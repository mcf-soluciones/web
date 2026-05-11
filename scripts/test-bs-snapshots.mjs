/**
 * Regression test for the snapshot-based BS engine. Exercises:
 *   1. Empty state — no snapshots, full historical derivation.
 *   2. Manual opening snapshot at 2024-12-31.
 *   3. Open period (2025-01) anchored to opening snapshot.
 *   4. Capture-close 2025-01 — short-circuit on subsequent reads.
 *   5. Open period (2025-02) anchored to most recent snapshot.
 *   6. Year-rollover correctness via a hypothetical 2025-12 close.
 *
 * Cleans up test snapshots at the end so the DB isn't left dirty.
 *
 * Usage: node scripts/test-bs-snapshots.mjs
 */
import 'dotenv/config';
import { createClient } from '@libsql/client';
import { deriveBalanceSheet } from '../api/_lib/balance-sheet.js';

const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const FMT = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (n) => FMT.format(Number(n || 0)) + ' €';

const TEST_TAG = '[TEST]';
const createdIds = [];

async function clearTestSnapshots() {
  // Delete any snapshot lines pointing to test snapshots, then the snapshots.
  const ids = await turso.execute({
    sql: `SELECT id FROM bs_snapshots WHERE notes LIKE '${TEST_TAG}%' OR name LIKE '${TEST_TAG}%'`,
    args: [],
  });
  for (const r of ids.rows) {
    await turso.execute({ sql: `DELETE FROM bs_snapshot_lines WHERE snapshot_id = ?`, args: [r.id] });
    await turso.execute({ sql: `DELETE FROM bs_snapshots WHERE id = ?`, args: [r.id] });
  }
}

async function makeSnapshot({ as_of_date, mode, name, lines }) {
  const [y, m] = as_of_date.split('-').map(Number);
  const ins = await turso.execute({
    sql: `INSERT INTO bs_snapshots (as_of_date, yyyy, mm, name, notes, mode)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [as_of_date, y, m, `${TEST_TAG} ${name}`, `${TEST_TAG} regression test`, mode],
  });
  const id = Number(ins.lastInsertRowid);
  createdIds.push(id);
  for (const L of lines) {
    await turso.execute({
      sql: `INSERT INTO bs_snapshot_lines (snapshot_id, line_code, amount) VALUES (?, ?, ?)`,
      args: [id, L.line_code, L.amount],
    });
  }
  return id;
}

async function captureSnapshot({ yyyy, mm, name }) {
  const bs = await deriveBalanceSheet(yyyy, mm);
  const lines = bs.lines.map(L => ({ line_code: L.code, amount: L.amount }));
  const lastDay = new Date(Date.UTC(yyyy, mm, 0)).getUTCDate();
  const as_of_date = `${yyyy}-${String(mm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return makeSnapshot({ as_of_date, mode: 'capture', name, lines });
}

function brief(label, bs) {
  const tag = bs.snapshot
    ? `snapshot=${bs.snapshot.as_of_date}${bs.snapshot.closed ? ' (CLOSED)' : ''}`
    : 'no snapshot';
  const drift = Math.abs(bs.totals.balance_check) < 1
    ? '✅' : Math.abs(bs.totals.balance_check) < 200 ? '⚠' : '❌';
  console.log(`  ${label.padEnd(40)} A=${eur(bs.totals.assets).padStart(15)}   E=${eur(bs.totals.equity).padStart(15)}   ${drift} ${eur(bs.totals.balance_check).padStart(11)}    ${tag}`);
}

try {
  await clearTestSnapshots();

  console.log('\n[1] Empty state — full historical derivation');
  brief('2025-01', await deriveBalanceSheet(2025, 1));
  brief('2026-04', await deriveBalanceSheet(2026, 4));

  console.log('\n[2] Manual opening snapshot at 2024-12-31');
  await makeSnapshot({
    as_of_date: '2024-12-31', mode: 'manual', name: 'Apertura',
    lines: [
      { line_code: 'A.11.bank', amount: 180364 },
      { line_code: 'E.20.retained_earnings', amount: 180364 },
    ],
  });

  console.log('\n[3] Open periods anchored to opening snapshot');
  brief('2025-01 (open, anchor=2024-12-31)', await deriveBalanceSheet(2025, 1));
  brief('2025-02 (open, anchor=2024-12-31)', await deriveBalanceSheet(2025, 2));

  console.log('\n[4] Capture-close 2025-01 → 2025-01 becomes CLOSED');
  await captureSnapshot({ yyyy: 2025, mm: 1, name: 'Cierre Ene 2025' });
  brief('2025-01 (CLOSED)', await deriveBalanceSheet(2025, 1));
  brief('2025-02 (open, anchor=2025-01-31)', await deriveBalanceSheet(2025, 2));

  console.log('\n[5] Capture-close 2025-12 → tests year rollover into 2026');
  brief('2025-12 (open, before close)', await deriveBalanceSheet(2025, 12));
  await captureSnapshot({ yyyy: 2025, mm: 12, name: 'Cierre Dic 2025' });
  brief('2025-12 (CLOSED)', await deriveBalanceSheet(2025, 12));
  brief('2026-01 (open, anchor=2025-12-31)', await deriveBalanceSheet(2026, 1));
  // Year rollover: snapshot's E.30 should roll into E.20 for 2026
  const bs26 = await deriveBalanceSheet(2026, 1);
  const e20 = bs26.lines.find(L => L.code === 'E.20.retained_earnings');
  const e30 = bs26.lines.find(L => L.code === 'E.30.current_earnings');
  console.log(`      E.20 retained = ${eur(e20.amount)}   ${JSON.stringify(e20.breakdown)}`);
  console.log(`      E.30 current  = ${eur(e30.amount)}   ${JSON.stringify(e30.breakdown)}`);
} finally {
  await clearTestSnapshots();
  console.log('\n[test snapshots cleared]');
}
