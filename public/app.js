(function () {
'use strict';

var UNIT = 'tiges';
var REASONS = [['Vente', 'Marché, fleuriste…'], ['Périmé', 'Trop vieilles'], ['Perte', 'Casse, gel, maladie'], ['Don', 'Offert'], ['Autre', '']];
var RCLS = { 'Vente': 'ok', 'Périmé': 'warn', 'Perte': 'bad', 'Don': 'zero', 'Autre': 'zero' };
var MON = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
var DOW = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

var st = {
  tab: 'stock', varieties: [], lots: [], settings: { warn_days: 4, bad_days: 6 }, auth: false, demo: false, journal: null, loaded: false, busy: false,
  open: {}, filter: '', adding: false, focusNew: false, confirm: null,
  inV: null, inD: null, inQ: 50, outV: null, outQ: 30, outM: 'Vente', pivot: 'in'
};

/* ---------- dates (heure locale du téléphone ou de l'ordinateur) ---------- */
function iso(d) { return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
function today() { return iso(new Date()); }
function dt(s) { var a = s.split('-'); return new Date(+a[0], +a[1] - 1, +a[2]); }
function fmt(s) { var x = dt(s); return DOW[x.getDay()] + ' ' + x.getDate() + ' ' + MON[x.getMonth()]; }
function age(s) { return Math.round((dt(today()) - dt(s)) / 864e5); }
function lastDays(n) {
  var out = [], x;
  for (var i = n - 1; i >= 0; i--) { x = new Date(); x.setDate(x.getDate() - i); out.push(iso(x)); }
  return out;
}

/* ---------- utilitaires ---------- */
function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function clamp(n) { return Math.max(0, Math.min(100000, n | 0)); }
function toast(t) {
  var e = document.getElementById('toast');
  e.textContent = t; e.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(function () { e.hidden = true; }, 3000);
}

function api(method, url, body) {
  var opt = { method: method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  return fetch(url, opt).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (r.status === 401 && url !== '/api/login') { location.href = '/login.html'; throw new Error('Connexion requise.'); }
      if (!r.ok) throw new Error(j.error || 'Erreur ' + r.status);
      return j;
    });
  }, function () { throw new Error('Connexion impossible. Vérifiez le Wi-Fi ou que le serveur est démarré.'); });
}

/* ---------- données ---------- */
function liveLots(vid) { return st.lots.filter(function (l) { return l.variety_id === vid; }); }
function total(v) { return v.total; }
function byId(id) { return st.varieties.filter(function (v) { return v.id === id; })[0]; }
function active() { return st.varieties.filter(function (v) { return !v.archived; }); }
// Seuils de fraîcheur : ceux de la variété s'ils existent, sinon ceux des réglages.
function thresholds(v) {
  var w = v.warn_days || st.settings.warn_days, b = v.bad_days || st.settings.bad_days;
  return { warn: w, bad: Math.max(b, w + 1) };
}

function fixSelection() {
  var list = active(), first = list[0] && list[0].id;
  if (!byId(st.inV) || byId(st.inV).archived) st.inV = first || null;
  if (!byId(st.outV) || byId(st.outV).archived) {
    var withStock = list.filter(function (v) { return v.total > 0; })[0];
    st.outV = withStock ? withStock.id : (first || null);
  }
}
function loadState() {
  return api('GET', '/api/state').then(function (s) {
    st.varieties = s.varieties; st.lots = s.lots; st.settings = s.settings; st.auth = s.auth; st.demo = !!s.demo; st.loaded = true; fixSelection();
  });
}
function loadJournal() {
  var from = lastDays(7)[0];
  return api('GET', '/api/journal?from=' + from).then(function (j) { st.journal = j; });
}
function refresh() {
  return Promise.all([loadState(), st.tab === 'log' ? loadJournal() : Promise.resolve()]);
}
function guard(p) {
  return p.catch(function (e) { toast(e.message); }).then(function () { st.busy = false; render(); });
}

/* ---------- vues ---------- */
function vchips(key, withAdd) {
  var h = '<div class="vchips" role="group">' + active().map(function (v) {
    return '<button type="button" data-a="' + key + '" data-v="' + v.id + '" aria-pressed="' + (st[key] === v.id) + '">' + esc(v.name) + '<small>' + v.total + '</small></button>';
  }).join('');
  if (withAdd) h += '<button type="button" class="add" data-a="toggleAdd">+ Nouvelle variété</button>';
  return h + '</div>';
}

