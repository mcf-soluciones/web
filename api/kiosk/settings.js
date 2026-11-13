import turso from '../_lib/turso.js';
import { settingsRequest } from '../_lib/kiosk-settings.js';
import { currentOwner } from '../_lib/web-auth.js';

/** POST /api/kiosk/settings { pin, action: 'load' | 'save', settings, discounts }: what /kiosko edits. Owners only: signed in, or a PIN checked here on every call. */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    res.setHeader('Cache-Control', 'no-store');
    const { status, json } = await settingsRequest(turso, req.body, currentOwner(req)?.user);
    return res.status(status).json(json);
  } catch (err) {
    console.error('kiosk/settings error:', err);
    return res.status(500).json({ error: err.message });
  }
}
