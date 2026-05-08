/**
 * Scan sales_detail for rows whose (product, euro, price_list, property) combo
 * isn't in the products catalog — these are the "gaps" that cause missing
 * product_size / product_mission / capacity in the Resumen tables.
 *
 * Reports:
 *   1. Coverage rate overall and by year
 *   2. Missing (product, euro, price_list, property) combos, ranked by impact
 *   3. Partial-match diagnostics: combos missing, but where we DO have:
 *        - same (product, price_list, property) at a different euro  →  price change?
 *        - same (product, property) but different price_list          →  price-list change?
 *        - same product only                                          →  typo / new variant
 *   4. Rows where the product itself doesn't exist in `products` at all
 *
 * Usage: node scripts/analyze-product-gaps.js
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

function pad(n, w = 10) { return String(n).padStart(w, ' '); }
function fmt(n) { return Number(n || 0).toLocaleString('es-ES', { maximumFractionDigits: 2 }); }

async function main() {
  // ---------- 1. OVERALL COVERAGE ---------------------------------------------
  const overall = await turso.execute(`
    SELECT COUNT(*) AS total_rows,
           SUM(CASE WHEN p.product IS NULL THEN 1 ELSE 0 END) AS unmapped_rows,
           ROUND(SUM(sd.euro), 2) AS total_euros,
           ROUND(SUM(CASE WHEN p.product IS NULL THEN sd.euro ELSE 0 END), 2) AS unmapped_euros
    FROM sales_detail sd
    LEFT JOIN products p
      ON sd.product = p.product
     AND sd.euro = p.precio
     AND sd.price_list = p.price_list
     AND sd.property = p.property
  `);
  const o = overall.rows[0];
  console.log('\n=== OVERALL COVERAGE ===');
  console.log(`  rows:     ${fmt(o.total_rows)} total, ${fmt(o.unmapped_rows)} unmapped (${(100*Number(o.unmapped_rows)/Number(o.total_rows)).toFixed(2)}%)`);
  console.log(`  euros:    ${fmt(o.total_euros)} total, ${fmt(o.unmapped_euros)} unmapped (${(100*Number(o.unmapped_euros)/Number(o.total_euros)).toFixed(2)}%)`);

  // ---------- 2. COVERAGE BY YEAR ---------------------------------------------
  console.log('\n=== COVERAGE BY YEAR ===');
  const byYear = await turso.execute(`
    SELECT sd.yyyy,
           COUNT(*) AS total_rows,
           SUM(CASE WHEN p.product IS NULL THEN 1 ELSE 0 END) AS unmapped_rows,
           ROUND(SUM(CASE WHEN p.product IS NULL THEN sd.euro ELSE 0 END), 2) AS unmapped_euros
    FROM sales_detail sd
    LEFT JOIN products p
      ON sd.product = p.product
     AND sd.euro = p.precio
     AND sd.price_list = p.price_list
     AND sd.property = p.property
    GROUP BY sd.yyyy
    ORDER BY sd.yyyy
  `);
  for (const r of byYear.rows) {
    const pct = 100 * Number(r.unmapped_rows) / Number(r.total_rows);
    console.log(`  ${r.yyyy}:  ${pad(fmt(r.unmapped_rows))} / ${pad(fmt(r.total_rows))} rows unmapped (${pct.toFixed(1)}%)  €${fmt(r.unmapped_euros)}`);
  }

  // ---------- 3. MISSING COMBOS, RANKED BY IMPACT -----------------------------
  console.log('\n=== TOP MISSING (product, euro, price_list, property) COMBOS ===');
  const combos = await turso.execute(`
    SELECT sd.product, sd.euro, sd.price_list, sd.property,
           COUNT(*) AS n_rows,
           ROUND(SUM(sd.euro), 2) AS euros_total,
           MIN(sd.date) AS first_seen,
           MAX(sd.date) AS last_seen
    FROM sales_detail sd
    LEFT JOIN products p
      ON sd.product = p.product
     AND sd.euro = p.precio
     AND sd.price_list = p.price_list
     AND sd.property = p.property
    WHERE p.product IS NULL
    GROUP BY sd.product, sd.euro, sd.price_list, sd.property
    ORDER BY euros_total DESC
    LIMIT 40
  `);
  console.log(`  ${'product'.padEnd(14)} ${'€'.padStart(8)} ${'price_list'.padEnd(22)} ${'property'.padEnd(11)} ${'rows'.padStart(7)} ${'total €'.padStart(10)}  first→last`);
  for (const r of combos.rows) {
    console.log(`  ${String(r.product||'').padEnd(14)} ${String(fmt(r.euro)).padStart(8)} ${String(r.price_list||'').padEnd(22)} ${String(r.property||'').padEnd(11)} ${pad(fmt(r.n_rows), 7)} ${pad(fmt(r.euros_total), 10)}  ${r.first_seen}→${r.last_seen}`);
  }

  // ---------- 4. PRODUCTS THAT DON'T EXIST AT ALL IN products -----------------
  console.log('\n=== PRODUCTS IN sales_detail THAT DO NOT EXIST IN products ===');
  const orphans = await turso.execute(`
    SELECT sd.product, COUNT(*) AS n, ROUND(SUM(sd.euro), 2) AS euros,
           GROUP_CONCAT(DISTINCT sd.property) AS seen_at
    FROM sales_detail sd
    WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.product = sd.product)
    GROUP BY sd.product
    ORDER BY euros DESC
  `);
  if (orphans.rows.length === 0) {
    console.log('  (none — every distinct product in sales_detail has at least one row in products)');
  } else {
    for (const r of orphans.rows) {
      console.log(`  ${String(r.product||'').padEnd(14)}  ${pad(fmt(r.n))} rows  €${pad(fmt(r.euros))}  seen_at=${r.seen_at}`);
    }
  }

  // ---------- 5. PARTIAL MATCH DIAGNOSTICS ------------------------------------
  // Combos missing but the (product, price_list, property) has OTHER euros in products
  console.log('\n=== MISSING COMBOS where (product,price_list,property) exists at OTHER euros ===');
  const priceDrift = await turso.execute(`
    SELECT sd.product, sd.price_list, sd.property, sd.euro AS sd_euro,
           COUNT(*) AS n,
           (SELECT GROUP_CONCAT(DISTINCT p.precio) FROM products p
             WHERE p.product=sd.product AND p.price_list=sd.price_list AND p.property=sd.property) AS known_prices
    FROM sales_detail sd
    LEFT JOIN products p
      ON sd.product=p.product AND sd.euro=p.precio
     AND sd.price_list=p.price_list AND sd.property=p.property
    WHERE p.product IS NULL
      AND EXISTS (SELECT 1 FROM products p2
                   WHERE p2.product=sd.product
                     AND p2.price_list=sd.price_list
                     AND p2.property=sd.property)
    GROUP BY sd.product, sd.price_list, sd.property, sd.euro
    ORDER BY n DESC
    LIMIT 20
  `);
  if (priceDrift.rows.length === 0) {
    console.log('  (no price-drift-style gaps)');
  } else {
    for (const r of priceDrift.rows) {
      console.log(`  ${String(r.product||'').padEnd(14)} ${String(r.price_list||'').padEnd(22)} ${String(r.property||'').padEnd(11)} sales_detail €${r.sd_euro}  n=${fmt(r.n)}   known prices in products: [${r.known_prices}]`);
    }
  }

  // Combos where (product, property) exists with a DIFFERENT price_list
  console.log('\n=== MISSING COMBOS where (product,property) exists under a DIFFERENT price_list ===');
  const priceListDrift = await turso.execute(`
    SELECT sd.product, sd.property, sd.price_list AS sd_price_list, sd.euro AS sd_euro,
           COUNT(*) AS n,
           (SELECT GROUP_CONCAT(DISTINCT p.price_list) FROM products p
             WHERE p.product=sd.product AND p.property=sd.property) AS known_price_lists
    FROM sales_detail sd
    LEFT JOIN products p
      ON sd.product=p.product AND sd.euro=p.precio
     AND sd.price_list=p.price_list AND sd.property=p.property
    WHERE p.product IS NULL
      AND NOT EXISTS (SELECT 1 FROM products p2
                       WHERE p2.product=sd.product
                         AND p2.price_list=sd.price_list
                         AND p2.property=sd.property)
      AND EXISTS (SELECT 1 FROM products p3
                   WHERE p3.product=sd.product AND p3.property=sd.property)
    GROUP BY sd.product, sd.property, sd.price_list, sd.euro
    ORDER BY n DESC
    LIMIT 20
  `);
  if (priceListDrift.rows.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of priceListDrift.rows) {
      console.log(`  ${String(r.product||'').padEnd(14)} ${String(r.property||'').padEnd(11)} €${r.sd_euro} sd_price_list=${r.sd_price_list}  n=${fmt(r.n)}   known lists: [${r.known_price_lists}]`);
    }
  }

  // ---------- 6. DISTINCT PROPERTIES + PRICE LISTS in sales_detail vs products
  console.log('\n=== DISTINCT VALUES ===');
  const sdProps = await turso.execute(`SELECT DISTINCT property FROM sales_detail ORDER BY property`);
  const pProps = await turso.execute(`SELECT DISTINCT property FROM products ORDER BY property`);
  console.log(`  sales_detail.property: ${sdProps.rows.map(r=>r.property).join(', ')}`);
  console.log(`  products.property:     ${pProps.rows.map(r=>r.property).join(', ')}`);

  const sdLists = await turso.execute(`SELECT DISTINCT price_list FROM sales_detail ORDER BY price_list`);
  const pLists = await turso.execute(`SELECT DISTINCT price_list FROM products ORDER BY price_list`);
  console.log(`  sales_detail.price_list: ${sdLists.rows.map(r=>r.price_list).join(', ')}`);
  console.log(`  products.price_list:     ${pLists.rows.map(r=>r.price_list).join(', ')}`);

  // ---------- 7. RECARGA / TARJETA specifically ------------------------------
  console.log('\n=== RECARGA / TARJETA rows (handled by override logic, not products join) ===');
  const rt = await turso.execute(`
    SELECT product, COUNT(*) AS n, ROUND(SUM(euro), 2) AS euros
    FROM sales_detail
    WHERE product IN ('RECARGA','TARJETA')
    GROUP BY product
  `);
  for (const r of rt.rows) console.log(`  ${r.product}: n=${fmt(r.n)} €${fmt(r.euros)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
