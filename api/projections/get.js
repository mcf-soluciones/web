import turso from '../_lib/turso.js';

/**
 * GET /api/projections/get?id=
 *   -> full projection row including parsed payload
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const id = parseInt(req.query.id, 10);
    if (!id) return res.status(400).json({ error: 'id is required' });
    const r = await turso.execute({
      sql: `SELECT id, name, description, baseline_yyyy_mm, payload, owner, created_at, updated_at
            FROM projections WHERE id = ?`,
      args: [id],
    });
    if (r.rows.length === 0) return res.status(404).json({ error: `projection ${id} not found` });
    const row = r.rows[0];
    let payload;
    try { payload = JSON.parse(row.payload); } catch { payload = {}; }
    return res.status(200).json({
      id: Number(row.id),
      name: row.name,
      description: row.description,
      baseline_yyyy_mm: row.baseline_yyyy_mm,
      owner: row.owner,
      created_at: row.created_at,
      updated_at: row.updated_at,
      payload,
    });
  } catch (err) {
    console.error('projections/get error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
