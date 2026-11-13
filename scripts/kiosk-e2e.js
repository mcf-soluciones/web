/**
 * End to end: the real kiosk code talking to the real handlers on a throwaway database. Nothing touches production.
 * Runs `Kiosk.exe --cloud-check` (a Debug build, which refuses anything but localhost) and checks the rows it produced.
 *
 * Usage:
 *   node scripts/kiosk-e2e.js <path-to-debug-Kiosk.exe>
 */
const { createClient } = require('@libsql/client');
const { createHash, randomBytes } = require('crypto');
const { spawn, spawnSync } = require('child_process');
const assert = require('assert/strict');
const { pathToFileURL } = require('url');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3987;
const exe = process.argv[2];

async function main() {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-e2e-')), 'cloud.db').replace(/\\/g, '/');
  const db = createClient({ url: `file:${dbFile}` });
  await db.batch([
    `CREATE TABLE sales (id INTEGER PRIMARY KEY AUTOINCREMENT, movement TEXT NOT NULL, type TEXT DEFAULT 'venta', account TEXT, euros REAL NOT NULL DEFAULT 0, mcf_user TEXT, date_real TEXT NOT NULL, icon TEXT DEFAULT 'g', created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, product TEXT NOT NULL, precio REAL NOT NULL, capacidad TEXT, product_price TEXT, product_size TEXT, product_mins INTEGER DEFAULT 0, product_mission TEXT, subproducto TEXT, day_subproduct_capacity INTEGER DEFAULT 0, day_product_capacity INTEGER DEFAULT 0, notes TEXT, price_list TEXT NOT NULL, property TEXT NOT NULL)`,
    `CREATE TABLE movements (id INTEGER PRIMARY KEY AUTOINCREMENT, movement TEXT NOT NULL, type TEXT NOT NULL, account TEXT DEFAULT 'cash', euros REAL NOT NULL DEFAULT 0, propiedad TEXT, mcf_user TEXT, date_real TEXT NOT NULL, description TEXT, icon TEXT, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE sales_detail (id INTEGER PRIMARY KEY AUTOINCREMENT, movid TEXT NOT NULL, date TEXT NOT NULL, yyyy INTEGER NOT NULL, mm INTEGER NOT NULL, dd INTEGER NOT NULL, time TEXT, hr INTEGER, min INTEGER, payment TEXT, product TEXT, euro REAL DEFAULT 0, company TEXT, dayweek TEXT, price_list TEXT, property TEXT)`,
  ], 'write');
  const schema = fs.readFileSync(path.join(__dirname, 'schema-kiosk.sql'), 'utf8');
  for (const stmt of schema.split(/;\s*\n/).map(s => s.replace(/--[^\n]*/g, '').trim()).filter(Boolean)) await db.execute(stmt);
  const products = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'kiosk', 'products-hortaleza.json'), 'utf8'));
  for (const p of products) await db.execute({ sql: 'INSERT INTO products (product, precio, price_list, property) VALUES (?, ?, ?, ?)', args: [p.product, p.precio, p.price_list, p.property] });

  const key = randomBytes(32).toString('base64url');
  await db.execute({
    sql: `INSERT INTO kiosks (kiosk_id, name, key_hash, company, price_list, property, propiedad_label, sales_user, sales_suffix)
          VALUES ('K1', 'Speed Queen Canillas', ?, 'mcf', 'cesar1', 'hortaleza', '(002) Hortaleza', 'local-hortaleza', '223501')`,
    args: [createHash('sha256').update(key).digest('hex')],
  });

  await db.execute({
    sql: `INSERT INTO kiosk_users (mcf_user, role, pin_salt, pin_hash, pin_iterations) VALUES ('lalo', 'owner', ?, ?, 1000)`,
    args: ['00112233445566778899aabbccddeeff', 'f2eacbaee38bb06b3e9b26e798534a180bc1ead9634c4509b09820d6ce4b8df1'],
  });

  await db.execute({ sql: 'INSERT INTO kiosk_settings (kiosk_id, settings) VALUES (?, ?)', args: ['K1', JSON.stringify({ home_notice: 'Aviso e2e', ports: 'COM1' })] });
  await db.execute(`INSERT INTO kiosk_card_discounts (kiosk_id, uid, percent) VALUES ('K1', '96519FBE', 10)`);

  const server = spawn(process.execPath, [path.join(__dirname, 'kiosk-dev-server.js'), String(PORT), dbFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      server.stdout.once('data', resolve);
      server.once('exit', code => reject(new Error(`dev server exited with ${code}`)));
    });

    const run = spawnSync(exe, ['--cloud-check', `http://127.0.0.1:${PORT}`, key], { encoding: 'utf8', timeout: 90000 });
    console.log(`kiosk exit ${run.status}`, run.stdout || '', run.stderr || '');
    assert.equal(run.status, 0, 'the kiosk left something unsent');
    assert.match(run.stdout, /pins \[lalo\]/, 'the kiosk must receive the PIN list');
    assert.match(run.stdout, /discount 10,/, 'the kiosk must receive the discounts');
    assert.match(run.stdout, /notice \[Aviso e2e\]/, 'the kiosk must receive the settings');
    assert.match(run.stdout, /saved True/, 'the kiosk must keep the settings for its next start');

    const rows = (await db.execute('SELECT * FROM sales_detail ORDER BY movid')).rows;
    console.table(rows.map(r => ({ movid: r.movid, time: r.time, payment: r.payment, product: r.product, euro: r.euro, dayweek: r.dayweek })));
    assert.equal(rows.length, 5, 'five completed sales, the failed one stays out');
    const byMovid = suffix => rows.find(r => r.movid.endsWith(suffix) && !r.movid.startsWith('K1R'));
    assert.equal(byMovid('0001').product, 'LAVADORA 3');
    assert.equal(byMovid('0001').payment, 'EFECTIVO');
    assert.equal(byMovid('0001').euro, 7);
    assert.equal(byMovid('0002').product, 'SECADORA 5');
    assert.equal(byMovid('0002').payment, 'TARJETA BANCO');
    assert.equal(byMovid('0002').euro, 7.5);
    assert.equal(byMovid('0003').payment, 'TARJETA CLIENTE');
    assert.equal(byMovid('0003').euro, 7.2);
    assert.equal(byMovid('0004').product, 'TARJETA');
    const topup = rows.find(r => r.movid.startsWith('K1R'));
    assert.equal(topup.product, 'RECARGA');
    assert.equal(topup.euro, 10);
    for (const r of rows) {
      assert.equal(r.company, 'mcf');
      assert.equal(r.price_list, 'cesar1');
      assert.equal(r.property, 'hortaleza');
      assert.match(r.time, /^\d\d:\d\d:\d\d$/);
      assert.match(r.dayweek, /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/);
    }

    const rollup = (await db.execute('SELECT * FROM sales ORDER BY account')).rows;
    console.table(rollup.map(r => ({ movement: r.movement, account: r.account, euros: r.euros, user: r.mcf_user, date: r.date_real })));
    assert.deepEqual(rollup.map(r => [r.account, r.euros]), [['banco', 17.5], ['cash', 27]]);
    assert.match(rollup[0].movement, /^VentasDia\d{6}_223501 \[banco\]$/);

    const join = (await db.execute(`SELECT d.product, d.euro FROM sales_detail d LEFT JOIN products p
      ON d.product = p.product AND d.euro = p.precio AND d.price_list = p.price_list AND d.property = p.property WHERE p.product IS NULL`)).rows;
    assert.deepEqual(join.map(r => r.product).sort(), ['RECARGA', 'TARJETA'], 'only RECARGA and TARJETA may miss the products join');

    const movements = (await db.execute('SELECT * FROM movements ORDER BY type DESC')).rows;
    console.table(movements.map(m => ({ movement: m.movement, type: m.type, euros: m.euros, propiedad: m.propiedad, user: m.mcf_user })));
    assert.equal(movements.length, 2, 'one pull and one coin load, once each');
    assert.equal(movements[0].type, 'transito');
    assert.equal(movements[0].euros, 75);
    assert.equal(movements[0].propiedad, '(002) Hortaleza');
    assert.equal(movements[0].mcf_user, 'lalo');
    assert.match(movements[0].description, /^Count de billetes: 20e = 2, 10e = 1, 5e = 5 - Count de Monedas: 2e = 0, /);
    assert.equal(movements[1].type, 'fondo caja');
    assert.equal(movements[1].euros, 2.5);
    assert.equal(movements[1].mcf_user, 'adrian');

    const failed = (await db.execute(`SELECT status, post_state FROM kiosk_sales WHERE status = 'activation_failed'`)).rows;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].post_state, 'pending');

    assert.equal((await db.execute('SELECT COUNT(*) n FROM kiosk_card_moves')).rows[0].n, 1);
    assert.equal((await db.execute('SELECT COUNT(*) n FROM kiosk_events')).rows[0].n, 1);

    const status = (await db.execute('SELECT * FROM kiosk_status')).rows[0];
    const payload = JSON.parse(status.payload);
    console.log('heartbeat:', status.app_version, 'next due', status.next_due_at, 'skew', status.clock_skew_s, 'coins low', payload.coins_low, 'pc', payload.pc);
    assert.equal(payload.selling, true);
    assert.deepEqual(payload.coins_low, [50]);
    assert.equal(payload.devices.bank.ok, true);
    assert.equal(payload.machines.length, 7);
    assert.equal(payload.outbox.parked, 0);
    const { settingsProblem, chargeableProducts } = await import(pathToFileURL(path.join(__dirname, '..', 'api', '_lib', 'kiosk-settings.js')).href);
    const machines = Object.keys(payload.settings.prices);
    assert.equal(machines.length, 7);
    assert.equal(settingsProblem(payload.settings, machines), null, 'the settings the kiosk reports must pass the rules of /kiosko');
    assert.equal(typeof payload.settings.black_screen_from, 'string', '/kiosko starts its black screen field from what the kiosk reports');
    assert.ok(chargeableProducts(payload.settings).length > 40);
    assert.ok(!JSON.stringify(payload).includes('KeyA') && !JSON.stringify(payload).toLowerCase().includes('keya'), 'the card key must never leave the kiosk');

    const recon = (await db.execute('SELECT * FROM kiosk_recon')).rows;
    console.table(recon.map(r => ({ date: r.date, status: r.status, detail: r.detail })));
    assert.ok(recon.length >= 1);
    assert.ok(recon.every(r => r.status === 'ok'), 'the night check must pass');

    const publicStatus = await (await fetch(`http://127.0.0.1:${PORT}/api/kiosk/status`)).json();
    const text = JSON.stringify(publicStatus);
    assert.ok(!text.includes('hopper_cents') && !text.includes('notes_cents'), 'the public status leaked money');
    console.log('public status:', publicStatus.kiosks[0].state, publicStatus.kiosks[0].problems);

    const denied = await fetch(`http://127.0.0.1:${PORT}/api/kiosk/heartbeat`, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' });
    assert.equal(denied.status, 401);

    console.log('\nEND TO END OK');
    if (process.env.KIOSK_E2E_KEEP) {
      console.log(`Left running for a look at the pages: http://127.0.0.1:${PORT}/estado`);
      await new Promise(() => {});
    }
  } finally {
    server.kill();
    db.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
