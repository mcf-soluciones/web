import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { createClient } from '@libsql/client';
import XLSX from 'xlsx';
import { signIn, signInAccountant } from '../../api/_lib/web-auth.js';
import { esMexico, hermanaDe, sinMexico } from '../../api/_lib/sucursales.js';
import { canonicalizePropiedad } from '../../api/_lib/propiedad.js';

// Set before any route loads its database client, so nothing here can reach production.
const dir = mkdtempSync(join(tmpdir(), 'mexico-'));
const url = `file:${join(dir, 'mexico.db').replace(/\\/g, '/')}`;
process.env.TURSO_DATABASE_URL = url;
process.env.TURSO_AUTH_TOKEN = '';
process.env.MCF_SESSION_SECRET = 'test-secret';
process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON = '{}'; // never used: no fixture Spain row has a factura

const API = fileURLToPath(new URL('../../api/', import.meta.url));
const db = createClient({ url });
const load = name => import(pathToFileURL(join(API, `${name}.js`)).href);

// The live tables' shapes, for the columns these reports read.
const TABLES = [
  `CREATE TABLE movements (id INTEGER PRIMARY KEY AUTOINCREMENT, movement TEXT NOT NULL, type TEXT NOT NULL, account TEXT DEFAULT 'cash', euros REAL NOT NULL DEFAULT 0, propiedad TEXT, mcf_user TEXT, date_real TEXT NOT NULL, description TEXT, icon TEXT, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, visit_id TEXT, mcf_user TEXT, propiedad TEXT, fecha TEXT, limpieza_general REAL, limpieza_maquinas REAL, limpieza_basura REAL, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, date TEXT, propiedad TEXT, location TEXT, jabon REAL DEFAULT 0, suavizante REAL DEFAULT 0, oxigeno REAL DEFAULT 0, visit_id_ref TEXT, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, movement TEXT NOT NULL DEFAULT 'venta', type TEXT DEFAULT 'venta', account TEXT, euros REAL NOT NULL DEFAULT 0, mcf_user TEXT, date_real TEXT NOT NULL)`,
  `CREATE TABLE gastos (id INTEGER PRIMARY KEY AUTOINCREMENT, concepto_text TEXT NOT NULL DEFAULT 'x', user_name TEXT, concepto_mcf TEXT, currency TEXT DEFAULT 'EUR', cuenta TEXT, concepto_proveedor TEXT, num_factura TEXT, nif_proveedor TEXT, razon_social TEXT, concepto_banco TEXT, gasto REAL DEFAULT 0, importe_iva REAL DEFAULT 0, importe_irpf REAL DEFAULT 0, importe_otro REAL DEFAULT 0, recibo_url TEXT, is_fiscal INTEGER DEFAULT 0, created_at TEXT DEFAULT '2026-01-01', categoria_gastos_mcf TEXT, es_inversion TEXT DEFAULT 'No', fecha TEXT, mm INTEGER, yyyy INTEGER, importe_total REAL, propiedad TEXT, sheet_row_id TEXT, bank_movement_hash TEXT, loan_id INTEGER, loan_payment_interest REAL, loan_payment_principal REAL)`,
  `CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, product TEXT NOT NULL, precio REAL NOT NULL, capacidad TEXT, product_price TEXT, product_size TEXT, product_mins INTEGER DEFAULT 0, product_mission TEXT, subproducto TEXT, price_list TEXT NOT NULL, property TEXT NOT NULL)`,
  `CREATE TABLE sales_detail (id INTEGER PRIMARY KEY AUTOINCREMENT, movid TEXT NOT NULL, date TEXT NOT NULL, yyyy INTEGER NOT NULL, mm INTEGER NOT NULL, dd INTEGER NOT NULL, time TEXT, hr INTEGER, min INTEGER, payment TEXT, product TEXT, euro REAL DEFAULT 0, company TEXT, dayweek TEXT, price_list TEXT, property TEXT)`,
  `CREATE TABLE catalogo_cuentas (cuenta_mcf TEXT PRIMARY KEY, categoria_gastos_mcf TEXT, desc TEXT, tooltip TEXT, propiedad TEXT)`,
  `CREATE TABLE property_activation (property TEXT PRIMARY KEY, start_date TEXT NOT NULL, label TEXT, notes TEXT)`,
  `CREATE TABLE loans (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, lender TEXT, principal_original REAL NOT NULL, start_date TEXT NOT NULL, term_months INTEGER, interest_rate REAL, status TEXT DEFAULT 'active', propiedad TEXT, notes TEXT, recibo_url TEXT)`,
  `CREATE TABLE financing_events (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL, mm INTEGER NOT NULL, yyyy INTEGER NOT NULL, event_type TEXT NOT NULL, euros REAL NOT NULL, loan_id INTEGER, counterparty TEXT, notes TEXT)`,
  `CREATE TABLE bs_lines (code TEXT PRIMARY KEY, section TEXT NOT NULL, label TEXT NOT NULL, sort_order INTEGER DEFAULT 0, description TEXT, is_contra INTEGER DEFAULT 0, is_derivable INTEGER DEFAULT 0, derivation_note TEXT, subsection TEXT, subgroup TEXT)`,
  `CREATE TABLE bs_opening_balances (line_code TEXT PRIMARY KEY, amount REAL NOT NULL DEFAULT 0, as_of_date TEXT NOT NULL, notes TEXT)`,
  `CREATE TABLE bs_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, yyyy INTEGER NOT NULL, mm INTEGER NOT NULL, line_code TEXT NOT NULL, amount REAL NOT NULL, notes TEXT, user_name TEXT, updated_at TEXT)`,
  `CREATE TABLE bs_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, as_of_date TEXT NOT NULL, yyyy INTEGER NOT NULL, mm INTEGER NOT NULL, name TEXT, notes TEXT, created_by TEXT, mode TEXT DEFAULT 'manual')`,
  `CREATE TABLE bs_snapshot_lines (snapshot_id INTEGER NOT NULL, line_code TEXT NOT NULL, amount REAL NOT NULL, PRIMARY KEY (snapshot_id, line_code))`,
  `CREATE TABLE tax_settlements (yyyy INTEGER PRIMARY KEY, actual_is REAL NOT NULL, year_profit_base REAL NOT NULL, notes TEXT, filed_at TEXT, updated_at TEXT)`,
];

