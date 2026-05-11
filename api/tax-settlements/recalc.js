import turso from '../_lib/turso.js';
import { computeYearProfitBase } from '../reports/pnl.js';

/**
 * POST /api/tax-settlements/recalc   body: { yyyy }
 *
 * Recomputes year_profit_base for an existing closed year. Use this after
 * editing prior-year gastos so the per-month IS allocation reflects the new
 * profit shape. Does NOT change actual_is or notes.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const b = req.body || {};
    const yyyy = parseInt(b.yyyy, 10);
    if (!Number.isFinite(yyyy)) {
      return res.status(400).json({ error: 'yyyy is required' });
    }

    const existing = await turso.execute({
      sql: `SELECT year_profit_base FROM tax_settlements WHERE yyyy = ?`,
      args: [yyyy],
    });
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: `No closed settlement for yyyy=${yyyy}` });
    }
    const oldBase = Number(existing.rows[0].year_profit_base) || 0;

    const newBase = await computeYearProfitBase(yyyy);

    await turso.execute({
      sql: `UPDATE tax_settlements
            SET year_profit_base = ?, updated_at = datetime('now')
            WHERE yyyy = ?`,
      args: [newBase, yyyy],
    });

    return res.status(200).json({
      success: true,
      yyyy,
      old_base: oldBase,
      new_base: newBase,
    });
  } catch (err) {
    console.error('tax-settlements/recalc error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
