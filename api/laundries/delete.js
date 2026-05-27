import turso from '../_lib/turso.js';

/**
 * DELETE /api/laundries/delete?id=123   (also accepts POST { id })
 *
 * Hard-deletes a single laundry row. Cascades to laundry_photos via FK.
 * Does NOT remove the Drive-hosted photo files (kept for audit).
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const id = toInt(req.query.id ?? req.body?.id);
    if (!id) return res.status(400).json({ error: 'id is required' });

    const rs = await turso.execute({
      sql: `DELETE FROM laundries WHERE id = ?`,
      args: [id],
    });

    return res.status(200).json({
      success: true,
      id,
      rows_deleted: Number(rs.rowsAffected) || 0,
    });
  } catch (err) {
    console.error('laundries/delete error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
