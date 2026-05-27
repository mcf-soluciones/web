// Same as scenario-plan.mjs but normalizes insurance (G6) to 30 €/month per
// location — matching MCF's real precedent (Usera ~30/mo, Hortaleza ~33/mo).
// In-memory only; saved scenarios in DB are not modified.
import turso from '../api/_lib/turso.js';
import { computeProjection } from '../api/_lib/projections.js';
import baselineHandler from '../api/projections/baseline.js';

function captureHandler(h, req) {
  return new Promise((resolve, reject) => {
    const fakeRes = {
      _status: 200, _body: null, _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      status(c) { this._status = c; return this; },
      json(o) { this._body = o; resolve({ status: this._status, body: o }); },
      end() { resolve({ status: this._status, body: null }); },
    };
    Promise.resolve(h(req, fakeRes)).catch(reject);
  });
}

const baseline = (await captureHandler(baselineHandler, { method: 'GET', query: { yyyy_mm: '2026-04' }, body: null })).body;
const r = await turso.execute('SELECT id, payload FROM projections WHERE id IN (5,6,7,8)');
const saved = {};
for (const row of r.rows) saved[row.id] = JSON.parse(row.payload);

// Normalize insurance G6 → 30 €/mo for every sucursal in every payload
const G6_REAL = 30;
function fixInsurance(payload) {
  const p = JSON.parse(JSON.stringify(payload));
  for (const ns of (p.new_sucursales || [])) {
    if (!Array.isArray(ns.cost_lines)) continue;
    for (const line of ns.cost_lines) {
      if (line.cuenta === 'G6') line.monthly = G6_REAL;
    }
  }
  return p;
}

for (const id of Object.keys(saved)) saved[id] = fixInsurance(saved[id]);

const alc1Tpl = saved[7].new_sucursales[0];
const alc2Tpl = saved[7].new_sucursales[1];
const prosTpl = saved[8].new_sucursales[0];

const isVar = (c) => ['E', 'F', 'H'].includes(String(c || '').charAt(0).toUpperCase());

function scaleSucursal(ns, salesFactor, variableCostFactor) {
  const out = JSON.parse(JSON.stringify(ns));
  out.annual_sales = Math.round(ns.annual_sales * salesFactor);
  for (const line of out.cost_lines) {
    const cf = isVar(line.cuenta) ? variableCostFactor : 1;
    line.monthly = Math.round(line.monthly * cf);
  }
  return out;
}

function makePayload(opts) {
  return {
    kind: 'new_sucursal',
    investment: {
      purchase_price: opts.price, down_payment_pct: opts.dpPct,
      interest_rate: opts.rate, loan_term: opts.term,
      discount_rate: 6, analysis_period: 7, terminal_value: opts.terminal ?? 15000,
      inflation_rate: 0.5, price_increase_rate: 0.2,
    },
    new_sucursales: opts.sucursales,
    existing_adjustments: [], capex_events: opts.capex || [], extra_loans: opts.loans || [],
  };
}

const sce = [];
sce.push({ tag: 'E1', name: 'Alc 69K @ 6.6%/6yr (saved#5, seguro corregido)', payload: saved[5] });
sce.push({ tag: 'E2', name: 'Alc 59K @ 6.6%/6yr (saved#6, seguro corregido)', payload: saved[6] });
sce.push({ tag: 'E3', name: 'Alc 69K @ 8.5%/7yr (saved#7, seguro corregido)', payload: saved[7] });
sce.push({ tag: 'E4', name: 'Pros 65K, 85% cash (saved#8, seguro corregido)', payload: saved[8] });
sce.push({ tag: 'A1', name: 'Alc 59K — 100% cash', payload: makePayload({ price: 59000, dpPct: 100, rate: 0, term: 0, sucursales: [alc1Tpl, alc2Tpl] }) });
sce.push({ tag: 'A2', name: 'Alc 69K — 100% cash', payload: makePayload({ price: 69000, dpPct: 100, rate: 0, term: 0, sucursales: [alc1Tpl, alc2Tpl] }) });
sce.push({ tag: 'P1', name: 'Pros 65K — 100% cash', payload: makePayload({ price: 65000, dpPct: 100, rate: 0, term: 0, sucursales: [prosTpl] }) });
sce.push({ tag: 'P2', name: 'Pros 55K — 100% cash (lower offer)', payload: makePayload({ price: 55000, dpPct: 100, rate: 0, term: 0, sucursales: [prosTpl] }) });
sce.push({ tag: 'B1', name: 'Both: Alc 69K (bank loan) + Pros 65K (cash)', payload: makePayload({ price: 134000, dpPct: 65000 / 134000 * 100, rate: 8.5, term: 7, sucursales: [alc1Tpl, alc2Tpl, prosTpl] }) });
sce.push({ tag: 'B2', name: 'Both: Alc 59K (bank loan) + Pros 65K (cash)', payload: makePayload({ price: 124000, dpPct: 65000 / 124000 * 100, rate: 8.5, term: 7, sucursales: [alc1Tpl, alc2Tpl, prosTpl] }) });
sce.push({ tag: 'B3', name: 'Both: Alc 59K + Pros 55K (lower offers)', payload: makePayload({ price: 114000, dpPct: 65000 / 114000 * 100, rate: 8.5, term: 7, sucursales: [alc1Tpl, alc2Tpl, prosTpl] }) });
sce.push({ tag: 'D1', name: 'DOWN −30%: Alc 69K @ 8.5%', payload: makePayload({ price: 69000, dpPct: 20, rate: 8.5, term: 7, sucursales: [scaleSucursal(alc1Tpl, 0.70, 0.85), scaleSucursal(alc2Tpl, 0.70, 0.85)] }) });
sce.push({ tag: 'D2', name: 'DOWN −30%: Pros 65K, 85% cash', payload: makePayload({ price: 65000, dpPct: 85, rate: 8.5, term: 7, sucursales: [scaleSucursal(prosTpl, 0.70, 0.85)] }) });
sce.push({ tag: 'D3', name: 'DOWN −30%: Both', payload: makePayload({ price: 134000, dpPct: 65000 / 134000 * 100, rate: 8.5, term: 7, sucursales: [scaleSucursal(alc1Tpl, 0.70, 0.85), scaleSucursal(alc2Tpl, 0.70, 0.85), scaleSucursal(prosTpl, 0.70, 0.85)] }) });

