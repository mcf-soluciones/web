import turso from '../_lib/turso.js';

/**
 * GET /api/laundries/notes?id=<laundry_id>
 *
 * Returns every dated note for one laundry, newest first.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const id = toInt(req.query.id);
    if (!id) return res.status(400).json({ error: 'id is required' });

    const rs = await turso.execute({
      sql: `SELECT id, laundry_id, note_date, body, author, created_at, updated_at
            FROM laundry_notes
            WHERE laundry_id = ?
            ORDER BY note_date DESC, id DESC`,
      args: [id],
    });

    return res.status(200).json({ count: rs.rows.length, rows: rs.rows });
  } catch (err) {
    console.error('laundries/notes error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
