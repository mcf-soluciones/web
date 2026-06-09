// Drops the UNIQUE index on gastos.bank_movement_hash.
//
// The bank importer no longer de-duplicates: it trusts every uploaded row and
// allows duplicates (the user deletes any later). The unique index would make a
// duplicate upload throw a constraint error instead of inserting, so it is
// removed. The bank_movement_hash column stays (it flags bank-imported rows in
// the UI) but is no longer unique.
//
// Idempotent and non-destructive — drops an index only, touches no row data.
//
// Usage: node --env-file=.env scripts/drop-bank-hash-unique-index.js

import turso from '../api/_lib/turso.js';

async function main() {
  const before = await turso.execute(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_gastos_bank_hash'`
  );
  if (before.rows.length === 0) {
    console.log('idx_gastos_bank_hash not present — nothing to do.');
    return;
  }
  await turso.execute('DROP INDEX IF EXISTS idx_gastos_bank_hash');
  console.log('Dropped UNIQUE index idx_gastos_bank_hash. Duplicate bank uploads are now allowed.');
}

main().catch(e => { console.error(e); process.exit(1); });
