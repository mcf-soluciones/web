require('dotenv').config();
const { createClient } = require('@libsql/client');
const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

async function main() {
  // 1. Column list
  const cols = await turso.execute(`PRAGMA table_info(products)`);
  console.log('\n=== products columns ===');
  for (const c of cols.rows) console.log(`  ${c.name}  (${c.type})`);

  // 2. Sample rows for each missing combo group
  const targets = [
    { product: 'SECADORA 1', price_list: 'edusanferric1', property: 'usera' },
    { product: 'SECADORA 2', price_list: 'edusanferric1', property: 'usera' },
    { product: 'SECADORA 3', price_list: 'edusanferric1', property: 'usera' },
    { product: 'SECADORA 3', price_list: 'mcf1', property: 'usera' },
    { product: 'SECADORA 2', price_list: 'mcf1', property: 'usera' },
    { product: 'SECADORA 1', price_list: 'mcf1', property: 'usera' },
    { product: 'SECADORA 5', price_list: 'cesar1', property: 'hortaleza' },
    { product: 'SECADORA 6', price_list: 'cesar1', property: 'hortaleza' },
    { product: 'SECADORA 7', price_list: 'cesar1', property: 'hortaleza' },
    { product: 'LAVADORA 3', price_list: 'cesar1', property: 'hortaleza' },
    { product: 'LAVADORA 4', price_list: 'cesar1', property: 'hortaleza' },
    { product: 'LAVADORA 6', price_list: 'edusanferric1', property: 'usera' },
    { product: 'LAVADORA 7', price_list: 'edusanferric1', property: 'usera' },
  ];
  for (const t of targets) {
    console.log(`\n=== ${t.product} / ${t.price_list} / ${t.property} siblings ===`);
    const r = await turso.execute({
      sql: `SELECT precio, product_size, product_mission, product_price, subproducto,
                   product_mins, capacidad, day_subproduct_capacity, day_product_capacity
            FROM products
            WHERE product = ? AND price_list = ? AND property = ?
            ORDER BY precio`,
      args: [t.product, t.price_list, t.property],
    });
    if (r.rows.length === 0) { console.log('  (no siblings at all)'); continue; }
    console.log(`  precio  size mission      price       mins capac sub`);
    for (const s of r.rows) {
      console.log(`  ${String(s.precio).padStart(6)} ${String(s.product_size||'-').padEnd(5)} ${String(s.product_mission||'-').padEnd(11)} ${String(s.product_price||'-').padEnd(11)} ${String(s.product_mins||'-').padStart(4)} ${String(s.capacidad||'-').padEnd(5)} ${s.subproducto||'-'}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