function vStock() {
  var list = active();
  if (!list.length) {
    return '<div class="empty"><h2>Aucune variété</h2><p>Ajoutez les variétés que vous stockez dans les réglages, ou créez-en une au moment de la première entrée.</p><button class="btn" data-t="settings">Ouvrir les réglages</button> <button class="btn" data-t="in">Ajouter une entrée</button></div>';
  }
  var all = list.reduce(function (s, v) { return s + v.total; }, 0);
  var q = st.filter.toLowerCase();
  var cards = list.filter(function (v) { return v.name.toLowerCase().indexOf(q) > -1; }).map(function (v) {
    var L = liveLots(v.id), chip = '<span class="chip zero">Épuisé</span>', old = '';
    if (L.length) {
      var g = age(L[0].date);
      old = 'Plus ancien : ' + fmt(L[0].date);
      var th = thresholds(v);
      chip = g >= th.bad ? '<span class="chip bad">À sortir vite · ' + g + ' j</span>'
           : g >= th.warn ? '<span class="chip warn">À surveiller · ' + g + ' j</span>'
           : '<span class="chip ok">Frais · ' + g + ' j</span>';
    }
    var open = st.open[v.id];
    var lotsH = open ? '<div class="lots">' + (L.length ? L.map(function (l, i) {
      return '<div class="lot' + (i === 0 ? ' first' : '') + '"><span class="rk">' + (i + 1) + '</span><span class="d"><span>' + fmt(l.date) + '</span>' + (i === 0 ? '<span class="chip ok">sort en premier</span>' : '') + '</span><span class="n">' + l.remaining + '</span></div>';
    }).join('') + '<p class="hint">Les chiffres 1, 2, 3… donnent l\'ordre de sortie.</p>' : '<p class="hint">Aucun lot en stock.</p>') + '</div>' : '';
    return '<article class="card"><button class="vhead" data-a="open" data-v="' + v.id + '" aria-expanded="' + !!open + '"><div class="vrow"><span class="vname">' + esc(v.name) + '</span><span class="vtotal">' + v.total + '<small>' + UNIT + '</small></span></div>' +
      '<div class="vfoot">' + chip + '<span>' + old + '</span></div><span class="hint" style="margin:0">' + (open ? 'Masquer les lots' : 'Voir les lots') + '</span></button>' + lotsH + '</article>';
  }).join('');
  return '<div class="sum"><b>' + all + '</b><span>' + UNIT + ' en stock · ' + list.length + ' variété' + (list.length > 1 ? 's' : '') + ' · au ' + fmt(today()) + '</span></div>' +
    '<div class="tools"><input id="q" type="text" placeholder="Chercher une variété" value="' + esc(st.filter) + '" aria-label="Chercher une variété"></div>' +
    '<div class="grid">' + (cards || '<p class="hint">Aucune variété ne correspond.</p>') + '</div>';
}

function vIn() {
  if (!st.inD) st.inD = today();
  var addBox = st.adding ? '<div class="addv"><input id="newv" type="text" maxlength="60" placeholder="Nom de la variété" aria-label="Nom de la nouvelle variété" autocomplete="off"><button type="button" class="btn" data-a="addV">Créer</button></div>' : '';
  var empty = !active().length;
  var recap = empty ? '<div class="plan"><h3>Créez d\'abord une variété</h3></div>'
    : '<div class="plan"><h3>Récapitulatif</h3><div class="pl"><b>' + st.inQ + ' ' + UNIT + ' de ' + esc(byId(st.inV).name) + '</b><span>' + fmt(st.inD) + '</span></div></div>';
  return '<form class="form"><h2>Nouvelle entrée</h2>' +
    '<div class="fld"><span class="lb">Quelle variété ?</span>' + vchips('inV', true) + addBox + '</div>' +
    '<div class="fld"><span class="lb">Combien de tiges ?</span><div class="stepper"><button type="button" class="big" data-a="dq" data-k="inQ" data-v="-10" aria-label="Moins 10">−</button><input id="qin" inputmode="numeric" value="' + st.inQ + '" aria-label="Quantité"><button type="button" class="big" data-a="dq" data-k="inQ" data-v="10" aria-label="Plus 10">+</button></div>' +
    '<div class="quick">' + [10, 25, 50, 100].map(function (n) { return '<button type="button" data-a="dq" data-k="inQ" data-v="' + n + '">+' + n + '</button>'; }).join('') + '<button type="button" data-a="dq" data-k="inQ" data-v="-100000">Effacer</button></div></div>' +
    '<div class="fld"><label for="din">Date de récolte</label><input type="date" id="din" value="' + st.inD + '" max="' + today() + '"></div>' +
    recap + '<button class="primary" data-a="saveIn" ' + (!empty && st.inQ > 0 ? '' : 'disabled') + '>Ajouter au stock</button></form>';
}

