import turso from '../_lib/turso.js';

/**
 * GET /api/gastos/proveedores?cuenta=C1
 *
 * Returns the distinct (razon_social, nif_proveedor) pairs historically used
 * within a cuenta, ordered by most-recent-use. The modal uses this to:
 *   - show razon_social chips with NIF in parenthesis
 *   - filter NIF chips to only those paired with the currently-chosen razon_social
 *
 * Response:
 *   {
 *     cuenta: 'C1',
 *     pairs: [
 *       { razon_social, nif_proveedor, concepto_proveedor, used_count, last_used },
 *       ...
 *     ]
 *   }
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const cuenta = String(req.query.cuenta || '').trim();
    if (!cuenta) return res.status(400).json({ error: 'cuenta is required' });

    const rs = await turso.execute({
      sql: `SELECT TRIM(razon_social) AS razon_social,
                   TRIM(nif_proveedor) AS nif_proveedor,
                   TRIM(concepto_proveedor) AS concepto_proveedor,
                   COUNT(*) AS used_count,
                   MAX(fecha) AS last_used
            FROM gastos
            WHERE cuenta = ?
              AND razon_social IS NOT NULL AND TRIM(razon_social) <> ''
            GROUP BY TRIM(razon_social), TRIM(COALESCE(nif_proveedor, ''))
            ORDER BY last_used DESC, used_count DESC
            LIMIT 50`,
      args: [cuenta],
    });

    return res.status(200).json({
      cuenta,
      pairs: rs.rows.map(r => ({
        razon_social: r.razon_social,
        nif_proveedor: r.nif_proveedor || null,
        concepto_proveedor: r.concepto_proveedor || null,
        used_count: Number(r.used_count) || 0,
        last_used: r.last_used || null,
      })),
    });
  } catch (err) {
    console.error('gastos/proveedores error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
