import { alertExtras, conditions, parsePayload } from './kiosk-alerts.js';
import { salesMovement } from './kiosk-mapping.js';

const MAX_OFF_MS = 7 * 24 * 3600 * 1000;

/** Stores a heartbeat. The kiosk says when the next one is due, so changing its interval never causes a false alarm. */
export async function recordHeartbeat(db, kiosk, body, nowMs = Date.now()) {
  const nextInS = Math.min(Math.max(Number(body.next_in_s) || 300, 60), 7 * 24 * 3600);
  const mode = body.mode === 'off' ? 'off' : 'on';
  // Telemetry switched off always expires, so a forgotten switch cannot hide a dead kiosk for ever.
  let offUntil = null;
  if (mode === 'off') {
    const asked = Date.parse(body.off_until);
    offUntil = new Date(Math.min(Number.isFinite(asked) ? asked : nowMs + 24 * 3600 * 1000, nowMs + MAX_OFF_MS)).toISOString();
  }
  const kioskClock = Date.parse(body.now_utc);
  const skew = Number.isFinite(kioskClock) ? (kioskClock - nowMs) / 1000 : null;
  await db.execute({
    sql: `INSERT INTO kiosk_status (kiosk_id, received_at, next_due_at, app_version, mode, off_until, clock_skew_s, payload)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(kiosk_id) DO UPDATE SET received_at = excluded.received_at, next_due_at = excluded.next_due_at,
            app_version = excluded.app_version, mode = excluded.mode, off_until = excluded.off_until,
            clock_skew_s = excluded.clock_skew_s, payload = excluded.payload`,
    args: [kiosk.kiosk_id, new Date(nowMs).toISOString(), new Date(nowMs + nextInS * 1000).toISOString(), body.app_version || null, mode, offUntil, skew, JSON.stringify(body)],
  });
  return { ok: true, server_time: new Date(nowMs).toISOString() };
}

const LABELS = { bank: 'Datáfono', coins: 'Monedas', notes: 'Billetes', cards: 'Tarjetas cliente', machines: 'Máquinas', printer: 'Impresora' };

/** What the public status page may show: health only, never money or card numbers. */
export function publicStatus(kiosk, status, current, nowMs) {
  const p = parsePayload(status);
  const lost = current.some(c => c.code === 701);
  const off = status?.mode === 'off' && status.off_until && Date.parse(status.off_until) > nowMs;
  const state = !status ? 'unknown' : off ? 'off' : lost ? 'down' : current.length ? 'problem' : 'ok';
  const components = Object.entries(LABELS)
    .filter(([key]) => p.devices?.[key])
    .map(([key, label]) => ({
      key, label,
      ok: lost ? null : p.devices[key].ok !== false,
      status: key === 'coins' && p.coins_low?.length && p.devices[key].ok !== false ? 'bajo' : p.devices[key].ok === false ? p.devices[key].status : 'ok',
    }));
  return {
    kiosk_id: kiosk.kiosk_id,
    name: kiosk.name,
    property: kiosk.property,
    state,
    last_seen: status?.received_at ?? null,
    next_due_at: status?.next_due_at ?? null,
    app_version: status?.app_version ?? null,
    selling: p.selling ?? null,
    problems: current.map(c => ({ code: c.code, message: c.message })),
    components,
    machines: lost ? [] : (p.machines || []).map(m => ({ name: m.name, state: m.state })),
    pc: lost ? null : { temp_c: p.pc?.temp_c ?? null, mem_used_pct: p.pc?.mem_used_pct ?? null, disk_free_gb: p.pc?.disk_free_gb ?? null, uptime_s: p.uptime_s ?? null },
    upload: lost ? null : { depth: p.outbox?.depth ?? 0, oldest_age_s: p.outbox?.oldest_age_s ?? 0, last_ok_at: p.outbox?.last_ok_at ?? null },
    recon_ok_through: status?.recon_ok_through ?? null,
  };
}

