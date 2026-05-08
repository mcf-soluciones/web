import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { pathToFileURL } from 'node:url';

// Load .env
const envPath = path.resolve('.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const PUBLIC_DIR = path.resolve('public');
const API_DIR = path.resolve('api');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
    req.on('error', reject);
  });
}

function makeRes(res) {
  return {
    _status: 200,
    _headers: {},
    setHeader(k, v) { this._headers[k] = v; res.setHeader(k, v); },
    status(code) { this._status = code; return this; },
    json(obj) {
      res.writeHead(this._status, { 'Content-Type': 'application/json', ...this._headers });
      res.end(JSON.stringify(obj));
    },
    send(data) {
      res.writeHead(this._status, this._headers);
      res.end(data);
    },
  };
}

async function handleApi(pathname, req, res) {
  const name = pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const file = path.join(API_DIR, name + '.js');
  if (!fs.existsSync(file)) {
    res.writeHead(404); res.end('API not found'); return;
  }
  const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
  const handler = mod.default;
  const body = await readBody(req);
  const fakeReq = { method: req.method, body, headers: req.headers, url: req.url };
  await handler(fakeReq, makeRes(res));
}

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let fp = path.join(PUBLIC_DIR, rel);

  // cleanUrls: /admin -> /admin.html
  if (!fs.existsSync(fp) && !path.extname(fp)) {
    const alt = fp + '.html';
    if (fs.existsSync(alt)) fp = alt;
  }

  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext = path.extname(fp).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);
  console.log(req.method, pathname);
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(pathname, req, res);
    } else {
      serveStatic(pathname, res);
    }
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end(String(e));
  }
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`Local server on http://localhost:${port}`);
});
