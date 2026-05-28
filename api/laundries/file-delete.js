import turso from '../_lib/turso.js';

/**
 * DELETE /api/laundries/file-delete?id=<file_id>
 *
 * Removes a single laundry_files row. The Drive file is left in place
 * (kept for audit, same convention as photo-delete and gastos delete).
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
      sql: `DELETE FROM laundry_files WHERE id = ?`,
      args: [id],
    });

    return res.status(200).json({
      success: true,
      id,
      rows_deleted: Number(rs.rowsAffected) || 0,
    });
  } catch (err) {
    console.error('laundries/file-delete error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
