import turso from '../_lib/turso.js';
import { checkPin, noteSignIn } from '../_lib/kiosk-pin.js';
import { currentAccountant, currentOwner, signIn, signOut } from '../_lib/web-auth.js';
import { MEXICO_VISIBLE } from '../_lib/sucursales.js';

/**
 * GET: who is signed in, and whether Hub and Reportes are open. Also says if this is the accountant, and shows the
 * Mexico toggle's availability only to an owner with Reportes open.
 * POST { pin, reports }: sign in with a PIN. reports: true also opens Hub and Reportes.
 * DELETE: sign out.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const owner = currentOwner(req);
    const me = { user: owner?.user ?? null, reports: owner?.reports ?? false };
    if (owner?.reports && MEXICO_VISIBLE) me.mexico_visible = true;
    const accountant = owner ? null : currentAccountant(req);
    if (accountant) me.accountant = accountant;
    return res.status(200).json(me);
  }
  if (req.method === 'DELETE') {
    signOut(req, res);
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const reports = req.body?.reports === true;
    const check = await checkPin(turso, req.body?.pin);
    if (check.locked) return res.status(429).json({ error: 'Demasiados intentos. Espere unos minutos.' });
    if (!check.ok) {
      await noteSignIn(turso, null, 'web.wrong_pin');
      return res.status(401).json({ error: 'PIN incorrecto' });
    }
    signIn(req, res, check.user, { reports });
    await noteSignIn(turso, check.user, reports ? 'web.reports' : 'web.signin');
    return res.status(200).json({ user: check.user, reports });
  } catch (err) {
    console.error('auth/pin error:', err);
    return res.status(500).json({ error: 'No se pudo comprobar el PIN' });
  }
}
