import { createHash } from 'crypto';

export function hashKioskKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

/** The kiosk a request's bearer key belongs to, or null. The kiosk id always comes from here, never from the request body. */
export async function authenticateKiosk(db, req) {
  const header = req.headers?.authorization || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const rs = await db.execute({ sql: 'SELECT * FROM kiosks WHERE key_hash = ?', args: [hashKioskKey(match[1])] });
  return rs.rows[0] || null;
}
