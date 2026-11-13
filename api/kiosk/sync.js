import turso from '../_lib/turso.js';
import { authenticateKiosk } from '../_lib/kiosk-auth.js';
import { ingestAppendOnly, ingestCashOps, ingestSales } from '../_lib/kiosk-ingest.js';

/** POST /api/kiosk/sync: what a kiosk recorded since its last upload. Safe to repeat. */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const kiosk = await authenticateKiosk(turso, req);
    if (!kiosk) return res.status(401).json({ error: 'Unknown kiosk key' });

    const body = req.body || {};
    if (!body.db_uuid) return res.status(400).json({ error: 'db_uuid is required' });

    const sales = await ingestSales(turso, kiosk, body.sales, body.app_version);
    const cash = await ingestCashOps(turso, kiosk, body.cash_ops);
    const through = await ingestAppendOnly(turso, kiosk, body.db_uuid, body);
    return res.status(200).json({
      accepted: [...sales.accepted, ...cash.accepted],
      rejected: [...sales.rejected, ...cash.rejected],
      through,
      server_time: new Date().toISOString(),
    });
  } catch (err) {
    console.error('kiosk/sync error:', err);
    return res.status(500).json({ error: err.message });
  }
}
