'use strict';
// Remplit une base de démonstration (jamais la vraie base) : npm run demo
const path = require('node:path');
const fs = require('node:fs');
const { openStore } = require('./store');

const file = path.join(__dirname, 'data', 'demo.db');
for (const ext of ['', '-wal', '-shm']) fs.rmSync(file + ext, { force: true });
const s = openStore(file);

function day(offset) {
  const d = new Date(); d.setDate(d.getDate() - offset);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
const id = {};
for (const n of ['Dahlia', 'Zinnia', 'Cosmos', 'Chrysanthème', 'Rose', 'Ammi']) id[n] = s.addVariety(n).id;
const entries = [['Dahlia', 5, 120], ['Dahlia', 3, 150], ['Dahlia', 1, 80], ['Zinnia', 4, 200], ['Zinnia', 2, 100], ['Zinnia', 0, 120],
  ['Cosmos', 2, 150], ['Cosmos', 0, 60], ['Chrysanthème', 6, 90], ['Chrysanthème', 1, 70], ['Rose', 1, 60]];
for (const [n, off, qty] of entries) s.addEntry({ variety_id: id[n], date: day(off), qty });
const exits = [['Dahlia', 2, 100, 'Vente'], ['Dahlia', 1, 50, 'Vente'], ['Zinnia', 1, 140, 'Vente'], ['Cosmos', 1, 100, 'Vente'],
  ['Chrysanthème', 2, 70, 'Vente'], ['Chrysanthème', 1, 10, 'Périmé'], ['Rose', 0, 15, 'Perte']];
for (const [n, off, qty, reason] of exits) s.addExit({ variety_id: id[n], date: day(off), qty, reason });
s.close();
console.log('Base de démonstration créée : ' + file);
console.log('Lancez-la avec : $env:DB_PATH="data/demo.db"; npm start   (PowerShell)');
