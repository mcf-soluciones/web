/**
 * DEPRECATED — use POST /api/gastos/create (with optional `file`) or
 * POST /api/gastos/factura (to attach a factura to an existing gasto).
 *
 * Prior behavior: accepted a base64 file, uploaded to Drive, inserted into
 * Turso gastos. Its two responsibilities are now split cleanly:
 *   - create.js   — new gasto + optional factura in one call
 *   - factura.js  — re-attach factura to an existing gasto
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(410).json({
    error: 'gone',
    message: 'This endpoint has been retired. Use POST /api/gastos/create (new) or POST /api/gastos/factura (attach to existing).',
  });
}