function plan(vid, q) {
  var L = liveLots(vid), need = q, res = [];
  for (var i = 0; i < L.length && need > 0; i++) {
    var t = Math.min(L[i].remaining, need);
    res.push({ l: L[i], t: t, left: L[i].remaining - t });
    need -= t;
  }
  return { res: res, short: need };
}

function vOut() {
  if (!active().length) return '<div class="empty"><h2>Rien à sortir</h2><p>Enregistrez d\'abord une entrée.</p><button class="btn" data-t="in">Ajouter une entrée</button></div>';
  var v = byId(st.outV), q = st.outQ, pl = plan(v.id, q), box;
  if (q <= 0) box = '<div class="plan"><h3>Choisissez une quantité</h3></div>';
  else if (pl.short > 0) box = '<div class="plan err">Stock insuffisant : il reste ' + v.total + ' ' + UNIT + ' de ' + esc(v.name) + '. Réduisez la quantité de ' + pl.short + '.</div>';
  else box = '<div class="plan"><h3>Ce qui sera pris, dans l\'ordre</h3>' + pl.res.map(function (r) {
    return '<div class="pl"><span>Lot du ' + fmt(r.l.date) + '</span><b>' + r.t + ' <span class="hint">(reste ' + r.left + ')</span></b></div>';
  }).join('') + '</div>';
  return '<form class="form"><h2>Nouvelle sortie</h2>' +
    '<div class="fld"><span class="lb">Quelle variété ?</span>' + vchips('outV', false) + '</div>' +
    '<div class="fld"><span class="lb">Combien de tiges ?</span><div class="stepper"><button type="button" class="big" data-a="dq" data-k="outQ" data-v="-10" aria-label="Moins 10">−</button><input id="qout" inputmode="numeric" value="' + q + '" aria-label="Quantité"><button type="button" class="big" data-a="dq" data-k="outQ" data-v="10" aria-label="Plus 10">+</button><span class="hint">sur ' + v.total + ' dispo</span></div>' +
    '<div class="quick">' + [10, 25, 50].map(function (n) { return '<button type="button" data-a="dq" data-k="outQ" data-v="' + n + '">+' + n + '</button>'; }).join('') + '<button type="button" data-a="all">Tout le stock</button></div></div>' +
    '<div class="fld"><span class="lb">Motif de la sortie</span><div class="reasons" role="group">' + REASONS.map(function (m) {
      return '<button type="button" data-a="outM" data-v="' + m[0] + '" aria-pressed="' + (st.outM === m[0]) + '">' + m[0] + (m[1] ? '<small>' + m[1] + '</small>' : '') + '</button>';
    }).join('') + '</div></div>' +
    box + '<button class="primary" data-a="saveOut" ' + (q > 0 && pl.short === 0 ? '' : 'disabled') + '>Valider la sortie</button></form>';
}

