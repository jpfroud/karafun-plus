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
  // Focus clavier par défaut ; un test met focusVisible à false pour un toucher.
  matches(selector) { return selector === ':focus-visible' ? this.ownerDocument.focusVisible !== false : false; }
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
  // Mise en page facultative (doc.layout) : chaque lecture peut déplacer le défilement.
  get clientWidth() { this.ownerDocument.layout?.(); return this.ownerDocument.width; }
  get offsetHeight() { return this.ownerDocument.layout?.(this)?.height; }
  getBoundingClientRect() { return this.ownerDocument.layout?.(this) || { left: 10, top: 20, width: this.ownerDocument.width, height: 40 }; }
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
  // Électorat agrandi pendant le vote : la décision donne le nombre final.
  e(32, 'battle.decided', { ballotId: 'z', outcome: 'quorum', voters: 1, eligible: 7 });
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
function apiView({ live = true, events = eveningEvents(), id = meta.eveningId, now = at(72), endedAt = live ? null : at(90) } = {}) {
  const stats = computeStats({ meta: { ...meta, eveningId: id, endedAt }, events, now, live });
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
  return { doc, $: id => doc.getElementById(id), fetches, assigned, timers, store, windowListeners, window: context.window, context };
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
  // Ouverture et clôture : chaque ligne dit de quel électorat elle parle
  // (ancien journal sans électorat final : seulement les voix).
  assert.match(text(page.doc.getElementById('cardSocial')),
    /Vote proposé \(5 votants possibles à l’ouverture\).*Vote terminé : acceptée \(4 voix\).*pas assez de votants \(1 voix sur 7 votants possibles\)/s);
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

// Regression: test au bar du 4 octobre — sur iPhone, en lisant la page sous
// « Attente avant de chanter », la vue remontait vers ce graphique toutes les
// 2-3 s : chaque rendu (rafraîchissement de 15 s, redimensionnement quand la
// barre d'adresse se replie) effaçait les cartes avant de les redessiner, la
// page raccourcie un instant ramenait le défilement plus haut, et Safari n'a
// pas d'ancrage pour le remettre.
test('défilement gardé au rafraîchissement et au redimensionnement, sans ancrage du navigateur (iPhone)', async () => {
  let calls = 0, respond = null;
  // Second chargement : Eve chante, une ligne de plus dans les attentes.
  const withEve = () => {
    const events = eveningEvents();
    events.push({ t: at(50), ev: 'stage.started', queueId: 7, entryId: 'e1', ids: ['pE'], source: 'queue' }, { t: at(54), ev: 'stage.ended', queueId: 7, playedSec: 240 });
    return events.sort((a, b) => a.t - b.t).map((e, i) => ({ ...e, seq: i + 1 }));
  };
  const page = loadPage({ width: 390, responses: { '/api/staff/stats': () => {
    calls++;
    return { ok: true, body: respond ? respond() : calls <= 2 ? apiView() : apiView({ events: withEve() }) };
  } } });
  await settle();
  const { doc, window: win } = page;
  const charts = page.$('charts'), main = page.$('main');
  // Mise en page de Safari, simplifiée : en-tête de 900 px (40 de plus avec
  // le bandeau d'erreur), cartes de 300 px plus 26 px par ligne de chanteur,
  // défilement ramené dans la page à chaque lecture de la mise en page.
  const HEAD = 900, VIEW = 664;
  const headerExtra = () => page.$('errorBox').hidden ? 0 : 40;
  const head = () => HEAD + headerExtra();
  const cardHeight = card => 300 + 26 * card.find(n => n.getAttribute('class') === 'st-row').length;
  const natural = () => head() + charts.children.reduce((sum, card) => sum + cardHeight(card), 0);
  const mainHeight = () => Math.max(parseFloat(main.style.minHeight) || 0, natural());
  win.innerHeight = VIEW;
  win.scrollY = 0;
  const clamp = () => { win.scrollY = Math.max(0, Math.min(win.scrollY, mainHeight() - VIEW)); };
  win.scrollBy = (x, y) => { win.scrollY += y; clamp(); };
  const rect = (top, height) => ({ left: 0, top: top - win.scrollY, bottom: top + height - win.scrollY, width: 390, height });
  doc.layout = node => {
    clamp();
    if (!node) return null;
    if (node === main) return rect(0, mainHeight());
    if (node === page.$('insights')) return rect(150 + headerExtra(), 300);
    if (node === page.$('kpis')) return rect(450 + headerExtra(), 450);
    if (node.parentNode === charts) {
      const index = charts.children.indexOf(node);
      return rect(head() + charts.children.slice(0, index).reduce((sum, card) => sum + cardHeight(card), 0), cardHeight(node));
    }
    return null;
  };
  const top = id => doc.getElementById(id).getBoundingClientRect().top;
  // Lecture plus bas : haut de l'écran dans la carte de la file (sous les attentes).
  win.scrollY = HEAD + cardHeight(page.$('chartTimeline')) + cardHeight(page.$('chartWaits')) + cardHeight(page.$('chartRates')) + 50;
  const reading = win.scrollY;
  // Barre d'adresse qui se replie : redimensionnement, rendu 200 ms plus tard.
  page.windowListeners.resize[0]();
  page.timers.at(-1).fn();
  assert.equal(win.scrollY, reading, 'redimensionnement : la vue ne remonte pas');
  assert.equal(main.style.minHeight, '', 'hauteur libérée après le rendu');
  // Rafraîchissement de 15 s, mêmes données.
  page.timers.filter(t => t.ms === 15000).at(-1).fn();
  await settle();
  assert.equal(win.scrollY, reading, 'rafraîchissement : la vue ne remonte pas');
  // Rafraîchissement avec une ligne de plus au-dessus : la carte lue reste à la même place.
  const queueTop = top('chartQueue');
  page.timers.filter(t => t.ms === 15000).at(-1).fn();
  await settle();
  assert.equal(calls, 3);
  assert.equal(page.$('chartWaits').find(n => n.getAttribute('class') === 'st-row').length, 5, 'Eve ajoutée aux attentes');
  assert.equal(top('chartQueue'), queueTop, 'la carte lue ne bouge pas');
  assert.equal(win.scrollY, reading + 26);
  // Ligne des attentes touchée du doigt (focus sans clavier) : pas de focus
  // remis ni d'info-bulle réaffichée à chaque rafraîchissement.
  const row = marks(page.$('chartWaits'))[0];
  doc.focusVisible = false;
  row.focus();
  assert.equal(page.$('tooltip').hidden, false);
  page.timers.filter(t => t.ms === 15000).at(-1).fn();
  await settle();
  assert.equal(page.$('charts').descendants().includes(doc.activeElement), false, 'focus du toucher non remis');
  assert.equal(page.$('tooltip').hidden, true, 'pas d’info-bulle réaffichée');
  assert.equal(win.scrollY, reading + 26);
  // Bandeau d'erreur du journal retiré au-dessus : la carte lue ne bouge pas.
  assert.equal(page.$('errorBox').hidden, false);
  respond = () => ({ ...apiView({ events: withEve() }), journalError: null });
  page.timers.filter(t => t.ms === 15000).at(-1).fn();
  await settle();
  assert.equal(page.$('errorBox').hidden, true);
  assert.equal(win.scrollY, reading + 26 - 40, 'en-tête raccourci au-dessus : la vue suit la carte lue');
  // Haut de page : rien à garder. Le bandeau qui revient pousse la page
  // normalement, la vue reste en haut.
  win.scrollY = 0;
  respond = () => apiView({ events: withEve() });
  page.timers.filter(t => t.ms === 15000).at(-1).fn();
  await settle();
  assert.equal(page.$('errorBox').hidden, false);
  assert.equal(win.scrollY, 0, 'en haut de page, la vue reste en haut');
  // Rendu qui échoue (données abîmées) : la hauteur gardée est libérée quand même.
  win.scrollY = reading;
  respond = () => { const body = apiView(); body.stats.timeline.queue = null; return body; };
  page.timers.filter(t => t.ms === 15000).at(-1).fn();
  await settle();
  assert.match(page.$('errorBox').textContent, /Statistiques indisponibles/);
  assert.equal(main.style.minHeight, '', 'hauteur libérée malgré l’erreur');
});

// ------------------------------------------------------------------ axe du temps
// Étiquettes d'heure (centrées sous l'axe) et marques des passages d'un graphique.
function timeAxis(page, id, { left, right = 12 }) {
  const svg = page.doc.getElementById(`${id}Plot`).byTag('svg')[0];
  const W = Number(svg.getAttribute('viewBox').split(' ')[2]);
  const labels = svg.children.filter(n => n.tagName === 'TEXT' && n.getAttribute('text-anchor') === 'middle' && /\d\d:\d\d$/.test(text(n)))
    .map(n => ({ label: text(n), x: Number(n.getAttribute('x')) }));
  const plotLeft = left(W);
  return { svg, W, labels, plotLeft, usable: W - right - plotLeft };
}
const timelineAxis = page => timeAxis(page, 'chartTimeline', { left: W => Math.min(150, W * 0.28) });
const queueAxis = page => timeAxis(page, 'chartQueue', { left: () => 34 });
function assertReadableAxis({ labels, usable }, what) {
  assert.ok(labels.length >= 2, `${what} : au moins deux heures (${labels.length})`);
  assert.ok(labels.length <= Math.floor(usable / 60) + 1, `${what} : ${labels.length} étiquettes pour ${Math.round(usable)} unités`);
  for (let i = 1; i < labels.length; i++) {
    assert.ok(labels[i].x - labels[i - 1].x >= 40, `${what} : « ${labels[i - 1].label} » et « ${labels[i].label} » à ${Math.round(labels[i].x - labels[i - 1].x)} unités`);
  }
  assert.equal(new Set(labels.map(l => l.label)).size, labels.length, `${what} : pas deux fois la même étiquette`);
}
function assertMarksSpread(axis, what) {
  const rects = axis.svg.children.filter(n => n.tagName === 'RECT' && n.getAttribute('class') === 'st-mark');
  const x0 = Math.min(...rects.map(r => Number(r.getAttribute('x'))));
  const x1 = Math.max(...rects.map(r => Number(r.getAttribute('x')) + Number(r.getAttribute('width'))));
  assert.ok(x1 - x0 >= 0.5 * axis.usable, `${what} : passages sur ${Math.round(x1 - x0)} unités sur ${Math.round(axis.usable)}`);
}
const timelineCaption = page => page.doc.getElementById('chartTimelinePlot').find(n => n.tagName === 'P' && /Dernier passage/.test(text(n)))[0];
const localHHMM = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const viewResponse = view => ({ '/api/staff/stats': () => ({ ok: true, body: view }) });
const lastStageEnd = view => Math.max(...view.stats.timeline.stages.map(x => x.end));

// Regression: ISSUE-037 — « Déroulé de la soirée » illisible : soirée restée ouverte 4 jours, barres de 2 px et heures superposées
test('déroulé : une soirée restée ouverte 4 jours garde des barres lisibles et des heures espacées, sur PC et à 360 px', async () => {
  const view = apiView({ now: at(72 + 4 * 24 * 60) });
  const lastEnd = lastStageEnd(view);
  for (const width of [900, 360]) {
    const page = loadPage({ width, responses: viewResponse(view) });
    await settle();
    const axis = timelineAxis(page);
    assertReadableAxis(axis, `déroulé ${width} px`);
    assertMarksSpread(axis, `déroulé ${width} px`);
    assert.equal(text(timelineCaption(page)), `Dernier passage à ${localHHMM(lastEnd)} · soirée encore ouverte`);
    // Le repère vertical suit le même axe : au bord droit, 15 min après le dernier passage.
    const tip = page.$('tooltip');
    axis.svg.dispatch('pointermove', { clientX: 10 + axis.W - 12, target: axis.svg });
    assert.match(text(tip), new RegExp(`^${localHHMM(lastEnd + 15 * 60000)}Rien`));
  }
});

// Regression: ISSUE-037 — la soirée close 6 jours plus tard gardait le même graphique illisible pour de bon
test('déroulé : une soirée close 6 jours plus tard est dessinée sur ses passages, avec l’heure de clôture', async () => {
  const endedAt = at(6 * 24 * 60);
  const view = apiView({ live: false, endedAt, now: endedAt + 3600000 });
  const page = loadPage({ responses: viewResponse(view) });
  await settle();
  const axis = timelineAxis(page);
  assertReadableAxis(axis, 'déroulé clos');
  assertMarksSpread(axis, 'déroulé clos');
  const day = new Date(endedAt).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  assert.equal(text(timelineCaption(page)), `Dernier passage à ${localHHMM(lastStageEnd(view))} · soirée close le ${day} à ${localHHMM(endedAt)}`);
  // Clôture moins de 3 h après le dernier passage : axe jusqu'à la clôture, sans note.
  const soon = loadPage({ responses: viewResponse(apiView({ live: false, endedAt: at(90 + 170) })) });
  await settle();
  assert.equal(timelineCaption(soon), undefined);
  assert.equal(soon.doc.getElementById('chartTimelinePlot').find(n => n.tagName === 'P').length, 0);
});

// Regression: ISSUE-037 — clôture plus de 3 h après, le même jour : l'heure seule
test('déroulé : soirée close le jour même plus de 3 h après le dernier passage, l’heure de clôture sans le jour', async () => {
  // Dernier passage vers midi heure locale, clôture vers 16 h : même jour quel que soit le fuseau.
  const noon = new Date(at(0)); noon.setHours(12, 0, 0, 0);
  const shift = noon.getTime() - at(70);
  const events = eveningEvents().map(ev => ({ ...ev, t: ev.t + shift }));
  const endedAt = noon.getTime() + 4 * 3600000;
  const stats = computeStats({ meta: { ...meta, startedAt: at(0) + shift, endedAt }, events, now: endedAt, live: false });
  const view = { ...apiView({ live: false }), stats };
  const page = loadPage({ responses: viewResponse(view) });
  await settle();
  assert.equal(text(timelineCaption(page)), `Dernier passage à ${localHHMM(lastStageEnd(view))} · soirée close à ${localHHMM(endedAt)}`);
});

// Regression: ISSUE-037 — la soirée normale en direct ne change pas : « maintenant » reste visible, un temps mort aussi
test('déroulé : soirée en direct, l’axe va jusqu’à maintenant tant que le dernier passage a moins de 3 h', async () => {
  const page = loadPage();
  await settle();
  const axis = timelineAxis(page);
  assertReadableAxis(axis, 'déroulé du soir');
  assertMarksSpread(axis, 'déroulé du soir');
  assert.equal(timelineCaption(page), undefined, 'pas de note pendant une soirée normale');
  // Sans le titre « Hors file » en cours : dernier passage à 44 min.
  const events = eveningEvents().filter(ev => !(ev.queueId === 6 || (ev.ev === 'stage.started' && ev.title === 'Hors file')));
  const idle = minutes => apiView({ events, now: at(44 + minutes) });
  const pause = loadPage({ responses: viewResponse(idle(170)) });
  await settle();
  assert.equal(timelineCaption(pause), undefined, 'pause de 2 h 50 : encore la soirée en cours');
  const right = timelineAxis(pause);
  right.svg.dispatch('pointermove', { clientX: 10 + right.W - 12, target: right.svg });
  assert.match(text(pause.$('tooltip')), new RegExp(`^${localHHMM(at(44 + 170))}`), 'le bord droit est maintenant');
  const stale = loadPage({ responses: viewResponse(idle(190)) });
  await settle();
  assert.equal(text(timelineCaption(stale)), `Dernier passage à ${localHHMM(at(44))} · soirée encore ouverte`);
});

// Regression: ISSUE-037 — la file d'attente sur deux jours (relevés toutes les 5 min) : heures superposées
test('file d’attente sur deux jours : graduations espacées, avec le jour', async () => {
  const events = eveningEvents();
  let seq = events.length;
  for (let m = 50; m <= 48 * 60; m += 30) events.push({ seq: ++seq, t: at(m), ev: 'queue.sample', ready: m % 7, songsListed: m % 7, present: 4 });
  for (const width of [900, 360]) {
    const page = loadPage({ width, responses: viewResponse(apiView({ events, now: at(48 * 60) })) });
    await settle();
    const axis = queueAxis(page);
    assertReadableAxis(axis, `file ${width} px`);
    for (const { label } of axis.labels) assert.match(label, /^[a-zéû]+\. \d\d:\d\d$/, `jour dans « ${label} »`);
  }
  // Une soirée courte garde les heures seules.
  const page = loadPage();
  await settle();
  const short = queueAxis(page);
  assertReadableAxis(short, 'file du soir');
  for (const { label } of short.labels) assert.match(label, /^\d\d:\d\d$/);
});

// Regression: ISSUE-037 — pas de graduations : alignées sur l'horloge locale, du quart d'heure au jour
test('graduations du temps : pas selon la largeur, alignés sur l’horloge locale', async () => {
  const page = loadPage();
  await settle();
  const { timeTicks } = page.context;
  const local = (d, h, m = 0) => { const x = new Date(at(0)); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); return x.getTime(); };
  const minutes = ticks => ticks.slice(1).map((t, i) => (t - ticks[i]) / 60000);
  // 1 h 30 sur 600 unités : 10 étiquettes au plus, pas de 10 min, aux dizaines.
  const short = timeTicks(local(0, 20, 3), local(0, 21, 33), 600);
  assert.deepEqual(new Set(minutes(short)), new Set([10]));
  assert.equal(new Date(short[0]).getMinutes(), 10);
  // 5 min sur une heure et beaucoup de place.
  assert.deepEqual(new Set(minutes(timeTicks(local(0, 20), local(0, 21), 1400))), new Set([5]));
  // 15 h sur 247 unités (téléphone) : pas de 6 h, aux heures multiples de 6.
  const day = timeTicks(local(0, 22, 42), local(1, 13, 40), 247);
  assert.ok(day.every(t => new Date(t).getMinutes() === 0 && new Date(t).getHours() % 6 === 0), day.map(t => new Date(t).getHours()).join(','));
  // 4 jours sur 738 unités : pas de 12 h ; sur 247 : un jour, à minuit.
  assert.ok(timeTicks(local(0, 22, 42), local(4, 21), 738).every(t => new Date(t).getHours() % 12 === 0));
  const days = timeTicks(local(0, 22, 42), local(4, 21), 247);
  assert.ok(days.length >= 2 && days.length <= 4 && days.every(t => new Date(t).getHours() === 0), days.map(t => new Date(t).toString()).join(' | '));
  // Au-delà d'un jour par étiquette : plusieurs jours, toujours à minuit.
  const weeks = timeTicks(local(0, 22, 42), local(30, 21), 247);
  assert.ok(weeks.length >= 2 && weeks.length <= 5, String(weeks.length));
  assert.ok(weeks.every(t => new Date(t).getHours() === 0));
});