const FIXTURE_TABLES = ['gastos', 'sales', 'sales_detail', 'products', 'movements'];

const gasto = (propiedad, cuenta, importe, extra = {}) => db.execute({
  sql: `INSERT INTO gastos (propiedad, cuenta, importe_total, importe_iva, is_fiscal, es_inversion, fecha, mm, yyyy, recibo_url, categoria_gastos_mcf)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  args: [propiedad, cuenta, importe, extra.iva ?? 0, extra.fiscal ?? 1, extra.inversion ?? 'No', extra.fecha ?? '2026-10-05', extra.mm ?? 10, extra.yyyy ?? 2026, extra.recibo ?? null, extra.categoria ?? 'Fijos'],
});

let movid = 0;
const venta = (company, property, product, euro, { date = '2026-10-05', payment = 'EFECTIVO', priceList = 'lista' } = {}) => db.execute({
  sql: `INSERT INTO sales_detail (movid, date, yyyy, mm, dd, payment, product, euro, company, price_list, property) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  args: [`T${++movid}`, date, Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)), payment, product, euro, company, priceList, property],
});

const producto = (product, precio, property, mission = 'LAVAR') => db.execute({
  sql: `INSERT INTO products (product, precio, product_price, product_size, product_mins, product_mission, price_list, property) VALUES (?, ?, 'normal', 'M', 30, ?, 'lista', ?)`,
  args: [product, precio, mission, property],
});

async function seedSpain() {
  await gasto('(001) Usera', 'C1', 500, { iva: 105 });
  await gasto('(002) Hortaleza', 'C2', 400, { iva: 84 });
  await gasto('Corporate', 'J1', 100, { iva: 21 });
  await gasto('Corporate', 'N1', 50, { categoria: 'Impuestos' });
  await gasto(null, 'J1', 10); // no propiedad: it stays Spain's
  await gasto('USERA', 'E1', 30, { categoria: 'Variables' }); // an old spelling
  await gasto('(001) Usera', 'Z1', 1000, { inversion: 'Si', categoria: 'Adquisición o Inversiones' });
  await venta('mcf', 'usera', 'LAVADORA 1', 5);
  await venta('mcf', 'usera', 'LAVADORA 1', 5, { payment: 'BANCO' });
  await venta('mcf', 'usera', 'LAVADORA 1', 5, { payment: 'TARJETA CLIENTE' });
  await venta('mcf', 'hortaleza', 'SECADORA 1', 4);
  await venta('mcf', 'usera', 'LAVADORA 1', 5, { date: '2025-10-05' });
  await producto('LAVADORA 1', 5, 'usera');
  await producto('SECADORA 1', 4, 'hortaleza', 'SECAR');
  await db.execute(`INSERT INTO sales (account, euros, mcf_user, date_real) VALUES ('cash', 100, 'local-usera', '2026-10-05'), ('banco', 80, 'local-hortaleza', '2026-10-05')`);
}