function vLog() {
  if (!st.journal) return '<p class="loading">Chargement…</p>';
  var days = lastDays(7), isIn = st.pivot === 'in', type = isIn ? 'in' : 'out';
  var map = {};
  st.journal.pivot.forEach(function (r) { if (r.type === type) map[r.variety_id + '|' + r.mdate] = r.total; });
  var head = '<tr><th>Variété</th>' + days.map(function (d) { var x = dt(d); return '<th>' + DOW[x.getDay()] + ' ' + x.getDate() + '</th>'; }).join('') + '<th>Total</th></tr>';
  var colT = days.map(function () { return 0; }), grand = 0;
  var seen = {};
  st.journal.pivot.forEach(function (r) { seen[r.variety_id] = true; });
  var rows = st.varieties.filter(function (v) { return !v.archived || seen[v.id]; }).map(function (v) {
    var rt = 0;
    var c = days.map(function (d, i) { var n = map[v.id + '|' + d] || 0; rt += n; colT[i] += n; return '<td class="' + (n ? 'has' : 'z') + '">' + (n || '·') + '</td>'; }).join('');
    grand += rt;
    return '<tr><td>' + esc(v.name) + '</td>' + c + '<td class="has">' + rt + '</td></tr>';
  }).join('');
  var foot = '<tr><td>Total</td>' + colT.map(function (n) { return '<td>' + n + '</td>'; }).join('') + '<td>' + grand + '</td></tr>';
  var L = st.journal.recent.map(function (m) {
    var sure = st.confirm === m.id;
    return '<div class="lg"><span class="sg ' + m.type + '">' + (m.type === 'in' ? '+' : '−') + m.qty + '</span><span class="m"><b>' + esc(m.variety) + '</b><small>' + fmt(m.date) + '</small></span>' +
      '<span class="tg tgs">' + (m.type === 'in' ? '<span class="chip ok">Entrée</span>' : '<span class="chip ' + RCLS[m.reason] + '">' + esc(m.reason) + '</span>') +
      '<button class="mini' + (sure ? ' sure' : '') + '" data-a="undo" data-v="' + m.id + '">' + (sure ? 'Confirmer l\'annulation' : 'Annuler') + '</button></span></div>';
  }).join('');
  return '<div class="sec" style="margin-top:0"><h2>' + (isIn ? 'Entrées' : 'Sorties') + ' par variété et par jour</h2><div class="seg" role="group">' +
    [['in', 'Entrées'], ['out', 'Sorties']].map(function (a) { return '<button type="button" data-a="pivot" data-v="' + a[0] + '" aria-pressed="' + (st.pivot === a[0]) + '">' + a[1] + '</button>'; }).join('') + '</div></div>' +
    (active().length ? '<div class="tw"><table><thead>' + head + '</thead><tbody>' + rows + '</tbody><tfoot>' + foot + '</tfoot></table></div><p class="hint">7 derniers jours, en ' + UNIT + '. Faites défiler le tableau sur téléphone.</p>' : '<p class="hint">Aucune donnée pour le moment.</p>') +
    '<div class="sec"><h2>Derniers mouvements</h2></div>' + (L ? '<div class="log">' + L + '</div>' : '<p class="hint">Aucun mouvement pour le moment.</p>');
}

function numInput(id, val, ph, label) {
  return '<div class="fld"><label for="' + id + '">' + label + '</label><input class="num" id="' + id + '" type="number" inputmode="numeric" min="1" max="365" value="' + (val || '') + '" placeholder="' + (ph || '') + '"></div>';
}

function vSettings() {
  var d = st.settings, act = active(), arch = st.varieties.filter(function (v) { return v.archived; });
  var rows = act.map(function (v) {
    var th = thresholds(v), own = v.warn_days || v.bad_days;
    var del = st.confirm === 'del' + v.id;
    return '<div class="vset"><div class="fld"><label for="nm-' + v.id + '">Nom</label><input class="txt" id="nm-' + v.id + '" type="text" maxlength="60" value="' + esc(v.name) + '"></div>' +
      '<div class="nums">' + numInput('w-' + v.id, v.warn_days, d.warn_days, 'À surveiller (jours)') + numInput('b-' + v.id, v.bad_days, d.bad_days, 'À sortir vite (jours)') + '</div>' +
      '<p class="hint">' + v.total + ' ' + UNIT + ' en stock · seuils ' + (own ? 'propres : ' : 'par défaut : ') + th.warn + ' / ' + th.bad + ' j. Laissez vide pour utiliser les seuils par défaut.</p>' +
      '<div class="rowbtns"><button type="button" class="btn" data-a="saveV" data-v="' + v.id + '">Enregistrer</button>' +
      '<button type="button" class="mini" data-a="archV" data-v="' + v.id + '">Archiver</button>' +
      '<button type="button" class="mini' + (del ? ' sure' : '') + '" data-a="delV" data-v="' + v.id + '">' + (del ? 'Confirmer la suppression' : 'Supprimer') + '</button></div></div>';
  }).join('');
  var archH = arch.length ? '<div class="form"><h2>Variétés archivées</h2><p class="hint" style="margin:0">Elles n\'apparaissent plus dans les saisies. L\'historique est conservé.</p>' + arch.map(function (v) {
    return '<div class="rowbtns" style="justify-content:space-between"><b>' + esc(v.name) + '</b><button type="button" class="mini" data-a="unarchV" data-v="' + v.id + '">Restaurer</button></div>';
  }).join('') + '</div>' : '';
  return '<div class="settings">' +
    '<form class="form"><h2>Seuils de fraîcheur</h2><p class="hint" style="margin:0">Âge du plus ancien lot en stock à partir duquel une variété passe en « à surveiller », puis en « à sortir vite ». S\'applique à toutes les variétés sans seuil propre.</p>' +
    '<div class="nums">' + numInput('s-warn', d.warn_days, '', 'À surveiller après (jours)') + numInput('s-bad', d.bad_days, '', 'À sortir vite après (jours)') + '</div>' +
    '<button type="button" class="primary" data-a="saveSettings">Enregistrer les seuils</button></form>' +
    '<form class="form"><h2>Variétés à stocker</h2>' +
    '<div class="addv"><input id="setnew" type="text" maxlength="60" placeholder="Nouvelle variété (ex. Dahlia café au lait)" aria-label="Nom de la nouvelle variété" autocomplete="off"><button type="button" class="btn" data-a="addVS">Ajouter</button></div>' +
    (rows || '<p class="hint">Aucune variété pour le moment.</p>') + '</form>' + archH +
    (st.demo ? '<div class="form"><h2>Données</h2><p class="hint" style="margin:0">Dans cette démonstration, les données sont stockées dans votre navigateur. Remettez les exemples avec le bouton du bandeau en haut de page.</p></div>' : '<div class="form"><h2>Données et accès</h2><p class="hint" style="margin:0">La sauvegarde est une copie complète de votre base de données.</p>' +
    '<a class="btn" style="text-decoration:none;text-align:center;display:grid;place-items:center" href="/api/backup">Télécharger une sauvegarde</a>' +
    (st.auth ? '<button type="button" class="mini" style="min-height:44px" data-a="logout">Se déconnecter</button>' : '<p class="hint" style="margin:0">Aucun mot de passe n\'est activé (usage local).</p>') + '</div>') + '</div>';
}

