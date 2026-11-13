import turso from '../_lib/turso.js';
import { allPublicStatus } from '../_lib/kiosk-telemetry.js';

/** GET /api/kiosk/status: health of every kiosk for /estado. Public, so it carries no money and no card numbers. */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ kiosks: await allPublicStatus(turso), server_time: new Date().toISOString() });
  } catch (err) {
    console.error('kiosk/status error:', err);
    return res.status(500).json({ error: err.message });
  }
}
