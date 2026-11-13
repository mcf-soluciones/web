import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Owner PINs: six digits, no username, so the PIN itself identifies its owner.
 * Same derivation as the kiosk (Rfc2898DeriveBytes.Pbkdf2 with SHA-256), so it can check them offline.
 */
export const PIN_ITERATIONS = 150000;
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60 * 1000;

export const validPinFormat = pin => /^\d{6}$/.test(String(pin ?? ''));

function derive(pin, saltHex, iterations) {
  return pbkdf2Sync(String(pin), Buffer.from(saltHex, 'hex'), iterations, 32, 'sha256');
}

export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return { pin_salt: salt, pin_hash: derive(pin, salt, PIN_ITERATIONS).toString('hex'), pin_iterations: PIN_ITERATIONS };
}

export function pinMatches(pin, user) {
  const expected = Buffer.from(user.pin_hash, 'hex');
  const actual = derive(pin, user.pin_salt, Number(user.pin_iterations));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Finds who a secret belongs to, or refuses. Each guard scope counts its own wrong tries, so one person's typos on one sign-in don't lock another.
async function checkAgainstRole(db, { scope, role, secret, allowed }, nowMs) {
  const guard = (await db.execute({ sql: `SELECT * FROM kiosk_pin_guard WHERE scope = ?`, args: [scope] })).rows[0];
  if (guard?.locked_until && Date.parse(guard.locked_until) > nowMs) return { ok: false, locked: true };

  const users = (await db.execute({ sql: `SELECT * FROM kiosk_users WHERE role = ?`, args: [role] })).rows;
  const user = allowed ? users.find(u => pinMatches(secret, u)) : null;
  if (user) {
    await db.execute({
      sql: `INSERT INTO kiosk_pin_guard (scope, failures, locked_until) VALUES (?, 0, NULL)
            ON CONFLICT(scope) DO UPDATE SET failures = 0, locked_until = NULL`,
      args: [scope],
    });
    return { ok: true, user: user.mcf_user };
  }
  const failures = Number(guard?.failures || 0) + 1;
  const locked = failures >= MAX_FAILURES;
  await db.execute({
    sql: `INSERT INTO kiosk_pin_guard (scope, failures, locked_until) VALUES (?, ?, ?)
          ON CONFLICT(scope) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until`,
    args: [scope, locked ? 0 : failures, locked ? new Date(nowMs + LOCK_MS).toISOString() : null],
  });
  return { ok: false, locked };
}

/** Who this PIN belongs to, or a refusal. Too many wrong tries lock every PIN for a few minutes, since there is no username to lock per person. */
export function checkPin(db, pin, nowMs = Date.now()) {
  return checkAgainstRole(db, { scope: 'web', role: 'owner', secret: pin, allowed: validPinFormat(pin) }, nowMs);
}

/** The same for the accountant's password at /cuentas. It can never match an owner's PIN, and it has its own lockout. */
export function checkAccountantPassword(db, password, nowMs = Date.now()) {
  return checkAgainstRole(db, { scope: 'accountant', role: 'accountant', secret: password, allowed: typeof password === 'string' && password.length > 0 }, nowMs);
}

/** A note of who signed in. A failed note must never stop someone signing in. */
export async function noteSignIn(db, user, action) {
  try {
    await db.execute({ sql: 'INSERT INTO kiosk_audit (at, mcf_user, action) VALUES (?, ?, ?)', args: [new Date().toISOString(), user, action] });
  } catch (err) {
    console.error('sign-in note error:', err);
  }
}
