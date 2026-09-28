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
  setAttribute() {}
  querySelector() { return new Element(); }
  querySelectorAll() { return []; }
  focus() {}
  scrollIntoView() {}
}

const elements = new Map();
const get = id => elements.get(id) || (elements.set(id, new Element(id)), elements.get(id));
get('sheet').hidden = true;
const tabs = ['table', 'queue', 'catalog'].map(name => Object.assign(get(`nav-${name}`), { dataset: { tab: name } }));
const document = {
  title: '', activeElement: null, hidden: true, listeners: {},
  getElementById: get,
  querySelectorAll(selector) { return selector === '.tabs button' ? tabs : []; },
  addEventListener(name, listener) { this.listeners[name] = listener; },
  contains() { return true; },
};

const alice = { id: 'alice', name: 'Alice', active: true, songs: [], invites: [], inKaraFun: [] };
const bob = { id: 'bob', name: 'Bob', active: true, songs: [], invites: [], inKaraFun: [] };
let singer = null;
let managedId = null;
let recoveryPeople = [];
let privacyFiltered = false;
let headcount = 4;
let posts = 0;
let claimPosts = 0;
let lastClaimCode = null;
let count = 2;
let invitationReady = true;
const state = () => ({
  table: { id: 'Comptoir', name: 'Comptoir', individual: true, headcount, count, activeCount: count },
  soloInvitationReady: invitationReady,
  tablePeople: privacyFiltered ? managedId === 'alice' ? [alice] : managedId === 'zoe' ? [singer] : []
    : [alice, bob, ...(singer ? [singer] : [])],
  managedIds: managedId ? [managedId] : [], recoveryPeople,
  people: [], queue: [
    { pos: 1, ids: ['alice'], singer: 'Alice', title: 'Premier titre' },
    ...(singer ? [{ pos: 2, ids: [singer.id], singer: singer.name, title: 'Second titre' }] : []),
  ], waiting: [], battle: { phase: 'idle', eligiblePersonIds: [], votedPersonIds: [] },
  catalogAvailable: true, stage: null, next: null, rules: {},
});
const response = data => ({ ok: true, json: async () => data });
const fetch = async (url, options = {}) => {
  if (url.startsWith('/api/state?')) return response(state());
  if (url === '/api/join') {
    posts++;
    const body = JSON.parse(options.body);
    singer = { id: 'zoe', name: body.name, active: true, songs: [], invites: [], inKaraFun: [] };
    managedId = singer.id;
    count++;
    return response({ id: singer.id, token: 'zoe-token' });
  }
  if (url === '/api/table/person/claim') {
    claimPosts++;
    const body = JSON.parse(options.body);
    lastClaimCode = body.code;
    managedId = body.personId;
    recoveryPeople = [];
    return response({ id: managedId, token: 'recovered-token' });
  }
  throw new Error(`Requête inattendue : ${url}`);
};
const saved = new Map();
const localStorage = { getItem: key => saved.get(key) || null,
  setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
const notices = [];
let permissionRequests = 0;
class FakeNotification {
  static permission = 'default';
  static async requestPermission() { permissionRequests++; this.permission = 'granted'; return 'granted'; }
  constructor(title, options) { notices.push({ title, ...options }); }
  close() {}
}
let poll;
const context = { document, fetch, localStorage, location: { pathname: '/t/Comptoir/secret', search: '?invitation=personal-one-use-token' },
  window: { isSecureContext: true, Notification: FakeNotification, scrollTo() {} }, Notification: FakeNotification,
  navigator: {}, URLSearchParams,
  setInterval: fn => { poll = fn; }, setTimeout: () => 1, clearTimeout() {},
  console, Date, Number, String, Set, Array, JSON, Math };
vm.runInNewContext(script, context, { filename: 'client.html' });
const settle = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  await settle();
  assert.equal(get('joinBox').hidden, false, 'un nouveau client peut s’inscrire malgré les deux autres');
  assert.equal(get('tableBox').hidden, true, 'le groupe ne montre pas les fiches des autres');
  assert.equal(get('claimBox').hidden, true, 'aucune reprise d’un autre client');
  assert.equal(get('addPersonBox').hidden, true, 'aucun bouton pour créer plusieurs profils');
  assert.equal(get('waitingCard').hidden, true, 'la file ne montre pas un faux groupe à la cliente solo');
  assert.match(get('joinIntro').textContent, /invitation du bar est personnelle/);
  assert.match(get('catalogAccessActions').innerHTML, /M’inscrire/);
  assert.doesNotMatch(get('catalogAccessActions').innerHTML, /Reprendre/);
  assert.equal(get('peopleCard').hidden, true);
  assert.doesNotMatch(get('queueList').innerHTML, /Passage prévu/,
    'le rang et l’heure suffisent pour une chanson simplement prévue');
  assert.equal(get('alertsToggle').textContent, 'Activer les notifications');
  await get('alertsToggle').listeners.click();
  assert.equal(permissionRequests, 1, 'le clic demande réellement la permission du navigateur en HTTPS');
  assert.equal(get('alertsToggle').textContent, 'Désactiver les notifications');

  invitationReady = false;
  poll(); await settle();
  assert.equal(get('joinBox').hidden, true, 'une invitation utilisée ou expirée masque le formulaire solo');
  assert.doesNotMatch(get('catalogAccessActions').innerHTML, /M’inscrire/);
  assert.match(get('catalogAccessText').textContent, /déjà été utilisée ou a expiré/);
  invitationReady = true;
  poll(); await settle();

  privacyFiltered = true;
  poll(); await settle();
  assert.equal(get('joinBox').hidden, false, 'l’inscription fonctionne si l’API masque les autres profils');
  assert.equal(get('catalogAccessBox').hidden, false);

  recoveryPeople = [{ id: 'alice', name: 'Alice' }];
  poll(); await settle();
  assert.equal(get('tableBox').hidden, false, 'la reprise reste accessible même quand aucun autre profil n’est affiché');
  assert.equal(get('claimBox').hidden, false, 'un code actif ouvre la reprise sur un téléphone neuf');
  assert.match(get('claimPeople').innerHTML, /Je suis Alice · reprendre mes chansons/);
  assert.doesNotMatch(get('claimPeople').innerHTML, /Bob/);
  assert.match(get('catalogAccessActions').innerHTML, /Récupérer mes chansons/);
  assert.match(get('catalogAccessActions').innerHTML, /M’inscrire/);
  get('claimPeople').listeners.click({ target: { closest: () => ({ dataset: { claimPerson: 'bob' } }) } });
  assert.equal(get('sheet').hidden, true, 'un chanteur sans code actif ne peut pas ouvrir la reprise');
  get('claimPeople').listeners.click({ target: { closest: () => ({ dataset: { claimPerson: 'alice' } }) } });
  assert.match(get('sheetPanel').innerHTML, /Code de reprise à 4 chiffres/);
  get('claimCode').value = '1234';
  get('claimForm').listeners.submit({ preventDefault() {} });
  await settle(); await settle();
  assert.equal(lastClaimCode, '1234');
  assert.equal(claimPosts, 1);
  assert.equal(get('claimBox').hidden, true, 'la reprise disparaît dès que le téléphone gère Alice');
  assert.match(get('quickSongActions').innerHTML, /data-quick-song="alice"/);
  assert.doesNotMatch(get('peopleList').innerHTML, /Bob/);
  alice.needConfirm = true;
  alice.invites = [{ entryId: 'duo-1', fromName: 'Bob', song: { title: 'En duo' } }];
  poll(); await settle();
  assert.ok(notices.some(notice => notice.title === 'Karaoké : présence à confirmer'));
  assert.ok(notices.some(notice => notice.title === 'Karaoké : nouvelle demande' && /duo/.test(notice.body)),
    'une invitation de duo déclenche une notification si la page est ouverte en arrière-plan');
  alice.needConfirm = false;
  alice.invites = [];
  poll(); await settle();
  recoveryPeople = [{ id: 'bob', name: 'Bob' }];
  poll(); await settle();
  assert.equal(get('claimBox').hidden, true, 'un téléphone déjà lié ne voit pas une autre reprise');
  get('claimPeople').listeners.click({ target: { closest: () => ({ dataset: { claimPerson: 'bob' } }) } });
  await settle();
  assert.equal(claimPosts, 1, 'un téléphone déjà lié ne peut pas reprendre Bob');
  assert.equal(get('sheet').hidden, true);

  managedId = null;
  recoveryPeople = [];
  poll(); await settle();

  get('firstName').value = 'Zoé';
  get('joinForm').listeners.submit({ preventDefault() {} });
  await settle(); await settle();
  assert.equal(posts, 1);
  assert.equal(get('joinBox').hidden, true);
  assert.equal(get('tableBox').hidden, false);
  assert.equal(get('peopleCard').hidden, false);
  assert.equal(get('nav-table').textContent, 'Mes titres');
  assert.equal(get('quickSongBox').hidden, false);
  assert.match(get('quickSongActions').innerHTML, />Choisir une chanson</);
  assert.equal(get('addPersonBox').hidden, true);
  assert.equal(get('claimBox').hidden, true);
  assert.doesNotMatch(get('peopleList').innerHTML, /data-add-song=/, 'aucun second bouton de chanson dans la fiche solo');
  assert.doesNotMatch(get('peopleList').innerHTML, /Alice|Bob|data-add-song="alice"|data-add-song="bob"/);
  assert.match(get('peopleList').innerHTML, /Chanter en duo/);
  assert.match(get('peopleList').innerHTML, /Changer de téléphone/);
  assert.doesNotMatch(get('quickSongActions').innerHTML, /Alice|Bob/);
  assert.match(get('queueList').innerHTML, /Alice/);
  assert.match(get('queueList').innerHTML, /Zoé <span class="badge">ta chanson<\/span>/);
  assert.doesNotMatch(get('queueList').innerHTML, /Alice <span class="badge">ta chanson<\/span>/);

  get('newName').value = 'Faux profil';
  get('addPersonForm').listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(posts, 1, 'un téléphone du Comptoir ne peut pas inscrire un deuxième profil via l’interface');
  get('claimPeople').listeners.click({ target: { closest: () => ({ dataset: { claimPerson: 'alice' } }) } });
  assert.equal(get('sheet').hidden, true, 'le parcours de reprise des autres reste inaccessible après inscription');

  singer = null;
  managedId = null;
  count = headcount = 3;
  poll(); await settle();
  assert.equal(get('joinBox').hidden, true, 'aucun formulaire si le groupe est complet');
  assert.equal(get('noSingerBox').hidden, false);
  assert.match(get('catalogAccessText').textContent, /places « En solo » sont toutes prises/);
  assert.equal(get('addPersonBox').hidden, true);
  console.log('Comptoir client : inscription, reprise avec code, isolation visuelle et capacité OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
