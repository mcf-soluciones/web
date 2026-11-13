import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { denominationDescription, detailRow, salesMovement, saleProblem } from '../../api/_lib/kiosk-mapping.js';

const products = JSON.parse(readFileSync(new URL('./products-hortaleza.json', import.meta.url), 'utf8'));

function sale(over = {}) {
  return {
    id: 'a1', receipt_no: 'K1-260801-0004', kind: 'machine', machine: 'SECADORA 7', method: 'bank', status: 'completed',
    cycles: 3, price_cents: 600, created_at: '2026-08-01 18:36:06.123', updated_at: '2026-08-01 18:36:40.000', ...over,
  };
}

test('matches a real row from the old pipeline, apart from movid', () => {
  // parsed/hortaleza_2026-08.csv: 011012608010004E,2026-08-01,2026,8,1,18:36:06,18,36,TARJETA BANCO,SECADORA 7,6.0,mcf,Saturday,cesar1,hortaleza
  assert.deepEqual(detailRow(sale()), {
    movid: 'K1-260801-0004', date: '2026-08-01', yyyy: 2026, mm: 8, dd: 1, time: '18:36:06', hr: 18, min: 36,
    payment: 'TARJETA BANCO', product: 'SECADORA 7', euro: 6, dayweek: 'Saturday',
  });
});

test('payments and products use the exact labels the reports filter on', () => {
  assert.equal(detailRow(sale({ method: 'cash' })).payment, 'EFECTIVO');
  assert.equal(detailRow(sale({ method: 'card' })).payment, 'TARJETA CLIENTE');
  assert.equal(detailRow(sale({ kind: 'topup', machine: '' })).product, 'RECARGA');
  assert.equal(detailRow(sale({ kind: 'card', machine: '' })).product, 'TARJETA');
});

test('weekday comes from the date text, whatever the server time zone', () => {
  const saved = process.env.TZ;
  for (const tz of ['UTC', 'Pacific/Auckland', 'America/Los_Angeles']) {
    process.env.TZ = tz;
    assert.equal(detailRow(sale({ created_at: '2026-11-08 23:59:59.000' })).dayweek, 'Sunday');
    assert.equal(detailRow(sale({ created_at: '2026-11-09 00:00:00.000' })).dayweek, 'Monday');
  }
  process.env.TZ = saved;
});

test('sales label matches what reconcile.py parses', () => {
  const label = salesMovement('2026-11-04', '223501', 'cash');
  assert.equal(label, 'VentasDia041126_223501 [cash]');
  assert.match(label, /VentasDia\d{6}_(\d{6})/);
});

test('movements text is identical to the website form', () => {
  assert.equal(
    denominationDescription({ b20e: 2, b10e: 1, b5e: 5 }),
    'Count de billetes: 20e = 2, 10e = 1, 5e = 5 - Count de Monedas: 2e = 0, 1e = 0, 0.50e = 0, 0.20e = 0, 0.10e = 0, 0.05e = 0',
  );
});

test('bad sales are refused with a reason', () => {
  assert.match(saleProblem(sale({ method: 'bitcoin' })), /method/);
  assert.match(saleProblem(sale({ price_cents: 2.5 })), /price_cents/);
  assert.match(saleProblem(sale({ created_at: 'ayer' })), /created_at/);
  assert.match(saleProblem(sale({ receipt_no: '' })), /receipt/);
  assert.equal(saleProblem(sale()), null);
});

// The kiosk's price table (kiosk-app/package/appsettings.json): cash and customer-card price per wash or per dryer cycle.
const WASHERS = { 'LAVADORA 1': [500, 450], 'LAVADORA 2': [500, 450], 'LAVADORA 3': [700, 630], 'LAVADORA 4': [800, 720] };
const DRYERS = { 'SECADORA 5': [[250, 225], [200, 200]], 'SECADORA 6': [[250, 225]], 'SECADORA 7': [[200, 180]] };
const MAX_CYCLES = 5;

function chargeable() {
  const keys = [];
  for (const [machine, prices] of Object.entries(WASHERS)) for (const c of prices) keys.push([machine, c]);
  for (const [machine, windows] of Object.entries(DRYERS)) {
    for (const prices of windows) for (const c of prices) for (let n = 1; n <= MAX_CYCLES; n++) keys.push([machine, c * n]);
  }
  return keys;
}

// The rows scripts/kiosk-seed-products.js adds for SECADORA 5 at 2.00 per cycle after 21:15.
const SEEDED = [['SECADORA 5', 2], ['SECADORA 5', 4], ['SECADORA 5', 6], ['SECADORA 5', 8]];

test('every price the kiosk can charge finds its products row', () => {
  const have = new Set(products.map(p => `${p.product}|${p.precio}`));
  for (const [product, precio] of SEEDED) have.add(`${product}|${precio}`);
  const missing = chargeable()
    .filter(([machine, cents]) => !have.has(`${machine}|${detailRow(sale({ machine, price_cents: cents })).euro}`))
    .map(([machine, cents]) => `${machine} ${cents}`);
  assert.deepEqual(missing, []);
});

test('the seed rows are exactly what is missing today', () => {
  const have = new Set(products.map(p => `${p.product}|${p.precio}`));
  const missing = new Set(chargeable().map(([m, c]) => [m, c / 100]).filter(([m, e]) => !have.has(`${m}|${e}`)).map(([m, e]) => `${m}|${e}`));
  assert.deepEqual([...missing].sort(), SEEDED.map(([m, e]) => `${m}|${e}`).sort());
});
