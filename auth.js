'use strict';
const crypto = require('node:crypto');

const COOKIE = 'sf_session';
const SESSION_MS = 90 * 24 * 3600 * 1000;   // reste connecté 90 jours sur un même appareil
const MAX_FAILS = 5;                         // essais ratés avant blocage
const LOCK_MS = 15 * 60 * 1000;              // durée du blocage, par adresse IP

function sha(s) { return crypto.createHash('sha256').update(s).digest(); }

/**
 * Authentification par mot de passe unique. Sans mot de passe configuré, l'accès est libre
 * (usage local). Le jeton de session est signé : changer le mot de passe déconnecte tout le monde.
 */
function createAuth(password, now = () => Date.now()) {
  const enabled = typeof password === 'string' && password.length > 0;
  const key = enabled ? sha('stock-fleurs-session:' + password) : null;
  const fails = new Map(); // ip -> { n, until }

  function sign(payload) { return crypto.createHmac('sha256', key).update(payload).digest('base64url'); }

  function issue() {
    const exp = String(now() + SESSION_MS);
    return exp + '.' + sign(exp);
  }

  function valid(token) {
    if (!enabled) return true;
    if (typeof token !== 'string') return false;
    const i = token.indexOf('.');
    if (i < 1) return false;
    const exp = token.slice(0, i), sig = Buffer.from(token.slice(i + 1)), good = Buffer.from(sign(exp));
    if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return false;
    return Number(exp) > now();
  }

  function fromCookieHeader(header) {
    if (!header) return null;
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE) return v.join('=');
    }
    return null;
  }

  function login(ip, attempt) {
    const f = fails.get(ip);
    if (f && f.until > now()) return { ok: false, locked: true, retryInMs: f.until - now() };
    const ok = enabled && typeof attempt === 'string' && crypto.timingSafeEqual(sha(attempt), sha(password));
    if (ok) { fails.delete(ip); return { ok: true, token: issue() }; }
    const n = (f ? f.n : 0) + 1;
    fails.set(ip, n >= MAX_FAILS ? { n: 0, until: now() + LOCK_MS } : { n, until: 0 });
    return { ok: false, locked: n >= MAX_FAILS };
  }

  function cookie(token, secure) {
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`;
  }
  function clearCookie(secure) {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  return { enabled, login, valid, fromCookieHeader, cookie, clearCookie };
}

module.exports = { createAuth, COOKIE };
