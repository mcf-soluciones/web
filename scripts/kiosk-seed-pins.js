/**
 * Sets the owners' 6-digit PINs from a JSON file: { "lalo": "123456", "adrian": "...", "oscar": "..." }.
 * The file holds the PINs in clear, so it lives outside the repos, and Turso only receives hashes. The first run
 * creates it with random PINs. To change a PIN, edit the file and run this again.
 * PINs must differ between people, because there is no username.
 *
 * Usage:
 *   node scripts/kiosk-seed-pins.js [file]      (default: mcf-kiosk-pins.json in your home folder)
 */
require('dotenv').config();
const { createClient } = require('@libsql/client');
const { pbkdf2Sync, randomBytes, randomInt } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ITERATIONS = 150000; // same as api/_lib/kiosk-pin.js and the kiosk
const OWNERS = ['lalo', 'adrian', 'oscar'];

function randomPins() {
  const pins = new Set();
  while (pins.size < OWNERS.length) pins.add(String(randomInt(1000000)).padStart(6, '0'));
  const list = [...pins];
  return Object.fromEntries(OWNERS.map((owner, i) => [owner, list[i]]));
}

function readPins(file) {
  let saved;
  // Not the parser's own message, which can quote the file and so a PIN.
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON.`); }
  const pins = Object.entries(saved).map(([user, pin]) => [user, String(pin)]);
  for (const [user, pin] of pins) {
    if (!OWNERS.includes(user)) throw new Error(`Unknown owner "${user}". Owners are: ${OWNERS.join(', ')}.`);
    if (!/^\d{6}$/.test(pin)) throw new Error(`The PIN for ${user} must be exactly 6 digits.`);
  }
  if (new Set(pins.map(([, pin]) => pin)).size < pins.length) throw new Error('Two owners have the same PIN. Each one needs a different PIN.');
  return pins;
}

async function main() {
  const file = process.argv[2] || path.join(os.homedir(), 'mcf-kiosk-pins.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${JSON.stringify(randomPins(), null, 2)}\n`);
    console.log(`Created ${file} with random PINs.`);
  }
  const pins = readPins(file);

  const turso = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  await turso.batch(pins.map(([user, pin]) => {
    const salt = randomBytes(16).toString('hex');
    return {
      sql: `INSERT INTO kiosk_users (mcf_user, role, pin_salt, pin_hash, pin_iterations) VALUES (?, 'owner', ?, ?, ?)
            ON CONFLICT(mcf_user) DO UPDATE SET pin_salt = excluded.pin_salt, pin_hash = excluded.pin_hash,
              pin_iterations = excluded.pin_iterations, updated_at = datetime('now')`,
      args: [user, salt, pbkdf2Sync(pin, Buffer.from(salt, 'hex'), ITERATIONS, 32, 'sha256').toString('hex'), ITERATIONS],
    };
  }), 'write');
  console.log(`PINs set for: ${pins.map(([user]) => user).join(', ')}.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
