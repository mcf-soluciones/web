require('dotenv').config();
const { createClient } = require('@libsql/client');
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  console.log('\n=== sales (AWS daily, recent months) ===');
  const s = await turso.execute(`
    SELECT substr(date_real, 1, 7) AS yyyymm,
           COUNT(*) AS n,
           ROUND(SUM(euros), 2) AS total,
           GROUP_CONCAT(DISTINCT type) AS types,
           GROUP_CONCAT(DISTINCT account) AS accounts
    FROM sales
    WHERE date_real >= '2025-01'
    GROUP BY yyyymm
    ORDER BY yyyymm DESC
    LIMIT 8`);
  for (const r of s.rows) console.log(`  ${r.yyyymm}: n=${r.n} total=${r.total} types=${r.types} accounts=${r.accounts}`);

  console.log('\n=== sample rows 2026-04 ===');
  const sample = await turso.execute(`SELECT * FROM sales WHERE date_real LIKE '2026-04%' LIMIT 5`);
  for (const r of sample.rows) console.log('  ' + JSON.stringify(r));
}
main().catch(err => { console.error(err); process.exit(1); });
