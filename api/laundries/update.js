import turso from '../_lib/turso.js';
import { EDITABLE_FIELDS, coerce } from '../_lib/laundries-editable.js';

/**
 * PATCH /api/laundries/update
 *   body: { id: number, patch: { <field>: <value>, ... } }
 *
 * Updates a single laundry row. Only whitelisted columns may be changed.
 * Always bumps updated_at.
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
    if (!patch || typeof patch !== 'object') {
      return res.status(400).json({ error: 'patch must be an object' });
    }

    const updates = {};
    for (const [field, raw] of Object.entries(patch)) {
      if (!EDITABLE_FIELDS.has(field)) {
        return res.status(400).json({ error: `field not editable: ${field}` });
      }
      updates[field] = coerce(field, raw);
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'patch has no valid fields' });
    }

    const fields = Object.keys(updates);
    const setClause = fields.map(f => `${quote(f)} = ?`).join(', ');
    const args = [...fields.map(f => updates[f]), id];

    const rs = await turso.execute({
      sql: `UPDATE laundries SET ${setClause}, updated_at = datetime('now') WHERE id = ?`,
      args,
    });

    return res.status(200).json({
      success: true,
      id,
      updated_fields: fields,
      rows_changed: Number(rs.rowsAffected) || 0,
    });
  } catch (err) {
    console.error('laundries/update error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function quote(ident) { return `"${ident.replace(/"/g, '""')}"`; }
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
