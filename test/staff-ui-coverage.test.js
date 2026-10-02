'use strict';
// Page du bar (public/staff.html) : ce que le gérant voit et ce que la page
// envoie au serveur, pour chaque commande de la soirée. Le balisage réel de la
// page est chargé dans un petit DOM simulé (sélecteurs, propagation des
// clics, listes déroulantes), puis son premier <script> est exécuté dans un
// bac à sable nommé « staff.html », comme les autres tests de la page, pour
// que test/coverage.js rattache la couverture à la page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'staff.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
assert.ok(script, 'script de la page du bar');
const bodyHtml = html.slice(html.indexOf('<body'), html.indexOf('<script>'));
const KEY = '123456'; // clé factice du bar
const hhmm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const settle = () => new Promise(resolve => setImmediate(resolve));

// ------------------------------------------------------------------ DOM simulé
const VOID = new Set(['input', 'img', 'br', 'meta', 'link', 'hr', 'source']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: '\u00a0' };
const decode = text => text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ENTITIES[name]);
const camel = name => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const REFLECTED = ['id', 'src', 'href', 'title', 'placeholder', 'type', 'name'];

class El {
  constructor(doc, tag = 'div', attrs = {}) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this.listeners = {};
    this.style = {};
    // Comme le vrai DOM, dataset ne garde que des chaînes.
    this.dataset = new Proxy({}, { set(target, name, value) { target[name] = String(value); return true; } });
    for (const [name, value] of Object.entries(attrs)) if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = value;
    this.className = attrs.class || '';
    this.hidden = 'hidden' in attrs;
    this.disabled = 'disabled' in attrs;
    this.checked = 'checked' in attrs;
    this.selected = 'selected' in attrs;
    this.open = 'open' in attrs;
    for (const name of REFLECTED) if (name in attrs) this[name] = attrs[name];
    this._value = attrs.value ?? (this.tagName === 'OPTION' ? null : '');
  }
  get parentElement() { return this.parent; }
  get value() {
    if (this.tagName === 'SELECT') return this.selectedOptions[0]?.value ?? '';
    if (this.tagName === 'OPTION') return this._value ?? this.textContent;
    return this._value;
  }
  set value(value) {
    if (this.tagName !== 'SELECT') { this._value = value; return; }
    const options = this.options;
    for (const option of options) option.selected = option.value === String(value);
    this._noneSelected = !options.some(option => option.selected);
  }
  get options() { return this.querySelectorAll('option'); }
  get selectedOptions() {
    const options = this.options;
    const chosen = options.filter(option => option.selected);
    if (chosen.length) return [chosen.at(-1)];
    return this._noneSelected || !options.length ? [] : [options[0]];
  }
  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean);
    const add = (...names) => { this.className = [...new Set([...list(), ...names])].join(' '); };
    const remove = (...names) => { this.className = list().filter(name => !names.includes(name)).join(' '); };
    return { contains: name => list().includes(name), add, remove,
      toggle: (name, force) => { const on = force === undefined ? !list().includes(name) : !!force; (on ? add : remove)(name); return on; } };
  }
  get innerHTML() { return this._html ?? ''; }
  set innerHTML(source) {
    this._html = String(source);
    this._text = undefined;
    this._noneSelected = false;
    this.children = parse(this.ownerDocument, this._html, this);
  }
  get textContent() {
    if (this._text !== undefined) return this._text;
    return this.children.map(child => typeof child === 'string' ? decode(child) : child.textContent).join('');
  }
  set textContent(text) { this._text = String(text); this._html = undefined; this.children = []; }
  *descendants() {
    for (const child of this.children) if (child instanceof El) { yield child; yield* child.descendants(); }
  }
  querySelectorAll(selector) { return [...this.descendants()].filter(el => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  matches(selector) { return selector.split(',').some(part => matchChain(this, part.trim().split(/\s+/))); }
  closest(selector) { for (let el = this; el; el = el.parent) if (el.matches(selector)) return el; return null; }
  contains(other) { for (let el = other; el; el = el.parent) if (el === this) return true; return false; }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[camel(name.slice(5))] ?? null;
    if (REFLECTED.includes(name)) return this[name] == null ? null : String(this[name]);
    return name in this.attrs ? this.attrs[name] : null;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = String(value);
    if (REFLECTED.includes(name)) this[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attrs[name];
    if (name.startsWith('data-')) delete this.dataset[camel(name.slice(5))];
    if (REFLECTED.includes(name)) delete this[name];
  }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  removeEventListener(type, listener) { this.listeners[type] = (this.listeners[type] || []).filter(fn => fn !== listener); }
  dispatchEvent(event) { dispatch(this, event.type, event); return true; }
  // Comme dans un navigateur, un bouton désactivé ne réagit pas.
  click() { return this.disabled ? null : dispatch(this, 'click'); }
  focus() { this.ownerDocument.activeElement = this; }
  select() { this.selectedAll = true; }
  showModal() { this.open = true; }
  close() { if (this.open) { this.open = false; dispatch(this, 'close', { bubbles: false }); } }
  setPointerCapture(id) { this.capture = id; }
  getBoundingClientRect() { return this.rect || { top: 0, height: 0 }; }
}

function matchSimple(el, simple) {
  const m = /^([a-zA-Z0-9]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/.exec(simple);
  if (!m) throw new Error(`Sélecteur non géré par le DOM simulé : ${simple}`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  const classes = el.classList;
  if (m[2] && !m[2].split('.').filter(Boolean).every(name => classes.contains(name))) return false;
  for (const [, name, value] of m[3].matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
    const actual = el.getAttribute(name);
    if (actual === null || (value !== undefined && actual !== value)) return false;
  }
  return true;
}
function matchChain(el, parts) {
  if (!matchSimple(el, parts.at(-1))) return false;
  let rest = parts.length - 2;
  for (let up = el.parent; up && rest >= 0; up = up.parent) if (matchSimple(up, parts[rest])) rest--;
  return rest < 0;
}

// Propagation : gestionnaire « onX », écouteurs de chaque ancêtre, puis du document.
function dispatch(target, type, init = {}) {
  const event = { bubbles: true, ...init, type, target, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  const route = [];
  for (let el = target; el; el = el.parent) route.push(el);
  for (const node of event.bubbles === false ? [target] : route) {
    event.currentTarget = node;
    if (typeof node['on' + type] === 'function') node['on' + type](event);
    for (const listener of [...(node.listeners[type] || [])]) listener(event);
    if (event.stopped) return event;
  }
  if (event.bubbles !== false) for (const listener of target.ownerDocument.listeners[type] || []) listener(event);
  return event;
}

function parse(doc, source, container) {
  const root = [];
  const stack = [{ tag: null, el: container, children: root }];
  const tagPattern = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let last = 0;
  for (const m of source.matchAll(tagPattern)) {
    if (m.index > last) stack.at(-1).children.push(source.slice(last, m.index));
    last = m.index + m[0].length;
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const open = stack.findLastIndex(frame => frame.tag === tag);
      if (open > 0) stack.length = open;
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([^\s="'/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    }
    const el = new El(doc, tag, attrs);
    el.parent = stack.at(-1).el;
    stack.at(-1).children.push(el);
    if (!VOID.has(tag)) stack.push({ tag, el, children: el.children });
  }
  if (last < source.length) stack.at(-1).children.push(source.slice(last));
  return root;
}

function makeDocument() {
  const doc = { listeners: {}, activeElement: null, hidden: false, title: '', copyWorks: false,
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); },
    execCommand() { return this.copyWorks; } };
  const body = new El(doc, 'div');
  body.innerHTML = bodyHtml;
  const byId = new Map();
  doc.getElementById = id => {
    const cached = byId.get(id);
    if (cached && cached.id === id && body.contains(cached)) return cached;
    const found = [...body.descendants()].find(el => el.id === id) || null;
    if (found) byId.set(id, found);
    return found;
  };
  doc.body = body;
  return doc;
}

// ------------------------------------------------------------------ état servi
function baseWorld() {
  return {
    kf: { ready: true, connected: true, base: 'demo', code: KEY, queue: [{ queueId: 1, title: 'Titre' }], username: 'FileKaraoke',
      events: [{ t: '2026-10-02T21:15:30.000Z', dir: 'in', name: 'status', data: { state: 'playing' } }] },
    karafun: { demo: true }, code: KEY,
    settings: { gap: 4, cap: 2, requirePresence: false, pushDelaySec: 10, playDelaySec: 8, auto: false, autoPlay: false,
      tableRotation: false, weightedTables: false },
    spotify: null,
    tables: [
      { id: '1', name: 'Table 1', headcount: 4, activeCount: 2, count: 2, url: 'http://192.168.1.20:3000/t/1/abc', qrUrl: '/qr/1.png' },
      { id: '2', name: 'Table 2', headcount: 2, activeCount: 1, count: 1 },
      { id: 'Comptoir', name: 'En solo', individual: true, headcount: 40, activeCount: 1, count: 1 },
    ],
    people: [
      { id: 'alice', name: 'Alice', tableId: '1', active: true, songCount: 1, sung: 0, privateNote: 't-shirt rouge', verified: true },
      { id: 'bruno', name: 'Bruno', tableId: '1', active: true, songCount: 2, sung: 3 },
      { id: 'chloe', name: 'Chloé', tableId: '2', active: false, songCount: 0, sung: 1 },
      { id: 'dora', name: 'Dora', tableId: 'Comptoir', active: true, songCount: 1, sung: 0, photoUrl: '/photo/dora.jpg' },
    ],
    stage: null, next: null, tracked: [], ips: [{ address: '192.168.1.20' }], queue: [], blocked: [], log: [],
    manualChanges: [], soloInvitations: [], presencePending: [], bootId: 'boot-1', restarting: false, closing: null,
    phoneBase: 'http://192.168.1.20:3000', port: 3000, avgSlotMin: 4.5, battle: { phase: 'idle' },
  };
}

const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

// Ouvre la page du bar avec un faux serveur. `replies` donne la réponse d'un
// POST par chemin (objet, ou fonction du corps) ; { status, error } = refus.
async function openPage({ search = `?key=${KEY}`, hostname = '127.0.0.1', world = baseWorld(), storage = {},
  storageThrows = false, secure = true, permission = 'granted', audioThrows = false, notifyThrows = false } = {}) {
  const doc = makeDocument();
  const page = { doc, world, posts: [], fetches: [], replies: {}, confirmAnswer: true, confirms: [], prompts: [],
    promptAnswer: null, opened: [], notifications: [], permissionRequests: 0, rings: 0, clipboard: [], clipboardWorks: true,
    stateStatus: 200, searches: [], stored: new Map(Object.entries(storage)) };
  page.$ = id => {
    const el = doc.getElementById(id);
    assert.ok(el, `élément #${id} présent dans la page`);
    return el;
  };
  page.search = q => q === 'Panne' ? { status: 503, error: 'Catalogue KaraFun indisponible.' }
    : q === 'Rien' ? [] : [{ songId: 42, title: 'Bohemian Rhapsody', artist: 'Queen' }, { songId: 7, title: 'Dancing Queen', artist: 'ABBA' }];
  const fetch = async (url, options = {}) => {
    page.fetches.push({ url, options });
    const [route] = url.split('?');
    if (route === '/api/staff/state') {
      if (page.stateStatus !== 200) return json({}, page.stateStatus);
      return json(JSON.parse(JSON.stringify(page.world)));
    }
    if (route === '/api/search') {
      const q = new URLSearchParams(url.split('?')[1]).get('q');
      page.searches.push(q);
      const result = page.search(q);
      return Array.isArray(result) ? json(result) : json({ error: result.error }, result.status);
    }
    assert.equal(options.method, 'POST', `requête inattendue : ${url}`);
    const body = JSON.parse(options.body);
    page.posts.push({ path: route, url, body, headers: options.headers });
    const reply = page.replies[route];
    const result = typeof reply === 'function' ? reply(body) : reply || { ok: true };
    return result.status ? json({ error: result.error }, result.status) : json(result);
  };
  const timers = new Map();
  let timerId = 0;
  page.runTimers = ms => { for (const [id, timer] of timers) if (timer.ms === ms) { timers.delete(id); timer.fn(); } };
  class AudioContext {
    constructor() { if (audioThrows) throw new Error('audio bloqué'); this.currentTime = 0; this.destination = {}; }
    resume() {}
    createOscillator() { return { frequency: {}, connect() {}, start() { page.rings++; }, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  class Notification {
    constructor(title, options) {
      if (notifyThrows) throw new TypeError('Illegal constructor');
      page.notifications.push({ title, ...options });
    }
    static requestPermission() { page.permissionRequests++; return Promise.resolve('granted'); }
  }
  Notification.permission = permission;
  const localStorage = {
    getItem: key => page.stored.get(key) ?? null,
    setItem: (key, value) => { if (storageThrows) throw new Error('stockage plein'); page.stored.set(key, String(value)); },
  };
  const context = { document: doc, fetch, location: { search, hostname }, URL, URLSearchParams, localStorage,
    window: { open: (...args) => page.opened.push(args), AudioContext, Notification, isSecureContext: secure },
    Notification, navigator: { clipboard: { writeText: async text => {
      if (!page.clipboardWorks) throw new Error('presse-papiers refusé');
      page.clipboard.push(text);
    } } },
    CSS: { escape: value => String(value) }, Event: class { constructor(type, init) { Object.assign(this, init, { type }); } },
    setInterval: fn => { page.pollFn = fn; }, setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: id => timers.delete(id),
    confirm: message => { page.confirms.push(message); return page.confirmAnswer; },
    prompt: (message, value) => { page.prompts.push({ message, value }); return page.promptAnswer; },
    console, Date, Number, String, Set, Map, Array, JSON, Math, Promise, Object, Error };
  vm.runInNewContext(script, context, { filename: 'staff.html' });
  page.flush = async () => { for (let i = 0; i < 4; i++) await settle(); };
  page.poll = async () => { page.pollFn(); await page.flush(); };
  page.update = async patch => { Object.assign(page.world, patch); await page.poll(); };
  page.click = async el => { el.click(); await page.flush(); };
  page.change = async (el, value) => {
    if (value !== undefined) { if (typeof value === 'boolean') el.checked = value; else el.value = value; }
    dispatch(el, 'change');
    await page.flush();
  };
  page.type = async (el, value) => { el.value = value; dispatch(el, 'input'); await page.flush(); };
  page.key = async (el, key) => { const event = dispatch(el, 'keydown', { key }); await page.flush(); return event; };
  page.toast = () => ({ text: page.$('toast').textContent, bad: page.$('toast').className.includes('bad') });
  page.lastPost = route => (route ? page.posts.filter(post => post.path === route) : page.posts).at(-1);
  page.postsTo = route => page.posts.filter(post => post.path === route);
  page.in = (id, selector) => page.$(id).querySelector(selector);
  page.all = (id, selector) => page.$(id).querySelectorAll(selector);
  await page.flush();
  return page;
}
const texts = nodes => nodes.map(node => node.textContent.trim());

// ------------------------------------------------------------------ tests

test('accès du bar : la clé suit chaque requête, QR privé du bar et QR des tables', async () => {
  const page = await openPage();
  const first = page.fetches[0];
  assert.equal(first.url, `/api/staff/state?key=${KEY}`, 'l’état est demandé avec la clé du bar');
  assert.equal(first.options.headers['x-staff-key'], KEY);
  assert.equal(page.$('kfPill').textContent, 'KaraFun connecté (démo)');
  assert.equal(page.$('staffQr').src, `/qr/staff.svg?key=${KEY}`, 'le QR du bar transporte la clé');
  assert.equal(page.$('printLink').href, `/print?key=${KEY}`);
  // QR du bar introuvable : message à la place de l'image, puis retour.
  page.$('staffQr').onerror();
  assert.equal(page.$('staffQr').hidden, true);
  assert.equal(page.$('staffQrError').hidden, false, 'le bar sait que le QR est indisponible');
  page.$('staffQr').onload();
  assert.equal(page.$('staffQr').hidden, false);
  assert.equal(page.$('staffQrError').hidden, true);
  const src = page.$('staffQr').src;
  await page.poll();
  assert.equal(page.$('staffQr').src, src, 'le QR du bar n’est pas rechargé à chaque rafraîchissement');

  await page.click(page.$('connectBtn'));
  const connect = page.lastPost();
  assert.equal(connect.url, `/api/staff/connect?key=${KEY}`);
  assert.equal(connect.headers['x-staff-key'], KEY);
  assert.deepEqual(connect.body, { code: KEY });
  assert.equal(page.toast().text, 'Connexion…');
  await page.click(page.$('reconnectBtn'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'reconnect' });
  assert.equal(page.toast().text, 'Reconnexion…');

  // QR d'une table : lien versionné par son adresse (le cache ne garde pas l'ancien).
  const qrLink = () => page.all('tBody', 'a').find(a => a.textContent === 'Voir le QR').href;
  assert.match(qrLink(), new RegExp(`^/qr/1\\.png\\?v=[0-9a-f]+&key=${KEY}$`));
  const before = qrLink();
  page.world.tables[0].url = 'http://192.168.1.20:3000/t/1/nouveau';
  await page.poll();
  assert.notEqual(qrLink(), before, 'nouvelle adresse de table : nouveau QR');
  assert.equal(page.all('tBody', 'a').filter(a => a.textContent === 'Voir le QR').length, 1, 'seule la table avec adresse a un QR');
  assert.equal(page.$('phoneLabel').textContent, '1 QR code disponible · adresse utilisée');
  assert.equal(page.$('phoneBase').textContent, 'http://192.168.1.20:3000');
  // Sans clé : ni paramètre ni clé vide dans l'adresse.
  const anonymous = await openPage({ search: '' });
  assert.equal(anonymous.fetches[0].url, '/api/staff/state');
  assert.equal(anonymous.$('staffQr').src, '/qr/staff.svg');
  assert.match(anonymous.all('tBody', 'a').find(a => a.textContent === 'Voir le QR').href, /^\/qr\/1\.png\?v=[0-9a-f]+$/);
});

test('adresse des QR : seule une adresse HTTPS publique sans chemin est acceptée', async () => {
  const page = await openPage();
  assert.match(page.$('accessMode').textContent, /^Mode Wi-Fi local/, 'adresse locale : avertissement Wi-Fi');
  assert.equal(page.$('accessMode').style.color, 'var(--warn, #a35b00)');
  assert.equal(page.$('customBase').value, '', 'une adresse locale n’est pas présentée comme publique');
  const save = async value => { page.$('customBase').value = value; await page.click(page.$('saveBase')); return page.toast(); };
  assert.deepEqual(await save('pas une adresse'), { text: 'Saisis une adresse HTTPS valide.', bad: true });
  for (const refused of ['http://chant.exemple.fr', 'https://192.168.1.5', 'https://10.0.0.2', 'https://127.0.0.1',
    'https://172.16.0.1', 'https://172.31.255.1', 'https://169.254.1.1', 'https://localhost', 'https://bar.local',
    'https://chant.localhost', 'https://[::1]', 'https://chant.exemple.fr/chemin', 'https://moi:secret@chant.exemple.fr',
    'https://chant.exemple.fr/?a=1', 'https://chant.exemple.fr/#ancre']) {
    assert.deepEqual(await save(refused), { text: 'Saisis une adresse HTTPS publique, sans chemin, identifiants ni paramètres.', bad: true }, refused);
  }
  assert.equal(page.postsTo('/api/staff/settings').length, 0, 'aucune adresse refusée n’est envoyée');
  for (const [typed, sent] of [['https://chant.exemple.fr/', 'https://chant.exemple.fr'],
    ['  https://172.32.0.1  ', 'https://172.32.0.1'], ['https://8.8.8.8', 'https://8.8.8.8']]) {
    await save(typed);
    assert.deepEqual(page.lastPost('/api/staff/settings').body, { baseUrl: sent }, typed);
  }
  assert.equal(page.toast().text, 'QR configurés pour l’adresse HTTPS');
  await page.update({ phoneBase: 'https://chant.exemple.fr' });
  assert.match(page.$('accessMode').textContent, /^Accès Internet actif/);
  assert.equal(page.$('accessMode').style.color, 'var(--ok, #167348)');
  assert.equal(page.$('customBase').value, 'https://chant.exemple.fr', 'l’adresse publique en service est rappelée');
  page.$('customBase').focus();
  page.$('customBase').value = 'https://autre.exemple.fr';
  await page.poll();
  assert.equal(page.$('customBase').value, 'https://autre.exemple.fr', 'la saisie en cours n’est pas écrasée');
  page.doc.activeElement = null;

  // Wi-Fi local : l'adresse choisie dans la liste.
  assert.deepEqual(texts(page.$('ipSel').options), ['http://192.168.1.20:3000']);
  await page.click(page.$('useLocal'));
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { baseUrl: 'http://192.168.1.20:3000' });
  assert.equal(page.toast().text, 'QR configurés pour le Wi-Fi local');
  const count = page.posts.length;
  await page.update({ ips: [] });
  assert.equal(page.$('ipSel').textContent, 'aucune adresse réseau détectée');
  await page.click(page.$('useLocal'));
  assert.equal(page.posts.length, count, 'sans adresse locale, rien n’est envoyé');
});

test('repères chanteurs : recherche, filtre de table, bonus, départ et retour', async () => {
  const page = await openPage();
  assert.equal(page.$('identityCount').textContent, '4');
  const names = () => texts(page.all('identityBody', '.identity-who strong'));
  const groups = () => texts(page.all('identityBody', 'h4'));
  assert.deepEqual(names(), ['Alice', 'Bruno', 'Chloé', 'Dora'], 'tri par table puis par prénom');
  assert.deepEqual(groups(), ['Table 1 2 personnes', 'Table 2 1 personne', 'En solo 1 personne']);
  const row = id => page.in('identityBody', `[data-identity-person="${id}"]`);
  assert.equal(row('bruno').querySelector('.tiny').textContent, '2 titres · 3 passages');
  assert.equal(row('alice').querySelector('.tiny').textContent, '1 titre · 0 passage');
  assert.equal(row('chloe').querySelector('.tiny').textContent, 'parti, fiche conservée');
  assert.ok(row('chloe').classList.contains('gone'));
  assert.ok(row('chloe').querySelector('[data-identity-share]').disabled, 'une personne partie ne se transfère pas');
  assert.equal(row('dora').querySelector('img').src, '/photo/dora.jpg');
  assert.equal(row('alice').querySelector('.identity-avatar').textContent, 'A', 'initiale sans photo');

  // Recherche par repère, par nom de table, puis sans résultat.
  const field = page.$('identitySearch');
  const clear = field.parentElement.querySelector('[data-clear-for="identitySearch"]');
  assert.equal(clear.hidden, true);
  await page.type(field, 'ROUGE');
  assert.deepEqual(names(), ['Alice'], 'le repère privé sert à retrouver quelqu’un');
  assert.equal(clear.hidden, false, 'le × apparaît dès qu’on tape');
  await page.type(field, 'table 2');
  assert.deepEqual(names(), ['Chloé']);
  await page.type(field, 'zzz');
  assert.equal(page.$('identityBody').textContent, 'Aucun chanteur pour ce filtre.');
  await page.click(clear);
  assert.equal(field.value, '');
  assert.equal(clear.hidden, true);
  assert.equal(page.doc.activeElement, field, 'le × rend la main au champ');
  assert.deepEqual(names(), ['Alice', 'Bruno', 'Chloé', 'Dora'], 'champ vidé : toute la liste revient');
  page.doc.activeElement = null;

  // Filtre de table, conservé entre deux rafraîchissements.
  assert.deepEqual(texts(page.$('identityTable').options), ['Toutes les tables', 'Table 1', 'Table 2', 'En solo']);
  await page.change(page.$('identityTable'), '1');
  assert.deepEqual(names(), ['Alice', 'Bruno']);
  await page.poll();
  assert.equal(page.$('identityTable').value, '1', 'le filtre reste en place');
  assert.deepEqual(names(), ['Alice', 'Bruno']);
  page.world.tables = page.world.tables.filter(t => t.id !== '1');
  page.world.people = page.world.people.filter(p => p.tableId !== '1');
  await page.poll();
  assert.equal(page.$('identityTable').value, 'all', 'table supprimée : retour à toutes les tables');
  Object.assign(page.world, baseWorld());
  await page.poll();
  assert.deepEqual(names(), ['Alice', 'Bruno', 'Chloé', 'Dora']);
  // Saisie en cours dans un repère : la liste n'est pas redessinée sous les doigts.
  const html = page.$('identityBody').innerHTML;
  row('bruno').querySelector('[data-identity-note]').focus();
  page.world.people[1].privateNote = 'nouveau repère';
  await page.poll();
  assert.equal(page.$('identityBody').innerHTML, html, 'pas de rafraîchissement pendant la saisie');
  page.doc.activeElement = null;
  await page.poll();

  // Bonus réservé au bar.
  await page.change(row('bruno').querySelector('[data-person-bonus]'), '2');
  assert.deepEqual(page.lastPost('/api/staff/bonus').body, { personId: 'bruno', level: 2 });
  assert.equal(page.toast().text, 'Bonus enregistré (invisible des clients) ; la file est recalculée');
  await page.change(row('bruno').querySelector('[data-person-bonus]'), '0');
  assert.deepEqual(page.lastPost('/api/staff/bonus').body, { personId: 'bruno', level: 0 });
  assert.equal(page.toast().text, 'Bonus retiré');
  page.world.people[1].bonus = -2;
  await page.poll();
  assert.equal(row('bruno').querySelector('[data-person-bonus]').value, '-2', 'le bonus enregistré est présélectionné');
  // Un changement hors de la liste des bonus n'envoie rien.
  const before = page.posts.length;
  await page.change(row('alice').querySelector('[data-identity-note]'), 'x');
  assert.equal(page.posts.length, before);

  // Repère validé par Entrée : même envoi que le bouton ✓, vérification conservée.
  row('alice').querySelector('[data-identity-note]').value = 'veste bleue';
  const enter = await page.key(row('alice').querySelector('[data-identity-note]'), 'Enter');
  assert.equal(enter.defaultPrevented, true, 'Entrée ne soumet rien d’autre');
  assert.deepEqual(page.lastPost('/api/staff/person/identify').body, { personId: 'alice', note: 'veste bleue', verified: true });
  assert.equal(page.toast().text, 'Repère privé enregistré');
  const count = page.posts.length;
  await page.key(row('alice').querySelector('[data-identity-note]'), 'a');
  await page.key(row('alice').querySelector('[data-identity-save]'), 'Enter');
  assert.equal(page.posts.length, count, 'seule Entrée dans le repère enregistre');
  await page.click(row('bruno').querySelector('[data-identity-save]'));
  assert.deepEqual(page.lastPost('/api/staff/person/identify').body, { personId: 'bruno', note: 'nouveau repère', verified: false },
    'sans vérification enregistrée, le repère part non vérifié');

  // Départ confirmé seulement, puis retour.
  page.confirmAnswer = false;
  await page.click(row('bruno').querySelector('[data-identity-leave]'));
  assert.equal(page.postsTo('/api/staff/person/leave').length, 0, 'départ annulé : rien n’est envoyé');
  assert.match(page.confirms.at(-1), /Marquer ce chanteur comme parti/);
  page.confirmAnswer = true;
  await page.click(row('bruno').querySelector('[data-identity-leave]'));
  assert.deepEqual(page.lastPost('/api/staff/person/leave').body, { personId: 'bruno' });
  assert.equal(page.toast().text, 'Chanteur marqué parti ; ses titres en attente ont été retirés');
  await page.click(row('chloe').querySelector('[data-identity-reactivate]'));
  assert.deepEqual(page.lastPost('/api/staff/person/reactivate').body, { personId: 'chloe' });
  assert.equal(page.toast().text, 'Personne réactivée, historique conservé');
  // Un clic hors d'une ligne ne fait rien.
  const total = page.posts.length;
  await page.click(page.$('identityBody'));
  assert.equal(page.posts.length, total);
});

test('repères chanteurs : transfert vers un autre téléphone (lien, code, erreurs)', async () => {
  const page = await openPage();
  const row = id => page.in('identityBody', `[data-identity-person="${id}"]`);
  const linkExpiresAt = Date.now() + 10 * 60000, expiresAt = Date.now() + 20 * 60000;
  page.replies['/api/staff/person/share'] = { code: '4821', url: 'https://bar.example/t/1/x?transfer=abc',
    qr: 'data:image/png;base64,QQ', linkExpiresAt, expiresAt };
  await page.click(row('alice').querySelector('[data-identity-share]'));
  assert.deepEqual(page.lastPost('/api/staff/person/share').body, { personId: 'alice' });
  assert.equal(page.$('shareDialog').open, true);
  assert.equal(page.$('shareTitle').textContent, 'Accès à Alice');
  assert.equal(page.$('shareCode').textContent, '4821');
  assert.equal(page.$('shareQrBox').hidden, false);
  assert.equal(page.$('shareQr').src, 'data:image/png;base64,QQ');
  assert.equal(page.$('shareUrl').hidden, false);
  assert.equal(page.$('shareLinkActions').hidden, false);
  assert.equal(page.$('shareUrl').value, 'https://bar.example/t/1/x?transfer=abc');
  assert.match(page.$('shareHelp').textContent, /ou envoie-lui le lien/);
  assert.match(page.$('shareCodeHelp').textContent, /sur la page de la table/);
  assert.equal(page.$('shareExpires').textContent,
    `QR et lien valables jusqu’à ${hhmm(linkExpiresAt)}, code jusqu’à ${hhmm(expiresAt)} ; un seul usage.`);
  await page.click(page.$('shareCopy'));
  assert.deepEqual(page.clipboard, ['https://bar.example/t/1/x?transfer=abc']);
  assert.equal(page.toast().text, 'Lien copié');
  page.clipboardWorks = false;
  await page.click(page.$('shareCopy'));
  assert.equal(page.$('shareUrl').selectedAll, true, 'sans presse-papiers, le lien est sélectionné');
  assert.equal(page.toast().text, 'Sélectionne le lien pour le copier');
  page.doc.copyWorks = true;
  await page.click(page.$('shareCopy'));
  assert.equal(page.toast().text, 'Lien copié', 'copie de secours du navigateur');
  await page.click(page.$('shareClose'));
  assert.equal(page.$('shareDialog').open, false);
  assert.equal(page.$('shareCode').textContent, '', 'le code ne reste pas affiché après fermeture');
  assert.equal(page.$('shareUrl').value, '');
  assert.equal(page.$('shareQr').getAttribute('src'), null);

  // Personne « En solo », code seul (pas de lien ni de QR).
  page.replies['/api/staff/person/share'] = { code: '1234', expiresAt };
  await page.click(row('dora').querySelector('[data-identity-share]'));
  assert.equal(page.$('shareTitle').textContent, 'Accès à Dora');
  assert.equal(page.$('shareQrBox').hidden, true);
  assert.equal(page.$('shareUrl').hidden, true);
  assert.equal(page.$('shareLinkActions').hidden, true);
  assert.match(page.$('shareHelp').textContent, /saisis ce code/);
  assert.match(page.$('shareCodeHelp').textContent, /ouvrir le QR « En solo »/);
  assert.equal(page.$('shareExpires').textContent, `code jusqu’à ${hhmm(expiresAt)} ; un seul usage.`);
  page.$('shareDialog').close();

  page.replies['/api/staff/person/share'] = { status: 409, error: 'Cette personne est partie.' };
  await page.click(row('alice').querySelector('[data-identity-share]'));
  assert.deepEqual(page.toast(), { text: 'Cette personne est partie.', bad: true });
  assert.equal(page.$('shareDialog').open, false, 'pas de fenêtre de transfert après un refus');
  page.replies['/api/staff/person/share'] = { status: 500 };
  await page.click(row('alice').querySelector('[data-identity-share]'));
  assert.deepEqual(page.toast(), { text: 'Erreur', bad: true }, 'refus sans raison : message générique');
});

function queueWorld() {
  const now = Date.now();
  const world = baseWorld();
  world.queue = [
    { source: 'karafun', ours: true, queueId: 'kf-1', pos: 1, singer: 'Alice', table: 'Table 1', ids: ['alice'],
      title: 'Titre KaraFun', artist: 'Artiste', eta: now, waitingPresence: true },
    { source: 'karafun', ours: true, queueId: 'kf-2', pos: 2, singer: 'Dora', table: 'En solo', ids: ['dora'],
      title: 'Prochain', eta: now + 240000, guaranteed: true },
    { source: 'envoi', pos: 3, singer: 'Bruno', title: 'En route' },
    { source: 'helper', id: 'bruno', pos: 4, name: 'Bruno', table: 'Table 1', ids: ['bruno'],
      song: { title: 'Chanson A', artist: 'Groupe', entryId: 'e1' }, isNew: true, eta: now + 480000 },
    { source: 'helper', id: 'duo1', pos: 5, name: 'Alice & Dora', table: 'Table 1', ids: ['alice', 'dora'], kind: 'duo',
      presenceSkips: 2, repeat: { playedAt: now - 1800000 }, song: { title: 'Duo', artist: 'Deux', entryId: 'e2' }, eta: now + 720000 },
    { source: 'helper', id: 'chloe', pos: 6, name: 'Chloé', table: 'Table 2', ids: ['chloe'], waitingPresence: true,
      repeat: { earlier: [4], later: [9] }, song: { title: 'Chanson A', artist: 'Groupe' }, deferred: true, afterClosing: true },
    { source: 'helper', id: 'bruno', future: true, pos: 7, name: 'Bruno', ids: ['bruno'], afterClosing: true,
      song: { title: 'Plus tard', entryId: 'e3' }, repeat: { later: [8] } },
    { source: 'karafun', ours: false, pos: 8, singer: 'La salle', title: 'Manuel', eta: now + 1200000 },
  ];
  world.closing = { at: now + 3600000, passed: false, full: false, fitCount: 5, afterCount: 2 };
  return world;
}
const rows = page => page.all('qBody', '.queue-item');
const badges = row => texts(row.querySelectorAll('.queue-tags .badge'));

test('file du bar : statuts, badges, doublons, repères et séparateur de fermeture', async () => {
  const world = queueWorld();
  const closing = world.closing;
  const page = await openPage({ world });
  assert.equal(page.$('qn').textContent, '8');
  assert.equal(page.$('queueEmpty').hidden, true);
  const lines = rows(page);
  assert.equal(lines.length, 8);
  assert.deepEqual(badges(lines[0]), ['Dans KaraFun · Je suis là attendu']);
  assert.deepEqual(badges(lines[1]), ['Dans KaraFun', 'Prochain confirmé']);
  assert.deepEqual(badges(lines[2]), ['Envoi']);
  assert.deepEqual(badges(lines[3]), ['À venir', 'Premier passage']);
  assert.deepEqual(badges(lines[4]), ['À venir', 'Duo', 'Absent ×2']);
  assert.deepEqual(badges(lines[5]), ['Je suis là attendu', 'Pas prêt']);
  assert.deepEqual(badges(lines[6]), ['Titre suivant']);
  assert.deepEqual(badges(lines[7]), ['Ajouté dans KaraFun']);
  // Doublons : chanté récemment, déjà prévu plus haut, prévu plus bas.
  const repeat = line => line.querySelector('.badge.repeat');
  assert.equal(repeat(lines[3]), null);
  assert.equal(repeat(lines[4]).textContent, `⚠ Chanté ${hhmm(world.queue[4].repeat.playedAt)}`);
  assert.equal(repeat(lines[4]).title, `Titre en double : chanté à ${hhmm(world.queue[4].repeat.playedAt)}`);
  assert.equal(repeat(lines[5]).textContent, '⚠ Doublon n°4');
  assert.equal(repeat(lines[5]).title, 'Titre en double : déjà prévu en n°4 ; aussi prévu en n°9');
  assert.equal(repeat(lines[6]).textContent, '⚠ Aussi n°8');
  // Actions : priorité seulement à partir du deuxième titre prévu, rien pour un titre manuel.
  const actions = line => texts(line.querySelectorAll('.queue-actions button'));
  assert.deepEqual(actions(lines[0]), ['Retirer'], 'un titre de la file dans KaraFun se retire de KaraFun');
  assert.deepEqual(actions(lines[2]), []);
  assert.deepEqual(actions(lines[3]), ['Retirer'], 'le premier prévu n’a pas besoin de priorité');
  assert.deepEqual(actions(lines[4]), ['Priorité', 'Retirer']);
  assert.deepEqual(actions(lines[6]), [], 'un titre supplémentaire n’est pas encore déplaçable');
  assert.equal(lines[6].querySelector('.drag-handle').disabled, true);
  assert.equal(lines[7].querySelector('[data-pick]'), null, 'un titre ajouté à la main dans KaraFun ne se sélectionne pas');
  assert.equal(lines[2].querySelector('.eta').textContent, '—', 'heure inconnue');
  assert.equal(lines[0].querySelector('.eta').textContent, hhmm(world.queue[0].eta));
  assert.equal(lines[3].querySelector('.song-cell').title, 'Chanson A — Groupe');
  // Séparateur de fermeture : une seule fois, juste avant le premier titre d'après l'heure.
  const separators = page.all('qBody', '.queue-closing');
  assert.equal(separators.length, 1);
  assert.equal(separators[0].textContent,
    `— Fermeture à ${hhmm(world.closing.at)} : les titres ci-dessous ne passeront probablement pas —`);
  const order = page.$('qBody').children.filter(child => child instanceof El);
  assert.equal(order.indexOf(separators[0]) + 1, order.indexOf(lines[5]), 'le séparateur précède le premier titre trop tard');
  // Repère privé : seulement pour les chanteurs qui en ont un, préfixé par le prénom dans un duo.
  assert.equal(lines[0].querySelector('.note-pop').textContent, 't-shirt rouge');
  assert.equal(lines[4].querySelector('.note-pop').textContent, 'Alice : t-shirt rouge');
  assert.equal(lines[3].querySelector('.note-pop'), null);
  // Afficher le repère au toucher : reste ouvert au rafraîchissement, se ferme ailleurs.
  const toggle = lines[4].querySelector('[data-note-toggle]');
  await page.click(toggle);
  assert.ok(lines[4].querySelector('.person-cell').classList.contains('show-note'));
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  await page.poll();
  const reopened = rows(page)[4].querySelector('.person-cell');
  assert.ok(reopened.classList.contains('show-note'), 'le repère ouvert le reste au rafraîchissement');
  await page.click(rows(page)[0].querySelector('[data-note-toggle]'));
  assert.ok(!reopened.classList.contains('show-note'), 'un seul repère ouvert à la fois');
  assert.ok(rows(page)[0].querySelector('.person-cell').classList.contains('show-note'));
  await page.click(rows(page)[0].querySelector('[data-note-toggle]'));
  assert.ok(!rows(page)[0].querySelector('.person-cell').classList.contains('show-note'), 'second appui : refermé');
  await page.click(rows(page)[4].querySelector('[data-note-toggle]'));
  await page.click(page.$('queueHint'));
  assert.ok(!rows(page)[4].querySelector('.person-cell').classList.contains('show-note'), 'un appui ailleurs le referme');
  await page.poll();
  assert.ok(!rows(page)[4].querySelector('.person-cell').classList.contains('show-note'));

  // Fermeture : texte du bar selon la situation.
  assert.equal(page.$('closingPill').textContent, `Fermeture ${hhmm(world.closing.at)}`);
  assert.equal(page.$('closingPill').className, 'pill ok');
  assert.equal(page.$('closingText').textContent, `5 titres passeront avant ${hhmm(world.closing.at)}, 2 après : ils ne seront pas lancés (réordonne, ou décale l’heure). Il reste de la place : les clients peuvent encore ajouter des titres.`);
  const at = new Date(world.closing.at);
  assert.equal(page.$('closingTime').value, `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`);
  assert.equal(page.$('closingClear').disabled, false);
  await page.update({ closing: { ...closing, full: true, fitCount: 1, afterCount: 1 } });
  assert.equal(page.$('closingPill').className, 'pill bad');
  assert.equal(page.$('closingText').textContent, `1 titre passera avant ${hhmm(world.closing.at)}, 1 après : il ne sera pas lancé (réordonne, ou décale l’heure). Nouveaux ajouts refusés : décale l’heure pour accepter une dernière chanson.`);
  await page.update({ closing: { ...closing, passed: true, afterCount: 0 } });
  assert.equal(page.$('closingPill').textContent, 'Fermeture atteinte');
  assert.match(page.$('closingText').textContent, /passeront avant \d\d:\d\d\. Il reste/);
  page.$('closingTime').focus();
  page.$('closingTime').value = '23:55';
  await page.update({ closing: null });
  assert.equal(page.$('closingTime').value, '23:55', 'l’heure en cours de saisie n’est pas écrasée');
  page.doc.activeElement = null;
  await page.poll();
  assert.equal(page.$('closingPill').textContent, 'Pas d’heure');
  assert.equal(page.$('closingText').textContent, 'Aucune heure annoncée : les clients ajoutent des titres librement.');
  assert.equal(page.$('closingTime').value, '');
  assert.equal(page.$('closingClear').disabled, true);
  assert.equal(page.all('qBody', '.queue-closing').length, 0, 'sans heure, pas de séparateur');
  await page.update({ queue: [] });
  assert.equal(page.$('queueEmpty').hidden, false);
  assert.equal(page.$('qn').textContent, '0');
});

test('file du bar : retirer, priorité, sélection multiple et retrait groupé', async () => {
  const page = await openPage({ world: queueWorld() });
  const line = index => rows(page)[index];
  page.confirmAnswer = false;
  await page.click(line(3).querySelector('[data-rm]'));
  await page.click(line(0).querySelector('[data-kfrm]'));
  assert.equal(page.posts.length, 0, 'retraits annulés : rien n’est envoyé');
  page.confirmAnswer = true;
  await page.click(line(3).querySelector('[data-rm]'));
  assert.deepEqual(page.lastPost('/api/staff/remove').body, { personId: 'bruno' });
  assert.equal(page.toast().text, 'Chanson retirée');
  await page.click(line(0).querySelector('[data-kfrm]'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'remove', queueId: 'kf-1' });
  assert.equal(page.toast().text, 'Chanson retirée de KaraFun');
  await page.click(line(4).querySelector('[data-urgent]'));
  assert.deepEqual(page.lastPost('/api/staff/move').body, { personId: 'duo1', toIndex: 0, priority: true });
  assert.equal(page.toast().text, 'Passage avancé au plus tôt après les titres déjà dans KaraFun');

  // Sélection d'une ligne, puis de toutes.
  assert.equal(page.$('removeSelected').disabled, true);
  await page.change(line(3).querySelector('[data-pick]'), true);
  assert.equal(page.$('removeSelected').disabled, false);
  assert.equal(page.$('removeSelected').textContent, 'Retirer la sélection (1)');
  assert.ok(line(3).classList.contains('picked'));
  assert.equal(line(3).querySelector('[data-pick]').checked, true, 'la case reste cochée après rafraîchissement');
  assert.equal(page.$('selectAllQueue').checked, false);
  await page.change(line(3).querySelector('[data-pick]'), false);
  assert.equal(page.$('removeSelected').disabled, true);
  assert.equal(page.$('removeSelected').textContent, 'Retirer la sélection');
  await page.change(page.$('selectAllQueue'), true);
  assert.equal(page.$('removeSelected').textContent, 'Retirer la sélection (6)', 'titres de la file et titres envoyés par la file');
  assert.equal(page.$('selectAllQueue').checked, true);
  page.confirmAnswer = false;
  await page.click(page.$('removeSelected'));
  assert.equal(page.postsTo('/api/staff/remove-many').length, 0);
  assert.match(page.confirms.at(-1), /Retirer les 6 titres sélectionnés/);
  page.confirmAnswer = true;
  await page.click(page.$('removeSelected'));
  assert.deepEqual(page.lastPost('/api/staff/remove-many').body, {
    items: [{ personId: 'bruno', entryId: 'e1' }, { personId: 'duo1', entryId: 'e2' }, { personId: 'chloe', entryId: null },
      { personId: 'bruno', entryId: 'e3' }],
    queueIds: ['kf-1', 'kf-2'] });
  assert.equal(page.$('removeSelected').disabled, true, 'sélection vidée après l’envoi');
  const count = page.posts.length;
  await page.click(page.$('removeSelected'));
  assert.equal(page.posts.length, count, 'sans sélection, le bouton ne fait rien');
  await page.change(page.$('selectAllQueue'), true);
  await page.change(page.$('selectAllQueue'), false);
  assert.equal(page.$('removeSelected').disabled, true, 'décocher « Tout » vide la sélection');
  // Une ligne sélectionnée qui disparaît de la file sort de la sélection.
  await page.change(line(4).querySelector('[data-pick]'), true);
  page.world.queue = page.world.queue.filter(q => q.id !== 'duo1');
  await page.poll();
  assert.equal(page.$('removeSelected').disabled, true);
});

test('file du bar : déplacer une ligne au toucher, par glisser-déposer et au doigt', async () => {
  const page = await openPage({ world: queueWorld() });
  const row = id => page.in('qBody', `[data-drag-id="${id}"]`);
  assert.deepEqual(page.all('qBody', '[data-drag-id]').map(r => [r.dataset.dragId, r.dataset.visibleIndex]),
    [['bruno', '0'], ['duo1', '1'], ['chloe', '2']], 'seuls les titres prévus sont déplaçables');
  // Poignée puis destination.
  await page.click(page.in('qBody', '[data-handle="bruno"]'));
  assert.match(page.$('queueHint').textContent, /^Choisis maintenant la ligne/);
  assert.ok(row('bruno').classList.contains('move-selected'));
  await page.click(page.in('qBody', '[data-handle="bruno"]'));
  assert.match(page.$('queueHint').textContent, /^Glisse une ligne prévue/, 'retoucher la poignée annule');
  await page.click(page.in('qBody', '[data-handle="bruno"]'));
  await page.click(row('bruno'));
  assert.equal(page.postsTo('/api/staff/move').length, 0, 'toucher la même ligne annule sans envoi');
  assert.match(page.$('queueHint').textContent, /^Glisse/);
  await page.click(row('chloe'));
  assert.equal(page.postsTo('/api/staff/move').length, 0, 'sans poignée choisie, toucher une ligne ne déplace rien');
  await page.click(page.in('qBody', '[data-handle="bruno"]'));
  await page.click(row('chloe'));
  assert.deepEqual(page.lastPost('/api/staff/move').body, { personId: 'bruno', toIndex: 2 });
  assert.equal(page.toast().text, 'File réordonnée');

  // Glisser-déposer à la souris.
  const transfer = { setData(type, value) { this.data = value; } };
  dispatch(page.in('qBody', '[data-handle="chloe"]'), 'dragstart', { dataTransfer: transfer });
  assert.equal(transfer.effectAllowed, 'move');
  assert.equal(transfer.data, 'chloe');
  assert.ok(row('chloe').classList.contains('dragging'));
  const over = dispatch(row('duo1'), 'dragover', { dataTransfer: transfer });
  assert.equal(over.defaultPrevented, true, 'la ligne accepte le dépôt');
  assert.equal(transfer.dropEffect, 'move');
  assert.ok(row('duo1').classList.contains('drag-target'));
  dispatch(row('duo1'), 'drop', { dataTransfer: transfer });
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/move').body, { personId: 'chloe', toIndex: 1 });
  // Lâché sur sa propre ligne, ou abandonné : rien n'est envoyé.
  const count = page.postsTo('/api/staff/move').length;
  dispatch(page.in('qBody', '[data-handle="duo1"]'), 'dragstart', { dataTransfer: transfer });
  dispatch(row('duo1'), 'drop', { dataTransfer: transfer });
  dispatch(page.in('qBody', '[data-handle="bruno"]'), 'dragstart', { dataTransfer: transfer });
  dispatch(row('chloe'), 'dragover', { dataTransfer: transfer });
  dispatch(page.in('qBody', '[data-handle="bruno"]'), 'dragend');
  assert.ok(!row('bruno').classList.contains('dragging'));
  assert.equal(page.all('qBody', '.drag-target').length, 0);
  dispatch(row('chloe'), 'dragover', { dataTransfer: transfer });
  dispatch(row('chloe'), 'drop', { dataTransfer: transfer });
  await page.flush();
  assert.equal(page.postsTo('/api/staff/move').length, count);

  // Au doigt : la ligne la plus proche du doigt reçoit le titre.
  page.all('qBody', '[data-drag-id]').forEach((r, i) => { r.rect = { top: i * 50, height: 50 }; });
  const handle = page.in('qBody', '[data-handle="bruno"]');
  dispatch(handle, 'pointerdown', { pointerType: 'mouse', clientY: 0, pointerId: 1 });
  assert.equal(handle.capture, undefined, 'à la souris, le glisser-déposer natif suffit');
  dispatch(handle, 'pointerdown', { pointerType: 'touch', clientY: 25, pointerId: 3 });
  assert.equal(handle.capture, 3);
  dispatch(handle, 'pointermove', { clientY: 28 });
  assert.ok(!row('bruno').classList.contains('dragging'), 'un tremblement ne déplace rien');
  dispatch(handle, 'pointermove', { clientY: 130 });
  assert.ok(row('bruno').classList.contains('dragging'));
  assert.ok(row('chloe').classList.contains('drag-target'));
  // Pendant le geste, un rafraîchissement ne redessine pas la file.
  const before = page.$('qBody').innerHTML;
  page.world.queue[3].name = 'Bruno modifié';
  await page.poll();
  assert.equal(page.$('qBody').innerHTML, before);
  dispatch(handle, 'pointerup', { type: 'pointerup', clientY: 130 });
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/move').body, { personId: 'bruno', toIndex: 2 });
  // Le clic qui suit le geste n'arme pas un déplacement.
  dispatch(handle, 'click');
  assert.match(page.$('queueHint').textContent, /^Glisse/);
  // Geste interrompu : la file est rechargée, rien n'est envoyé.
  const moves = page.postsTo('/api/staff/move').length;
  const fetches = page.fetches.length;
  const second = page.in('qBody', '[data-handle="duo1"]');
  page.all('qBody', '[data-drag-id]').forEach((r, i) => { r.rect = { top: i * 50, height: 50 }; });
  dispatch(second, 'pointerdown', { pointerType: 'touch', clientY: 75, pointerId: 4 });
  dispatch(second, 'pointermove', { clientY: 10 });
  dispatch(second, 'pointercancel', { type: 'pointercancel' });
  await page.flush();
  assert.equal(page.postsTo('/api/staff/move').length, moves);
  assert.ok(page.fetches.length > fetches, 'la file est rechargée après un geste interrompu');
  // Appui sans mouvement : ni envoi ni rechargement.
  const third = page.in('qBody', '[data-handle="chloe"]');
  const quiet = page.fetches.length;
  dispatch(third, 'pointerdown', { pointerType: 'touch', clientY: 125, pointerId: 5 });
  dispatch(third, 'pointerup', { type: 'pointerup', clientY: 126 });
  await page.flush();
  assert.equal(page.fetches.length, quiet);
  assert.equal(page.postsTo('/api/staff/move').length, moves);
});

test('sur scène : derniers passages, repère, départ et vidage de l’historique', async () => {
  const world = baseWorld();
  const at = Date.now() - 600000;
  world.stageHistory = [
    { onStage: true, title: 'En cours', artist: 'Groupe', people: [
      { id: 'alice', name: 'Alice', table: 'Table 1', active: true, privateNote: 't-shirt rouge' }] },
    { onStage: false, at, title: 'Fini', people: [
      { id: 'chloe', name: 'Chloé', table: 'Table 2', active: false },
      { id: 'dora', name: 'Dora', table: 'En solo', active: true, photoUrl: '/photo/dora.jpg' }] },
  ];
  const history = world.stageHistory;
  const page = await openPage({ world });
  const items = page.all('stageHistory', '.stage-history-item');
  assert.equal(items.length, 2);
  assert.ok(items[0].classList.contains('on-stage'));
  assert.equal(items[0].querySelector('.stage-history-time').textContent, '🎤 En cours');
  assert.equal(items[1].querySelector('.stage-history-time').textContent, `${hhmm(at)}passé`);
  assert.match(items[0].textContent, /t-shirt rouge/);
  const person = id => page.in('stageHistory', `[data-history-person="${id}"]`);
  assert.match(person('chloe').textContent, /Table 2 · parti/);
  assert.equal(person('chloe').querySelector('[data-history-leave]'), null, 'une personne déjà partie ne se marque pas partie');
  assert.equal(person('dora').querySelector('img').src, '/photo/dora.jpg');
  assert.equal(page.$('clearStageHistory').disabled, false);

  page.promptAnswer = 'casquette';
  await page.click(person('alice').querySelector('[data-history-note]'));
  assert.deepEqual(page.prompts.at(-1), { message: 'Repère privé pour Alice (ex. t-shirt rouge)', value: 't-shirt rouge' });
  assert.deepEqual(page.lastPost('/api/staff/person/identify').body, { personId: 'alice', note: 'casquette', verified: true });
  page.promptAnswer = null;
  const count = page.posts.length;
  await page.click(person('alice').querySelector('[data-history-note]'));
  assert.equal(page.posts.length, count, 'repère annulé : rien n’est envoyé');
  page.confirmAnswer = false;
  await page.click(person('dora').querySelector('[data-history-leave]'));
  assert.equal(page.posts.length, count);
  assert.match(page.confirms.at(-1), /^Marquer Dora comme partie/);
  page.confirmAnswer = true;
  await page.click(person('dora').querySelector('[data-history-leave]'));
  assert.deepEqual(page.lastPost('/api/staff/person/leave').body, { personId: 'dora' });
  // Personne inconnue de la liste des chanteurs : message générique.
  page.world.stageHistory[1].people.push({ id: 'ancien', name: 'Ancien', table: 'Table 9', active: true });
  await page.poll();
  page.promptAnswer = 'barbe';
  await page.click(person('ancien').querySelector('[data-history-note]'));
  assert.deepEqual(page.prompts.at(-1), { message: 'Repère privé pour cette personne (ex. t-shirt rouge)', value: '' });
  assert.deepEqual(page.lastPost('/api/staff/person/identify').body, { personId: 'ancien', note: 'barbe', verified: false });
  const total = page.posts.length;
  await page.click(page.$('stageHistory'));
  assert.equal(page.posts.length, total, 'un clic hors d’une personne ne fait rien');

  // Un bouton du panneau a le focus : pas de rafraîchissement sous le doigt.
  person('alice').querySelector('[data-history-note]').focus();
  const html = page.$('stageHistory').innerHTML;
  await page.update({ stageHistory: [] });
  assert.equal(page.$('stageHistory').innerHTML, html);
  page.doc.activeElement = null;
  await page.poll();
  assert.equal(page.$('stageHistory').textContent, 'Aucun passage pour le moment.');
  assert.equal(page.$('clearStageHistory').disabled, true, 'rien à vider');
  await page.update({ stageHistory: [history[0]] });
  assert.equal(page.$('clearStageHistory').disabled, true, 'le passage en cours ne se vide pas');
  await page.update({ stageHistory: history });
  page.confirmAnswer = false;
  await page.click(page.$('clearStageHistory'));
  assert.equal(page.postsTo('/api/staff/stage-history/clear').length, 0);
  page.confirmAnswer = true;
  await page.click(page.$('clearStageHistory'));
  assert.deepEqual(page.lastPost('/api/staff/stage-history/clear').body, {});
  assert.equal(page.toast().text, 'Derniers passages effacés');
});

test('en direct : duo noté, absent, relance, passer, lecture et envoi en cours', async () => {
  const world = baseWorld();
  world.stage = { ours: true, ids: ['alice'], queueId: 'q-live', kind: 'duo',
    singers: [{ name: 'Alice', table: 'Table 1' }, { name: 'Dora', individual: true }], song: { title: 'Ensemble' } };
  world.next = { ours: false, singer: 'Client', title: 'Manuel' };
  world.tracked = [{ queueId: 77, startedAt: Date.now() }, { queueId: 78, ids: ['bruno'], startedAt: null }];
  world.pending = { label: 'Bruno', title: 'Chanson A' };
  const page = await openPage({ world });
  assert.match(page.$('stage').textContent, /Alice.*Table 1.*Dora.*En solo.*Duo.*Ensemble.*Interprète inconnu/s);
  assert.match(page.$('next').textContent, /Client.*Ajouté dans KaraFun.*Manuel/s);
  assert.equal(page.$('pendingTxt').textContent, 'Envoi en cours à KaraFun : Bruno — Chanson A');

  // Duo improvisé : partenaire de la même table d'abord, personnes parties exclues.
  assert.equal(page.$('markDuoBox').hidden, false);
  assert.equal(page.$('markDuoBox').dataset.queueId, 'q-live');
  assert.deepEqual(page.all('markDuoPartner', 'optgroup').map(g => g.getAttribute('label')),
    ['Même table', 'Autres tables et personnes en solo']);
  assert.deepEqual(texts(page.$('markDuoPartner').options), ['Bruno — Table 1', 'Dora — En solo']);
  page.confirmAnswer = false;
  await page.click(page.$('markDuoBtn'));
  assert.equal(page.postsTo('/api/staff/duo-mark').length, 0);
  page.confirmAnswer = true;
  page.$('markDuoPartner').value = 'dora';
  await page.click(page.$('markDuoBtn'));
  assert.deepEqual(page.lastPost('/api/staff/duo-mark').body, { queueId: 'q-live', partnerId: 'dora' });
  assert.equal(page.toast().text, 'Duo comptabilisé');
  await page.update({ stage: { ...world.stage, ids: ['alice', 'dora'] } });
  assert.equal(page.$('markDuoBox').hidden, true, 'un duo déjà formé ne propose pas de second chanteur');
  await page.update({ stage: { ours: true, ids: ['bruno'], queueId: 'q2', title: 'Seul' }, people: [baseWorld().people[1]] });
  assert.equal(page.$('markDuoBox').hidden, true, 'personne d’autre : rien à noter');
  // Garde-fou : bouton atteint malgré tout (clavier, ancien affichage) sans titre ni partenaire.
  page.$('markDuoBox').dataset.queueId = '';
  page.$('markDuoPartner').innerHTML = '';
  const marks = page.postsTo('/api/staff/duo-mark').length;
  await page.click(page.$('markDuoBtn'));
  assert.equal(page.postsTo('/api/staff/duo-mark').length, marks, 'sans titre ni partenaire, rien n’est envoyé');
  page.world.people = baseWorld().people;

  // Absent : retire le prochain titre KaraFun pas encore commencé.
  assert.equal(page.$('absentBtn').hidden, false);
  assert.equal(page.$('absentBtn').dataset.qid, '78');
  await page.click(page.$('absentBtn'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'absent', queueId: 78 });
  assert.equal(page.toast().text, 'Retirée : la personne reprend la 4e place');
  page.$('absentBtn').dataset.qid = '999';
  const kf = page.postsTo('/api/staff/kf').length;
  await page.click(page.$('absentBtn'));
  assert.equal(page.postsTo('/api/staff/kf').length, kf, 'titre déjà parti : rien n’est envoyé');
  await page.update({ tracked: [{ queueId: 77, startedAt: Date.now() }] });
  assert.equal(page.$('absentBtn').hidden, true);

  // Relance, passer, lecture.
  assert.equal(page.$('restartBtn').disabled, false);
  page.confirmAnswer = false;
  await page.click(page.$('restartBtn'));
  await page.click(page.$('skipBtn'));
  assert.equal(page.postsTo('/api/staff/kf').length, kf, 'relance et passage annulés');
  page.confirmAnswer = true;
  await page.click(page.$('restartBtn'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'restart' });
  assert.equal(page.toast().text, 'Relance demandée à KaraFun');
  await page.click(page.$('skipBtn'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'next' });
  await page.click(page.$('playBtn'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'play' });
  await page.update({ restartRetryAt: Date.now() + 60000 });
  assert.equal(page.$('restartBtn').disabled, true);
  assert.equal(page.$('restartBtn').textContent, '⏮ Relance possible dans une minute');
  await page.update({ restartRetryAt: null, restarting: true });
  assert.equal(page.$('restartBtn').textContent, '⏮ Relance en cours…');
  await page.update({ restarting: false, stage: null, pending: null });
  assert.equal(page.$('restartBtn').disabled, true, 'rien sur scène : rien à relancer');
  assert.equal(page.$('stage').textContent, 'rien');
  assert.equal(page.$('pendingTxt').textContent, '');
});

test('fermeture du bar : annoncer, décaler et retirer l’heure', async () => {
  const page = await openPage();
  page.$('closingTime').value = '';
  await page.click(page.$('closingSave'));
  assert.deepEqual(page.toast(), { text: 'Choisis l’heure de fermeture.', bad: true });
  assert.equal(page.postsTo('/api/staff/closing').length, 0, 'sans heure, rien n’est envoyé');
  page.$('closingTime').value = '23:30';
  await page.click(page.$('closingSave'));
  assert.deepEqual(page.lastPost('/api/staff/closing').body, { time: '23:30' });
  assert.equal(page.toast().text, 'Heure de fermeture annoncée aux clients');
  const extend = page.doc.body.querySelector('[data-closing-extend="15"]');
  await page.click(extend);
  assert.deepEqual(page.lastPost('/api/staff/closing').body, { extendMin: 15 });
  assert.equal(page.toast().text, 'Fermeture décalée');
  assert.equal(page.$('closingClear').disabled, true, 'sans heure annoncée, rien à retirer');
  await page.update({ closing: { at: Date.now() + 3600000, passed: false, full: false, fitCount: 3, afterCount: 0 } });
  await page.click(page.$('closingClear'));
  assert.deepEqual(page.lastPost('/api/staff/closing').body, { clear: true });
  assert.equal(page.toast().text, 'Heure de fermeture retirée');
  page.replies['/api/staff/closing'] = { status: 400, error: 'Heure de fermeture invalide.' };
  page.$('closingTime').value = '23:30';
  await page.click(page.$('closingSave'));
  assert.deepEqual(page.toast(), { text: 'Heure de fermeture invalide.', bad: true }, 'le refus du serveur est affiché');
  page.replies['/api/staff/closing'] = { ok: true, message: 'Fermeture à 23:30 ; 4 titres passeront.' };
  page.$('closingTime').value = '23:30';
  await page.click(page.$('closingSave'));
  assert.equal(page.toast().text, 'Fermeture à 23:30 ; 4 titres passeront.', 'le message du serveur prime');
});

test('arrêt de la soirée, suppression des tables et vidage de la file', async () => {
  const page = await openPage();
  page.confirmAnswer = false;
  await page.click(page.$('shutdownBtn'));
  assert.equal(page.postsTo('/api/staff/shutdown').length, 0, 'arrêt annulé : rien n’est envoyé');
  assert.match(page.confirms.at(-1), /^Arrêter la soirée \?/);
  page.confirmAnswer = true;
  await page.click(page.$('shutdownBtn'));
  assert.deepEqual(page.lastPost('/api/staff/shutdown').body, {});
  assert.equal(page.lastPost('/api/staff/shutdown').url, `/api/staff/shutdown?key=${KEY}`);
  assert.deepEqual(page.toast(), { text: 'La soirée est arrêtée. Tu peux fermer cette page.', bad: false });
  page.replies['/api/staff/shutdown'] = { status: 403, error: 'Accès réservé aux gérants.' };
  await page.click(page.$('shutdownBtn'));
  assert.deepEqual(page.toast(), { text: 'Accès réservé aux gérants.', bad: true });

  // Suppression des tables.
  page.confirmAnswer = false;
  await page.click(page.$('clearTables'));
  assert.match(page.confirms.at(-1), /^Supprimer les 3 tables/);
  assert.equal(page.postsTo('/api/staff/tables-clear').length, 0);
  page.confirmAnswer = true;
  const loads = () => page.fetches.filter(f => f.url.startsWith('/api/staff/state')).length;
  let before = loads();
  await page.click(page.$('clearTables'));
  assert.deepEqual(page.lastPost('/api/staff/tables-clear').body, { confirmation: 'SUPPRIMER TOUTES LES TABLES' });
  assert.equal(page.toast().text, 'Toutes les tables sont effacées.');
  assert.ok(loads() > before, 'la page est rechargée après la suppression');
  for (const leftover of [{ currentStillPlaying: true }, { otherKaraFunSongs: 2 }, { removalErrors: 1 }, { removalPending: 1 }]) {
    page.replies['/api/staff/tables-clear'] = leftover;
    await page.click(page.$('clearTables'));
    assert.equal(page.toast().text, 'Tables effacées. Vérifie et vide les titres restants dans KaraFun.', JSON.stringify(leftover));
  }
  page.replies['/api/staff/tables-clear'] = { status: 409, error: 'Envoi en cours, réessaie.' };
  await page.click(page.$('clearTables'));
  assert.deepEqual(page.toast(), { text: 'Envoi en cours, réessaie.', bad: true });
  const count = page.postsTo('/api/staff/tables-clear').length;
  await page.update({ tables: [] });
  await page.click(page.$('clearTables'));
  assert.deepEqual(page.toast(), { text: 'Aucune table à supprimer.', bad: false });
  assert.equal(page.postsTo('/api/staff/tables-clear').length, count);
  page.world.tables = baseWorld().tables;

  // Vidage de la file.
  page.confirmAnswer = false;
  await page.click(page.$('clearQueue'));
  assert.equal(page.postsTo('/api/staff/queue-clear').length, 0);
  page.confirmAnswer = true;
  before = loads();
  await page.click(page.$('clearQueue'));
  assert.deepEqual(page.lastPost('/api/staff/queue-clear').body, { confirmation: 'VIDER TOUTES LES CHANSONS' });
  assert.equal(page.toast().text, 'File vidée ; tables et chanteurs conservés.');
  assert.ok(loads() > before);
  page.replies['/api/staff/queue-clear'] = { awaitingKaraFun: true };
  await page.click(page.$('clearQueue'));
  assert.equal(page.toast().text, 'Retraits demandés. Vérifie que la file de KaraFun se vide avant de reprendre.');
  page.replies['/api/staff/queue-clear'] = { status: 500, error: 'KaraFun ne répond pas.' };
  await page.click(page.$('clearQueue'));
  assert.deepEqual(page.toast(), { text: 'KaraFun ne répond pas.', bad: true });

  // Envoi interrompu à vérifier.
  assert.equal(page.$('recoveryBox').hidden, true);
  await page.update({ recoveredPending: true });
  assert.equal(page.$('recoveryBox').hidden, false);
  await page.click(page.$('reconcilePending'));
  assert.deepEqual(page.lastPost('/api/staff/reconcile-pending').body, {});
  assert.equal(page.toast().text, 'File KaraFun vérifiée ; envoi repris');
});

test('changements manuels : annuler le dernier ou tous', async () => {
  const page = await openPage();
  const recalcs = () => page.postsTo('/api/staff/queue-recalculate').length;
  await page.click(page.$('recalculateQueue'));
  assert.equal(recalcs(), 0);
  assert.equal(page.confirms.length, 0, 'sans changement manuel, aucune question');
  await page.update({ manualChanges: [
    { id: 'second', kind: 'priority', name: 'Marine', from: 4, to: 1, at: Date.now(), canUndo: true },
    { id: 'first', kind: 'move', name: 'JP', from: 5, to: 2, at: Date.now(), canUndo: false }] });
  assert.match(page.$('manualHistoryList').textContent, /Annule d’abord le changement plus récent/);
  await page.click(page.in('manualHistoryList', '[data-manual-undo="second"]'));
  assert.deepEqual(page.lastPost('/api/staff/manual-change-undo').body, { id: 'second' });
  assert.equal(page.toast().text, 'Dernier changement annulé ; ordre précédent retrouvé');
  page.confirmAnswer = false;
  await page.click(page.$('recalculateQueue'));
  assert.equal(page.confirms.at(-1), 'Annuler les 2 changements manuels et retrouver l’ordre d’avant ces interventions ?');
  assert.equal(recalcs(), 0);
  page.confirmAnswer = true;
  await page.click(page.$('recalculateQueue'));
  assert.deepEqual(page.lastPost('/api/staff/queue-recalculate').body, {});
  assert.equal(page.toast().text, 'Tous les changements manuels ont été annulés');
  await page.update({ manualChanges: [{ id: 'seul', kind: 'move', name: 'JP', from: 5, to: 2, at: Date.now(), canUndo: false }] });
  assert.match(page.$('manualHistoryList').textContent, /La file a changé depuis : annulation indisponible/);
  assert.equal(page.$('recalculateQueue').disabled, true, 'historique dépassé : annulation globale impossible');
  const asked = page.confirms.length;
  await page.click(page.$('recalculateQueue'));
  assert.equal(page.confirms.length, asked);
  await page.update({ manualChanges: [{ id: 'seul', kind: 'move', name: 'JP', from: 5, to: 2, at: Date.now(), canUndo: true }] });
  page.confirmAnswer = false;
  await page.click(page.$('recalculateQueue'));
  assert.match(page.confirms.at(-1), /1 changement manuel et retrouver l’ordre/, 'singulier pour un seul changement');
  assert.equal(recalcs(), 1);
});

test('tables : création, renommage, effectif, bonus, départ et QR individuel', async () => {
  const page = await openPage();
  const card = id => page.in('tBody', `[data-table-name="${id}"]`).closest('.table-card');
  assert.equal(page.$('tableName').placeholder, 'Table 3', 'prochain numéro libre proposé');
  assert.equal(card('1').querySelector('.occupancy').textContent, '2 actifs / 2 inscrits / 4 places');
  assert.equal(card('2').querySelector('.occupancy').textContent, '1 actif / 1 inscrit / 2 places');
  assert.equal(card('Comptoir').querySelector('.occupancy').textContent, '1 soliste');
  assert.equal(card('Comptoir').querySelector('[data-left]'), null, '« En solo » ne part jamais');
  assert.equal(card('Comptoir').querySelector('[data-hc]'), null, '« En solo » n’a pas d’effectif');

  // Création : numéro libre par défaut, validations locales.
  page.$('tableHeadcount').value = '4';
  await page.click(page.$('createTable'));
  assert.deepEqual(page.lastPost('/api/staff/table').body, { id: '3', headcount: 4 });
  assert.equal(page.toast().text, 'Table ajoutée');
  for (const [name, headcount, message] of [['1', '4', 'Cette table existe déjà.'], ['x'.repeat(21), '4', 'Le nom de table est trop long.'],
    ['Terrasse', '0', 'Indique entre 1 et 40 personnes.'], ['Terrasse', '41', 'Indique entre 1 et 40 personnes.'],
    ['Terrasse', '2.5', 'Indique entre 1 et 40 personnes.']]) {
    const count = page.posts.length;
    page.$('tableName').value = name; page.$('tableHeadcount').value = headcount;
    await page.click(page.$('createTable'));
    assert.deepEqual(page.toast(), { text: message, bad: true }, `${name} / ${headcount}`);
    assert.equal(page.posts.length, count);
  }
  page.$('tableName').value = ' Terrasse '; page.$('tableHeadcount').value = '6';
  await page.click(page.$('createTable'));
  assert.deepEqual(page.lastPost('/api/staff/table').body, { id: 'Terrasse', headcount: 6 });
  assert.equal(page.$('tableName').value, '', 'le champ est vidé après l’ajout');
  page.$('tableName').focus();
  await page.update({ tables: [...page.world.tables, { id: '3', name: 'Table 3', headcount: 4, activeCount: 0, count: 0 }] });
  assert.equal(page.$('tableName').placeholder, 'Table 3', 'pendant la saisie, la suggestion ne bouge pas');
  page.doc.activeElement = null;
  await page.poll();
  assert.equal(page.$('tableName').placeholder, 'Table 4');
  page.world.tables = Array.from({ length: 60 }, (_, i) => ({ id: String(i + 1), name: `Table ${i + 1}`, headcount: 2, activeCount: 0, count: 0 }));
  await page.poll();
  page.$('tableName').value = '';
  page.$('tableHeadcount').value = '4';
  await page.click(page.$('createTable'));
  assert.deepEqual(page.toast(), { text: 'La limite de 60 tables est atteinte.', bad: true });
  page.world.tables = baseWorld().tables;
  await page.poll();

  // Renommer : bouton ou Entrée, nom vide refusé.
  card('1').querySelector('[data-table-name]').value = '  Terrasse  ';
  await page.click(card('1').querySelector('[data-rename]'));
  assert.deepEqual(page.lastPost('/api/staff/table/rename').body, { tableId: '1', name: 'Terrasse' });
  assert.equal(page.toast().text, 'Table renommée');
  card('2').querySelector('[data-table-name]').value = 'Bar';
  const keyResult = await page.key(card('2').querySelector('[data-table-name]'), 'Enter');
  assert.equal(keyResult.defaultPrevented, true);
  assert.deepEqual(page.lastPost('/api/staff/table/rename').body, { tableId: '2', name: 'Bar' });
  const renames = page.postsTo('/api/staff/table/rename').length;
  await page.key(card('2').querySelector('[data-table-name]'), 'a');
  card('2').querySelector('[data-table-name]').value = '   ';
  await page.click(card('2').querySelector('[data-rename]'));
  assert.deepEqual(page.toast(), { text: 'Indique un nom de table entre 1 et 40 caractères.', bad: true });
  assert.equal(page.postsTo('/api/staff/table/rename').length, renames);

  // Effectif.
  card('2').querySelector('[data-hc]').value = '6';
  await page.click(card('2').querySelector('[data-hcok]'));
  assert.deepEqual(page.lastPost('/api/staff/table').body, { id: '2', headcount: 6 });
  assert.equal(page.toast().text, 'Enregistré');
  card('2').querySelector('[data-hc]').value = '41';
  await page.click(card('2').querySelector('[data-hcok]'));
  assert.deepEqual(page.toast(), { text: 'Indique entre 1 et 40 personnes.', bad: true });

  // Bonus de table.
  await page.change(card('2').querySelector('[data-table-bonus]'), '-1');
  assert.deepEqual(page.lastPost('/api/staff/bonus').body, { tableId: '2', level: -1 });
  assert.equal(page.toast().text, 'Bonus de table enregistré (invisible des clients)');
  await page.change(card('2').querySelector('[data-table-bonus]'), '0');
  assert.equal(page.toast().text, 'Bonus de table retiré');

  // Table partie.
  page.confirmAnswer = false;
  await page.click(card('2').querySelector('[data-left]'));
  assert.equal(page.confirms.at(-1), 'Table 2 est partie ? Ses tickets seront retirés.');
  assert.equal(page.postsTo('/api/staff/table-left').length, 0);
  page.confirmAnswer = true;
  await page.click(card('2').querySelector('[data-left]'));
  assert.deepEqual(page.lastPost('/api/staff/table-left').body, { id: '2' });
  assert.equal(page.toast().text, 'Table retirée');

  // Champ d'une carte en cours de saisie : les cartes ne sont pas redessinées.
  const input = card('1').querySelector('[data-hc]');
  input.focus();
  input.value = '9';
  await page.poll();
  assert.equal(card('1').querySelector('[data-hc]'), input, 'la saisie de l’effectif n’est pas perdue');
  page.doc.activeElement = null;
});

test('accueil en solo : QR individuel, copie, invitations en attente et erreurs', async () => {
  const expiresAt = Date.now() + 30 * 60000;
  const world = baseWorld();
  world.soloInvitations = [{ id: 'one', tableId: 'Comptoir', expiresAt }, { id: 'two', tableId: 'Comptoir', expiresAt },
    { id: 'autre', tableId: '1', expiresAt }];
  const page = await openPage({ world });
  assert.equal(page.$('issueSoloInvitation').disabled, false);
  assert.equal(page.$('soloInvitationStatus').textContent, '1 soliste présent · 2 invitations en attente');
  assert.deepEqual(texts(page.all('soloInvitationList', 'span')),
    [`QR 1 valable jusqu’à ${hhmm(expiresAt)} Annuler`, `QR 2 valable jusqu’à ${hhmm(expiresAt)} Annuler`]);
  page.confirmAnswer = false;
  await page.click(page.in('soloInvitationList', '[data-solo-revoke="two"]'));
  assert.equal(page.postsTo('/api/staff/solo-invite/revoke').length, 0);
  page.confirmAnswer = true;
  await page.click(page.in('soloInvitationList', '[data-solo-revoke="two"]'));
  assert.deepEqual(page.lastPost('/api/staff/solo-invite/revoke').body, { id: 'two' });
  assert.equal(page.toast().text, 'Invitation annulée');

  // Le bouton de la carte « En solo » ouvre le même QR individuel.
  page.replies['/api/staff/solo-invite'] = { id: 'three', url: 'https://bar.example/t/Comptoir/s?invitation=fausse',
    qr: 'data:image/png;base64,abc', expiresAt };
  await page.click(page.in('tBody', '[data-solo-invite]'));
  assert.deepEqual(page.lastPost('/api/staff/solo-invite').body, { tableId: 'Comptoir' });
  assert.equal(page.$('soloInviteDialog').open, true);
  assert.equal(page.$('soloInviteQr').src, 'data:image/png;base64,abc');
  assert.equal(page.$('soloInviteUrl').value, 'https://bar.example/t/Comptoir/s?invitation=fausse');
  assert.equal(page.$('soloInviteExpires').textContent, `Valable jusqu’à ${hhmm(expiresAt)} ; une seule inscription.`);
  await page.click(page.$('soloInviteCopy'));
  assert.deepEqual(page.clipboard, ['https://bar.example/t/Comptoir/s?invitation=fausse']);
  assert.equal(page.toast().text, 'Lien individuel copié');
  page.clipboardWorks = false;
  await page.click(page.$('soloInviteCopy'));
  assert.equal(page.$('soloInviteUrl').selectedAll, true);
  assert.deepEqual(page.toast(), { text: 'Sélectionne le lien pour le copier.', bad: true });
  await page.click(page.$('soloInviteClose'));
  assert.equal(page.$('soloInviteDialog').open, false);
  page.replies['/api/staff/solo-invite'] = { status: 409, error: 'Trop d’invitations en attente.' };
  await page.click(page.$('issueSoloInvitation'));
  assert.deepEqual(page.toast(), { text: 'Trop d’invitations en attente.', bad: true });
  assert.equal(page.$('soloInviteDialog').open, false, 'pas de QR affiché après un refus');

  await page.update({ tables: baseWorld().tables.filter(t => !t.individual), soloInvitations: [] });
  assert.equal(page.$('issueSoloInvitation').disabled, true);
  assert.equal(page.$('soloInvitationStatus').textContent, 'Le groupe « En solo » est indisponible.');
  assert.equal(page.$('soloInvitationList').innerHTML, '');
});

test('optimisation de la file : état affiché et recalcul', async () => {
  const page = await openPage();
  const pill = () => page.$('solverPill');
  const text = () => page.$('solverText').textContent;
  const diag = () => page.$('diag').textContent;
  assert.equal(pill().textContent, 'Ordre calculé localement');
  assert.equal(text(), 'Optimisation approfondie non utilisée dans ce mode.');
  assert.match(diag(), /OrdonnancementSimulation locale/);
  await page.update({ solver: { configured: true, available: false, fallbackLastError: 'Java absent.' } });
  assert.equal(pill().textContent, 'Optimisation indisponible');
  assert.equal(pill().className, 'pill warn');
  assert.equal(text(), 'Ordre calculé localement, mêmes règles. Java absent.');
  assert.match(diag(), /Rotation locale de secours : Java absent\./);
  await page.update({ solver: { configured: true, available: false } });
  assert.match(diag(), /Rotation locale de secours : solveur indisponible/);
  await page.update({ solver: { configured: true, available: true, pending: true, forced: true,
    pendingSince: Date.now() - 12000, budgetMs: 30000 } });
  assert.match(pill().textContent, /^⏳ Calcul de la file en cours \(1[23] s \/ 30 s\)$/);
  assert.equal(text(), 'La file affichée est déjà utilisable ; le calcul cherche un meilleur ordre.');
  assert.equal(page.$('optimizeQueue').disabled, true, 'un recalcul demandé est déjà en cours');
  assert.match(diag(), /Optimisation : calcul en cours/);
  await page.update({ solver: { configured: true, available: true, pending: true, pendingSince: Date.now() } });
  assert.equal(pill().textContent, '⏳ Calcul de la file en cours', 'calcul tout juste lancé : pas de durée');
  assert.equal(page.$('optimizeQueue').disabled, false, 'calcul automatique : le bar peut quand même forcer');
  await page.update({ solver: { configured: true, available: true, refining: true, refineSince: Date.now() - 5000 } });
  assert.match(pill().textContent, /^🔄 Optimisation continue \([56] s\)$/);
  assert.equal(pill().className, 'pill ok');
  assert.equal(text(), 'La file ne change pas : la recherche continue et n’affiche un nouvel ordre que s’il est meilleur.');
  assert.match(diag(), /Optimisation continue en cours/);
  const at = Date.now() - 60000;
  await page.update({ solver: { configured: true, available: true, plan: 'timefold', lastRun: { at, improved: true },
    refineImprovements: 2, nextRefineAt: Date.now() + 20000 } });
  assert.equal(pill().textContent, 'Ordre optimisé');
  assert.match(text(), new RegExp(`^Dernier calcul à ${hhmm(at)} : meilleur ordre trouvé\\. 2 améliorations depuis le dernier changement de la file\\. Prochaine recherche dans (19|20) s\\.$`));
  assert.match(diag(), /Optimisation prête/);
  await page.update({ solver: { configured: true, available: true, plan: 'manual', lastRun: { at, improved: false }, refineImprovements: 1 } });
  assert.equal(pill().textContent, 'Ordre modifié par le bar');
  assert.equal(text(), `Dernier calcul à ${hhmm(at)} : rien de mieux. 1 amélioration depuis le dernier changement de la file. Ordre du bar conservé ; « Recalculer la file » le remplace.`);
  // Recalcul : confirmation seulement si des choix du bar seraient perdus.
  page.confirmAnswer = false;
  await page.click(page.$('optimizeQueue'));
  assert.equal(page.postsTo('/api/staff/queue-optimize').length, 0);
  assert.match(page.confirms.at(-1), /^Recalculer toute la file \?/);
  page.confirmAnswer = true;
  await page.click(page.$('optimizeQueue'));
  assert.deepEqual(page.lastPost('/api/staff/queue-optimize').body, {});
  await page.update({ solver: { configured: true, available: true, plan: 'mystere' } });
  assert.equal(pill().textContent, 'Ordre calculé localement');
  assert.equal(text(), '');
  const asked = page.confirms.length;
  await page.click(page.$('optimizeQueue'));
  assert.equal(page.confirms.length, asked, 'sans choix manuel, pas de question');
  assert.equal(page.postsTo('/api/staff/queue-optimize').length, 2);
});

test('Battle : vote en direct, clôture, demande, refus et étapes de l’ajout automatique', async () => {
  const page = await openPage({ storage: { 'bar-alerts': 'yes' } });
  const status = () => page.$('battleStatus').textContent;
  const pill = () => page.$('battlePill');
  await page.update({ battle: { id: 1, phase: 'voting', closesAt: Date.now() + 90000, proposalName: 'Alice', voters: 6, eligible: 10,
    threshold: 5, yesVotes: 4, noVotes: 2, songOptions: [{ title: 'Africa', artist: 'Toto', votes: 3 }, { title: 'Hello', votes: 1 }] } });
  assert.equal(pill().textContent, 'Vote en cours');
  assert.equal(pill().className, 'pill ok');
  assert.equal(status(), 'La salle vote pour une Battle (proposition de Alice). Résultats en direct ci-dessous ; tu peux clore le vote avant la fin.');
  assert.equal(page.$('battleVotes').hidden, false);
  const bars = page.all('battleVotes', '.vote-bar');
  assert.deepEqual(bars.map(bar => [bar.querySelector('span').textContent, bar.querySelector('b').textContent, bar.querySelector('i').attrs.style]),
    [['Africa — Toto', '3', 'width:100%'], ['Hello', '1', 'width:33%'], ['Pas de Battle', '2', 'width:67%']]);
  assert.match(page.in('battleVotes', 'p').textContent,
    /^6 votants sur 10 inscrits \(minimum 5\) · 4 pour une Battle, 2 contre · fin dans 1 min (29|30) s$/);
  assert.equal(page.$('battleVoteActions').hidden, false);
  page.confirmAnswer = false;
  await page.click(page.$('battleCloseVote'));
  assert.equal(page.postsTo('/api/staff/battle/close').length, 0, 'clôture annulée');
  page.confirmAnswer = true;
  await page.click(page.$('battleCloseVote'));
  assert.deepEqual(page.lastPost('/api/staff/battle/close').body, {});
  assert.equal(page.toast().text, 'Vote clos');
  assert.equal(page.rings, 0, 'un vote ne sonne pas');

  // Demande de Battle : titre de l'onglet, message, sonnerie et notification une seule fois.
  page.doc.hidden = true;
  await page.update({ battle: { id: 2, phase: 'requested', selectedSong: { title: 'Africa', artist: 'Toto' }, voters: 1, eligible: 1,
    threshold: 1, yesVotes: 1, songOptions: [{ title: 'Africa', votes: 1 }, { title: 'Hello', votes: 0 }] } });
  assert.equal(page.doc.title, '🎤 Battle demandée — File karaoké');
  assert.equal(page.toast().text, 'La salle demande une Battle : organise-la dans KaraFun.');
  assert.equal(page.rings, 1);
  assert.deepEqual(page.notifications, [{ title: 'Battle demandée par la salle',
    body: 'Ouvre la page du bar pour organiser la Battle dans KaraFun.', tag: 'battle-karaoke' }]);
  assert.equal(pill().textContent, 'À organiser');
  assert.equal(status(), 'Battle demandée : Africa — Toto. 1 votant sur 1 inscrit (minimum 1) · 1 pour une Battle, 0 contre. Prépare-la dans KaraFun et laisse les téléphones rejoindre.');
  assert.equal(page.$('battleVotes').hidden, false, 'plusieurs titres proposés : le décompte reste visible');
  assert.equal(page.$('battleActions').hidden, false);
  assert.match(page.$('staffAlerts').textContent, /La salle demande une Battle : une action du bar est nécessaire\./);
  await page.poll();
  assert.equal(page.rings, 1, 'la même demande ne resonne pas');
  assert.equal(page.notifications.length, 1);
  await page.click(page.$('battleDismiss'));
  assert.deepEqual(page.lastPost('/api/staff/battle/resolve').body, { outcome: 'dismissed' });
  // Notification refusée par le navigateur (Android) : la demande reste visible dans la page.
  const strict = await openPage({ storage: { 'bar-alerts': 'yes' }, notifyThrows: true });
  strict.doc.hidden = true;
  await strict.update({ battle: { id: 9, phase: 'requested', selectedSong: { title: 'Africa' } } });
  assert.equal(strict.rings, 1);
  assert.equal(strict.notifications.length, 0);
  assert.match(strict.$('staffAlerts').textContent, /La salle demande une Battle/);
  assert.equal(page.toast().text, 'Demande close ; pause entre votes démarrée');
  page.doc.hidden = false;

  // Étapes de l'ajout automatique.
  const song = { title: 'Africa', artist: 'Toto' };
  const step = async (status, extra = {}) => page.update({ battle: { id: 3, phase: 'requested', selectedSong: song, automation: { status }, ...extra } });
  await step('waiting');
  assert.equal(pill().textContent, 'En attente du passage promis');
  assert.match(status(), /^Battle demandée sur Africa — Toto\. Le prochain chanteur déjà annoncé garde sa place/);
  await step('sending');
  assert.equal(pill().textContent, 'Ajout en cours');
  assert.match(status(), /^Envoi de Africa — Toto à KaraFun\./);
  assert.equal(page.$('battleActions').hidden, true, 'pendant l’envoi, pas de décision du bar');
  page.world.queue = [{ source: 'karafun', ours: true, queueId: 'b1', pos: 1, kind: 'battle', title: 'Africa' }];
  await step('queued');
  assert.equal(pill().textContent, 'Prête dans KaraFun');
  assert.match(status(), /^Battle prête dans KaraFun : Africa — Toto\./);
  assert.equal(page.$('playBtn').textContent, '▶ Lancer la Battle');
  await step('playing');
  assert.equal(pill().textContent, 'En cours');
  assert.equal(status(), 'Battle en cours. Après les résultats, le titre suivant attendra ton clic.');
  assert.equal(page.$('playBtn').textContent, '▶ Lecture');
  await step('manual');
  assert.equal(pill().textContent, 'Battle manuelle au bar');
  assert.equal(page.$('battleFinished').hidden, false);
  await page.click(page.$('battleFinished'));
  assert.deepEqual(page.lastPost('/api/staff/battle/resolve').body, { outcome: 'finished' });
  assert.equal(page.toast().text, 'Battle terminée ; lance la prochaine chanson quand le bar est prêt');
  await step('failed');
  assert.equal(pill().textContent, 'À vérifier');
  assert.equal(pill().className, 'pill bad');
  assert.equal(status(), 'Ajout automatique non confirmé : Vérifie KaraFun. Organise la Battle manuellement ou ferme la demande.');
  assert.equal(page.$('battleDone').hidden, false);
  await page.click(page.$('battleDone'));
  assert.deepEqual(page.lastPost('/api/staff/battle/resolve').body, { outcome: 'done' });
  page.world.queue = [];
  await page.update({ battle: { id: 3, phase: 'cooldown', cooldownUntil: Date.now() + 125000, automation: { status: 'after' } } });
  assert.equal(pill().textContent, 'Pause après Battle');
  assert.match(status(), /^Battle terminée\. Félicite les gagnants.*Prochaine Battle possible dans 2 min 0[45] s\.$/);
  assert.equal(page.$('playBtn').textContent, '▶ Lancer le prochain titre');
  await page.update({ battle: { id: 3, phase: 'cooldown', automation: { status: 'after' } } });
  assert.match(status(), /« ▶ Lancer le prochain titre » dans le panneau En direct\.$/);
  await page.update({ battle: { id: 3, phase: 'cooldown', automation: { status: 'resuming' } } });
  assert.equal(pill().textContent, 'Reprise demandée');
  assert.match(status(), /^Reprise demandée par le bar\./);
  await page.update({ battle: { id: 3, phase: 'cooldown' } });
  assert.equal(pill().textContent, 'Pause entre votes');
  assert.equal(status(), 'La pause entre Battles démarrera à la fin de la Battle.');
  await page.update({ battle: { phase: 'idle', registered: 2, minVoters: 5 } });
  assert.equal(status(), 'Aucun vote en cours. Les clients pourront proposer une Battle à partir de 5 personnes inscrites (2 pour l’instant) ; tu peux en lancer une toi-même ci-dessous.');
  await page.update({ battle: { phase: 'idle', registered: 8, minVoters: 5 } });
  assert.equal(status(), 'Aucun vote en cours. Les clients peuvent proposer une Battle depuis leur table.');
  assert.equal(page.doc.title, 'File karaoké — page du bar');

  // Réglages Battle.
  page.$('battleCooldownMin').value = '20'; page.$('battleRejectedCooldownMin').value = '3';
  page.$('battleVoteMin').value = '2'; page.$('battleMinVoters').value = '4';
  await page.click(page.$('saveBattleCooldown'));
  assert.deepEqual(page.lastPost('/api/staff/settings').body,
    { battleCooldownMin: 20, battleRejectedCooldownMin: 3, battleVoteMin: 2, battleMinVoters: 4 });
  assert.equal(page.toast().text, 'Réglages Battle enregistrés');
});

test('Battle : lancement par le bar depuis la recherche de titres', async () => {
  const page = await openPage();
  const field = page.$('battleLaunchSearch');
  field.value = 'Queen';
  await page.key(field, 'Enter');
  const buttons = page.all('battleLaunchResults', '[data-battle-launch]');
  assert.deepEqual(texts(page.all('battleLaunchResults', 'b')), ['Bohemian Rhapsody', 'Dancing Queen']);
  page.confirmAnswer = false;
  await page.click(buttons[1]);
  assert.equal(page.postsTo('/api/staff/battle/launch').length, 0, 'lancement annulé');
  assert.equal(page.confirms.at(-1), 'Lancer une Battle sur « Dancing Queen » ? Elle sera ajoutée après le prochain passage annoncé.');
  page.confirmAnswer = true;
  await page.click(buttons[1]);
  assert.deepEqual(page.lastPost('/api/staff/battle/launch').body, { song: { songId: 7, title: 'Dancing Queen', artist: 'ABBA' } });
  assert.equal(page.toast().text, 'Battle programmée : elle passera après le prochain chanteur annoncé');
  assert.equal(page.$('battleLaunchResults').innerHTML, '', 'les résultats disparaissent une fois la Battle programmée');
  // À la frappe : recherche après une courte pause.
  await page.type(field, 'Abba');
  assert.equal(page.$('battleLaunchResults').textContent, '');
  assert.deepEqual(page.searches, ['Queen'], 'pas de recherche pendant la frappe');
  page.runTimers(300);
  await page.flush();
  assert.deepEqual(page.searches, ['Queen', 'Abba']);
  assert.equal(page.all('battleLaunchResults', '[data-battle-launch]').length, 2);
  field.value = 'Rien';
  await page.key(field, 'Enter');
  assert.equal(page.$('battleLaunchResults').textContent, 'Aucun résultat');
  field.value = 'Panne';
  await page.key(field, 'Enter');
  assert.equal(page.$('battleLaunchResults').textContent, 'Catalogue KaraFun indisponible.');
  // Le × de la recherche Battle vide le champ et les résultats.
  field.value = 'Queen';
  await page.key(field, 'Enter');
  await page.click(field.parentElement.querySelector('[data-clear-for="battleLaunchSearch"]'));
  assert.equal(field.value, '');
  assert.equal(page.$('battleLaunchResults').innerHTML, '');
  page.doc.activeElement = null;
});

test('alertes et notifications du bar : sonnerie, personnes parties, avis KaraFun, mémoire', async () => {
  const page = await openPage({ secure: true, permission: 'default' });
  assert.equal(page.$('enableStaffAlerts').textContent, 'Activer les notifications');
  await page.click(page.$('enableStaffAlerts'));
  assert.equal(page.stored.get('bar-alerts'), 'yes');
  assert.equal(page.rings, 1, 'activer fait entendre la sonnerie');
  assert.equal(page.permissionRequests, 1, 'le navigateur demande l’autorisation des notifications');
  assert.equal(page.$('enableStaffAlerts').textContent, 'Désactiver les notifications');
  await page.click(page.$('enableStaffAlerts'));
  assert.equal(page.stored.get('bar-alerts'), 'no');
  assert.equal(page.rings, 1);
  assert.equal(page.$('enableStaffAlerts').textContent, 'Activer les notifications');
  // Son bloqué par le navigateur : l'alerte reste à l'écran, sans erreur.
  const muted = await openPage({ audioThrows: true, secure: false });
  await muted.click(muted.$('enableStaffAlerts'));
  assert.equal(muted.$('enableStaffAlerts').textContent, 'Désactiver les notifications');
  assert.equal(muted.permissionRequests, 0, 'sans HTTPS, pas de demande de notification');

  // Personne peut-être partie.
  await page.update({ maybeGone: [{ id: 'bruno', name: 'Bruno', table: 'Table 1', skips: 3, title: 'Chanson A' }, { id: 'x', name: 'X', skips: 1, title: 'T' }] });
  const gone = page.in('staffAlerts', '[data-gone="bruno"]');
  assert.equal(gone.querySelector('span').textContent,
    'Bruno (Table 1) n’a pas répondu à « Je suis là » 3 fois : « Chanson A » a été retiré de sa liste. Cette personne est-elle encore là ?');
  assert.match(page.in('staffAlerts', '[data-gone="x"]').textContent, /^X n’a pas répondu/);
  await page.click(gone.querySelector('[data-gone-present]'));
  assert.deepEqual(page.lastPost('/api/staff/person/present').body, { personId: 'bruno' });
  assert.equal(page.toast().text, 'Noté : la personne est toujours là');
  page.confirmAnswer = false;
  await page.click(page.in('staffAlerts', '[data-gone="bruno"] [data-gone-leave]'));
  assert.equal(page.postsTo('/api/staff/person/leave').length, 0);
  page.confirmAnswer = true;
  await page.click(page.in('staffAlerts', '[data-gone="bruno"] [data-gone-leave]'));
  assert.deepEqual(page.lastPost('/api/staff/person/leave').body, { personId: 'bruno' });
  assert.equal(page.toast().text, 'Personne marquée partie ; ses titres restants ont été retirés');
  const count = page.posts.length;
  await page.click(page.$('staffAlerts'));
  assert.equal(page.posts.length, count, 'un clic hors des boutons ne fait rien');

  // Chaque alerte d'état est lisible par le bar.
  const world = { maybeGone: [], persistenceError: 'disque plein', recoveredPending: true, queueClearPending: true,
    removalPending: 2, presencePending: ['Zoé', 'Yann'],
    kf: { ...page.world.kf, identityNotice: 'KaraFun affiche maintenant « FileKaraoke ».', permissionWarning: 'Droits KaraFun incomplets.',
      permissions: { addToQueue: false } } };
  await page.update(world);
  const shown = texts(page.all('staffAlerts', '.staff-alert span'));
  assert.deepEqual(shown, [
    'Sauvegarde impossible : disque plein. Envoi automatique suspendu.',
    'Envoi interrompu à vérifier dans KaraFun avant de reprendre la file.',
    'Vidage de la file en cours : vérifie KaraFun. Les nouveaux titres attendent la confirmation des retraits.',
    'En attente de « Je suis là » pour Zoé et Yann. Sans réponse 30 s après la fin du titre en cours, le passage suivant chante d’abord.',
    '2 retraits en attente de confirmation dans KaraFun. Vérifie sa file.',
    'KaraFun affiche maintenant « FileKaraoke ».',
    'Droits KaraFun incomplets.',
    'KaraFun refuse l’ajout de titres pour FileKaraoke. Donne-lui les droits dans KaraFun Pro.']);
  // Fermer l'avis de nom KaraFun l'efface aussi côté serveur, et s'en souvient.
  await page.click(page.in('staffAlerts', '[data-dismiss-alert="identity"]'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'dismiss-notice' });
  assert.doesNotMatch(page.$('staffAlerts').textContent, /KaraFun affiche maintenant/);
  const saved = JSON.parse(page.stored.get('bar-dismissed-alerts'));
  assert.deepEqual(saved, { boot: 'boot-1', alerts: { identity: 'KaraFun affiche maintenant « FileKaraoke ».' } });
  // Page rouverte sur le même démarrage : l'alerte fermée reste fermée.
  const reopened = await openPage({ world: { ...baseWorld(), ...world, kf: world.kf },
    storage: { 'bar-dismissed-alerts': page.stored.get('bar-dismissed-alerts') } });
  assert.doesNotMatch(reopened.$('staffAlerts').textContent, /KaraFun affiche maintenant/);
  assert.match(reopened.$('staffAlerts').textContent, /Droits KaraFun incomplets/);
  // Mémoire illisible ou pleine : les alertes s'affichent quand même.
  const broken = await openPage({ world: { ...baseWorld(), ...world, kf: world.kf }, storage: { 'bar-dismissed-alerts': '{oups' },
    storageThrows: true });
  assert.match(broken.$('staffAlerts').textContent, /KaraFun affiche maintenant/);
  await broken.click(broken.in('staffAlerts', '[data-dismiss-alert="permission"]'));
  assert.doesNotMatch(broken.$('staffAlerts').textContent, /Droits KaraFun incomplets/, 'fermeture effective même sans mémoire');
  // Serveur injoignable ou accès refusé.
  page.stateStatus = 403;
  await page.poll();
  assert.equal(page.$('kfPill').textContent, 'Programme arrêté ?');
  assert.equal(page.$('kfPill').className, 'pill bad');
});

test('Spotify : configuration, connexion, appareils et commandes', async () => {
  const world = baseWorld();
  world.spotify = { configured: false, connected: false, redirectUri: 'http://127.0.0.1:3000/spotify/callback', clientId: '' };
  const page = await openPage({ world });
  assert.equal(page.$('spotifyPill').textContent, 'Non configuré');
  assert.equal(page.$('spotifyLogin').disabled, true, 'sans Client ID, pas de connexion possible');
  assert.equal(page.$('spotifyConnected').hidden, true);
  assert.equal(page.$('spotifyRedirect').textContent, 'http://127.0.0.1:3000/spotify/callback');
  page.$('spotifyClientId').value = '  0123456789abcdef  ';
  await page.click(page.$('spotifySaveClient'));
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'client', clientId: '0123456789abcdef' });
  assert.equal(page.toast().text, 'Client ID Spotify enregistré');
  await page.update({ spotify: { ...world.spotify, configured: true, clientId: '0123456789abcdef' } });
  assert.equal(page.$('spotifyPill').textContent, 'Non connecté');
  assert.equal(page.$('spotifyLogin').disabled, false);
  assert.equal(page.$('spotifyClientId').value, '0123456789abcdef');

  // Connexion depuis le PC du bar : la page Spotify s'ouvre, sans avertissement.
  page.replies['/api/staff/spotify'] = body => body.action === 'auth-url' ? { url: 'https://accounts.spotify.com/authorize?client_id=fake' } : { ok: true };
  await page.click(page.$('spotifyLogin'));
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'auth-url' });
  assert.deepEqual(page.opened, [['https://accounts.spotify.com/authorize?client_id=fake', '_blank', 'noopener']]);
  assert.notEqual(page.toast().text, 'Fais cette connexion depuis le PC du bar : Spotify revient sur son adresse locale.');
  // Depuis un téléphone : la page s'ouvre aussi, avec l'avertissement.
  const phone = await openPage({ world, hostname: '192.168.1.20' });
  phone.replies['/api/staff/spotify'] = { url: 'https://accounts.spotify.com/authorize?client_id=fake' };
  await phone.click(phone.$('spotifyLogin'));
  assert.deepEqual(phone.toast(), { text: 'Fais cette connexion depuis le PC du bar : Spotify revient sur son adresse locale.', bad: true });
  assert.equal(phone.opened.length, 1);
  phone.replies['/api/staff/spotify'] = { status: 400, error: 'Client ID Spotify manquant.' };
  await phone.click(phone.$('spotifyLogin'));
  assert.deepEqual(phone.toast(), { text: 'Client ID Spotify manquant.', bad: true });
  assert.equal(phone.opened.length, 1, 'pas de page Spotify après un refus');

  // Connecté : lecture en cours, appareil choisi, dernière action.
  const at = Date.now() - 60000;
  const connected = { configured: true, connected: true, clientId: '0123456789abcdef', autoResume: true, autoPause: false,
    deviceId: 'dev-2', deviceName: 'Enceinte', player: { isPlaying: true, track: { title: 'Get Lucky', artist: 'Daft Punk' },
      device: { name: 'Enceinte' } }, lastAction: { at, kind: 'resume', ok: true }, lastError: null };
  await page.update({ spotify: connected });
  assert.equal(page.$('spotifyConnected').hidden, false);
  assert.equal(page.$('spotifyPill').textContent, 'Spotify en lecture');
  assert.equal(page.$('spotifyPill').className, 'pill ok');
  assert.equal(page.$('spotifyText').textContent, `Spotify : Get Lucky — Daft Punk sur Enceinte. Dernière action à ${hhmm(at)} : relance.`);
  assert.equal(page.$('spotifyAutoResume').checked, true);
  assert.equal(page.$('spotifyAutoPause').checked, false);
  assert.equal(page.$('spotifyDelay').value, 3, 'délai par défaut');
  assert.deepEqual(texts(page.$('spotifyDevice').options), ['Appareil actif de Spotify', 'Enceinte']);
  assert.equal(page.$('spotifyDevice').value, 'dev-2');
  await page.update({ spotify: { ...connected, player: { isPlaying: false, track: { title: 'Get Lucky' } }, deviceId: 'dev-3', deviceName: '',
    lastAction: { at, kind: 'pause', ok: true, result: 'already' }, lastError: 'Spotify : appareil introuvable.' } });
  assert.equal(page.$('spotifyPill').textContent, 'Spotify en pause');
  assert.equal(page.$('spotifyPill').className, 'pill bad', 'une erreur Spotify est signalée');
  assert.equal(page.$('spotifyText').textContent, `Spotify : appareil introuvable. Spotify : Get Lucky. Dernière action à ${hhmm(at)} : pause (rien à faire).`);
  assert.deepEqual(texts(page.$('spotifyDevice').options), ['Appareil actif de Spotify', 'Appareil choisi']);
  await page.update({ spotify: { ...connected, player: null, deviceId: '', lastAction: { at, kind: 'resume', ok: false } } });
  assert.equal(page.$('spotifyPill').textContent, 'Connecté');
  assert.equal(page.$('spotifyText').textContent, `Dernière action à ${hhmm(at)} : relance en échec.`);
  assert.deepEqual(texts(page.$('spotifyDevice').options), ['Appareil actif de Spotify']);

  // Liste des appareils.
  page.replies['/api/staff/spotify'] = body => body.action === 'devices'
    ? { devices: [{ id: 'dev-1', name: 'PC du bar', active: true }, { id: 'dev-2', name: 'Enceinte' }] } : { ok: true };
  await page.update({ spotify: { ...connected } });
  await page.click(page.$('spotifyDevices'));
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'devices' });
  assert.deepEqual(texts(page.$('spotifyDevice').options), ['Appareil actif de Spotify', 'PC du bar (actif)', 'Enceinte']);
  assert.equal(page.$('spotifyDevice').value, 'dev-2', 'l’appareil enregistré reste sélectionné');
  await page.change(page.$('spotifyDevice'), 'dev-1');
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'device', deviceId: 'dev-1', deviceName: 'PC du bar' },
    'le nom enregistré ne garde pas « (actif) »');
  assert.equal(page.toast().text, 'Appareil Spotify enregistré');
  await page.change(page.$('spotifyDevice'), '');
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'device', deviceId: '', deviceName: '' });
  page.replies['/api/staff/spotify'] = { devices: [] };
  await page.click(page.$('spotifyDevices'));
  assert.deepEqual(page.toast(), { text: 'Aucun appareil : ouvre Spotify sur l’appareil voulu, puis actualise.', bad: true });
  assert.deepEqual(texts(page.$('spotifyDevice').options), ['Appareil actif de Spotify']);
  page.replies['/api/staff/spotify'] = { status: 401, error: 'Connexion Spotify expirée.' };
  await page.click(page.$('spotifyDevices'));
  assert.deepEqual(page.toast(), { text: 'Connexion Spotify expirée.', bad: true });
  page.replies['/api/staff/spotify'] = { ok: true };

  // Réglages de relance et de coupure.
  page.$('spotifyAutoResume').checked = false; page.$('spotifyAutoPause').checked = true;
  page.$('spotifyDelay').value = '0'; page.$('spotifyLead').value = '4';
  await page.click(page.$('spotifySaveOptions'));
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'options', autoResume: false, autoPause: true,
    resumeDelaySec: 0, pauseLeadSec: 4 });
  assert.equal(page.toast().text, 'Réglages Spotify enregistrés');

  // Commandes manuelles.
  await page.click(page.$('spotifyPlay'));
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'play' });
  assert.equal(page.toast().text, 'Spotify relancé');
  await page.click(page.$('spotifyPause'));
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'pause' });
  assert.equal(page.toast().text, 'Spotify en pause');
  page.confirmAnswer = false;
  const count = page.posts.length;
  await page.click(page.$('spotifyDisconnect'));
  assert.equal(page.posts.length, count, 'déconnexion annulée');
  page.confirmAnswer = true;
  await page.click(page.$('spotifyDisconnect'));
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'disconnect' });
  assert.equal(page.toast().text, 'Spotify déconnecté');
  // Champs en cours de saisie : pas écrasés par le rafraîchissement.
  page.$('spotifyDelay').focus();
  page.$('spotifyDelay').value = '7';
  await page.poll();
  assert.equal(page.$('spotifyDelay').value, '7');
  page.doc.activeElement = null;
});

