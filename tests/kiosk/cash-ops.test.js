import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { cashOpProblem, ingestCashOps } from '../../api/_lib/kiosk-ingest.js';

const schema = readFileSync(new URL('../../scripts/schema-kiosk.sql', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'kiosk-cash-'));
const KIOSK = { kiosk_id: 'K1' };
let db;
let counter = 0;

afterEach(() => db.close());

beforeEach(async () => {
  db = createClient({ url: `file:${join(dir, `t${++counter}.db`)}` });
  await db.batch([
    `CREATE TABLE sales_detail (id INTEGER PRIMARY KEY AUTOINCREMENT, movid TEXT NOT NULL)`,
    `CREATE TABLE movements (id INTEGER PRIMARY KEY AUTOINCREMENT, movement TEXT NOT NULL, type TEXT NOT NULL, account TEXT DEFAULT 'cash', euros REAL NOT NULL DEFAULT 0, propiedad TEXT, mcf_user TEXT, date_real TEXT NOT NULL, description TEXT, icon TEXT DEFAULT 'x', created_at TEXT DEFAULT (datetime('now')))`,
  ], 'write');
  for (const stmt of schema.split(/;\s*\n/).map(s => s.replace(/--[^\n]*/g, '').trim()).filter(Boolean)) await db.execute(stmt);
  await db.execute(`INSERT INTO kiosks (kiosk_id, name, key_hash, company, price_list, property, propiedad_label, sales_user, sales_suffix)
    VALUES ('K1', 'Hortaleza', 'h', 'mcf', 'cesar1', 'hortaleza', '(002) Hortaleza', 'local-hortaleza', '223501')`);
});

const pull = over => ({
  id: 'op1', kind: 'pull', mcf_user: 'lalo', created_at: '2026-11-04 10:00:00.000', committed_at: '2026-11-04 10:05:00.000',
  b20e: 2, b10e: 1, b5e: 5, m2e: 0, m1e: 0, m50e: 0, m20e: 0, m10e: 0, m5e: 0, total_cents: 7500, expected_cents: 7500, note: '', ...over,
});
const coins = over => pull({ id: 'op2', kind: 'coins', b20e: 0, b10e: 0, b5e: 0, m2e: 3, m1e: 10, m50e: 4, total_cents: 1800, expected_cents: 1800, ...over });
const rows = async () => (await db.execute('SELECT * FROM movements ORDER BY id')).rows;

test('a cash pull is the same row the website form writes', async () => {
  const r = await ingestCashOps(db, KIOSK, [pull()]);
  assert.deepEqual(r.accepted, ['op1']);
  const [m] = await rows();
  assert.equal(m.movement, 'Movimiento transito - 2026-11-04');
  assert.equal(m.type, 'transito');
  assert.equal(m.account, 'cash');
  assert.equal(m.euros, 75);
  assert.equal(m.propiedad, '(002) Hortaleza');
  assert.equal(m.mcf_user, 'lalo');
  assert.equal(m.date_real, '2026-11-04');
  assert.equal(m.description, 'Count de billetes: 20e = 2, 10e = 1, 5e = 5 - Count de Monedas: 2e = 0, 1e = 0, 0.50e = 0, 0.20e = 0, 0.10e = 0, 0.05e = 0');
  assert.equal(m.icon, '🟡');
});

test('adding coins is a fondo caja row', async () => {
  await ingestCashOps(db, KIOSK, [coins()]);
  const [m] = await rows();
  assert.equal(m.movement, 'Movimiento fondo caja - 2026-11-04');
  assert.equal(m.type, 'fondo caja');
  assert.equal(m.euros, 18);
  assert.match(m.description, /2e = 3, 1e = 10, 0.50e = 4/);
});

test('a person balance moves the right way, by the website formula', async () => {
  await ingestCashOps(db, KIOSK, [pull(), coins()]);
  // api/hub.js: transito adds, gasto, deposito and fondo caja subtract.
  const balance = await db.execute(`SELECT mcf_user,
    SUM(CASE WHEN type = 'transito' THEN euros ELSE 0 END) - SUM(CASE WHEN type IN ('gasto','deposito','fondo caja','fondo_caja') THEN euros ELSE 0 END) AS b
    FROM movements GROUP BY mcf_user`);
  assert.equal(balance.rows[0].mcf_user, 'lalo');
  assert.equal(balance.rows[0].b, 57);
});

test('sending an operation again adds nothing', async () => {
  await ingestCashOps(db, KIOSK, [pull()]);
  const again = await ingestCashOps(db, KIOSK, [pull()]);
  assert.deepEqual(again.accepted, ['op1']);
  assert.equal((await rows()).length, 1);
});

test('a retry after a lost answer adds nothing', async () => {
  const flaky = { batch: async (s, m) => { await db.batch(s, m); throw new Error('reset after commit'); } };
  const first = await ingestCashOps(flaky, KIOSK, [pull()]);
  assert.equal(first.rejected[0].reason, 'processing');
  await ingestCashOps(db, KIOSK, [pull()]);
  assert.equal((await rows()).length, 1);
});

test('the date is when it happened at the kiosk, even if it arrives days later', async () => {
  await ingestCashOps(db, KIOSK, [pull({ committed_at: '2026-10-30 21:00:00.000' })]);
  assert.equal((await rows())[0].date_real, '2026-10-30');
});

test('the difference an owner corrected is kept with the operation', async () => {
  await ingestCashOps(db, KIOSK, [pull({ expected_cents: 8000, note: 'el kiosco contó 80,00 €, retirado 75,00 €' })]);
  const [op] = (await db.execute('SELECT * FROM kiosk_cash_ops')).rows;
  assert.equal(op.expected_cents, 8000);
  assert.equal(op.total_cents, 7500);
  assert.match(op.note, /80,00/);
});

test('bad operations are refused and do not hold back the good ones', async () => {
  const r = await ingestCashOps(db, KIOSK, [pull({ id: 'bad', total_cents: 9999 }), pull({ id: 'good' }), pull({ id: 'bad2', mcf_user: '' })]);
  assert.deepEqual(r.accepted, ['good']);
  assert.deepEqual(r.rejected.map(x => x.id).sort(), ['bad', 'bad2']);
  assert.ok(r.rejected.every(x => x.reason === 'schema'));
  assert.equal((await rows()).length, 1);
});

test('what makes an operation invalid', () => {
  assert.equal(cashOpProblem(pull()), null);
  assert.match(cashOpProblem(pull({ kind: 'robo' })), /kind/);
  assert.match(cashOpProblem(pull({ total_cents: 1 })), /total/);
  assert.match(cashOpProblem(pull({ b20e: -1, total_cents: 3500 })), /count/);
  assert.match(cashOpProblem(pull({ committed_at: 'ayer' })), /committed_at/);
  assert.match(cashOpProblem(pull({ b20e: 0, b10e: 0, b5e: 0, total_cents: 0 })), /nothing/);
});
