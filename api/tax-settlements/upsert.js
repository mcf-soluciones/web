import turso from '../_lib/turso.js';
import { computeYearProfitBase } from '../reports/pnl.js';

/**
 * POST /api/tax-settlements/upsert
 *   body: { yyyy, actual_is, notes? }
 *
 * Snapshots year_profit_base from the current P&L state. From this moment on,
 * the P&L for `yyyy` will allocate `actual_is` across months instead of
 * estimating IS via the synthetic N8 rule.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const b = req.body || {};
    const yyyy = parseInt(b.yyyy, 10);
    const actualIs = parseFloat(b.actual_is);
    const notes = b.notes ? String(b.notes).trim() : null;

    if (!Number.isFinite(yyyy) || yyyy < 2000 || yyyy > 2100) {
      return res.status(400).json({ error: 'yyyy must be a valid year' });
    }
    if (!Number.isFinite(actualIs) || actualIs < 0) {
      return res.status(400).json({ error: 'actual_is must be a non-negative number' });
    }

    const yearProfitBase = await computeYearProfitBase(yyyy);

    await turso.execute({
      sql: `INSERT INTO tax_settlements (yyyy, actual_is, year_profit_base, notes, filed_at, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(yyyy) DO UPDATE SET
              actual_is        = excluded.actual_is,
              year_profit_base = excluded.year_profit_base,
              notes            = excluded.notes,
              updated_at       = datetime('now')`,
      args: [yyyy, actualIs, yearProfitBase, notes],
    });

    return res.status(200).json({
      success: true,
      yyyy,
      actual_is: actualIs,
      year_profit_base: yearProfitBase,
    });
  } catch (err) {
    console.error('tax-settlements/upsert error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
