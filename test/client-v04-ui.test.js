'use strict';
// Page des chanteurs, retours du premier essai réel au bar : bouton Retour
// d'Android, bouton × des recherches, Battle choisie dans le catalogue,
// paroles, « Pas prêt », demande de duo depuis la file et heure de fermeture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
assert.ok(script, 'script de la page client');

class Element {
  constructor(id = '') {
    const classes = new Set();
    Object.assign(this, { id, hidden: false, value: '', textContent: '', dataset: {}, listeners: {},
      classList: { toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
        contains: name => classes.has(name) } });
    this._html = '';
  }
  set innerHTML(value) { this._html = value; }
  get innerHTML() { return this._html; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  setAttribute() {}
  querySelector() { return new Element(); }
  querySelectorAll() { return []; }
  focus() { this.focused = true; }
  scrollIntoView() {}
}

const elements = new Map();
const get = id => elements.get(id) || (elements.set(id, new Element(id)), elements.get(id));
const tabs = ['table', 'queue', 'catalog'].map(name => Object.assign(get(`nav-${name}`), { dataset: { tab: name } }));
const catalogButtons = ['playlist', 'styles', 'top'].map(type => Object.assign(new Element(), { dataset: { catalog: type } }));
get('sheet').hidden = true;
const document = {
  title: '', activeElement: null, hidden: false, listeners: {}, documentElement: { lang: 'fr' },
  getElementById: get,
  querySelectorAll(selector) {
    if (selector === '.tabs button') return tabs;
    if (selector === '[data-catalog]') return catalogButtons;
    return [];
  },
  addEventListener(name, listener) { this.listeners[name] = listener; },
  contains() { return true; },
};

// Historique du navigateur simulé : Retour déclenche « popstate ».
const windowListeners = {};
const history = {
  entries: [], index: -1, backs: 0,
  get state() { return this.entries[this.index]?.state ?? null; },
  replaceState(state) { this.entries[this.index < 0 ? (this.index = 0) : this.index] = { state }; },
  pushState(state) { this.entries.splice(this.index + 1); this.entries.push({ state }); this.index++; },
  back() {
    this.backs++;
    if (this.index <= 0) { this.left = true; return; } // la page est quittée
    this.index--;
    queueMicrotask(() => windowListeners.popstate?.({ state: this.state }));
  },
  go(delta) {
    this.gos = (this.gos || 0) + 1;
    if (this.index + delta < 0) { this.left = true; return; }
    this.index += delta;
    queueMicrotask(() => windowListeners.popstate?.({ state: this.state }));
  },
};
const pressBack = async () => { history.back(); await settle(); };

let closing = null;
let queue = [];
let alice = { id: 'alice', name: 'Alice', active: true, songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre', artist: 'Moi' }],
  invites: [], inKaraFun: [], joinRequests: [], sentJoinRequests: [], canDefer: false, deferral: null };
const battleIdle = { phase: 'idle', eligiblePersonIds: [], votedPersonIds: [], minVoters: 2, registered: 4 };
const state = () => ({ table: { id: '1', name: 'Table 1', headcount: 2, activeCount: 1 },
  tablePeople: [alice], managedIds: ['alice'], people: [], queue, waiting: [], closing,
  battle: battleIdle, catalogAvailable: true, stage: null, next: null, rules: {} });
const response = data => ({ ok: true, json: async () => data });
const posts = [];
const fetched = [];
let lyrics = { lines: ['Premier vers', '', 'Refrain'], url: 'https://www.karafun.fr/karaoke/a/b/', exact: true };
const fetch = async (url, options = {}) => {
  fetched.push(url);
  if (url.startsWith('/api/state?')) return response(state());
  if (url.startsWith('/api/catalog/categories?')) return response([{ name: 'Années 80', filter: 'pl_1', img: 'https://cdn.test/80s.jpg' }]);
  if (url.startsWith('/api/catalog/songs?')) return response({ songs: [{ songId: 9, title: 'Tube', artist: 'Groupe', img: 'https://cdn.test/tube.jpg' },
    { songId: 10, title: 'Autre tube', artist: 'Groupe' }], total: 2 });
  if (url.startsWith('/api/search?')) return response([{ songId: 42, title: 'Bohemian Rhapsody', artist: 'Queen' }]);
  if (url.startsWith('/api/song/notice?')) return response({ notice: { queued: [{ pos: 2, name: 'Bruno', ownerId: 'bruno', entryId: 'b1', before: null }] } });
  if (url.startsWith('/api/lyrics?')) return response(lyrics);
  if (url.startsWith('/api/table/')) {
    posts.push([url, JSON.parse(options.body)]);
    if (url === '/api/table/defer') {
      alice = { ...alice, canDefer: false, deferral: { remaining: 1, total: 1 } };
      return response({ ok: true, deferral: { remaining: 1, total: 1 } });
    }
    if (url === '/api/table/duet/join') return response({ ok: true, direct: false });
    return response({ ok: true });
  }
  throw new Error(`Requête inattendue : ${url}`);
};
const saved = new Map();
const localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key) };
let poll;
let scrolls = 0;
const timers = new Map();
let timerId = 0;
const finishTyping = () => { for (const [id, timer] of timers) if (timer.ms === 300) { timers.delete(id); timer.fn(); } };
const context = { document, fetch, localStorage, location: { pathname: '/t/1/secret', search: '' },
  window: { isSecureContext: false, scrollTo() { scrolls++; }, history, addEventListener: (name, fn) => { windowListeners[name] = fn; }, open() {} },
  navigator: { languages: ['fr-FR'] }, URLSearchParams, queueMicrotask,
  setInterval: fn => { poll = fn; }, setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
  clearTimeout: id => timers.delete(id), console, Date, Number, String, Set, Array, JSON, Math };
