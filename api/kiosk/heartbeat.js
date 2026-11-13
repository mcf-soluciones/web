import turso from '../_lib/turso.js';
import { authenticateKiosk } from '../_lib/kiosk-auth.js';
import { recordHeartbeat } from '../_lib/kiosk-telemetry.js';

/** POST /api/kiosk/heartbeat: how a kiosk is doing, every few minutes. */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const kiosk = await authenticateKiosk(turso, req);
    if (!kiosk) return res.status(401).json({ error: 'Unknown kiosk key' });
    return res.status(200).json(await recordHeartbeat(turso, kiosk, req.body || {}));
  } catch (err) {
    console.error('kiosk/heartbeat error:', err);
    return res.status(500).json({ error: err.message });
  }
}
