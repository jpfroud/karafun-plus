'use strict';
// Page des statistiques (public/stats.html) rendue dans un petit DOM simulé,
// avec des statistiques réelles calculées par evening-stats.js : chiffres
// clés, repères, graphiques SVG, infobulles, repère vertical, vue tableau,
// filtre par personne ou table, tri, export, thème et rafraîchissement.
// Le script de la page s'exécute dans un bac à sable nommé « stats.html »
// pour que test/coverage.js rattache la couverture à la page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { computeStats, insights } = require('../evening-stats');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'stats.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

// ------------------------------------------------------------------ DOM simulé
class Node_ {
  constructor(doc, tag, ns = null) {
    this.ownerDocument = doc; this.tagName = String(tag).toUpperCase(); this.namespaceURI = ns;
    this.children = []; this.parent = null; this.attrs = {}; this.listeners = {}; this.style = {};
    this.hidden = false; this.checked = false; this._text = ''; this.className = '';
  }
  get firstChild() { return this.children[0] || null; }
  get parentNode() { return this.parent; }
  focus() { this.ownerDocument.activeElement = this; this.dispatch('focus'); }
  appendChild(child) { if (child.parent) child.parent.removeChild(child); child.parent = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter(c => c !== child); child.parent = null; return child; }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === 'id') this.ownerDocument.ids.set(String(value), this);
    if (name === 'hidden') this.hidden = true;
    if (name === 'value') this._value = String(value);
  }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  removeAttribute(name) { delete this.attrs[name]; if (name === 'hidden') this.hidden = false; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, props = {}) {
    const event = { type, target: this, currentTarget: this, clientX: 0, clientY: 0, preventDefault() {}, ...props };
    for (const fn of this.listeners[type] || []) fn(event);
    return event;
  }
  get textContent() { return this.tagName === '#TEXT' ? this._text : this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this.children = []; if (this.tagName === '#TEXT') this._text = String(value); else if (value !== '') this.appendChild(this.ownerDocument.createTextNode(value)); }
  get clientWidth() { return this.ownerDocument.width; }
  getBoundingClientRect() { return { left: 10, top: 20, width: this.ownerDocument.width, height: 40 }; }
  descendants() { return this.children.flatMap(c => [c, ...c.descendants()]); }
  find(predicate) { return this.descendants().filter(predicate); }
  byTag(tag) { return this.find(n => n.tagName === tag.toUpperCase()); }
  options() { return this.byTag('option'); }
  get value() {
    if (this.tagName === 'SELECT') return this._selected ?? this.options()[0]?.getAttribute('value') ?? '';
    return this._value ?? '';
  }
  set value(v) { this._value = String(v); if (this.tagName === 'SELECT') this._selected = String(v); }
}

function makeDocument(width = 900) {
  const doc = { ids: new Map(), width };
  doc.createElement = tag => new Node_(doc, tag);
  doc.createElementNS = (ns, tag) => new Node_(doc, tag, ns);
  doc.createTextNode = text => { const n = new Node_(doc, '#text'); n._text = String(text); return n; };
  doc.documentElement = new Node_(doc, 'html');
  // Éléments de la page, avec la balise de leur déclaration dans stats.html.
  for (const [, tag, id] of html.matchAll(/<(\w+)[^>]*\sid="([^"]+)"/g)) {
    const el = new Node_(doc, tag);
    el.setAttribute('id', id);
    if (new RegExp(`id="${id}"[^>]*\\shidden`).test(html)) el.hidden = true;
  }
  doc.getElementById = id => doc.ids.get(id) || null;
  return doc;
}