test('diagnostic KaraFun : recherche de test et ajout d’essai', async () => {
  const page = await openPage();
  assert.match(page.$('diag').textContent, /ServeurdemoCode123456ConnectéouiDonnées reçuesoui/);
  assert.match(page.$('diag').textContent, /Durée moyenne mesurée4,5 min/);
  assert.match(page.$('kfEvents').textContent, /^21:15:30 ← status \{"state":"playing"\}$/);
  const field = page.$('testQ');
  field.value = 'Q';
  await page.click(page.$('testSearch'));
  assert.deepEqual(page.searches, [], 'une lettre ne lance pas de recherche');
  assert.equal(page.$('testRes').innerHTML, '');
  field.value = ' Queen ';
  await page.key(field, 'Enter');
  assert.deepEqual(page.searches, ['Queen'], 'Entrée lance la recherche, texte nettoyé');
  assert.deepEqual(texts(page.all('testRes', 'li .muted')), ['Queen · id 42', 'ABBA · id 7']);
  await page.click(page.in('testRes', '[data-add="42"]'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'test-add', songId: 42 }, 'l’identifiant part en nombre');
  assert.equal(page.toast().text, 'Envoyé à KaraFun : regarde sa file');
  await page.key(field, 'a');
  assert.deepEqual(page.searches, ['Queen'], 'seule Entrée déclenche la recherche');
  field.value = 'Rien';
  await page.click(page.$('testSearch'));
  assert.equal(page.$('testRes').textContent, 'Aucun résultat');
  field.value = 'Panne';
  await page.click(page.$('testSearch'));
  assert.equal(page.$('testRes').textContent, 'Catalogue KaraFun indisponible.', 'la raison de l’échec est affichée');
  // Sans connexion KaraFun : invitation à saisir le code.
  await page.update({ kf: null });
  assert.equal(page.$('kfPill').textContent, 'KaraFun : pas de code');
  assert.equal(page.$('diag').textContent, 'ÉtatSaisis le code KaraFun en haut à droite.');
  assert.equal(page.$('kfQueue').textContent, '');
});

