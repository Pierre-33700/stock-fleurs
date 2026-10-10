'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { openStore, HttpError } = require('./store');
const { createAuth } = require('./auth');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'stock.db');
const PUBLIC = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PRODUCTION = process.env.NODE_ENV === 'production';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};
// Fichiers accessibles sans être connecté (page de connexion et ce dont elle a besoin).
const PUBLIC_FILES = new Set(['/login.html', '/login.js', '/style.css', '/icon.svg', '/manifest.webmanifest']);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const auth = createAuth(process.env.ACCESS_PASSWORD || '');
if (PRODUCTION && !auth.enabled) {
  console.error('ACCESS_PASSWORD est obligatoire en production (NODE_ENV=production). Arrêt.');
  process.exit(1);
}
const store = openStore(DB_PATH);

const isSecure = (req) => TRUST_PROXY ? req.headers['x-forwarded-proto'] === 'https' : process.env.COOKIE_SECURE === '1';
const clientIp = (req) => (TRUST_PROXY && (req.headers['fly-client-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket.remoteAddress || 'inconnu';

function baseHeaders(req, extra) {
  const h = {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': CSP, ...extra,
  };
  if (isSecure(req)) h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}

function send(req, res, status, body, headers = {}) {
  res.writeHead(status, baseHeaders(req, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }));
  res.end(JSON.stringify(body));
}

function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Format de requête non pris en charge.');
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10_000) { reject(new HttpError(413, 'Requête trop volumineuse.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'JSON invalide.')); }
    });
    req.on('error', reject);
  });
}

const authed = (req) => auth.valid(auth.fromCookieHeader(req.headers.cookie));

async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  const ok = (status, body, headers) => send(req, res, status, body, headers);

  if (m === 'POST' && p === '/api/login') {
    if (!auth.enabled) return ok(200, { ok: true });
    const r = auth.login(clientIp(req), (await readJson(req)).password);
    if (r.ok) return ok(200, { ok: true }, { 'Set-Cookie': auth.cookie(r.token, isSecure(req)) });
    if (r.locked) throw new HttpError(429, 'Trop d\'essais. Réessayez dans 15 minutes.');
    throw new HttpError(401, 'Mot de passe incorrect.');
  }
  if (m === 'POST' && p === '/api/logout') return ok(200, { ok: true }, { 'Set-Cookie': auth.clearCookie(isSecure(req)) });

  if (!authed(req)) throw new HttpError(401, 'Connexion requise.');

  if (m === 'GET' && p === '/api/state') return ok(200, { ...store.state(), auth: auth.enabled });
  if (m === 'GET' && p === '/api/journal') return ok(200, store.journal(url.searchParams.get('from') || ''));
  if (m === 'PUT' && p === '/api/settings') return ok(200, store.setSettings(await readJson(req)));
  if (m === 'POST' && p === '/api/varieties') return ok(201, store.addVariety((await readJson(req)).name));
  if (m === 'POST' && p === '/api/entries') return ok(201, store.addEntry(await readJson(req)));
  if (m === 'POST' && p === '/api/exits') return ok(201, store.addExit(await readJson(req)));
  let id;
  if ((id = p.match(/^\/api\/varieties\/(\d+)$/))) {
    if (m === 'PATCH') return ok(200, store.updateVariety(Number(id[1]), await readJson(req)));
    if (m === 'DELETE') return ok(200, store.deleteVariety(Number(id[1])));
  }
  if ((id = p.match(/^\/api\/movements\/(\d+)$/)) && m === 'DELETE') return ok(200, store.undo(Number(id[1])));

  if (m === 'GET' && p === '/api/backup') {
    const tmp = path.join(os.tmpdir(), `stock-backup-${process.pid}-${Date.now()}.db`);
    store.backupTo(tmp);
    const name = `stock-fleurs-${new Date().toISOString().slice(0, 10)}.db`;
    res.writeHead(200, baseHeaders(req, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' }));
    const s = fs.createReadStream(tmp);
    s.pipe(res);
    s.on('close', () => fs.rm(tmp, { force: true }, () => {}));
    return;
  }
  throw new HttpError(404, 'Introuvable.');
}

function serveFile(req, res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(req, res, 404, { error: 'Introuvable.' });
    res.writeHead(200, baseHeaders(req, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }));
    res.end(data);
  });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (!authed(req) && !PUBLIC_FILES.has(rel)) {
    res.writeHead(302, baseHeaders(req, { Location: '/login.html' }));
    return res.end();
  }
  if (rel === '/login.html' && authed(req) && auth.enabled) {
    res.writeHead(302, baseHeaders(req, { Location: '/' }));
    return res.end();
  }
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(req, res, 403, { error: 'Interdit.' });
  serveFile(req, res, file);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') throw new HttpError(405, 'Méthode non autorisée.');
    serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(req, res, e.status, { error: e.message });
    console.error(e);
    send(req, res, 500, { error: 'Erreur interne du serveur.' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Stock Fleurs démarré. Base : ${DB_PATH}${auth.enabled ? ' · mot de passe activé' : ' · SANS mot de passe'}`);
  console.log(`  Sur cet ordinateur : http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log(`  Sur le téléphone (même Wi-Fi) : http://${i.address}:${PORT}`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); store.close(); process.exit(0); });
