'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openStore } = require('./store');

function setup() {
  const s = openStore(':memory:');
  const v = s.addVariety('Dahlia').id;
  s.addEntry({ variety_id: v, date: '2026-10-07', qty: 150 });
  s.addEntry({ variety_id: v, date: '2026-10-05', qty: 120 }); // saisie après, mais plus ancien
  s.addEntry({ variety_id: v, date: '2026-10-09', qty: 80 });
  return { s, v };
}
const stock = (s, v) => s.state().varieties.find((x) => x.id === v).total;
const lots = (s, v) => s.state().lots.filter((l) => l.variety_id === v).map((l) => [l.date, l.remaining]);

test('les sorties prennent les lots les plus anciens d\'abord, même saisis en retard', () => {
  const { s, v } = setup();
  const r = s.addExit({ variety_id: v, date: '2026-10-10', qty: 200, reason: 'Vente' });
  assert.deepEqual(r.taken, [{ lot_date: '2026-10-05', qty: 120 }, { lot_date: '2026-10-07', qty: 80 }]);
  assert.deepEqual(lots(s, v), [['2026-10-07', 70], ['2026-10-09', 80]]);
  assert.equal(stock(s, v), 150);
});

test('une sortie supérieure au stock est refusée et ne change rien', () => {
  const { s, v } = setup();
  assert.throws(() => s.addExit({ variety_id: v, date: '2026-10-10', qty: 351, reason: 'Vente' }), /Stock insuffisant/);
  assert.equal(stock(s, v), 350);
  assert.equal(s.journal('2026-10-01').movements.filter((m) => m.type === 'out').length, 0);
});

test('annuler une sortie rend les tiges aux bons lots', () => {
  const { s, v } = setup();
  const before = lots(s, v);
  const { movement_id } = s.addExit({ variety_id: v, date: '2026-10-10', qty: 200, reason: 'Périmé' });
  s.undo(movement_id);
  assert.deepEqual(lots(s, v), before);
});

test('annuler une entrée déjà entamée est refusé, sinon elle disparaît', () => {
  const { s, v } = setup();
  const e = s.addEntry({ variety_id: v, date: '2026-10-01', qty: 10 });
  const out = s.addExit({ variety_id: v, date: '2026-10-10', qty: 5, reason: 'Perte' });
  assert.throws(() => s.undo(e.movement_id), /déjà été sorties/);
  s.undo(out.movement_id);
  s.undo(e.movement_id);
  assert.equal(stock(s, v), 350);
});

test('validations : quantité, motif, date, doublon de variété', () => {
  const { s, v } = setup();
  assert.throws(() => s.addEntry({ variety_id: v, date: '2026-10-10', qty: 0 }), /quantité/);
  assert.throws(() => s.addEntry({ variety_id: v, date: '2026-02-31', qty: 5 }), /Date invalide/);
  assert.throws(() => s.addExit({ variety_id: v, date: '2026-10-10', qty: 5, reason: 'Vol' }), /Motif/);
  assert.throws(() => s.addVariety('dahlia'), /existe déjà/);
});

test('le journal renvoie les mouvements depuis une date, du plus récent au plus ancien', () => {
  const { s, v } = setup();
  s.addExit({ variety_id: v, date: '2026-10-09', qty: 10, reason: 'Vente' });
  s.addExit({ variety_id: v, date: '2026-10-09', qty: 5, reason: 'Perte' });
  const m = s.journal('2026-10-01').movements;
  const sum = (type, date) => m.filter((x) => x.type === type && x.date === date).reduce((t, x) => t + x.qty, 0);
  assert.equal(sum('out', '2026-10-09'), 15);
  assert.equal(sum('in', '2026-10-05'), 120);
  assert.deepEqual(s.journal('2026-10-09').movements.map((x) => x.date).sort(), ['2026-10-09', '2026-10-09', '2026-10-09']);
});

test('réglages : seuils par défaut et par variété, validation', () => {
  const s = openStore(':memory:');
  assert.deepEqual(s.getSettings(), { warn_days: 4, bad_days: 6 });
  s.setSettings({ warn_days: 2, bad_days: 5 });
  assert.deepEqual(s.state().settings, { warn_days: 2, bad_days: 5 });
  assert.throws(() => s.setSettings({ warn_days: 5, bad_days: 5 }), /supérieur/);
  assert.throws(() => s.setSettings({ warn_days: 'x', bad_days: 5 }), /nombre de jours/);
  const v = s.addVariety('Pivoine').id;
  s.updateVariety(v, { warn_days: 1, bad_days: 3 });
  const row = s.state().varieties.find((x) => x.id === v);
  assert.equal(row.warn_days, 1); assert.equal(row.bad_days, 3);
  s.updateVariety(v, { warn_days: null, bad_days: null });
  assert.equal(s.state().varieties[0].warn_days, null);
  assert.throws(() => s.updateVariety(v, { warn_days: 9 }), /supérieur/); // 9 >= 5 par défaut
});

test('variétés : renommer, archiver (si stock vide), supprimer (si jamais utilisée)', () => {
  const s = openStore(':memory:');
  const a = s.addVariety('Dahlia').id, b = s.addVariety('Zinnia').id;
  s.updateVariety(a, { name: 'Dahlia café' });
  assert.throws(() => s.updateVariety(a, { name: 'zinnia' }), /porte déjà/);
  s.addEntry({ variety_id: a, date: '2026-10-10', qty: 10 });
  assert.throws(() => s.updateVariety(a, { archived: true }), /il reste du stock|Il reste du stock/i);
  s.addExit({ variety_id: a, date: '2026-10-10', qty: 10, reason: 'Vente' });
  s.updateVariety(a, { archived: true });
  assert.equal(s.state().varieties.find((x) => x.id === a).archived, 1);
  assert.throws(() => s.deleteVariety(a), /historique/);
  s.deleteVariety(b);
  assert.equal(s.state().varieties.length, 1);
});