async function seedMexico() {
  await gasto('(003) Monterrey', 'C3', 200, { iva: 32, fiscal: 1, recibo: 'https://drive.google.com/file/d/mexico/view' });
  await gasto('monterrey', 'E3', 20, { categoria: 'Variables' }); // loaded by hand, spelled differently
  await gasto('(004) CDMX', 'C4', 90);
  await gasto('(003) Monterrey', 'Z3', 5000, { inversion: 'Si', categoria: 'Adquisición o Inversiones' });
  await venta('mcf_mx', 'monterrey', 'MTY LAVADORA 1', 4.2);
  await venta('mcf_mx', 'monterrey', 'MTY LAVADORA 1', 4.2, { payment: 'BANCO' });
  await venta('mcf_mx', 'monterrey', 'MTY LAVADORA 1', 4.2, { payment: 'TARJETA CLIENTE' });
  await venta('mcf_mx', 'cdmx', 'CDMX SECADORA 1', 3.1);
  await producto('MTY LAVADORA 1', 4.2, 'monterrey');
  await producto('CDMX SECADORA 1', 3.1, 'cdmx', 'SECAR');
}

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(o) { this.body = o; return this; },
    end(o) { this.body = o; return this; },
  };
}

function cookieFor(signInFn) {
  const res = fakeRes();
  signInFn(res);
  return { cookie: [res.headers['set-cookie']].flat().map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ') };
}
const owner = () => cookieFor(res => signIn({ headers: {} }, res, 'lalo', { reports: true }));
const accountant = () => cookieFor(res => signInAccountant({ headers: {} }, res, 'contadora'));

async function get(name, query, headers = owner()) {
  const res = fakeRes();
  await (await load(name)).default({ method: 'GET', headers, query }, res);
  assert.equal(res.statusCode, 200, `${name} ${JSON.stringify(query)}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function post(name, body, headers = owner()) {
  const res = fakeRes();
  await (await load(name)).default({ method: 'POST', headers, query: {}, body }, res);
  return res;
}

// The workbook inside the monthly ZIP, as { sheet: rows }, plus the names of everything in the ZIP.
async function exportMonth(headers = owner()) {
  const chunks = [];
  const res = new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); } });
  res.setHeader = () => res;
  res.status = () => res;
  res.json = o => { throw new Error(JSON.stringify(o)); };
  const finished = new Promise(resolve => res.on('finish', resolve));
  await (await load('export/month')).default({ method: 'GET', headers, query: { mm: '10', yyyy: '2026' } }, res);
  await finished;

  const zip = Buffer.concat(chunks);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    entries.push({ name: zip.toString('utf8', at + 46, at + 46 + nameLength), data: zip.subarray(dataAt, dataAt + zip.readUInt32LE(at + 20)) });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  const book = XLSX.read(inflateRawSync(entries.find(e => e.name.endsWith('.xlsx')).data));
  const sheets = Object.fromEntries(book.SheetNames.map(n => [n, XLSX.utils.sheet_to_json(book.Sheets[n], { header: 1 })]));
  return { sheets, names: entries.map(e => e.name) };
}

async function spainReports() {
  const out = {};
  for (const scope of ['mcf', 'usera', 'hortaleza']) out[`pnl ${scope}`] = await get('reports/pnl', { mm: '10', yyyy: '2026', scope });
  out.cashflow = await get('reports/cashflow', { mm: '10', yyyy: '2026' });
  out.balance = await get('balance-sheet/timeseries', { yyyy: '2026' });
  out.baseline = await get('projections/baseline', { yyyy_mm: '2026-10' });
  out.gastos = await get('gastos/list', { mm: '10', yyyy: '2026' });
  out.detail = await get('reports/gastos-detail', { cuenta: 'C1', yyyy: '2026' });
  out.zip = (await exportMonth()).sheets;
  return out;
}

const close = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-9, `${label}: ${a} vs ${b}`);

before(async () => {
  assert.ok(process.env.TURSO_DATABASE_URL.startsWith('file:'));
  for (const sql of TABLES) await db.execute(sql);
  await db.execute(`INSERT INTO bs_lines (code, section, label) VALUES ('A-C-7', 'assets', 'Efectivo'), ('A-NC-2', 'assets', 'Inmovilizado')`);
  await db.execute(`INSERT INTO property_activation (property, start_date, label) VALUES ('usera', '2020-01-01', '(001) Usera'), ('hortaleza', '2025-08-01', '(002) Hortaleza')`);
  await db.batch([
    ['C1', 'Fijos', 'Alquiler (C)', '(001) Usera'], ['C2', 'Fijos', 'Alquiler (C)', '(002) Hortaleza'],
    ['C3', 'Fijos', 'Alquiler (C)', '(003) Monterrey'], ['C4', 'Fijos', 'Alquiler (C)', '(004) CDMX'],
    ['J1', 'Fijos', 'Operaciones (J)', 'Corporate'], ['N1', 'Impuestos', 'Autonomo', 'Corporate'],
    ['E1', 'Variables', 'Agua, Luz (E)', '(001) Usera'], ['E2', 'Variables', 'Agua, Luz (E)', '(002) Hortaleza'],
    ['E3', 'Variables', 'Agua, Luz (E)', '(003) Monterrey'], ['E10', 'Variables', 'Agua, Luz (E)', '(004) CDMX'],
    ['E4', 'Variables', 'Gas (E)', '(001) Usera'], ['G3', 'Fijos', 'Internet (G)', '(003) Monterrey'],
  ].map(args => ({ sql: `INSERT INTO catalogo_cuentas (cuenta_mcf, categoria_gastos_mcf, desc, propiedad) VALUES (?, ?, ?, ?)`, args })), 'write');
});

beforeEach(async () => {
  for (const t of FIXTURE_TABLES) await db.execute(`DELETE FROM ${t}`);
  await db.execute('DELETE FROM tax_settlements');
  await seedSpain();
});

test('every Spain report gives the same answer with Mexico in the database', async () => {
  const without = await spainReports();
  await seedMexico();
  assert.deepEqual(await spainReports(), without);
});

test('the tax base stays Spain only, so a closed year still adds up to the tax actually paid', async () => {
  const { computeYearProfitBase } = await load('reports/pnl');
  await venta('mcf', 'usera', 'LAVADORA 1', 5000); // a profit, so there is a base to allocate
  const base = await computeYearProfitBase(2026);
  assert.ok(base > 0);
  await seedMexico();
  assert.equal(await computeYearProfitBase(2026), base);

  await db.execute({ sql: `INSERT INTO tax_settlements (yyyy, actual_is, year_profit_base) VALUES (2026, 300, ?)`, args: [base] });
  const { year } = await get('reports/pnl', { mm: '12', yyyy: '2026', mexico: '1' });
  const n8a = year.sections.find(s => s.key === 'Impuestos').subsections.find(s => s.key === 'II').items.find(i => i.code === 'N8a');
  close(Object.values(n8a.by_month).reduce((a, b) => a + b, 0), 300, 'N8a over the year');
});

const splitOf = (pnl, sectionKey, key) => pnl.year.sections.find(s => s.key === sectionKey).subsections.find(s => s.key === key);
const rowsOf = split => split.items.map(i => `${i.code} ${i.property_label}`);
const rowIn = (split, code) => split.items.find(i => i.code === code);

test('with mexico=1 the stores join the same rows as any other, below them, and the totals follow', async () => {
  await seedMexico();
  const spain = await get('reports/pnl', { mm: '10', yyyy: '2026' });
  assert.equal(spain.con_mexico, undefined);
  assert.equal(JSON.stringify(spain).toLowerCase().includes('monterrey'), false);

  const con = await get('reports/pnl', { mm: '10', yyyy: '2026', mexico: '1' });
  assert.equal(con.con_mexico, true);

  const ventas = splitOf(con, 'Ingresos', 'A');
  assert.deepEqual(rowsOf(ventas), ['A1 (001) Usera', 'A2 (002) Hortaleza', 'A3 (003) Monterrey', 'A4 (004) CDMX']);
  close(rowIn(ventas, 'A3').by_month[10], 8.4, 'sales leave out tarjeta cliente');
  close(rowIn(ventas, 'A4').by_month[10], 3.1, 'cdmx sales');

  const alquiler = splitOf(con, 'Gastos', 'C');
  assert.deepEqual(rowsOf(alquiler), ['C1 (001) Usera', 'C2 (002) Hortaleza', 'C3 (003) Monterrey', 'C4 (004) CDMX']);
  close(rowIn(alquiler, 'C3').by_month[10], 200, 'gross, though the row has IVA');
  assert.equal(rowIn(alquiler, 'C3').iva_ytd, 0);
  close(rowIn(splitOf(con, 'Gastos', 'E'), 'E3').by_month[10], 20, 'a hand-typed spelling lands on the store');
  assert.equal(rowsOf(splitOf(con, 'Gastos', 'E')).includes('E3 (003) Monterrey'), true);
  assert.equal(JSON.stringify(con).includes('Z3'), false, 'capex stays out');

  // Every Spanish row is untouched, and so are the taxes.
  for (const section of spain.year.sections) for (const sub of section.subsections) for (const item of sub.items) {
    assert.deepEqual(splitOf(con, section.key, sub.key).items.find(i => i.code === item.code && i.property_label === item.property_label), item);
  }
  assert.deepEqual(con.year.sections.find(s => s.key === 'Impuestos'), spain.year.sections.find(s => s.key === 'Impuestos'));

  // The added rows add up, at every level.
  const ventasMx = 8.4 + 3.1;
  const gastosMx = 220 + 90;
  for (const sub of con.year.sections.flatMap(s => s.subsections)) {
    close(sub.items.reduce((total, i) => total + i.by_month[10], 0), sub.by_month[10], `${sub.key} adds up`);
  }
  const total = (pnl, key) => pnl.year.sections.find(s => s.key === key);
  close(total(con, 'Ingresos').by_month[10], total(spain, 'Ingresos').by_month[10] + ventasMx, 'ingresos');
  close(total(con, 'Gastos').by_month[10], total(spain, 'Gastos').by_month[10] + gastosMx, 'gastos');
  close(total(con, 'Gastos').ytd, total(spain, 'Gastos').ytd + gastosMx, 'gastos ytd');
  close(con.year.ebitda.by_month[10], spain.year.ebitda.by_month[10] + ventasMx - gastosMx, 'ebitda');
  close(con.year.neto.by_month[10], spain.year.neto.by_month[10] + ventasMx - gastosMx, 'neto');
  close(con.year.neto.ytd, spain.year.neto.ytd + ventasMx - gastosMx, 'neto ytd');
  close(con.year.neto.margin_pct_by_month[10], con.year.neto.by_month[10] / total(con, 'Ingresos').by_month[10], 'margin uses the larger sales');

  // The cards say what the table says, and IVA is still only Spain's.
  close(con.topline.revenue, total(con, 'Ingresos').by_month[10], 'revenue card');
  close(con.margins.total_gastos_op, spain.margins.total_gastos_op + gastosMx, 'gastos card');
  close(con.margins.ebitda, con.year.ebitda.by_month[10], 'ebitda card');
  close(con.margins.net_income, con.year.neto.by_month[10], 'net income card');
  assert.equal(con.margins.iva_cobrado, spain.margins.iva_cobrado);
  assert.equal(con.margins.iva_pagado_deducible, spain.margins.iva_pagado_deducible);
  assert.equal(con.margins.impuestos_n8, spain.margins.impuestos_n8);
});

test('a concept keeps its rows together, each store below the others, even with text-sorted codes like E10', async () => {
  await gasto('(004) CDMX', 'E10', 1);
  await gasto('(003) Monterrey', 'E3', 1);
  await gasto('(002) Hortaleza', 'E2', 1);
  await gasto('(001) Usera', 'E4', 1);
  const con = await get('reports/pnl', { mm: '10', yyyy: '2026', mexico: '1' });
  assert.deepEqual(splitOf(con, 'Gastos', 'E').items.map(i => i.code), ['E1', 'E2', 'E3', 'E10', 'E4']);
});

test('a split only Mexico has still appears, in its place', async () => {
  await gasto('(003) Monterrey', 'G3', 12);
  const con = await get('reports/pnl', { mm: '10', yyyy: '2026', mexico: '1' });
  const gastos = con.year.sections.find(s => s.key === 'Gastos').subsections.map(s => s.key);
  assert.deepEqual(gastos, ['C', 'E', 'G', 'J']);
  close(splitOf(con, 'Gastos', 'G').ytd, 12, 'its total');
  assert.equal(splitOf(con, 'Gastos', 'G').items[0].label, 'Internet (G) — (003) Monterrey');
});

test('a Mexican row opens its Detalle for an owner asking, and for nobody else', async () => {
  await seedMexico();
  const asked = await get('reports/gastos-detail', { cuenta: 'C3', yyyy: '2026', mexico: '1' });
  assert.equal(asked.count, 1);
  close(asked.total, 200, 'the row');
  assert.equal(asked.catalog.desc, 'Alquiler (C)');

  assert.equal((await get('reports/gastos-detail', { cuenta: 'C3', yyyy: '2026' })).count, 0);
  const hers = await get('reports/gastos-detail', { cuenta: 'C3', yyyy: '2026', mexico: '1' }, accountant());
  assert.equal(hers.count, 0);
  assert.equal(hers.catalog, null);
});

test('a store view never includes Mexico, even if asked', async () => {
  await seedMexico();
  const usera = await get('reports/pnl', { mm: '10', yyyy: '2026', scope: 'usera', mexico: '1' });
  assert.equal(usera.con_mexico, undefined);
  assert.equal(JSON.stringify(usera).toLowerCase().includes('monterrey'), false);
});

test('Mexican sales under a property we do not know still count, under their own name, below the others', async () => {
  await venta('mcf_mx', 'guadalajara', 'GDL LAVADORA 1', 7);
  const con = await get('reports/pnl', { mm: '10', yyyy: '2026', mexico: '1' });
  const spain = await get('reports/pnl', { mm: '10', yyyy: '2026' });
  const ventas = splitOf(con, 'Ingresos', 'A');
  assert.equal(ventas.items.at(-1).label, 'Ventas (Core) — guadalajara');
  close(ventas.items.at(-1).by_month[10], 7, 'unknown store');
  close(con.year.neto.by_month[10], spain.year.neto.by_month[10] + 7, 'counted in the total');
});

test('the accountant never gets Mexico, even if she asks for it', async () => {
  await seedMexico();
  const headers = accountant();
  const pnl = await get('reports/pnl', { mm: '10', yyyy: '2026', mexico: '1' }, headers);
  assert.equal(pnl.con_mexico, undefined);
  assert.equal(JSON.stringify(pnl).toLowerCase().includes('monterrey'), false);

  const list = await get('gastos/list', { mm: '10', yyyy: '2026', mexico: '1' }, headers);
  assert.ok(list.rows.length > 0);
  assert.equal(list.rows.filter(r => esMexico(r.propiedad)).length, 0);

  const detail = await get('reports/gastos-detail', { cuenta: 'C3', yyyy: '2026' }, headers);
  assert.equal(detail.count, 0);
  assert.equal(detail.catalog, null, 'the catalog row would name the store');

  const catalog = await get('gastos/catalog', {}, headers);
  assert.equal(catalog.rows.filter(r => esMexico(r.propiedad)).length, 0);
  assert.equal(Object.keys(catalog.by_propiedad).filter(esMexico).length, 0);

  const { sheets, names } = await exportMonth(headers);
  assert.equal(JSON.stringify(sheets).toLowerCase().includes('monterrey'), false);
  assert.equal(names.filter(n => n.startsWith('facturas/')).length, 0);
});

test('an owner sees Mexico in gastos and the catalog only when asking, and totals follow', async () => {
  await seedMexico();
  const spain = await get('gastos/list', { mm: '10', yyyy: '2026' });
  assert.equal(spain.rows.filter(r => esMexico(r.propiedad)).length, 0);

  const all = await get('gastos/list', { mm: '10', yyyy: '2026', mexico: '1' });
  assert.equal(all.rows.filter(r => esMexico(r.propiedad)).length, 4);
  close(all.total_operativo, spain.total_operativo + 310, 'operating total');
  close(all.total_inversion, spain.total_inversion + 5000, 'capex total');

  assert.ok((await get('gastos/catalog', {})).by_propiedad['(003) Monterrey']);
});

test('the Inversión calculator models a new store on Monterrey\'s cuentas, without its name or its amounts', async () => {
  await seedMexico();
  const baseline = await get('projections/baseline', { yyyy_mm: '2026-10' });
  const { catalog, expenses_by_cuenta } = baseline.pnl;
  assert.ok(catalog.C1);
  assert.equal(catalog.C3.propiedad, 'Sucursal nueva');
  assert.equal(catalog.C3.desc, 'Alquiler (C)');
  assert.equal(catalog.C4, undefined);
  assert.equal(expenses_by_cuenta.C3, undefined);
  assert.equal(JSON.stringify(baseline).toLowerCase().includes('monterrey'), false);

  const payload = { kind: 'new_sucursal', new_sucursales: [{ name: 'Alcorcón', annual_sales: 12000, cost_lines: [{ cuenta: 'C3', monthly: 100 }] }] };
  const computed = await post('projections/compute', { baseline_yyyy_mm: '2026-10', payload });
  assert.equal(computed.statusCode, 200, JSON.stringify(computed.body));
  const line = computed.body.result.pnl.by_cuenta.find(l => l.cuenta === 'C3');
  assert.equal(line.label, 'Alquiler (C) — Sucursal nueva');
  assert.ok(line.projected.every(v => v > 0), JSON.stringify(line.projected));
});

test('the Hub stays Spain only', async () => {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-05`;
  await venta('mcf', 'usera', 'LAVADORA 1', 5, { date });
  const without = await get('hub', {});
  await venta('mcf_mx', 'monterrey', 'MTY LAVADORA 1', 4.2, { date });
  assert.deepEqual(await get('hub', {}), without);
});

test('in the Resumen each Mexican store is added to its sister, keeping its machines apart', async () => {
  await seedMexico();
  const monthly = await get('reports/monthly', { mm: '10', yyyy: '2026' });
  const rows = monthly.this.rows;
  assert.deepEqual([...new Set(rows.map(r => r.property))].sort(), ['hortaleza', 'usera']);

  const sum = (property, realStore) => rows
    .filter(r => r.property === property && (!realStore || r.sucursal_real === realStore))
    .reduce((s, r) => s + Number(r.euro), 0);
  close(sum('usera'), 15 + 12.6, 'usera + monterrey');
  close(sum('usera', 'monterrey'), 12.6, 'what monterrey brought');
  close(sum('hortaleza'), 4 + 3.1, 'hortaleza + cdmx');

  // Capacity counts distinct machine names, so both stores' machines must both be there, with their product data.
  const usera = rows.filter(r => r.property === 'usera');
  assert.deepEqual([...new Set(usera.map(r => r.product))].sort(), ['LAVADORA 1', 'MTY LAVADORA 1']);
  assert.equal(usera.find(r => r.product === 'MTY LAVADORA 1').product_mission, 'LAVAR');

  assert.deepEqual(monthly.sister_merge, [
    { store: 'usera', includes: '(003) Monterrey', yoy_comparable: false },
    { store: 'hortaleza', includes: '(004) CDMX', yoy_comparable: false },
  ]);
});

test('with no Mexico the Resumen is what it always was', async () => {
  const monthly = await get('reports/monthly', { mm: '10', yyyy: '2026' });
  assert.deepEqual(monthly.sister_merge, []);
  assert.ok(monthly.this.rows.every(r => r.sucursal_real === r.property));
});

test('Mexico cannot hide a month Spain is still missing: the headline comes from sales, sisters included', async () => {
  await db.execute(`INSERT INTO sales (account, euros, mcf_user, date_real) VALUES ('cash', 100, 'local-usera', '2026-11-03'), ('cash', 80, 'local-hortaleza', '2026-11-03')`);
  await venta('mcf_mx', 'monterrey', 'MTY LAVADORA 1', 4.2, { date: '2026-11-03' });
  await venta('mcf_mx', 'monterrey', 'MTY LAVADORA 1', 4.2, { date: '2026-11-03', payment: 'TARJETA CLIENTE' });
  const monthly = await get('reports/monthly', { mm: '11', yyyy: '2026' });
  assert.equal(monthly.preliminary, true);
  assert.deepEqual(monthly.this.rows, []);
  close(monthly.preliminary_totals.by_property.usera, 104.2, 'usera + monterrey');
  close(monthly.preliminary_totals.by_property.hortaleza, 80, 'hortaleza');
  close(monthly.preliminary_totals.total, 184.2, 'total');
});

test('a Mexican gasto stays out of Hub balances, and a Spanish one still counts', async () => {
  const session = cookieFor(res => signIn({ headers: {} }, res, 'lalo'));
  const mx = await post('gastos/create', { propiedad: 'monterrey', concepto_mcf: 'Alquiler (C)', importe_total: 50, fecha: '2026-10-06', mcf_user: 'lalo' }, session);
  assert.equal(mx.statusCode, 200, JSON.stringify(mx.body));
  assert.equal(mx.body.movement_id, null);
  const saved = (await db.execute({ sql: 'SELECT propiedad, cuenta FROM gastos WHERE id = ?', args: [mx.body.id] })).rows[0];
  assert.equal(saved.propiedad, '(003) Monterrey');
  assert.equal(saved.cuenta, 'C3');

  const es = await post('gastos/create', { propiedad: 'usera', concepto_mcf: 'Alquiler (C)', importe_total: 50, fecha: '2026-10-06', mcf_user: 'lalo' }, session);
  assert.ok(es.body.movement_id);
  assert.equal((await db.execute('SELECT COUNT(*) AS n FROM movements')).rows[0].n, 1);
});

test('a Mexican factura is refused until its own Drive folder is set, never filed with Spain', async () => {
  const session = cookieFor(res => signIn({ headers: {} }, res, 'lalo'));
  const file = { name: 'f.pdf', type: 'application/pdf', content: 'AAAA' };
  const created = await post('gastos/create', { propiedad: '(004) CDMX', importe_total: 50, fecha: '2026-10-06', file }, session);
  assert.equal(created.statusCode, 400);
  assert.equal((await db.execute(`SELECT COUNT(*) AS n FROM gastos WHERE propiedad = '(004) CDMX'`)).rows[0].n, 0);

  await seedMexico();
  const id = (await db.execute(`SELECT id FROM gastos WHERE propiedad = '(004) CDMX' LIMIT 1`)).rows[0].id;
  assert.equal((await post('gastos/factura', { id, file })).statusCode, 400);
});

test('store names and numbers resolve to the right label, and the old Compra TBC label to Monterrey', () => {
  for (const v of ['monterrey', 'Monterrey', '(003) Monterrey', '(003)', '(003) Compra TBC']) assert.equal(canonicalizePropiedad(v), '(003) Monterrey', v);
  for (const v of ['cdmx', 'CDMX', '(004) CDMX', '(004)']) assert.equal(canonicalizePropiedad(v), '(004) CDMX', v);
  assert.equal(canonicalizePropiedad('(001) Usera'), '(001) Usera');
  assert.equal(canonicalizePropiedad('Corporate'), 'Corporate');
});

test('sisters and spellings', () => {
  assert.equal(hermanaDe('monterrey'), 'usera');
  assert.equal(hermanaDe('cdmx'), 'hortaleza');
  assert.equal(hermanaDe('usera'), null);
  for (const v of ['(003) Monterrey', 'MONTERREY', '(004) CDMX', 'cdmx']) assert.equal(esMexico(v), true, v);
  for (const v of ['(001) Usera', 'Corporate', '', null, undefined]) assert.equal(esMexico(v), false, String(v));
});

test('the filter keeps rows with no propiedad, which belong to Spain', async () => {
  const rows = await db.execute(`SELECT propiedad FROM gastos WHERE ${sinMexico()}`);
  assert.ok(rows.rows.some(r => r.propiedad === null));
});

// Lookups by id and owner-only helpers. Everything else reading gastos is a Spain total, and must leave Mexico out.
const NOT_SPAIN_TOTALS = [
  'gastos/delete.js', 'gastos/duplicate.js', 'gastos/factura.js', 'gastos/update.js', // one row, by id, owners only
  'gastos/proveedores.js', 'gastos/suggest.js', // autocomplete for owners
  'financing/loans/delete.js', 'financing/loans/detail.js', 'financing/loans/list.js', // one loan's payments, owners only
];

test('every read of gastos leaves Mexico out, or is listed above on purpose', () => {
  const files = d => readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const path = join(d, e.name);
    if (e.isDirectory()) return files(path);
    return e.name.endsWith('.js') ? [path] : [];
  });
  const missing = [];
  const seen = new Set();
  for (const file of files(API)) {
    const name = relative(API, file).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/FROM\s+gastos\b/g)) {
      seen.add(name);
      if (NOT_SPAIN_TOTALS.includes(name)) continue;
      const statement = text.slice(m.index, text.indexOf('args', m.index));
      if (!statement.includes('sinMexico(')) missing.push(`${name}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(seen.has('reports/pnl.js') && seen.has('_lib/balance-sheet.js'), 'the check is looking in the right place');
  for (const name of NOT_SPAIN_TOTALS) assert.ok(seen.has(name), `${name} no longer reads gastos`);
});