// ------------------------------------------------------------------ données
const T0 = Date.UTC(2026, 9, 3, 18, 0);
const at = m => T0 + m * 60000;
function eveningEvents() {
  const events = [];
  let seq = 0;
  const e = (m, ev, f = {}) => events.push({ seq: ++seq, t: at(m), ev, ...f });
  e(0, 'evening.started');
  for (const [pid, tableId] of [['pA', '1'], ['pB', '1'], ['pC', '2'], ['pD', '2'], ['pE', '3']]) e(0, 'person.joined', { personId: pid, tableId });
  e(0, 'person.bonus', { personId: 'pB', level: 1 });
  e(1, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Soulmate' });
  e(2, 'song.requested', { personId: 'pB', entryId: 'b1', title: 'Is This Love?' });
  e(3, 'song.requested', { personId: 'pC', entryId: 'c1', title: 'Bella' });
  e(3, 'song.requested', { personId: 'pD', entryId: 'd1', title: 'Slow Motion' });
  e(3, 'song.requested', { personId: 'pE', entryId: 'e1', title: 'Jamais chanté' });
  e(5, 'queue.sample', { ready: 4, songsListed: 5, present: 5 });
  e(6, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], source: 'queue', title: 'Soulmate' });
  e(10, 'stage.ended', { queueId: 1, playedSec: 240 });
  e(10, 'karaoke.phase', { phase: 'between', blocker: 'awaiting-presence' });
  e(11, 'stage.started', { queueId: 2, entryId: 'b1', ids: ['pB', 'pC'], source: 'queue' });
  e(15, 'stage.ended', { queueId: 2, playedSec: 240 });
  e(15, 'karaoke.phase', { phase: 'between', blocker: 'push-delay' });
  e(16, 'queue.sample', { ready: 2, songsListed: 3, present: 5 });
  e(16, 'stage.started', { queueId: 3, source: 'battle', title: 'Battle collective' });
  e(20, 'stage.ended', { queueId: 3, playedSec: 240 });
  e(25, 'stage.started', { queueId: 4, entryId: 'c1', ids: ['pC'], source: 'queue' });
  e(29, 'stage.ended', { queueId: 4, playedSec: 240 });
  e(30, 'battle.proposed', { ballotId: 'x', proposerId: 'pA', eligible: 5 });
  e(31, 'battle.decided', { ballotId: 'x', outcome: 'approved', voters: 4 });
  e(31, 'battle.staffLaunch', { ballotId: 'y', title: 'Bar' });
  e(32, 'battle.decided', { ballotId: 'z', outcome: 'quorum', voters: 1 });
  e(40, 'stage.started', { queueId: 5, entryId: 'd1', ids: ['pD'], source: 'queue' });
  e(44, 'stage.ended', { queueId: 5, playedSec: 240 });
  e(45, 'queue.sample', { ready: 1, songsListed: 1, present: 4 });
  e(70, 'stage.started', { queueId: 6, source: 'native', title: 'Hors file' });
  e(70, 'person.left', { personId: 'pE' });
  return events;
}
const meta = { eveningId: '2026-10-03_2000_abcd', startedAt: at(0), endedAt: null,
  roster: { pA: { name: 'Alice' }, pB: { name: 'Bruno' }, pC: { name: 'Chloé' }, pD: { name: 'Dina' }, pE: { name: 'Eve' } },
  tables: { 1: { name: 'Table 1' }, 2: { name: 'Terrasse' }, 3: { name: 'Table 3' } } };
function apiView({ live = true, events = eveningEvents(), id = meta.eveningId } = {}) {
  const stats = computeStats({ meta: { ...meta, eveningId: id, endedAt: live ? null : at(90) }, events, now: at(72), live });
  const names = { people: Object.fromEntries(Object.entries(meta.roster).map(([k, v]) => [k, v.name])), tables: { 1: 'Table 1', 2: 'Terrasse' } };
  return { evening: { id, startedAt: stats.evening.startedAt, endedAt: stats.evening.endedAt, current: live, truncated: !live },
    names, stats, insights: insights(stats, { nameOf: pid => names.people[pid], tableName: tid => names.tables[tid] || `Table ${tid}` }),
    generatedAt: at(72), journalError: live ? 'disque plein' : null };
}

// ------------------------------------------------------------------ page
function loadPage({ search = '?key=cle-bar', width = 900, responses = {}, storage = {}, brokenStorage = false } = {}) {
  const doc = makeDocument(width);
  const fetches = [], assigned = [], timers = [];
  const routes = { '/api/staff/stats/evenings': () => ({ ok: true, body: { current: meta.eveningId, evenings: [
    { id: meta.eveningId, startedAt: at(0), current: true, people: 5 }, { id: '2026-10-02_2000_beef', startedAt: at(-1440), people: 0 }] } }),
  '/api/staff/stats': url => ({ ok: true, body: url.searchParams.get('evening') === 'current' ? apiView() : apiView({ live: false, id: url.searchParams.get('evening') }) }),
  ...responses };
  const store = { ...storage };
  const localStorage = brokenStorage ? { getItem() { throw new Error('bloqué'); }, setItem() { throw new Error('bloqué'); }, removeItem() { throw new Error('bloqué'); } } :
    { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  const windowListeners = {};
  const context = {
    document: doc, location: { search, assign: url => assigned.push(url) }, localStorage, URLSearchParams, URL, Date, Intl, Math, JSON, Number, String, Object, Array, Set, Map, Promise, Error,
    window: { innerWidth: width, addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {},
    fetch: async url => {
      const parsed = new URL(url, 'http://bar.local');
      fetches.push(parsed);
      const route = routes[parsed.pathname];
      const answer = route ? await route(parsed) : { ok: false, status: 404, body: { error: 'Introuvable' } };
      return { ok: answer.ok, status: answer.status || 200, json: async () => answer.body };
    },
  };
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'stats.html' });
  return { doc, $: id => doc.getElementById(id), fetches, assigned, timers, store, windowListeners };
}
const text = el => el.textContent;
const marks = (el, pred = () => true) => el.find(n => (n.listeners.pointerenter || []).length && pred(n));

