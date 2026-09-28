'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
assert.ok(script, 'script de la page du bar');

class Element {
  constructor() {
    this.dataset = {};
    this.style = {};
    this.value = '';
    this.listeners = {};
    this.hidden = false;
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  querySelectorAll() { return []; }
  contains() { return false; }
  getAttribute() { return null; }
}
const elements = new Map();
const get = id => elements.get(id) || (elements.set(id, new Element()), elements.get(id));
const document = { activeElement: null, hidden: false, getElementById: get };
const singer = { id: 'alice', name: 'Alice', tableId: '1', active: true, songCount: 1,
  sung: 0, privateNote: 't-shirt rouge', verified: true };
let connected = true;
let manualChanges = [];
let queue = [];
const posts = [];
const state = () => ({
  kf: { ready: connected, connected, base: 'demo', code: '1234', queue: [], events: [] },
  karafun: { demo: true }, code: '1234',
  settings: { gap: 4, cap: 2, requirePresence: false, pushDelaySec: 10,
    playDelaySec: 8, auto: false, autoPlay: false, tableRotation: false, weightedTables: false },
  tables: [{ id: '1', name: 'Table 1', headcount: 2, activeCount: 1, count: 1 }],
  people: [singer], tracked: [], ips: [], queue, blocked: [], log: [], manualChanges,
  phoneBase: 'http://127.0.0.1:3000', port: 3000, avgSlotMin: 4,
  battle: { phase: 'idle' },
});
const response = data => ({ ok: true, json: async () => data });
const fetch = async (url, options = {}) => {
  if (url.startsWith('/api/staff/state')) return response(state());
  if (url.startsWith('/api/staff/person/identify')) {
    posts.push(JSON.parse(options.body));
    return response({ ok: true });
  }
  throw new Error(`Requête inattendue : ${url}`);
};
let poll;
const context = { document, fetch, location: { search: '' }, window: {}, URL, URLSearchParams,
  localStorage: { getItem: () => null, setItem() {} },
  setInterval: fn => { poll = fn; }, setTimeout: () => 1, clearTimeout() {},
  console, Date, Number, String, Set, Map, Array, JSON, Math, confirm: () => true };
vm.runInNewContext(script, context, { filename: 'staff.html' });
const settle = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  await settle();
  assert.equal(get('connectBtn').textContent, 'Changer le code', 'la connexion déjà active est explicite');
  assert.equal(String(get('battleCooldownMin').value), '15', 'valeur de repli Battle');
  assert.doesNotMatch(get('identityBody').innerHTML, /data-identity-verified|> Vérifié</,
    'le contrôle sans effet a disparu');
  assert.match(get('identityBody').innerHTML, /t-shirt rouge/, 'le repère reste affiché');

  const row = { dataset: { identityPerson: 'alice' }, querySelector: () => ({ value: 'veste bleue' }) };
  get('identityBody').listeners.click({ target: { closest: selector =>
    selector === '[data-identity-person]' ? row : selector === '[data-identity-save]' ? {} : null } });
  await settle();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].note, 'veste bleue');
  assert.equal(posts[0].verified, true, 'enregistrer le repère ne modifie pas un ancien état de vérification');

  connected = false;
  poll();
  await settle();
  assert.equal(get('connectBtn').textContent, 'Connecter', 'le bouton propose la connexion quand elle manque');
  manualChanges = [
    { id: 'second', kind: 'priority', name: 'Marine', from: 4, to: 1, at: Date.now(), canUndo: true },
    { id: 'first', kind: 'move', name: 'JP', from: 5, to: 2, at: Date.now(), canUndo: false },
  ];
  poll();
  await settle();
  assert.equal(get('manualHistory').hidden, false, 'les interventions sont retrouvables dans la file');
  assert.equal(get('manualCount').textContent, 2);
  assert.match(get('manualHistoryList').innerHTML, /Priorité : Marine/);
  assert.match(get('manualHistoryList').innerHTML, /Déplacement : JP/);
  assert.match(get('manualHistoryList').innerHTML, /data-manual-undo="second"/,
    'seule la dernière intervention est annulable immédiatement');
  assert.doesNotMatch(get('manualHistoryList').innerHTML, /data-manual-undo="first"/);
  assert.equal(get('recalculateQueue').disabled, false, 'l’annulation globale est possible si l’historique est actuel');
  queue = [{ source: 'karafun', ours: false, pos: 1, singer: 'La salle',
    title: 'Battle collective', artist: 'Simulation', eta: Date.now() }];
  poll();
  await settle();
  assert.match(get('qBody').innerHTML, /Ajouté dans KaraFun/,
    'un titre manuel dans KaraFun est visiblement distinct d’un titre envoyé par la file');
  console.log('Bar : connexion et repères chanteurs OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
