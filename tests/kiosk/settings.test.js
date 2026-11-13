import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { chargeableProducts, discountProblem, discountedCents, missingProducts, saveSettings, settingsProblem, settingsRequest } from '../../api/_lib/kiosk-settings.js';
import { kioskConfig } from '../../api/_lib/kiosk-config.js';
import { hashPin } from '../../api/_lib/kiosk-pin.js';

const schema = readFileSync(new URL('../../scripts/schema-kiosk.sql', import.meta.url), 'utf8');
const products = JSON.parse(readFileSync(new URL('./products-hortaleza.json', import.meta.url), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'kiosk-settings-'));

const KIOSK = { kiosk_id: 'K1', price_list: 'cesar1', property: 'hortaleza' };
const MACHINES = ['LAVADORA 1', 'LAVADORA 2', 'LAVADORA 3', 'LAVADORA 4', 'SECADORA 5', 'SECADORA 6', 'SECADORA 7'];

const all = (cents, card_cents) => [{ from: '00:00', to: '23:59', cents, card_cents }];
const settings = over => ({
  home_notice: '',
  hours: Array.from({ length: 7 }, () => ({ open: '08:00', last_wash: '21:20', last_sale: '21:50', close: '22:00' })),
  black_screen_from: '22:00',
  prices: {
    'LAVADORA 1': all(500, 450), 'LAVADORA 2': all(500, 450), 'LAVADORA 3': all(700, 630), 'LAVADORA 4': all(800, 720),
    'SECADORA 5': [{ from: '00:00', to: '21:15', cents: 250, card_cents: 225 }, { from: '21:16', to: '23:59', cents: 200, card_cents: 200 }],
    'SECADORA 6': all(250, 225), 'SECADORA 7': all(200, 180),
  },
  max_cycles: 5,
  card: { price_cents: 2000, initial_balance_cents: 1800, topup_amounts: [500, 1000, 1500, 2000], sell_cards: true },
  timeouts: { inactivity_seconds: 60, cash_gap_seconds: 60, done_screen_seconds: 15 },
  cloud: { upload_minutes: 30, telemetry_enabled: true, heartbeat_day_minutes: 5, heartbeat_night_minutes: 30, night_check_at: '23:00', low_coins: { 50: 20, 100: 20, 200: 10 }, temp_alert_c: 85 },
  min_change_in_hopper_cents: 1500,
  ...over,
});

let db;
let counter = 0;

afterEach(() => db.close());