test('page des statistiques : chiffres clés, repères, graphiques et tableaux de la soirée en cours', async () => {
  const page = loadPage();
  await settle();
  const { $ } = page;
  assert.equal(page.fetches[0].searchParams.get('key'), 'cle-bar');
  assert.equal($('backLink').getAttribute('href'), '/staff?key=cle-bar');
  assert.match(text($('eveningLine')), /en cours · 5 inscrits/);
  assert.equal($('livePill').hidden, false);
  assert.equal($('errorBox').hidden, false, 'erreur du journal signalée');
  assert.match(text($('errorBox')), /disque plein/);
  assert.equal($('eveningSelect').options().length, 2);
  assert.match(text($('eveningSelect')), /Ce soir/);
  const kpis = $('kpis').children;
  assert.equal(kpis.length, 8);
  assert.match(text(kpis[0]), /Attente moyenne pour chanter/);
  assert.match(text(kpis[2]), /Équité de la rotation/);
  assert.ok($('insights').children.length >= 3);
  assert.match(text($('insights')), /Plus longue attente/);
  const ids = $('charts').children.map(c => c.getAttribute('id'));
  assert.deepEqual(ids, ['chartTimeline', 'chartWaits', 'chartRates', 'chartQueue', 'chartHistogram', 'chartDead', 'chartHourly', 'chartTables', 'cardSocial', 'cardSingers']);
  for (const id of ids.slice(0, 8)) assert.ok(page.doc.getElementById(id).byTag('svg').length, `${id} : graphique SVG`);
  assert.ok($('definitions').children.length > 10, 'définitions des mesures');
  // Légende pour les graphiques à plusieurs séries.
  assert.match(text(page.doc.getElementById('chartTimeline')), /Solo.*Duo.*Battle.*Hors file/s);
  assert.match(text(page.doc.getElementById('chartRates')), /Part attendue/);
  // Tableau des chanteurs, avec chaque personne.
  const singers = page.doc.getElementById('cardSingers');
  assert.equal(singers.byTag('tbody')[0].children.length, 5);
  assert.match(text(singers), /Alice.*Table 1/s);
  assert.match(text(page.doc.getElementById('cardSocial')), /Vote terminé : acceptée \(4 voix\).*Battle lancée par le bar : « Bar ».*pas assez de votants/s);
  assert.match(text(page.doc.getElementById('cardSocial')), /invitations.*refusées.*sans réponse.*demandes « Duo \? »/s,
    'invitations restées sans réponse au départ du titre');
  // Soirée en cours : rafraîchie toutes les 15 s.
  assert.equal(page.timers.at(-1).ms, 15000);
  const before = page.fetches.length;
  page.timers.at(-1).fn();
  await settle();
  assert.equal(page.fetches.length, before + 1);
});

test('infobulles au survol, au clavier et repère vertical sur le déroulé et la file', async () => {
  const page = loadPage();
  await settle();
  const tip = page.$('tooltip');
  const timeline = page.doc.getElementById('chartTimeline');
  const stage = marks(timeline, n => n.tagName === 'RECT' && n.getAttribute('class') === 'st-mark')[0];
  stage.dispatch('pointerenter', { clientX: 100, clientY: 200 });
  assert.equal(tip.hidden, false);
  assert.match(text(tip), /Soulmate.*Alice/s);
  assert.ok(Number.parseFloat(tip.style.left) >= 8);
  stage.dispatch('pointerleave');
  assert.equal(tip.hidden, true);
  stage.dispatch('focus');
  assert.equal(tip.hidden, false);
  stage.dispatch('blur');
  assert.equal(tip.hidden, true);
  assert.equal(stage.getAttribute('tabindex'), '0');
  // Repère vertical : heure et titre en cours à cet endroit.
  const svg = timeline.byTag('svg')[0];
  svg.dispatch('pointermove', { clientX: 10 + 900 * 0.3, target: svg });
  const cross = svg.children.filter(n => n.tagName === 'LINE').at(-1);
  assert.equal(cross.getAttribute('visibility'), 'visible');
  assert.equal(tip.hidden, false);
  svg.dispatch('pointermove', { clientX: 15, target: svg });
  assert.equal(cross.getAttribute('visibility'), 'hidden', 'à gauche, sur les prénoms');
  svg.dispatch('pointermove', { clientX: 10 + 900 * 0.9, target: stage });
  svg.dispatch('pointerleave');
  assert.equal(tip.hidden, true);
  const gap = marks(timeline, n => n.getAttribute('fill') === 'var(--gap-band)')[0];
  gap.dispatch('pointermove', { clientX: 50 });
  assert.match(text(tip), /temps mort/);
  // File d'attente : valeur la plus proche sous le pointeur.
  const queue = page.doc.getElementById('chartQueue').byTag('svg')[0];
  const overlay = queue.children.at(-1);
  overlay.dispatch('pointermove', { clientX: 500 });
  assert.match(text(tip), /titres prêts.*personnes présentes|personnes présentes.*titres prêts/s);
  overlay.dispatch('pointerleave');
  assert.equal(tip.hidden, true);
  // Barres, colonnes et lignes : chaque marque a son infobulle.
  for (const id of ['chartWaits', 'chartRates', 'chartHistogram', 'chartDead', 'chartHourly', 'chartTables']) {
    const target = marks(page.doc.getElementById(id))[0];
    assert.ok(target, id);
    target.dispatch('pointerenter', { clientX: 10, clientY: 10 });
    assert.equal(tip.hidden, false, id);
    assert.ok(text(tip).length > 3, id);
  }
});

