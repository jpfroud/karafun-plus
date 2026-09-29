'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
assert.ok(script, 'script de la page client');

class Element {
  constructor(id = '') {
    this.id = id;
    this.hidden = false;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.dataset = {};
    this.listeners = {};
    this.classList = { toggle() {} };
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  set innerHTML(value) { this._innerHTML = value; this.htmlWrites = (this.htmlWrites || 0) + 1; }
  get innerHTML() { return this._innerHTML; }
  setAttribute() {}
  querySelector() { return new Element(); }
  querySelectorAll() { return []; }
  focus() {}
  scrollIntoView() {}
}

const elements = new Map();
const get = id => elements.get(id) || (elements.set(id, new Element(id)), elements.get(id));
const tabs = ['table', 'queue', 'catalog'].map(name => Object.assign(get(`nav-${name}`), { dataset: { tab: name } }));
const document = {
  title: '', activeElement: null, listeners: {},
  getElementById: get,
  querySelectorAll(selector) { return selector === '.tabs button' ? tabs : []; },
  addEventListener(name, listener) { this.listeners[name] = listener; },
  contains() { return true; },
};

const alice = { id: 'alice', name: 'Alice', active: true, songs: [], invites: [], inKaraFun: [] };
const bob = { id: 'bob', name: 'Bob', active: true, songs: [], invites: [], inKaraFun: [] };
let managedIds = [];
let invites = [];
let battle = { phase: 'idle', eligiblePersonIds: [], votedPersonIds: [] };
let lastClaimCode = null;
let proposedBy = null;
let proposedSongs = null;
let proposerChoice = null;
let duetPartners = [
  { id: 'marine', name: 'Marine', table: 'Table 2', tableId: '2' },
  { id: 'bob', name: 'Bob', table: 'Table 1', tableId: '1' },
];
const state = () => ({ table: { id: '1', name: 'Table 1', headcount: 2, activeCount: 2 },
  tablePeople: [{ ...alice, invites }, bob], managedIds, people: [], queue: [], waiting: [],
  battle, catalogAvailable: true, stage: null, next: null, rules: {} });
const response = data => ({ ok: true, json: async () => data });
const fetch = async (url, options = {}) => {
  if (url.startsWith('/api/state?')) return response(state());
  if (url.startsWith('/api/catalog/categories?')) return response([{ name: 'Top', filter: 'top' }]);
  if (url.startsWith('/api/catalog/songs?')) return response({ songs: [{ songId: 9, title: 'La chanson', artist: 'Artiste' }], total: 1 });
  if (url.startsWith('/api/search?')) return response([{ songId: 42, title: 'Bohemian Rhapsody', artist: 'Queen' }]);
  if (url.startsWith('/api/duo/partners?')) return response(duetPartners);
  if (url === '/api/table/battle/propose') {
    const body = JSON.parse(options.body);
    proposedBy = body.personId;
    proposedSongs = body.songs;
    proposerChoice = body.proposerChoice;
    battle = { id: 'vote-new', phase: 'voting', eligiblePersonIds: ['alice', 'bob'], votedPersonIds: [], yesVotes: 0, noVotes: 0, threshold: 2, eligible: 2 };
    return response({ ok: true });
  }
  if (url === '/api/table/person/claim') {
    lastClaimCode = JSON.parse(options.body).code;
    managedIds = ['alice'];
    return response({ id: 'alice', token: 'owned-token' });
  }
  throw new Error(`Requête inattendue : ${url}`);
};
const saved = new Map();
const localStorage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
let poll;
const context = { document, fetch, localStorage, location: { pathname: '/t/1/secret' },
  window: { isSecureContext: false, scrollTo() {} }, navigator: {}, URLSearchParams,
  setInterval: fn => { poll = fn; }, setTimeout: () => 1, clearTimeout() {},
  console, Date, Number, String, Set, Array, JSON, Math };
vm.runInNewContext(script, context, { filename: 'client.html' });
const settle = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  await settle();
  assert.equal(get('noSingerBox').hidden, true, 'les accès sont présentés dans les cartes de la table sans doublon');
  assert.equal(get('addPersonBox').hidden, true, 'le bloc d’ajout disparaît quand la table est complète');
  assert.equal(get('catalogAccessBox').hidden, false, 'le catalogue explique comment obtenir le droit d’ajouter');
  assert.match(get('catalogAccessActions').innerHTML, /Reprendre un chanteur inscrit/);
  assert.equal(get('quickSongBox').hidden, true);

  tabs[2].listeners.click({ target: tabs[2] });
  await settle();
  get('catalogContent').listeners.click({ target: { closest: () => ({ dataset: { categoryIndex: '0' }, hasAttribute: key => key === 'data-category-index' }) } });
  await settle();
  get('catalogContent').listeners.click({ target: { closest: () => ({ dataset: { songIndex: '0' }, hasAttribute: key => key === 'data-song-index' }) } });
  assert.match(get('sheetPanel').innerHTML, /Avant d’ajouter « La chanson »/);
  assert.match(get('sheetPanel').innerHTML, /Reprendre un chanteur inscrit/);

