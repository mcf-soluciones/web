/**
 * Runs the real /api handlers and the pages of public/ on localhost against a throwaway database, so a kiosk build or
 * a page can be tested without touching production. Used by scripts/kiosk-e2e.js. Refuses to run against anything but
 * a file: database.
 *
 * Usage:
 *   node scripts/kiosk-dev-server.js <port> <path-to-db-file>
 */
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');

const [, , port = '3999', dbFile = 'kiosk-dev.db'] = process.argv;
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
delete process.env.TURSO_AUTH_TOKEN;

const API = path.join(__dirname, '..', 'api');
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function apiHandler(urlPath) {
  if (!urlPath.startsWith('/api/')) return null;
  const file = path.join(API, `${urlPath.slice('/api/'.length)}.js`);
  if (!file.startsWith(API) || file.includes('_lib') || !fs.existsSync(file)) return null;
  return (await import(pathToFileURL(file).href)).default;
}

function parseBody(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch { return raw; }
}

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const urlPath = req.url.split('?')[0];
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return res; };
  res.send = body => { res.end(body); return res; };
  const handler = await apiHandler(urlPath);
  if (!handler) {
    // Pages of public/, with clean URLs like Vercel, so /estado and /kiosko can be opened in a browser.
    const name = urlPath.replace(/^\/+/, '') || 'index';
    const file = [path.join(PUBLIC, name), path.join(PUBLIC, `${name}.html`)].find(f => f.startsWith(PUBLIC) && fs.existsSync(f) && fs.statSync(f).isFile());
    if (!file) return res.status(404).json({ error: 'not found' });
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    return res.end(fs.readFileSync(file));
  }
  req.body = parseBody(Buffer.concat(chunks).toString('utf8'));
  req.query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  return handler(req, res);
}).listen(Number(port), '127.0.0.1', () => console.log(`kiosk dev server on http://127.0.0.1:${port}, database ${dbFile}`));
