/**
 * Imports the BS chart of accounts from an XLSX file into bs_lines.
 *
 * Expected sheet columns (one tab, first row is header):
 *   Code | Group | Section | Subsection | SubAccount | DetailedSubAccount | Tooltip
 *
 * Mapping to bs_lines:
 *   section    ← Group  (Activo→assets, Patrimonio→equity, Pasivos→liabilities)
 *   subsection ← Section ("Activo No Corriente", etc.)
 *   subgroup   ← Subsection when there's a SubAccount; otherwise null
 *   label      ← SubAccount [+ " — " + DetailedSubAccount] when SubAccount is set,
 *                otherwise Subsection
 *   description / derivation_note ← Tooltip
 *
 * Usage:
 *   node scripts/import-bs-lines-xlsx.js <path-to-xlsx>
 *   node scripts/import-bs-lines-xlsx.js <path> --replace      # wipes existing first
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const argFile = process.argv.slice(2).find(a => !a.startsWith('--'));
const REPLACE = process.argv.includes('--replace');

if (!argFile) {
  console.error('Usage: node scripts/import-bs-lines-xlsx.js <path-to-xlsx> [--replace]');
  process.exit(1);
}
const XLSX_PATH = path.resolve(argFile);
if (!fs.existsSync(XLSX_PATH)) {
  console.error(`File not found: ${XLSX_PATH}`);
  process.exit(1);
}

function normSection(group) {
  const s = String(group || '').trim().toLowerCase();
  if (s.startsWith('activo')) return 'assets';
  if (s.startsWith('patrimonio')) return 'equity';
  if (s.startsWith('pasivo')) return 'liabilities';
  return null;
}

function trim(v) { return String(v ?? '').trim(); }

async function main() {
  const wb = xlsx.readFile(XLSX_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (rows.length < 2) {
    console.error('Sheet has no data rows.');
    process.exit(1);
  }

  // Header index map (case-insensitive)
  const headers = rows[0].map(h => String(h || '').trim().toLowerCase());
  const idx = (name) => headers.indexOf(name.toLowerCase());
  const required = ['code', 'group', 'section', 'subsection'];
  for (const r of required) {
    if (idx(r) < 0) { console.error(`Missing column: "${r}". Found: ${headers.join(', ')}`); process.exit(1); }
  }

  const data = rows.slice(1).map((r, i) => {
    const code = trim(r[idx('code')]);
    const group = trim(r[idx('group')]);
    const section = trim(r[idx('section')]);
    const subsection = trim(r[idx('subsection')]);
    const subAccount = idx('subaccount') >= 0 ? trim(r[idx('subaccount')]) : '';
    const detailed = idx('detailedsubaccount') >= 0 ? trim(r[idx('detailedsubaccount')]) : '';
    const tooltip = idx('tooltip') >= 0 ? trim(r[idx('tooltip')]) : '';

    if (!code) return null;

    const mappedSection = normSection(group);
    if (!mappedSection) {
      console.warn(`  ! row ${i + 2} ("${code}"): unrecognised Group "${group}" — skipping`);
      return null;
    }

    // Subgroup is the Subsection only when there's a finer-grained SubAccount/Detail
    // making the Subsection a grouping container. Otherwise the line IS the subsection.
    const hasSubAccount = subAccount !== '' || detailed !== '';
    const subgroup = hasSubAccount ? subsection : null;
    const label = hasSubAccount
      ? (subAccount && detailed ? `${subAccount} — ${detailed.replace(/^\s+/, '')}`
        : (subAccount || detailed.replace(/^\s+/, '')))
      : subsection;

    return {
      code,
      section: mappedSection,
      subsection: section,                                                    // sheet's "Section" → DB's "subsection"
      subgroup,
      label,
      sort_order: i + 1,
      description: tooltip || null,
      derivation_note: tooltip || null,
      is_contra: 0,
      is_derivable: 0,
    };
  }).filter(Boolean);

  console.log(`Parsed ${data.length} lines from ${XLSX_PATH}`);

  if (REPLACE) {
    console.log('--replace: clearing bs_lines and dependents');
    await turso.execute(`DELETE FROM bs_overrides`);
    await turso.execute(`DELETE FROM bs_opening_balances`);
    await turso.execute(`DELETE FROM bs_snapshot_lines`);
    await turso.execute(`DELETE FROM bs_lines`);
  }

  let upserted = 0;
  for (const L of data) {
    await turso.execute({
      sql: `INSERT INTO bs_lines (code, section, subsection, subgroup, label, sort_order, description, is_contra, is_derivable, derivation_note, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(code) DO UPDATE SET
              section          = excluded.section,
              subsection       = excluded.subsection,
              subgroup         = excluded.subgroup,
              label            = excluded.label,
              sort_order       = excluded.sort_order,
              description      = excluded.description,
              is_contra        = excluded.is_contra,
              is_derivable     = excluded.is_derivable,
              derivation_note  = excluded.derivation_note,
              updated_at       = datetime('now')`,
      args: [L.code, L.section, L.subsection, L.subgroup, L.label, L.sort_order,
             L.description, L.is_contra, L.is_derivable, L.derivation_note],
    });
    upserted++;
  }
  console.log(`Upserted ${upserted} lines.`);

  console.log('\nFinal table (preview):');
  const r = await turso.execute(
    `SELECT section, subsection, subgroup, code, label FROM bs_lines ORDER BY section, sort_order`
  );
  let lastSection = '', lastSub = '', lastSubgroup = '';
  for (const row of r.rows) {
    if (row.section !== lastSection) {
      console.log(`\n[${row.section.toUpperCase()}]`);
      lastSection = row.section; lastSub = ''; lastSubgroup = '';
    }
    if (row.subsection !== lastSub) {
      console.log(`  ${row.subsection}`);
      lastSub = row.subsection; lastSubgroup = '';
    }
    if ((row.subgroup || '') !== lastSubgroup) {
      if (row.subgroup) console.log(`    ${row.subgroup}`);
      lastSubgroup = row.subgroup || '';
    }
    const indent = row.subgroup ? '      ' : '    ';
    console.log(`${indent}${row.code.padEnd(10)} ${row.label}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
