import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { conditions, watchTick } from '../../api/_lib/kiosk-alerts.js';
import { allPublicStatus, publicStatus, reconcile, recordHeartbeat } from '../../api/_lib/kiosk-telemetry.js';
import { ingestSales } from '../../api/_lib/kiosk-ingest.js';
import { checkPin, hashPin } from '../../api/_lib/kiosk-pin.js';

const schema = readFileSync(new URL('../../scripts/schema-kiosk.sql', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'kiosk-telemetry-'));
const MIN = 60000;
const NOON = Date.parse('2026-11-04T12:00:00Z'); // 13:00 in Madrid

const KIOSK = { kiosk_id: 'K1', name: 'Hortaleza', property: 'hortaleza', sales_user: 'local-hortaleza', sales_suffix: '223501', post_enabled: 1, company: 'mcf', price_list: 'cesar1' };

let db;
let counter = 0;

afterEach(() => db.close());

beforeEach(async () => {
  db = createClient({ url: `file:${join(dir, `t${++counter}.db`)}` });
  await db.batch([
    `CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, movement TEXT NOT NULL, type TEXT DEFAULT 'venta', account TEXT, euros REAL NOT NULL DEFAULT 0, mcf_user TEXT, date_real TEXT NOT NULL, icon TEXT DEFAULT 'g', created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, product TEXT NOT NULL, precio REAL NOT NULL, price_list TEXT NOT NULL, property TEXT NOT NULL)`,
    `CREATE TABLE sales_detail (id INTEGER PRIMARY KEY AUTOINCREMENT, movid TEXT NOT NULL, date TEXT NOT NULL, yyyy INTEGER NOT NULL, mm INTEGER NOT NULL, dd INTEGER NOT NULL, time TEXT, hr INTEGER, min INTEGER, payment TEXT, product TEXT, euro REAL DEFAULT 0, company TEXT, dayweek TEXT, price_list TEXT, property TEXT)`,
  ], 'write');
  for (const stmt of schema.split(/;\s*\n/).map(s => s.replace(/--[^\n]*/g, '').trim()).filter(Boolean)) await db.execute(stmt);
  await db.execute(`INSERT INTO kiosks (kiosk_id, name, key_hash, company, price_list, property, propiedad_label, sales_user, sales_suffix)
    VALUES ('K1', 'Hortaleza', 'h', 'mcf', 'cesar1', 'hortaleza', '(002) Hortaleza', 'local-hortaleza', '223501')`);
});

const healthy = over => ({
  next_in_s: 300, mode: 'on', selling: true, app_version: '3.1.0', ui_tick_age_s: 1,
  devices: { bank: { ok: true, status: 'ok' }, coins: { ok: true, status: 'ok' }, notes: { ok: true, status: 'ok' }, cards: { ok: true, status: 'ok' }, machines: { ok: true, status: 'ok' }, printer: { ok: true, status: 'ok' } },
  machines: [{ name: 'LAVADORA 1', state: 'Libre' }],
  cash: { coins: [{ cents: 100, count: 40 }], hopper_cents: 4000, notes: [{ cents: 2000, count: 3 }], notes_cents: 6000 },
  pc: { temp_c: 61, mem_used_pct: 40, disk_free_gb: 80 },
  outbox: { depth: 0, oldest_age_s: 0, parked: 0 },
  ...over,
});

async function beat(body, at = NOON) {
  await recordHeartbeat(db, KIOSK, { now_utc: new Date(at).toISOString(), ...body }, at);
  return (await db.execute(`SELECT * FROM kiosk_status WHERE kiosk_id = 'K1'`)).rows[0];
}

const codes = list => list.map(c => c.code);

test('a healthy kiosk has nothing to report', async () => {
  const s = await beat(healthy());
  assert.deepEqual(conditions(KIOSK, s, NOON + 2 * MIN), []);
});

test('silence is only a problem after the time the kiosk itself announced', async () => {
  const s = await beat(healthy());
  assert.deepEqual(conditions(KIOSK, s, NOON + 7 * MIN), []);
  assert.deepEqual(codes(conditions(KIOSK, s, NOON + 9 * MIN)), [701]);
});

