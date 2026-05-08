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
  const [salesRs, gastosRs] = await Promise.all([
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
    // Outflows: every gasto in the year, with es_inversion flag + catalog join
    turso.execute({
      sql: `SELECT g.cuenta, g.mm, g.propiedad,
                   COALESCE(g.importe_total, g.gasto, 0) AS importe,
                   g.categoria_gastos_mcf,
                   COALESCE(g.es_inversion, 'No') AS es_inversion,
                   g.concepto_mcf,
                   c.desc AS cuenta_desc, c.tooltip AS cuenta_tooltip
            FROM gastos g
            LEFT JOIN catalogo_cuentas c ON g.cuenta = c.cuenta_mcf
            WHERE g.yyyy = ? AND g.cuenta IS NOT NULL`,
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

  // --- Compute subtotals ---------------------------------------------------
  const cfo = sumMaps([inflowsSection.by_month, operatingSection.by_month, taxSection.by_month]);
  const cfi = { ...investingSection.by_month };
  const cff = zeroMonths();  // placeholder
  const netChange = sumMaps([cfo, cfi, cff]);

  return {
    yyyy,
    current_mm: currentMm,
    sections: [inflowsSection, operatingSection, taxSection, investingSection],
    cfo: { by_month: cfo, ytd: sumYtd(cfo, currentMm) },
    cfi: { by_month: cfi, ytd: sumYtd(cfi, currentMm) },
    cff: {
      by_month: cff,
      ytd: 0,
      note: 'CFF pendiente — requiere tabla financing_events (préstamos, aportes, retiros).',
    },
    net_change: { by_month: netChange, ytd: sumYtd(netChange, currentMm) },
    total_inflows: { by_month: inflowsSection.by_month, ytd: inflowsSection.ytd },
  };
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
