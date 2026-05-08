/**
 * DEPRECATED — use POST /api/gastos/create instead.
 *
 * Prior behavior (before the Turso-primary refactor):
 *   - Appended a row to the Google Sheet "gastos" tab
 *   - Dual-wrote to Turso gastos
 *
 * The Sheet is now frozen / retired; all writes flow through Turso only.
 * This endpoint returns 410 Gone so any stale client surfaces the change.
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST,GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(410).json({
    error: 'gone',
    message: 'This endpoint has been retired. Use POST /api/gastos/create instead.',
  });
}
