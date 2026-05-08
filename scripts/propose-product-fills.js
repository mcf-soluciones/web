/**
 * Propose INSERT rows into `products` for every sales_detail gap that isn't
 * RECARGA / TARJETA (those are handled by override logic).
 *
 * For each missing (product, euro, price_list, property):
 *   - fetch sibling rows (same product/price_list/property, any precio)
 *   - copy product_mission, product_size, capacidad, subproducto,
 *     day_subproduct_capacity, day_product_capacity from the most common
 *     sibling values (they're consistent per product × property)
 *   - derive product_mins by looking at the two nearest sibling prices and
 *     taking their product_mins (if both agree → use it; if they differ →
 *     use the sibling with the nearest precio)
 *   - classify product_price with a conservative rule: 'descuento' (safe default)
 *
 * Writes `scripts/proposed-product-inserts.json` for manual review.
 * Run again with `--apply` to actually INSERT.
 *
 * Usage:
 *   node scripts/propose-product-fills.js            # dry run → write JSON
 *   node scripts/propose-product-fills.js --apply    # actually INSERT
 */
require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@libsql/client');
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const APPLY = process.argv.includes('--apply');
const OUT_PATH = 'scripts/proposed-product-inserts.json';

async function main() {
  // If the JSON already exists and --apply is set, use whatever the user left
  // in the file (so they can hand-edit mins/size before committing).
  if (APPLY && fs.existsSync(OUT_PATH)) {
    return applyFromJson();
  }

  // ---------- 1. Get all missing combos (excluding RECARGA / TARJETA) -------
  const gaps = await turso.execute(`
    SELECT sd.product, sd.euro, sd.price_list, sd.property,
           COUNT(*) AS n_rows,
           ROUND(SUM(sd.euro), 2) AS euros_total,
           MIN(sd.date) AS first_seen,
           MAX(sd.date) AS last_seen
    FROM sales_detail sd
    LEFT JOIN products p
      ON sd.product = p.product AND sd.euro = p.precio
     AND sd.price_list = p.price_list AND sd.property = p.property
    WHERE p.product IS NULL
      AND sd.product NOT IN ('RECARGA', 'TARJETA')
    GROUP BY sd.product, sd.euro, sd.price_list, sd.property
    ORDER BY euros_total DESC
  `);

  console.log(`\n${gaps.rows.length} real gaps to propose fills for`);

  const proposals = [];
  const skipped = [];

  for (const g of gaps.rows) {
    const siblings = await turso.execute({
      sql: `SELECT precio, product_size, product_mission, product_price, subproducto,
                   product_mins, capacidad, day_subproduct_capacity, day_product_capacity
            FROM products
            WHERE product = ? AND price_list = ? AND property = ?
            ORDER BY precio`,
      args: [g.product, g.price_list, g.property],
    });

    if (siblings.rows.length === 0) {
      skipped.push({
        product: g.product, euro: g.euro, price_list: g.price_list, property: g.property,
        n_rows: g.n_rows, euros_total: g.euros_total,
        reason: 'no siblings to derive fields from',
      });
      continue;
    }

    // Copy the most common values from siblings for constant fields.
    const mode = (key) => {
      const counts = new Map();
      for (const s of siblings.rows) {
        const v = s[key];
        if (v === null || v === undefined) continue;
        counts.set(v, (counts.get(v) || 0) + 1);
      }
      let best = null, bestN = -1;
      for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
      return best;
    };

    const product_size = mode('product_size');
    const product_mission = mode('product_mission');
    const capacidad = mode('capacidad');
    const subproducto = mode('subproducto');
    const day_subproduct_capacity = mode('day_subproduct_capacity');
    const day_product_capacity = mode('day_product_capacity');

    // Derive product_mins by finding the nearest sibling precio and copying.
    // If we're below/above the full range, use the nearest endpoint.
    let product_mins = null;
    let mins_source = null;
    const siblingsWithMins = siblings.rows.filter(s => s.product_mins != null);
    if (siblingsWithMins.length > 0) {
      const nearest = siblingsWithMins.reduce((best, s) => {
        const d = Math.abs(Number(s.precio) - Number(g.euro));
        if (best == null || d < best.d) return { s, d };
        return best;
      }, null);
      product_mins = nearest.s.product_mins;
      mins_source = `nearest sibling precio=${nearest.s.precio} (Δ${nearest.d.toFixed(2)})`;
    }

    // Conservative price tier: 'descuento' since historical gaps are usually
    // promotional / discount prices the user ran.
    const product_price = 'descuento';

    proposals.push({
      // Missing combo
      product: g.product,
      precio: Number(g.euro),
      price_list: g.price_list,
      property: g.property,
      n_rows_affected: Number(g.n_rows),
      euros_affected: Number(g.euros_total),
      first_seen: g.first_seen,
      last_seen: g.last_seen,
      // Proposed catalog fields
      product_size,
      product_mission,
      product_price,
      subproducto,
      product_mins,
      product_mins_source: mins_source,
      capacidad,
      day_subproduct_capacity,
      day_product_capacity,
      notes: `Auto-proposed from sibling (${siblings.rows.length} known prices for ${g.product}/${g.price_list}/${g.property})`,
      siblings: siblings.rows.map(s => ({ precio: s.precio, mins: s.product_mins, price: s.product_price })),
    });
  }

  // ---------- 2. Write proposals to JSON for review -------------------------
  fs.writeFileSync(OUT_PATH, JSON.stringify({ proposals, skipped }, null, 2));
  console.log(`\n=== Proposals written to ${OUT_PATH} ===`);
  console.log(`  ${proposals.length} rows ready to insert`);
  console.log(`  ${skipped.length} skipped (no siblings — need manual review)`);
  if (skipped.length) {
    console.log('\nSkipped:');
    for (const s of skipped) console.log(`  ${s.product} €${s.euro} ${s.price_list} ${s.property}  (${s.n_rows} rows, €${s.euros_total})`);
  }

  // ---------- 3. Summary table of proposals --------------------------------
  console.log('\n=== Proposal summary (top 20 by impact) ===');
  console.log(`  ${'product'.padEnd(14)} ${'€'.padStart(7)} ${'price_list'.padEnd(22)} ${'property'.padEnd(11)} ${'size'.padEnd(5)} ${'mins'.padStart(5)} ${'rows'.padStart(5)} ${'€ total'.padStart(10)}`);
  for (const p of proposals.slice(0, 20)) {
    console.log(`  ${String(p.product).padEnd(14)} ${String(p.precio).padStart(7)} ${String(p.price_list).padEnd(22)} ${String(p.property).padEnd(11)} ${String(p.product_size||'-').padEnd(5)} ${String(p.product_mins||'-').padStart(5)} ${String(p.n_rows_affected).padStart(5)} ${String(p.euros_affected).padStart(10)}`);
  }

  console.log('\nDry run only. Review the JSON, edit if needed, then re-run with --apply to INSERT.');
}

