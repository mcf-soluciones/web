import { computeProjection } from '../_lib/projections.js';
import baselineHandler from './baseline.js';

/**
 * POST /api/projections/compute
 *   body: { baseline_yyyy_mm: 'YYYY-MM', payload: {...} }
 *
 * Stateless compute. Loads baseline via the baseline endpoint internally,
 * then runs computeProjection. Returns { pnl, cashflow, balance_sheet,
 * investment_metrics } with baseline / projected / delta arrays.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const ym = String(body.baseline_yyyy_mm || '').trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      return res.status(400).json({ error: 'baseline_yyyy_mm required (format YYYY-MM)' });
    }
    const payload = body.payload || {};

    // Re-use baseline.js by calling its handler in-process (no self-fetch).
    // Static import so Vercel bundles the dependency reliably — dynamic
    // import() of a sibling api function returned undefined on deploy.
    const baselineRes = await captureHandler(baselineHandler, { method: 'GET', query: { yyyy_mm: ym }, body: null });
    if (baselineRes.status !== 200) return res.status(baselineRes.status).json(baselineRes.body);
    const baseline = baselineRes.body;

    const result = computeProjection(baseline, payload);
    return res.status(200).json({
      baseline_yyyy_mm: ym,
      result,
    });
  } catch (err) {
    console.error('projections/compute error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// Tiny in-process invocation of another handler to avoid a self-fetch.
function captureHandler(handler, fakeReq) {
  return new Promise((resolve, reject) => {
    const fakeRes = {
      _status: 200, _body: null, _headers: {},
      setHeader(k, v) { this._headers[k] = v; },
      status(c) { this._status = c; return this; },
      json(obj) { this._body = obj; resolve({ status: this._status, body: obj }); },
      end() { resolve({ status: this._status, body: null }); },
    };
    Promise.resolve(handler(fakeReq, fakeRes)).catch(reject);
  });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
