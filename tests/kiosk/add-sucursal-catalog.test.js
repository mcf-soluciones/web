import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const SCRIPT = fileURLToPath(new URL('../../scripts/add-sucursal-catalog.mjs', import.meta.url));
// A folder with no .env, so the script can only ever see this file database.
const folder = mkdtempSync(join(tmpdir(), 'add-sucursal-'));
const url = `file:${join(folder, 'catalog.db').replace(/\\/g, '/')}`;
const db = createClient({ url });

const HORTALEZA = {
  A2: ['Ventas', 'Ventas (Core)'], B2: ['Ventas', 'Ventas (Non-Core)'],
  C2: ['Fijos', 'Alquiler (C)'], D2: ['Fijos', 'Financiamiento (D)'],
  E2: ['Variables', 'Agua, Luz (E)'], E5: ['Variables', 'Gas (E)'], E8: ['Variables', 'Detergentes (E)'],
  F2: ['Variables', 'Articulos para Vending o Auxiliares (F)'], F5: ['Variables', 'Comissiones Bancarias (F)'],
  G2: ['Fijos', 'Internet (G)'], G5: ['Fijos', 'Seguro (G)'], G8: ['Fijos', 'Limpieza (G)'], G11: ['Fijos', 'Alarma (G)'],
  H2: ['Variables', 'Adquisición y Marketing (H)'], H5: ['Variables', 'Atención y Retornos (H)'],
  I2: ['Fijos', 'Mantenimiento de Maquinaria y Equipo (I)'],
  K2: ['Impuestos', 'IVA cobrado'], L3: ['Impuestos', 'IVA Pagado en gastos que hicimos'], M3: ['Margen', 'Margen'],
  O2: ['Virtuales', 'Depreciacion'], Z2: ['Adquisición o Inversiones', 'Adquisición o Inversiones'],
};
// The live catalog's other codes, which is what makes E4, F4, G4 and H4 unavailable.
const OTHERS = {
  '(001) Usera': 'A1 B1 C1 D1 E1 E4 E7 F1 F4 G1 G4 G7 G10 H1 H4 I1 K1 L2 M2 O1 Z1',
  '(003) Monterrey': 'A3 B3 C3 D3 E3 E6 E9 F3 F6 G3 G6 G9 G12 H3 H6 I3 K3 L4 M4 O3 Z3',
  Corporate: 'J1 J3 J4 J5 N1 N2 N3 N4 N5 J2 L1 M1 N6 N7 P1 Z4 N8',
};

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  cwd: folder,
  env: { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: '' },
  encoding: 'utf8',
});
const rowsOf = async label => (await db.execute({ sql: 'SELECT * FROM catalogo_cuentas WHERE propiedad = ? ORDER BY cuenta_mcf', args: [label] })).rows;
const everything = async () => JSON.stringify((await db.execute('SELECT * FROM catalogo_cuentas ORDER BY cuenta_mcf')).rows);
const everythingBut = async label => JSON.stringify((await db.execute({ sql: 'SELECT * FROM catalogo_cuentas WHERE propiedad <> ? ORDER BY cuenta_mcf', args: [label] })).rows);

beforeEach(async () => {
  await db.execute('DROP TABLE IF EXISTS catalogo_cuentas');
  await db.execute(`CREATE TABLE catalogo_cuentas (cuenta_mcf TEXT PRIMARY KEY, categoria_gastos_mcf TEXT, desc TEXT, tooltip TEXT, updated_at TEXT DEFAULT (datetime('now')), propiedad TEXT)`);
  const insert = 'INSERT INTO catalogo_cuentas (cuenta_mcf, categoria_gastos_mcf, desc, tooltip, propiedad) VALUES (?, ?, ?, ?, ?)';
  await db.batch(Object.entries(HORTALEZA).map(([code, [categoria, desc]]) => ({ sql: insert, args: [code, categoria, desc, `${desc} · (002) Hortaleza`, '(002) Hortaleza'] })), 'write');
  for (const [label, codes] of Object.entries(OTHERS)) {
    await db.batch(codes.split(' ').map(code => ({ sql: insert, args: [code, 'Fijos', code, code, label] })), 'write');
  }
});

test('a store gets the next free number of each letter, so nothing lands on another store\'s code', async () => {
  const before = await everything();
  const result = run('(004) CDMX');
  assert.equal(result.status, 0, result.stderr);

  const rows = await rowsOf('(004) CDMX');
  const code = desc => rows.find(r => r.desc === desc)?.cuenta_mcf;
  assert.deepEqual(rows.map(r => r.cuenta_mcf).sort(), 'C4 D4 E10 E11 E12 F7 F8 G13 G14 G15 G16 H7 H8 I4 O4 Z5'.split(' ').sort());
  assert.equal(code('Agua, Luz (E)'), 'E10');
  assert.equal(code('Gas (E)'), 'E11');
  assert.equal(code('Detergentes (E)'), 'E12');
  assert.equal(code('Alarma (G)'), 'G16');

  const alquiler = rows.find(r => r.cuenta_mcf === 'C4');
  assert.equal(alquiler.categoria_gastos_mcf, 'Fijos');
  assert.equal(alquiler.tooltip, 'Alquiler (C) · (004) CDMX');
  assert.equal(rows.find(r => r.cuenta_mcf === 'Z5').categoria_gastos_mcf, 'Adquisición o Inversiones');

  assert.equal(await everythingBut('(004) CDMX'), before, 'no existing row changed');
  assert.equal((await db.execute(`SELECT propiedad FROM catalogo_cuentas WHERE cuenta_mcf = 'E4'`)).rows[0].propiedad, '(001) Usera');
});

test('--full also adds the sales, IVA and margin rows', async () => {
  assert.equal(run('(005) Getafe', '--full').status, 0);
  const codes = (await rowsOf('(005) Getafe')).map(r => r.cuenta_mcf);
  assert.equal(codes.length, 21);
  for (const code of ['A4', 'B4', 'K4', 'L5', 'M5']) assert.ok(codes.includes(code), code);
});

test('--dry-run shows the codes and writes nothing', async () => {
  const before = await everything();
  const result = run('(004) CDMX', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /E10\s+Agua, Luz \(E\)/);
  assert.equal(await everything(), before);
});

test('running it twice adds nothing more', async () => {
  assert.equal(run('(004) CDMX').status, 0);
  const once = await everything();
  const again = run('(004) CDMX');
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already has 16 rows/);
  assert.equal(await everything(), once);
});

test('it refuses a number another store has, or a label with no number', async () => {
  const before = await everything();
  const taken = run('(003) Otra');
  assert.equal(taken.status, 1);
  assert.match(taken.stderr, /\(003\) Monterrey/);
  assert.equal(run('CDMX').status, 1);
  assert.equal(run().status, 1);
  assert.equal(await everything(), before);
});