const alc1B10 = { ...JSON.parse(JSON.stringify(alc1Tpl)), annual_sales: Math.round(alc1Tpl.annual_sales * 1.10) };
const alc2B10 = { ...JSON.parse(JSON.stringify(alc2Tpl)), annual_sales: Math.round(alc2Tpl.annual_sales * 1.10) };
sce.push({ tag: 'I1', name: 'Alc 69K + 8K mejora (sales +10%)', payload: makePayload({ price: 69000, dpPct: 20, rate: 8.5, term: 7, sucursales: [alc1B10, alc2B10], capex: [{ date: '2026-10', description: 'Mejora equipo Alcorcón', amount: 8000, depreciation_years: 7 }] }) });
const alc1B05 = { ...JSON.parse(JSON.stringify(alc1Tpl)), annual_sales: Math.round(alc1Tpl.annual_sales * 1.05) };
const alc2B05 = { ...JSON.parse(JSON.stringify(alc2Tpl)), annual_sales: Math.round(alc2Tpl.annual_sales * 1.05) };
sce.push({ tag: 'I2', name: 'Alc 69K + 8K mejora (sales +5%)', payload: makePayload({ price: 69000, dpPct: 20, rate: 8.5, term: 7, sucursales: [alc1B05, alc2B05], capex: [{ date: '2026-10', description: 'Mejora equipo Alcorcón', amount: 8000, depreciation_years: 7 }] }) });

const alc1Full = JSON.parse(JSON.stringify(alc1Tpl));
alc1Full.cost_lines = alc1Full.cost_lines.map(l => l.cuenta === 'G9' ? { ...l, monthly: l.monthly + 400 } : l);
const alc2Full = JSON.parse(JSON.stringify(alc2Tpl));
alc2Full.cost_lines = alc2Full.cost_lines.map(l => l.cuenta === 'G9' ? { ...l, monthly: l.monthly + 400 } : l);
sce.push({ tag: 'S1', name: 'Alc 69K @ 8.5% — persona 100% cargada (+800/mo)', payload: makePayload({ price: 69000, dpPct: 20, rate: 8.5, term: 7, sucursales: [alc1Full, alc2Full] }) });

const fmt = (n) => (Math.round(n) || 0).toLocaleString('es-ES');
console.log('| Tag | Scenario | Price | Cash Out | Loan | Annual Op Cash | Annual Debt Svc | Annual Net Cash | NPV(7yr) | IRR | Payback | ROI |');
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const s of sce) {
  const result = computeProjection(baseline, s.payload);
  const im = result.investment_metrics;
  const dpPct = s.payload.investment.down_payment_pct;
  const price = s.payload.investment.purchase_price;
  const cashOut = price * dpPct / 100;
  const loan = price - cashOut;
  console.log('| ' + s.tag + ' | ' + s.name + ' | ' + fmt(price) + ' | ' + fmt(cashOut) + ' | ' + fmt(loan) + ' | ' + fmt(im.annual_operating_cash) + ' | ' + fmt(im.annual_loan_service) + ' | ' + fmt(im.annual_cash_flow) + ' | ' + fmt(im.npv) + ' | ' + (im.irr == null ? '—' : (im.irr * 100).toFixed(0) + '%') + ' | ' + (isFinite(im.payback_period) ? im.payback_period.toFixed(2) : '∞') + ' | ' + im.roi.toFixed(0) + '% |');
}
process.exit(0);
