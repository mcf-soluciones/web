import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { checkPin, hashPin } from '../../api/_lib/kiosk-pin.js';
import { kioskConfig } from '../../api/_lib/kiosk-config.js';
import { currentAccountant, currentOwner, makeToken, readToken, requireOwner, requireReader, requireReports, scriptHeaders, signIn, signInAccountant, signOut } from '../../api/_lib/web-auth.js';
import { settingsRequest } from '../../api/_lib/kiosk-settings.js';
import { MEXICO_VISIBLE } from '../../api/_lib/sucursales.js';

// Set before any route loads its database client, so nothing here can reach production.
const dir = mkdtempSync(join(tmpdir(), 'web-auth-'));
const url = `file:${join(dir, 'web.db').replace(/\\/g, '/')}`;
process.env.TURSO_DATABASE_URL = url;
process.env.TURSO_AUTH_TOKEN = '';
process.env.MCF_SESSION_SECRET = 'test-secret';

const API = fileURLToPath(new URL('../../api/', import.meta.url));
const schema = readFileSync(new URL('../../scripts/schema-kiosk.sql', import.meta.url), 'utf8');
const db = createClient({ url });
const route = async name => (await import(pathToFileURL(join(API, `${name}.js`)).href)).default;

const OWNER_PIN = '123456';
const OTHER_PIN = '654321';
const ACCOUNTANT_PASSWORD = 'una-contraseña-larga-de-prueba';
const SIX_DIGIT_PASSWORD = '111111';

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(o) { this.body = o; return this; },
    end(o) { this.body = o; return this; },
  };
}

// What a browser would send back after this response.
function cookieHeader(res) {
  return [res.headers['set-cookie']].flat().map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ');
}

function signedIn(user, opts) {
  const res = fakeRes();
  signIn({ headers: {} }, res, user, opts);
  return { cookie: cookieHeader(res) };
}

const call = async (handler, req) => {
  const res = fakeRes();
  await handler({ method: 'POST', headers: {}, query: {}, ...req }, res);
  return res;
};

before(async () => {
  assert.ok(process.env.TURSO_DATABASE_URL.startsWith('file:'));
  for (const stmt of schema.split(/;\s*\n/).map(s => s.replace(/--[^\n]*/g, '').trim()).filter(s => s && !s.includes('sales_detail'))) await db.execute(stmt);
  await db.execute(`CREATE TABLE movements (id INTEGER PRIMARY KEY, movement TEXT, type TEXT, account TEXT, euros REAL, propiedad TEXT, mcf_user TEXT, date_real TEXT, description TEXT, icon TEXT, created_at TEXT)`);
  await db.execute(`CREATE TABLE incidents (id INTEGER PRIMARY KEY, summary TEXT, severity TEXT, propiedad TEXT, cost REAL, resolution TEXT, found TEXT, machine TEXT, incident_date TEXT)`);
  await db.execute(`CREATE TABLE surveys (id INTEGER PRIMARY KEY, name TEXT, survey_id TEXT, propiedad TEXT, experience TEXT, cleanliness TEXT, availability TEXT, recommend TEXT, comments TEXT, survey_date TEXT)`);
  for (const [user, pin] of [['lalo', OWNER_PIN], ['oscar', OTHER_PIN]]) {
    const h = hashPin(pin);
    await db.execute({ sql: `INSERT INTO kiosk_users (mcf_user, role, pin_salt, pin_hash, pin_iterations) VALUES (?, 'owner', ?, ?, ?)`, args: [user, h.pin_salt, h.pin_hash, h.pin_iterations] });
  }
  for (const [user, password] of [['contadora', ACCOUNTANT_PASSWORD], ['otra', SIX_DIGIT_PASSWORD]]) {
    const h = hashPin(password);
    await db.execute({ sql: `INSERT INTO kiosk_users (mcf_user, role, pin_salt, pin_hash, pin_iterations) VALUES (?, 'accountant', ?, ?, ?)`, args: [user, h.pin_salt, h.pin_hash, h.pin_iterations] });
  }
});

beforeEach(async () => {
  await db.execute('DELETE FROM kiosk_pin_guard');
  await db.execute('DELETE FROM movements');
  await db.execute('DELETE FROM kiosk_audit');
});

