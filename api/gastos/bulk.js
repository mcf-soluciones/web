import turso from '../_lib/turso.js';
import { BULK_FIELDS, coerce } from '../_lib/gastos-editable.js';

/**
 * PATCH /api/gastos/bulk
 *   body: { ids: [<id>, ...], patch: { <field>: <value>, ... } }
 *
 * Applies the same column change(s) to N rows. Uses a batch transaction.
 * Allowed fields: see BULK_FIELDS whitelist — numeric columns (importe_*)
 * are intentionally excluded; those should be edited per-row.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const ids = Array.isArray(body.ids) ? body.ids.map(toInt).filter(Number.isFinite) : [];
    const patch = body.patch || {};
    if (ids.length === 0) return res.status(400).json({ error: 'ids array is required' });
    if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'patch must be a non-empty object' });
    }

    const updates = {};
    for (const [field, raw] of Object.entries(patch)) {
      if (!BULK_FIELDS.has(field)) {
        return res.status(400).json({ error: `field not bulk-editable: ${field}` });
      }
      updates[field] = coerce(field, raw);
    }

    // cuenta changes also trigger categoria re-resolution.
    if ('cuenta' in updates) {
      updates.categoria_gastos_mcf = await resolveCategoria(updates.cuenta);
    }

    const fields = Object.keys(updates);
    const setClause = fields.map(f => `${quote(f)} = ?`).join(', ');
    const placeholders = ids.map(() => '?').join(',');
    const args = [...fields.map(f => updates[f]), ...ids];

    const rs = await turso.execute({
      sql: `UPDATE gastos SET ${setClause} WHERE id IN (${placeholders})`,
      args,
    });

    return res.status(200).json({
      success: true,
      updated: Number(rs.rowsAffected) || 0,
      ids,
      updated_fields: fields,
    });
  } catch (err) {
    console.error('gastos/bulk error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function resolveCategoria(cuenta) {
  if (!cuenta) return null;
  try {
    const r = await turso.execute({
      sql: `SELECT categoria_gastos_mcf FROM catalogo_cuentas WHERE cuenta_mcf = ? LIMIT 1`,
      args: [String(cuenta).trim()],
    });
    return r.rows[0]?.categoria_gastos_mcf || null;
  } catch {
    return null;
  }
}

function quote(ident) { return `"${ident.replace(/"/g, '""')}"`; }
function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
