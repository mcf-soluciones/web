/**
 * Imports census indicators from a CSV into the `census_indicators` table.
 *
 * Usage:
 *   node scripts/import-census-csv.js path/to/file.csv
 *
 * Expected CSV columns (case-insensitive, any subset of optionals):
 *   Required:  seccion_id, yyyy
 *   Optional:  barrio_id, municipio_id, poblacion, renta_media, renta_hogar,
 *              pct_extranjero, hogar_size, alquiler_m2
 *
 * - seccion_id should be the INE CUSEC code (10 digits, leading-zero preserved).
 * - One row per (seccion_id, yyyy). Re-running overwrites the same row.
 * - Numeric fields accept comma OR period as decimal separator (INE files use comma).
 *
 * Tip: prep a single wide CSV with all the indicators you have for the year,
 * leave columns blank where you don't have data. This script will UPSERT
 * with COALESCE so partial updates don't overwrite previously-loaded fields
 * with NULL.
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const argFile = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!argFile) {
  console.error('Usage: node scripts/import-census-csv.js <path/to/file.csv>');
  process.exit(1);
}
const CSV_PATH = path.resolve(argFile);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',' || c === ';') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      }
      else { field += c; }
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

const normalizeKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '_');

function toNum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s === '-' || s === 'NA' || s === 'na') return null;
  // INE uses comma decimal separator and dot for thousands.
  // Heuristic: if there's exactly one comma and no period, treat comma as decimal.
  const cleaned = s.includes(',') && !s.includes('.')
    ? s.replace(',', '.')
    : s.replace(/\.(?=\d{3}\b)/g, '');  // strip thousand separators
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  const n = toNum(v);
  return n === null ? null : Math.round(n);
}

const FIELDS = [
  { key: 'barrio_id',       toDb: v => v === '' ? null : String(v) },
  { key: 'municipio_id',    toDb: v => v === '' ? null : String(v) },
  { key: 'poblacion',       toDb: toInt },
  { key: 'renta_media',     toDb: toNum },
  { key: 'renta_hogar',     toDb: toNum },
  { key: 'pct_extranjero',  toDb: toNum },
  { key: 'hogar_size',      toDb: toNum },
  { key: 'alquiler_m2',     toDb: toNum },
];

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV not found: ${CSV_PATH}`);
    process.exit(1);
  }

  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.error('CSV has no data rows.');
    process.exit(1);
  }

  const headers = rows[0].map(normalizeKey);
  for (const req of ['seccion_id', 'yyyy']) {
    if (!headers.includes(req)) {
      console.error(`Missing required column: ${req}. Found: ${headers.join(', ')}`);
      process.exit(1);
    }
  }
  const idx = (k) => headers.indexOf(k);

  const data = rows.slice(1).map(row => {
    const out = {
      seccion_id: String(row[idx('seccion_id')] || '').trim(),
      yyyy: toInt(row[idx('yyyy')]),
    };
    for (const f of FIELDS) {
      const c = idx(f.key);
      out[f.key] = c >= 0 ? f.toDb(String(row[c] ?? '').trim()) : undefined;
    }
    return out;
  }).filter(r => r.seccion_id && r.yyyy);

  console.log(`Parsed ${data.length} valid rows from ${CSV_PATH}`);
  let upserts = 0;
  for (const r of data) {
    // Build INSERT ... ON CONFLICT DO UPDATE with COALESCE so blank cells
    // don't clobber existing values.
    const cols = ['seccion_id', 'yyyy'];
    const vals = [r.seccion_id, r.yyyy];
    const setParts = [];
    for (const f of FIELDS) {
      if (r[f.key] === undefined) continue;       // column wasn't in the CSV
      cols.push(f.key);
      vals.push(r[f.key]);
      setParts.push(`${f.key} = COALESCE(excluded.${f.key}, ${f.key})`);
    }
    const placeholders = cols.map(() => '?').join(', ');
    const sql = setParts.length === 0
      ? `INSERT OR IGNORE INTO census_indicators (${cols.join(', ')}) VALUES (${placeholders})`
      : `INSERT INTO census_indicators (${cols.join(', ')}) VALUES (${placeholders})
         ON CONFLICT(seccion_id, yyyy) DO UPDATE SET ${setParts.join(', ')}`;
    await turso.execute({ sql, args: vals });
    upserts++;
    if (upserts % 500 === 0) console.log(`  ${upserts}/${data.length}`);
  }
  console.log(`OK  ${upserts} rows upserted`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