test('a token is refused if changed, expired, of another level or signed with another secret', () => {
  const now = 1_000_000;
  const token = makeToken({ user: 'lalo', level: 'reports', exp: now + 1000 });
  assert.equal(readToken(token, 'reports', now).user, 'lalo');
  assert.equal(readToken(token, 'session', now), null);
  assert.equal(readToken(token, 'reports', now + 1000), null);
  assert.equal(readToken(token, 'reports', now, 'other-secret'), null);
  assert.equal(readToken(`${token}x`, 'reports', now), null);
  const [, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ user: 'oscar', level: 'reports', exp: now + 1000 })).toString('base64url');
  assert.equal(readToken(`${forged}.${signature}`, 'reports', now), null);
  assert.equal(readToken('garbage', 'reports', now), null);
});

test('without a signing key nobody can sign in or get through', () => {
  const secret = process.env.MCF_SESSION_SECRET;
  const { cookie } = signedIn('lalo', { reports: true });
  delete process.env.MCF_SESSION_SECRET;
  try {
    assert.throws(() => makeToken({ user: 'lalo' }));
    assert.equal(currentOwner({ headers: { cookie } }), null);
    assert.equal(requireReports({ headers: { cookie } }, fakeRes()), null);
  } finally {
    process.env.MCF_SESSION_SECRET = secret;
  }
});

test('on the real site the key comes from the database token, and the token itself signs nothing', () => {
  const secret = process.env.MCF_SESSION_SECRET;
  delete process.env.MCF_SESSION_SECRET;
  process.env.TURSO_AUTH_TOKEN = 'a-database-token';
  try {
    const exp = Date.now() + 60_000;
    const token = makeToken({ user: 'lalo', level: 'session', exp });
    assert.equal(readToken(token, 'session').user, 'lalo');
    assert.equal(readToken(makeToken({ user: 'oscar', level: 'session', exp }, 'a-database-token'), 'session'), null);
    process.env.TURSO_AUTH_TOKEN = 'a-new-database-token';
    assert.equal(readToken(token, 'session'), null);
  } finally {
    process.env.MCF_SESSION_SECRET = secret;
    process.env.TURSO_AUTH_TOKEN = '';
  }
});

test('the cookies cannot be read by page scripts or sent by other sites, and are https-only on the real site', () => {
  const res = fakeRes();
  signIn({ headers: { 'x-forwarded-proto': 'https' } }, res, 'lalo', { reports: true });
  for (const c of res.headers['set-cookie']) {
    assert.match(c, /; Path=\/api; HttpOnly; SameSite=Strict; Secure/);
  }
});

test('signing in on /admin does not open Hub and Reportes: they ask again', () => {
  const headers = signedIn('lalo');
  assert.deepEqual(currentOwner({ headers }), { user: 'lalo', reports: false });
  assert.equal(requireOwner({ headers }, fakeRes()), 'lalo');
  const res = fakeRes();
  assert.equal(requireReports({ method: 'GET', headers }, res), null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.needs_pin, true);
});

test('the second PIN opens Hub and Reportes, and signing out closes everything', () => {
  const headers = signedIn('lalo', { reports: true });
  assert.equal(requireReports({ method: 'GET', headers }, fakeRes()), 'lalo');
  const res = fakeRes();
  signOut({ headers }, res);
  assert.equal(cookieHeader(res), '');
  for (const c of res.headers['set-cookie']) assert.match(c, /Max-Age=0/);
});

