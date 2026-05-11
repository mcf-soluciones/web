import turso from '../_lib/turso.js';

/**
 * DELETE /api/projections/delete?id=
 * (also accepts POST body)
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const id = parseInt(src.id, 10);
    if (!id) return res.status(400).json({ error: 'id is required' });
    const r = await turso.execute({ sql: `DELETE FROM projections WHERE id = ?`, args: [id] });
    return res.status(200).json({ success: true, rows_changed: Number(r.rowsAffected) || 0 });
  } catch (err) {
    console.error('projections/delete error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
