/**
 * Applies scripts/schema-projections.sql to Turso. Idempotent.
 * Usage: node scripts/run-schema-projections.js
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
  const sqlPath = path.join(__dirname, 'schema-projections.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const stmts = sql.split(/;\s*\n/).map(s => s.replace(/--[^\n]*/g, '').trim()).filter(Boolean);
  console.log(`Executing ${stmts.length} statement(s)...`);
  for (const stmt of stmts) {
    const preview = stmt.slice(0, 80).replace(/\s+/g, ' ');
    try { await turso.execute(stmt); console.log(`  OK   ${preview}`); }
    catch (err) {
      if (/already exists|duplicate column/i.test(err.message)) console.log(`  SKIP ${preview}`);
      else { console.error(`  FAIL ${preview}\n       ${err.message}`); process.exitCode = 1; }
    }
  }
}
main().catch(err => { console.error('Fatal:', err); process.exit(1); });
