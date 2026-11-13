/**
 * Registers a kiosk and prints its key once. The cloud keeps only a hash of the key.
 * Install the key on the kiosk with set-cloud-key.cmd.
 *
 * Usage:
 *   node scripts/kiosk-create.js K1            register Hortaleza's kiosk
 *   node scripts/kiosk-create.js K1 --rotate   issue a new key, the old one stops working
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');
const { createHash, randomBytes } = require('crypto');

const KNOWN = {
  K1: {
    name: 'Speed Queen Canillas', company: 'mcf', price_list: 'cesar1', property: 'hortaleza',
    propiedad_label: '(002) Hortaleza', sales_user: 'local-hortaleza', sales_suffix: '223501',
  },
};

async function main() {
  const [id, flag] = process.argv.slice(2);
  const kiosk = KNOWN[id];
  if (!kiosk) { console.error(`Unknown kiosk "${id}". Known: ${Object.keys(KNOWN).join(', ')}`); process.exit(1); }

  const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  const key = randomBytes(32).toString('base64url');
  const keyHash = createHash('sha256').update(key).digest('hex');
  const existing = await turso.execute({ sql: 'SELECT kiosk_id FROM kiosks WHERE kiosk_id = ?', args: [id] });

  if (existing.rows.length > 0) {
    if (flag !== '--rotate') { console.error(`${id} already exists. Use --rotate to replace its key.`); process.exit(1); }
    await turso.execute({ sql: 'UPDATE kiosks SET key_hash = ? WHERE kiosk_id = ?', args: [keyHash, id] });
  } else {
    await turso.execute({
      sql: `INSERT INTO kiosks (kiosk_id, name, key_hash, company, price_list, property, propiedad_label, sales_user, sales_suffix)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, kiosk.name, keyHash, kiosk.company, kiosk.price_list, kiosk.property, kiosk.propiedad_label, kiosk.sales_user, kiosk.sales_suffix],
    });
  }
  console.log(`Kiosk ${id} key (shown only now, paste it into set-cloud-key.cmd on the kiosk):\n${key}`);
}

main().catch(err => { console.error(err); process.exit(1); });
