import turso from '../_lib/turso.js';

/**
 * POST /api/gastos/duplicate   body: { ids: [<id>, ...] }
 *
 * Reads each given gasto row and inserts a copy. Copies keep all fields
 * except id, sheet_row_id and created_at (which is set to now). `fecha`,
 * `mm`, `yyyy` are preserved so the clone stays in the same period — the
 * user can edit those in the new row if they want.
 *
 * Returns the new row ids so the UI can refresh the list.
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const ids = Array.isArray(body.ids)
      ? body.ids.map(v => parseInt(v, 10)).filter(Number.isFinite)
      : [];
    if (ids.length === 0) return res.status(400).json({ error: 'ids array is required' });

    const placeholders = ids.map(() => '?').join(',');
    const sourceRs = await turso.execute({
      sql: `SELECT concepto_text, user_name, concepto_mcf, currency, cuenta,
                   concepto_proveedor, num_factura, nif_proveedor, razon_social,
                   concepto_banco, gasto, importe_iva, importe_irpf, importe_otro,
                   recibo_url, is_fiscal,
                   categoria_gastos_mcf, es_inversion, fecha, mm, yyyy,
                   importe_total, propiedad
            FROM gastos WHERE id IN (${placeholders})`,
      args: ids,
    });

    const newIds = [];
    for (const r of sourceRs.rows) {
      const ins = await turso.execute({
        sql: `INSERT INTO gastos (
                concepto_text, user_name, concepto_mcf, currency, cuenta,
                concepto_proveedor, num_factura, nif_proveedor, razon_social,
                concepto_banco, gasto, importe_iva, importe_irpf, importe_otro,
                recibo_url, is_fiscal,
                categoria_gastos_mcf, es_inversion, fecha, mm, yyyy,
                importe_total, propiedad
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          r.concepto_text, r.user_name, r.concepto_mcf, r.currency, r.cuenta,
          r.concepto_proveedor, r.num_factura, r.nif_proveedor, r.razon_social,
          r.concepto_banco, r.gasto, r.importe_iva, r.importe_irpf, r.importe_otro,
          r.recibo_url, r.is_fiscal,
          r.categoria_gastos_mcf, r.es_inversion, r.fecha, r.mm, r.yyyy,
          r.importe_total, r.propiedad,
        ],
      });
      newIds.push(Number(ins.lastInsertRowid));
    }

    return res.status(200).json({
      success: true,
      source_ids: ids,
      new_ids: newIds,
      duplicated: newIds.length,
    });
  } catch (err) {
    console.error('gastos/duplicate error:', err);
    return res.status(500).json({ error: err.message });
  }
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
