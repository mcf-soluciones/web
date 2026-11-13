import turso from '../_lib/turso.js';
import { checkAccountantPassword, noteSignIn } from '../_lib/kiosk-pin.js';
import { signInAccountant, signOut } from '../_lib/web-auth.js';

/**
 * The accountant's sign-in at /cuentas. Her password is hashed in kiosk_users with role 'accountant'
 * (scripts/set-accountant-password.mjs), which neither the owner PIN check nor the kiosks read.
 *
 * POST { password }: sign in, naming her in a signed cookie.
 * DELETE: sign out.
 *
 * The cookie opens only the read-only routes using requireReader, and those always hide Mexico from her.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'DELETE') {
    signOut(req, res);
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const check = await checkAccountantPassword(turso, req.body?.password);
    if (check.locked) return res.status(429).json({ error: 'Demasiados intentos. Espere unos minutos.' });
    if (!check.ok) {
      await noteSignIn(turso, null, 'web.accountant_wrong_password');
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }
    signInAccountant(req, res, check.user);
    await noteSignIn(turso, check.user, 'web.accountant_signin');
    return res.status(200).json({ accountant: check.user });
  } catch (err) {
    console.error('auth/cuentas error:', err);
    return res.status(500).json({ error: 'No se pudo comprobar la contraseña' });
  }
}