test('règles de la soirée, envoi et lecture automatiques, rotation et version', async () => {
  const world = baseWorld();
  world.app = { version: '0.4.0', commit: 'abc1234', builtAt: '2026-10-01T12:00:00.000Z' };
  world.settings = { ...world.settings, repeatWarnMin: 30, presenceGraceSec: 45, presenceMaxSkips: 2, interleaveArrivals: false };
  const page = await openPage({ world });
  assert.equal(page.$('appVersion').textContent, '0.4.0 · abc1234');
  assert.match(page.$('appVersion').title, /^Version installée, construite le /);
  assert.equal(page.$('repeatWarnMin').value, 30);
  assert.equal(page.$('interleaveArrivals').checked, false);
  assert.equal(page.$('rotationPeople').checked, true);
  page.$('gap').value = '3'; page.$('cap').value = '5'; page.$('requirePresence').checked = true;
  page.$('playDelaySec').value = '6'; page.$('pushDelaySec').value = '20'; page.$('repeatWarnMin').value = '0';
  page.$('presenceGraceSec').value = '60'; page.$('presenceMaxSkips').value = '4';
  await page.click(page.$('saveRules'));
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { gap: '3', cap: '5', requirePresence: true, playDelaySec: '6',
    pushDelaySec: '20', repeatWarnMin: 0, presenceGraceSec: 60, presenceMaxSkips: 4 });
  assert.equal(page.toast().text, 'Règles enregistrées');
  await page.change(page.$('auto'), true);
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { auto: true });
  await page.change(page.$('autoPlay'), true);
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { autoPlay: true });
  await page.change(page.$('rotationTables'), true);
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { tableRotation: true, weightedTables: false });
  assert.equal(page.toast().text, 'Mode de rotation enregistré ; la file est recalculée');
  await page.change(page.$('rotationCompromise'), true);
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { tableRotation: true, weightedTables: true });
  await page.change(page.$('rotationPeople'), true);
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { tableRotation: false, weightedTables: false });
  const count = page.posts.length;
  await page.change(page.$('rotationTables'), false);
  assert.equal(page.posts.length, count, 'un bouton radio décoché n’envoie rien');
  await page.change(page.$('interleaveArrivals'), true);
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { interleaveArrivals: true });
  await page.update({ settings: { ...world.settings, tableRotation: true, weightedTables: true }, app: {} });
  assert.equal(page.$('rotationCompromise').checked, true);
  assert.equal(page.$('rotationTables').checked, false);
  assert.equal(page.$('appVersion').textContent, '');
  assert.equal(page.$('appVersion').title, 'Version installée sur ce PC');
});
