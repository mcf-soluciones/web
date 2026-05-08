/**
 * Seed / update property_activation rows. Re-run anytime the user corrects a
 * start date — UPSERT on property.
 *
 * Usage: node scripts/seed-property-activation.js
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Edit these dates as needed — source of truth is the business, not this file.
const ACTIVATIONS = [
  { property: 'usera',     start_date: '2020-01-01', label: '(001) Usera',     notes: 'Assumed very early — all historical sales_detail rows belong to MCF.' },
  { property: 'hortaleza', start_date: '2025-08-01', label: '(002) Hortaleza', notes: 'Acquired July 2025; P&L attribution starts August 2025. Pre-Aug sales_detail rows are prior owner and are excluded from P&L/CF.' },
];

async function main() {
  // Ensure table exists
  await turso.execute(`CREATE TABLE IF NOT EXISTS property_activation (
    property TEXT PRIMARY KEY,
    start_date TEXT NOT NULL,
    label TEXT,
    notes TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  )`);

  for (const a of ACTIVATIONS) {
    await turso.execute({
      sql: `INSERT INTO property_activation (property, start_date, label, notes, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(property) DO UPDATE SET
              start_date = excluded.start_date,
              label = excluded.label,
              notes = excluded.notes,
              updated_at = datetime('now')`,
      args: [a.property, a.start_date, a.label, a.notes],
    });
    console.log(`  upserted ${a.property} → ${a.start_date}`);
  }

  console.log('\nCurrent rows:');
  const r = await turso.execute('SELECT property, start_date, label, notes FROM property_activation ORDER BY property');
  for (const row of r.rows) console.log('  ' + JSON.stringify(row));
}
main().catch(e => { console.error(e); process.exit(1); });
