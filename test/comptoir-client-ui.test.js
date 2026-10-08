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
let joins = 0;
let opens = 0;
let renames = 0;
let claimPosts = 0;
let lastClaimCode = null;
let lastOpen = null;
let count = 2;
const stateUrls = [];
const state = () => ({
  table: { id: 'Comptoir', name: 'Comptoir', individual: true, headcount, count, activeCount: count },
  soloInvitationReady: !singer,
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
  if (url.startsWith('/api/state?')) { stateUrls.push(url); return response(state()); }
  // Retours du 4 octobre (lot A) : le QR individuel compte dès son ouverture,
  // par un POST de la page ; la personne a un prénom provisoire à remplacer.
  if (url === '/api/table/solo/open') {
    opens++;
    lastOpen = JSON.parse(options.body);
    singer = { id: 'zoe', name: 'Solo 1', nameRequired: true, active: true, songs: [], invites: [], inKaraFun: [] };
    managedId = singer.id;
    count++;
    return response({ id: singer.id, token: 'zoe-token', nameRequired: true });
  }
  if (url === '/api/table/person/rename') {
    renames++;
    const body = JSON.parse(options.body);
    singer = { ...singer, name: body.name };
    delete singer.nameRequired;
    return response({ ok: true });
  }
  if (url === '/api/join') { joins++; return response({}); }
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
const settleAll = async () => { for (let i = 0; i < 6; i++) await settle(); };

(async () => {
  await settleAll();
  // Ouverture du QR : la personne existe tout de suite, malgré les deux autres.
  assert.equal(opens, 1, 'le QR individuel est compté dès son ouverture');
  assert.deepEqual(lastOpen, { table: 'Comptoir', access: 'secret', invitation: 'personal-one-use-token' });
  assert.equal(joins, 0, 'plus d’inscription par le formulaire');
  assert.equal(saved.get('kfPeople:Comptoir:secret'), JSON.stringify({ zoe: 'zoe-token' }));
  assert.equal(get('nameGate').hidden, false, 'prénom obligatoire avant toute autre chose');
  assert.equal(get('tabsNav').hidden, true);
  assert.equal(get('mainContent').hidden, true);
  assert.equal(get('joinBox').hidden, true, 'aucun formulaire d’inscription « En solo »');
  assert.equal(get('claimBox').hidden, true, 'aucune reprise d’un autre client');
  assert.equal(get('addPersonBox').hidden, true, 'aucun bouton pour créer plusieurs profils');
  assert.equal(get('waitingCard').hidden, true, 'la file ne montre pas un faux groupe à la cliente solo');
  assert.equal(get('alertsToggle').textContent, 'Activer les notifications');
  await get('alertsToggle').listeners.click();
  assert.equal(permissionRequests, 1, 'le clic demande réellement la permission du navigateur en HTTPS');
  assert.equal(get('alertsToggle').textContent, 'Désactiver les notifications');
  poll(); await settleAll();
  assert.equal(opens, 1, 'jamais une deuxième ouverture');

  get('nameGateInput').value = 'Zoé';
  await get('nameGateForm').listeners.submit({ preventDefault() {} });
  await settleAll();
  assert.equal(renames, 1);
  assert.equal(get('nameGate').hidden, true);
  assert.equal(get('tabsNav').hidden, false);
  assert.equal(get('mainContent').hidden, false);
  assert.match(stateUrls.at(-1), /invitation=personal-one-use-token/, 'l’adresse garde la clé personnelle');
  assert.equal(get('joinBox').hidden, true);
  assert.equal(get('tableBox').hidden, false);
  assert.equal(get('peopleCard').hidden, false);
  assert.equal(get('navTableLabel').textContent, 'Mes titres');
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
  assert.doesNotMatch(get('queueList').innerHTML, /Passage prévu/,
    'le rang et l’heure suffisent pour une chanson simplement prévue');

  get('newName').value = 'Faux profil';
  get('addPersonForm').listeners.submit({ preventDefault() {} });
  await settle();
  assert.equal(count, 3, 'un téléphone du Comptoir ne peut pas inscrire un deuxième profil via l’interface');
  get('claimPeople').listeners.click({ target: { closest: () => ({ dataset: { claimPerson: 'alice' } }) } });
  assert.equal(get('sheet').hidden, true, 'le parcours de reprise des autres reste inaccessible après inscription');

  // Gestion reprise ailleurs (lien commun) : la reprise par code reste possible.
  managedId = null;
  privacyFiltered = true;
  poll(); await settleAll();
  assert.equal(opens, 1, 'la page n’ouvre pas une seconde fois le QR de lui-même');
  assert.equal(get('catalogAccessBox').hidden, false);
  assert.match(get('catalogAccessText').textContent, /demande au bar un QR individuel/);

  recoveryPeople = [{ id: 'alice', name: 'Alice' }];
  poll(); await settleAll();
  assert.equal(get('tableBox').hidden, false, 'la reprise reste accessible même quand aucun autre profil n’est affiché');
  assert.equal(get('claimBox').hidden, false, 'un code actif ouvre la reprise sur un téléphone neuf');
  assert.match(get('claimPeople').innerHTML, /Je suis Alice · reprendre mes chansons/);
  assert.doesNotMatch(get('claimPeople').innerHTML, /Bob/);
  assert.match(get('catalogAccessActions').innerHTML, /Récupérer mes chansons/);
  get('claimPeople').listeners.click({ target: { closest: () => ({ dataset: { claimPerson: 'bob' } }) } });
  assert.equal(get('sheet').hidden, true, 'un chanteur sans code actif ne peut pas ouvrir la reprise');
  get('claimPeople').listeners.click({ target: { closest: () => ({ dataset: { claimPerson: 'alice' } }) } });
  assert.match(get('sheetPanel').innerHTML, /Code de reprise à 4 chiffres/);
  get('claimCode').value = '1234';
  get('claimForm').listeners.submit({ preventDefault() {} });
  await settleAll();
  assert.equal(lastClaimCode, '1234');
  assert.equal(claimPosts, 1);
  assert.equal(get('claimBox').hidden, true, 'la reprise disparaît dès que le téléphone gère Alice');
  assert.match(get('quickSongActions').innerHTML, /data-quick-song="alice"/);
  assert.doesNotMatch(get('peopleList').innerHTML, /Bob/);
  alice.needConfirm = true;
  alice.invites = [{ entryId: 'duo-1', fromName: 'Bob', song: { title: 'En duo' } }];
  poll(); await settleAll();
  // Page en arrière-plan : une notification par demande, présence puis duo.
  assert.deepEqual(notices.map(notice => [notice.title, notice.body]), [
    ['Karaoké : réponse attendue', 'C’est bientôt au tour d’Alice !'],
    ['Karaoké : réponse attendue', 'Bob propose un duo à Alice']]);
  assert.match(document.title, /^🔴 Réponse attendue$|^\(2\) /, 'le titre de l’onglet signale les demandes');
  alice.needConfirm = false;
  alice.invites = [];
  poll(); await settleAll();
  recoveryPeople = [{ id: 'bob', name: 'Bob' }];
  poll(); await settleAll();
  assert.equal(get('claimBox').hidden, true, 'un téléphone déjà lié ne voit pas une autre reprise');
  get('claimPeople').listeners.click({ target: { closest: () => ({ dataset: { claimPerson: 'bob' } }) } });
  await settle();
  assert.equal(claimPosts, 1, 'un téléphone déjà lié ne peut pas reprendre Bob');
  assert.equal(get('sheet').hidden, true);

  singer = null;
  managedId = null;
  recoveryPeople = [];
  count = headcount = 3;
  poll(); await settleAll();
  assert.doesNotMatch(get('catalogAccessText').textContent, /toutes prises/, '« En solo » n’a pas de nombre de places');
  assert.equal(get('addPersonBox').hidden, true);
  assert.equal(get('joinBox').hidden, true);
  console.log('Comptoir client : QR compté à l’ouverture, prénom obligatoire, reprise avec code, isolation visuelle et groupe sans limite de places OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
