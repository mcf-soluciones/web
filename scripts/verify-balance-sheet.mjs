/**
 * Sweep / single-month sanity check for the BS engine.
 *
 * Modes:
 *   No args       → sweep every month from data start to current month, one
 *                   line per month: A − L − E and a drift tag. Final summary
 *                   prints worst-drift months and lines that are flagged as
 *                   overrides or sourced from a snapshot.
 *
 *   2025-08 …     → detail mode: print every line for each requested month.
 *
 *   --since=YYYY-MM  → start the sweep at this month (default = earliest data).
 *
 * Usage:
 *   node scripts/verify-balance-sheet.mjs
 *   node scripts/verify-balance-sheet.mjs --since=2025-01
 *   node scripts/verify-balance-sheet.mjs 2025-08 2026-01
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import { deriveBalanceSheet } from '../api/_lib/balance-sheet.js';

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const FMT = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (n) => FMT.format(Number(n || 0)) + ' €';

const TOL_OK = 1;
const TOL_WARN = 200;

function driftBadge(check) {
  const a = Math.abs(check);
  if (a < TOL_OK) return '✅';
  if (a < TOL_WARN) return '⚠';
  return '❌';
}

async function dataRange() {
  const r = await turso.execute(
    `SELECT MIN(yyyy * 100 + mm) AS first_ym, MAX(yyyy * 100 + mm) AS last_ym
     FROM gastos WHERE yyyy IS NOT NULL`
  );
  const first = Number(r.rows[0]?.first_ym) || null;
  const last = Number(r.rows[0]?.last_ym) || null;
  return { first, last };
}

function* monthRange(fromYm, toYm) {
  let y = Math.floor(fromYm / 100), m = fromYm % 100;
  const ey = Math.floor(toYm / 100), em = toYm % 100;
  while (y < ey || (y === ey && m <= em)) {
    yield { yyyy: y, mm: m };
    m++;
    if (m > 12) { m = 1; y++; }
  }
}

function parseSinceArg() {
  const arg = process.argv.find(a => a.startsWith('--since='));
  if (!arg) return null;
  const v = arg.split('=')[1] || '';
  const m = v.match(/^(\d{4})-(\d{2})$/);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

function parseDetailMonths() {
  return process.argv.slice(2)
    .filter(a => /^\d{4}-\d{1,2}$/.test(a))
    .map(a => {
      const [y, m] = a.split('-').map(Number);
      return { yyyy: y, mm: m };
    });
}

async function detailDump(yyyy, mm) {
  console.log(`\n========================================================`);
  console.log(`  Balance Sheet — ${yyyy}-${String(mm).padStart(2, '0')}`);
  console.log(`========================================================`);

  const bs = await deriveBalanceSheet(yyyy, mm);

  if (bs.snapshot) {
    const tag = bs.snapshot.closed ? 'CLOSED' : 'open';
    console.log(`Snapshot anchor: ${bs.snapshot.as_of_date} (${tag}, ${bs.snapshot.mode}) — ${bs.snapshot.name || 'unnamed'}`);
  } else {
    console.log(`Snapshot anchor: none — full historical derivation`);
  }

  let lastSection = '';
  for (const L of bs.lines) {
    if (L.section !== lastSection) {
      console.log(`\n[${L.section.toUpperCase()}]`);
      lastSection = L.section;
    }
    const tag = L.source === 'override' ? '(OVR)'
              : L.source === 'snapshot' ? '(snap)'
              : L.source === 'derived' ? '(der)'
              : '(opn)';
    const contraTag = L.is_contra ? ' (contra)' : '';
    console.log(`  ${L.code.padEnd(34)} ${tag} ${eur(L.amount).padStart(14)}${contraTag}    ${L.label}`);
    if (L.breakdown && L.source === 'derived') {
      const parts = Object.entries(L.breakdown)
        .filter(([_, v]) => typeof v === 'number')
        .map(([k, v]) => `${k}=${eur(v)}`)
        .join(', ');
      if (parts) console.log(`    └─ ${parts}`);
    }
  }

  console.log(`\nSection totals:`);
  console.log(`  Assets       ${eur(bs.totals.assets).padStart(14)}`);
  console.log(`  Liabilities  ${eur(bs.totals.liabilities).padStart(14)}`);
  console.log(`  Equity       ${eur(bs.totals.equity).padStart(14)}`);
  const tag = Math.abs(bs.totals.balance_check) < TOL_OK
    ? '✅ balanced'
    : Math.abs(bs.totals.balance_check) < TOL_WARN
      ? '⚠ small drift'
      : '❌ imbalance';
  console.log(`  Balance      A − L − E = ${eur(bs.totals.balance_check)}    ${tag}`);
}

async function sweep(fromYm, toYm) {
  console.log(`\nSweeping ${String(fromYm).slice(0,4)}-${String(fromYm).slice(4)} → ${String(toYm).slice(0,4)}-${String(toYm).slice(4)}\n`);
  console.log(`  Period   Anchor       Cls   Assets        Liabilities   Equity        Drift          `);
  console.log(`  -------- ------------ ----- ------------- ------------- ------------- ---------------`);

  const driftRows = [];
  let worst = { ym: null, drift: 0 };
  let totalOverrides = 0;
  let totalSnapshots = 0;

  for (const { yyyy, mm } of monthRange(fromYm, toYm)) {
    const bs = await deriveBalanceSheet(yyyy, mm);
    const check = bs.totals.balance_check;
    const period = `${yyyy}-${String(mm).padStart(2, '0')}`;
    const anchor = bs.anchor_date || '—'.padEnd(11);
    const closed = bs.snapshot?.closed ? 'CLS' : '   ';
    const overrides = bs.lines.filter(L => L.source === 'override').length;
    const snaps = bs.lines.filter(L => L.source === 'snapshot').length;
    totalOverrides += overrides;
    totalSnapshots += snaps;

    console.log(
      `  ${period}  ${String(anchor).padEnd(12)} ${closed}   `
      + `${eur(bs.totals.assets).padStart(13)} `
      + `${eur(bs.totals.liabilities).padStart(13)} `
      + `${eur(bs.totals.equity).padStart(13)} `
      + `${eur(check).padStart(13)} ${driftBadge(check)}`
      + (overrides ? ` · ${overrides} OVR` : '')
    );

    driftRows.push({ ym: period, drift: check, overrides, snaps });
    if (Math.abs(check) > Math.abs(worst.drift)) worst = { ym: period, drift: check };
  }

  // Summary
  const driftsSorted = [...driftRows].sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
  const balanced = driftRows.filter(r => Math.abs(r.drift) < TOL_OK).length;
  const warnings = driftRows.filter(r => Math.abs(r.drift) >= TOL_OK && Math.abs(r.drift) < TOL_WARN).length;
  const errors = driftRows.filter(r => Math.abs(r.drift) >= TOL_WARN).length;

  console.log(`\nSummary:`);
  console.log(`  Months swept:         ${driftRows.length}`);
  console.log(`  ✅ balanced (<€${TOL_OK}):      ${balanced}`);
  console.log(`  ⚠ small drift (<€${TOL_WARN}): ${warnings}`);
  console.log(`  ❌ imbalance (≥€${TOL_WARN}):   ${errors}`);
  console.log(`  Worst drift:          ${worst.ym} = ${eur(worst.drift)}`);
  console.log(`  Total override-cells across months: ${totalOverrides}`);
  console.log(`  Total snapshot-cells across months: ${totalSnapshots}`);

  if (errors > 0) {
    console.log(`\nTop 5 offending months:`);
    for (const r of driftsSorted.slice(0, 5)) {
      console.log(`  ${r.ym}  drift=${eur(r.drift)}`);
    }
    console.log(`\nNext steps to balance:`);
    console.log(`  · Add a manual opening snapshot (apertura) at the earliest meaningful month-end.`);
    console.log(`  · Or set per-month overrides on lines that the engine can't derive (AR, AP, inventory).`);
    console.log(`  · After fixing the earliest months, re-run this script to check if drift propagates downstream.`);
  }
}

// =============================================================================

async function main() {
  const detailMonths = parseDetailMonths();
  if (detailMonths.length > 0) {
    for (const { yyyy, mm } of detailMonths) await detailDump(yyyy, mm);
    return;
  }

  const range = await dataRange();
  if (!range.first || !range.last) {
    console.error('No gastos data found — nothing to verify.');
    return;
  }

  const since = parseSinceArg();
  const fromYm = since && since >= range.first ? since : range.first;
  const toYm = range.last;
  await sweep(fromYm, toYm);
}

main()
  .then(() => console.log('\n(verification complete)'))
  .catch(e => { console.error(e); process.exit(1); });