test('vue tableau, repère sur une personne ou une table, tri des chanteurs', async () => {
  const page = loadPage();
  await settle();
  const waits = page.doc.getElementById('chartWaits');
  const toggle = waits.byTag('button')[0];
  const plot = waits.children.find(n => n.className === 'st-plot');
  const tableWrap = waits.children.find(n => n.className === 'st-table-wrap');
  assert.equal(tableWrap.hidden, true);
  toggle.dispatch('click');
  assert.equal(tableWrap.hidden, false);
  assert.equal(plot.hidden, true);
  assert.equal(text(toggle), 'Graphique');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.match(text(tableWrap), /Chloé/);
  toggle.dispatch('click');
  assert.equal(tableWrap.hidden, true);
  // Repère : une personne.
  const focus = page.$('focusSelect');
  assert.ok(focus.options().some(o => o.getAttribute('value') === 'p:pA'));
  focus.value = 'p:pA';
  focus.dispatch('change', { target: focus });
  const card = page.$('focusCard');
  assert.equal(card.hidden, false);
  assert.match(text(card), /Soirée d’Alice.*Table 1.*Soulmate.*chanté/s);
  const muted = marks(page.doc.getElementById('chartTimeline'), n => n.getAttribute('fill') === 'var(--mark-muted)');
  assert.ok(muted.length > 0, 'les autres passent en gris');
  assert.equal(page.doc.getElementById('cardSingers').find(n => n.className === 'focus').length, 1);
  // Repère : une table.
  focus.value = 't:2';
  focus.dispatch('change', { target: focus });
  assert.match(text(card), /Terrasse.*Chloé.*Dina/s);
  focus.value = 'p:inconnu';
  focus.dispatch('change', { target: focus });
  assert.equal(card.hidden, true);
  focus.value = 't:inconnue';
  focus.dispatch('change', { target: focus });
  assert.equal(card.hidden, true);
  focus.value = '';
  focus.dispatch('change', { target: focus });
  assert.equal(card.hidden, true);
  // Tri du tableau des chanteurs.
  const header = () => page.doc.getElementById('cardSingers').byTag('button');
  const firstRow = () => text(page.doc.getElementById('cardSingers').byTag('tbody')[0].children[0].children[0]);
  header().find(b => text(b).startsWith('Chanteur')).dispatch('click');
  assert.equal(firstRow(), 'Alice');
  header().find(b => text(b).startsWith('Chanteur')).dispatch('click');
  assert.equal(firstRow(), 'Eve');
  header().find(b => text(b).startsWith('Attente moy.')).dispatch('click');
  assert.match(text(header().find(b => text(b).startsWith('Attente moy.'))), /↓/);
  header().find(b => text(b).startsWith('Table')).dispatch('click');
  assert.match(firstRow(), /^(Alice|Bruno)$/);
});