function render() {
  document.querySelectorAll('nav.tabs button').forEach(function (b) { b.setAttribute('aria-selected', b.dataset.t === st.tab); });
  var focusId = document.activeElement && document.activeElement.id;
  var h;
  if (!st.loaded) h = '<p class="loading">Chargement…</p>';
  else h = { stock: vStock, 'in': vIn, out: vOut, log: vLog, settings: vSettings }[st.tab]();
  if (st.demo && st.loaded) {
    var sure = st.confirm === 'reset';
    h = '<div class="demo-banner"><span><b>Version de démonstration.</b> Vos saisies restent dans ce navigateur et ne sont envoyées nulle part.</span>' +
      '<button type="button" class="mini' + (sure ? ' sure' : '') + '" data-a="resetDemo">' + (sure ? 'Confirmer la remise à zéro' : 'Remettre les données d\'exemple') + '</button></div>' + h;
  }
  document.getElementById('view').innerHTML = h;
  var f = st.focusNew ? document.getElementById('newv') : (focusId && document.getElementById(focusId));
  st.focusNew = false;
  if (f && f.tagName === 'INPUT') { f.focus(); try { f.setSelectionRange(f.value.length, f.value.length); } catch (e) {} }
}

/* ---------- actions ---------- */
function goTab(t) {
  st.tab = t; st.confirm = null;
  render(); window.scrollTo(0, 0);
  if (t === 'log') guard(loadJournal()); else if (t === 'stock') guard(loadState());
}

function addVariety(inputId) {
  var inp = document.getElementById(inputId), name = inp && inp.value.trim();
  if (!name) { toast('Saisissez un nom de variété.'); return; }
  if (st.busy) return; st.busy = true;
  guard(api('POST', '/api/varieties', { name: name }).then(function (v) {
    st.adding = false;
    if (inputId === 'newv') st.inV = v.id;
    toast(v.name + ' ajoutée');
    return loadState();
  }));
}

function intOrNull(id) {
  var el = document.getElementById(id), n = el ? parseInt(el.value, 10) : NaN;
  return isNaN(n) ? null : n;
}
function patchVariety(id, body, msg) {
  if (st.busy) return; st.busy = true;
  guard(api('PATCH', '/api/varieties/' + id, body).then(function () { toast(msg); return loadState(); }));
}

