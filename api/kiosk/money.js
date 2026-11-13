import turso from '../_lib/turso.js';
import { checkPin } from '../_lib/kiosk-pin.js';
import { currentOwner } from '../_lib/web-auth.js';
import { madridNow, parsePayload } from '../_lib/kiosk-alerts.js';

/** POST /api/kiosk/money { pin }: cash in each kiosk and today's takings. Owners only: signed in, or a PIN checked here on the server. */
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    res.setHeader('Cache-Control', 'no-store');
    const signedIn = currentOwner(req)?.user;
    const check = signedIn ? { ok: true, user: signedIn } : req.body?.pin ? await checkPin(turso, req.body.pin) : { ok: false };
    if (check.locked) return res.status(429).json({ error: 'Demasiados intentos. Espere unos minutos.' });
    if (!check.ok) return res.status(401).json({ error: 'PIN incorrecto' });

    const today = madridNow(Date.now()).date;
    const kiosks = (await turso.execute('SELECT kiosk_id, name FROM kiosks ORDER BY kiosk_id')).rows;
    const out = [];
    for (const kiosk of kiosks) {
      const status = (await turso.execute({ sql: 'SELECT * FROM kiosk_status WHERE kiosk_id = ?', args: [kiosk.kiosk_id] })).rows[0];
      const totals = await turso.execute({
        sql: `SELECT method, kind, COUNT(*) AS n, SUM(price_cents) AS cents FROM kiosk_sales
              WHERE kiosk_id = ? AND biz_date = ? AND status = 'completed' GROUP BY method, kind`,
        args: [kiosk.kiosk_id, today],
      });
      out.push({
        kiosk_id: kiosk.kiosk_id,
        name: kiosk.name,
        as_of: status?.received_at ?? null,
        cash: parsePayload(status).cash ?? null,
        today: totals.rows.map(r => ({ method: r.method, kind: r.kind, count: Number(r.n), cents: Number(r.cents) })),
      });
    }
    return res.status(200).json({ user: check.user, kiosks: out });
  } catch (err) {
    console.error('kiosk/money error:', err);
    return res.status(500).json({ error: err.message });
  }
}
