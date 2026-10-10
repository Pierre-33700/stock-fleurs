'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const REASONS = ['Vente', 'Périmé', 'Perte', 'Don', 'Autre'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkQty(q) {
  if (!Number.isInteger(q) || q < 1 || q > 100000) throw new HttpError(400, 'La quantité doit être un nombre entier entre 1 et 100 000.');
  return q;
}

function cleanName(name) {
  name = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 60) throw new HttpError(400, 'Le nom de la variété doit faire entre 1 et 60 caractères.');
  return name;
}

function checkDays(n, label, nullable) {
  if (nullable && (n === null || n === undefined || n === '')) return null;
  if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, `${label} : entrez un nombre de jours entre 1 et 365.`);
  return n;
}

function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS varieties (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      warn_days INTEGER,
      bad_days INTEGER,
      archived INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings (key, value) VALUES ('warn_days', '4'), ('bad_days', '6');
    CREATE TABLE IF NOT EXISTS movements (
      id INTEGER PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('in','out')),
      variety_id INTEGER NOT NULL REFERENCES varieties(id),
      mdate TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS lots (
      id INTEGER PRIMARY KEY,
      variety_id INTEGER NOT NULL REFERENCES varieties(id),
      lot_date TEXT NOT NULL,
      qty INTEGER NOT NULL,
      remaining INTEGER NOT NULL CHECK (remaining >= 0),
      movement_id INTEGER NOT NULL REFERENCES movements(id)
    );
    CREATE TABLE IF NOT EXISTS allocations (
      movement_id INTEGER NOT NULL REFERENCES movements(id),
      lot_id INTEGER NOT NULL REFERENCES lots(id),
      qty INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lots_fifo ON lots (variety_id, lot_date, id);
    CREATE INDEX IF NOT EXISTS idx_mov_date ON movements (mdate);
  `);

  // Bases créées avant l'ajout des réglages : on complète la table des variétés.
  const cols = db.prepare('PRAGMA table_info(varieties)').all().map((c) => c.name);
  for (const [name, def] of [['warn_days', 'INTEGER'], ['bad_days', 'INTEGER'], ['archived', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE varieties ADD COLUMN ${name} ${def}`);
  }

  const q = {
    varieties: db.prepare(`SELECT v.id, v.name, v.warn_days, v.bad_days, v.archived, COALESCE(SUM(l.remaining),0) AS total
                           FROM varieties v LEFT JOIN lots l ON l.variety_id = v.id
                           GROUP BY v.id ORDER BY v.name COLLATE NOCASE`),
    settings: db.prepare('SELECT key, value FROM settings'),
    setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    varietyFull: db.prepare('SELECT * FROM varieties WHERE id = ?'),
    stockOf: db.prepare('SELECT COALESCE(SUM(remaining),0) AS total FROM lots WHERE variety_id = ?'),
    movesOf: db.prepare('SELECT COUNT(*) AS n FROM movements WHERE variety_id = ?'),
    updVariety: db.prepare('UPDATE varieties SET name = ?, warn_days = ?, bad_days = ?, archived = ? WHERE id = ?'),
    delVariety: db.prepare('DELETE FROM varieties WHERE id = ?'),
    liveLots: db.prepare(`SELECT id, variety_id, lot_date AS date, remaining FROM lots
                          WHERE remaining > 0 ORDER BY variety_id, lot_date, id`),
    variety: db.prepare('SELECT id, name FROM varieties WHERE id = ?'),
    addVariety: db.prepare('INSERT INTO varieties (name) VALUES (?)'),
    addMovement: db.prepare('INSERT INTO movements (type, variety_id, mdate, qty, reason) VALUES (?,?,?,?,?)'),
    addLot: db.prepare('INSERT INTO lots (variety_id, lot_date, qty, remaining, movement_id) VALUES (?,?,?,?,?)'),
    fifoLots: db.prepare(`SELECT id, lot_date, remaining FROM lots
                          WHERE variety_id = ? AND remaining > 0 ORDER BY lot_date, id`),
    takeFromLot: db.prepare('UPDATE lots SET remaining = remaining - ? WHERE id = ?'),
    giveBackToLot: db.prepare('UPDATE lots SET remaining = remaining + ? WHERE id = ?'),
    addAlloc: db.prepare('INSERT INTO allocations (movement_id, lot_id, qty) VALUES (?,?,?)'),
    allocs: db.prepare('SELECT lot_id, qty FROM allocations WHERE movement_id = ?'),
    delAllocs: db.prepare('DELETE FROM allocations WHERE movement_id = ?'),
    movement: db.prepare('SELECT * FROM movements WHERE id = ?'),
    delMovement: db.prepare('DELETE FROM movements WHERE id = ?'),
    lotOfMovement: db.prepare('SELECT id, qty, remaining FROM lots WHERE movement_id = ?'),
    delLot: db.prepare('DELETE FROM lots WHERE id = ?'),
    since: db.prepare(`SELECT id, type, variety_id, mdate AS date, qty, reason FROM movements
                       WHERE mdate >= ? ORDER BY mdate DESC, id DESC LIMIT ?`),
  };

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const lastId = (r) => Number(r.lastInsertRowid);

  function getSettings() {
    const o = {};
    for (const r of q.settings.all()) o[r.key] = Number(r.value);
    return { warn_days: o.warn_days, bad_days: o.bad_days };
  }

  return {
    close: () => db.close(),

    state() {
      return { varieties: q.varieties.all(), lots: q.liveLots.all(), settings: getSettings() };
    },

    getSettings,

    setSettings(body) {
      const warn = checkDays(body && body.warn_days, 'Seuil « à surveiller »', false);
      const bad = checkDays(body && body.bad_days, 'Seuil « à sortir vite »', false);
      if (warn >= bad) throw new HttpError(400, 'Le seuil « à sortir vite » doit être supérieur au seuil « à surveiller ».');
      tx(() => { q.setSetting.run('warn_days', String(warn)); q.setSetting.run('bad_days', String(bad)); });
      return getSettings();
    },

    addVariety(name) {
      name = cleanName(name);
      try {
        return { id: lastId(q.addVariety.run(name)), name };
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'Cette variété existe déjà.');
        throw e;
      }
    },

    /** Renomme, règle les seuils propres à la variété ou l'archive. Champs absents = inchangés. */
    updateVariety(id, patch) {
      const v = q.varietyFull.get(id);
      if (!v) throw new HttpError(404, 'Variété introuvable.');
      patch = patch || {};
      const name = 'name' in patch ? cleanName(patch.name) : v.name;
      const warn = 'warn_days' in patch ? checkDays(patch.warn_days, 'Seuil « à surveiller »', true) : v.warn_days;
      const bad = 'bad_days' in patch ? checkDays(patch.bad_days, 'Seuil « à sortir vite »', true) : v.bad_days;
      const archived = 'archived' in patch ? (patch.archived ? 1 : 0) : v.archived;
      const def = getSettings();
      if ((warn ?? def.warn_days) >= (bad ?? def.bad_days)) {
        throw new HttpError(400, 'Le seuil « à sortir vite » doit être supérieur au seuil « à surveiller ».');
      }
      if (archived && !v.archived && q.stockOf.get(id).total > 0) {
        throw new HttpError(409, 'Il reste du stock pour cette variété. Sortez-le avant de l\'archiver.');
      }
      try {
        q.updVariety.run(name, warn, bad, archived, id);
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) throw new HttpError(409, 'Une variété porte déjà ce nom.');
        throw e;
      }
      return { ok: true };
    },

    /** Suppression possible seulement si la variété n'a jamais servi. */
    deleteVariety(id) {
      if (!q.varietyFull.get(id)) throw new HttpError(404, 'Variété introuvable.');
      if (q.movesOf.get(id).n > 0) throw new HttpError(409, 'Cette variété a un historique. Archivez-la plutôt.');
      q.delVariety.run(id);
      return { ok: true };
    },

    /** Copie cohérente de la base dans un fichier (pour la sauvegarde). */
    backupTo(file) {
      db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    },

    addEntry({ variety_id, date, qty }) {
      if (!q.variety.get(variety_id)) throw new HttpError(404, 'Variété introuvable.');
      if (!isDate(date)) throw new HttpError(400, 'Date invalide.');
      checkQty(qty);
      return tx(() => {
        const mid = lastId(q.addMovement.run('in', variety_id, date, qty, null));
        q.addLot.run(variety_id, date, qty, qty, mid);
        return { movement_id: mid };
      });
    },

    /** Sortie FIFO : prend dans les lots les plus anciens d'abord. */
    addExit({ variety_id, date, qty, reason }) {
      if (!q.variety.get(variety_id)) throw new HttpError(404, 'Variété introuvable.');
      if (!isDate(date)) throw new HttpError(400, 'Date invalide.');
      if (!REASONS.includes(reason)) throw new HttpError(400, 'Motif de sortie invalide.');
      checkQty(qty);
      return tx(() => {
        const lots = q.fifoLots.all(variety_id);
        const available = lots.reduce((s, l) => s + l.remaining, 0);
        if (available < qty) throw new HttpError(409, `Stock insuffisant : il reste ${available} tiges.`);
        const mid = lastId(q.addMovement.run('out', variety_id, date, qty, reason));
        let need = qty;
        const taken = [];
        for (const l of lots) {
          if (need === 0) break;
          const t = Math.min(l.remaining, need);
          q.takeFromLot.run(t, l.id);
          q.addAlloc.run(mid, l.id, t);
          taken.push({ lot_date: l.lot_date, qty: t });
          need -= t;
        }
        return { movement_id: mid, taken };
      });
    },

    /** Annule un mouvement (correction d'une erreur de saisie). */
    undo(id) {
      return tx(() => {
        const m = q.movement.get(id);
        if (!m) throw new HttpError(404, 'Mouvement introuvable.');
        if (m.type === 'in') {
          const lot = q.lotOfMovement.get(id);
          if (lot.remaining !== lot.qty) {
            throw new HttpError(409, 'Des tiges de cette entrée ont déjà été sorties. Annulez d\'abord ces sorties.');
          }
          q.delLot.run(lot.id);
        } else {
          for (const a of q.allocs.all(id)) q.giveBackToLot.run(a.qty, a.lot_id);
          q.delAllocs.run(id);
        }
        q.delMovement.run(id);
        return { ok: true };
      });
    },

    /** Tous les mouvements depuis une date ; l'écran en tire le récapitulatif par variété. */
    journal(from, limit = 2000) {
      if (!isDate(from)) throw new HttpError(400, 'Date invalide.');
      return { movements: q.since.all(from, limit) };
    },
  };
}

module.exports = { openStore, HttpError, REASONS, isDate };
