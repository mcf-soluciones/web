import turso from '../_lib/turso.js';

/**
 * GET /api/tax-settlements/list
 * Returns all closed fiscal years, newest first.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const r = await turso.execute(
      `SELECT yyyy, actual_is, year_profit_base, notes, filed_at, updated_at
       FROM tax_settlements
       ORDER BY yyyy DESC`
    );
    return res.status(200).json({ rows: r.rows });
  } catch (err) {
    console.error('tax-settlements/list error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
