/**
 * Adds a store's rows to catalogo_cuentas, with Hortaleza's names and categories, so its gastos resolve to a cuenta.
 * A code is unique across all stores, so each row takes the next free number of its letter. Only the letter means
 * anything to the reports: it picks the P&L section, and Z marks capex.
 *
 * By default it adds the 16 spending concepts the gastos modal offers. --full also adds the sales, IVA and margin rows
 * (A, B, K, L, M), which only a store counted in Spain's numbers needs.
 *
 * Adds everything or nothing, and never changes an existing row. Safe to run twice.
 *
 * Usage:
 *   node scripts/add-sucursal-catalog.mjs "(004) CDMX" --dry-run     show the codes
 *   node scripts/add-sucursal-catalog.mjs "(004) CDMX" [--full]      add them
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';

const TEMPLATE = '(002) Hortaleza';
const NOT_ON_THE_FORM = /^[ABKLM]/;

const args = process.argv.slice(2);
const label = args.find(a => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const full = args.includes('--full');

if (!/^\(\d{3}\) \S/.test(label ?? '')) {
  console.error('Give the store\'s label, numbered like the others: node scripts/add-sucursal-catalog.mjs "(004) CDMX"');
  process.exit(1);
}

const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const all = (await db.execute('SELECT cuenta_mcf, categoria_gastos_mcf, desc, propiedad FROM catalogo_cuentas')).rows;

const own = all.filter(r => r.propiedad === label);
if (own.length > 0) {
  console.log(`${label} already has ${own.length} rows. Nothing was changed.`);
  process.exit(0);
}
const sameNumber = all.find(r => String(r.propiedad).startsWith(label.slice(0, 5)));
if (sameNumber) {
  console.error(`${label.slice(0, 5)} is already "${sameNumber.propiedad}". Nothing was changed.`);
  process.exit(1);
}

const parts = code => code.match(/^([A-Z])(\d+)/)?.slice(1) ?? [code, '0'];
const highest = {};
for (const { cuenta_mcf: code } of all) {
  const [letter, number] = parts(code);
  highest[letter] = Math.max(highest[letter] ?? 0, Number(number));
}

const template = all
  .filter(r => r.propiedad === TEMPLATE && (full || !NOT_ON_THE_FORM.test(r.cuenta_mcf)))
  .sort((a, b) => {
    const [la, na] = parts(a.cuenta_mcf);
    const [lb, nb] = parts(b.cuenta_mcf);
    return la.localeCompare(lb) || Number(na) - Number(nb);
  });
if (template.length === 0) {
  console.error(`No rows for ${TEMPLATE} to copy. Nothing was changed.`);
  process.exit(1);
}

const rows = template.map(r => {
  const [letter] = parts(r.cuenta_mcf);
  highest[letter] += 1;
  return { code: `${letter}${highest[letter]}`, categoria: r.categoria_gastos_mcf, desc: r.desc };
});
for (const r of rows) console.log(`${r.code.padEnd(4)} ${r.desc}`);

if (dryRun) {
  console.log(`\n--dry-run: ${rows.length} rows for ${label} were not added.`);
  process.exit(0);
}

await db.batch(rows.map(r => ({
  sql: 'INSERT INTO catalogo_cuentas (cuenta_mcf, categoria_gastos_mcf, desc, tooltip, propiedad) VALUES (?, ?, ?, ?, ?)',
  args: [r.code, r.categoria, r.desc, `${r.desc} · ${label}`, label],
})), 'write');
console.log(`\n${rows.length} rows added for ${label}.`);
process.exit(0);
