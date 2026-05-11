/**
 * Diagnostic: side-by-side view of BS engine's monthly NI vs. P&L endpoint's
 * monthly NI. The two are *intentionally* different reports with different
 * conventions and are NOT expected to match — this script is for inspection,
 * not regression testing.
 *
 * Conventions that diverge by design:
 *   - P&L 'neto.by_month' adds depreciation back after subtracting (cash-like).
 *   - P&L nets revenue by 21% IVA cobrado at the EBITDA level.
 *   - BS uses gross revenue and proper accounting NI (revenue − expenses − dep − N8).
 *   - P&L falls back to the sales table when sales_detail lacks data; BS does not.
 *
 * BS NI[m] = derivedBalanceSheet(yyyy, m).E.30 − derivedBalanceSheet(yyyy, m-1).E.30
 * P&L NI[m] = pnl.js' year.neto.by_month[m]
 *
 * Usage:
 *   node scripts/check-bs-vs-pnl.mjs            # all years with data
 *   node scripts/check-bs-vs-pnl.mjs 2025 2026  # specific years
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import { deriveBalanceSheet } from '../api/_lib/balance-sheet.js';

const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const FMT = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (n) => FMT.format(Number(n || 0)) + ' €';

const BASE = process.env.LOCAL_API_BASE || 'http://localhost:3001';
const TOL = 1;

async function pnlYearNeto(yyyy) {
  const r = await fetch(`${BASE}/api/reports/pnl?yyyy=${yyyy}&mm=12`);
  if (!r.ok) throw new Error(`pnl HTTP ${r.status} for ${yyyy}`);
  const j = await r.json();
  return j.year.neto.by_month;                                              // { 1: x, 2: y, ... }
}

async function bsMonthlyE30(yyyy, mm) {
  const bs = await deriveBalanceSheet(yyyy, mm);
  const e30 = bs.lines.find(L => L.code === 'E.30.current_earnings');
  return e30 ? Number(e30.amount) : 0;
}

async function checkYear(yyyy) {
  console.log(`\n=== ${yyyy} ===`);
  console.log(`  Mes  P&L NI            BS NI             Diff             `);
  console.log(`  ---  ----------------  ----------------  -----------------`);

  const pnlNeto = await pnlYearNeto(yyyy);

  let prevYtd = 0;
  let totalDiff = 0;
  let flaggedCount = 0;

  for (let m = 1; m <= 12; m++) {
    const ytdE30 = await bsMonthlyE30(yyyy, m);
    const bsMonthly = ytdE30 - prevYtd;
    prevYtd = ytdE30;

    const pnlMonthly = Number(pnlNeto[m] || 0);
    if (pnlMonthly === 0 && bsMonthly === 0) continue;

    const diff = bsMonthly - pnlMonthly;
    totalDiff += diff;
    // Diff is informational — both reports are intentionally different views.
    const flag = Math.abs(diff) < TOL ? '·' : '~';
    if (Math.abs(diff) >= TOL) flaggedCount++;

    console.log(
      `  ${String(m).padStart(2)}   `
      + `${eur(pnlMonthly).padStart(16)}  `
      + `${eur(bsMonthly).padStart(16)}  `
      + `${eur(diff).padStart(15)}  ${flag}`
    );
  }

  console.log(`\n  Year total diff: ${eur(totalDiff)}    flagged months: ${flaggedCount}`);
  return { yyyy, totalDiff, flaggedCount };
}

async function dataYears() {
  const r = await turso.execute(`SELECT DISTINCT yyyy FROM gastos WHERE yyyy IS NOT NULL ORDER BY yyyy`);
  return r.rows.map(x => Number(x.yyyy));
}

async function main() {
  const argYears = process.argv.slice(2).map(Number).filter(n => Number.isFinite(n) && n > 2000);
  const years = argYears.length > 0 ? argYears : await dataYears();

  if (years.length === 0) {
    console.error('No years to check.');
    return;
  }

  const summaries = [];
  for (const y of years) summaries.push(await checkYear(y));

  console.log(`\n=== Summary ===`);
  for (const s of summaries) {
    console.log(`  ${s.yyyy}  diff months: ${s.flaggedCount}    total diff: ${eur(s.totalDiff)}`);
  }
  console.log(`\n(BS and P&L use different conventions — diffs above are inspection-only, not failures.)`);
}

main()
  .then(() => console.log('\n(cross-check complete)'))
  .catch(e => { console.error(e); process.exit(1); });
