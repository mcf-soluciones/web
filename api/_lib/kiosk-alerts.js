/**
 * What is wrong with a kiosk right now, and what to tell people about it.
 * Codes match the error catalog: 1xx bank, 2xx coins, 3xx notes, 4xx cards, 5xx machines, 6xx printer, 7xx PC, 8xx cloud.
 */

const MIN = 60 * 1000;
const REMINDER_MS = 6 * 60 * MIN;

const DEVICES = [
  ['bank', 101, 'Pagos con tarjeta bancaria no disponibles'],
  ['coins', 201, 'Monedero no disponible'],
  ['notes', 301, 'Billetero no disponible'],
  ['cards', 401, 'Lector de tarjetas cliente no disponible'],
  ['machines', 501, 'No se pueden activar las máquinas'],
  ['printer', 601, 'Impresora no disponible'],
];

export function parsePayload(status) {
  if (!status?.payload) return {};
  try { return JSON.parse(status.payload); } catch { return {}; }
}

function madrid(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = t => parts.find(p => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), minute: Number(get('minute')), clock: `${get('hour')}:${get('minute')}` };
}

export const madridNow = madrid;

/** Conditions currently true. holdMin: how long one must last before anyone is told, so a brief blip stays quiet. */
export function conditions(kiosk, status, nowMs, extras = {}) {
  const silenced = kiosk.silenced_until && Date.parse(kiosk.silenced_until) > nowMs;
  if (silenced || !status) return [];
  const off = status.mode === 'off' && status.off_until && Date.parse(status.off_until) > nowMs;
  if (off) return [];

  const out = [];
  const receivedMs = Date.parse(status.received_at);
  // After a switched-off period the kiosk should speak up right away; otherwise allow half an interval of lateness.
  const offEnded = status.mode === 'off' && status.off_until;
  const dueMs = Date.parse(offEnded ? status.off_until : status.next_due_at);
  const grace = offEnded ? 3 * MIN : Math.max(3 * MIN, (dueMs - receivedMs) / 2);
  if (nowMs > dueMs + grace) {
    out.push({ code: 701, holdMin: 0, message: `Sin señal del kiosco desde las ${madrid(receivedMs).clock}. El ordenador puede estar apagado o sin internet.` });
    return out; // the last heartbeat says nothing about now
  }

  const p = parsePayload(status);
  if (p.selling) {
    for (const [key, code, message] of DEVICES) {
      if (p.devices?.[key] && p.devices[key].ok === false) out.push({ code, holdMin: 10, message });
    }
    if (p.coins_low?.length) out.push({ code: 202, holdMin: 0, message: `Quedan pocas monedas de ${p.coins_low.map(c => `${(c / 100).toFixed(2).replace('.', ',')} €`).join(', ')}` });
  }
  if (p.unfinished_paid > 0) out.push({ code: 502, holdMin: 0, message: `${p.unfinished_paid} venta(s) cobrada(s) sin completar. Revise el registro de ventas.` });
  if (typeof p.pc?.temp_c === 'number' && p.pc.temp_c >= (p.pc.temp_alert_c ?? 85)) out.push({ code: 702, holdMin: 10, message: `El ordenador está a ${Math.round(p.pc.temp_c)} °C` });
  if (Math.abs(status.clock_skew_s ?? 0) > 120) out.push({ code: 703, holdMin: 10, message: `El reloj del ordenador está desajustado ${Math.round(status.clock_skew_s)} s, y las ventas llevan esa hora` });
  if ((p.ui_tick_age_s ?? 0) > 120) out.push({ code: 704, holdMin: 5, message: 'La pantalla del kiosco no responde' });
  if ((p.outbox?.oldest_age_s ?? 0) > 2 * 3600) out.push({ code: 801, holdMin: 0, message: `Ventas sin subir desde hace ${Math.round(p.outbox.oldest_age_s / 3600)} h` });
  if (p.outbox?.parked > 0) out.push({ code: 804, holdMin: 0, message: `${p.outbox.parked} venta(s) rechazada(s) al subirlas` });
  if (p.config_problem) out.push({ code: 807, holdMin: 0, message: `El kiosco rechazó los ajustes: ${p.config_problem}` });
  if (extras.reconBad?.length) out.push({ code: 802, holdMin: 0, message: `La revisión nocturna no cuadra: ${extras.reconBad.join(', ')}` });
  if (extras.unmatchedProducts > 0) out.push({ code: 803, holdMin: 0, message: `${extras.unmatchedProducts} venta(s) con un precio sin fila en products` });
  return out;
}