vm.runInNewContext(script, context, { filename: 'client.html' });
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const click = (node, picks) => node.listeners.click({ target: { closest: selector => picks[selector] || null } });

(async () => {
  await settle();
  assert.equal(history.entries.length, 2, 'une étape de départ protège la sortie de la page');
  assert.equal(history.entries[0].state.root, true);

  // ---------------------------------------------------------- bouton Retour
  tabs[2].listeners.click({ target: tabs[2] });
  await settle();
  assert.equal(get('tab-catalog').hidden, false);
  assert.equal(scrolls, 1, 'onglet touché : il s’ouvre en haut de sa page');
  click(get('catalogContent'), { button: { dataset: { categoryIndex: '0' }, hasAttribute: key => key === 'data-category-index' } });
  await settle();
  assert.match(get('catalogContent').innerHTML, /Tube/);
  click(get('catalogContent'), { button: { dataset: { songIndex: '0' }, hasAttribute: key => key === 'data-song-index' } });
  await settle();
  assert.equal(get('sheet').hidden, false, 'fenêtre du titre ouverte');
  const depth = history.index;
  await pressBack();
  assert.equal(get('sheet').hidden, true, 'Retour ferme la fenêtre');
  assert.match(get('catalogContent').innerHTML, /Tube/, 'la liste de la sélection reste affichée');
  await pressBack();
  assert.match(get('catalogContent').innerHTML, /Années 80/, 'Retour revient aux sélections');
  const scrollsBeforeBack = scrolls;
  await pressBack();
  assert.equal(get('tab-table').hidden, false, 'Retour revient à l’onglet précédent');
  // Regression: seconde relecture de la refonte — Retour remettait l'onglet
  // en haut au lieu de laisser le navigateur rendre la position quittée.
  assert.equal(scrolls, scrollsBeforeBack, 'avec Retour, la position de l’étape est rendue par le navigateur');
  await pressBack();
  assert.equal(get('tab-table').hidden, false, 'sur l’écran de départ, la page reste ouverte');
  assert.match(get('toast').textContent, /Appuie encore sur Retour/);
  const backsBefore = history.backs;
  history.back();
  await settle();
  assert.equal(history.backs, backsBefore + 2, 'second appui rapide : la page se laisse quitter');
  assert.equal(history.left, true);
  assert.ok(depth >= 3);

  // Fermer une fenêtre depuis la page retire aussi son étape d'historique.
  history.entries = [{ state: { kf: 1, root: true, tab: 'table', catalog: 'categories', sheet: false } },
    { state: { kf: 1, tab: 'table', catalog: 'categories', sheet: false } }];
  history.index = 1;
  click(get('peopleList'), { '[data-lyrics-title]': { dataset: { lyricsTitle: 'Mon titre', lyricsArtist: 'Moi', lyricsId: '1' } } });
  await settle();
  assert.equal(history.state.sheet, true);
  assert.match(get('lyricsBody').innerHTML, /Premier vers.*class="gap".*Refrain/s, 'paroles ligne à ligne');
  assert.match(get('lyricsBody').innerHTML, /Voir sur KaraFun/);
  click(get('sheet'), { '[data-close-sheet]': {} });
  get('sheet').listeners.click({ target: { closest: selector => selector === '[data-close-sheet]' ? {} : null } });
  await settle();
  assert.equal(history.state.sheet, false, 'l’étape de la fenêtre fermée est retirée');
  lyrics = { lines: null, url: 'https://www.karafun.fr/search/?query=x', exact: false };
  click(get('peopleList'), { '[data-lyrics-title]': { dataset: { lyricsTitle: 'Inconnu', lyricsArtist: '', lyricsId: '' } } });
  await settle();
  assert.match(get('lyricsBody').innerHTML, /Paroles introuvables.*Chercher sur KaraFun/s);
  get('sheet').listeners.click({ target: { closest: selector => selector === '[data-close-sheet]' ? {} : null } });
  await settle();

  // ---------------------------------------------------------- bouton × de la recherche
  tabs[2].listeners.click({ target: tabs[2] });
  await settle();
  get('searchInput').value = 'Queen';
  get('searchInput').listeners.input();
  assert.equal(get('searchClear').hidden, false, 'le × apparaît avec du texte');
  finishTyping();
  await settle();
  assert.match(get('catalogContent').innerHTML, /Bohemian Rhapsody/);
  get('searchClear').listeners.click();
  await settle();
  assert.equal(get('searchInput').value, '');
  assert.equal(get('searchClear').hidden, true);
  assert.equal(get('searchInput').focused, true, 'le curseur reste dans la recherche');
  assert.match(get('catalogContent').innerHTML, /Années 80/, 'retour aux sélections');

  // ---------------------------------------------------------- × et puces après un ajout (essai réel au bar)
  // Recherche, titre ajouté (retour à « Mes titres »), retour au Catalogue alors
  // que les résultats sont encore affichés : le × et les puces restent au catalogue.
  const moves = () => history.backs + (history.gos || 0);
  const addFromSearch = async term => {
    get('searchInput').value = term;
    get('searchInput').listeners.input();
    finishTyping();
    await settle();
    assert.match(get('catalogContent').innerHTML, new RegExp(`Résultats pour « ${term} »`));
    click(get('catalogContent'), { button: { dataset: { songIndex: '0' }, hasAttribute: key => key === 'data-song-index' } });
    await settle();
    assert.equal(get('sheet').hidden, false);
    get('appendSong').listeners.click();
    await settle(); await settle();
    assert.equal(get('tab-table').hidden, false, 'après l’ajout, retour à « Mes titres »');
    tabs[2].listeners.click({ target: tabs[2] });
    await settle();
    assert.equal(get('tab-catalog').hidden, false);
    assert.match(get('catalogContent').innerHTML, /Résultats pour/, 'les résultats sont encore là');
  };
  await addFromSearch('que');
  let movesBefore = moves();
  get('searchClear').listeners.click();
  await settle();
  assert.equal(get('tab-catalog').hidden, false, '× : on reste sur le catalogue');
  assert.equal(get('tab-table').hidden, true, '× : pas de retour à « Mes titres »');
  assert.equal(get('searchInput').value, '');
  assert.equal(get('searchClear').hidden, true);
  assert.match(get('catalogContent').innerHTML, /Années 80/, '× : sélections affichées');
  assert.doesNotMatch(get('catalogContent').innerHTML, /Résultats pour/, '× : anciens résultats effacés');
  assert.equal(moves(), movesBefore, 'l’historique ne recule pas vers « Mes titres »');
  assert.equal(history.state.tab, 'catalog');
  assert.equal(history.state.catalog, 'categories', 'l’étape actuelle est celle des sélections');
  await pressBack();
  assert.equal(get('tab-table').hidden, false, 'Retour ensuite : onglet précédent');
  await pressBack();
  assert.equal(get('tab-catalog').hidden, false);
  assert.equal(get('searchInput').value, 'que', 'Retour vers des résultats : la recherche est refaite');
  assert.match(get('catalogContent').innerHTML, /Résultats pour « que »/);
  await pressBack();
  assert.match(get('catalogContent').innerHTML, /Années 80/);
  assert.equal(get('searchInput').value, '');

  // Même parcours, puis puce « Styles ».
  await addFromSearch('que');
  movesBefore = moves();
  catalogButtons[1].listeners.click();
  await settle();
  assert.equal(get('tab-catalog').hidden, false, 'puce : on reste sur le catalogue');
  assert.equal(get('tab-table').hidden, true);
  assert.equal(catalogButtons[1].classList.contains('on'), true, 'puce Styles active');
  assert.match(fetched.at(-1), /^\/api\/catalog\/categories\?type=styles/, 'sélections Styles chargées');
  assert.match(get('catalogContent').innerHTML, /Années 80/);
  assert.equal(get('searchInput').value, '');
  assert.equal(moves(), movesBefore);
  assert.equal(history.state.catalog, 'categories');
  catalogButtons[0].listeners.click();
  await settle();
  assert.equal(catalogButtons[0].classList.contains('on'), true);

  // Parcours normal : sélections → recherche → × recule d'une seule étape.
  const selectionsStep = history.index;
  get('searchInput').value = 'Queen';
  get('searchInput').listeners.input();
  finishTyping();
  await settle();
  assert.equal(history.index, selectionsStep + 1, 'la recherche crée une étape');
  movesBefore = moves();
  get('searchClear').listeners.click();
  await settle();
  assert.equal(moves(), movesBefore + 1, 'une seule étape en arrière');
  assert.equal(history.index, selectionsStep, 'pas d’étape périmée laissée en place');
  assert.match(get('catalogContent').innerHTML, /Années 80/);
  assert.equal(get('tab-catalog').hidden, false);

  // Titres d'une sélection → recherche → Retour : les titres de la sélection reviennent.
  click(get('catalogContent'), { button: { dataset: { categoryIndex: '0' }, hasAttribute: key => key === 'data-category-index' } });
  await settle();
  assert.match(get('catalogContent').innerHTML, /Tube/);
  get('searchInput').value = 'Queen';
  get('searchInput').listeners.input();
  finishTyping();
  await settle();
  const searchStep = history.index;
  get('searchInput').value = 'Queens';
  get('searchInput').listeners.input();
  finishTyping();
  await settle();
  assert.equal(history.index, searchStep, 'nouveau terme : même étape');
  assert.equal(history.state.term, 'Queens', 'l’étape garde le terme cherché');
  await pressBack();
  assert.match(get('catalogContent').innerHTML, /Tube/, 'Retour : titres de la sélection');
  assert.doesNotMatch(get('catalogContent').innerHTML, /Bohemian/);
  assert.equal(get('searchInput').value, '');
  await pressBack();
  assert.match(get('catalogContent').innerHTML, /Années 80/, 'puis les sélections');
  assert.equal(get('tab-catalog').hidden, false);

  // ---------------------------------------------------------- Battle depuis le catalogue
  click(get('battleVotes'), { '[data-battle-propose]': { dataset: { battlePropose: 'alice' } } });
  await settle();
  assert.match(get('sheetPanel').innerHTML, /Parcourir le catalogue/);
  get('battleSearch').value = 'Qu';
  get('battleSearch').listeners.input();
  assert.equal(get('battleSearchClear').hidden, false);
  get('battleSearchClear').listeners.click();
  assert.equal(get('battleSearch').value, '', '× vide aussi la recherche Battle');
  get('battleBrowse').listeners.click();
  await settle();
  assert.equal(get('tab-catalog').hidden, false);
  assert.equal(get('battlePickBar').hidden, false, 'mode choix Battle visible');
  assert.match(get('catalogContent').innerHTML, /category-tile[^>]*>\s*<img src="https:\/\/cdn\.test\/80s\.jpg"/, 'vignette de la sélection');
  click(get('catalogContent'), { button: { dataset: { categoryIndex: '0' }, hasAttribute: key => key === 'data-category-index' } });
  await settle();
  assert.match(get('catalogContent').innerHTML, /class="cover "[^>]*>T<img src="https:\/\/cdn\.test\/tube\.jpg"/, 'vignette du titre, initiale en attendant l’image');
  assert.match(get('catalogContent').innerHTML, /class="cover "[^>]*>A<\/span>/, 'sans image : pastille avec l’initiale');
  click(get('catalogContent'), { button: { dataset: { songIndex: '0' }, hasAttribute: key => key === 'data-song-index' } });
  // Regression: ISSUE-002 (recette navigateur v0.4) — rien ne montrait les titres déjà choisis pour la Battle.
  assert.match(get('catalogContent').innerHTML, /song-row picked" data-song-index="0" aria-pressed="true"[\s\S]*✓ Choisi/, 'titre choisi marqué');
  click(get('catalogContent'), { button: { dataset: { songIndex: '1' }, hasAttribute: key => key === 'data-song-index' } });
  assert.equal(get('sheet').hidden, true, 'en mode Battle, un titre s’ajoute sans fenêtre');
  assert.match(get('battlePickText').textContent, /2\/3/);
  get('battlePickDone').listeners.click();
  await settle();
  // Regression: relecture de la refonte — les marques restaient après la sortie du choix Battle.
  assert.doesNotMatch(get('catalogContent').innerHTML, /picked|✓ Choisi|aria-pressed/, 'hors du choix Battle : plus de marque');
  assert.match(get('battleSelected').innerHTML, /Tube.*Autre tube/s, 'les titres choisis sont dans la proposition');
  assert.equal(get('startBattleVote').disabled, false);
  get('startBattleVote').listeners.click();
  await settle();
  const proposal = posts.find(([url]) => url === '/api/table/battle/propose')[1];
  assert.deepEqual(proposal.songs.map(song => song.songId), [9, 10]);

  // ---------------------------------------------------------- titre déjà prévu : proposer un duo
  click(get('catalogContent'), { button: { dataset: { songIndex: '0' }, hasAttribute: key => key === 'data-song-index' } });
  await settle();
  assert.match(get('songJoinOffer').innerHTML, /Proposer un duo à Bruno/);
  assert.match(get('sheetPanel').innerHTML, /Voir les paroles/);
  document.listeners.click({ target: { closest: selector => selector === '[data-join-request]'
    ? { dataset: { joinRequest: 'bruno', joinEntry: 'b1', joinName: 'Bruno', joinTitle: 'Tube' } } : null } });
  assert.match(get('sheetPanel').innerHTML, /Chanter « Tube » avec Bruno/);
  get('sendJoin').listeners.click();
  await settle();
  assert.deepEqual(posts.at(-1), ['/api/table/duet/join', { table: '1', access: 'secret', personId: 'alice', ownerId: 'bruno', entryId: 'b1' }]);
  assert.match(get('toast').textContent, /Demande de duo envoyée à Bruno/);

  // ---------------------------------------------------------- file : bouton Duo ? et fermeture
  queue = [{ pos: 1, source: 'helper', id: 'bruno', ids: ['bruno'], name: 'Bruno', title: 'Tube', song: { entryId: 'b1', title: 'Tube' }, eta: Date.now() + 60000, afterClosing: false },
    { pos: 2, source: 'helper', id: 'chloe', ids: ['chloe'], name: 'Chloé', title: 'Slow', song: { entryId: 'c1', title: 'Slow' }, eta: Date.now() + 300000, afterClosing: true },
    { pos: 3, source: 'helper', id: 'alice', ids: ['alice'], name: 'Alice', title: 'Mon titre', song: { entryId: 'e1' }, eta: Date.now() + 600000, afterClosing: true }];
  closing = { at: Date.now() + 120000, passed: false, full: true, fitCount: 1, afterCount: 2 };
  alice = { ...alice, sentJoinRequests: [{ ownerId: 'bruno', ownerName: 'Bruno', entryId: 'b1', song: { title: 'Tube' } }] };
  poll(); await settle();
  const rows = get('queueList').innerHTML;
  assert.match(rows, /Duo demandé/, 'demande déjà envoyée');
  assert.match(rows, /data-join-request="chloe"/, 'proposer un duo sur un autre titre');
  assert.doesNotMatch(rows, /data-join-request="alice"/, 'jamais sur son propre titre');
  assert.match(rows, /after-closing.*Après la fermeture/s);
  assert.equal(get('closingBox').hidden, false);
  assert.match(get('closingBox').innerHTML, /Fermeture du bar à \d\d:\d\d.*complète/s);
  assert.equal(get('closingBox').classList.contains('warn'), true, 'file complète : alerte, une seule fois sur la page');
  assert.doesNotMatch(html, /id="catalogClosing"/, 'pas de seconde alerte dans le catalogue');
  assert.match(get('peopleList').innerHTML, /Demande de duo envoyée à Bruno pour « Tube »/);

  // ---------------------------------------------------------- « Pas prêt »
  alice = { ...alice, canDefer: true, joinRequests: [{ entryId: 'e1', fromId: 'zoe', fromName: 'Zoé', song: { title: 'Mon titre' } }] };
  poll(); await settle();
  assert.match(get('peopleList').innerHTML, /C’est bientôt au tour d’Alice|C’est bientôt au tour de Alice/);
  assert.match(get('peopleList').innerHTML, /Zoé aimerait chanter « Mon titre » avec Alice/);
  assert.equal(get('attention').hidden, false, 'la demande de duo s’affiche en grand');
  assert.equal(get('attentionTitle').textContent, 'Zoé aimerait chanter « Mon titre » avec Alice.');
  assert.match(get('attentionText').textContent, /Réponds avant l’envoi du titre à KaraFun, sinon la demande expire\./);
  click(get('peopleList'), { '[data-join-answer]': { dataset: { joinAnswer: 'yes', personId: 'alice', joinEntry: 'e1', joinFrom: 'zoe' } } });
  await settle();
  assert.deepEqual(posts.at(-1)[1], { table: '1', access: 'secret', personId: 'alice', entryId: 'e1', fromId: 'zoe', accept: true });
  click(get('peopleList'), { '[data-defer-person]': { dataset: { deferPerson: 'alice' } } });
  await settle();
  assert.deepEqual(posts.at(-1), ['/api/table/defer', { table: '1', access: 'secret', personId: 'alice', songs: 1 }]);
  assert.match(get('toast').textContent, /une chanson passe avant toi|1 chanson passe avant toi/);
  assert.match(get('peopleList').innerHTML, /Passage repoussé : encore 1 chanson avant Alice/);
  assert.match(get('peopleList').innerHTML, /data-ready-person="alice"/);
  click(get('peopleList'), { '[data-ready-person]': { dataset: { readyPerson: 'alice' } } });
  await settle();
  assert.equal(posts.at(-1)[0], '/api/table/defer/cancel');
  console.log('Client v0.4 : bouton Retour, ×, Battle depuis le catalogue, paroles, duo depuis la file, Pas prêt et fermeture OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