// Lot K : un soliste n'est nommé que par son prénom ; la carte « Tables »
// garde le nom du groupe.
test('soliste : prénom seul dans le filtre, les info-bulles, le panneau et le tableau ; colonne Table vide', async () => {
  const page = loadPage({ responses: withView(view => {
    view.stats.tables.find(tb => tb.id === '3').individual = true;
    view.names.tables['3'] = 'En solo';
  }) });
  await settle();
  const focus = page.$('focusSelect');
  const option = value => text(focus.options().find(o => o.getAttribute('value') === value));
  assert.equal(option('p:pE'), 'Eve', 'filtre : prénom seul');
  assert.equal(option('p:pA'), 'Alice · Table 1', 'une personne de table garde sa table');
  const rows = page.doc.getElementById('cardSingers').byTag('tbody')[0].children;
  const eve = rows.find(row => text(row.children[0]) === 'Eve');
  assert.equal(text(eve.children[1]), '', 'colonne Table vide pour un soliste');
  assert.equal(text(rows.find(row => text(row.children[0]) === 'Alice').children[1]), 'Table 1');
  const tip = page.$('tooltip');
  let seen = 0;
  for (const id of ['chartWaits', 'chartRates']) {
    for (const mark of marks(page.doc.getElementById(id))) {
      mark.dispatch('pointerenter', { clientX: 100, clientY: 100 });
      if (/^Eve/.test(text(tip))) { seen++; assert.doesNotMatch(text(tip), /En solo/, `${id} : info-bulle sans groupe`); }
      mark.dispatch('pointerleave');
    }
  }
  assert.ok(seen > 0, 'au moins une info-bulle de la soliste vérifiée');
  focus.value = 'p:pE';
  focus.dispatch('change', { target: focus });
  assert.match(text(page.$('focusCard')), /Soirée d’Eve\s*Arrivée /);
  assert.doesNotMatch(text(page.$('focusCard')), /En solo/);
  // Écran de gestion : le groupe garde son nom dans le filtre des tables.
  assert.ok(focus.options().some(o => o.getAttribute('value') === 't:3'));
});