test('the wider night interval does not raise a false alarm', async () => {
  const s = await beat(healthy({ next_in_s: 1800, selling: false }));
  assert.deepEqual(conditions(KIOSK, s, NOON + 40 * MIN), []);
  assert.deepEqual(codes(conditions(KIOSK, s, NOON + 46 * MIN)), [701]);
});

test('telemetry switched off stays quiet, but only until it expires', async () => {
  const s = await beat(healthy({ mode: 'off', off_until: new Date(NOON + 60 * MIN).toISOString() }));
  assert.deepEqual(conditions(KIOSK, s, NOON + 59 * MIN), []);
  assert.deepEqual(codes(conditions(KIOSK, s, NOON + 64 * MIN)), [701]);
});

test('telemetry cannot be switched off for more than a week', async () => {
  const s = await beat(healthy({ mode: 'off', off_until: new Date(NOON + 365 * 24 * 60 * MIN).toISOString() }));
  assert.equal(s.off_until, new Date(NOON + 7 * 24 * 60 * MIN).toISOString());
});

test('a silenced kiosk reports nothing', async () => {
  const s = await beat(healthy());
  const silenced = { ...KIOSK, silenced_until: new Date(NOON + 120 * MIN).toISOString() };
  assert.deepEqual(conditions(silenced, s, NOON + 100 * MIN), []);
});

test('device problems count during selling hours only', async () => {
  const devices = { ...healthy().devices, bank: { ok: false, status: 'no activado' } };
  assert.deepEqual(codes(conditions(KIOSK, await beat(healthy({ devices })), NOON + MIN)), [101]);
  assert.deepEqual(conditions(KIOSK, await beat(healthy({ devices, selling: false })), NOON + MIN), []);
});

test('each kind of trouble has its own code', async () => {
  const s = await beat(healthy({
    coins_low: [50], unfinished_paid: 1, ui_tick_age_s: 300, pc: { temp_c: 90 }, outbox: { oldest_age_s: 3 * 3600, parked: 2 },
    now_utc: new Date(NOON + 5 * MIN).toISOString(),
  }));
  const found = conditions(KIOSK, s, NOON + MIN, { reconBad: ['2026-11-03'], unmatchedProducts: 1 });
  assert.deepEqual(codes(found).sort(), [202, 502, 702, 703, 704, 801, 802, 803, 804]);
  assert.match(found.find(c => c.code === 202).message, /0,50 €/);
});

test('an unknown temperature never alerts', async () => {
  assert.deepEqual(conditions(KIOSK, await beat(healthy({ pc: { temp_c: null } })), NOON + MIN), []);
});

test('the public status never carries money', async () => {
  await beat(healthy());
  const [k] = await allPublicStatus(db, NOON + MIN);
  assert.equal(k.state, 'ok');
  const text = JSON.stringify(k);
  for (const secret of ['cash', 'hopper', 'notes_cents', 'cents', '6000']) assert.ok(!text.includes(secret), `leaked ${secret}`);
  assert.deepEqual(k.machines, [{ name: 'LAVADORA 1', state: 'Libre' }]);
});

test('public status shows coins as low without amounts', async () => {
  await beat(healthy({ coins_low: [100] }));
  const [k] = await allPublicStatus(db, NOON + MIN);
  assert.equal(k.components.find(c => c.key === 'coins').status, 'bajo');
  assert.equal(k.state, 'problem');
});

test('public status says so when the kiosk has gone quiet', async () => {
  await beat(healthy());
  const [k] = await allPublicStatus(db, NOON + 30 * MIN);
  assert.equal(k.state, 'down');
  assert.deepEqual(k.machines, []);
  assert.equal(k.components[0].ok, null);
});

test('a kiosk with no heartbeat yet shows as unknown and does not alert', async () => {
  const [k] = await allPublicStatus(db, NOON);
  assert.equal(k.state, 'unknown');
  const sent = [];
  await watchTick(db, async text => { sent.push(text); return true; }, NOON);
  assert.deepEqual(sent, []);
});