export async function allPublicStatus(db, nowMs = Date.now()) {
  const kiosks = (await db.execute('SELECT * FROM kiosks ORDER BY kiosk_id')).rows;
  const out = [];
  for (const kiosk of kiosks) {
    const status = (await db.execute({ sql: 'SELECT * FROM kiosk_status WHERE kiosk_id = ?', args: [kiosk.kiosk_id] })).rows[0];
    out.push(publicStatus(kiosk, status, conditions(kiosk, status, nowMs, await alertExtras(db, kiosk, nowMs)), nowMs));
  }
  return out;
}

/**
 * The night check. The kiosk lists each day's completed sales and the server compares them with what it holds.
 * Sales the server never received go back to the kiosk to resend. A sale posted but missing from the report tables
 * is flagged for a person instead of being reposted, because someone may have removed it on purpose.
 */
export async function reconcile(db, kiosk, days, nowMs = Date.now()) {
  const missing = [];
  const results = [];
  for (const day of days || []) {
    const held = await db.execute({
      sql: `SELECT sale_id, post_state, method, price_cents FROM kiosk_sales WHERE kiosk_id = ? AND biz_date = ? AND status = 'completed'`,
      args: [kiosk.kiosk_id, day.date],
    });
    const heldIds = new Set(held.rows.map(r => r.sale_id));
    const absent = (day.sale_ids || []).filter(id => !heldIds.has(id));
    missing.push(...absent);

    const problems = [];
    if (absent.length) problems.push(`${absent.length} venta(s) pendientes de subir`);
    if (Number(kiosk.post_enabled) === 1) {
      const posted = held.rows.filter(r => r.post_state === 'posted');
      const detail = await db.execute({
        sql: `SELECT COUNT(*) AS n FROM sales_detail WHERE property = ? AND date = ? AND substr(movid, 1, 1) = 'K'`,
        args: [kiosk.property, day.date],
      });
      if (Number(detail.rows[0].n) !== posted.length) problems.push(`sales_detail tiene ${detail.rows[0].n} filas y deberían ser ${posted.length}`);
      for (const [method, account] of [['cash', 'cash'], ['bank', 'banco']]) {
        const expected = posted.filter(r => r.method === method).reduce((sum, r) => sum + Number(r.price_cents), 0);
        // Only the kiosk's own row for the day: rows other jobs put in `sales` are not this check's concern.
        const rollup = await db.execute({
          sql: `SELECT COALESCE(SUM(euros), 0) AS e FROM sales WHERE mcf_user = ? AND date_real = ? AND account = ? AND movement = ?`,
          args: [kiosk.sales_user, day.date, account, salesMovement(day.date, kiosk.sales_suffix, account)],
        });
        if (Math.round(Number(rollup.rows[0].e) * 100) !== expected) problems.push(`sales ${account} ${Number(rollup.rows[0].e).toFixed(2)} y deberían ser ${(expected / 100).toFixed(2)}`);
      }
    }
    const heldCents = held.rows.reduce((sum, r) => sum + Number(r.price_cents), 0);
    const kioskCents = (day.cents?.cash || 0) + (day.cents?.bank || 0) + (day.cents?.card || 0);
    if (!absent.length && heldCents !== kioskCents) problems.push(`el kiosco suma ${(kioskCents / 100).toFixed(2)} y la nube ${(heldCents / 100).toFixed(2)}`);

    const status = absent.length && problems.length === 1 ? 'pending' : problems.length ? 'mismatch' : 'ok';
    await db.execute({
      sql: `INSERT INTO kiosk_recon (kiosk_id, date, status, detail, checked_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(kiosk_id, date) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_at = excluded.checked_at`,
      args: [kiosk.kiosk_id, day.date, status, problems.join('; ') || null, new Date(nowMs).toISOString()],
    });
    results.push({ date: day.date, status, problems });
  }

  // Retention may only remove local sales up to the last day of an unbroken run of clean checks.
  const clean = [...results].sort((a, b) => a.date.localeCompare(b.date));
  let through = null;
  for (const r of clean) { if (r.status !== 'ok') break; through = r.date; }
  if (through) {
    await db.execute({
      sql: `UPDATE kiosk_status SET recon_ok_through = ? WHERE kiosk_id = ? AND (recon_ok_through IS NULL OR recon_ok_through < ?)`,
      args: [through, kiosk.kiosk_id, through],
    });
  }
  return { missing, results };
}
