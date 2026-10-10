'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalApi } = require('./api-local');
const { openStore } = require('../store');

function fakeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}
const call = (srv, method, url, body) => {
  const u = new URL(url, 'http://x');
  return srv.handle(method, u.pathname, u.searchParams, body);
};

test('première ouverture : données de démonstration présentes et persistées', () => {
  const st = fakeStorage();
  const a = createLocalApi(st);
  const s = call(a, 'GET', '/api/state').body;
  assert.equal(s.demo, true);
  assert.equal(s.varieties.length, 6);
  assert.ok(s.lots.length > 5);
  // Une nouvelle session relit les mêmes données.
  call(a, 'POST', '/api/varieties', { name: 'Pivoine' });
  const b = createLocalApi(st);
  assert.ok(call(b, 'GET', '/api/state').body.varieties.some((v) => v.name === 'Pivoine'));
});

test('même comportement FIFO, refus et annulation que le vrai serveur', () => {
  const srv = createLocalApi(fakeStorage());
  const real = openStore(':memory:');
  const vl = call(srv, 'POST', '/api/varieties', { name: 'Pivoine' }).body.id;
  const vr = real.addVariety('Pivoine').id;
  const ops = [['in', '2026-03-07', 150], ['in', '2026-03-05', 120], ['in', '2026-03-09', 80]];
  for (const [, d, q] of ops) {
    call(srv, 'POST', '/api/entries', { variety_id: vl, date: d, qty: q });
    real.addEntry({ variety_id: vr, date: d, qty: q });
  }
  const outL = call(srv, 'POST', '/api/exits', { variety_id: vl, date: '2026-03-10', qty: 200, reason: 'Vente' });
  const outR = real.addExit({ variety_id: vr, date: '2026-03-10', qty: 200, reason: 'Vente' });
  assert.equal(outL.status, 201);
  assert.deepEqual(outL.body.taken, outR.taken);

  const lotsOf = (lots, v) => lots.filter((l) => l.variety_id === v).map((l) => [l.date, l.remaining]);
  assert.deepEqual(lotsOf(call(srv, 'GET', '/api/state').body.lots, vl), lotsOf(real.state().lots, vr));

  const tooMuch = call(srv, 'POST', '/api/exits', { variety_id: vl, date: '2026-03-10', qty: 999, reason: 'Vente' });
  assert.equal(tooMuch.status, 409);
  assert.match(tooMuch.body.error, /Stock insuffisant/);

  assert.equal(call(srv, 'DELETE', '/api/movements/' + outL.body.movement_id).status, 200);
  real.undo(outR.movement_id);
  assert.deepEqual(lotsOf(call(srv, 'GET', '/api/state').body.lots, vl), lotsOf(real.state().lots, vr));
});

test('validations et réglages identiques', () => {
  const srv = createLocalApi(fakeStorage());
  const v = call(srv, 'POST', '/api/varieties', { name: 'Pivoine' }).body.id;
  assert.equal(call(srv, 'POST', '/api/varieties', { name: 'pivoine' }).status, 409);
  assert.equal(call(srv, 'POST', '/api/entries', { variety_id: v, date: '2026-02-31', qty: 5 }).status, 400);
  assert.equal(call(srv, 'POST', '/api/entries', { variety_id: v, date: '2026-03-01', qty: 0 }).status, 400);
  assert.equal(call(srv, 'POST', '/api/exits', { variety_id: v, date: '2026-03-01', qty: 5, reason: 'Vol' }).status, 400);
  assert.equal(call(srv, 'PUT', '/api/settings', { warn_days: 5, bad_days: 5 }).status, 400);
  assert.equal(call(srv, 'PUT', '/api/settings', { warn_days: 2, bad_days: 5 }).status, 200);
  assert.deepEqual(call(srv, 'GET', '/api/state').body.settings, { warn_days: 2, bad_days: 5 });
  call(srv, 'POST', '/api/entries', { variety_id: v, date: '2026-03-01', qty: 5 });
  assert.equal(call(srv, 'PATCH', '/api/varieties/' + v, { archived: true }).status, 409);
  assert.equal(call(srv, 'DELETE', '/api/varieties/' + v).status, 409);
});

test('journal : agrégation par variété et par jour, et réinitialisation de la démo', () => {
  const srv = createLocalApi(fakeStorage());
  const v = call(srv, 'POST', '/api/varieties', { name: 'Pivoine' }).body.id;
  call(srv, 'POST', '/api/entries', { variety_id: v, date: '2026-03-05', qty: 100 });
  call(srv, 'POST', '/api/exits', { variety_id: v, date: '2026-03-06', qty: 10, reason: 'Vente' });
  call(srv, 'POST', '/api/exits', { variety_id: v, date: '2026-03-06', qty: 5, reason: 'Perte' });
  const j = call(srv, 'GET', '/api/journal?from=2026-03-01').body;
  assert.equal(j.pivot.find((r) => r.variety_id === v && r.type === 'out').total, 15);
  assert.equal(j.recent[0].variety.length > 0, true);
  call(srv, 'POST', '/api/demo/reset');
  assert.equal(call(srv, 'GET', '/api/state').body.varieties.length, 6);
});