async function applyFromJson() {
  const { proposals } = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  console.log(`\n=== Applying ${proposals.length} inserts from ${OUT_PATH} ===`);
  let inserted = 0, skipped_existing = 0;
  for (const p of proposals) {
    // Guard against double-insert if the combo was already added since the
    // proposal was generated.
    const check = await turso.execute({
      sql: `SELECT 1 FROM products WHERE product=? AND precio=? AND price_list=? AND property=? LIMIT 1`,
      args: [p.product, p.precio, p.price_list, p.property],
    });
    if (check.rows.length > 0) {
      skipped_existing++;
      console.log(`  SKIP (already exists): ${p.product} €${p.precio} / ${p.price_list} / ${p.property}`);
      continue;
    }
    await turso.execute({
      sql: `INSERT INTO products (
              product, precio, capacidad, product_price, product_size,
              product_mins, product_mission, subproducto,
              day_subproduct_capacity, day_product_capacity,
              notes, price_list, property
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        p.product, p.precio, p.capacidad, p.product_price, p.product_size,
        p.product_mins, p.product_mission, p.subproducto,
        p.day_subproduct_capacity, p.day_product_capacity,
        p.notes, p.price_list, p.property,
      ],
    });
    inserted++;
    console.log(`  INS  ${p.product} €${p.precio} ${p.price_list}/${p.property}  size=${p.product_size} mins=${p.product_mins}`);
  }
  console.log(`\n  done: ${inserted} inserted, ${skipped_existing} already existed`);
}

main().catch(e => { console.error(e); process.exit(1); });