test('export, thème, autre soirée, erreurs et soirée vide', async () => {
  const page = loadPage({ storage: { statsTheme: 'dark' } });
  await settle();
  assert.equal(page.doc.documentElement.getAttribute('data-theme'), 'dark', 'thème mémorisé');
  page.$('exportNames').checked = true;
  page.$('downloadBtn').dispatch('click');
  const url = new URL(page.assigned[0], 'http://bar.local');
  assert.equal(url.pathname, '/api/staff/stats/export');
  assert.equal(url.searchParams.get('names'), '1');
  assert.equal(url.searchParams.get('evening'), 'current');
  assert.equal(url.searchParams.get('key'), 'cle-bar');
  const theme = page.$('themeSelect');
  theme.value = 'light';
  theme.dispatch('change', { target: theme });
  assert.equal(page.doc.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(page.store.statsTheme, 'light');
  theme.value = '';
  theme.dispatch('change', { target: theme });
  assert.equal(page.doc.documentElement.getAttribute('data-theme'), null);
  assert.equal(page.store.statsTheme, undefined);
  // Soirée archivée : pas de rafraîchissement automatique.
  const select = page.$('eveningSelect');
  const timers = page.timers.length;
  select.value = '2026-10-02_2000_beef';
  select.dispatch('change', { target: select });
  await settle();
  assert.equal(page.$('livePill').hidden, true);
  assert.match(text(page.$('eveningLine')), /dernière ligne du journal illisible ignorée/);
  assert.equal(page.timers.length, timers, 'aucun rafraîchissement');
  // Redimensionnement : nouveau rendu après un court délai.
  page.windowListeners.resize[0]();
  page.timers.at(-1).fn();
  assert.ok(page.$('charts').children.length);

  // Erreurs du serveur.
  const broken = loadPage({ brokenStorage: true, responses: {
    '/api/staff/stats': () => ({ ok: false, status: 500, body: {} }),
    '/api/staff/stats/evenings': () => ({ ok: false, status: 403, body: { error: 'Réservé au bar' } }) } });
  await settle();
  assert.equal(broken.$('errorBox').hidden, false);
  assert.match(text(broken.$('errorBox')), /Statistiques indisponibles : HTTP 500 · Liste des soirées indisponible : Réservé au bar/);
  broken.$('themeSelect').value = 'dark';
  broken.$('themeSelect').dispatch('change', { target: broken.$('themeSelect') });
  assert.equal(broken.doc.documentElement.getAttribute('data-theme'), 'dark', 'thème appliqué même sans stockage');
  const noList = loadPage({ responses: { '/api/staff/stats/evenings': () => ({ ok: false, status: 500, body: {} }) } });
  await settle();
  assert.match(text(noList.$('errorBox')), /Liste des soirées indisponible : HTTP 500 · Journal de soirée : disque plein/);

  // Soirée qui commence : aucun passage, pas encore de repère.
  const empty = loadPage({ width: 360, responses: { '/api/staff/stats': () => ({ ok: true, body: apiView({ events: [{ seq: 1, t: at(0), ev: 'evening.started' }] }) }) } });
  await settle();
  assert.match(text(empty.$('insights')), /Les repères apparaîtront/);
  assert.match(text(empty.doc.getElementById('chartTimeline')), /Pas encore de données/);
  assert.match(text(empty.$('kpis')), /pas encore de chanteurs.*aucun entre deux chansons/s);
});

// ------------------------------------------------------------------ QA navigateur du 2026-10-03
// Found by /qa on 2026-10-03
// Report: .gstack/qa-reports/run-20261003T140104Z/qa-report-127.0.0.1-2026-10-03.md
const withView = patch => ({ '/api/staff/stats': () => { const view = apiView(); patch(view); return { ok: true, body: view }; } });
const plotTexts = (page, id) => page.doc.getElementById(`${id}Plot`).byTag('svg')[0].children.filter(n => n.tagName === 'TEXT').map(text);

// Regression: ISSUE-023 — à la souris, le repère vertical passait sous le curseur et cachait l'info-bulle du Déroulé
test('déroulé et file : le repère vertical ne capte jamais le pointeur', async () => {
  const page = loadPage();
  await settle();
  for (const id of ['chartTimeline', 'chartQueue']) {
    const svg = page.doc.getElementById(id).byTag('svg')[0];
    const cross = svg.children.filter(n => n.tagName === 'LINE' && n.getAttribute('visibility') === 'hidden').at(-1);
    assert.equal(cross.getAttribute('pointer-events'), 'none', `${id} : la barre survolée garde son info-bulle`);
  }
});

// Regression: ISSUE-024 — la vue « Tableau » revenait au graphique à chaque rafraîchissement et changement de Repère
test('vue tableau : gardée au rafraîchissement de 15 s et au changement de Repère, jusqu’au retour au graphique', async () => {
  const page = loadPage();
  await settle();
  const button = id => page.doc.getElementById(id).byTag('button')[0];
  const tableShown = id => !page.doc.getElementById(id).children.find(n => n.className === 'st-table-wrap').hidden;
  button('chartWaits').dispatch('click');
  button('chartQueue').dispatch('click');
  page.timers.at(-1).fn();
  await settle();
  for (const id of ['chartWaits', 'chartQueue']) {
    assert.equal(button(id).getAttribute('aria-pressed'), 'true', `${id} après rafraîchissement`);
    assert.equal(tableShown(id), true);
    assert.equal(text(button(id)), 'Graphique');
  }
  assert.equal(button('chartTimeline').getAttribute('aria-pressed'), 'false', 'les autres cartes restent en graphique');
  const focus = page.$('focusSelect');
  focus.value = 'p:pA';
  focus.dispatch('change', { target: focus });
  assert.equal(tableShown('chartWaits'), true, 'changement de Repère : vue gardée');
  button('chartWaits').dispatch('click');
  page.timers.at(-1).fn();
  await settle();
  assert.equal(tableShown('chartWaits'), false, 'retour au graphique gardé aussi');
  assert.equal(tableShown('chartQueue'), true);
});

// Regression: ISSUE-028 — « File d'attente au fil de la soirée » : rien au toucher ni au clavier
test('file d’attente : info-bulle au toucher (gardée doigt levé) et parcours au clavier', async () => {
  const page = loadPage();
  await settle();
  const tip = page.$('tooltip');
  const svg = page.doc.getElementById('chartQueue').byTag('svg')[0];
  const overlay = svg.children.at(-1);
  const cross = svg.children.filter(n => n.tagName === 'LINE').at(-1);
  overlay.dispatch('pointerdown', { clientX: 300, pointerType: 'touch' });
  assert.equal(tip.hidden, false, 'un toucher montre le relevé');
  assert.equal(cross.getAttribute('visibility'), 'visible');
  overlay.dispatch('pointerleave', { pointerType: 'touch' });
  assert.equal(tip.hidden, false, 'doigt levé : l’info-bulle reste lisible');
  overlay.dispatch('pointerleave', { pointerType: 'mouse' });
  assert.equal(tip.hidden, true, 'la souris qui sort la cache');
  assert.equal(overlay.getAttribute('tabindex'), '0', 'atteint au clavier');
  overlay.dispatch('focus');
  assert.equal(tip.hidden, false);
  const last = text(tip);
  assert.match(last, /19:00|18:45|titres prêts/);
  overlay.dispatch('keydown', { key: 'Home' });
  const first = text(tip);
  assert.notEqual(first, last, 'Début : premier relevé');
  assert.match(overlay.getAttribute('aria-valuetext'), /titres prêts.*personnes présentes/);
  overlay.dispatch('keydown', { key: 'ArrowRight' });
  assert.notEqual(text(tip), first, '→ : relevé suivant');
  overlay.dispatch('keydown', { key: 'Enter' });
  overlay.dispatch('blur');
  assert.equal(tip.hidden, true);
});

// Regression: ISSUE-034 — après un rafraîchissement, l'info-bulle restait seule avec l'ancien contenu
test('rafraîchissement : l’info-bulle d’un graphique redessiné disparaît avec son repère', async () => {
  const page = loadPage();
  await settle();
  const overlay = page.doc.getElementById('chartQueue').byTag('svg')[0].children.at(-1);
  overlay.dispatch('pointermove', { clientX: 400 });
  assert.equal(page.$('tooltip').hidden, false);
  page.timers.at(-1).fn();
  await settle();
  assert.equal(page.$('tooltip').hidden, true);
});

// Regression: ISSUE-025 — au téléphone, les libellés de la répartition des attentes se chevauchaient
test('répartition des attentes : libellés courts et unité sous l’axe au téléphone, complets sur PC', async () => {
  const phone = loadPage({ width: 390 });
  await settle();
  const labels = plotTexts(phone, 'chartHistogram');
  for (const short of ['0–10', '10–20', '20–30', '30–45', '45–60', '60–90', '90+']) assert.ok(labels.includes(short), `${short} : ${labels.join(' | ')}`);
  assert.ok(labels.includes('attente en minutes'));
  assert.ok(!labels.some(label => /^\d+–\d+ min$/.test(label)), 'pas de libellé long qui déborderait de sa colonne');
  const pc = loadPage({ width: 900 });
  await settle();
  assert.ok(plotTexts(pc, 'chartHistogram').includes('10–20 min'));
  assert.ok(!plotTexts(pc, 'chartHistogram').includes('attente en minutes'));
});

// Regression: ISSUE-026 — graduations arrondies en double ou fausses (« 0 min, 1 min, 1 min, 2 min »)
test('graduations : attentes courtes en secondes et minutes exactes, comptes entiers sans doublon', async () => {
  const events = [{ seq: 1, t: at(0), ev: 'evening.started' }];
  let seq = 1;
  const e = (sec, ev, f = {}) => events.push({ seq: ++seq, t: at(0) + sec * 1000, ev, ...f });
  e(0, 'person.joined', { personId: 'pA', tableId: '1' });
  e(0, 'person.joined', { personId: 'pB', tableId: '1' });
  e(0, 'song.requested', { personId: 'pA', entryId: 'a1', title: 'Un' });
  e(0, 'song.requested', { personId: 'pB', entryId: 'b1', title: 'Deux' });
  e(52, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['pA'], source: 'queue' });
  e(74, 'stage.ended', { queueId: 1, playedSec: 22 });
  e(74, 'stage.started', { queueId: 2, entryId: 'b1', ids: ['pB'], source: 'queue' });
  e(96, 'stage.ended', { queueId: 2, playedSec: 22 });
  e(100, 'queue.sample', { ready: 0, songsListed: 0, present: 0 });
  e(160, 'queue.sample', { ready: 0, songsListed: 0, present: 0 });
  const page = loadPage({ responses: { '/api/staff/stats': () => ({ ok: true, body: apiView({ events }) }) } });
  await settle();
  const waits = plotTexts(page, 'chartWaits').filter(label => /^\d+ (s|min)( \d\d)?$/.test(label));
  assert.deepEqual(waits, ['0 s', '15 s', '30 s', '45 s', '1 min', '1 min 15'], 'pas de 15 s jusqu’à 74 s : libellés distincts et justes');
  const queue = plotTexts(page, 'chartQueue').filter(label => /^\d+$/.test(label));
  assert.deepEqual(queue, ['0', '1', '2'], 'file vide : graduations entières, sans « 2, 2, 1, 1, 0 »');
  // Graduations de l'axe (alignées à droite), sans les totaux écrits au-dessus des colonnes.
  const columns = page.doc.getElementById('chartHistogramPlot').byTag('svg')[0].children
    .filter(n => n.tagName === 'TEXT' && n.getAttribute('text-anchor') === 'end').map(text);
  assert.equal(new Set(columns).size, columns.length, `colonnes : ${columns.join(', ')}`);
});