document.addEventListener('click', function (e) {
  var t = e.target.closest('[data-t]');
  if (t) { goTab(t.dataset.t); return; }
  var b = e.target.closest('[data-a]');
  if (!b) return;
  var a = b.dataset.a, v = b.dataset.v;
  if (a === 'open') st.open[v] = !st.open[v];
  else if (a === 'dq') { var k = b.dataset.k; st[k] = clamp(st[k] + +v); }
  else if (a === 'all') st.outQ = byId(st.outV).total;
  else if (a === 'inV' || a === 'outV') { st[a] = +v; }
  else if (a === 'outM' || a === 'pivot') st[a] = v;
  else if (a === 'toggleAdd') { st.adding = !st.adding; st.focusNew = st.adding; }
  else if (a === 'addV') { addVariety('newv'); return; }
  else if (a === 'addVS') { addVariety('setnew'); return; }
  else if (a === 'saveSettings') {
    if (st.busy) return; st.busy = true;
    guard(api('PUT', '/api/settings', { warn_days: intOrNull('s-warn'), bad_days: intOrNull('s-bad') }).then(function () { toast('Seuils enregistrés'); return loadState(); }));
    return;
  }
  else if (a === 'saveV') {
    patchVariety(+v, { name: document.getElementById('nm-' + v).value, warn_days: intOrNull('w-' + v), bad_days: intOrNull('b-' + v) }, 'Variété enregistrée');
    return;
  }
  else if (a === 'archV') { patchVariety(+v, { archived: true }, 'Variété archivée'); return; }
  else if (a === 'unarchV') { patchVariety(+v, { archived: false }, 'Variété restaurée'); return; }
  else if (a === 'delV') {
    if (st.confirm !== 'del' + v) { st.confirm = 'del' + v; render(); return; }
    if (st.busy) return; st.busy = true; st.confirm = null;
    guard(api('DELETE', '/api/varieties/' + v).then(function () { toast('Variété supprimée'); return loadState(); }));
    return;
  }
  else if (a === 'resetDemo') {
    if (st.confirm !== 'reset') { st.confirm = 'reset'; render(); return; }
    if (st.busy) return; st.busy = true; st.confirm = null;
    guard(api('POST', '/api/demo/reset').then(function () { toast('Données d\'exemple remises'); return loadState(); }));
    return;
  }
  else if (a === 'logout') { api('POST', '/api/logout').then(function () { location.href = '/login.html'; }); return; }
  else if (a === 'saveIn') {
    if (st.busy || !byId(st.inV) || st.inQ <= 0) return; st.busy = true;
    var vin = byId(st.inV), qin = st.inQ;
    guard(api('POST', '/api/entries', { variety_id: st.inV, date: st.inD, qty: qin }).then(function () {
      toast('+' + qin + ' ' + vin.name + ' ajoutées au stock');
      st.tab = 'stock'; st.open[vin.id] = true; return loadState();
    }));
    return;
  }
  else if (a === 'saveOut') {
    if (st.busy || !byId(st.outV) || st.outQ <= 0) return; st.busy = true;
    var vout = byId(st.outV), qout = st.outQ, why = st.outM;
    guard(api('POST', '/api/exits', { variety_id: vout.id, date: today(), qty: qout, reason: why }).then(function () {
      toast('−' + qout + ' ' + vout.name + ' · ' + why + ' (plus anciens lots d\'abord)');
      st.tab = 'stock'; st.open[vout.id] = true; return loadState();
    }));
    return;
  }
  else if (a === 'undo') {
    if (st.confirm !== +v) { st.confirm = +v; render(); return; }
    if (st.busy) return; st.busy = true; st.confirm = null;
    guard(api('DELETE', '/api/movements/' + v).then(function () {
      toast('Mouvement annulé'); return Promise.all([loadState(), loadJournal()]);
    }));
    return;
  }
  render();
});

document.addEventListener('input', function (e) {
  var id = e.target.id;
  if (id === 'q') { st.filter = e.target.value; render(); }
  else if (id === 'qin') { st.inQ = clamp(parseInt(e.target.value, 10) || 0); render(); }
  else if (id === 'qout') { st.outQ = clamp(parseInt(e.target.value, 10) || 0); render(); }
  else if (id === 'din') { if (e.target.value) { st.inD = e.target.value; render(); } }
});
document.addEventListener('submit', function (e) { e.preventDefault(); });
document.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && (e.target.id === 'newv' || e.target.id === 'setnew')) { e.preventDefault(); addVariety(e.target.id); }
});
document.getElementById('theme').addEventListener('click', function () {
  var r = document.documentElement, dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme:dark)').matches;
  r.dataset.theme = dark ? 'light' : 'dark';
});
document.addEventListener('visibilitychange', function () { if (!document.hidden && st.loaded) guard(refresh()); });

render();
guard(loadState());
})();
