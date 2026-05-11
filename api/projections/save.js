import turso from '../_lib/turso.js';

/**
 * POST /api/projections/save
 *   body: { id?, name, description?, baseline_yyyy_mm, payload, owner? }
 *
 * If id is provided → UPDATE. Otherwise INSERT. Returns { success, id }.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const ym = String(b.baseline_yyyy_mm || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      return res.status(400).json({ error: 'baseline_yyyy_mm required (format YYYY-MM)' });
    }
    if (!b.payload || typeof b.payload !== 'object') {
      return res.status(400).json({ error: 'payload is required' });
    }
    const payloadJson = JSON.stringify(b.payload);
    const id = b.id ? parseInt(b.id, 10) : null;

    if (id) {
      const r = await turso.execute({
        sql: `UPDATE projections
              SET name = ?, description = ?, baseline_yyyy_mm = ?, payload = ?, owner = ?, updated_at = datetime('now')
              WHERE id = ?`,
        args: [name, b.description || null, ym, payloadJson, b.owner || null, id],
      });
      if (Number(r.rowsAffected) === 0) return res.status(404).json({ error: `projection ${id} not found` });
      return res.status(200).json({ success: true, id });
    } else {
      const ins = await turso.execute({
        sql: `INSERT INTO projections (name, description, baseline_yyyy_mm, payload, owner)
              VALUES (?, ?, ?, ?, ?)`,
        args: [name, b.description || null, ym, payloadJson, b.owner || null],
      });
      return res.status(200).json({ success: true, id: Number(ins.lastInsertRowid) });
    }
  } catch (err) {
    console.error('projections/save error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