// Regression: ISSUE-030 — tri par prénom : « Émilie » classée après « Farid »
// Regression: ISSUE-031 — « Soirée de Émilie » au lieu de « Soirée d’Émilie »
test('chanteurs : ordre alphabétique français et « Soirée d’Émilie »', async () => {
  const page = loadPage({ responses: withView(view => { view.names.people.pD = 'Farid'; view.names.people.pE = 'Émilie'; }) });
  await settle();
  const singers = () => page.doc.getElementById('cardSingers');
  const names = () => singers().byTag('tbody')[0].children.map(row => text(row.children[0]));
  singers().byTag('button').find(b => text(b).startsWith('Chanteur')).dispatch('click');
  assert.deepEqual(names(), ['Alice', 'Bruno', 'Chloé', 'Émilie', 'Farid']);
  singers().byTag('button').find(b => text(b).startsWith('Chanteur')).dispatch('click');
  assert.deepEqual(names(), ['Farid', 'Émilie', 'Chloé', 'Bruno', 'Alice']);
  const focus = page.$('focusSelect');
  assert.deepEqual(focus.options().filter(o => /^p:/.test(o.getAttribute('value'))).map(o => text(o).split(' · ')[0]), ['Alice', 'Bruno', 'Chloé', 'Émilie', 'Farid']);
  focus.value = 'p:pE';
  focus.dispatch('change', { target: focus });
  assert.equal(text(page.$('focusCard').byTag('h2')[0]), 'Soirée d’Émilie');
  focus.value = 'p:pB';
  focus.dispatch('change', { target: focus });
  assert.equal(text(page.$('focusCard').byTag('h2')[0]), 'Soirée de Bruno');
});

