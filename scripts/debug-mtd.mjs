import fs from 'node:fs';
import path from 'node:path';
for (const line of fs.readFileSync(path.resolve('.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
  if (!m) continue;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!process.env[m[1]]) process.env[m[1]] = v;
}
const { createClient } = await import('@libsql/client');
const t = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

console.log('\n=== sales table, Apr 2026 by day + store ===');
const r1 = await t.execute(`
  SELECT date_real, mcf_user, type, COUNT(*) AS n, SUM(euros) AS tot
  FROM sales
  WHERE date_real >= '2026-04-01'
  GROUP BY date_real, mcf_user, type
  ORDER BY date_real, mcf_user`);
for (const r of r1.rows) console.log(r.date_real, r.mcf_user, r.type, 'n=' + r.n, 'tot=' + r.tot);

console.log('\n=== sales table, monthly totals (any user, any type) ===');
const r2 = await t.execute(`
  SELECT substr(date_real, 1, 7) AS ym, COUNT(*) AS n, SUM(euros) AS tot,
         MIN(date_real) AS mn, MAX(date_real) AS mx
  FROM sales
  GROUP BY ym ORDER BY ym`);
for (const r of r2.rows) console.log(r.ym, 'rows=' + r.n, 'eur=' + r.tot, 'range=', r.mn, '→', r.mx);

console.log('\n=== sales_detail, Apr 2025 vs Apr 2026 ===');
const r3 = await t.execute(`
  SELECT yyyy, mm, COUNT(*) AS n, SUM(euro) AS tot, MAX(dd) AS lastday
  FROM sales_detail WHERE mm = 4 AND yyyy IN (2025, 2026) GROUP BY yyyy, mm`);
for (const r of r3.rows) console.log(r.yyyy, r.mm, 'rows=' + r.n, 'eur=' + r.tot, 'lastday=' + r.lastday);

console.log('\n=== sales_detail, last 3 months rows + range ===');
const r4 = await t.execute(`
  SELECT yyyy, mm, COUNT(*) AS n, SUM(euro) AS tot, MAX(dd) AS mx_dd
  FROM sales_detail WHERE (yyyy > 2026) OR (yyyy = 2026 AND mm >= 1) OR (yyyy = 2025 AND mm = 12)
  GROUP BY yyyy, mm ORDER BY yyyy, mm`);
for (const r of r4.rows) console.log(r.yyyy, r.mm, 'rows=' + r.n, 'eur=' + r.tot, 'mx_dd=' + r.mx_dd);

console.log('\n=== sales_detail, Apr 2025 breakdown by payment ===');
const r5 = await t.execute(`
  SELECT payment, COUNT(*) AS n, SUM(euro) AS tot
  FROM sales_detail WHERE yyyy=2025 AND mm=4 AND dd<=14 GROUP BY payment`);
for (const r of r5.rows) console.log(r.payment, 'n=' + r.n, 'eur=' + r.tot);

console.log('\n=== sales_detail, Apr 2026 breakdown by payment ===');
const r6 = await t.execute(`
  SELECT payment, COUNT(*) AS n, SUM(euro) AS tot
  FROM sales_detail WHERE yyyy=2026 AND mm=4 AND dd<=14 GROUP BY payment`);
for (const r of r6.rows) console.log(r.payment, 'n=' + r.n, 'eur=' + r.tot);
