/**
 * Adds the products rows for SECADORA 5 at 2.00 per cycle after 21:15, so those sales join in the reports.
 * Each new row copies the row of the same drying time at the day price. Existing rows are never changed.
 * 10.00 already exists: it is 4 cycles at 2.50, and 5 cycles at 2.00 will report under it as 40 minutes.
 *
 * Usage:
 *   node scripts/kiosk-seed-products.js           show what would be added
 *   node scripts/kiosk-seed-products.js --apply   add it
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');

const SEED = [
  { precio: 2, dayPrice: 2.5 },
  { precio: 4, dayPrice: 5 },
  { precio: 6, dayPrice: 7.5 },
  { precio: 8, dayPrice: 10 },
];
const KEY = { product: 'SECADORA 5', price_list: 'cesar1', property: 'hortaleza' };

async function main() {
  const apply = process.argv.includes('--apply');
  const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

  for (const { precio, dayPrice } of SEED) {
    const where = 'product = ? AND precio = ? AND price_list = ? AND property = ?';
    const already = await turso.execute({ sql: `SELECT id FROM products WHERE ${where}`, args: [KEY.product, precio, KEY.price_list, KEY.property] });
    if (already.rows.length > 0) { console.log(`  exists ${KEY.product} ${precio}`); continue; }

    const sibling = (await turso.execute({ sql: `SELECT * FROM products WHERE ${where}`, args: [KEY.product, dayPrice, KEY.price_list, KEY.property] })).rows[0];
    if (!sibling) { console.error(`  no row at ${dayPrice} to copy for ${precio}`); process.exitCode = 1; continue; }

    console.log(`  ${apply ? 'add' : 'would add'} ${KEY.product} ${precio}: ${sibling.product_mins} min, ${sibling.capacidad}, size ${sibling.product_size}, ${sibling.product_mission}`);
    if (!apply) continue;
    await turso.execute({
      sql: `INSERT INTO products (product, precio, capacidad, product_price, product_size, product_mins, product_mission, subproducto,
              day_subproduct_capacity, day_product_capacity, notes, price_list, property)
            VALUES (?, ?, ?, 'publico', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [KEY.product, precio, sibling.capacidad, sibling.product_size, sibling.product_mins, sibling.product_mission, sibling.subproducto,
        sibling.day_subproduct_capacity, sibling.day_product_capacity, 'Kiosk v3: 2.00 per cycle after 21:15', KEY.price_list, KEY.property],
    });
  }
  if (!apply) console.log('Nothing written. Run with --apply to add these rows.');
}

main().catch(err => { console.error(err); process.exit(1); });
