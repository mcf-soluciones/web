/**
 * Applies scripts/schema-bs-snapshots.sql to Turso. Idempotent.
 *
 * Usage:
 *   node scripts/run-schema-bs-snapshots.js
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  const sqlPath = path.join(__dirname, 'schema-bs-snapshots.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const stmts = sql
    .split(/;\s*\n/)
    .map(s => s.replace(/--[^\n]*/g, '').trim())
    .filter(s => s.length > 0);

  console.log(`Executing ${stmts.length} statement(s)...`);
  for (const stmt of stmts) {
    const preview = stmt.slice(0, 80).replace(/\s+/g, ' ');
    try {
      await turso.execute(stmt);
      console.log(`  OK   ${preview}`);
    } catch (err) {
      if (/already exists|duplicate column/i.test(err.message)) {
        console.log(`  SKIP ${preview}  (${err.message})`);
      } else {
        console.error(`  FAIL ${preview}`);
        console.error(`       ${err.message}`);
        process.exitCode = 1;
      }
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