// Regression: constat QA Q8 (8 octobre) — « Attente avant de chanter » à
// 390 px : pas fixe de 15 s, « 1 min » et « 1 min 15 » collés (39 unités
// entre leurs centres). Le pas dépend de la largeur, comme l'axe du temps.
test('graduations des durées : pas selon la largeur, au moins 60 unités entre deux étiquettes', async () => {
  const page = loadPage();
  await settle();
  const { durationTicks } = page.context;
  const gaps = (ticks, width) => ticks.slice(1).map((v, i) => (v - ticks[i]) * width / ticks.at(-1));
  const steps = ticks => new Set(ticks.slice(1).map((v, i) => v - ticks[i]));
  // Cas du constat : 1 min 15 au plus sur 198 unités (390 px).
  assert.deepEqual(steps(durationTicks(75, 198)), new Set([30]), '30 s au lieu de 15 s');
  // Beaucoup de place : le pas fin reste.
  assert.deepEqual(steps(durationTicks(75, 1200)), new Set([15]));
  // Pas candidats : 15 s, 30 s, 1, 2, 5, 10, 15, 30 min, puis l'heure.
  for (const [maxSec, width] of [[75, 198], [75, 120], [600, 198], [3000, 198], [40 * 60, 700], [5 * 3600, 198], [30, 60], [0, 198]]) {
    const ticks = durationTicks(maxSec, width);
    assert.equal(ticks[0], 0);
    assert.ok(ticks.length >= 2, `${maxSec} s sur ${width} : au moins deux graduations`);
    assert.ok(ticks.at(-1) >= maxSec, `${maxSec} s sur ${width} : l’axe couvre la plus longue attente`);
    const [step] = steps(ticks);
    assert.ok([15, 30, 60, 120, 300, 600, 900, 1800].includes(step) || step % 3600 === 0, `${maxSec} s sur ${width} : pas rond ${step}`);
    if (width >= 120) for (const gap of gaps(ticks, width)) assert.ok(gap >= 60, `${maxSec} s sur ${width} : ${Math.round(gap)} unités entre deux étiquettes`);
  }
  // Sur la page, à 360, 390 et 900 px : étiquettes d'axe jamais serrées, sur
  // chaque graphique à axe horizontal gradué (attentes, temps morts, tables).
  // Les axes de durée ont des libellés exacts (« 30 s », « 1 min 30 »), pas
  // « 0,5 min ».
  const durationAxes = ['Attente avant de chanter, par chanteur', 'Temps morts par cause', 'Attente moyenne par table'];
  for (const width of [360, 390, 900]) {
    const shown = loadPage({ width });
    await settle();
    const svgs = ['chartWaitsPlot', 'chartRatesPlot', 'chartDeadPlot', 'chartTablesPlot'].flatMap(id => shown.doc.getElementById(id).byTag('svg'));
    assert.equal(svgs.length, 5, `${width} px : cinq axes horizontaux`);
    for (const svg of svgs) {
      const name = `${width} px, ${svg.getAttribute('aria-label')}`;
      const ticks = svg.children.filter(n => n.tagName === 'TEXT' && n.getAttribute('text-anchor') === 'middle');
      const labels = ticks.map(n => Number(n.getAttribute('x')));
      assert.ok(labels.length >= 2, `${name} : graduations`);
      for (let i = 1; i < labels.length; i++) assert.ok(labels[i] - labels[i - 1] >= 60, `${name} : ${Math.round(labels[i] - labels[i - 1])} unités`);
      if (durationAxes.some(label => svg.getAttribute('aria-label').startsWith(label))) {
        for (const tick of ticks) assert.match(tick.textContent, /^(0 s|0 min|\d+ s|\d+ min( \d\d)?)$/, `${name} : libellé de durée exact`);
      }
    }
  }
});
