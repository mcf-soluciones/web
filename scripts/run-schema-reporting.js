/**
 * Applies scripts/schema-reporting.sql to Turso. Safe to re-run — each
 * statement is executed individually so already-applied ALTERs fail
 * silently (they're logged, not fatal). CREATE TABLE/INDEX use IF NOT
 * EXISTS and are fully idempotent.
 *
 * Usage:
 *   node scripts/run-schema-reporting.js
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
  const sqlPath = path.join(__dirname, 'schema-reporting.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Split on semicolons at end of line (naive but works for this file)
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
      // "duplicate column" etc. expected on re-run
      if (/duplicate column|already exists/i.test(err.message)) {
        console.log(`  SKIP ${preview}  (${err.message})`);
      } else {
        console.error(`  FAIL ${preview}`);
        console.error(`       ${err.message}`);
        process.exitCode = 1;
      }
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