test('Hub and Reportes lapse after 30 minutes without use, use keeps them open, and never past 12 hours', () => {
  const start = Date.now();
  const first = fakeRes();
  signIn({ headers: {} }, first, 'lalo', { reports: true }, start);
  let cookie = cookieHeader(first);
  assert.equal(requireReports({ method: 'GET', headers: { cookie } }, fakeRes(), start + 31 * 60_000), null);

  // In use every 20 minutes: stays open, renewing each time.
  let now = start;
  for (let i = 0; i < 5; i++) {
    now += 20 * 60_000;
    const res = fakeRes();
    assert.equal(requireReports({ method: 'GET', headers: { cookie } }, res, now), 'lalo');
    const session = cookie.split('; ').find(c => c.startsWith('mcf_session'));
    cookie = [session, cookieHeader({ headers: { 'set-cookie': res.headers['set-cookie'] } })].join('; ');
  }

  // Past 12 hours, even in constant use.
  now = start;
  while (now + 20 * 60_000 < start + 12 * 3_600_000) {
    now += 20 * 60_000;
    const res = fakeRes();
    assert.equal(requireReports({ method: 'GET', headers: { cookie } }, res, now), 'lalo');
    if (res.headers['set-cookie']) cookie = cookieHeader(res);
  }
  assert.equal(requireReports({ method: 'GET', headers: { cookie } }, fakeRes(), start + 12 * 3_600_000 + 1), null);
});

test('a plain link goes back to the page, so the monthly export is not a page of JSON', () => {
  const res = fakeRes();
  assert.equal(requireReports({ method: 'GET', headers: { accept: 'text/html,application/xhtml+xml' } }, res), null);
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/reporte');
});

function allRoutes(folder = API) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(e => {
    if (e.name === '_lib') return [];
    const path = join(folder, e.name);
    if (e.isDirectory()) return allRoutes(path);
    return e.name.endsWith('.js') ? [relative(API, path).replace(/\\/g, '/').replace(/\.js$/, '')] : [];
  });
}

// Reachable without the second PIN, each on purpose. A new route is locked unless it is added here.
const OPEN = [
  'auth/cuentas', 'auth/pin',
  'gastos/create', 'movimientos', // signed in, tested below
  'tickets/generate', 'visitas',
  'kiosk/config', 'kiosk/heartbeat', 'kiosk/money', 'kiosk/reconcile', 'kiosk/settings', 'kiosk/status', 'kiosk/sync', 'kiosk/watch-tick',
];

test('every other route refuses anyone without the second PIN, before doing anything', async () => {
  const locked = allRoutes().filter(name => !OPEN.includes(name));
  assert.ok(locked.length > 50, `only ${locked.length} routes found`);
  for (const name of ['hub', 'reports/pnl', 'reports/monthly', 'export/month', 'balance-sheet/get', 'gastos/list', 'gastos/delete', 'financing/loans/list']) assert.ok(locked.includes(name), name);
  const headers = signedIn('lalo');
  for (const name of locked) {
    const handler = await route(name);
    for (const req of [{ method: 'GET', headers: {} }, { method: 'POST', headers: {}, body: {} }, { method: 'GET', headers }]) {
      const res = fakeRes();
      await handler({ query: {}, ...req }, res);
      assert.equal(res.statusCode, 401, `${name} ${req.method}`);
      assert.equal(res.body?.needs_pin, true, name);
    }
  }
});

// All she can reach. Read-only: each one answers only GET.
const ACCOUNTANT_ROUTES = ['reports/pnl', 'reports/gastos-detail', 'gastos/list', 'gastos/catalog', 'gastos/drive-folder', 'export/month'];

function accountantHeaders(nowMs) {
  const res = fakeRes();
  signInAccountant({ headers: {} }, res, 'contadora', nowMs);
  return { cookie: cookieHeader(res) };
}

test('the accountant reaches only her read-only routes, and every other route refuses her', async () => {
  const headers = accountantHeaders();
  for (const name of ACCOUNTANT_ROUTES) {
    const handler = await route(name);
    const res = fakeRes();
    await handler({ method: 'GET', query: {}, headers }, res);
    assert.notEqual(res.statusCode, 401, name);
    const post = fakeRes();
    await handler({ method: 'POST', query: {}, headers, body: {} }, post);
    assert.equal(post.statusCode, 405, `${name} must not accept a write`);
  }
  for (const name of allRoutes().filter(n => !OPEN.includes(n) && !ACCOUNTANT_ROUTES.includes(n))) {
    const handler = await route(name);
    for (const req of [{ method: 'GET', headers }, { method: 'POST', headers, body: {} }]) {
      const res = fakeRes();
      await handler({ query: {}, ...req }, res);
      assert.equal(res.statusCode, 401, `${name} ${req.method}`);
    }
  }
  // Open to staff or to a PIN, but a gasto, cash and kiosk money still want an owner.
  for (const [name, body] of [['gastos/create', { gasto: 10 }], ['movimientos', { type: 'deposito', euros: 50 }], ['kiosk/money', {}]]) {
    assert.equal((await call(await route(name), { headers, body })).statusCode, 401, name);
  }
  assert.equal(await settingsRequest(db, { action: 'load' }, currentOwner({ headers })?.user).then(r => r.status), 401);
});

