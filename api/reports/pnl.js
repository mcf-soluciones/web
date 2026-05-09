import turso from '../_lib/turso.js';

/**
 * GET /api/reports/pnl?mm=3&yyyy=2026
 *
 * Returns:
 *   - period topline cards (month + YoY), matching mbr-v9-quarto.qmd:1313
 *   - full-year structured P&L (sections / subsections / line items) with
 *     per-month values, modeled on the P&L Google Sheet 2026_P&L_conjunto_mes
 *
 * Preliminary fallback: when sales_detail has no rows for the month,
 * topline revenue comes from the `sales` table (daily AWS pipeline),
 * which already excludes tarjeta-cliente.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const mm = toInt(req.query.mm);
    const yyyy = toInt(req.query.yyyy);
    const scope = normalizeScope(req.query.scope);
    if (!mm || !yyyy) return res.status(400).json({ error: 'mm and yyyy are required' });

    const [topline, yearData, activations] = await Promise.all([
      computeTopline(mm, yyyy, scope),
      computeYearPnl(yyyy, mm, scope),
      turso.execute(`SELECT property, start_date, label, notes FROM property_activation`),
    ]);

    return res.status(200).json({
      period: { mm, yyyy },
      scope,
      preliminary: topline.preliminary,
      preliminary_max_day: topline.preliminaryMaxDay,
      topline: { revenue: topline.revenue, revenue_demand: topline.revenueDemand },
      margins: topline.margins,
      year: yearData,
      activations: activations.rows,
    });

  } catch (err) {
    console.error('reports/pnl error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// =============================================================================
// Scope helpers (mcf | usera | hortaleza)
// =============================================================================

function normalizeScope(s) {
  const v = String(s || 'mcf').toLowerCase();
  if (v === 'usera' || v === 'hortaleza') return v;
  return 'mcf';
}

// Match a gastos.propiedad value against a store scope.
// gastos.propiedad varies: 'usera', '(001) Usera', 'hortaleza', '(002) Hortaleza',
// 'Corporate', '(003) Compra TBC', etc.
function matchesScope(propiedad, scope) {
  if (scope === 'mcf') return true;
  if (!propiedad) return false;
  const s = String(propiedad).toLowerCase();
  return s.includes(scope);
}

// =============================================================================
// Topline (month + YoY cards)
// =============================================================================

async function computeTopline(mm, yyyy, scope = 'mcf') {
  const propFilter = scope === 'mcf' ? '' : ' AND sd.property = ?';
  const propArgs = scope === 'mcf' ? [] : [scope];

  const [revRow, demRow, gastosRows] = await Promise.all([
    turso.execute({
      sql: `SELECT COALESCE(SUM(sd.euro), 0) AS total
            FROM sales_detail sd
            LEFT JOIN property_activation pa ON sd.property = pa.property
            WHERE sd.yyyy = ? AND sd.mm = ?
              AND sd.payment <> 'TARJETA CLIENTE'
              AND (pa.start_date IS NULL OR sd.date >= pa.start_date)
              ${propFilter}`,
      args: [yyyy, mm, ...propArgs],
    }),
    turso.execute({
      sql: `SELECT COALESCE(SUM(sd.euro), 0) AS total
            FROM sales_detail sd
            LEFT JOIN property_activation pa ON sd.property = pa.property
            WHERE sd.yyyy = ? AND sd.mm = ?
              AND (pa.start_date IS NULL OR sd.date >= pa.start_date)
              ${propFilter}`,
      args: [yyyy, mm, ...propArgs],
    }),
    turso.execute({
      // For loan-payment rows (loan_id IS NOT NULL) only the interest portion
      // is a P&L expense. Principal is non-cash from the P&L's perspective; it
      // moves a balance-sheet liability and shows up under CFF in cashflow.js.
      sql: `SELECT g.cuenta, g.categoria_gastos_mcf, g.propiedad,
                   CASE
                     WHEN g.loan_id IS NOT NULL THEN COALESCE(g.loan_payment_interest, 0)
                     ELSE COALESCE(g.importe_total, g.gasto, 0)
                   END AS importe,
                   COALESCE(g.importe_iva, 0) AS iva
            FROM gastos g
            WHERE g.yyyy = ? AND g.mm = ?
              AND COALESCE(g.es_inversion, 'No') = 'No'
              AND g.cuenta IS NOT NULL`,
      args: [yyyy, mm],
    }),
  ]);

  let revenue = Number(revRow.rows[0]?.total || 0);
  let revenueDemand = Number(demRow.rows[0]?.total || 0);

  let preliminary = false;
  let preliminaryMaxDay = null;
  if (revenue === 0 && revenueDemand === 0) {
    const ym = `${yyyy}-${String(mm).padStart(2, '0')}`;
    const fbSql = scope === 'mcf'
      ? `SELECT COALESCE(SUM(euros), 0) AS total, MAX(date_real) AS max_day
         FROM sales WHERE substr(date_real, 1, 7) = ?`
      : `SELECT COALESCE(SUM(euros), 0) AS total, MAX(date_real) AS max_day
         FROM sales WHERE substr(date_real, 1, 7) = ? AND LOWER(mcf_user) LIKE ?`;
    const fbArgs = scope === 'mcf' ? [ym] : [ym, `%${scope}%`];
    const fb = await turso.execute({ sql: fbSql, args: fbArgs });
    const t = Number(fb.rows[0]?.total || 0);
    if (t > 0) {
      preliminary = true;
      revenue = t;
      revenueDemand = t;
      preliminaryMaxDay = fb.rows[0]?.max_day || null;
    }
  }

  // Categoria + letter buckets
  const cats = { Variables: 0, Fijos: 0, Impuestos: 0, Virtuales: 0 };
  let perPropertyGastos = 0;     // letters C-I
  let corporateGastos = 0;       // letter J
  let ivaPagadoPerProperty = 0;  // sum importe_iva on C-I rows
  let ivaPagadoCorporate = 0;    // sum importe_iva on J rows
  let impuestosDeducible = 0;    // N1 + N2 + N3 only (N4, N5 are IVA/IRPF pass-throughs)
  let impuestosPassthrough = 0;  // N4 + N5 — paid this month, but represent prior-month spend
  let depreciacion = 0;          // letter O
  const impuestosByCode = {};    // { N1: x, N2: y, ... } for tooltip breakdown

  const DEDUCTIBLE_TAX_CODES = new Set(['N1', 'N2', 'N3']);
  const PASSTHROUGH_TAX_CODES = new Set(['N4', 'N5']);

  for (const r of gastosRows.rows) {
    const code = String(r.cuenta || '').trim().toUpperCase();
    const letter = code.charAt(0);
    const importe = Number(r.importe || 0);
    const iva = Number(r.iva || 0);
    const k = r.categoria_gastos_mcf;

    // Per-property gastos (C–I) only count if the row's propiedad matches the scope.
    // Corporate (J) and Depreciación (O) are MCF-wide; in store scopes we exclude them
    // entirely (unit-test / sucursal analysis — no corporate allocation).
    const isPerPropLetter = 'CDEFGHI'.includes(letter);
    const isCorporate = letter === 'J';
    const isDepreciation = letter === 'O';
    const isDeductibleTax = DEDUCTIBLE_TAX_CODES.has(code);

    if (isPerPropLetter && !matchesScope(r.propiedad, scope)) continue;
    if (scope !== 'mcf' && (isCorporate || isDepreciation)) continue;

    if (k in cats) cats[k] += importe;

    if (isPerPropLetter) {
      perPropertyGastos += importe;
      ivaPagadoPerProperty += iva;
    } else if (isCorporate) {
      corporateGastos += importe;
      ivaPagadoCorporate += iva;
    } else if (isDepreciation) {
      depreciacion += importe;
    }
    if (isDeductibleTax) impuestosDeducible += importe;
    if (PASSTHROUGH_TAX_CODES.has(code)) impuestosPassthrough += importe;
    if (letter === 'N') impuestosByCode[code] = (impuestosByCode[code] || 0) + importe;
  }

  // EBITDA neto de IVA: todo el IVA pagado en gastos operativos (C–J) es deducible.
  //   EBITDA = (Ingresos − IVA_Cobrado) − (Gastos_op − IVA_Pagado_Deducible)
  const ivaCobrado = revenue * 0.21;
  const ingresosNet = revenue - ivaCobrado;
  const ivaPagadoDeducible = ivaPagadoPerProperty + ivaPagadoCorporate;
  const ebitda = ingresosNet
    - (perPropertyGastos - ivaPagadoPerProperty)
    - (corporateGastos - ivaPagadoCorporate);

  // Synthetic O2 (depreciation add-back) and N8 (Impuesto Sociedades estimate).
  // MCF-scope only — both are corporate-level adjustments, hidden in store views.
  let depreciacionO2 = 0;
  let impuestosN8 = 0;
  if (scope === 'mcf') {
    depreciacionO2 = o2ForMonth(yyyy, mm);
    depreciacion += depreciacionO2;
    impuestosN8 = Math.max(0, ebitda - depreciacion) * N8_RATE;
    impuestosDeducible += impuestosN8;
    if (impuestosN8 > 0) impuestosByCode['N8'] = impuestosN8;
  }

  // Depreciation is non-cash and tax-deductible: it lowers N8 (tax base) but
  // is then ADDED BACK to net income (cash-equivalent earnings view).
  const netIncome = ebitda - impuestosDeducible + depreciacion;

  // Legacy simple-view fields preserved so existing UI references don't break
  const gross = revenue - cats.Variables;

  return {
    revenue, revenueDemand, preliminary, preliminaryMaxDay,
    margins: {
      // Legacy fields
      variables: cats.Variables, fijos: cats.Fijos,
      impuestos: cats.Impuestos, virtuales: cats.Virtuales,
      gross,
      // Sheet-matching EBITDA + Neto
      ingresos_net: ingresosNet,
      iva_cobrado: ivaCobrado,
      iva_pagado_per_property: ivaPagadoPerProperty,
      iva_pagado_corporate: ivaPagadoCorporate,
      iva_pagado_deducible: ivaPagadoDeducible,
      per_property_gastos: perPropertyGastos,
      corporate_gastos: corporateGastos,
      total_gastos_op: perPropertyGastos + corporateGastos,
      ebitda,
      impuestos_deducible: impuestosDeducible,
      impuestos_passthrough: impuestosPassthrough,
      impuestos_by_code: impuestosByCode,
      depreciacion,
      depreciacion_o2: depreciacionO2,
      impuestos_n8: impuestosN8,
      operating: ebitda,        // alias for UI backwards compat
      net_income: netIncome,
      passthrough_tax_codes: ['N4', 'N5'],
    },
  };
}

// =============================================================================
// Year P&L (sections × months)
// =============================================================================

// Maps the first letter of cuenta_mcf to a P&L section label (from the sheet)
const LETTER_LABELS = {
  A: { section: 'Ingresos', sub: 'Core (Lavado y secado)', order: 1 },
  B: { section: 'Ingresos', sub: 'Non-Core (Cafe y/o Vending)', order: 2 },
  C: { section: 'Gastos', sub: 'Alquiler', order: 1 },
  D: { section: 'Gastos', sub: 'Financiamiento', order: 2 },
  E: { section: 'Gastos', sub: 'Consumibles (Core)', order: 3 },
  F: { section: 'Gastos', sub: 'Consumibles (Non-Core)', order: 4 },
  G: { section: 'Gastos', sub: 'Fijos Otros', order: 5 },
  H: { section: 'Gastos', sub: 'Clientes', order: 6 },
  I: { section: 'Gastos', sub: 'Mantenimiento de Maquinaria y Equipo', order: 7 },
  J: { section: 'Gastos', sub: 'Corporate', order: 8 },
  N: { section: 'Impuestos', sub: 'Impuestos Pagados', order: 1 },
  O: { section: 'Depreciación', sub: 'Depreciación', order: 1 },
};

// =============================================================================
// Synthetic line items — not in the gastos table, computed deterministically.
// =============================================================================

// O2 — Depreciación equipo (cálculo lineal): 1.800 €/año entre Ago 2025 y Ago 2032.
const O2_MONTHLY = 1800 / 12;                                              // 150 €/mes
const O2_RANGE = { start_yyyy: 2025, start_mm: 8, end_yyyy: 2032, end_mm: 8 };
const O2_TOOLTIP = 'Depreciación lineal: 1.800 €/año entre ago 2025 y ago 2032 (= 150 €/mes).';

// N8 — Impuesto sobre Sociedades estimado: 20% × max(0, EBITDA − Depreciación).
const N8_RATE = 0.20;
const N8_TOOLTIP = 'Estimación: 20% × (EBITDA − Depreciación) por mes (mínimo 0).';

function o2ForMonth(yyyy, mm) {
  const t = yyyy * 12 + mm;
  const start = O2_RANGE.start_yyyy * 12 + O2_RANGE.start_mm;
  const end = O2_RANGE.end_yyyy * 12 + O2_RANGE.end_mm;
  return (t >= start && t <= end) ? O2_MONTHLY : 0;
}

// Property label map (from sheet: (001) Usera etc.)
function propertyLabel(p) {
  if (!p) return '(sin propiedad)';
  const s = String(p).toLowerCase();
  if (s.includes('usera')) return '(001) Usera';
  if (s.includes('hortaleza')) return '(002) Hortaleza';
  if (s.includes('corporate') || s === '(000) corporate') return 'Corporate';
  return p;
}

const zeroMonths = () => ({ 1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0,10:0,11:0,12:0 });
const addMonth = (a, mm, v) => { a[mm] = (a[mm] || 0) + v; };

async function computeYearPnl(yyyy, currentMm, scope = 'mcf') {
  const propFilterSd = scope === 'mcf' ? '' : ' AND sd.property = ?';
  const sdArgs = scope === 'mcf' ? [yyyy] : [yyyy, scope];

  // ---- gastos by cuenta × month, with category join ------------------------
  // Loan-payment rows: only the interest portion is a P&L expense.
  const gastos = await turso.execute({
    sql: `SELECT g.cuenta, g.mm, g.yyyy, g.propiedad,
                 CASE
                   WHEN g.loan_id IS NOT NULL THEN COALESCE(g.loan_payment_interest, 0)
                   ELSE COALESCE(g.importe_total, g.gasto, 0)
                 END AS importe,
                 COALESCE(g.importe_iva, 0) AS iva,
                 g.categoria_gastos_mcf, g.concepto_mcf,
                 c.desc AS cuenta_desc, c.tooltip AS cuenta_tooltip
          FROM gastos g
          LEFT JOIN catalogo_cuentas c ON g.cuenta = c.cuenta_mcf
          WHERE g.yyyy = ?
            AND COALESCE(g.es_inversion, 'No') = 'No'
            AND g.cuenta IS NOT NULL`,
    args: [yyyy],
  });

  // ---- ingresos: sales_detail by property × month (filtered by activation) -
  const salesDet = await turso.execute({
    sql: `SELECT sd.property, sd.mm, COALESCE(SUM(sd.euro), 0) AS euros
          FROM sales_detail sd
          LEFT JOIN property_activation pa ON sd.property = pa.property
          WHERE sd.yyyy = ?
            AND sd.payment <> 'TARJETA CLIENTE'
            AND (pa.start_date IS NULL OR sd.date >= pa.start_date)
            ${propFilterSd}
          GROUP BY sd.property, sd.mm`,
    args: sdArgs,
  });

  // ---- ingresos fallback: sales table for months sales_detail lacks ------
  const salesAggSql = scope === 'mcf'
    ? `SELECT
         CASE WHEN mcf_user LIKE '%hortaleza%' THEN 'hortaleza'
              WHEN mcf_user LIKE '%usera%'     THEN 'usera'
              ELSE 'unknown' END AS property,
         CAST(substr(date_real, 6, 2) AS INTEGER) AS mm,
         COALESCE(SUM(euros), 0) AS euros,
         MAX(date_real) AS max_day
       FROM sales
       WHERE substr(date_real, 1, 4) = ?
       GROUP BY property, mm`
    : `SELECT ? AS property,
              CAST(substr(date_real, 6, 2) AS INTEGER) AS mm,
              COALESCE(SUM(euros), 0) AS euros,
              MAX(date_real) AS max_day
       FROM sales
       WHERE substr(date_real, 1, 4) = ?
         AND LOWER(mcf_user) LIKE ?
       GROUP BY mm`;
  const salesAggArgs = scope === 'mcf'
    ? [String(yyyy)]
    : [scope, String(yyyy), `%${scope}%`];
  const salesAgg = await turso.execute({ sql: salesAggSql, args: salesAggArgs });

  // Which months have sales_detail data?
  const monthsWithDetail = new Set(salesDet.rows.map(r => Number(r.mm)));
  const preliminaryMonths = new Set();

  // Build ingresos map by property and month
  const ingresosByProp = { usera: zeroMonths(), hortaleza: zeroMonths() };
  const preliminaryMaxDay = {};
  for (const r of salesDet.rows) {
    const prop = r.property;
    if (prop in ingresosByProp) addMonth(ingresosByProp[prop], Number(r.mm), Number(r.euros));
  }
  for (const r of salesAgg.rows) {
    const mm = Number(r.mm);
    if (monthsWithDetail.has(mm)) continue; // prefer sales_detail
    const prop = r.property;
    if (prop in ingresosByProp) {
      addMonth(ingresosByProp[prop], mm, Number(r.euros));
      preliminaryMonths.add(mm);
      if (r.max_day) preliminaryMaxDay[mm] = r.max_day;
    }
  }

  // ---- build year payload --------------------------------------------------
  // Gastos: aggregate by letter + desc + property + month
  // Structure: sections[letter] -> items[cuenta] -> by_month
  const letterAgg = {};
  // Extra trackers for EBITDA / Neto
  const ivaPagadoPerPropByMonth = zeroMonths();
  const ivaPagadoCorporateByMonth = zeroMonths();
  const perPropertyGastosByMonth = zeroMonths();
  const corporateGastosByMonth = zeroMonths();
  const impuestosDeducibleByMonth = zeroMonths();     // N1 + N2 + N3
  const DEDUCTIBLE_TAX_CODES = new Set(['N1', 'N2', 'N3']);

  for (const r of gastos.rows) {
    const code = String(r.cuenta || '').trim();
    if (!code) continue;
    const upperCode = code.toUpperCase();
    const letter = code.charAt(0).toUpperCase();
    const mm = Number(r.mm);
    const v = Number(r.importe || 0);
    const iva = Number(r.iva || 0);

    const isPerPropLetter = 'CDEFGHI'.includes(letter);
    const isCorporate = letter === 'J';
    const isDepreciation = letter === 'O';

    // Scope filtering: per-property letters require propiedad match;
    // Corporate (J) + Depreciación (O) are dropped in store views.
    if (isPerPropLetter && !matchesScope(r.propiedad, scope)) continue;
    if (scope !== 'mcf' && (isCorporate || isDepreciation)) continue;

    if (isPerPropLetter) {
      addMonth(perPropertyGastosByMonth, mm, v);
      addMonth(ivaPagadoPerPropByMonth, mm, iva);
    } else if (isCorporate) {
      addMonth(corporateGastosByMonth, mm, v);
      addMonth(ivaPagadoCorporateByMonth, mm, iva);
    }
    if (DEDUCTIBLE_TAX_CODES.has(upperCode)) addMonth(impuestosDeducibleByMonth, mm, v);

    if (!LETTER_LABELS[letter]) continue; // skip unknown letters (K, L, M, P — derived/informational)

    if (!letterAgg[letter]) {
      letterAgg[letter] = {
        letter,
        section: LETTER_LABELS[letter].section,
        sub: LETTER_LABELS[letter].sub,
        order: LETTER_LABELS[letter].order,
        by_month: zeroMonths(),
        items: new Map(),
      };
    }
    const bucket = letterAgg[letter];
    addMonth(bucket.by_month, mm, v);

    // item key: prefer cuenta_desc + propiedad, fall back to cuenta code
    const desc = r.cuenta_desc || r.concepto_mcf || `Cuenta ${code}`;
    const propLabel = propertyLabel(r.propiedad);
    const itemKey = `${code}|${propLabel}`;
    if (!bucket.items.has(itemKey)) {
      bucket.items.set(itemKey, {
        code, label: `${desc} — ${propLabel}`,
        desc, property_label: propLabel,
        tooltip: r.cuenta_tooltip,
        by_month: zeroMonths(),
      });
    }
    addMonth(bucket.items.get(itemKey).by_month, mm, v);
  }

  // -------------------------------------------------------------------------
  // Synthetic line items (MCF scope only): O2 depreciation + N8 Imp. Sociedades.
  // N8 depends on EBITDA per month, so we must compute EBITDA first using only
  // real gastos data, then inject the synthetics into letterAgg before grouping.
  // -------------------------------------------------------------------------
  const ebitdaPreSynth = zeroMonths();
  for (let m = 1; m <= 12; m++) {
    const ing = (ingresosByProp.usera[m] || 0) + (ingresosByProp.hortaleza[m] || 0);
    const ivaC = ing * 0.21;
    ebitdaPreSynth[m] = (ing - ivaC)
      - ((perPropertyGastosByMonth[m] || 0) - (ivaPagadoPerPropByMonth[m] || 0))
      - ((corporateGastosByMonth[m] || 0) - (ivaPagadoCorporateByMonth[m] || 0));
  }

  const o2ByMonth = zeroMonths();
  const n8ByMonth = zeroMonths();
  // Items that go into the new "Impuestos Incurridos" section (taxes that
  // accrued this period, distinct from "Impuestos" = taxes actually paid).
  const incurridosItems = [];
  const incurridosByMonth = zeroMonths();

  // IVA cobrado (21% of sales) — per propiedad. This IVA is already netted out
  // of EBITDA at the revenue level, so we surface it here for visibility but it
  // does NOT reduce net income again.
  const ivaProps = scope === 'mcf' ? ['usera', 'hortaleza'] : [scope];
  for (const prop of ivaProps) {
    const ivaPropByMonth = zeroMonths();
    for (let m = 1; m <= 12; m++) {
      ivaPropByMonth[m] = (ingresosByProp[prop][m] || 0) * 0.21;
    }
    if (!Object.values(ivaPropByMonth).some(v => v > 0)) continue;
    const code = prop === 'usera' ? 'K1' : 'K2';
    const propLabel = propertyLabel(prop);
    incurridosItems.push({
      code,
      label: `IVA Cobrado (21%) — ${propLabel}`,
      desc: 'IVA Cobrado',
      property_label: propLabel,
      by_month: ivaPropByMonth,
      synthetic: true,
      tooltip: 'IVA del 21% incluido en ventas y ya descontado al calcular EBITDA. Mostrado aquí como impuesto incurrido (informativo) — no se vuelve a restar de la utilidad neta.',
    });
    for (let m = 1; m <= 12; m++) addMonth(incurridosByMonth, m, ivaPropByMonth[m]);
  }

  if (scope === 'mcf') {
    const realDepByMonth = letterAgg.O ? { ...letterAgg.O.by_month } : zeroMonths();
    for (let m = 1; m <= 12; m++) {
      o2ByMonth[m] = o2ForMonth(yyyy, m);
      const totalDep = (realDepByMonth[m] || 0) + o2ByMonth[m];
      n8ByMonth[m] = Math.max(0, ebitdaPreSynth[m] - totalDep) * N8_RATE;
    }

    if (Object.values(o2ByMonth).some(v => v > 0)) {
      // Pull the real catalogo_cuentas descriptor for O2 so the row label
      // matches every other item (e.g. "Depreciacion — (002) Hortaleza").
      const o2CatalogRow = await turso.execute(
        `SELECT desc, propiedad, tooltip FROM catalogo_cuentas WHERE cuenta_mcf = 'O2' LIMIT 1`
      );
      const o2Cat = o2CatalogRow.rows[0] || {};
      const o2Desc = o2Cat.desc || 'Depreciación';
      const o2PropLabel = o2Cat.propiedad || 'Corporate';

      if (!letterAgg.O) {
        letterAgg.O = {
          letter: 'O', section: 'Depreciación', sub: 'Depreciación', order: 1,
          by_month: zeroMonths(), items: new Map(),
        };
      }
      letterAgg.O.items.set(`O2|${o2PropLabel}`, {
        code: 'O2',
        label: `${o2Desc} — ${o2PropLabel}`,
        desc: o2Desc,
        property_label: o2PropLabel,
        by_month: { ...o2ByMonth },
        synthetic: true,
        tooltip: O2_TOOLTIP,
      });
      for (let m = 1; m <= 12; m++) addMonth(letterAgg.O.by_month, m, o2ByMonth[m]);
    }

    if (Object.values(n8ByMonth).some(v => v > 0)) {
      // N8 lives in "Impuestos Incurridos" (NOT the existing "Impuestos" section
      // which represents taxes actually paid — N1..N5 from gastos).
      incurridosItems.push({
        code: 'N8',
        label: 'Impuesto Sociedades estimado — Corporate',
        desc: 'Impuesto Sociedades estimado',
        property_label: 'Corporate',
        by_month: { ...n8ByMonth },
        synthetic: true,
        tooltip: N8_TOOLTIP,
      });
      for (let m = 1; m <= 12; m++) addMonth(incurridosByMonth, m, n8ByMonth[m]);
      // N8 reduces neto, so include it in the deductible per-month rollup.
      for (let m = 1; m <= 12; m++) addMonth(impuestosDeducibleByMonth, m, n8ByMonth[m]);
    }
  }

  // Seed Ingresos A section from property-based sales
  if (!letterAgg.A) {
    letterAgg.A = {
      letter: 'A', section: 'Ingresos', sub: 'Core (Lavado y secado)', order: 1,
      by_month: zeroMonths(), items: new Map(),
    };
  }
  const aBucket = letterAgg.A;
  const ingresosProps = scope === 'mcf' ? ['usera', 'hortaleza'] : [scope];
  for (const prop of ingresosProps) {
    const label = propertyLabel(prop);
    const by_month = { ...ingresosByProp[prop] };
    aBucket.items.set(`${prop === 'usera' ? 'A1' : 'A2'}|${label}`, {
      code: prop === 'usera' ? 'A1' : 'A2',
      label: `Ventas (Core) — ${label}`,
      desc: 'Ventas (Core)',
      property_label: label,
      by_month,
    });
    for (let m = 1; m <= 12; m++) addMonth(aBucket.by_month, m, by_month[m] || 0);
  }

  // Group into sections (insertion order = render order)
  const sectionBuckets = { Ingresos: [], Gastos: [], Impuestos: [], Depreciación: [] };
  for (const b of Object.values(letterAgg)) {
    if (!(b.section in sectionBuckets)) continue;
    sectionBuckets[b.section].push({
      key: b.letter,
      label: b.sub,
      order: b.order,
      by_month: b.by_month,
      ytd: sumYtd(b.by_month, currentMm),
      items: Array.from(b.items.values())
        .map(it => ({ ...it, ytd: sumYtd(it.by_month, currentMm) }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    });
  }

  // "Impuestos Incurridos" is a SUBSECTION inside the Impuestos section
  // (alongside the existing "Impuestos Pagados" sub from N letter).
  if (incurridosItems.length > 0) {
    sectionBuckets['Impuestos'].push({
      key: 'II',
      label: 'Impuestos Incurridos',
      order: 2,           // after "Impuestos Pagados" (order=1 from LETTER_LABELS.N)
      by_month: incurridosByMonth,
      ytd: sumYtd(incurridosByMonth, currentMm),
      items: incurridosItems
        .map(it => ({ ...it, ytd: sumYtd(it.by_month, currentMm) }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    });
  }

  const sections = Object.entries(sectionBuckets).map(([key, subs]) => {
    subs.sort((a, b) => a.order - b.order);
    const section_by_month = zeroMonths();
    for (const s of subs) for (let m = 1; m <= 12; m++) section_by_month[m] += s.by_month[m] || 0;
    return {
      key, label: key,
      by_month: section_by_month,
      ytd: sumYtd(section_by_month, currentMm),
      subsections: subs,
    };
  });

  const ingresos = sections.find(s => s.key === 'Ingresos')?.by_month || zeroMonths();
  const depreciacion = sections.find(s => s.key === 'Depreciación')?.by_month || zeroMonths();

  // EBITDA per month, neto de IVA:
  //   EBITDA = (Ingresos − IVA_Cobrado)
  //          − (perPropGastos − IVA_Pagado_perProp)
  //          − (corporateGastos − IVA_Pagado_corporate)
  //   IVA_Cobrado = 21% of Ingresos
  const ebitda = zeroMonths();
  const neto = zeroMonths();
  const ebitdaPct = {};
  const netoPct = {};
  for (let m = 1; m <= 12; m++) {
    const ing = ingresos[m] || 0;
    const ivaCobrado = ing * 0.21;
    ebitda[m] = (ing - ivaCobrado)
      - ((perPropertyGastosByMonth[m] || 0) - (ivaPagadoPerPropByMonth[m] || 0))
      - ((corporateGastosByMonth[m] || 0) - (ivaPagadoCorporateByMonth[m] || 0));
    // Depreciation is added back (non-cash; already lowered N8 via tax shield).
    neto[m] = ebitda[m] - (impuestosDeducibleByMonth[m] || 0) + (depreciacion[m] || 0);
    ebitdaPct[m] = ing > 0 ? ebitda[m] / ing : null;
    netoPct[m] = ing > 0 ? neto[m] / ing : null;
  }

  const ytd = (obj) => sumYtd(obj, currentMm);

  return {
    yyyy,
    scope,
    current_mm: currentMm,
    preliminary_months: Array.from(preliminaryMonths).sort((a, b) => a - b),
    preliminary_max_day: preliminaryMaxDay,
    sections,
    ebitda: {
      by_month: ebitda, ytd: ytd(ebitda),
      margin_pct_by_month: ebitdaPct,
      margin_pct_ytd: ytd(ingresos) > 0 ? ytd(ebitda) / ytd(ingresos) : null,
    },
    neto: {
      by_month: neto, ytd: ytd(neto),
      margin_pct_by_month: netoPct,
      margin_pct_ytd: ytd(ingresos) > 0 ? ytd(neto) / ytd(ingresos) : null,
    },
  };
}

function sumYtd(monthObj, throughMm) {
  let s = 0;
  for (let m = 1; m <= throughMm; m++) s += monthObj[m] || 0;
  return s;
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
