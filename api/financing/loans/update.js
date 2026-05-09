import turso from '../../_lib/turso.js';
import { canonicalizePropiedad } from '../../_lib/propiedad.js';

const EDITABLE = new Set([
  'name', 'lender', 'principal_original', 'start_date', 'term_months',
  'interest_rate', 'status', 'propiedad', 'notes', 'recibo_url',
]);

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const body = req.body || {};
    const id = parseInt(body.id, 10);
    const patch = body.patch || {};
    if (!id) return res.status(400).json({ error: 'id is required' });

    const updates = {};
    for (const [k, v] of Object.entries(patch)) {
      if (!EDITABLE.has(k)) return res.status(400).json({ error: `field not editable: ${k}` });
      if (k === 'principal_original' || k === 'interest_rate') updates[k] = v == null ? null : parseFloat(v);
      else if (k === 'term_months') updates[k] = v == null ? null : parseInt(v, 10);
      else if (k === 'propiedad') updates[k] = canonicalizePropiedad(v);
      else updates[k] = v == null || v === '' ? null : String(v);
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'patch is empty' });

    const fields = Object.keys(updates);
    const sql = `UPDATE loans SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`;
    const args = [...fields.map(f => updates[f]), id];
    const r = await turso.execute({ sql, args });
    return res.status(200).json({ success: true, id, rows_changed: Number(r.rowsAffected) || 0 });
  } catch (err) {
    console.error('financing/loans/update error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
