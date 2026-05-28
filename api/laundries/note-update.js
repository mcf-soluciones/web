import turso from '../_lib/turso.js';

/**
 * PATCH /api/laundries/note-update
 *   body: { id, patch: { note_date?, body? } }
 *
 * Edits an existing dated note. Only note_date and body are mutable;
 * laundry_id and author are immutable post-create.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const id = toInt(body.id);
    const patch = body.patch || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const updates = {};
    if ('note_date' in patch) {
      const d = normalizeDate(patch.note_date);
      if (!d) return res.status(400).json({ error: 'note_date must be YYYY-MM-DD' });
      updates.note_date = d;
    }
    if ('body' in patch) {
      const t = (patch.body || '').toString().trim();
      if (!t) return res.status(400).json({ error: 'body cannot be empty' });
      updates.body = t;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'patch has no valid fields' });
    }

    const fields = Object.keys(updates);
    const setClause = fields.map(f => `"${f}" = ?`).join(', ');
    const args = [...fields.map(f => updates[f]), id];

    const rs = await turso.execute({
      sql: `UPDATE laundry_notes SET ${setClause}, updated_at = datetime('now') WHERE id = ?`,
      args,
    });

    return res.status(200).json({
      success: true,
      id,
      updated_fields: fields,
      rows_changed: Number(rs.rowsAffected) || 0,
    });
  } catch (err) {
    console.error('laundries/note-update error:', err);
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
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
