import turso from '../_lib/turso.js';

/**
 * GET /api/gastos/list?yyyy=2026&mm=3
 *
 * Returns every gasto row for the month joined to catalogo_cuentas for display.
 * Used by the Gastos tab editable table.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const mm = toInt(req.query.mm);
    const yyyy = toInt(req.query.yyyy);
    if (!mm || !yyyy) return res.status(400).json({ error: 'mm and yyyy are required' });

    const rs = await turso.execute({
      sql: `SELECT g.id, g.fecha, g.mm, g.yyyy,
                   g.propiedad, g.concepto_mcf, g.cuenta,
                   g.concepto_proveedor, g.razon_social, g.nif_proveedor,
                   g.num_factura, g.concepto_banco,
                   COALESCE(g.importe_total, g.gasto, 0) AS importe_total,
                   g.importe_iva, g.importe_irpf, g.importe_otro,
                   g.currency, g.is_fiscal, g.es_inversion,
                   g.categoria_gastos_mcf, g.recibo_url,
                   g.user_name AS mcf_user, g.sheet_row_id,
                   g.bank_movement_hash,
                   g.loan_id, g.loan_payment_interest, g.loan_payment_principal,
                   l.name AS loan_name,
                   g.created_at,
                   c.desc AS cuenta_desc, c.tooltip AS cuenta_tooltip
            FROM gastos g
            LEFT JOIN catalogo_cuentas c ON g.cuenta = c.cuenta_mcf
            LEFT JOIN loans l ON g.loan_id = l.id
            WHERE g.yyyy = ? AND g.mm = ?
            ORDER BY g.fecha DESC, g.id DESC`,
      args: [yyyy, mm],
    });

    const rows = rs.rows.map(r => ({
      ...r,
      is_fiscal: Number(r.is_fiscal) === 1,
      is_bank_import: r.bank_movement_hash != null,
      importe_total: Number(r.importe_total) || 0,
      importe_iva: r.importe_iva == null ? null : Number(r.importe_iva),
      importe_irpf: r.importe_irpf == null ? null : Number(r.importe_irpf),
      importe_otro: r.importe_otro == null ? null : Number(r.importe_otro),
    }));

    const total = rows
      .filter(r => r.es_inversion !== 'Si')
      .reduce((s, r) => s + (r.importe_total || 0), 0);
    const totalInversion = rows
      .filter(r => r.es_inversion === 'Si')
      .reduce((s, r) => s + (r.importe_total || 0), 0);

    return res.status(200).json({
      period: { mm, yyyy },
      count: rows.length,
      total_operativo: total,
      total_inversion: totalInversion,
      rows,
    });
  } catch (err) {
    console.error('gastos/list error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function toInt(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
