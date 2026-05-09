import turso from '../_lib/turso.js';

/**
 * GET /api/reports/cashflow?mm=3&yyyy=2026
 *
 * Phase 1 cash flow statement — "indirect view" from existing tables:
 *   Inflows  = sales table (fiscal cash receipts, cash + banco account)
 *   Outflows = gastos (operating + taxes) split by es_inversion flag
 *   CFF      = placeholder (no financing_events table yet)
 *
 * All outflows are stored as NEGATIVE numbers so every subtotal is a simple sum.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const mm = toInt(req.query.mm);
    const yyyy = toInt(req.query.yyyy);
    if (!mm || !yyyy) return res.status(400).json({ error: 'mm and yyyy are required' });

    const year = await computeYearCashflow(yyyy, mm);

    return res.status(200).json({
      period: { mm, yyyy },
      year,
    });
  } catch (err) {
    console.error('reports/cashflow error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// =============================================================================
// Helpers
// =============================================================================

const zeroMonths = () => ({ 1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0,9:0,10:0,11:0,12:0 });
const addMonth = (a, mm, v) => { a[mm] = (a[mm] || 0) + v; };
const sumYtd = (obj, throughMm) => {
  let s = 0;
  for (let m = 1; m <= throughMm; m++) s += obj[m] || 0;
  return s;
};
const sumMaps = (maps) => {
  const out = zeroMonths();
  for (const map of maps) for (let m = 1; m <= 12; m++) out[m] += map[m] || 0;
  return out;
};
const negMap = (obj) => {
  const out = zeroMonths();
  for (let m = 1; m <= 12; m++) out[m] = -(obj[m] || 0);
  return out;
};

const LETTER_LABELS = {
  C: 'Alquiler',
  D: 'Financiamiento (interés y comisiones)',
  E: 'Consumibles (Core)',
  F: 'Consumibles (Non-Core)',
  G: 'Fijos Otros',
  H: 'Clientes',
  I: 'Mantenimiento de Maquinaria y Equipo',
  J: 'Corporate',
  N: 'Impuestos pagados',
  O: 'Depreciación (no-cash)',
  Z: 'Adquisición o Inversiones',    // capex — always routes to CFI
};

function propertyLabel(p) {
  if (!p) return '(sin propiedad)';
  const s = String(p).toLowerCase();
  if (s.includes('usera')) return '(001) Usera';
  if (s.includes('hortaleza')) return '(002) Hortaleza';
  if (s.includes('corporate')) return 'Corporate';
  return p;
}

// =============================================================================
// Year cash flow
// =============================================================================

async function computeYearCashflow(yyyy, currentMm) {
  const [salesRs, gastosRs, financingEventsRs, loanPaymentsRs] = await Promise.all([
    // Inflows: daily sales aggregated by (mm, account, property), filtered by
    // property activation date so pre-acquisition rows (e.g. Hortaleza before
    // 2025-08-01) don't leak into our cash flow.
    turso.execute({
      sql: `SELECT CAST(substr(s.date_real, 6, 2) AS INTEGER) AS mm,
                   s.account,
                   CASE WHEN s.mcf_user LIKE '%hortaleza%' THEN 'hortaleza'
                        WHEN s.mcf_user LIKE '%usera%'     THEN 'usera'
                        ELSE 'unknown' END AS property,
                   COALESCE(SUM(s.euros), 0) AS euros
            FROM sales s
            LEFT JOIN property_activation pa ON
              (pa.property = 'hortaleza' AND s.mcf_user LIKE '%hortaleza%')
              OR (pa.property = 'usera'     AND s.mcf_user LIKE '%usera%')
            WHERE substr(s.date_real, 1, 4) = ?
              AND (pa.start_date IS NULL OR s.date_real >= pa.start_date)
            GROUP BY mm, s.account, property`,
      args: [String(yyyy)],
    }),
    // Outflows: every gasto in the year, with es_inversion flag + catalog join.
    // For loan-payment rows the operating-bucket only sees the interest portion;
    // the principal is split out by the loanPaymentsRs query below into CFF.
    turso.execute({
      sql: `SELECT g.cuenta, g.mm, g.propiedad,
                   CASE
                     WHEN g.loan_id IS NOT NULL THEN COALESCE(g.loan_payment_interest, 0)
                     ELSE COALESCE(g.importe_total, g.gasto, 0)
                   END AS importe,
                   g.categoria_gastos_mcf,
                   COALESCE(g.es_inversion, 'No') AS es_inversion,
                   g.concepto_mcf,
                   c.desc AS cuenta_desc, c.tooltip AS cuenta_tooltip
            FROM gastos g
            LEFT JOIN catalogo_cuentas c ON g.cuenta = c.cuenta_mcf
            WHERE g.yyyy = ? AND g.cuenta IS NOT NULL`,
      args: [yyyy],
    }),
    // Non-payment financing events: disbursements, equity in/out, fees, refinance.
    turso.execute({
      sql: `SELECT e.event_type, e.mm, e.euros, e.counterparty, e.loan_id,
                   l.name AS loan_name
            FROM financing_events e
            LEFT JOIN loans l ON e.loan_id = l.id
            WHERE e.yyyy = ?`,
      args: [yyyy],
    }),
    // Loan-payment principal — extracted from gastos (the row matches the bank
    // statement; principal goes to CFF, interest stays in CFO via gastosRs).
    turso.execute({
      sql: `SELECT g.mm, g.loan_id, g.propiedad,
                   COALESCE(g.loan_payment_principal, 0) AS principal,
                   l.name AS loan_name
            FROM gastos g
            LEFT JOIN loans l ON g.loan_id = l.id
            WHERE g.yyyy = ?
              AND g.loan_id IS NOT NULL
              AND COALESCE(g.loan_payment_principal, 0) > 0`,
      args: [yyyy],
    }),
  ]);

  // --- Build INFLOWS sections ----------------------------------------------
  // Group by (account, property) → 4 items: cash×usera, cash×horta, banco×usera, banco×horta
  const inflowItems = new Map();  // key: account|property → {label, code, by_month}
  for (const r of salesRs.rows) {
    const account = r.account || 'unknown';
    const prop = r.property;
    const key = `${account}|${prop}`;
    if (!inflowItems.has(key)) {
      inflowItems.set(key, {
        code: `${account.slice(0, 1).toUpperCase()}-${prop.slice(0, 1).toUpperCase()}`,
        label: `${account === 'banco' ? 'Tarjeta banco' : 'Efectivo'} — ${propertyLabel(prop)}`,
        desc: account, property_label: propertyLabel(prop),
        by_month: zeroMonths(),
      });
    }
    addMonth(inflowItems.get(key).by_month, Number(r.mm), Number(r.euros));
  }

  // Subsections by account (cash vs banco)
  const inflowSubByAccount = new Map();
  for (const [key, item] of inflowItems) {
    const account = key.split('|')[0];
    if (!inflowSubByAccount.has(account)) {
      inflowSubByAccount.set(account, {
        key: account === 'banco' ? 'BAN' : 'CSH',
        label: account === 'banco' ? 'Ingresos con tarjeta banco' : 'Ingresos en efectivo',
        by_month: zeroMonths(),
        items: [],
        order: account === 'banco' ? 2 : 1,
      });
    }
    const sub = inflowSubByAccount.get(account);
    sub.items.push({ ...item, ytd: sumYtd(item.by_month, currentMm) });
    for (let m = 1; m <= 12; m++) addMonth(sub.by_month, m, item.by_month[m]);
  }
  const inflowSubsList = Array.from(inflowSubByAccount.values())
    .map(s => ({ ...s, ytd: sumYtd(s.by_month, currentMm) }))
    .sort((a, b) => a.order - b.order);
  const inflowsSection = buildSection('Ingresos', 'Ingresos operativos',
    inflowSubsList, currentMm, { positive: true });

  // --- Build OUTFLOWS (operating + taxes) grouped by letter ----------------
  const letterAgg = {};
  for (const r of gastosRs.rows) {
    const code = String(r.cuenta || '').trim();
    if (!code) continue;
    const letter = code.charAt(0).toUpperCase();
    if (!LETTER_LABELS[letter]) continue;
    const esInv = r.es_inversion === 'Si';
    const isVirtual = (r.categoria_gastos_mcf || '') === 'Virtuales';
    if (isVirtual) continue; // skip non-cash
    const isTax = letter === 'N';
    const bucket = esInv ? 'investing' : (isTax ? 'taxes' : 'operating');
    const key = `${bucket}|${letter}`;
    if (!letterAgg[key]) {
      letterAgg[key] = {
        bucket, letter,
        label: LETTER_LABELS[letter],
        by_month: zeroMonths(),
        items: new Map(),
      };
    }
    const b = letterAgg[key];
    const mm = Number(r.mm);
    const importe = Number(r.importe || 0);
    addMonth(b.by_month, mm, importe);

    const propLabel = propertyLabel(r.propiedad);
    const itemKey = `${code}|${propLabel}`;
    if (!b.items.has(itemKey)) {
      const desc = r.cuenta_desc || r.concepto_mcf || `Cuenta ${code}`;
      b.items.set(itemKey, {
        code, label: `${desc} — ${propLabel}`,
        desc, property_label: propLabel,
        tooltip: r.cuenta_tooltip,
        by_month: zeroMonths(),
      });
    }
    addMonth(b.items.get(itemKey).by_month, mm, importe);
  }

  const bucketize = (bucket, title) => {
    const subs = Object.values(letterAgg)
      .filter(b => b.bucket === bucket)
      .map(b => ({
        key: b.letter,
        label: b.label,
        by_month: negMap(b.by_month),                  // outflows are NEGATIVE
        items: Array.from(b.items.values()).map(it => ({
          ...it,
          by_month: negMap(it.by_month),
          ytd: sumYtd(negMap(it.by_month), currentMm),
        })).sort((a, b) => a.code.localeCompare(b.code)),
      }))
      .map(s => ({ ...s, ytd: sumYtd(s.by_month, currentMm) }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return buildSection(title, title, subs, currentMm, { positive: false });
  };

  const operatingSection = bucketize('operating', 'Pagos operativos');
  const taxSection = bucketize('taxes', 'Pagos de impuestos');
  const investingSection = bucketize('investing', 'Inversión (Capex)');

  // --- Build CFF section (Financiamiento) ----------------------------------
  // Subsections:
  //   Préstamos: principal pagado (− from gastos.loan_payment_principal)
  //              disbursements    (+ from financing_events 'disbursement')
  //   Capital:   aportaciones     (+ from financing_events 'equity_in')
  //              retiros          (− from financing_events 'equity_out')
  //   Otros:     comisiones únicas (− from financing_events 'fee_one_time')
  //              refinanciación    (sign-neutral by default; stored as positive)
  const cffSection = buildCffSection(financingEventsRs.rows, loanPaymentsRs.rows, currentMm);

  // --- Compute subtotals ---------------------------------------------------
  const cfo = sumMaps([inflowsSection.by_month, operatingSection.by_month, taxSection.by_month]);
  const cfi = { ...investingSection.by_month };
  const cff = { ...cffSection.by_month };
  const netChange = sumMaps([cfo, cfi, cff]);

  return {
    yyyy,
    current_mm: currentMm,
    sections: [inflowsSection, operatingSection, taxSection, investingSection, cffSection],
    cfo: { by_month: cfo, ytd: sumYtd(cfo, currentMm) },
    cfi: { by_month: cfi, ytd: sumYtd(cfi, currentMm) },
    cff: { by_month: cff, ytd: sumYtd(cff, currentMm) },
    net_change: { by_month: netChange, ytd: sumYtd(netChange, currentMm) },
    total_inflows: { by_month: inflowsSection.by_month, ytd: inflowsSection.ytd },
  };
}

// CFF event_type → sign (applied to the stored positive `euros`).
const CFF_SIGN = {
  disbursement: +1,
  equity_in: +1,
  equity_out: -1,
  fee_one_time: -1,
  refinance: +1,
};
const CFF_LABEL = {
  disbursement: 'Desembolso de préstamo',
  equity_in: 'Aportación de capital',
  equity_out: 'Retiro de capital',
  fee_one_time: 'Comisión única',
  refinance: 'Refinanciación',
};

function buildCffSection(eventRows, loanPaymentRows, currentMm) {
  // Group financing_events by event_type.
  const byType = {};
  for (const r of eventRows) {
    const t = r.event_type;
    if (!byType[t]) byType[t] = { items: new Map(), by_month: zeroMonths() };
    const sign = CFF_SIGN[t] ?? -1;
    const signed = Number(r.euros) * sign;
    addMonth(byType[t].by_month, Number(r.mm), signed);
    const itemKey = r.loan_id ? `loan:${r.loan_id}` : `cp:${r.counterparty || '(sin contraparte)'}`;
    if (!byType[t].items.has(itemKey)) {
      byType[t].items.set(itemKey, {
        code: r.loan_id ? `L${r.loan_id}` : 'CP',
        label: r.loan_name
          ? `${CFF_LABEL[t] || t} — ${r.loan_name}`
          : `${CFF_LABEL[t] || t} — ${r.counterparty || '(sin contraparte)'}`,
        desc: CFF_LABEL[t] || t,
        property_label: r.counterparty || r.loan_name || '',
        by_month: zeroMonths(),
      });
    }
    addMonth(byType[t].items.get(itemKey).by_month, Number(r.mm), signed);
  }

  const subs = [];

  // Préstamos sub: principal pagado + disbursement + refinance
  const loanByMonth = zeroMonths();
  const loanItems = [];

  // Principal payments — group by loan_id
  const principalByLoan = new Map();
  for (const r of loanPaymentRows) {
    const loanId = r.loan_id;
    const k = `${loanId}`;
    if (!principalByLoan.has(k)) {
      principalByLoan.set(k, {
        code: `L${loanId}`,
        label: `Principal pagado — ${r.loan_name || `Préstamo #${loanId}`}`,
        desc: 'Principal pagado',
        property_label: r.loan_name || `Préstamo #${loanId}`,
        by_month: zeroMonths(),
      });
    }
    const it = principalByLoan.get(k);
    addMonth(it.by_month, Number(r.mm), -Number(r.principal));   // outflow → negative
    addMonth(loanByMonth, Number(r.mm), -Number(r.principal));
  }
  loanItems.push(...principalByLoan.values());

  // Disbursements + refinance fold into the same Préstamos subsection
  for (const t of ['disbursement', 'refinance']) {
    if (!byType[t]) continue;
    for (let m = 1; m <= 12; m++) loanByMonth[m] += byType[t].by_month[m] || 0;
    loanItems.push(...byType[t].items.values());
    delete byType[t];
  }

  if (loanItems.length > 0) {
    subs.push({
      key: 'L',
      label: 'Préstamos',
      by_month: loanByMonth,
      ytd: sumYtd(loanByMonth, currentMm),
      items: loanItems
        .map(it => ({ ...it, ytd: sumYtd(it.by_month, currentMm) }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    });
  }

  // Capital sub: equity in + equity out
  const capByMonth = zeroMonths();
  const capItems = [];
  for (const t of ['equity_in', 'equity_out']) {
    if (!byType[t]) continue;
    for (let m = 1; m <= 12; m++) capByMonth[m] += byType[t].by_month[m] || 0;
    capItems.push(...byType[t].items.values());
    delete byType[t];
  }
  if (capItems.length > 0) {
    subs.push({
      key: 'C',
      label: 'Capital',
      by_month: capByMonth,
      ytd: sumYtd(capByMonth, currentMm),
      items: capItems
        .map(it => ({ ...it, ytd: sumYtd(it.by_month, currentMm) }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    });
  }

  // Otros (anything left, e.g. fee_one_time)
  const otherByMonth = zeroMonths();
  const otherItems = [];
  for (const t of Object.keys(byType)) {
    for (let m = 1; m <= 12; m++) otherByMonth[m] += byType[t].by_month[m] || 0;
    otherItems.push(...byType[t].items.values());
  }
  if (otherItems.length > 0) {
    subs.push({
      key: 'O',
      label: 'Otros',
      by_month: otherByMonth,
      ytd: sumYtd(otherByMonth, currentMm),
      items: otherItems
        .map(it => ({ ...it, ytd: sumYtd(it.by_month, currentMm) }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    });
  }

  return buildSection('Financiamiento', 'Financiamiento (CFF)', subs, currentMm, { positive: false });
}

function buildSection(key, label, subsections, currentMm, { positive }) {
  const by_month = zeroMonths();
  for (const sub of subsections) for (let m = 1; m <= 12; m++) by_month[m] += sub.by_month[m] || 0;
  return {
    key, label, positive,
    by_month,
    ytd: sumYtd(by_month, currentMm),
    subsections,
  };
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