// Regression: ISSUE-032 — équité : « pas assez de chanteurs » alors que 6 personnes avaient chanté
// Regression: ISSUE-033 — « (1 intervalles) »
test('équité et temps morts : la vraie raison, et les accords au singulier', async () => {
  const kpi = async patch => {
    const page = loadPage({ responses: withView(patch) });
    await settle();
    return page;
  };
  const fairness = page => text(page.$('kpis').children[2]);
  let page = await kpi(view => { view.stats.fairness = { ...view.stats.fairness, jain: null, n: 0 }; });
  assert.match(fairness(page), /personne n’est encore là depuis 30 min/, 'le seuil de durée, pas le nombre');
  assert.ok(!/pas assez de chanteurs/.test(fairness(page)));
  page = await kpi(view => { view.stats.fairness = { ...view.stats.fairness, jain: null, n: 2 }; });
  assert.match(fairness(page), /aucun passage pour le moment/);
  page = await kpi(view => { view.stats.fairness = { ...view.stats.fairness, jain: 1, n: 1, bonusPeople: 0 }; });
  assert.match(fairness(page), /sur 1 chanteur ·/);
  page = await kpi(view => { view.stats.global = { ...view.stats.global, deadGapCount: 1 }; });
  assert.match(text(page.doc.getElementById('chartDead').byTag('p')[0]), /\(1 intervalle\)$/);
});