/** Facts conditions() needs that are not in the heartbeat. */
export async function alertExtras(db, kiosk, nowMs) {
  const since = new Date(nowMs - 7 * 24 * 60 * MIN).toISOString().slice(0, 10);
  const recon = await db.execute({ sql: `SELECT date FROM kiosk_recon WHERE kiosk_id = ? AND status <> 'ok' AND date >= ? ORDER BY date`, args: [kiosk.kiosk_id, since] });
  const products = await db.execute({ sql: `SELECT COUNT(*) AS n FROM kiosk_sales WHERE kiosk_id = ? AND product_ok = 0 AND biz_date >= ?`, args: [kiosk.kiosk_id, since] });
  return { reconBad: recon.rows.map(r => r.date), unmatchedProducts: Number(products.rows[0]?.n || 0) };
}

/**
 * One watcher pass. Keeps one kiosk_alerts row per episode, so each problem is announced once, reminded
 * every few hours and closed with an all-clear. A message that could not be sent is retried on the next pass.
 */
export async function watchTick(db, send, nowMs = Date.now()) {
  const iso = new Date(nowMs).toISOString();
  const now = madrid(nowMs);
  const quiet = now.hour >= 23 || now.hour < 7; // arrives without a sound at night
  const kiosks = (await db.execute('SELECT * FROM kiosks')).rows;
  const report = [];

  for (const kiosk of kiosks) {
    const status = (await db.execute({ sql: 'SELECT * FROM kiosk_status WHERE kiosk_id = ?', args: [kiosk.kiosk_id] })).rows[0];
    const current = conditions(kiosk, status, nowMs, await alertExtras(db, kiosk, nowMs));
    const open = (await db.execute({ sql: 'SELECT * FROM kiosk_alerts WHERE kiosk_id = ? AND closed_at IS NULL', args: [kiosk.kiosk_id] })).rows;

    for (const cond of current) {
      let alert = open.find(a => Number(a.code) === cond.code);
      if (!alert) {
        const ins = await db.execute({
          sql: 'INSERT INTO kiosk_alerts (kiosk_id, code, message, first_seen_at) VALUES (?, ?, ?, ?)',
          args: [kiosk.kiosk_id, cond.code, cond.message, iso],
        });
        alert = { id: Number(ins.lastInsertRowid), first_seen_at: iso, notified_at: null, last_sent_at: null };
      }
      const held = nowMs - Date.parse(alert.first_seen_at) >= cond.holdMin * MIN;
      const remind = alert.notified_at && !quiet && nowMs - Date.parse(alert.last_sent_at) >= REMINDER_MS;
      if ((!alert.notified_at && held) || remind) {
        const prefix = alert.notified_at ? 'Sigue pendiente' : 'Alerta';
        if (await send(`🔴 ${prefix} · ${kiosk.name}\n${cond.message} (Código ${cond.code})`, quiet)) {
          await db.execute({
            sql: 'UPDATE kiosk_alerts SET notified_at = COALESCE(notified_at, ?), last_sent_at = ?, message = ? WHERE id = ?',
            args: [iso, iso, cond.message, alert.id],
          });
        }
      }
    }

    for (const alert of open) {
      if (current.some(c => c.code === Number(alert.code))) continue;
      if (alert.notified_at && !(await send(`🟢 Resuelto · ${kiosk.name}\n${alert.message} (Código ${alert.code})`, quiet))) continue;
      await db.execute({ sql: 'UPDATE kiosk_alerts SET closed_at = ? WHERE id = ?', args: [iso, alert.id] });
    }

    // The 08:05 "all fine", once per day, only when nothing is wrong.
    const dailyDue = status && (now.hour > 8 || (now.hour === 8 && now.minute >= 5)) && now.hour < 9 && status.last_daily_date !== now.date;
    if (dailyDue && current.length === 0 && await send(`✅ Todo bien · ${kiosk.name}`, false)) {
      await db.execute({ sql: 'UPDATE kiosk_status SET last_daily_date = ? WHERE kiosk_id = ?', args: [now.date, kiosk.kiosk_id] });
    }
    report.push({ kiosk_id: kiosk.kiosk_id, conditions: current.map(c => c.code) });
  }
  return report;
}
