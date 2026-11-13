import turso from '../_lib/turso.js';
import { watchTick } from '../_lib/kiosk-alerts.js';
import { sendTelegram } from '../_lib/telegram.js';

/** POST /api/kiosk/watch-tick: one watcher pass, called every 5 minutes by the AWS job lambda/mcf_kioskWatch. */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.KIOSK_WATCH_SECRET;
  if (!secret || req.headers?.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.status(200).json({ kiosks: await watchTick(turso, sendTelegram) });
  } catch (err) {
    console.error('kiosk/watch-tick error:', err);
    return res.status(500).json({ error: err.message });
  }
}
