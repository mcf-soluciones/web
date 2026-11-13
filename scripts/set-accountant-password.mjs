/**
 * Creates or replaces the accountant's login. Generates a long random password, prints it once, and stores only its
 * hash, in kiosk_users with role 'accountant'. That role can't pass the owner PIN check or open a kiosk.
 *
 * Run it in your own terminal, so the password only appears there. Run it again to replace a lost or shared password.
 * A session she already has open stays valid until it lapses: after 30 idle minutes, or 12 hours at most.
 *
 * Usage:
 *   node scripts/set-accountant-password.mjs <nombre>
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { createClient } from '@libsql/client';
import { hashPin } from '../api/_lib/kiosk-pin.js';

const name = String(process.argv[2] || '').trim().toLowerCase();
if (!/^[a-z0-9._-]{2,40}$/.test(name)) {
  console.error('Usage: node scripts/set-accountant-password.mjs <nombre>');
  process.exit(1);
}

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

const existing = (await db.execute({ sql: 'SELECT role FROM kiosk_users WHERE mcf_user = ?', args: [name] })).rows[0];
if (existing && existing.role !== 'accountant') {
  console.error(`"${name}" already has the role "${existing.role}". Replacing it would overwrite their PIN, so nothing was changed.`);
  process.exit(1);
}

const password = randomBytes(18).toString('base64url');
const { pin_salt, pin_hash, pin_iterations } = hashPin(password);
await db.execute({
  sql: `INSERT INTO kiosk_users (mcf_user, role, pin_salt, pin_hash, pin_iterations) VALUES (?, 'accountant', ?, ?, ?)
        ON CONFLICT(mcf_user) DO UPDATE SET pin_salt = excluded.pin_salt, pin_hash = excluded.pin_hash,
          pin_iterations = excluded.pin_iterations, updated_at = datetime('now')`,
  args: [name, pin_salt, pin_hash, pin_iterations],
});

console.log(`Login set for ${name}. She signs in at https://mcfsoluciones.com/cuentas with this password:\n\n  ${password}\n\nIt is not stored anywhere else, so pass it on now.`);
process.exit(0);