test('her cookie is not an owner\'s, and an owner\'s second PIN still reads as an owner', () => {
  const headers = accountantHeaders();
  assert.equal(currentOwner({ headers }), null);
  assert.equal(currentAccountant({ headers }), 'contadora');
  assert.equal(requireOwner({ headers }, fakeRes()), null);
  assert.equal(requireReports({ method: 'GET', headers }, fakeRes()), null);
  assert.deepEqual(requireReader({ method: 'GET', headers }, fakeRes()), { user: 'contadora', role: 'accountant' });
  assert.deepEqual(requireReader({ method: 'GET', headers: signedIn('lalo', { reports: true }) }, fakeRes()), { user: 'lalo', role: 'owner' });
  assert.equal(requireReader({ method: 'GET', headers: signedIn('lalo') }, fakeRes()), null);
  assert.equal(requireReader({ method: 'GET', headers: {} }, fakeRes()), null);
  // Signed with the right secret, but claiming an owner's level under her cookie's name.
  const forged = makeToken({ user: 'contadora', level: 'reports', exp: Date.now() + 60_000 });
  assert.equal(currentAccountant({ headers: { cookie: `mcf_accountant=${forged}` } }), null);
});

test('her session lapses after 30 minutes without use, use keeps it open, and never past 12 hours', () => {
  const start = Date.now();
  let { cookie } = accountantHeaders(start);
  assert.equal(requireReader({ method: 'GET', headers: { cookie } }, fakeRes(), start + 31 * 60_000), null);

  let now = start;
  while (now + 20 * 60_000 < start + 12 * 3_600_000) {
    now += 20 * 60_000;
    const res = fakeRes();
    assert.equal(requireReader({ method: 'GET', headers: { cookie } }, res, now).user, 'contadora');
    if (res.headers['set-cookie']) cookie = cookieHeader(res);
  }
  assert.equal(requireReader({ method: 'GET', headers: { cookie } }, fakeRes(), start + 12 * 3_600_000 + 1), null);
});

test('a browser is one person: signing in as one ends the other', () => {
  const res = fakeRes();
  signInAccountant({ headers: { 'x-forwarded-proto': 'https' } }, res, 'contadora');
  for (const c of res.headers['set-cookie']) assert.match(c, /; Path=\/api; HttpOnly; SameSite=Strict; Secure/);
  const cleared = res.headers['set-cookie'].filter(c => /Max-Age=0/.test(c)).map(c => c.split('=')[0]);
  assert.deepEqual(cleared.sort(), ['mcf_reports', 'mcf_session']);

  const owner = fakeRes();
  signIn({ headers: {} }, owner, 'lalo', { reports: true });
  assert.ok(owner.headers['set-cookie'].some(c => c.startsWith('mcf_accountant=;') && /Max-Age=0/.test(c)));

  const out = fakeRes();
  signOut({ headers: {} }, out);
  assert.equal(out.headers['set-cookie'].length, 3);
  for (const c of out.headers['set-cookie']) assert.match(c, /Max-Age=0/);
});

