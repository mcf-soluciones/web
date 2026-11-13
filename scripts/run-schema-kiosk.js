/**
 * Applies scripts/schema-kiosk.sql to Turso. Safe to re-run: every statement
 * uses CREATE ... IF NOT EXISTS, so already-applied changes are no-ops.
 *
 * Usage:
 *   node scripts/run-schema-kiosk.js
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
  const sql = fs.readFileSync(path.join(__dirname, 'schema-kiosk.sql'), 'utf8');
  const stmts = sql
    .split(/;\s*\n/)
    .map(s => s.replace(/--[^\n]*/g, '').trim())
    .filter(s => s.length > 0);

  const clash = await turso.execute("SELECT COUNT(*) AS n FROM sales_detail WHERE substr(movid, 1, 1) = 'K'");
  console.log(`sales_detail rows already starting with K: ${clash.rows[0].n}`);

  console.log(`Executing ${stmts.length} statement(s) against Turso...`);
  for (const stmt of stmts) {
    const preview = stmt.slice(0, 80).replace(/\s+/g, ' ');
    try {
      await turso.execute(stmt);
      console.log(`  OK   ${preview}`);
    } catch (err) {
      console.error(`  FAIL ${preview}`);
      console.error(`       ${err.message}`);
      process.exitCode = 1;
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
