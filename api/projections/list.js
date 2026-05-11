import turso from '../_lib/turso.js';

/**
 * GET /api/projections/list
 *   -> { projections: [{ id, name, description, baseline_yyyy_mm,
 *                        owner, created_at, updated_at }] }
 *
 * Returns metadata only — `payload` is omitted to keep the list lean.
 * Use /api/projections/get?id= for the full payload.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const r = await turso.execute(
      `SELECT id, name, description, baseline_yyyy_mm, owner, created_at, updated_at
       FROM projections ORDER BY updated_at DESC`
    );
    return res.status(200).json({
      projections: r.rows.map(row => ({
        id: Number(row.id),
        name: row.name,
        description: row.description,
        baseline_yyyy_mm: row.baseline_yyyy_mm,
        owner: row.owner,
        created_at: row.created_at,
        updated_at: row.updated_at,
      })),
    });
  } catch (err) {
    console.error('projections/list error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