function recorder(result = true) {
  const sent = [];
  const send = async (text, silent) => { sent.push({ text, silent }); return result; };
  return { sent, send };
}

test('an alert is announced once, then closed with an all-clear', async () => {
  await beat(healthy());
  const { sent, send } = recorder();
  await watchTick(db, send, NOON + 9 * MIN);
  await watchTick(db, send, NOON + 14 * MIN);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Sin señal/);
  assert.match(sent[0].text, /Código 701/);
  await beat(healthy(), NOON + 15 * MIN);
  await watchTick(db, send, NOON + 16 * MIN);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /Resuelto/);
  assert.equal((await db.execute('SELECT COUNT(*) n FROM kiosk_alerts WHERE closed_at IS NULL')).rows[0].n, 0);
});

test('a brief blip that clears before its hold time tells nobody', async () => {
  const devices = { ...healthy().devices, bank: { ok: false, status: 'activando' } };
  await beat(healthy({ devices }));
  const { sent, send } = recorder();
  await watchTick(db, send, NOON + MIN);
  await beat(healthy(), NOON + 3 * MIN);
  await watchTick(db, send, NOON + 4 * MIN);
  assert.deepEqual(sent, []);
});

test('a problem that lasts past its hold time is announced', async () => {
  const devices = { ...healthy().devices, bank: { ok: false, status: 'no activado' } };
  await beat(healthy({ devices }));
  const { sent, send } = recorder();
  await watchTick(db, send, NOON + MIN);
  assert.equal(sent.length, 0);
  await beat(healthy({ devices }), NOON + 6 * MIN);
  await watchTick(db, send, NOON + 11 * MIN);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /tarjeta bancaria/);
});

test('a message that could not be sent is tried again', async () => {
  await beat(healthy());
  const failing = recorder(false);
  await watchTick(db, failing.send, NOON + 9 * MIN);
  assert.equal(failing.sent.length, 1);
  const working = recorder();
  await watchTick(db, working.send, NOON + 14 * MIN);
  assert.equal(working.sent.length, 1);
});

test('a long problem is reminded a few hours later, and nights are silent', async () => {
  await beat(healthy());
  const { sent, send } = recorder();
  await watchTick(db, send, NOON + 9 * MIN);
  await watchTick(db, send, NOON + 5 * 60 * MIN);
  assert.equal(sent.length, 1);
  await watchTick(db, send, NOON + 6 * 60 * MIN + 10 * MIN);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /Sigue pendiente/);
  assert.equal(sent[1].silent, false);

  // 02:00 in Madrid: a new problem arrives without a sound.
  const night = Date.parse('2026-11-05T01:00:00Z');
  await db.execute('DELETE FROM kiosk_alerts');
  await beat(healthy(), night - 30 * MIN);
  const n = recorder();
  await watchTick(db, n.send, night);
  assert.equal(n.sent[0].silent, true);
});

test('the morning all-fine goes out once, and not when something is wrong', async () => {
  const morning = Date.parse('2026-11-04T07:06:00Z'); // 08:06 in Madrid
  await beat(healthy(), morning - MIN);
  const { sent, send } = recorder();
  await watchTick(db, send, morning);
  await watchTick(db, send, morning + 5 * MIN);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Todo bien/);

  await db.execute('UPDATE kiosk_status SET last_daily_date = NULL');
  await beat(healthy({ coins_low: [50] }), morning + 6 * MIN);
  const other = recorder();
  await watchTick(db, other.send, morning + 7 * MIN);
  assert.ok(other.sent.every(m => !/Todo bien/.test(m.text)));
});

function sale(id, over = {}) {
  return {
    id, receipt_no: `K1-261104-${id.padStart(4, '0')}`, kind: 'machine', machine: 'LAVADORA 3', method: 'cash', status: 'completed', cycles: 1,
    price_cents: 700, created_at: '2026-11-04 10:15:30.000', updated_at: '2026-11-04 10:16:00.000', ...over,
  };
}
const day = (ids, cash = 0, bank = 0, card = 0) => [{ date: '2026-11-04', count: ids.length, cents: { cash, bank, card }, sale_ids: ids }];

