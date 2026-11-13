import turso from '../_lib/turso.js';
import { authenticateKiosk } from '../_lib/kiosk-auth.js';
import { kioskConfig } from '../_lib/kiosk-config.js';

/** GET /api/kiosk/config?have=<rev>: what the kiosk should have. Answers only { unchanged: true } when it already does. */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const kiosk = await authenticateKiosk(turso, req);
    if (!kiosk) return res.status(401).json({ error: 'Unknown kiosk key' });
    res.setHeader('Cache-Control', 'no-store');
    const config = await kioskConfig(turso, kiosk);
    if (req.query?.have === config.rev) return res.status(200).json({ rev: config.rev, unchanged: true });
    return res.status(200).json(config);
  } catch (err) {
    console.error('kiosk/config error:', err);
    return res.status(500).json({ error: err.message });
  }
}
