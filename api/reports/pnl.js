import { requireReader } from '../_lib/web-auth.js';
import { detailIndex, storesOnSalesOnly } from '../_lib/sales-fallback.js';
import turso from '../_lib/turso.js';
import { MEXICO, MEXICO_COMPANY, sinMexico, tiendaMexico } from '../_lib/sucursales.js';

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
 *
 * Spain only, unless an owner asks for mexico=1 at MCF scope. Then the Mexican stores join the same rows as any other
 * store, in Ingresos and each gasto split, and the totals and cards include them. No IVA or Impuesto de Sociedades is
 * computed on them, since those were already paid in Mexico, so N8, N8a and computeYearProfitBase stay Spain's.
 */
export default async function handler(req, res) {
  const reader = requireReader(req, res);
  if (!reader) return;
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
    const verMexico = reader.role === 'owner' && scope === 'mcf' && req.query.mexico === '1';
    if (verMexico) addMexico(topline, yearData, await readMexico(yyyy));

    return res.status(200).json({
      period: { mm, yyyy },
      scope,
      preliminary: topline.preliminary,
      preliminary_max_day: topline.preliminaryMaxDay,
      topline: { revenue: topline.revenue, revenue_demand: topline.revenueDemand },
      margins: topline.margins,
      year: yearData,
      activations: activations.rows,
      ...(verMexico ? { con_mexico: true } : {}),
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
// 'Corporate', etc.
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
            WHERE sd.company = 'mcf'
              AND sd.yyyy = ? AND sd.mm = ?
              AND sd.payment <> 'TARJETA CLIENTE'
              AND (pa.start_date IS NULL OR sd.date >= pa.start_date)
              ${propFilter}`,
      args: [yyyy, mm, ...propArgs],
    }),
    turso.execute({
      sql: `SELECT COALESCE(SUM(sd.euro), 0) AS total
            FROM sales_detail sd
            LEFT JOIN property_activation pa ON sd.property = pa.property
            WHERE sd.company = 'mcf'
              AND sd.yyyy = ? AND sd.mm = ?
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
              AND ${sinMexico('g')}
              AND COALESCE(g.es_inversion, 'No') = 'No'
              AND g.cuenta IS NOT NULL`,
      args: [yyyy, mm],
    }),
  ]);

  let revenue = Number(revRow.rows[0]?.total || 0);
  let revenueDemand = Number(demRow.rows[0]?.total || 0);

  let preliminary = false;
  let preliminaryMaxDay = null;
  for (const { total, max_day } of await storesOnSalesOnly(turso, yyyy, mm, scope)) {
    preliminary = true;
    revenue += total;
    revenueDemand += total;
    if (max_day && (!preliminaryMaxDay || max_day > preliminaryMaxDay)) preliminaryMaxDay = max_day;
  }

  // Categoria + letter buckets
  const cats = { Variables: 0, Fijos: 0, Impuestos: 0, Virtuales: 0 };
  let perPropertyGastos = 0;     // letters C-I
  let corporateGastos = 0;       // letter J
  let ivaPagadoPerProperty = 0;  // sum importe_iva on C-I rows
  let ivaPagadoCorporate = 0;    // sum importe_iva on J rows
  // Net-income deductible: N1 (autónomo RETA) + N3 (Seg. Social empleados).
  // N2 (IS pagado) is PASSTHROUGH — IS expense is captured in P&L via the
  // synthetic N8 (estimate) or N8a (actual, allocated, when the year is closed).
  // N4 (IVA Neto) and N5 (IRPF retenido alquiler) are also pass-throughs.
  let impuestosDeducible = 0;
  let impuestosPassthrough = 0;
  let depreciacion = 0;          // letter O
  const impuestosByCode = {};    // { N1: x, N2: y, ... } for tooltip breakdown

  const DEDUCTIBLE_TAX_CODES = new Set(['N1', 'N3']);
  const PASSTHROUGH_TAX_CODES = new Set(['N2', 'N4', 'N5']);

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

  // Synthetic O2 (depreciation add-back) and N8/N8a (Impuesto Sociedades).
  // MCF-scope only — both are corporate-level adjustments, hidden in store views.
  // If the year is closed (tax_settlements row exists), we use N8a = actual_is
  // allocated by this month's share of the year's profit base. Otherwise we
  // fall back to the N8 estimate (20% × monthly profit).
  let depreciacionO2 = 0;
  let impuestosN8 = 0;
  let n8Code = 'N8';
  if (scope === 'mcf') {
    depreciacionO2 = o2ForMonth(yyyy, mm);
    depreciacion += depreciacionO2;
    const monthBase = Math.max(0, ebitda - depreciacion);
    const settled = await getTaxSettlement(yyyy);
    if (settled && settled.year_profit_base > 0) {
      impuestosN8 = settled.actual_is * (monthBase / settled.year_profit_base);
      n8Code = 'N8a';
    } else {
      impuestosN8 = monthBase * N8_RATE;
    }
    impuestosDeducible += impuestosN8;
    if (impuestosN8 > 0) impuestosByCode[n8Code] = impuestosN8;
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
      passthrough_tax_codes: ['N2', 'N4', 'N5'],
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
const N8_TOOLTIP = 'Estimación: 20% × (EBITDA − Depreciación) por mes (mínimo 0). Se reemplaza por N8a (IS real asignado) cuando se cierra el año fiscal en Configuración.';
const N8A_TOOLTIP = 'IS real ya filed para este año, asignado a cada mes proporcionalmente a (EBITDA − Depreciación). Reemplaza la estimación N8 porque el año fiscal ya está cerrado.';

// Lookup helper for closed fiscal years. Returns { actual_is, year_profit_base }
// or null if the year hasn't been closed in tax_settlements.
async function getTaxSettlement(yyyy) {
  try {
    const r = await turso.execute({
      sql: `SELECT actual_is, year_profit_base FROM tax_settlements WHERE yyyy = ?`,
      args: [yyyy],
    });
    const row = r.rows[0];
    if (!row) return null;
    return {
      actual_is: Number(row.actual_is) || 0,
      year_profit_base: Number(row.year_profit_base) || 0,
    };
  } catch {
    return null;     // table may not exist in old envs
  }
}

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

const codeNumber = (code) => {
  const n = parseInt(String(code).slice(1), 10);
  return Number.isNaN(n) ? Infinity : n;
};

// Keeps a concept's rows together, one per store in code order: Agua E1, E2, E3, E10, then Gas E4, E5, E6, E11.
function sortItems(items) {
  const firstCode = new Map();
  for (const it of items) firstCode.set(it.desc, Math.min(firstCode.get(it.desc) ?? Infinity, codeNumber(it.code)));
  return items.sort((a, b) => (firstCode.get(a.desc) - firstCode.get(b.desc)) || (codeNumber(a.code) - codeNumber(b.code)));
}

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
            AND ${sinMexico('g')}
            AND COALESCE(g.es_inversion, 'No') = 'No'
            AND g.cuenta IS NOT NULL`,
    args: [yyyy],
  });

  // ---- ingresos: sales_detail by property × month (filtered by activation) -
  const salesDet = await turso.execute({
    sql: `SELECT sd.property, sd.mm, COALESCE(SUM(sd.euro), 0) AS euros
          FROM sales_detail sd
          LEFT JOIN property_activation pa ON sd.property = pa.property
          WHERE sd.company = 'mcf'
            AND sd.yyyy = ?
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

  // Which store-months have sales_detail data? One store can have it while the other does not.
  const hasDetail = detailIndex(salesDet.rows);
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
    const prop = r.property;
    if (hasDetail(prop, mm)) continue; // prefer sales_detail
    if (prop in ingresosByProp) {
      addMonth(ingresosByProp[prop], mm, Number(r.euros));
      preliminaryMonths.add(mm);
      if (r.max_day && (!preliminaryMaxDay[mm] || r.max_day > preliminaryMaxDay[mm])) preliminaryMaxDay[mm] = r.max_day;
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
  const impuestosDeducibleByMonth = zeroMonths();     // N1 + N3 (N2 is passthrough)
  const DEDUCTIBLE_TAX_CODES = new Set(['N1', 'N3']);

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
        iva_by_month: zeroMonths(),
        items: new Map(),
      };
    }
    const bucket = letterAgg[letter];
    addMonth(bucket.by_month, mm, v);
    addMonth(bucket.iva_by_month, mm, iva);

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
        iva_by_month: zeroMonths(),
      });
    }
    addMonth(bucket.items.get(itemKey).by_month, mm, v);
    addMonth(bucket.items.get(itemKey).iva_by_month, mm, iva);
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

  let n8Code = 'N8';
  let n8Label = 'Impuesto Sociedades estimado';
  let n8Tooltip = N8_TOOLTIP;
  if (scope === 'mcf') {
    const realDepByMonth = letterAgg.O ? { ...letterAgg.O.by_month } : zeroMonths();
    // Per-month tax base (capped at 0). Used by both N8 estimate and N8a allocation.
    const monthBase = zeroMonths();
    for (let m = 1; m <= 12; m++) {
      o2ByMonth[m] = o2ForMonth(yyyy, m);
      const totalDep = (realDepByMonth[m] || 0) + o2ByMonth[m];
      monthBase[m] = Math.max(0, ebitdaPreSynth[m] - totalDep);
    }
    // If the year is closed, allocate the actual IS by month-share of profit base.
    // Otherwise fall back to the 20% estimate.
    const settled = await getTaxSettlement(yyyy);
    if (settled && settled.year_profit_base > 0) {
      n8Code = 'N8a';
      n8Label = 'Impuesto Sociedades real (asignado)';
      n8Tooltip = N8A_TOOLTIP;
      for (let m = 1; m <= 12; m++) {
        n8ByMonth[m] = settled.actual_is * (monthBase[m] / settled.year_profit_base);
      }
    } else {
      for (let m = 1; m <= 12; m++) {
        n8ByMonth[m] = monthBase[m] * N8_RATE;
      }
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
      // N8 / N8a lives in "Impuestos Incurridos" (NOT the existing "Impuestos
      // Pagados" section, which represents taxes actually paid — N1..N5 from gastos).
      incurridosItems.push({
        code: n8Code,
        label: `${n8Label} — Corporate`,
        desc: n8Label,
        property_label: 'Corporate',
        by_month: { ...n8ByMonth },
        synthetic: true,
        tooltip: n8Tooltip,
      });
      for (let m = 1; m <= 12; m++) addMonth(incurridosByMonth, m, n8ByMonth[m]);
      // N8 / N8a reduces neto, so include it in the deductible per-month rollup.
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
      iva_by_month: b.iva_by_month || zeroMonths(),
      iva_ytd: sumYtd(b.iva_by_month || zeroMonths(), currentMm),
      items: sortItems(Array.from(b.items.values())
        .map(it => ({
          ...it,
          ytd: sumYtd(it.by_month, currentMm),
          iva_ytd: sumYtd(it.iva_by_month || zeroMonths(), currentMm),
        }))),
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
    const section_iva_by_month = zeroMonths();
    for (const s of subs) for (let m = 1; m <= 12; m++) {
      section_by_month[m] += s.by_month[m] || 0;
      section_iva_by_month[m] += s.iva_by_month?.[m] || 0;
    }
    return {
      key, label: key,
      by_month: section_by_month,
      ytd: sumYtd(section_by_month, currentMm),
      iva_by_month: section_iva_by_month,
      iva_ytd: sumYtd(section_iva_by_month, currentMm),
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

const MEXICO_TOOLTIP = 'Ya tributado en México: sin IVA ni Impuesto de Sociedades.';

async function readMexico(yyyy) {
  const [ventas, gastos] = await Promise.all([
    turso.execute({
      sql: `SELECT property, mm,
                   COALESCE(SUM(CASE WHEN COALESCE(payment, '') <> 'TARJETA CLIENTE' THEN euro END), 0) AS euros,
                   COALESCE(SUM(euro), 0) AS demanda
            FROM sales_detail
            WHERE company = ? AND yyyy = ?
            GROUP BY property, mm`,
      args: [MEXICO_COMPANY, yyyy],
    }),
    turso.execute({
      sql: `SELECT g.cuenta, g.mm, g.propiedad, g.concepto_mcf, c.desc AS cuenta_desc,
                   CASE
                     WHEN g.loan_id IS NOT NULL THEN COALESCE(g.loan_payment_interest, 0)
                     ELSE COALESCE(g.importe_total, g.gasto, 0)
                   END AS importe
            FROM gastos g
            LEFT JOIN catalogo_cuentas c ON g.cuenta = c.cuenta_mcf
            WHERE g.yyyy = ?
              AND NOT (${sinMexico('g')})
              AND COALESCE(g.es_inversion, 'No') = 'No'
              AND g.cuenta IS NOT NULL`,
      args: [yyyy],
    }),
  ]);
  return { ventas: ventas.rows, gastos: gastos.rows };
}

/**
 * Puts the Mexican stores in the rows every other store uses, then carries them into the totals and the month's cards.
 * It runs once Spain's numbers are done, so N8, N8a and the IVA lines stay Spain's. Each cuenta counts the way it does
 * for Spain, except that amounts are gross: no IVA is collected or deducted on these stores.
 */
function addMexico(topline, year, { ventas, gastos }) {
  const mm = year.current_mm;
  const ingresos = zeroMonths();
  const porPropiedad = zeroMonths();
  const corporate = zeroMonths();
  const deducibles = zeroMonths();
  const pasan = zeroMonths();
  const depreciacion = zeroMonths();
  const changed = new Set();

  const addToRow = (letter, code, desc, store, month, amount) => {
    const { section: sectionKey, sub: label, order } = LETTER_LABELS[letter];
    const section = year.sections.find(s => s.key === sectionKey);
    let sub = section.subsections.find(s => s.key === letter);
    if (!sub) {
      sub = { key: letter, label, order, by_month: zeroMonths(), iva_by_month: zeroMonths(), iva_ytd: 0, items: [] };
      section.subsections.push(sub);
      section.subsections.sort((a, b) => a.order - b.order);
    }
    let item = sub.items.find(it => it.code === code && it.property_label === store);
    if (!item) {
      item = { code, label: `${desc} — ${store}`, desc, property_label: store, tooltip: MEXICO_TOOLTIP, by_month: zeroMonths(), iva_by_month: zeroMonths(), iva_ytd: 0 };
      sub.items.push(item);
    }
    addMonth(item.by_month, month, amount);
    addMonth(sub.by_month, month, amount);
    addMonth(section.by_month, month, amount);
    changed.add(section);
    changed.add(sub);
  };

  // Like A1 and A2, each store's sales row is there even before it has sold anything.
  const ventasCode = store => `A${Number(store.label.match(/\d+/)[0])}`;
  for (const store of MEXICO) addToRow('A', ventasCode(store), 'Ventas (Core)', store.label, 1, 0);

  for (const r of ventas) {
    const store = tiendaMexico(r.property);
    const month = Number(r.mm);
    const euros = Number(r.euros);
    // A sales row under the Mexican company with a property we don't know still counts, under its own name.
    addToRow('A', store ? ventasCode(store) : 'A', 'Ventas (Core)', store?.label ?? String(r.property), month, euros);
    addMonth(ingresos, month, euros);
    if (month === mm) topline.revenueDemand += Number(r.demanda);
  }

  for (const r of gastos) {
    const code = String(r.cuenta || '').trim().toUpperCase();
    const letter = code.charAt(0);
    if (!LETTER_LABELS[letter]) continue; // K, L, M, Z: not P&L rows for any store
    const month = Number(r.mm);
    const amount = Number(r.importe || 0);
    addToRow(letter, code, r.cuenta_desc || r.concepto_mcf || `Cuenta ${code}`, tiendaMexico(r.propiedad).label, month, amount);

    if ('AB'.includes(letter)) addMonth(ingresos, month, amount);
    else if ('CDEFGHI'.includes(letter)) addMonth(porPropiedad, month, amount);
    else if (letter === 'J') addMonth(corporate, month, amount);
    else if (letter === 'O') addMonth(depreciacion, month, amount);
    else if (code === 'N1' || code === 'N3') addMonth(deducibles, month, amount);
    else if (['N2', 'N4', 'N5'].includes(code)) addMonth(pasan, month, amount);
    if (letter === 'N' && month === mm) topline.margins.impuestos_by_code[code] = (topline.margins.impuestos_by_code[code] || 0) + amount;
  }

  for (const part of changed) {
    part.ytd = sumYtd(part.by_month, mm);
    if (!part.items) continue;
    part.items = sortItems(part.items);
    for (const item of part.items) item.ytd = sumYtd(item.by_month, mm);
  }

  const operativo = m => ingresos[m] - porPropiedad[m] - corporate[m];
  const netoDelMes = m => operativo(m) - deducibles[m] + depreciacion[m];
  const totalIngresos = year.sections.find(s => s.key === 'Ingresos').by_month;
  const share = (v, total) => (total > 0 ? v / total : null);
  for (let m = 1; m <= 12; m++) {
    year.ebitda.by_month[m] += operativo(m);
    year.neto.by_month[m] += netoDelMes(m);
    year.ebitda.margin_pct_by_month[m] = share(year.ebitda.by_month[m], totalIngresos[m]);
    year.neto.margin_pct_by_month[m] = share(year.neto.by_month[m], totalIngresos[m]);
  }
  const ingresosYtd = sumYtd(totalIngresos, mm);
  year.ebitda.ytd = sumYtd(year.ebitda.by_month, mm);
  year.ebitda.margin_pct_ytd = share(year.ebitda.ytd, ingresosYtd);
  year.neto.ytd = sumYtd(year.neto.by_month, mm);
  year.neto.margin_pct_ytd = share(year.neto.ytd, ingresosYtd);

  const cards = topline.margins;
  topline.revenue += ingresos[mm];
  cards.ingresos_net += ingresos[mm];
  cards.per_property_gastos += porPropiedad[mm];
  cards.corporate_gastos += corporate[mm];
  cards.total_gastos_op += porPropiedad[mm] + corporate[mm];
  cards.ebitda += operativo(mm);
  cards.operating = cards.ebitda;
  cards.impuestos_deducible += deducibles[mm];
  cards.impuestos_passthrough += pasan[mm];
  cards.depreciacion += depreciacion[mm];
  cards.net_income += netoDelMes(mm);
}

function sumYtd(monthObj, throughMm) {
  let s = 0;
  for (let m = 1; m <= throughMm; m++) s += monthObj[m] || 0;
  return s;
}

/**
 * Computes the year's IS taxable profit base used to allocate actual IS across
 * months when a year is closed:
 *   year_profit_base = Σ max(0, ebitda[m] − depreciacion[m])  for m = 1..12
 *
 * Reuses computeYearPnl's MCF-scope output. Independent of whether
 * tax_settlements has a row for this year yet (N8 vs N8a only affects
 * downstream presentation; the base is a function of EBITDA and depreciation).
 */
export async function computeYearProfitBase(yyyy) {
  const year = await computeYearPnl(yyyy, 12, 'mcf');
  const ebitda = year.ebitda.by_month || {};
  const depSection = year.sections.find(s => s.key === 'Depreciación');
  const dep = depSection ? depSection.by_month : zeroMonths();
  let total = 0;
  for (let m = 1; m <= 12; m++) {
    total += Math.max(0, (ebitda[m] || 0) - (dep[m] || 0));
  }
  return total;
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
