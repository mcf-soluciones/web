/**
 * Seeds bs_lines from a CSV file you control.
 *
 * Usage:
 *   1. Prepare your categories in a spreadsheet (Excel / Google Sheets / etc.)
 *   2. Export to CSV with these column headers (case-insensitive, any order):
 *        code, section, subsection, label, sort_order, is_contra, is_derivable,
 *        derivation_note, description
 *   3. Save as scripts/bs-lines.csv (or pass a path: `node ... my-file.csv`)
 *   4. Run:  node scripts/seed-bs-lines-from-csv.js
 *
 * Behaviour:
 *   - UPSERT on `code` — re-running with an updated CSV merges in changes.
 *   - Rows in the table that aren't in the CSV are LEFT ALONE by default. To
 *     wipe the table first, pass --replace:
 *        node scripts/seed-bs-lines-from-csv.js --replace
 *
 *   - Boolean columns accept: 1 / 0, true / false, si / no, yes / no, y / n.
 *
 * Required columns: code, section, label.
 * `section` must be one of: assets, liabilities, equity.
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
const REPLACE = process.argv.includes('--replace');
const CSV_PATH = argFile
  ? path.resolve(argFile)
  : path.join(__dirname, 'bs-lines.csv');

// Minimal CSV parser that handles quoted fields, escaped quotes, and CRLF.
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
      else if (c === ',') { row.push(field); field = ''; }
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

function normalizeKey(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '_');
}

function toBool(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().toLowerCase();
  if (s === '' || s === '0' || s === 'no' || s === 'n' || s === 'false') return 0;
  return 1;
}

function toIntOr(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`CSV not found: ${CSV_PATH}`);
    console.error(`Place your file there or pass a path:`);
    console.error(`  node scripts/seed-bs-lines-from-csv.js path/to/file.csv`);
    process.exit(1);
  }

  const text = fs.readFileSync(CSV_PATH, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.error('CSV has no data rows.');
    process.exit(1);
  }

  const headers = rows[0].map(normalizeKey);
  const required = ['code', 'section', 'label'];
  for (const r of required) {
    if (!headers.includes(r)) {
      console.error(`Missing required column: "${r}". Found columns: ${headers.join(', ')}`);
      process.exit(1);
    }
  }
  const idx = (name) => headers.indexOf(name);

  const data = rows.slice(1).map(row => ({
    code: String(row[idx('code')] || '').trim(),
    section: String(row[idx('section')] || '').trim().toLowerCase(),
    subsection: idx('subsection') >= 0 ? (String(row[idx('subsection')] || '').trim() || null) : null,
    label: String(row[idx('label')] || '').trim(),
    sort_order: idx('sort_order') >= 0 ? toIntOr(row[idx('sort_order')], 0) : 0,
    is_contra: idx('is_contra') >= 0 ? toBool(row[idx('is_contra')]) : 0,
    is_derivable: idx('is_derivable') >= 0 ? toBool(row[idx('is_derivable')]) : 0,
    derivation_note: idx('derivation_note') >= 0 ? (String(row[idx('derivation_note')] || '').trim() || null) : null,
    description: idx('description') >= 0 ? (String(row[idx('description')] || '').trim() || null) : null,
  })).filter(r => r.code);

  // Validate sections
  const validSections = new Set(['assets', 'liabilities', 'equity']);
  const bad = data.filter(r => !validSections.has(r.section));
  if (bad.length > 0) {
    console.error('Invalid section values (must be assets / liabilities / equity):');
    for (const r of bad) console.error(`  ${r.code}: "${r.section}"`);
    process.exit(1);
  }

  console.log(`Read ${data.length} rows from ${CSV_PATH}`);
  if (REPLACE) {
    console.log('--replace: wiping bs_lines first (overrides + opening_balances also dropped to avoid orphan refs)');
    await turso.execute(`DELETE FROM bs_overrides`);
    await turso.execute(`DELETE FROM bs_opening_balances`);
    await turso.execute(`DELETE FROM bs_snapshot_lines`);
    await turso.execute(`DELETE FROM bs_lines`);
  }

  let upserted = 0;
  for (const L of data) {
    await turso.execute({
      sql: `INSERT INTO bs_lines (code, section, subsection, label, sort_order, description, is_contra, is_derivable, derivation_note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(code) DO UPDATE SET
              section          = excluded.section,
              subsection       = excluded.subsection,
              label            = excluded.label,
              sort_order       = excluded.sort_order,
              description      = excluded.description,
              is_contra        = excluded.is_contra,
              is_derivable     = excluded.is_derivable,
              derivation_note  = excluded.derivation_note,
              updated_at       = datetime('now')`,
      args: [L.code, L.section, L.subsection, L.label, L.sort_order, L.description, L.is_contra, L.is_derivable, L.derivation_note],
    });
    upserted++;
  }
  console.log(`Upserted ${upserted} rows.`);

  console.log('\nFinal table:');
  const r = await turso.execute(
    `SELECT section, subsection, code, label, is_contra, is_derivable
     FROM bs_lines ORDER BY section, sort_order`
  );
  let lastSection = '', lastSub = '';
  for (const row of r.rows) {
    if (row.section !== lastSection) {
      console.log(`\n[${row.section}]`);
      lastSection = row.section; lastSub = '';
    }
    if ((row.subsection || '') !== lastSub) {
      console.log(`  · ${row.subsection || '(no subsection)'}`);
      lastSub = row.subsection || '';
    }
    const flags = [row.is_contra ? 'contra' : null, row.is_derivable ? 'derived' : 'override-only'].filter(Boolean).join(', ');
    console.log(`      ${String(row.code).padEnd(34)} ${row.label}  (${flags})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