// Regression: ISSUE-035 — « Rythme de passage » : le trait de la part attendue barrait les valeurs
test('rythme de passage : la valeur s’écrit après le trait de la part attendue quand il touche la barre', async () => {
  const page = loadPage({ responses: withView(view => {
    // Part attendue juste après le bout de chaque barre : le trait touche la valeur.
    for (const singer of view.stats.singers) if (singer.fairRate != null) singer.fairRate = (singer.turnsPerHour || 0) * 1.05 + 0.01;
  }) });
  await settle();
  const groups = page.doc.getElementById('chartRatesPlot').byTag('g');
  let checked = 0;
  for (const g of groups) {
    const tick = g.children.find(n => n.tagName === 'RECT' && n.getAttribute('fill') === 'var(--ref)');
    const value = g.children.filter(n => n.tagName === 'TEXT').at(-1);
    if (!tick) continue;
    checked++;
    assert.ok(Number(value.getAttribute('x')) >= Number(tick.getAttribute('x')) + 2 + 6, `${text(value)} après le trait`);
  }
  assert.ok(checked >= 2);
});

// Regression: ISSUE-036 — « Tous les chanteurs » : la dernière colonne coupée à 1366 px
test('tous les chanteurs : en-têtes sur deux lignes au besoin pour tenir dans la carte', () => {
  const css = html.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /#cardSingers \.st-table th\s*\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(rule, /white-space:\s*normal/);
});

// Regression: relecture PR #11 — chaque rafraîchissement (15 s) et chaque tri
// reconstruisaient la page et le focus clavier repartait au début.
test('focus clavier gardé au tri et au rafraîchissement : en-tête, bouton « Tableau », curseur de la file', async () => {
  const page = loadPage();
  await settle();
  const card = id => page.doc.getElementById(id);
  const active = () => page.doc.activeElement;
  const header = card('cardSingers').byTag('button').find(b => /^Chanteur/.test(text(b)));
  header.focus();
  header.dispatch('click');
  await settle();
  assert.notEqual(active(), header, 'tableau redessiné');
  assert.equal(active().tagName, 'BUTTON');
  assert.equal(text(active()), 'Chanteur ↑', 'le focus reste sur l’en-tête trié');
  assert.equal(card('cardSingers').byTag('button').includes(active()), true);
  // Rafraîchissement de la soirée en cours : bouton « Tableau » de la file.
  const toggle = () => card('chartQueue').byTag('button')[0];
  const before = toggle();
  before.focus();
  page.timers.at(-1).fn();
  await settle();
  assert.notEqual(toggle(), before, 'carte redessinée');
  assert.equal(active(), toggle());
  // Curseur de la file : relevé choisi au clavier, gardé avec son info-bulle.
  const slider = () => card('chartQueue').find(n => n.getAttribute('role') === 'slider')[0];
  slider().focus();
  slider().dispatch('keydown', { key: 'Home' });
  const shown = slider().getAttribute('aria-valuetext');
  page.timers.at(-1).fn();
  await settle();
  assert.equal(active(), slider());
  assert.equal(slider().getAttribute('aria-valuetext'), shown);
  assert.equal(page.$('tooltip').hidden, false);
  // Focus hors des graphiques : rien n'est déplacé.
  page.doc.activeElement = page.$('eveningSelect');
  page.timers.at(-1).fn();
  await settle();
  assert.equal(active(), page.$('eveningSelect'));
});

// Regression: relecture PR #11 — une réponse lente d'une autre soirée
// écrasait celle choisie entre-temps.
test('changer de soirée pendant un chargement : la page montre toujours la soirée choisie', async () => {
  for (const slow of ['current', 'past']) {
    const held = [];
    const past = '2026-10-02_2000_beef';
    const page = loadPage({ responses: { '/api/staff/stats': url => {
      const evening = url.searchParams.get('evening');
      const answer = { ok: true, body: evening === 'current' ? apiView() : apiView({ live: false, id: evening }) };
      return (evening === 'current') === (slow === 'current') ? new Promise(resolve => held.push(() => resolve(answer))) : answer;
    } } });
    await settle();
    const select = page.$('eveningSelect');
    const choose = async value => { select.value = value; select.dispatch('change', { target: select }); await settle(); };
    if (slow === 'past') {
      held.shift()?.();
      await settle();
      await choose(past);
      await choose('current');
    } else await choose(past);
    const expected = slow === 'past' ? 'current' : past;
    held.shift()();
    await settle();
    assert.equal(page.$('main').className, 'st-main');
    assert.equal(/en cours/.test(text(page.$('eveningLine'))), expected === 'current', `réponse lente de ${slow} ignorée`);
    assert.equal(page.$('livePill').hidden, expected !== 'current');
    const timers = page.timers.filter(t => t.ms === 15000).length;
    assert.ok(expected === 'current' ? timers >= 1 : true);
  }
});
