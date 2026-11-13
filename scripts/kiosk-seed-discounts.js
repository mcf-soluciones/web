/**
 * Loads the customer-card discounts from the old system's export: card number and percentage only, no names.
 * The export is from 2026-10-07, so check the list on /kiosko afterwards. Does nothing if discounts already exist.
 *
 * Usage:
 *   node scripts/kiosk-seed-discounts.js <folder-with-Cliente.csv>           show what would be added
 *   node scripts/kiosk-seed-discounts.js <folder-with-Cliente.csv> --apply   add it
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');
const fs = require('fs');
const path = require('path');

function readCsv(file) {
  const [head, ...lines] = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const columns = head.split(';');
  return lines.map(line => Object.fromEntries(line.split(';').map((value, i) => [columns[i], value])));
}

async function main() {
  const folder = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!folder) { console.error('Usage: node scripts/kiosk-seed-discounts.js <folder> [--apply]'); process.exit(1); }

  const customers = new Map(readCsv(path.join(folder, 'Cliente.csv')).map(c => [c.idCliente, Number(c.Descuento)]));
  const list = readCsv(path.join(folder, 'TarjetaCliente.csv'))
    .map(t => ({ uid: t.idTarjeta.trim().toUpperCase(), percent: Math.round(customers.get(t.idcliente) || 0) }))
    .filter(d => d.percent > 0);

  const counts = {};
  for (const d of list) counts[d.percent] = (counts[d.percent] || 0) + 1;
  console.log(`${list.length} cards with a discount:`, counts);

  const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  const existing = await turso.execute("SELECT COUNT(*) AS n FROM kiosk_card_discounts WHERE kiosk_id = 'K1'");
  if (Number(existing.rows[0].n) > 0) { console.log(`Already ${existing.rows[0].n} discounts for K1: nothing changed. Edit them on /kiosko.`); return; }
  if (!apply) { console.log('Nothing written. Run with --apply to add them.'); return; }

  await turso.batch(list.map(d => ({
    sql: `INSERT INTO kiosk_card_discounts (kiosk_id, uid, percent, updated_by, updated_at) VALUES ('K1', ?, ?, 'seed', datetime('now'))`,
    args: [d.uid, d.percent],
  })), 'write');
  console.log('Added. The kiosk receives them within a minute by day. Save prices once on /kiosko so their discounted prices get products rows.');
}

main().catch(err => { console.error(err); process.exit(1); });
