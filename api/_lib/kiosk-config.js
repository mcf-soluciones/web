import { createHash } from 'crypto';

/** What a kiosk should currently have. rev changes only when the content does, so the kiosk can ask cheaply and often. */
export async function kioskConfig(db, kiosk) {
  const users = await db.execute(
    `SELECT mcf_user AS user, pin_salt AS salt, pin_hash AS hash, pin_iterations AS iterations
     FROM kiosk_users WHERE role = 'owner' ORDER BY mcf_user`);
  const saved = await db.execute({ sql: 'SELECT settings FROM kiosk_settings WHERE kiosk_id = ?', args: [kiosk.kiosk_id] });
  const discounts = await db.execute({ sql: 'SELECT uid, percent FROM kiosk_card_discounts WHERE kiosk_id = ? ORDER BY uid', args: [kiosk.kiosk_id] });
  const body = {
    users: users.rows.map(u => ({ user: u.user, salt: u.salt, hash: u.hash, iterations: Number(u.iterations) })),
    settings: saved.rows[0] ? JSON.parse(saved.rows[0].settings) : null,
    discounts: discounts.rows.map(d => ({ uid: d.uid, percent: Number(d.percent) })),
  };
  return { rev: createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16), ...body };
}
