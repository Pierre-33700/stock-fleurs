'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuth } = require('./auth');

test('sans mot de passe, tout est ouvert', () => {
  const a = createAuth('');
  assert.equal(a.enabled, false);
  assert.equal(a.valid(null), true);
});

test('bon mot de passe : jeton valide ; mauvais : refusé', () => {
  const a = createAuth('tulipe');
  assert.equal(a.login('1.1.1.1', 'rose').ok, false);
  const r = a.login('1.1.1.1', 'tulipe');
  assert.equal(r.ok, true);
  assert.equal(a.valid(r.token), true);
  assert.equal(a.valid(a.fromCookieHeader('x=1; sf_session=' + r.token + '; y=2')), true);
});

test('jeton falsifié, vide ou expiré : refusé', () => {
  let t = 1_000_000;
  const a = createAuth('tulipe', () => t);
  const { token } = a.login('ip', 'tulipe');
  assert.equal(a.valid(token.slice(0, -2) + 'xx'), false);
  assert.equal(a.valid('9999999999999.abc'), false);
  assert.equal(a.valid(''), false);
  assert.equal(a.valid(undefined), false);
  t += 91 * 24 * 3600 * 1000;
  assert.equal(a.valid(token), false);
});

test('changer le mot de passe invalide les anciennes sessions', () => {
  const { token } = createAuth('ancien').login('ip', 'ancien');
  assert.equal(createAuth('nouveau').valid(token), false);
});

test('5 essais ratés bloquent l\'adresse, même avec le bon mot de passe, puis le blocage expire', () => {
  let t = 0;
  const a = createAuth('tulipe', () => t);
  for (let i = 0; i < 4; i++) assert.equal(a.login('ip', 'non').locked, false);
  assert.equal(a.login('ip', 'non').locked, true);
  assert.equal(a.login('ip', 'tulipe').locked, true);
  assert.equal(a.login('autre', 'tulipe').ok, true);
  t += 16 * 60 * 1000;
  assert.equal(a.login('ip', 'tulipe').ok, true);
});