test('the night check passes when everything arrived', async () => {
  await beat(healthy());
  await ingestSales(db, KIOSK, [sale('1'), sale('2', { method: 'bank' })], '3.1.0');
  const r = await reconcile(db, KIOSK, day(['1', '2'], 700, 700), NOON);
  assert.deepEqual(r.missing, []);
  assert.equal(r.results[0].status, 'ok');
  assert.equal((await db.execute('SELECT recon_ok_through t FROM kiosk_status')).rows[0].t, '2026-11-04');
});

test('the night check asks for sales the cloud never received', async () => {
  await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  const r = await reconcile(db, KIOSK, day(['1', '2'], 1400), NOON);
  assert.deepEqual(r.missing, ['2']);
  assert.equal(r.results[0].status, 'pending');
});

test('the night check flags a posted sale gone from sales_detail, and does not repost it', async () => {
  await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  await db.execute('DELETE FROM sales_detail');
  const r = await reconcile(db, KIOSK, day(['1'], 700), NOON);
  assert.deepEqual(r.missing, []);
  assert.equal(r.results[0].status, 'mismatch');
  assert.match(r.results[0].problems[0], /sales_detail/);
  assert.equal((await db.execute('SELECT COUNT(*) n FROM sales_detail')).rows[0].n, 0);
  assert.equal((await db.execute(`SELECT COUNT(*) n FROM kiosk_recon WHERE status = 'mismatch'`)).rows[0].n, 1);
});

test('the night check flags a wrong daily total in sales', async () => {
  await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  await db.execute('UPDATE sales SET euros = euros + 1');
  const r = await reconcile(db, KIOSK, day(['1'], 700), NOON);
  assert.equal(r.results[0].status, 'mismatch');
  assert.match(r.results[0].problems[0], /sales cash/);
});

test('fake AWS rows under an older label do not confuse the night check', async () => {
  await db.execute(`INSERT INTO sales (movement, account, euros, mcf_user, date_real) VALUES ('VentasDia011126_223501 [cash]', 'cash', 98, 'local-hortaleza', '2026-11-04')`);
  await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  const r = await reconcile(db, KIOSK, day(['1'], 700), NOON);
  assert.equal(r.results[0].status, 'ok');
});

test('a bad day stops recon_ok_through from moving past it', async () => {
  await beat(healthy());
  await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  const r = await reconcile(db, KIOSK, [
    { date: '2026-11-03', cents: { cash: 500 }, sale_ids: ['x'] },
    { date: '2026-11-04', cents: { cash: 700 }, sale_ids: ['1'] },
  ], NOON);
  assert.equal(r.results.find(d => d.date === '2026-11-03').status, 'pending');
  assert.equal((await db.execute('SELECT recon_ok_through t FROM kiosk_status')).rows[0].t, null);
});

test('the right PIN names its owner, and wrong ones eventually lock', async () => {
  const u = hashPin('123456');
  await db.execute({ sql: `INSERT INTO kiosk_users (mcf_user, role, pin_salt, pin_hash, pin_iterations) VALUES ('lalo', 'owner', ?, ?, ?)`, args: [u.pin_salt, u.pin_hash, u.pin_iterations] });
  assert.deepEqual(await checkPin(db, '123456', NOON), { ok: true, user: 'lalo' });
  for (let i = 0; i < 4; i++) assert.equal((await checkPin(db, '000000', NOON)).locked, false);
  assert.equal((await checkPin(db, '000000', NOON)).locked, true);
  assert.equal((await checkPin(db, '123456', NOON + MIN)).locked, true);
  assert.deepEqual(await checkPin(db, '123456', NOON + 6 * MIN), { ok: true, user: 'lalo' });
});

test('a malformed PIN is simply wrong', async () => {
  assert.equal((await checkPin(db, 'abc', NOON)).ok, false);
  assert.equal((await checkPin(db, null, NOON)).ok, false);
});

test('publicStatus works before any heartbeat', () => {
  assert.equal(publicStatus(KIOSK, undefined, [], NOON).state, 'unknown');
});
