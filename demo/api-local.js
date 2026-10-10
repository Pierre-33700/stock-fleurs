/*
 * Faux serveur pour la version de démonstration (GitHub Pages) : reprend les routes et les règles de
 * server.js / store.js, mais garde les données dans le navigateur (localStorage).
 * Chargé avant app.js, il intercepte les appels fetch vers /api/*.
 */
(function (root) {
  'use strict';

  var REASONS = ['Vente', 'Périmé', 'Perte', 'Don', 'Autre'];
  var KEY = 'stock-fleurs-demo-v1';

  function HttpError(status, message) { this.status = status; this.message = message; }

  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  function cleanName(name) {
    name = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 60) throw new HttpError(400, 'Le nom de la variété doit faire entre 1 et 60 caractères.');
    return name;
  }
  function checkDays(n, label, nullable) {
    if (nullable && (n === null || n === undefined || n === '')) return null;
    if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, label + ' : entrez un nombre de jours entre 1 et 365.');
    return n;
  }
  function checkQty(q) {
    if (!Number.isInteger(q) || q < 1 || q > 100000) throw new HttpError(400, 'La quantité doit être un nombre entier entre 1 et 100 000.');
    return q;
  }
  function cmpStr(a, b) { var x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  function localIso(offsetDays) {
    var d = new Date(); d.setDate(d.getDate() - offsetDays);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function createLocalApi(storage) {
    var db;

    function empty() {
      return { seq: { v: 1, m: 1, l: 1 }, varieties: [], movements: [], lots: [], allocations: [], settings: { warn_days: 4, bad_days: 6 } };
    }
    function save() { try { storage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* stockage plein ou bloqué : la session continue en mémoire */ } }
    function load() {
      try { var raw = storage.getItem(KEY); if (raw) return JSON.parse(raw); } catch (e) { /* données illisibles : on repart de la démo */ }
      return null;
    }

    function variety(id) { return db.varieties.filter(function (v) { return v.id === id; })[0]; }
    function stockOf(id) { return db.lots.reduce(function (s, l) { return l.variety_id === id ? s + l.remaining : s; }, 0); }
    function fifoLots(id) {
      return db.lots.filter(function (l) { return l.variety_id === id && l.remaining > 0; })
        .sort(function (a, b) { return a.lot_date < b.lot_date ? -1 : a.lot_date > b.lot_date ? 1 : a.id - b.id; });
    }

    var api = {
      state: function () {
        var varieties = db.varieties.map(function (v) {
          return { id: v.id, name: v.name, warn_days: v.warn_days, bad_days: v.bad_days, archived: v.archived ? 1 : 0, total: stockOf(v.id) };
        }).sort(function (a, b) { return cmpStr(a.name, b.name); });
        var lots = db.lots.filter(function (l) { return l.remaining > 0; })
          .sort(function (a, b) { return a.variety_id - b.variety_id || (a.lot_date < b.lot_date ? -1 : a.lot_date > b.lot_date ? 1 : a.id - b.id); })
          .map(function (l) { return { id: l.id, variety_id: l.variety_id, date: l.lot_date, remaining: l.remaining }; });
        return { varieties: varieties, lots: lots, settings: { warn_days: db.settings.warn_days, bad_days: db.settings.bad_days }, auth: false, demo: true };
      },

      setSettings: function (body) {
        var warn = checkDays(body && body.warn_days, 'Seuil « à surveiller »', false);
        var bad = checkDays(body && body.bad_days, 'Seuil « à sortir vite »', false);
        if (warn >= bad) throw new HttpError(400, 'Le seuil « à sortir vite » doit être supérieur au seuil « à surveiller ».');
        db.settings = { warn_days: warn, bad_days: bad };
        return db.settings;
      },

      addVariety: function (name) {
        name = cleanName(name);
        if (db.varieties.some(function (v) { return cmpStr(v.name, name) === 0; })) throw new HttpError(409, 'Cette variété existe déjà.');
        var v = { id: db.seq.v++, name: name, warn_days: null, bad_days: null, archived: 0 };
        db.varieties.push(v);
        return { id: v.id, name: name };
      },

      updateVariety: function (id, patch) {
        var v = variety(id);
        if (!v) throw new HttpError(404, 'Variété introuvable.');
        patch = patch || {};
        var name = 'name' in patch ? cleanName(patch.name) : v.name;
        var warn = 'warn_days' in patch ? checkDays(patch.warn_days, 'Seuil « à surveiller »', true) : v.warn_days;
        var bad = 'bad_days' in patch ? checkDays(patch.bad_days, 'Seuil « à sortir vite »', true) : v.bad_days;
        var archived = 'archived' in patch ? (patch.archived ? 1 : 0) : v.archived;
        var w = warn === null ? db.settings.warn_days : warn, b = bad === null ? db.settings.bad_days : bad;
        if (w >= b) throw new HttpError(400, 'Le seuil « à sortir vite » doit être supérieur au seuil « à surveiller ».');
        if (archived && !v.archived && stockOf(id) > 0) throw new HttpError(409, 'Il reste du stock pour cette variété. Sortez-le avant de l\'archiver.');
        if (db.varieties.some(function (o) { return o.id !== id && cmpStr(o.name, name) === 0; })) throw new HttpError(409, 'Une variété porte déjà ce nom.');
        v.name = name; v.warn_days = warn; v.bad_days = bad; v.archived = archived;
        return { ok: true };
      },

      deleteVariety: function (id) {
        if (!variety(id)) throw new HttpError(404, 'Variété introuvable.');
        if (db.movements.some(function (m) { return m.variety_id === id; })) throw new HttpError(409, 'Cette variété a un historique. Archivez-la plutôt.');
        db.varieties = db.varieties.filter(function (v) { return v.id !== id; });
        return { ok: true };
      },

      addEntry: function (b) {
        if (!variety(b.variety_id)) throw new HttpError(404, 'Variété introuvable.');
        if (!isDate(b.date)) throw new HttpError(400, 'Date invalide.');
        checkQty(b.qty);
        var m = { id: db.seq.m++, type: 'in', variety_id: b.variety_id, mdate: b.date, qty: b.qty, reason: null };
        db.movements.push(m);
        db.lots.push({ id: db.seq.l++, variety_id: b.variety_id, lot_date: b.date, qty: b.qty, remaining: b.qty, movement_id: m.id });
        return { movement_id: m.id };
      },

      addExit: function (b) {
        if (!variety(b.variety_id)) throw new HttpError(404, 'Variété introuvable.');
        if (!isDate(b.date)) throw new HttpError(400, 'Date invalide.');
        if (REASONS.indexOf(b.reason) < 0) throw new HttpError(400, 'Motif de sortie invalide.');
        checkQty(b.qty);
        var lots = fifoLots(b.variety_id);
        var available = lots.reduce(function (s, l) { return s + l.remaining; }, 0);
        if (available < b.qty) throw new HttpError(409, 'Stock insuffisant : il reste ' + available + ' tiges.');
        var m = { id: db.seq.m++, type: 'out', variety_id: b.variety_id, mdate: b.date, qty: b.qty, reason: b.reason };
        db.movements.push(m);
        var need = b.qty, taken = [];
        for (var i = 0; i < lots.length && need > 0; i++) {
          var t = Math.min(lots[i].remaining, need);
          lots[i].remaining -= t;
          db.allocations.push({ movement_id: m.id, lot_id: lots[i].id, qty: t });
          taken.push({ lot_date: lots[i].lot_date, qty: t });
          need -= t;
        }
        return { movement_id: m.id, taken: taken };
      },

      undo: function (id) {
        var m = db.movements.filter(function (x) { return x.id === id; })[0];
        if (!m) throw new HttpError(404, 'Mouvement introuvable.');
        if (m.type === 'in') {
          var lot = db.lots.filter(function (l) { return l.movement_id === id; })[0];
          if (lot.remaining !== lot.qty) throw new HttpError(409, 'Des tiges de cette entrée ont déjà été sorties. Annulez d\'abord ces sorties.');
          db.lots = db.lots.filter(function (l) { return l !== lot; });
        } else {
          db.allocations.forEach(function (a) {
            if (a.movement_id !== id) return;
            db.lots.forEach(function (l) { if (l.id === a.lot_id) l.remaining += a.qty; });
          });
          db.allocations = db.allocations.filter(function (a) { return a.movement_id !== id; });
        }
        db.movements = db.movements.filter(function (x) { return x !== m; });
        return { ok: true };
      },

      journal: function (from) {
        if (!isDate(from)) throw new HttpError(400, 'Date invalide.');
        var movements = db.movements.filter(function (m) { return m.mdate >= from; })
          .sort(function (x, y) { return x.mdate < y.mdate ? 1 : x.mdate > y.mdate ? -1 : y.id - x.id; })
          .slice(0, 2000)
          .map(function (m) { return { id: m.id, type: m.type, variety_id: m.variety_id, date: m.mdate, qty: m.qty, reason: m.reason }; });
        return { movements: movements };
      },

      /** Repart des données d'exemple (dates calculées par rapport à aujourd'hui). */
      reset: function () {
        db = empty();
        var id = {};
        ['Dahlia', 'Zinnia', 'Cosmos', 'Chrysanthème', 'Rose', 'Ammi'].forEach(function (n) { id[n] = api.addVariety(n).id; });
        [['Dahlia', 5, 120], ['Dahlia', 3, 150], ['Dahlia', 1, 80], ['Zinnia', 4, 200], ['Zinnia', 2, 100], ['Zinnia', 0, 120],
          ['Cosmos', 2, 150], ['Cosmos', 0, 60], ['Chrysanthème', 6, 90], ['Chrysanthème', 1, 70], ['Rose', 1, 60]].forEach(function (e) {
          api.addEntry({ variety_id: id[e[0]], date: localIso(e[1]), qty: e[2] });
        });
        [['Dahlia', 2, 100, 'Vente'], ['Dahlia', 1, 50, 'Vente'], ['Zinnia', 1, 140, 'Vente'], ['Cosmos', 1, 100, 'Vente'],
          ['Chrysanthème', 2, 70, 'Vente'], ['Chrysanthème', 1, 10, 'Périmé'], ['Rose', 0, 15, 'Perte']].forEach(function (e) {
          api.addExit({ variety_id: id[e[0]], date: localIso(e[1]), qty: e[2], reason: e[3] });
        });
        return { ok: true };
      }
    };

    db = load();
    if (!db) { api.reset(); save(); }

    /** Même contrat que server.js : renvoie { status, body }. */
    function handle(method, pathname, search, body) {
      var m;
      try {
        if (method === 'GET' && pathname === '/api/state') return { status: 200, body: api.state() };
        if (method === 'GET' && pathname === '/api/journal') return { status: 200, body: api.journal(search.get('from') || '') };
        if (method === 'POST' && pathname === '/api/logout') return { status: 200, body: { ok: true } };
        var out, status = 200;
        if (method === 'PUT' && pathname === '/api/settings') out = api.setSettings(body);
        else if (method === 'POST' && pathname === '/api/varieties') { out = api.addVariety((body || {}).name); status = 201; }
        else if (method === 'POST' && pathname === '/api/entries') { out = api.addEntry(body || {}); status = 201; }
        else if (method === 'POST' && pathname === '/api/exits') { out = api.addExit(body || {}); status = 201; }
        else if (method === 'POST' && pathname === '/api/demo/reset') out = api.reset();
        else if ((m = pathname.match(/^\/api\/varieties\/(\d+)$/)) && method === 'PATCH') out = api.updateVariety(Number(m[1]), body);
        else if (m && method === 'DELETE') out = api.deleteVariety(Number(m[1]));
        else if ((m = pathname.match(/^\/api\/movements\/(\d+)$/)) && method === 'DELETE') out = api.undo(Number(m[1]));
        else throw new HttpError(404, 'Introuvable.');
        save();
        return { status: status, body: out };
      } catch (e) {
        if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
        throw e;
      }
    }

    return { handle: handle, api: api };
  }

  var exported = { createLocalApi: createLocalApi };
  if (typeof module !== 'undefined' && module.exports) { module.exports = exported; return; }

  /* Dans le navigateur : on remplace fetch pour les appels /api/*. */
  var local = createLocalApi(root.localStorage);
  var realFetch = root.fetch.bind(root);
  root.fetch = function (input, opt) {
    var u = new URL(typeof input === 'string' ? input : input.url, root.location.href);
    if (u.pathname.indexOf('/api/') !== 0) return realFetch(input, opt);
    var method = ((opt && opt.method) || 'GET').toUpperCase(), body;
    try { body = opt && opt.body ? JSON.parse(opt.body) : undefined; } catch (e) { body = undefined; }
    var r = local.handle(method, u.pathname, u.searchParams, body);
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } }));
  };
})(typeof window !== 'undefined' ? window : globalThis);
