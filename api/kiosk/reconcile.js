import turso from '../_lib/turso.js';
import { authenticateKiosk } from '../_lib/kiosk-auth.js';
import { reconcile } from '../_lib/kiosk-telemetry.js';

/** POST /api/kiosk/reconcile: the night check. Answers which sales the kiosk must send again. */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const kiosk = await authenticateKiosk(turso, req);
    if (!kiosk) return res.status(401).json({ error: 'Unknown kiosk key' });
    return res.status(200).json(await reconcile(turso, kiosk, req.body?.days));
  } catch (err) {
    console.error('kiosk/reconcile error:', err);
    return res.status(500).json({ error: err.message });
  }
}
