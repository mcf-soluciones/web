/**
 * Seeds the laundries table with the two MCF-owned locations so the `mapa`
 * view has something to render on first load. Idempotent: if a row with the
 * same (name, propiedad_mcf=1) already exists, it's skipped.
 *
 * Coordinates are approximate centers from the address; refine via the UI.
 *
 * Usage:
 *   node scripts/seed-laundries.js
 */

require('dotenv').config();
const { createClient } = require('@libsql/client');

const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const SEEDS = [
  {
    name: 'MCF Usera',
    brand: 'MCF',
    address: 'Usera, Madrid',
    lat: 40.3856,
    lng: -3.7062,
    propiedad_mcf: 1,
  },
  {
    name: 'MCF Hortaleza',
    brand: 'MCF',
    address: 'Hortaleza, Madrid',
    lat: 40.4747,
    lng: -3.6411,
    propiedad_mcf: 1,
  },
];

async function main() {
  for (const s of SEEDS) {
    const existing = await turso.execute({
      sql: `SELECT id FROM laundries WHERE name = ? AND propiedad_mcf = 1 LIMIT 1`,
      args: [s.name],
    });
    if (existing.rows.length > 0) {
      console.log(`  SKIP  ${s.name} (id ${existing.rows[0].id})`);
      continue;
    }
    const rs = await turso.execute({
      sql: `INSERT INTO laundries (name, brand, address, lat, lng, propiedad_mcf, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [s.name, s.brand, s.address, s.lat, s.lng, s.propiedad_mcf, 'seed'],
    });
    console.log(`  INS   ${s.name} -> id ${Number(rs.lastInsertRowid)}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