test('her sign-in: wrong and right password, what it opens, and what gets noted', async () => {
  const cuentas = await route('auth/cuentas');
  const pin = await route('auth/pin');

  for (const password of ['nope', '', undefined, OWNER_PIN, 42]) {
    const wrong = await call(cuentas, { body: { password } });
    assert.equal(wrong.statusCode, 401, String(password));
    assert.equal(wrong.headers['set-cookie'], undefined);
    await db.execute('DELETE FROM kiosk_pin_guard');
  }

  const ok = await call(cuentas, { body: { password: ACCOUNTANT_PASSWORD } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.accountant, 'contadora');
  const headers = { cookie: cookieHeader(ok) };
  assert.deepEqual((await call(pin, { method: 'GET', headers })).body, { user: null, reports: false, accountant: 'contadora' });

  const out = await call(cuentas, { method: 'DELETE', headers });
  assert.equal(out.statusCode, 200);
  assert.equal(cookieHeader(out), '');

  assert.equal((await call(cuentas, { method: 'GET' })).statusCode, 405);

  const noted = (await db.execute(`SELECT mcf_user, action FROM kiosk_audit ORDER BY id`)).rows.map(r => `${r.mcf_user}:${r.action}`);
  assert.deepEqual(noted.slice(-2), ['null:web.accountant_wrong_password', 'contadora:web.accountant_signin']);
});

test('her wrong passwords and the owners\' wrong PINs have separate lockouts', async () => {
  const cuentas = await route('auth/cuentas');
  const pin = await route('auth/pin');

  for (let i = 0; i < 5; i++) await call(cuentas, { body: { password: 'nope' } });
  assert.equal((await call(cuentas, { body: { password: ACCOUNTANT_PASSWORD } })).statusCode, 429);
  assert.equal((await call(pin, { body: { pin: OWNER_PIN } })).statusCode, 200);

  await db.execute('DELETE FROM kiosk_pin_guard');
  for (let i = 0; i < 5; i++) await call(pin, { body: { pin: '000000' } });
  assert.equal((await call(pin, { body: { pin: OWNER_PIN } })).statusCode, 429);
  assert.equal((await call(cuentas, { body: { password: ACCOUNTANT_PASSWORD } })).statusCode, 200);
});

test('an accountant\'s password opens nothing an owner\'s PIN does, not even if it looks like one', async () => {
  assert.equal((await checkPin(db, SIX_DIGIT_PASSWORD)).ok, false);
  const config = await kioskConfig(db, { kiosk_id: 'K1' });
  assert.deepEqual(config.users.map(u => u.user), ['lalo', 'oscar']);
});

test('this repo\'s scripts can still call a report handler', () => {
  assert.equal(requireReports({ method: 'GET', headers: scriptHeaders() }, fakeRes()), 'script');
});

test('money needs a signed-in owner and is recorded under that owner, whatever the form sends', async () => {
  const movimientos = await route('movimientos');
  const count = { b20e: 1, b10e: 0, b5e: 1, m2e: 0, m1e: 0, m50e: 0, m20e: 0, m10e: 0, m5e: 0, propiedad: '(002) Hortaleza' };
  const rows = async () => (await db.execute('SELECT type, euros, mcf_user FROM movements ORDER BY id')).rows;

  for (const body of [{ type: 'transito', user: 'oscar', ...count }, { type: 'fondo_caja', user: 'oscar', ...count }, { type: 'deposito', mcf_user: 'oscar', euros: 50 }, { user: 'oscar', ...count }]) {
    const refused = await call(movimientos, { body });
    assert.equal(refused.statusCode, 401, body.type);
  }
  assert.equal((await rows()).length, 0);

  const headers = signedIn('lalo');
  for (const body of [{ type: 'transito', user: 'oscar', ...count }, { type: 'fondo_caja', user: 'oscar', ...count }, { type: 'deposito', mcf_user: 'oscar', euros: 50 }]) {
    assert.equal((await call(movimientos, { headers, body })).statusCode, 200, body.type);
  }
  const saved = await rows();
  assert.deepEqual(saved.map(r => r.mcf_user), ['lalo', 'lalo', 'lalo']);
  assert.deepEqual(saved.map(r => r.type), ['transito', 'fondo caja', 'deposito']);
  assert.deepEqual(saved.map(r => Number(r.euros)), [25, 25, 50]);
});

test('incidencias and customer surveys stay open, and old gasto posts stay gone', async () => {
  const movimientos = await route('movimientos');
  assert.equal((await call(movimientos, { body: { type: 'incidencia', propiedad: '(002) Hortaleza', description: 'x' } })).statusCode, 200);
  assert.equal((await call(movimientos, { body: { type: 'encuesta', location: 'hortaleza', survey_id: 'a' } })).statusCode, 200);
  assert.equal((await call(movimientos, { body: { type: 'gasto' } })).statusCode, 410);
});

test('a gasto needs a signed-in owner', async () => {
  const create = await route('gastos/create');
  const res = await call(create, { body: { mcf_user: 'oscar', gasto: 10 } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.needs_pin, true);
});

// A file database accepts { sql } with no args, but the live one throws on it. That broke every PIN on the real site while all tests passed.
test('every statement object has args, because the live database client requires them', () => {
  const files = dirs => dirs.flatMap(d => readdirSync(d, { withFileTypes: true }).flatMap(e => {
    const path = join(d, e.name);
    if (e.isDirectory()) return files([path]);
    return e.name.endsWith('.js') ? [path] : [];
  }));
  const missing = [];
  for (const file of files([API])) {
    if (file.replace(/\\/g, '/').endsWith('api/reports/timeseries.js')) continue; // its { sql } objects are WHERE fragments, not statements
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\{\s*sql\s*[:,}]/g)) {
      let depth = 0;
      let end = m.index;
      for (; end < text.length; end++) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}' && --depth === 0) break;
      }
      if (!/\bargs\b/.test(text.slice(m.index, end + 1))) missing.push(`${relative(API, file)}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('signing in: wrong and right PIN, what it opens, and what gets noted', async () => {
  const pin = await route('auth/pin');
  const wrong = await call(pin, { body: { pin: '000000' } });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);

  const ok = await call(pin, { body: { pin: OWNER_PIN } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.user, 'lalo');
  let headers = { cookie: cookieHeader(ok) };
  assert.deepEqual((await call(pin, { method: 'GET', headers })).body, { user: 'lalo', reports: false });

  // The Mexico toggle is only offered with Reportes open, so the lines around these stay exact whatever the flag says.
  const toggle = MEXICO_VISIBLE ? { mexico_visible: true } : {};
  const again = await call(pin, { headers, body: { pin: OWNER_PIN, reports: true } });
  headers = { cookie: cookieHeader(again) };
  assert.deepEqual((await call(pin, { method: 'GET', headers })).body, { user: 'lalo', reports: true, ...toggle });

  // The PIN says who it is, so another owner's PIN takes over.
  const other = await call(pin, { headers, body: { pin: OTHER_PIN, reports: true } });
  assert.deepEqual((await call(pin, { method: 'GET', headers: { cookie: cookieHeader(other) } })).body, { user: 'oscar', reports: true, ...toggle });

  assert.deepEqual((await call(pin, { method: 'GET' })).body, { user: null, reports: false });

  const noted = (await db.execute('SELECT mcf_user, action FROM kiosk_audit ORDER BY id')).rows.map(r => `${r.mcf_user}:${r.action}`);
  assert.deepEqual(noted, ['null:web.wrong_pin', 'lalo:web.signin', 'lalo:web.reports', 'oscar:web.reports']);
});

test('five wrong PINs lock it, and the right one does not get in until it clears', async () => {
  const pin = await route('auth/pin');
  for (let i = 0; i < 5; i++) await call(pin, { body: { pin: '000000' } });
  const res = await call(pin, { body: { pin: OWNER_PIN } });
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('the kiosk pages: signed in needs no PIN, and an empty try does not count towards the lockout', async () => {
  const money = await route('kiosk/money');
  assert.equal((await call(money, { headers: signedIn('lalo'), body: {} })).statusCode, 200);
  for (let i = 0; i < 6; i++) assert.equal((await call(money, { body: {} })).statusCode, 401);
  assert.equal((await call(money, { body: { pin: OWNER_PIN } })).statusCode, 200);

  await db.execute({ sql: `INSERT OR IGNORE INTO kiosks (kiosk_id, name, key_hash, company, price_list, property, propiedad_label, sales_user, sales_suffix) VALUES ('K1', 'x', 'x', 'mcf', 'cesar1', 'hortaleza', '(002) Hortaleza', 'local-hortaleza', '223501')`, args: [] });
  assert.equal((await settingsRequest(db, { action: 'load' }, 'lalo')).status, 200);
  assert.equal((await settingsRequest(db, { action: 'load' })).status, 401);
});
