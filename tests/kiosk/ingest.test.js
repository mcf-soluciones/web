import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { ingestAppendOnly, ingestSales } from '../../api/_lib/kiosk-ingest.js';

const schema = readFileSync(new URL('../../scripts/schema-kiosk.sql', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'kiosk-ingest-'));

const KIOSK = {
  kiosk_id: 'K1', name: 'Hortaleza', key_hash: 'x', company: 'mcf', price_list: 'cesar1', property: 'hortaleza',
  propiedad_label: '(002) Hortaleza', sales_user: 'local-hortaleza', sales_suffix: '223501', post_enabled: 1,
};

let db;
let counter = 0;

/** Same tables as production, from the same DDL as scripts/schema.sql and schema-sales-detail.sql. */
async function freshDb() {
  const c = createClient({ url: `file:${join(dir, `t${++counter}.db`)}` });
  await c.batch([
    `CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, movement TEXT NOT NULL, type TEXT DEFAULT 'venta', account TEXT, euros REAL NOT NULL DEFAULT 0, mcf_user TEXT, date_real TEXT NOT NULL, icon TEXT DEFAULT 'g', created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, product TEXT NOT NULL, precio REAL NOT NULL, capacidad TEXT, product_price TEXT, product_size TEXT, product_mins INTEGER DEFAULT 0, product_mission TEXT, subproducto TEXT, day_subproduct_capacity INTEGER DEFAULT 0, day_product_capacity INTEGER DEFAULT 0, notes TEXT, price_list TEXT NOT NULL, property TEXT NOT NULL)`,
    `CREATE TABLE sales_detail (id INTEGER PRIMARY KEY AUTOINCREMENT, movid TEXT NOT NULL, date TEXT NOT NULL, yyyy INTEGER NOT NULL, mm INTEGER NOT NULL, dd INTEGER NOT NULL, time TEXT, hr INTEGER, min INTEGER, payment TEXT, product TEXT, euro REAL DEFAULT 0, company TEXT, dayweek TEXT, price_list TEXT, property TEXT)`,
  ], 'write');
  for (const stmt of schema.split(/;\s*\n/).map(s => s.replace(/--[^\n]*/g, '').trim()).filter(Boolean)) await c.execute(stmt);
  await c.execute({
    sql: `INSERT INTO kiosks (kiosk_id, name, key_hash, company, price_list, property, propiedad_label, sales_user, sales_suffix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [KIOSK.kiosk_id, KIOSK.name, KIOSK.key_hash, KIOSK.company, KIOSK.price_list, KIOSK.property, KIOSK.propiedad_label, KIOSK.sales_user, KIOSK.sales_suffix],
  });
  await c.execute(`INSERT INTO products (product, precio, price_list, property) VALUES ('LAVADORA 3', 7.0, 'cesar1', 'hortaleza'), ('SECADORA 5', 7.5, 'cesar1', 'hortaleza'), ('LAVADORA 3', 6.3, 'cesar1', 'hortaleza')`);
  return c;
}

function sale(id, over = {}) {
  return {
    id, receipt_no: `K1-261104-${id.padStart(4, '0')}`, kind: 'machine', machine: 'LAVADORA 3', method: 'cash', status: 'completed',
    cycles: 1, price_cents: 700, inserted_cents: 1000, change_cents: 300, shortfall_cents: 0,
    created_at: '2026-11-04 10:15:30.000', updated_at: '2026-11-04 10:16:00.000', ...over,
  };
}

const all = async (sql, args = []) => (await db.execute({ sql, args })).rows;

afterEach(() => db.close());

beforeEach(async () => { db = await freshDb(); });

test('a completed sale reaches sales_detail, sales and kiosk_sales', async () => {
  const r = await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  assert.deepEqual(r, { accepted: ['1'], rejected: [] });

  const [d] = await all('SELECT * FROM sales_detail');
  assert.equal(d.movid, 'K1-261104-0001');
  assert.equal(d.date, '2026-11-04');
  assert.equal(d.yyyy, 2026);
  assert.equal(d.mm, 11);
  assert.equal(d.dd, 4);
  assert.equal(d.time, '10:15:30');
  assert.equal(d.hr, 10);
  assert.equal(d.min, 15);
  assert.equal(d.payment, 'EFECTIVO');
  assert.equal(d.product, 'LAVADORA 3');
  assert.equal(d.euro, 7);
  assert.equal(d.company, 'mcf');
  assert.equal(d.dayweek, 'Wednesday');
  assert.equal(d.price_list, 'cesar1');
  assert.equal(d.property, 'hortaleza');

  const [s] = await all('SELECT * FROM sales');
  assert.equal(s.movement, 'VentasDia041126_223501 [cash]');
  assert.equal(s.type, 'venta');
  assert.equal(s.account, 'cash');
  assert.equal(s.euros, 7);
  assert.equal(s.mcf_user, 'local-hortaleza');
  assert.equal(s.date_real, '2026-11-04');

  const [k] = await all('SELECT * FROM kiosk_sales');
  assert.equal(k.post_state, 'posted');
  assert.equal(k.product_ok, 1);
  assert.equal(k.change_cents, 300);
});

test('stored numbers are real integers, as in rows from the old pipeline', async () => {
  await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  const [t] = await all(`SELECT typeof(yyyy) y, typeof(hr) h, typeof(min) m, typeof(euro) e FROM sales_detail`);
  assert.deepEqual({ ...t }, { y: 'integer', h: 'integer', m: 'integer', e: 'real' });
  const [c] = await all('SELECT typeof(price_cents) p FROM kiosk_sales');
  assert.equal(c.p, 'integer');
});

test('sending the same sale again changes nothing', async () => {
  await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  await ingestSales(db, KIOSK, [sale('1', { price_cents: 99999 })], '3.1.0');
  assert.equal((await all('SELECT COUNT(*) n FROM sales_detail'))[0].n, 1);
  assert.equal((await all('SELECT COUNT(*) n FROM sales'))[0].n, 1);
  assert.equal((await all('SELECT euros FROM sales'))[0].euros, 7);
  assert.equal((await all('SELECT price_cents FROM kiosk_sales'))[0].price_cents, 700);
});

test('a retry after a commit whose answer was lost is harmless', async () => {
  const flaky = {
    batch: async (stmts, mode) => { await db.batch(stmts, mode); throw new Error('connection reset after commit'); },
    execute: (...a) => db.execute(...a),
  };
  const first = await ingestSales(flaky, KIOSK, [sale('1')], '3.1.0');
  assert.equal(first.accepted.length, 0);
  assert.equal(first.rejected[0].reason, 'processing');
  const second = await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  assert.deepEqual(second.accepted, ['1']);
  assert.equal((await all('SELECT COUNT(*) n FROM sales_detail'))[0].n, 1);
  assert.equal((await all('SELECT euros FROM sales'))[0].euros, 7);
});

test('the day total in sales equals the fiscal sum in sales_detail', async () => {
  await ingestSales(db, KIOSK, [
    sale('1'),
    sale('2', { method: 'cash', kind: 'topup', machine: '', price_cents: 2000 }),
    sale('3', { method: 'bank', price_cents: 700 }),
    sale('4', { method: 'card', price_cents: 630 }),
  ], '3.1.0');
  await ingestSales(db, KIOSK, [sale('5', { machine: 'SECADORA 5', price_cents: 750 })], '3.1.0');

  const rows = await all('SELECT account, euros FROM sales ORDER BY account');
  assert.deepEqual(rows.map(r => [r.account, r.euros]), [['banco', 7], ['cash', 34.5]]);
  const [fiscal] = await all(`SELECT SUM(euro) t FROM sales_detail WHERE payment IN ('EFECTIVO','TARJETA BANCO')`);
  const [rollup] = await all('SELECT SUM(euros) t FROM sales');
  assert.equal(fiscal.t, rollup.t);
  assert.equal((await all('SELECT COUNT(*) n FROM sales_detail'))[0].n, 5);
});

test('customer-card sales post to detail but not to the daily rollup', async () => {
  await ingestSales(db, KIOSK, [sale('1', { method: 'card', price_cents: 630 })], '3.1.0');
  const [d] = await all('SELECT payment, euro FROM sales_detail');
  assert.equal(d.payment, 'TARJETA CLIENTE');
  assert.equal(d.euro, 6.3);
  assert.equal((await all('SELECT COUNT(*) n FROM sales'))[0].n, 0);
});

test('failed and cancelled sales stay out of revenue', async () => {
  await ingestSales(db, KIOSK, [
    sale('1', { status: 'activation_failed', shortfall_cents: 700 }),
    sale('2', { status: 'cancelled', receipt_no: '', shortfall_cents: 200 }),
    sale('3', { status: 'paid' }),
  ], '3.1.0');
  assert.equal((await all('SELECT COUNT(*) n FROM sales_detail'))[0].n, 0);
  assert.equal((await all('SELECT COUNT(*) n FROM sales'))[0].n, 0);
  assert.equal((await all(`SELECT COUNT(*) n FROM kiosk_sales WHERE post_state = 'pending'`))[0].n, 3);
});

test('a sale first seen as paid posts once when it completes', async () => {
  await ingestSales(db, KIOSK, [sale('1', { status: 'paid', updated_at: '2026-11-04 10:15:40.000' })], '3.1.0');
  await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  assert.equal((await all('SELECT COUNT(*) n FROM sales_detail'))[0].n, 1);
  assert.equal((await all('SELECT status FROM kiosk_sales'))[0].status, 'completed');
});

test('an older state arriving late does not undo a newer one', async () => {
  await ingestSales(db, KIOSK, [sale('1', { status: 'activation_failed', updated_at: '2026-11-04 10:20:00.000' })], '3.1.0');
  await ingestSales(db, KIOSK, [sale('1', { status: 'paid', updated_at: '2026-11-04 10:15:40.000' })], '3.1.0');
  assert.equal((await all('SELECT status FROM kiosk_sales'))[0].status, 'activation_failed');
});

test('one bad sale does not hold back the others', async () => {
  const r = await ingestSales(db, KIOSK, [sale('1'), sale('2', { price_cents: 'gratis' }), sale('3')], '3.1.0');
  assert.deepEqual(r.accepted.sort(), ['1', '3']);
  assert.equal(r.rejected[0].id, '2');
  assert.equal(r.rejected[0].reason, 'schema');
  assert.equal((await all('SELECT COUNT(*) n FROM sales_detail'))[0].n, 2);
});

test('a price with no products row still posts and is flagged', async () => {
  await ingestSales(db, KIOSK, [sale('1', { machine: 'SECADORA 5', price_cents: 200 })], '3.1.0');
  assert.equal((await all('SELECT COUNT(*) n FROM sales_detail'))[0].n, 1);
  assert.equal((await all('SELECT product_ok FROM kiosk_sales'))[0].product_ok, 0);
});

test('top-ups and card purchases need no products row', async () => {
  await ingestSales(db, KIOSK, [sale('1', { kind: 'topup', machine: '', price_cents: 500 }), sale('2', { kind: 'card', machine: '', price_cents: 2000 })], '3.1.0');
  assert.deepEqual((await all('SELECT product_ok FROM kiosk_sales')).map(r => r.product_ok), [1, 1]);
});

test('posting can be switched off per kiosk', async () => {
  await db.execute(`UPDATE kiosks SET post_enabled = 0`);
  await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  assert.equal((await all('SELECT COUNT(*) n FROM sales_detail'))[0].n, 0);
  assert.equal((await all('SELECT COUNT(*) n FROM sales'))[0].n, 0);
  assert.equal((await all('SELECT post_state FROM kiosk_sales'))[0].post_state, 'pending');
  await db.execute(`UPDATE kiosks SET post_enabled = 1`);
  await ingestSales(db, KIOSK, [sale('1')], '3.1.0');
  assert.equal((await all('SELECT COUNT(*) n FROM sales_detail'))[0].n, 1);
});

test('rows reach the same report join the website uses', async () => {
  await ingestSales(db, KIOSK, [sale('1'), sale('2', { method: 'card', price_cents: 630 }), sale('3', { machine: 'SECADORA 5', price_cents: 750 })], '3.1.0');
  const rows = await all(`SELECT d.movid, p.precio FROM sales_detail d LEFT JOIN products p
    ON d.product = p.product AND d.euro = p.precio AND d.price_list = p.price_list AND d.property = p.property`);
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.precio !== null), 'every row must join');
});

test('append-only streams are stored once and report how far they got', async () => {
  const body = {
    cash_moves: [{ id: 7, sale_id: 'a', at: '2026-11-04 10:15:30.000', kind: 'note_in', cents: 2000 }, { id: 8, sale_id: 'a', at: '2026-11-04 10:15:31.000', kind: 'coin_out', cents: 1300 }],
    card_moves: [{ id: 3, uid: 'ABC', at: '2026-11-04 10:15:30.000', kind: 'spend', cents: -630, balance_after: 370, sale_id: 'b', note: 'x' }],
    events: [{ id: 21, at: '2026-11-04 10:15:30.000', type: 'service.open', detail: 'F5' }],
  };
  const through = await ingestAppendOnly(db, KIOSK, 'uuid-1', body);
  assert.deepEqual(through, { cash_moves: 8, card_moves: 3, events: 21 });
  await ingestAppendOnly(db, KIOSK, 'uuid-1', body);
  assert.equal((await all('SELECT COUNT(*) n FROM kiosk_cash_moves'))[0].n, 2);
  assert.equal((await all('SELECT COUNT(*) n FROM kiosk_card_moves'))[0].n, 1);
  assert.equal((await all('SELECT COUNT(*) n FROM kiosk_events'))[0].n, 1);
  // A rebuilt kiosk database restarts its ids: those are new rows, not repeats.
  await ingestAppendOnly(db, KIOSK, 'uuid-2', { cash_moves: [body.cash_moves[0]] });
  assert.equal((await all('SELECT COUNT(*) n FROM kiosk_cash_moves'))[0].n, 3);
});
