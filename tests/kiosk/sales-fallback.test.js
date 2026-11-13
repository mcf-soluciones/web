import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { detailIndex, storesOnSalesOnly } from '../../api/_lib/sales-fallback.js';

const dir = mkdtempSync(join(tmpdir(), 'sales-fallback-'));
let db;
let counter = 0;

afterEach(() => db.close());

beforeEach(async () => {
  db = createClient({ url: `file:${join(dir, `t${++counter}.db`)}` });
  await db.batch([
    `CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, movement TEXT, account TEXT, euros REAL, mcf_user TEXT, date_real TEXT)`,
    `CREATE TABLE sales_detail (id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT, yyyy INTEGER, mm INTEGER, property TEXT, euro REAL)`,
    `INSERT INTO sales (euros, mcf_user, date_real) VALUES (100, 'local-usera', '2026-11-03'), (50, 'local-usera', '2026-11-05'), (70, 'local-hortaleza', '2026-11-04')`,
  ], 'write');
});

test('a store with daily detail does not hide the store still waiting for its PDF', async () => {
  await db.execute(`INSERT INTO sales_detail (company, yyyy, mm, property, euro) VALUES ('mcf', 2026, 11, 'hortaleza', 70)`);
  const r = await storesOnSalesOnly(db, 2026, 11);
  assert.deepEqual(r, [{ store: 'usera', total: 150, max_day: '2026-11-05' }]);
});

test('with no detail at all, both stores come from sales', async () => {
  const r = await storesOnSalesOnly(db, 2026, 11);
  assert.deepEqual(r.map(s => s.store), ['usera', 'hortaleza']);
});

test('with detail for both, nothing comes from sales', async () => {
  await db.execute(`INSERT INTO sales_detail (company, yyyy, mm, property, euro) VALUES ('mcf', 2026, 11, 'hortaleza', 70), ('mcf', 2026, 11, 'usera', 150)`);
  assert.deepEqual(await storesOnSalesOnly(db, 2026, 11), []);
});

test('one store in scope looks only at that store', async () => {
  await db.execute(`INSERT INTO sales_detail (company, yyyy, mm, property, euro) VALUES ('mcf', 2026, 11, 'hortaleza', 70)`);
  assert.deepEqual(await storesOnSalesOnly(db, 2026, 11, 'hortaleza'), []);
  assert.deepEqual((await storesOnSalesOnly(db, 2026, 11, 'usera')).map(s => s.store), ['usera']);
});

test('detail from before MCF owned the store does not count', async () => {
  await db.execute(`INSERT INTO sales_detail (company, yyyy, mm, property, euro) VALUES ('cesar', 2026, 11, 'hortaleza', 70)`);
  assert.ok((await storesOnSalesOnly(db, 2026, 11)).some(s => s.store === 'hortaleza'));
});

test('a store with neither is simply absent', async () => {
  assert.deepEqual(await storesOnSalesOnly(db, 2026, 3), []);
});

test('the year view decides store by store', () => {
  const has = detailIndex([{ property: 'hortaleza', mm: 11 }, { property: 'usera', mm: 10 }]);
  assert.equal(has('hortaleza', 11), true);
  assert.equal(has('usera', 11), false);
  assert.equal(has('usera', 10), true);
  assert.equal(has('hortaleza', 10), false);
});
