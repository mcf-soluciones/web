import turso from '../_lib/turso.js';

/**
 * GET /api/reports/gastos-detail?cuenta=C1&yyyy=2026
 *
 * Returns every gasto row in the given cuenta_mcf for the year, with all
 * useful columns for the P&L detail modal.
 *
 * Response:
 *   {
 *     cuenta: 'C1',
 *     yyyy: 2026,
 *     total: 5857.50,
 *     count: 12,
 *     catalog: { cuenta_mcf, categoria_gastos_mcf, desc, tooltip },
 *     rows: [
 *       { id, fecha, mm, concepto_mcf, concepto_proveedor, razon_social,
 *         num_factura, nif_proveedor, mcf_user, propiedad,
 *         importe_total, importe_iva, importe_irpf, importe_otro,
 *         currency, is_fiscal, recibo_url, created_at }
 *     ]
 *   }
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const cuenta = typeof req.query.cuenta === 'string' ? req.query.cuenta.trim() : '';
    const yyyy = toInt(req.query.yyyy);
    if (!cuenta) return res.status(400).json({ error: 'cuenta is required' });
    if (!yyyy) return res.status(400).json({ error: 'yyyy is required' });

    const [rowsRs, catalogRs] = await Promise.all([
      turso.execute({
        sql: `SELECT id, fecha, mm, concepto_mcf, concepto_proveedor, razon_social,
                     num_factura, nif_proveedor, user_name AS mcf_user, propiedad,
                     COALESCE(importe_total, gasto, 0) AS importe_total,
                     importe_iva, importe_irpf, importe_otro,
                     currency, is_fiscal, recibo_url, created_at,
                     categoria_gastos_mcf, es_inversion
              FROM gastos
              WHERE cuenta = ? AND yyyy = ?
                AND COALESCE(es_inversion, 'No') = 'No'
              ORDER BY fecha DESC, id DESC`,
        args: [cuenta, yyyy],
      }),
      turso.execute({
        sql: `SELECT cuenta_mcf, categoria_gastos_mcf, desc, tooltip
              FROM catalogo_cuentas WHERE cuenta_mcf = ? LIMIT 1`,
        args: [cuenta],
      }),
    ]);

    const rows = rowsRs.rows.map(r => ({
      ...r,
      is_fiscal: Number(r.is_fiscal) === 1,
      importe_total: Number(r.importe_total) || 0,
      importe_iva: r.importe_iva == null ? null : Number(r.importe_iva),
      importe_irpf: r.importe_irpf == null ? null : Number(r.importe_irpf),
      importe_otro: r.importe_otro == null ? null : Number(r.importe_otro),
    }));
    const total = rows.reduce((s, r) => s + (r.importe_total || 0), 0);

    return res.status(200).json({
      cuenta,
      yyyy,
      total,
      count: rows.length,
      catalog: catalogRs.rows[0] || null,
      rows,
    });

  } catch (err) {
    console.error('reports/gastos-detail error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