beforeEach(async () => {
  db = createClient({ url: `file:${join(dir, `t${++counter}.db`)}` });
  await db.batch([
    `CREATE TABLE sales_detail (id INTEGER PRIMARY KEY AUTOINCREMENT, movid TEXT NOT NULL)`,
    `CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, product TEXT NOT NULL, precio REAL NOT NULL, capacidad TEXT, product_price TEXT, product_size TEXT, product_mins INTEGER DEFAULT 0, product_mission TEXT, subproducto TEXT, day_subproduct_capacity INTEGER DEFAULT 0, day_product_capacity INTEGER DEFAULT 0, notes TEXT, price_list TEXT NOT NULL, property TEXT NOT NULL)`,
  ], 'write');
  for (const stmt of schema.split(/;\s*\n/).map(s => s.replace(/--[^\n]*/g, '').trim()).filter(Boolean)) await db.execute(stmt);
  await db.batch(products.map(p => ({
    sql: `INSERT INTO products (product, precio, capacidad, product_price, product_size, product_mins, product_mission, subproducto, day_subproduct_capacity, day_product_capacity, notes, price_list, property) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [p.product, p.precio, p.capacidad, p.product_price, p.product_size, p.product_mins, p.product_mission, p.subproducto, p.day_subproduct_capacity, p.day_product_capacity, p.notes, p.price_list, p.property],
  })), 'write');
  await db.execute(`INSERT INTO kiosks (kiosk_id, name, key_hash, company, price_list, property, propiedad_label, sales_user, sales_suffix) VALUES ('K1', 'Hortaleza', 'h', 'mcf', 'cesar1', 'hortaleza', '(002) Hortaleza', 'local-hortaleza', '223501')`);
});

test('discount rounding matches prices the old kiosk charged', () => {
  // Each pair is a card price and discount with its result in the real products table.
  for (const [cents, pct, expected] of [[450, 10, 405], [450, 5, 430], [630, 10, 570], [630, 5, 600], [720, 10, 650], [720, 5, 685], [675, 5, 645], [675, 10, 610], [225, 5, 215], [225, 10, 205], [180, 5, 175], [180, 10, 165], [360, 10, 325]]) {
    assert.equal(discountedCents(cents, pct), expected, `${cents} at ${pct}%`);
  }
  assert.equal(discountedCents(720, 100), 0);
  assert.equal(discountedCents(450, 20), 360);
});

test('a normal configuration passes', () => {
  assert.equal(settingsProblem(settings(), MACHINES), null);
  assert.equal(settingsProblem({}, MACHINES), null);
  assert.equal(settingsProblem(settings({ black_screen_from: '' }), MACHINES), null, 'empty = never black');
  assert.equal(settingsProblem(settings({ black_screen_from: '01:00' }), MACHINES), null);
});

const bad = [
  ['six-day week', { hours: Array(6).fill({ open: '08:00', last_wash: '21:20', last_sale: '21:50', close: '22:00' }) }, /7 días/],
  ['bad time', { hours: Array(7).fill({ open: '8am', last_wash: '21:20', last_sale: '21:50', close: '22:00' }) }, /hora no válida/],
  ['hours out of order', { hours: Array(7).fill({ open: '08:00', last_wash: '22:30', last_sale: '21:50', close: '22:00' }) }, /en orden/],
  ['black screen at a bad time', { black_screen_from: '10pm' }, /pantalla negra/],
  ['black screen not text', { black_screen_from: null }, /pantalla negra/],
  ['unknown machine', { prices: { 'LAVADORA 9': all(500, 450) } }, /desconocida/],
  ['price change cannot be paid', { prices: { 'LAVADORA 1': all(520, 450) } }, /0,50/],
  ['free machine', { prices: { 'LAVADORA 1': all(0, 0) } }, /0,50/],
  ['card dearer than cash', { prices: { 'LAVADORA 1': all(500, 550) } }, /tarjeta/],
  ['overlapping windows', { prices: { 'SECADORA 5': [{ from: '00:00', to: '21:15', cents: 250, card_cents: 225 }, { from: '21:00', to: '23:59', cents: 200, card_cents: 200 }] } }, /solapan/],
  ['six cycles', { max_cycles: 6 }, /ciclos/],
  ['top-up over the terminal limit', { card: { price_cents: 2000, initial_balance_cents: 1800, topup_amounts: [2500] } }, /20 €/],
  ['balance above price', { card: { price_cents: 2000, initial_balance_cents: 2500, topup_amounts: [500] } }, /saldo inicial/],
  ['telemetry not a yes or no', { cloud: { ...settings().cloud, telemetry_enabled: 'si' } }, /telemetry/],
  ['long notice', { home_notice: 'x'.repeat(200) }, /140/],
];
for (const [name, over, pattern] of bad) {
  test(`refused: ${name}`, () => assert.match(settingsProblem(settings(over), MACHINES), pattern));
}

test('bad discounts are refused', () => {
  assert.equal(discountProblem({ uid: '96519FBE', percent: 10 }), null);
  assert.match(discountProblem({ uid: 'hola!', percent: 10 }), /tarjeta/);
  assert.match(discountProblem({ uid: '96519FBE', percent: 0 }), /descuento/);
  assert.match(discountProblem({ uid: '96519FBE', percent: 120 }), /descuento/);
});

test('the kiosk cannot be told about ports, wiring or card keys', () => {
  const sent = settings({ cards: { keya: 'FFFFFFFFFFFF' }, coins: { port: 'COM1' } });
  const keys = chargeableProducts(sent);
  assert.ok(keys.every(k => typeof k.product === 'string'));
  assert.equal(settingsProblem(sent, MACHINES), null, 'ignored here; the kiosk has no fields for them, tested on the kiosk');
});

test('today\'s prices need only the four SECADORA 5 night rows', async () => {
  const { missing, noSibling } = await missingProducts(db, KIOSK, settings(), []);
  assert.deepEqual(noSibling, []);
  assert.deepEqual(missing.map(p => `${p.product} ${p.precio}`).sort(), ['SECADORA 5 2', 'SECADORA 5 4', 'SECADORA 5 6', 'SECADORA 5 8']);
  const two = missing.find(p => p.precio === 2);
  assert.equal(two.product_mins, 10);
  assert.equal(two.product_mission, 'SECAR');
  assert.equal(two.capacidad, '21 KGS');
  assert.equal(two.product_price, 'publico');
});

test('saving a new price adds its rows first, so the join never misses', async () => {
  const s = settings({ prices: { ...settings().prices, 'LAVADORA 1': all(550, 495) } });
  const r = await saveSettings(db, KIOSK, 'lalo', s, [], MACHINES);
  assert.equal(r.ok, true);
  const rows = (await db.execute(`SELECT precio, product_price, product_mission, capacidad FROM products WHERE product = 'LAVADORA 1' AND precio IN (5.5, 4.95) ORDER BY precio`)).rows;
  assert.deepEqual(rows.map(p => [p.precio, p.product_price]), [[4.95, 'fidelizacion'], [5.5, 'publico']]);
  assert.equal(rows[0].product_mission, 'LAVAR');
  const again = await saveSettings(db, KIOSK, 'lalo', s, [], MACHINES);
  assert.deepEqual(again.products_added, []);
  assert.equal((await db.execute(`SELECT COUNT(*) n FROM products WHERE product = 'LAVADORA 1' AND precio = 5.5`)).rows[0].n, 1, 'a duplicate key would multiply report rows');
});

test('discounted prices get their rows too', async () => {
  const r = await saveSettings(db, KIOSK, 'lalo', settings(), [{ uid: '96519FBE', percent: 20 }], MACHINES);
  assert.ok(r.products_added.some(p => p.product === 'LAVADORA 1' && p.precio === 3.6));
  const [row] = (await db.execute(`SELECT product_price FROM products WHERE product = 'LAVADORA 1' AND precio = 3.6`)).rows;
  assert.equal(row.product_price, 'descuento');
});

test('a rejected save changes nothing', async () => {
  const before = (await db.execute('SELECT COUNT(*) n FROM products')).rows[0].n;
  const r = await saveSettings(db, KIOSK, 'lalo', settings({ prices: { 'LAVADORA 1': all(520, 450) } }), [], MACHINES);
  assert.equal(r.ok, false);
  assert.equal((await db.execute('SELECT COUNT(*) n FROM products')).rows[0].n, before);
  assert.equal((await db.execute('SELECT COUNT(*) n FROM kiosk_settings')).rows[0].n, 0);
});

test('a new machine with nothing to copy from is refused', async () => {
  const r = await saveSettings(db, KIOSK, 'lalo', settings({ prices: { 'SECADORA 9': all(250, 225) } }), [], ['SECADORA 9']);
  assert.equal(r.ok, false);
  assert.match(r.problem, /SECADORA 9/);
});

test('rev changes only when the content does', async () => {
  const a = await kioskConfig(db, KIOSK);
  assert.equal(a.settings, null);
  assert.deepEqual(a.discounts, []);
  assert.equal((await kioskConfig(db, KIOSK)).rev, a.rev);
  await saveSettings(db, KIOSK, 'lalo', settings(), [{ uid: '96519fbe', percent: 10 }], MACHINES);
  const b = await kioskConfig(db, KIOSK);
  assert.notEqual(b.rev, a.rev);
  assert.deepEqual(b.discounts, [{ uid: '96519FBE', percent: 10 }]);
  assert.equal(b.settings.max_cycles, 5);
});

test('the editor always gets every section, even from a partial save', async () => {
  await db.execute({
    sql: `INSERT INTO kiosk_status (kiosk_id, received_at, next_due_at, payload) VALUES ('K1', 'x', 'x', ?)`,
    args: [JSON.stringify({ settings: settings({ home_notice: 'del kiosco' }), config_rev: 'abc' })],
  });
  await db.execute(`INSERT INTO kiosk_settings (kiosk_id, settings) VALUES ('K1', '{"home_notice":"guardado"}')`);
  const u = hashPin('123456');
  await db.execute({ sql: `INSERT INTO kiosk_users (mcf_user, role, pin_salt, pin_hash, pin_iterations) VALUES ('lalo', 'owner', ?, ?, ?)`, args: [u.pin_salt, u.pin_hash, u.pin_iterations] });
  const { json } = await settingsRequest(db, { pin: '123456', action: 'load' });
  assert.equal(json.settings.home_notice, 'guardado');
  assert.equal(json.settings.hours.length, 7);
  assert.equal(json.settings.max_cycles, 5);
  assert.equal(json.machines.length, 7);
  assert.equal(json.applied_rev, 'abc');
});

test('every save is recorded with who did it', async () => {
  await saveSettings(db, KIOSK, 'oscar', settings(), [], MACHINES);
  const [a] = (await db.execute('SELECT * FROM kiosk_audit')).rows;
  assert.equal(a.mcf_user, 'oscar');
  assert.equal(a.action, 'settings.save');
  assert.match(a.detail, /SECADORA 5 2/);
});

test('without a right PIN nothing can be read or saved', async () => {
  const u = hashPin('123456');
  await db.execute({ sql: `INSERT INTO kiosk_users (mcf_user, role, pin_salt, pin_hash, pin_iterations) VALUES ('lalo', 'owner', ?, ?, ?)`, args: [u.pin_salt, u.pin_hash, u.pin_iterations] });
  assert.equal((await settingsRequest(db, { pin: '000000', action: 'load' })).status, 401);
  assert.equal((await settingsRequest(db, { action: 'load' })).status, 401);
  assert.equal((await settingsRequest(db, { pin: '000000', action: 'save', settings: settings() })).status, 401);
  assert.equal((await db.execute('SELECT COUNT(*) n FROM kiosk_settings')).rows[0].n, 0);
  const ok = await settingsRequest(db, { pin: '123456', action: 'load' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user, 'lalo');
  const saved = await settingsRequest(db, { pin: '123456', action: 'save', settings: settings(), discounts: [] });
  assert.equal(saved.status, 200);
  assert.equal((await db.execute('SELECT updated_by FROM kiosk_settings')).rows[0].updated_by, 'lalo');
});
