import turso from '../_lib/turso.js';

/**
 * GET /api/gastos/suggest?cuenta=C1&field=razon_social
 *
 * Returns a deduped list of recent distinct values for `field` within a cuenta,
 * ordered by most-recent-use. Drives the clickable suggestion chips below the
 * free-text inputs in the detailed-entry form.
 *
 * Whitelisted fields: razon_social, nif_proveedor, concepto_proveedor,
 *                     num_factura, concepto_banco.
 */
const FIELD_WHITELIST = new Set([
  'razon_social',
  'nif_proveedor',
  'concepto_proveedor',
  'num_factura',
  'concepto_banco',
]);

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const cuenta = String(req.query.cuenta || '').trim();
    const field = String(req.query.field || '').trim();
    const limit = Math.max(1, Math.min(20, parseInt(req.query.limit, 10) || 5));
    if (!cuenta) return res.status(400).json({ error: 'cuenta is required' });
    if (!FIELD_WHITELIST.has(field)) {
      return res.status(400).json({ error: `field must be one of: ${[...FIELD_WHITELIST].join(', ')}` });
    }

    const col = quote(field);
    // GROUP BY TRIM(col) so "50177720T", " 50177720T", "50177720T " collapse
    // into a single suggestion. We still return the trimmed value to the UI.
    const rs = await turso.execute({
      sql: `SELECT TRIM(${col}) AS value, COUNT(*) AS used_count, MAX(fecha) AS last_used
            FROM gastos
            WHERE cuenta = ?
              AND ${col} IS NOT NULL
              AND TRIM(${col}) <> ''
            GROUP BY TRIM(${col})
            ORDER BY last_used DESC, used_count DESC
            LIMIT ?`,
      args: [cuenta, limit],
    });

    return res.status(200).json({
      cuenta,
      field,
      suggestions: rs.rows.map(r => ({
        value: r.value,
        used_count: Number(r.used_count) || 0,
        last_used: r.last_used || null,
      })),
    });
  } catch (err) {
    console.error('gastos/suggest error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function quote(ident) { return `"${ident.replace(/"/g, '""')}"`; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
