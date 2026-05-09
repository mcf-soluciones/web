import turso from '../_lib/turso.js';
import { EDITABLE_FIELDS, coerce } from '../_lib/gastos-editable.js';
import { canonicalizePropiedad } from '../_lib/propiedad.js';

/**
 * PATCH /api/gastos/update
 *   body: { id: number, patch: { <field>: <value>, ... } }
 *
 * Updates a single gasto row. Only whitelisted columns may be changed.
 * Side effects:
 *   - If fecha changes, mm/yyyy are re-derived from the new fecha.
 *   - If cuenta changes, categoria_gastos_mcf is re-resolved from catalogo_cuentas.
 *   - If importe_total changes, the legacy `gasto` column is kept in sync.
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

    // Side effects --------------------------------------------------------------
    if ('fecha' in updates && updates.fecha) {
      const d = new Date(updates.fecha);
      if (!Number.isNaN(d.getTime())) {
        updates.mm = d.getMonth() + 1;
        updates.yyyy = d.getFullYear();
      }
    }
    if ('cuenta' in updates) {
      updates.categoria_gastos_mcf = await resolveCategoria(updates.cuenta);
    }
    // Always store propiedad in canonical form so the modal's short-form
    // values ("hortaleza") don't overwrite "(002) Hortaleza" on edit.
    if ('propiedad' in updates) {
      updates.propiedad = canonicalizePropiedad(updates.propiedad);
    }
    if ('importe_total' in updates) {
      updates.gasto = updates.importe_total;
    }

    // Loan-payment invariant. If we're touching any of the three loan fields
    // we need to fetch the current row to validate the final state, since the
    // patch may only contain a subset.
    const touchesLoan = 'loan_id' in updates
      || 'loan_payment_interest' in updates
      || 'loan_payment_principal' in updates
      || 'importe_total' in updates;
    if (touchesLoan) {
      const cur = await turso.execute({
        sql: `SELECT loan_id, loan_payment_interest, loan_payment_principal,
                     COALESCE(importe_total, gasto, 0) AS importe_total
              FROM gastos WHERE id = ?`,
        args: [id],
      });
      if (cur.rows.length === 0) return res.status(404).json({ error: 'gasto not found' });
      const merged = {
        loan_id: 'loan_id' in updates ? updates.loan_id : cur.rows[0].loan_id,
        interest: 'loan_payment_interest' in updates ? updates.loan_payment_interest : cur.rows[0].loan_payment_interest,
        principal: 'loan_payment_principal' in updates ? updates.loan_payment_principal : cur.rows[0].loan_payment_principal,
        importe: 'importe_total' in updates ? updates.importe_total : Number(cur.rows[0].importe_total),
      };
      if (merged.loan_id == null) {
        // Clearing the loan link — wipe the split so we don't keep stale halves.
        updates.loan_id = null;
        updates.loan_payment_interest = null;
        updates.loan_payment_principal = null;
      } else {
        const interest = Number(merged.interest);
        const principal = Number(merged.principal);
        if (!Number.isFinite(interest) || interest < 0 || !Number.isFinite(principal) || principal < 0) {
          return res.status(400).json({ error: 'loan_payment_interest and loan_payment_principal must both be ≥ 0' });
        }
        if (Math.abs((interest + principal) - merged.importe) > 0.01) {
          return res.status(400).json({
            error: 'loan_payment_interest + loan_payment_principal must equal importe_total',
            interest, principal, importe_total: merged.importe,
          });
        }
      }
    }

    // Build SQL ----------------------------------------------------------------
    const fields = Object.keys(updates);
    const setClause = fields.map(f => `${quote(f)} = ?`).join(', ');
    const args = [...fields.map(f => updates[f]), id];

    const rs = await turso.execute({
      sql: `UPDATE gastos SET ${setClause} WHERE id = ?`,
      args,
    });

    return res.status(200).json({
      success: true,
      id,
      updated_fields: fields,
      rows_changed: Number(rs.rowsAffected) || 0,
    });
  } catch (err) {
    console.error('gastos/update error:', err);
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

// SQLite identifier quoting — our field names don't contain special chars, but
// we wrap in double-quotes defensively for reserved words (desc is also used
// on catalogo_cuentas and may trip parsers).
function quote(ident) { return `"${ident.replace(/"/g, '""')}"`; }

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
