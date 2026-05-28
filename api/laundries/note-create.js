import turso from '../_lib/turso.js';

/**
 * POST /api/laundries/note-create
 *   body: { laundry_id, note_date (YYYY-MM-DD), body, author? }
 *
 * Appends a dated note to a laundry. note_date is required so the log stays
 * meaningful even when entries are added retroactively.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const laundryId = toInt(body.laundry_id);
    const noteDate = normalizeDate(body.note_date);
    const text = (body.body || '').toString().trim();
    if (!laundryId) return res.status(400).json({ error: 'laundry_id is required' });
    if (!noteDate) return res.status(400).json({ error: 'note_date (YYYY-MM-DD) is required' });
    if (!text) return res.status(400).json({ error: 'body is required' });

    const check = await turso.execute({
      sql: `SELECT id FROM laundries WHERE id = ? LIMIT 1`,
      args: [laundryId],
    });
    if (check.rows.length === 0) return res.status(404).json({ error: 'laundry not found' });

    const rs = await turso.execute({
      sql: `INSERT INTO laundry_notes (laundry_id, note_date, body, author)
            VALUES (?, ?, ?, ?)`,
      args: [
        laundryId,
        noteDate,
        text,
        (body.author || '').toString().trim() || null,
      ],
    });

    return res.status(200).json({ success: true, id: Number(rs.lastInsertRowid) });
  } catch (err) {
    console.error('laundries/note-create error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function normalizeDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : s;
}
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