  document.listeners.click({ target: { closest: selector => selector === '[data-access-go]' ? { dataset: { accessGo: 'claim' } } : null } });
  assert.equal(get('tab-table').hidden, false);
  get('claimPeople').listeners.click({ target: { closest: () => ({ dataset: { claimPerson: 'alice' } }) } });
  assert.match(get('sheetPanel').innerHTML, /Code de reprise à 4 chiffres/);
  get('claimCode').value = '1234';
  get('claimForm').listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(lastClaimCode, '1234');
  assert.equal(get('quickSongBox').hidden, true, 'la table ordinaire utilise les boutons de chaque chanteur');
  assert.equal(get('catalogAccessBox').hidden, true);
  assert.match(get('peopleList').innerHTML, /data-add-song="alice"/);
  assert.doesNotMatch(get('peopleList').innerHTML, /data-add-song="bob"/, 'un téléphone ne modifie pas les autres chanteurs');
  assert.match(get('sheetPanel').innerHTML, /Ajouter à sa liste/, 'le titre choisi est conservé');
  get('songPerson').value = 'alice';
  get('duetSongChoice').listeners.click();
  await settle();
  assert.match(get('sheetPanel').innerHTML, /Avec qui \?/);
  assert.ok(get('sheetPanel').innerHTML.indexOf('À ma table') < get('sheetPanel').innerHTML.indexOf('Autres tables · invitation à accepter'),
    'les partenaires de la table précèdent les autres même si l’API les renvoie après');
  assert.ok(get('sheetPanel').innerHTML.indexOf('Bob · Table 1') < get('sheetPanel').innerHTML.indexOf('Marine · Table 2'));
  assert.match(get('sheetPanel').innerHTML, /↗ Marine · Table 2/, 'chaque personne d’une autre table est signalée dans la liste');
  get('duoPartner').value = 'bob';
  get('duoPartner').listeners.change();
  assert.equal(get('sendDuo').textContent, 'Ajouter le duo', 'même table : le duo est ajouté directement');
  duetPartners = [{ id: 'marine', name: 'Marine', table: 'Table 2', tableId: '2' }];
  get('duetSongChoice').listeners.click();
  await settle();
  assert.doesNotMatch(get('sheetPanel').innerHTML, /À ma table/);
  assert.match(get('sheetPanel').innerHTML, /Autres tables · invitation à accepter/);
  get('duoPartner').value = 'marine';
  get('duoPartner').listeners.change();
  assert.equal(get('sendDuo').textContent, 'Envoyer l’invitation', 'autre table : invitation à accepter');

  invites = [{ entryId: 'duo-1', fromName: 'Marine', song: { songId: 5, title: 'Duo' } }];
  poll(); await settle();
  assert.equal(get('activityBanner').hidden, false);
  assert.match(get('activityBannerText').textContent, /Marine propose un duo à Alice/);
  assert.match(document.title, /^\(1\)/);

  invites = [];
  battle = { id: 'vote-songs', phase: 'voting', mode: 'songs', yesVotes: 0, noVotes: 0,
    threshold: 1, eligiblePersonIds: ['alice'], votedPersonIds: [],
    songOptions: [{ songId: 42, title: 'Bohemian Rhapsody', artist: 'Queen', votes: 0 }] };
  poll(); await settle();
  const voteFormWrites = get('battleVotes').htmlWrites;
  battle = { ...battle, songOptions: [{ ...battle.songOptions[0], votes: 1 }] };
  poll(); await settle();
  assert.equal(get('battleVotes').htmlWrites, voteFormWrites,
    'un rafraîchissement des votes ne recrée pas le choix en cours');
  battle = { id: 'vote-1', phase: 'voting', eligiblePersonIds: ['alice'], votedPersonIds: [] };
  poll(); await settle();
  assert.match(get('activityBannerText').textContent, /vote Battle est ouvert/);
  battle = { ...battle, votedPersonIds: ['alice'] };
  poll(); await settle();
  assert.equal(get('activityBanner').hidden, true, 'la bannière se retire après le vote');
  battle = { ...battle, phase: 'requested' };
  poll(); await settle();
  assert.equal(get('activityBanner').hidden, true,
    'après le vote, la Battle reste dans son panneau sans laisser Voir la Battle en haut');
  assert.match(get('battleText').textContent, /La Battle aura lieu/);
  managedIds = ['alice', 'bob'];
  battle = { phase: 'idle', eligiblePersonIds: [], votedPersonIds: [] };
  poll(); await settle();
  assert.equal((get('battleVotes').innerHTML.match(/data-battle-propose/g) || []).length, 1,
    'un seul bouton Battle pour plusieurs chanteurs sur un téléphone');
  get('battleVotes').listeners.click({ target: { closest: selector => selector === '[data-battle-propose]'
    ? { dataset: { battlePropose: '' } } : null } });
  assert.match(get('sheetPanel').innerHTML, /Qui propose la Battle \?/);
  get('battleProposer').value = 'bob';
  get('battleSearch').value = 'Queen';
  get('battleSearchForm').listeners.submit({ preventDefault() {} });
  await settle();
  assert.match(get('battleSearchResults').innerHTML, /Bohemian Rhapsody/);
  get('battleSearchResults').listeners.click({ target: { closest: selector => selector === '[data-battle-result]'
    ? { dataset: { battleResult: '0' } } : null } });
  assert.match(get('battleSelected').innerHTML, /Bohemian Rhapsody/);
  assert.equal(get('battleMyChoice').value, '42');
  get('startBattleVote').listeners.click();
  await settle(); await settle();
  assert.equal(proposedBy, 'bob', 'le demandeur est choisi après le clic');
  assert.equal(proposedSongs[0].songId, 42, 'le titre est transmis au vote');
  assert.equal(proposerChoice, 42, 'le vote du proposant est explicite');
  assert.equal(get('sheet').hidden, true);
  console.log('Client : chanson, duo, Battle unique et alertes OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
