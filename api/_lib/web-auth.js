import { createHmac, timingSafeEqual } from 'crypto';

/**
 * How the website remembers an owner once their PIN has been checked (kiosk-pin.js says who it is). Two signed cookies:
 *   mcf_session: signed in, for up to 12 hours. Enough for the money forms and the kiosk pages.
 *   mcf_reports: the PIN was asked again for Hub and Reportes. It lapses after 30 minutes without use.
 * The accountant has one of her own, which only the routes using requireReader accept:
 *   mcf_accountant: signed in at /cuentas. Same limits as mcf_reports.
 * HttpOnly so page scripts cannot read them, SameSite=Strict so other sites cannot send them.
 */
const SESSION = 'mcf_session';
const REPORTS = 'mcf_reports';
const ACCOUNTANT = 'mcf_accountant';
const SESSION_MS = 12 * 60 * 60 * 1000;
const REPORTS_IDLE_MS = 30 * 60 * 1000;
const RENEW_AFTER_MS = 5 * 60 * 1000;

const mac = (data, secret) => createHmac('sha256', secret).update(data).digest('base64url');

/**
 * What signs the cookies. Derived from the database token: only the server holds it, and it already opens everything
 * these cookies protect. Changing that token signs everyone out. MCF_SESSION_SECRET overrides it, for local work on a
 * file database, which has no token. With neither, nobody gets in.
 */
function signingKey() {
  if (process.env.MCF_SESSION_SECRET) return process.env.MCF_SESSION_SECRET;
  return process.env.TURSO_AUTH_TOKEN ? mac('mcf-web-session-v1', process.env.TURSO_AUTH_TOKEN) : null;
}

export function makeToken(claims, secret = signingKey()) {
  if (!secret) throw new Error('No signing key: TURSO_AUTH_TOKEN and MCF_SESSION_SECRET are both unset');
  const data = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${data}.${mac(data, secret)}`;
}

export function readToken(token, level, nowMs = Date.now(), secret = signingKey()) {
  if (!secret || !token) return null;
  const [data, signature] = String(token).split('.');
  if (!data || !signature) return null;
  const expected = Buffer.from(mac(data, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    return claims.level === level && claims.exp > nowMs ? claims : null;
  } catch {
    return null;
  }
}

function cookies(req) {
  const jar = {};
  for (const part of String(req.headers?.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) jar[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return jar;
}

function cookie(req, name, value) {
  const secure = req.headers?.['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `${name}=${value}; Path=/api; HttpOnly; SameSite=Strict${secure}${value ? '' : '; Max-Age=0'}`;
}

function idleClaims(user, level, nowMs, max) {
  return { user, level, exp: Math.min(nowMs + REPORTS_IDLE_MS, max), max, at: nowMs };
}

/** After a correct PIN. Signing in on /admin alone does not open Hub and Reportes, they ask again. */
export function signIn(req, res, user, { reports = false } = {}, nowMs = Date.now()) {
  const max = nowMs + SESSION_MS;
  res.setHeader('Set-Cookie', [
    cookie(req, SESSION, makeToken({ user, level: 'session', exp: max })),
    cookie(req, REPORTS, reports ? makeToken(idleClaims(user, 'reports', nowMs, max)) : ''),
    cookie(req, ACCOUNTANT, ''),
  ]);
}

/** After her correct password. A browser is one person at a time, so this also ends any owner session in it. */
export function signInAccountant(req, res, user, nowMs = Date.now()) {
  res.setHeader('Set-Cookie', [
    cookie(req, SESSION, ''),
    cookie(req, REPORTS, ''),
    cookie(req, ACCOUNTANT, makeToken(idleClaims(user, 'accountant', nowMs, nowMs + SESSION_MS))),
  ]);
}

export function signOut(req, res) {
  res.setHeader('Set-Cookie', [cookie(req, SESSION, ''), cookie(req, REPORTS, ''), cookie(req, ACCOUNTANT, '')]);
}

/** Who is signed in, or null. */
export function currentOwner(req, nowMs = Date.now()) {
  const jar = cookies(req);
  const reports = readToken(jar[REPORTS], 'reports', nowMs);
  const claims = reports || readToken(jar[SESSION], 'session', nowMs);
  return claims ? { user: claims.user, reports: !!reports } : null;
}

/** The accountant signed in here, or null. */
export function currentAccountant(req, nowMs = Date.now()) {
  return readToken(cookies(req)[ACCOUNTANT], 'accountant', nowMs)?.user ?? null;
}

function refuse(req, res) {
  // A plain link, like the monthly export: back to the page, which asks for the PIN.
  if (String(req.headers?.accept || '').includes('text/html')) {
    res.statusCode = 302;
    res.setHeader('Location', '/reporte');
    res.end();
    return null;
  }
  res.status(401).json({ error: 'Introduzca su PIN', needs_pin: true });
  return null;
}

/** The signed-in owner's name, or answers 401 and returns null. For the money forms. */
export function requireOwner(req, res, nowMs = Date.now()) {
  return currentOwner(req, nowMs)?.user ?? refuse(req, res);
}

// A valid idle-limited cookie, renewed so that use keeps it alive. Null if it is missing or lapsed.
function useIdleCookie(req, res, name, level, nowMs) {
  const claims = readToken(cookies(req)[name], level, nowMs);
  if (claims && nowMs - claims.at > RENEW_AFTER_MS) res.setHeader('Set-Cookie', cookie(req, name, makeToken(idleClaims(claims.user, level, nowMs, claims.max))));
  return claims;
}

/** The same for Hub and Reportes, which need the second PIN. Every use keeps it alive. */
export function requireReports(req, res, nowMs = Date.now()) {
  if (req.method === 'OPTIONS') return 'preflight';
  return useIdleCookie(req, res, REPORTS, 'reports', nowMs)?.user ?? refuse(req, res);
}

/**
 * For the few read-only routes the accountant may use: { user, role: 'owner' | 'accountant' }, or answers 401 and
 * returns null. Every other route keeps requireReports, so she is refused unless a route is switched to this on purpose.
 */
export function requireReader(req, res, nowMs = Date.now()) {
  if (req.method === 'OPTIONS') return { user: null, role: 'preflight' };
  const owner = useIdleCookie(req, res, REPORTS, 'reports', nowMs);
  if (owner) return { user: owner.user, role: 'owner' };
  const accountant = useIdleCookie(req, res, ACCOUNTANT, 'accountant', nowMs);
  return accountant ? { user: accountant.user, role: 'accountant' } : refuse(req, res);
}

/** For this repo's own scripts that call a report handler directly. */
export function scriptHeaders(nowMs = Date.now()) {
  const max = nowMs + REPORTS_IDLE_MS;
  return { cookie: `${REPORTS}=${makeToken(idleClaims('script', 'reports', nowMs, max))}` };
}
