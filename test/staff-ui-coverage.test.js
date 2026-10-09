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
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
  select() { this.selectedAll = true; }
  // Avec `doc.dialogFocus`, comme un navigateur : la fenêtre ouverte donne le
  // focus à son élément `autofocus`, sinon à son premier élément focalisable
  // (un élément quelconque l'est avec un attribut tabindex, comme un titre).
  showModal() {
    this.open = true;
    if (!this.ownerDocument.dialogFocus) return;
    const visible = el => { for (let up = el; up && up !== this; up = up.parent) if (up.hidden) return false; return true; };
    const focusable = el => !el.disabled && visible(el) && (/^(SELECT|TEXTAREA|BUTTON)$/.test(el.tagName) ||
      (el.tagName === 'INPUT' && el.type !== 'hidden') || (el.tagName === 'A' && el.getAttribute('href') !== null) || 'tabindex' in el.attrs);
    const all = [...this.descendants()];
    (all.find(el => 'autofocus' in el.attrs && focusable(el)) || all.find(focusable))?.focus();
  }
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
  doc.contains = node => body.contains(node);
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
      { id: 'alice', name: 'Alice', tableId: '1', active: true, songCount: 1, sung: 0, privateNote: 't-shirt rouge' },
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
async function openPage({ search = `?key=${KEY}`, hostname = '127.0.0.1', hash = '', world = baseWorld(), storage = {},
  storageThrows = false, secure = true, permission = 'granted', audioThrows = false, notifyThrows = false, dialogFocus = false } = {}) {
  const doc = makeDocument();
  doc.dialogFocus = dialogFocus;
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
  // Minuteurs dus à cet instant seulement : un minuteur qui se reprogramme
  // (barre de lecture) attend l'appel suivant.
  page.runTimers = ms => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } };
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
  // Historique du navigateur : chaque onglet ajoute une étape ; page.back() la retire.
  const location = { search, hostname, hash, pathname: '/staff' };
  page.history = [];
  page.windowListeners = {};
  const history = {
    state: null,
    pushState(state, _title, url) { page.history.push({ state, url }); this.state = state; location.hash = url.slice(url.indexOf('#')); },
    replaceState(state, _title, url) { page.history[Math.max(0, page.history.length - 1)] = { state, url }; this.state = state; location.hash = url.slice(url.indexOf('#')); },
    back() { page.back(); },
  };
  page.back = async () => {
    page.history.pop();
    const previous = page.history.at(-1) || { state: null, url: '#' };
    history.state = previous.state;
    location.hash = previous.url.slice(previous.url.indexOf('#'));
    for (const listener of page.windowListeners.popstate || []) listener({ state: previous.state });
    await page.flush();
  };
  const context = { document: doc, fetch, location, URL, URLSearchParams, localStorage,
    window: { open: (...args) => page.opened.push(args), AudioContext, Notification, isSecureContext: secure, history,
      addEventListener: (type, listener) => (page.windowListeners[type] ||= []).push(listener), scrollTo() {} },
    Notification, navigator: page.navigator = { clipboard: { writeText: async text => {
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

  // QR d'une table : affiché en grand dans la page, versionné par son adresse
  // (le cache ne garde pas l'ancien).
  const qrOf = async (target = page) => {
    await target.click(target.in('tBody', '[data-table-qr="1"]'));
    const src = target.$('tableQrImg').src;
    await target.click(target.$('tableQrClose'));
    return src;
  };
  assert.match(await qrOf(), new RegExp(`^/qr/1\\.png\\?v=[0-9a-f]+&key=${KEY}$`));
  const before = await qrOf();
  page.world.tables[0].url = 'http://192.168.1.20:3000/t/1/nouveau';
  await page.poll();
  assert.notEqual(await qrOf(), before, 'nouvelle adresse de table : nouveau QR');
  assert.equal(page.in('tBody', '[data-table-qr="2"]').disabled, true, 'seule la table avec adresse a un QR');
  assert.equal(page.$('phoneLabel').textContent, '1 QR code disponible · adresse utilisée');
  assert.equal(page.$('phoneBase').textContent, 'http://192.168.1.20:3000');
  assert.equal(page.$('statsLink').href, `/stats?key=${KEY}`, 'statistiques des soirées réservées au bar');
  // Sans clé : ni paramètre ni clé vide dans l'adresse.
  const anonymous = await openPage({ search: '' });
  assert.equal(anonymous.fetches[0].url, '/api/staff/state');
  assert.equal(anonymous.$('staffQr').src, '/qr/staff.svg');
  assert.match(await qrOf(anonymous), /^\/qr\/1\.png\?v=[0-9a-f]+$/);
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

test('adresse des QR : le choix fait reste affiché jusqu’à « Utiliser », malgré le rafraîchissement', async () => {
  const world = baseWorld();
  world.ips = [{ address: '192.168.1.20' }, { address: '10.0.0.5' }];
  const page = await openPage({ world });
  await page.change(page.$('ipSel'), 'http://10.0.0.5:3000');
  await page.poll();
  assert.equal(page.$('ipSel').value, 'http://10.0.0.5:3000', 'liste refermée : le choix reste');
  await page.click(page.$('useLocal'));
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { baseUrl: 'http://10.0.0.5:3000' });
  await page.poll();
  assert.equal(page.$('ipSel').value, 'http://192.168.1.20:3000', 'ensuite, la liste suit le serveur');
  await page.type(page.$('customBase'), 'https://chant.exemple.fr');
  await page.poll();
  assert.equal(page.$('customBase').value, 'https://chant.exemple.fr', 'adresse tapée gardée après la fermeture du clavier');
  await page.click(page.$('saveBase'));
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { baseUrl: 'https://chant.exemple.fr' });
  await page.poll();
  assert.equal(page.$('customBase').value, '', 'le serveur garde l’adresse locale : le champ la suit');
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
  // Repère enregistré tout seul : après la pause de frappe, sur Entrée ou en
  // quittant le champ. Seul le texte part.
  const note = id => row(id).querySelector('[data-identity-note]');
  const status = id => page.in('identityBody', `[data-save-status="note:${id}"]`).textContent;
  assert.equal(row('alice').querySelector('[data-identity-save]'), null, 'plus de bouton ✓ à ne pas oublier');
  await page.type(note('alice'), 'veste bleue');
  assert.equal(page.postsTo('/api/staff/person/identify').length, 0, 'pendant la frappe, rien ne part');
  assert.equal(status('alice'), 'Modifié…');
  page.runTimers(1000);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/person/identify').body, { personId: 'alice', note: 'veste bleue' });
  assert.equal(status('alice'), 'Enregistré ✓', 'confirmation visible à côté du champ');
  await page.type(note('bruno'), 'casquette');
  const enter = await page.key(note('bruno'), 'Enter');
  assert.equal(enter.defaultPrevented, true, 'Entrée ne soumet rien d’autre');
  assert.deepEqual(page.lastPost('/api/staff/person/identify').body, { personId: 'bruno', note: 'casquette' });
  await page.key(note('bruno'), 'a');
  await page.change(note('chloe'), 'lunettes');
  assert.deepEqual(page.lastPost('/api/staff/person/identify').body, { personId: 'chloe', note: 'lunettes' }, 'en quittant le champ');
  const sent = page.posts.length;
  await page.change(note('dora'), '');
  assert.equal(page.posts.length, sent, 'valeur inchangée : rien ne part');
  await page.type(note('dora'), 'x'.repeat(141));
  assert.equal(status('dora'), 'Non enregistré : au plus 140 caractères');
  assert.equal(note('dora').getAttribute('aria-invalid'), 'true');
  await page.poll();
  assert.equal(note('dora').value, 'x'.repeat(141), 'une valeur refusée n’est pas effacée par le rafraîchissement');
  page.replies['/api/staff/person/identify'] = { status: 500, error: 'Sauvegarde impossible.' };
  await page.change(note('dora'), 'chapeau');
  assert.equal(status('dora'), 'Non enregistré : Sauvegarde impossible. · Réessayer');
  page.replies['/api/staff/person/identify'] = { ok: true };
  await page.click(page.in('identityBody', '[data-retry="note:dora"]'));
  assert.deepEqual(page.lastPost('/api/staff/person/identify').body, { personId: 'dora', note: 'chapeau' });
  assert.equal(status('dora'), 'Enregistré ✓');
  // Le serveur a pris le nouveau repère : la confirmation disparaît, le champ suit le serveur.
  page.world.people[3].privateNote = 'chapeau';
  await page.poll();
  assert.equal(note('dora').value, 'chapeau');
  assert.equal(note('dora').getAttribute('aria-invalid'), null);

  // Départ confirmé seulement, puis retour.
  page.confirmAnswer = false;
  await page.click(row('bruno').querySelector('[data-identity-leave]'));
  assert.equal(page.postsTo('/api/staff/person/leave').length, 0, 'départ annulé : rien n’est envoyé');
  assert.match(page.confirms.at(-1), /Marquer ce chanteur comme parti/);
  page.confirmAnswer = true;
  // Regression: le bouton cliqué garde le focus (Chrome sur PC) ; la ligne ne
  // changeait pas et un deuxième clic renvoyait le départ.
  const leave = row('bruno').querySelector('[data-identity-leave]');
  leave.focus();
  page.world.people[1].active = false;
  await page.click(leave);
  assert.deepEqual(page.lastPost('/api/staff/person/leave').body, { personId: 'bruno' });
  assert.equal(page.toast().text, 'Chanteur marqué parti ; ses titres en attente ont été retirés');
  assert.match(row('bruno').textContent, /parti, fiche conservée/, 'la ligne suit le départ malgré le focus');
  assert.equal(row('bruno').querySelector('[data-identity-leave]'), null, 'plus de bouton « Parti » à recliquer');
  const reactivate = row('chloe').querySelector('[data-identity-reactivate]');
  reactivate.focus();
  page.world.people[2].active = true;
  await page.click(reactivate);
  assert.deepEqual(page.lastPost('/api/staff/person/reactivate').body, { personId: 'chloe' });
  assert.equal(page.toast().text, 'Personne réactivée, historique conservé');
  assert.doesNotMatch(row('chloe').textContent, /parti, fiche conservée/, 'la ligne suit la réactivation malgré le focus');
  page.doc.activeElement = null;
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
  assert.match(page.$('shareCodeHelp').textContent, /sur la page de la table, toucher « Voir toute la table », puis « C’est moi »/);
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
  page.$('shareCopy').focus();
  await page.click(page.$('shareCopy'));
  assert.equal(page.toast().text, 'Lien copié', 'copie de secours du navigateur');
  // Regression: copié par le champ, le focus revient au bouton « Copier »
  // (pas perdu en haut de la page).
  assert.ok(page.doc.activeElement === page.$('shareCopy'), `focus rendu au bouton (${page.doc.activeElement?.id})`);
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
  assert.match(page.$('shareCodeHelp').textContent, /ouvrir la page karaoké du bar, toucher « Je suis … »/);
  assert.doesNotMatch(page.$('shareCodeHelp').textContent, /En solo/, 'fenêtre montrée au client : le groupe n’est pas nommé');
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
  assert.deepEqual(actions(lines[3]), ['Réglages', 'Retirer'], 'le premier prévu n’a pas besoin de priorité');
  assert.deepEqual(actions(lines[4]), ['Priorité', 'Réglages', 'Retirer']);
  assert.deepEqual(actions(lines[6]), ['Réglages', 'Retirer'], 'un titre supplémentaire n’est pas encore déplaçable, mais se règle et se retire déjà');
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

// Une invitation de duo sans réponse ne retient plus le titre : il reste à
// sa place dans la file, marqué, et part en solo si personne n'a répondu.
test('file du bar : invitation de duo en attente marquée, plus de liste des duos sautés', async () => {
  const world = baseWorld();
  world.queue = [{ source: 'helper', id: 'alice', pos: 1, name: 'Alice', table: 'Table 1', ids: ['alice'],
    song: { title: 'Valse', artist: 'Strauss', entryId: 'e1', duet: { partnerName: 'Zoé', state: 'pending', kind: 'duo', seen: false } } },
  { source: 'helper', id: 'bruno', pos: 2, name: 'Bruno', table: 'Table 2', ids: ['bruno'], song: { title: 'Rock', entryId: 'e2' } }];
  world.next = world.queue[0];
  const page = await openPage({ world });
  assert.match(page.$('next').textContent, /Invitation en attente.*Valse/s, 'Scène : « Ensuite » porte le repère');
  const lines = rows(page);
  assert.deepEqual(badges(lines[0]), ['À venir', 'Invitation en attente']);
  assert.equal(lines[0].querySelector('.badge.invite').title,
    'Duo proposé à Zoé (pas encore vue) : sans réponse à son tour, le titre part en solo dans KaraFun.');
  assert.deepEqual(badges(lines[1]), ['À venir']);
  world.queue[0].song.duet.seen = true;
  await page.update({ queue: world.queue });
  assert.equal(rows(page)[0].querySelector('.badge.invite').title,
    'Duo proposé à Zoé : sans réponse à son tour, le titre part en solo dans KaraFun.');
  // En cours d'envoi : le titre part en solo, l'invitation expire à l'accusé.
  await page.update({ queue: [{ ...world.queue[0], source: 'envoi', id: undefined }] });
  assert.deepEqual(badges(rows(page)[0]), ['Envoi']);
  assert.ok(!/blockedBox|Duos en attente d’accord/.test(html), 'plus de liste « Duos en attente d’accord »');
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
      { id: 'dora', name: 'Dora', table: 'En solo', individual: true, active: true, photoUrl: '/photo/dora.jpg' },
      { id: 'eve', name: 'Eve', table: 'En solo', individual: true, active: false }] },
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
  assert.doesNotMatch(person('dora').textContent, /En solo/, 'un soliste : son prénom seul');
  assert.match(person('eve').textContent, /Eve\s*parti/, 'soliste parti : « parti » sans nom de groupe');
  assert.doesNotMatch(person('eve').textContent, /En solo|· parti/);
  assert.equal(page.$('clearStageHistory').disabled, false);

  // « Repère » ouvre l'écran Repères sur cette personne, prêt à écrire.
  await page.click(person('alice').querySelector('[data-history-note]'));
  assert.equal(page.doc.body.dataset.tab, 'reperes');
  assert.equal(page.$('identitySearch').value, 'Alice');
  assert.deepEqual(texts(page.all('identityBody', '.identity-who strong')), ['Alice']);
  assert.equal(page.doc.activeElement, page.in('identityBody', '[data-identity-person="alice"] [data-identity-note]'));
  page.doc.activeElement = null;
  const count = page.posts.length;
  page.confirmAnswer = false;
  await page.click(person('dora').querySelector('[data-history-leave]'));
  assert.equal(page.posts.length, count);
  assert.match(page.confirms.at(-1), /^Marquer Dora comme partie/);
  page.confirmAnswer = true;
  await page.click(person('dora').querySelector('[data-history-leave]'));
  assert.deepEqual(page.lastPost('/api/staff/person/leave').body, { personId: 'dora' });
  // Personne qui n'est plus inscrite : pas de fiche à ouvrir.
  page.world.stageHistory[1].people.push({ id: 'ancien', name: 'Ancien', table: 'Table 9', active: true });
  await page.poll();
  await page.click(person('ancien').querySelector('[data-history-note]'));
  assert.deepEqual(page.toast(), { text: 'Cette personne n’est plus inscrite.', bad: true });
  const total = page.posts.length;
  await page.click(page.$('stageHistory'));
  assert.equal(page.posts.length, total, 'un clic hors d’une personne ne fait rien');

  // Un bouton touché ne retient pas le rafraîchissement : seule une saisie le fait.
  person('alice').querySelector('[data-history-note]').focus();
  await page.update({ stageHistory: [] });
  assert.equal(page.$('stageHistory').textContent, 'Aucun passage pour le moment.');
  page.doc.activeElement = null;
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
  // QR ouvert sans prénom : jamais proposé comme partenaire (lot K).
  world.people.push({ id: 's9', name: 'Solo 9', tableId: 'Comptoir', active: true, nameRequired: true, songCount: 0, sung: 0 });
  const page = await openPage({ world });
  assert.match(page.$('stage').textContent, /Alice.*Table 1.*Dora.*Duo.*Ensemble.*Interprète inconnu/s);
  assert.doesNotMatch(page.$('stage').textContent, /En solo/, 'un soliste : son prénom, sans pastille');
  assert.equal(page.all('stage', '.live-table').length, 1, 'seule la table d’Alice a sa pastille');
  assert.match(page.$('next').textContent, /Client.*Ajouté dans KaraFun.*Manuel/s);
  assert.equal(page.$('pendingTxt').textContent, 'Envoi en cours à KaraFun : Bruno — Chanson A');

  // Duo improvisé : partenaire de la même table d'abord, personnes parties exclues.
  assert.equal(page.$('markDuoBox').hidden, false);
  assert.equal(page.$('markDuoBox').dataset.queueId, 'q-live');
  assert.deepEqual(page.all('markDuoPartner', 'optgroup').map(g => g.getAttribute('label')),
    ['Même table', 'Autres personnes']);
  assert.deepEqual(texts(page.$('markDuoPartner').options), ['Choisir…', 'Bruno — Table 1', 'Dora'], 'soliste : prénom seul ; « Solo 9 » exclu');
  assert.equal(page.$('markDuoPartner').value, '', 'personne n’est choisi d’avance');
  await page.click(page.$('markDuoBtn'));
  assert.equal(page.postsTo('/api/staff/duo-mark').length, 0, 'sans partenaire choisi, rien ne part');
  assert.deepEqual(page.toast(), { text: 'Choisis d’abord le second chanteur dans la liste.', bad: true });
  page.$('markDuoPartner').value = 'dora';
  page.confirmAnswer = false;
  await page.click(page.$('markDuoBtn'));
  assert.equal(page.postsTo('/api/staff/duo-mark').length, 0);
  assert.equal(page.confirms.at(-1), 'Noter Dora en duo avec Alice sur la chanson en cours ? Dora garde son tour.');
  page.confirmAnswer = true;
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

test('fermeture du bar : rappel sur Scène, décaler et retirer l’heure', async () => {
  const page = await openPage();
  const field = page.$('closingTime');
  assert.equal(page.doc.getElementById('closingSave'), null, 'plus de bouton « Annoncer »');
  assert.equal(page.$('closingChip').hidden, true, 'sans heure, pas de rappel sur Scène');
  const at = new Date(); at.setHours(23, 30, 0, 0);
  await page.update({ closing: { at: at.getTime(), passed: false, full: false, fitCount: 3, afterCount: 0 } });
  assert.equal(field.value, '23:30');
  assert.equal(page.$('closingChip').hidden, false);
  assert.equal(page.$('closingChipText').textContent, 'Fermeture 23:30');
  const extend = page.doc.body.querySelector('[data-closing-extend="15"]');
  await page.click(extend);
  assert.deepEqual(page.lastPost('/api/staff/closing').body, { extendMin: 15 });
  assert.equal(page.toast().text, 'Fermeture décalée');
  await page.click(page.$('closingClear'));
  assert.deepEqual(page.lastPost('/api/staff/closing').body, { clear: true });
  assert.equal(page.toast().text, 'Heure de fermeture retirée');
  await page.update({ closing: null });
  assert.equal(field.value, '', 'heure retirée : le champ suit le serveur');
  assert.equal(page.$('closingClear').disabled, true, 'sans heure annoncée, rien à retirer');
});

test('fin de soirée : plus de bouton d’arrêt, suppression des tables et vidage de la file', async () => {
  const page = await openPage();
  // L'arrêt se fait depuis le PC (ARRETER.bat) : un téléphone ne peut plus couper la soirée.
  assert.equal(page.doc.getElementById('shutdownBtn'), null, 'plus de bouton « Arrêter la soirée »');
  assert.ok(!/Arrêter la soirée/.test(page.doc.body.textContent));

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
  // KaraFun absent : sa file n'a pas pu être vue, le bar la vérifie.
  for (const leftover of [{ karafunOffline: true }, { currentStillPlaying: true }, { otherKaraFunSongs: 2 }, { removalErrors: 1 }, { removalPending: 1 }]) {
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
  assert.doesNotMatch(page.confirms.at(-1), /n’est pas connecté/);
  // KaraFun déconnecté : la question et la réponse disent que rien n'y est encore retiré.
  await page.update({ kf: { ...page.world.kf, ready: false, connected: false } });
  page.replies['/api/staff/queue-clear'] = { awaitingKaraFun: true, karafunOffline: true };
  await page.click(page.$('clearQueue'));
  assert.match(page.confirms.at(-1), /KaraFun n’est pas connecté : sa file sera vidée dès sa connexion\.$/);
  assert.equal(page.toast().text, 'File vidée ici. KaraFun n’est pas connecté : sa file sera vidée dès sa connexion.');
  await page.update({ kf: baseWorld().kf });
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

test('tables : tuiles, QR en grand, création, détails enregistrés seuls, bonus et départ', async () => {
  const page = await openPage();
  const card = id => page.in('tBody', `[data-table-card="${id}"]`);
  assert.equal(page.$('tableName').placeholder, 'Table 3', 'prochain numéro libre proposé');
  assert.equal(card('1').querySelector('.occupancy').textContent, '2 actifs / 2 inscrits / 4 places');
  assert.equal(card('2').querySelector('.occupancy').textContent, '1 actif / 1 inscrit / 2 places');
  assert.equal(card('Comptoir').querySelector('.occupancy').textContent, '1 soliste');
  assert.ok(card('Comptoir').querySelector('[data-solo-invite]'), '« En solo » : QR individuel');
  assert.equal(card('2').querySelector('[data-table-qr]').disabled, true, 'table sans QR');
  assert.equal(card('2').querySelector('.table-tile-cta').textContent, 'QR indisponible');

  // QR en grand dans la page, pour le montrer aux clients.
  await page.click(card('1').querySelector('[data-table-qr]'));
  assert.equal(page.$('tableQrDialog').open, true);
  assert.equal(page.$('tableQrName').textContent, 'Table 1');
  assert.equal(page.$('tableQrImg').alt, 'QR code de Table 1');
  assert.equal(page.$('tableQrUrl').value, 'http://192.168.1.20:3000/t/1/abc');
  assert.equal(page.$('tableQrPage').href, 'http://192.168.1.20:3000/t/1/abc');
  await page.click(page.$('tableQrCopy'));
  assert.deepEqual(page.clipboard, ['http://192.168.1.20:3000/t/1/abc']);
  assert.equal(page.toast().text, 'Lien de la table copié');
  page.clipboardWorks = false;
  await page.click(page.$('tableQrCopy'));
  assert.equal(page.$('tableQrUrl').selectedAll, true);
  assert.deepEqual(page.toast(), { text: 'Sélectionne le lien pour le copier.', bad: true });
  page.clipboardWorks = true;
  page.world.tables[0].name = 'Terrasse';
  await page.poll();
  assert.equal(page.$('tableQrDialog').open, true, 'le rafraîchissement ne ferme pas le QR');
  assert.equal(page.$('tableQrName').textContent, 'Terrasse');
  page.world.tables[0].name = 'Table 1';
  await page.click(page.$('tableQrClose'));
  assert.equal(page.$('tableQrDialog').open, false);
  await page.click(card('1').querySelector('[data-table-qr]'));
  page.world.tables = baseWorld().tables.filter(t => t.id !== '1');
  await page.poll();
  assert.equal(page.$('tableQrDialog').open, false, 'table partie : son QR se ferme');
  page.world.tables = baseWorld().tables;
  await page.poll();

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

  // Détails : nom et places enregistrés seuls, avec confirmation à côté.
  await page.click(card('2').querySelector('[data-table-more]'));
  assert.equal(page.$('tableSheet').open, true);
  assert.equal(page.$('tableSheetTitle').textContent, 'Table 2');
  assert.equal(page.$('tableSheetInfo').textContent, '1 actif, 1 inscrit, 2 places.');
  const name = page.$('tableSheetName'), places = page.$('tableSheetHc');
  assert.equal(name.value, 'Table 2');
  assert.equal(String(places.value), '2');
  await page.type(name, '  Bar  ');
  page.runTimers(1000);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/table/rename').body, { tableId: '2', name: 'Bar' });
  assert.equal(page.$('tableSheetNameStatus').textContent, 'Enregistré ✓');
  // Places tapées puis clavier refermé : le rafraîchissement ne les remet pas à 2.
  places.focus();
  await page.type(places, '9');
  page.doc.activeElement = null;
  await page.poll();
  assert.equal(places.value, '9');
  page.runTimers(800);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/table').body, { id: '2', headcount: 9 });
  const tablePosts = page.postsTo('/api/staff/table').length;
  for (const value of ['41', '0', '', '2.5']) {
    await page.type(places, value);
    page.runTimers(800);
    await page.flush();
    assert.equal(page.$('tableSheetHcStatus').textContent, 'Non enregistré : entre 1 et 40 personnes', value);
  }
  assert.equal(page.postsTo('/api/staff/table').length, tablePosts, 'aucune valeur hors bornes envoyée');
  await page.type(name, '');
  assert.equal(page.$('tableSheetNameStatus').textContent, 'Non enregistré : entre 1 et 40 caractères');
  await page.type(name, 'Table 2');
  page.runTimers(1000);
  await page.flush();
  assert.equal(page.$('tableSheetNameStatus').textContent, 'Enregistré ✓', 'nom revenu à celui du serveur : rien à envoyer');
  // Bonus de table.
  await page.change(page.$('tableSheetBonus'), '-1');
  assert.deepEqual(page.lastPost('/api/staff/bonus').body, { tableId: '2', level: -1 });
  assert.equal(page.toast().text, 'Bonus de table enregistré (invisible des clients)');
  await page.change(page.$('tableSheetBonus'), '0');
  assert.equal(page.toast().text, 'Bonus de table retiré');
  // Table partie.
  page.confirmAnswer = false;
  await page.click(page.$('tableSheetLeft'));
  assert.equal(page.confirms.at(-1), 'Table 2 est partie ? Ses tickets seront retirés.');
  assert.equal(page.postsTo('/api/staff/table-left').length, 0);
  page.confirmAnswer = true;
  await page.click(page.$('tableSheetLeft'));
  assert.deepEqual(page.lastPost('/api/staff/table-left').body, { id: '2' });
  assert.equal(page.toast().text, 'Table retirée');
  assert.equal(page.$('tableSheet').open, false);
  // « En solo » : ni places ni départ ; une table avec QR peut le montrer d'ici.
  await page.click(card('Comptoir').querySelector('[data-table-more]'));
  assert.equal(page.$('tableSheetHcRow').hidden, true);
  assert.equal(page.$('tableSheetLeft').hidden, true, '« En solo » ne part jamais');
  assert.equal(page.$('tableSheetQr').hidden, true);
  await page.click(page.$('tableSheetClose'));
  await page.click(card('1').querySelector('[data-table-more]'));
  assert.equal(page.$('tableSheetQr').hidden, false);
  await page.click(page.$('tableSheetQr'));
  assert.equal(page.$('tableSheet').open, false);
  assert.equal(page.$('tableQrDialog').open, true);
  assert.equal(page.$('tableQrName').textContent, 'Table 1');
  await page.click(page.$('tableQrClose'));
  // Table sans QR : rien à montrer.
  await page.click(card('2').querySelector('[data-table-more]'));
  await page.click(page.$('tableSheetQr'));
  assert.deepEqual(page.toast(), { text: 'Cette table n’a pas encore de QR.', bad: true });
  assert.equal(page.$('tableQrDialog').open, false);
  // Table supprimée pendant que ses détails sont ouverts : la fiche se ferme.
  await page.click(card('1').querySelector('[data-table-more]'));
  page.world.tables = baseWorld().tables.filter(t => t.id !== '1');
  await page.poll();
  assert.equal(page.$('tableSheet').open, false);
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
  // Regression: page du bar ouverte en http depuis un téléphone (contexte non
  // sécurisé, pas d'API presse-papiers) : « Copier le lien » ne copiait rien.
  // Signalé par le gérant le 8 octobre 2026 ; reproduit dans Chromium.
  page.doc.copyWorks = true;
  await page.click(page.$('soloInviteCopy'));
  assert.equal(page.toast().text, 'Lien individuel copié', 'copie de secours du navigateur');
  const clipboardApi = page.navigator.clipboard;
  delete page.navigator.clipboard;
  page.$('soloInviteUrl').selectedAll = false;
  page.$('soloInviteUrl').readOnly = true;
  await page.click(page.$('soloInviteCopy'));
  assert.equal(page.$('soloInviteUrl').selectedAll, true, 'le champ lui-même est sélectionné, dans la fenêtre ouverte');
  assert.equal(page.toast().text, 'Lien individuel copié', 'sans API presse-papiers, la copie de secours copie le lien');
  assert.equal(page.$('soloInviteUrl').readOnly, true, 'le champ redevient en lecture seule après la copie');
  page.navigator.clipboard = clipboardApi;
  page.doc.copyWorks = false;
  page.clipboardWorks = true;
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
  // Regression: ISSUE-012 — le texte renvoyait au « panneau En direct », qui n'existe pas (QA du 2026-10-03)
  assert.match(status(), /« ▶ Lancer le prochain titre » dans « Sur scène »\.$/);
  assert.ok(!/En direct/.test(status()));
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

  // Réglages Battle : chaque champ s'enregistre seul ; seule sa valeur part.
  assert.match(page.$('battleVoteMin').closest('label').textContent, /^Durée du vote \(1 à 120 min\)/, 'plage visible');
  const saved = id => page.doc.body.querySelector(`[data-save-status="${id}"]`).textContent;
  await page.type(page.$('battleCooldownMin'), '20');
  page.runTimers(800);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { battleCooldownMin: 20 });
  assert.equal(saved('battleCooldownMin'), 'Enregistré ✓');
  // Durée du vote hors bornes : rien ne part, la plage est rappelée et la saisie reste.
  const sent = page.postsTo('/api/staff/settings').length;
  await page.type(page.$('battleVoteMin'), '200');
  page.runTimers(800);
  await page.flush();
  assert.equal(page.postsTo('/api/staff/settings').length, sent);
  assert.equal(saved('battleVoteMin'), 'Non enregistré : entre 1 et 120 minutes');
  assert.equal(page.$('battleVoteMin').getAttribute('aria-invalid'), 'true');
  await page.poll();
  assert.equal(page.$('battleVoteMin').value, '200');
  // Refus du serveur : raison, puis nouvel essai.
  page.replies['/api/staff/settings'] = { status: 400, error: 'Le nombre minimal de votants doit être de 1 à 100.' };
  await page.type(page.$('battleMinVoters'), '8');
  await page.key(page.$('battleMinVoters'), 'Enter');
  assert.equal(saved('battleMinVoters'), 'Non enregistré : Le nombre minimal de votants doit être de 1 à 100. · Réessayer');
  page.replies['/api/staff/settings'] = { ok: true };
  await page.click(page.doc.body.querySelector('[data-retry="battleMinVoters"]'));
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { battleMinVoters: 8 });
  // Relu sur le serveur après l'enregistrement : le champ suit de nouveau le serveur.
  await page.update({ settings: { ...page.world.settings, battleMinVoters: 9 } });
  assert.equal(page.$('battleMinVoters').value, 9);
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
    'Arrêter le vidage',
    'En attente de « Je suis là » pour Zoé et Yann. Sans réponse 30 s après la fin du titre en cours, le passage suivant chante d’abord.',
    '2 retraits en attente de confirmation dans KaraFun. Vérifie sa file.',
    'KaraFun affiche maintenant « FileKaraoke ».',
    'Droits KaraFun incomplets.',
    'KaraFun refuse l’ajout de titres pour FileKaraoke. Donne-lui les droits dans KaraFun Pro.']);
  // Le vidage a toujours une sortie, même quand KaraFun ne retire rien, et
  // elle ne se cache pas : pas de croix sur la bannière qui la porte.
  const clearAlert = () => page.in('staffAlerts', '[data-alert-stop-clear]')?.closest('.staff-alert');
  assert.equal(clearAlert().querySelector('[data-dismiss-alert]'), null, 'la seule sortie ne peut pas être masquée');
  const stops = () => page.postsTo('/api/staff/queue-clear-stop').length;
  page.confirmAnswer = false;
  await page.click(page.in('staffAlerts', '[data-alert-stop-clear]'));
  assert.match(page.confirms.at(-1), /^Arrêter le vidage \? La file ne retirera plus les titres ajoutés directement dans KaraFun/);
  assert.equal(stops(), 0, 'rien ne part sans confirmation');
  page.confirmAnswer = true;
  page.replies['/api/staff/queue-clear-stop'] = { ok: true, wasPending: true };
  await page.click(page.in('staffAlerts', '[data-alert-stop-clear]'));
  assert.deepEqual(page.lastPost('/api/staff/queue-clear-stop').body, {});
  assert.equal(page.toast().text, 'Vidage arrêté : la file ne retire plus les titres ajoutés directement dans KaraFun.');
  // Page en retard : le vidage avait déjà pris fin (terminé, arrêté ailleurs ou
  // nouvelle soirée). Rien ne dit que KaraFun a été vidé : le bar vérifie.
  page.replies['/api/staff/queue-clear-stop'] = { ok: true, wasPending: false };
  await page.click(page.in('staffAlerts', '[data-alert-stop-clear]'));
  assert.equal(page.toast().text, 'Le vidage n’était plus en cours. Vérifie la file de KaraFun.');
  page.replies['/api/staff/queue-clear-stop'] = { status: 500, error: 'Sauvegarde impossible.' };
  await page.click(page.in('staffAlerts', '[data-alert-stop-clear]'));
  assert.deepEqual(page.toast(), { text: 'Sauvegarde impossible.', bad: true });
  // KaraFun déconnecté : rien n'a pu être retiré ni vérifié, la bannière le dit,
  // une seule fois (pas de seconde alerte pour les mêmes retraits).
  await page.update({ kf: { ...world.kf, ready: false, connected: false } });
  const offline = texts(page.all('staffAlerts', '.staff-alert span'));
  assert.ok(offline.includes('File vidée ici, mais KaraFun n’est pas connecté : ses titres en attente seront retirés dès sa connexion, avant tout nouvel envoi.'));
  assert.ok(!offline.some(text => /retrait|titres? envoyés? à KaraFun/.test(text) && !/^File vidée ici/.test(text)), 'pas de seconde alerte de retraits');
  assert.ok(!offline.some(text => /vérifie KaraFun|Vérifie sa file/.test(text)), 'pas de « vérifie KaraFun » quand KaraFun est absent');
  assert.ok(page.in('staffAlerts', '[data-alert-stop-clear]'), 'la sortie reste proposée sans KaraFun');
  assert.equal(clearAlert().querySelector('[data-dismiss-alert]'), null);
  // Vidage arrêté, KaraFun toujours absent : nos titres envoyés partiront à sa connexion.
  await page.update({ queueClearPending: false });
  assert.equal(page.in('staffAlerts', '[data-alert-stop-clear]'), null, 'plus de bouton une fois le vidage fini');
  assert.ok(texts(page.all('staffAlerts', '.staff-alert span')).includes('2 titres envoyés à KaraFun seront retirés dès sa connexion.'));
  await page.update({ removalPending: 1 });
  assert.ok(texts(page.all('staffAlerts', '.staff-alert span')).includes('1 titre envoyé à KaraFun sera retiré dès sa connexion.'));
  await page.update({ queueClearPending: true, removalPending: 2, kf: world.kf });
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
  assert.equal(page.$('spotifyPill').className, 'pill');
  assert.equal(page.$('spotifyChip').hidden, true, 'pas de pastille Spotify sur Scène sans Spotify');
  assert.equal(page.$('spotifyReconnectRow').hidden, true);
  assert.equal(page.$('spotifyLogin').disabled, true, 'sans Client ID, pas de connexion possible');
  assert.equal(page.$('spotifyConnected').hidden, true);
  assert.equal(page.$('spotifyRedirect').textContent, 'http://127.0.0.1:3000/spotify/callback');
  // Client ID : enregistré en quittant le champ, jamais pendant la frappe ou le collage.
  const clientId = page.$('spotifyClientId');
  const status = id => page.doc.body.querySelector(`[data-save-status="${id}"]`).textContent;
  await page.type(clientId, 'court');
  await page.change(clientId);
  assert.equal(page.postsTo('/api/staff/spotify').length, 0, 'identifiant invalide : rien ne part');
  assert.match(status('spotifyClientId'), /^Non enregistré : colle le « Client ID »/);
  await page.type(clientId, '  0123456789abcdef  ');
  assert.equal(page.postsTo('/api/staff/spotify').length, 0, 'pas d’envoi pendant la frappe');
  await page.change(clientId);
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'client', clientId: '0123456789abcdef' });
  assert.equal(status('spotifyClientId'), 'Enregistré ✓');
  await page.update({ spotify: { ...world.spotify, configured: true, clientId: '0123456789abcdef',
    health: { state: 'disconnected', device: null, checkedAt: 0, retryAt: 0 } } });
  assert.equal(page.$('spotifyPill').textContent, 'Spotify non connecté');
  assert.equal(page.$('spotifyPill').className, 'pill bad');
  assert.equal(page.$('spotifyChip').hidden, false, 'Spotify configuré : pastille sur Scène');
  assert.equal(page.$('spotifyChip').textContent, 'Spotify non connecté');
  assert.equal(page.$('spotifyChip').className, 'pill bad');
  assert.equal(page.$('spotifyReconnectRow').hidden, false, 'bouton « Reconnecter Spotify »');
  assert.equal(page.$('spotifyReconnect').textContent, 'Reconnecter Spotify');
  assert.equal(page.$('spotifyText').textContent, '', 'pas d’heure de vérification sans connexion');
  assert.equal(page.$('spotifyLogin').disabled, false);
  assert.equal(page.$('spotifyClientId').value, '0123456789abcdef');

  // Connexion depuis le PC du bar : la page Spotify s'ouvre, sans avertissement.
  page.replies['/api/staff/spotify'] = body => body.action === 'auth-url' ? { url: 'https://accounts.spotify.com/authorize?client_id=fake' } : { ok: true };
  await page.click(page.$('spotifyLogin'));
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'auth-url' });
  assert.deepEqual(page.opened, [['https://accounts.spotify.com/authorize?client_id=fake', '_blank', 'noopener']]);
  assert.notEqual(page.toast().text, 'Fais cette connexion depuis le PC du bar : Spotify revient sur son adresse locale.');
  // « Reconnecter Spotify » : même parcours que la première connexion.
  await page.click(page.$('spotifyReconnect'));
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'auth-url' });
  assert.equal(page.opened.length, 2);
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

  // Connecté, pas encore vérifié : pastille neutre.
  const at = Date.now() - 60000;
  const ready = { state: 'ready', device: { id: 'dev-2', name: 'Enceinte', active: true }, checkedAt: at, okAt: at, retryAt: 0, message: null };
  const connected = { configured: true, connected: true, clientId: '0123456789abcdef', autoResume: true, autoPause: false,
    deviceId: 'dev-2', deviceName: 'Enceinte', player: { isPlaying: true, track: { title: 'Get Lucky', artist: 'Daft Punk' },
      device: { name: 'Enceinte' } }, lastAction: { at, kind: 'resume', ok: true }, lastError: null,
    devices: [{ id: 'dev-1', name: 'PC du bar', type: 'Computer', active: false }, { id: 'dev-2', name: 'Enceinte', type: 'Speaker', active: true }] };
  await page.update({ spotify: { ...connected, health: { state: 'unknown', device: null, checkedAt: 0 } } });
  assert.equal(page.$('spotifyConnected').hidden, false);
  assert.equal(page.$('spotifyReconnectRow').hidden, true);
  assert.equal(page.$('spotifyPill').textContent, 'Spotify : vérification…');
  assert.equal(page.$('spotifyPill').className, 'pill');
  assert.equal(page.$('spotifyChip').textContent, 'Spotify : vérification…');
  assert.equal(page.$('spotifyChip').className, 'pill');
  // Prêt : lecture en cours, appareil choisi, dernière action, heure de vérification.
  await page.update({ spotify: { ...connected, health: ready } });
  assert.equal(page.$('spotifyPill').textContent, 'Spotify · Enceinte');
  assert.equal(page.$('spotifyPill').className, 'pill ok');
  assert.equal(page.$('spotifyChip').textContent, 'Spotify · Enceinte');
  assert.equal(page.$('spotifyChip').className, 'pill ok');
  assert.equal(page.$('tabDotPlus').hidden, true, 'tout va bien : pas de point sur « Plus »');
  assert.equal(page.$('spotifyText').textContent, `Spotify : Get Lucky — Daft Punk sur Enceinte. Dernière action à ${hhmm(at)} : relance. Vérifié à ${hhmm(at)}.`);
  assert.equal(page.$('spotifyAutoResume').checked, true);
  assert.equal(page.$('spotifyAutoPause').checked, false);
  assert.equal(page.$('spotifyDelay').value, 3, 'délai par défaut');
  assert.deepEqual(texts(page.$('spotifyDevice').options), ['Appareil actif de Spotify', 'PC du bar', 'Enceinte (actif)'],
    'liste gardée par le serveur : elle survit au rechargement de la page');
  assert.equal(page.$('spotifyDevice').value, 'dev-2');
  // Aucun appareil (204) : orange, plus vert ; le nom de l'appareil choisi est donné.
  await page.update({ spotify: { ...connected, player: { isPlaying: false, track: { title: 'Get Lucky' } }, deviceId: 'dev-3', deviceName: '',
    lastAction: { at, kind: 'pause', ok: true, result: 'already' }, lastError: 'Spotify : appareil introuvable.',
    health: { state: 'no-device', device: { id: 'dev-3', name: 'Tablette', active: false }, checkedAt: at } } });
  assert.equal(page.$('spotifyPill').textContent, 'Spotify : aucun appareil');
  assert.equal(page.$('spotifyPill').className, 'pill warn');
  assert.equal(page.$('spotifyChip').textContent, 'Spotify : aucun appareil');
  assert.equal(page.$('spotifyChip').className, 'pill warn');
  assert.equal(page.$('tabDotPlus').hidden, false);
  assert.equal(page.$('spotifyText').textContent, `Spotify connecté, aucun appareil : ouvre Spotify sur Tablette. Spotify : appareil introuvable. Spotify : Get Lucky. Dernière action à ${hhmm(at)} : pause (rien à faire). Vérifié à ${hhmm(at)}.`);
  assert.deepEqual(texts(page.$('spotifyDevice').options), ['Appareil actif de Spotify', 'PC du bar', 'Enceinte (actif)', 'Appareil choisi (introuvable)'],
    'l’appareil choisi reste affiché, même absent');
  assert.equal(page.$('spotifyDevice').value, 'dev-3', 'et sélectionné : pas de bascule silencieuse');
  await page.update({ spotify: { ...connected, deviceId: '', deviceName: '', health: { state: 'no-device', device: null, checkedAt: at } } });
  assert.match(page.$('spotifyText').textContent, /^Spotify connecté, aucun appareil : ouvre Spotify sur l’appareil voulu\./);
  // Injoignable : rouge, heure du nouvel essai.
  const retryAt = Date.now() + 120000;
  await page.update({ spotify: { ...connected, player: null, deviceId: '', devices: [], lastAction: { at, kind: 'resume', ok: false },
    lastError: 'Spotify ne répond pas correctement (réseau).', health: { state: 'error', device: null, checkedAt: at, retryAt, message: 'réseau' } } });
  assert.equal(page.$('spotifyPill').textContent, 'Spotify injoignable');
  assert.equal(page.$('spotifyPill').className, 'pill bad');
  assert.equal(page.$('spotifyChip').textContent, 'Spotify injoignable');
  assert.equal(page.$('spotifyText').textContent, `Spotify injoignable, nouvel essai à ${hhmm(retryAt)}. Spotify ne répond pas correctement (réseau). Dernière action à ${hhmm(at)} : relance en échec. Vérifié à ${hhmm(at)}.`);
  assert.deepEqual(texts(page.$('spotifyDevice').options), ['Appareil actif de Spotify']);
  await page.update({ spotify: { ...connected, lastError: null, health: { state: 'error', device: null, checkedAt: at, retryAt } } });
  assert.equal(page.$('tabDotPlus').hidden, false, 'injoignable : point sur « Plus » même sans erreur d’action');

  // Pastille de la Scène : mène au panneau Spotify.
  await page.click(page.$('spotifyChip'));
  assert.equal(page.doc.body.dataset.tab, 'plus');

  // Appareil enregistré absent : affiché « (introuvable) », sélectionné, rien n'est envoyé.
  await page.update({ spotify: { ...connected, deviceId: 'pc-OLD', deviceName: 'PC du bar', health: { state: 'no-device', device: { id: 'pc-OLD', name: 'PC du bar' }, checkedAt: at },
    devices: [{ id: 'dev-2', name: 'Enceinte', active: false }] } });
  const before = page.postsTo('/api/staff/spotify').length;
  await page.poll();
  assert.deepEqual(texts(page.$('spotifyDevice').options), ['Appareil actif de Spotify', 'Enceinte', 'PC du bar (introuvable)']);
  assert.equal(page.$('spotifyDevice').value, 'pc-OLD');
  assert.equal(page.postsTo('/api/staff/spotify').length, before, 'aucun choix d’appareil envoyé sans geste du bar');
  // Liste ouverte (focus) : pas reconstruite sous le doigt.
  page.$('spotifyDevice').focus();
  await page.update({ spotify: { ...page.world.spotify, devices: [{ id: 'autre', name: 'Autre' }] } });
  assert.deepEqual(texts(page.$('spotifyDevice').options), ['Appareil actif de Spotify', 'Enceinte', 'PC du bar (introuvable)']);
  page.doc.activeElement = null;
  // Rechoisir l'appareil introuvable : le nom part sans « (introuvable) ».
  await page.update({ spotify: { ...page.world.spotify, devices: [{ id: 'dev-2', name: 'Enceinte' }] } });
  page.replies['/api/staff/spotify'] = { ok: true };
  await page.change(page.$('spotifyDevice'), 'pc-OLD');
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'device', deviceId: 'pc-OLD', deviceName: 'PC du bar' });

  // « Vérifier Spotify » (ancien « Actualiser la liste ») : vérification sur le serveur.
  assert.equal(page.$('spotifyCheck').textContent, 'Vérifier Spotify');
  page.replies['/api/staff/spotify'] = body => body.action === 'refresh'
    ? { ok: true, health: { state: 'ready', device: { id: 'pc-NEW', name: 'PC du bar', active: true }, checkedAt: Date.now(), adopted: true } } : { ok: true };
  await page.update({ spotify: { ...connected, health: ready } });
  await page.click(page.$('spotifyCheck'));
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'refresh' });
  assert.deepEqual(page.toast(), { text: 'Spotify connecté · PC du bar', bad: false });
  await page.change(page.$('spotifyDevice'), 'dev-1');
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'device', deviceId: 'dev-1', deviceName: 'PC du bar' });
  assert.equal(page.toast().text, 'Appareil Spotify enregistré');
  await page.change(page.$('spotifyDevice'), 'dev-2');
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'device', deviceId: 'dev-2', deviceName: 'Enceinte' },
    'le nom enregistré ne garde pas « (actif) »');
  await page.change(page.$('spotifyDevice'), '');
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'device', deviceId: '', deviceName: '' });
  page.replies['/api/staff/spotify'] = { ok: true, health: { state: 'no-device', device: { id: 'dev-2', name: 'Enceinte' } } };
  await page.click(page.$('spotifyCheck'));
  assert.deepEqual(page.toast(), { text: 'Spotify connecté, aucun appareil : ouvre Spotify sur Enceinte', bad: true });
  page.replies['/api/staff/spotify'] = { ok: true, health: { state: 'disconnected', device: null } };
  await page.click(page.$('spotifyCheck'));
  assert.deepEqual(page.toast(), { text: 'Spotify non connecté', bad: true });
  page.replies['/api/staff/spotify'] = { status: 401, error: 'Connexion Spotify expirée.' };
  await page.click(page.$('spotifyCheck'));
  assert.deepEqual(page.toast(), { text: 'Connexion Spotify expirée.', bad: true });
  page.replies['/api/staff/spotify'] = { ok: true };

  // Réglages de relance et de coupure : chacun s'enregistre seul.
  page.replies['/api/staff/spotify'] = body => { if (body.action === 'options') Object.assign(page.world.spotify, body); return { ok: true }; };
  await page.change(page.$('spotifyAutoResume'), false);
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'options', autoResume: false });
  assert.equal(status('spotifyAutoResume'), 'Enregistré ✓');
  await page.poll();
  assert.equal(page.$('spotifyAutoResume').checked, false, 'relu sur le serveur, la case suit le serveur');
  await page.change(page.$('spotifyAutoPause'), true);
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'options', autoPause: true });
  await page.type(page.$('spotifyDelay'), '0');
  page.runTimers(800);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'options', resumeDelaySec: 0 }, '0 s permis');
  const sent = page.postsTo('/api/staff/spotify').length;
  for (const value of ['', '  ', '11']) {
    await page.type(page.$('spotifyLead'), value);
    page.runTimers(800);
    await page.flush();
    assert.equal(status('spotifyLead'), 'Non enregistré : entre 0 et 10 secondes', `silence « ${value} »`);
  }
  assert.equal(page.postsTo('/api/staff/spotify').length, sent, 'un champ vidé n’enregistre pas 0 s en silence');
  await page.type(page.$('spotifyLead'), '4');
  page.runTimers(800);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/spotify').body, { action: 'options', pauseLeadSec: 4 });
  // Spotify connecté : changer de Client ID le déconnecte, le bar confirme.
  page.confirmAnswer = false;
  await page.type(clientId, 'fedcba98765432100');
  await page.change(clientId);
  assert.match(page.confirms.at(-1), /^Changer le Client ID déconnecte Spotify/);
  assert.equal(clientId.value, '0123456789abcdef', 'changement refusé : l’ancien identifiant revient');
  page.confirmAnswer = true;

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
  assert.equal(page.$('diag').textContent, 'ÉtatSaisis le code KaraFun ci-dessus.');
  assert.match(page.$('staffAlerts').textContent, /KaraFun n’a pas de code/, 'alerte visible sur tous les écrans');
  await page.click(page.in('staffAlerts', '[data-alert-goto]'));
  assert.equal(page.doc.body.dataset.tab, 'plus');
  assert.equal(page.doc.activeElement, page.$('code'));
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
  assert.equal(page.doc.getElementById('saveRules'), null, 'plus de bouton « Enregistrer les règles »');
  page.$('requirePresence').checked = true;
  dispatch(page.$('requirePresence'), 'input');
  await page.change(page.$('requirePresence'));
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { requirePresence: true });
  assert.equal(page.postsTo('/api/staff/settings').length, 1, 'une case cochée part une seule fois');
  for (const [id, value, body] of [['gap', '3', { gap: 3 }], ['cap', '5', { cap: 5 }], ['playDelaySec', '6', { playDelaySec: 6 }],
    ['pushDelaySec', '20', { pushDelaySec: 20 }], ['repeatWarnMin', '0', { repeatWarnMin: 0 }],
    ['presenceGraceSec', '60', { presenceGraceSec: 60 }], ['presenceMaxSkips', '4', { presenceMaxSkips: 4 }]]) {
    await page.type(page.$(id), value);
    page.runTimers(800);
    await page.flush();
    assert.deepEqual(page.lastPost('/api/staff/settings').body, body, id);
  }
  // Champ vidé : rien n'est envoyé (0 serait une vraie valeur), et la saisie reste.
  const sent = page.postsTo('/api/staff/settings').length;
  await page.type(page.$('pushDelaySec'), '');
  page.runTimers(800);
  await page.flush();
  assert.equal(page.postsTo('/api/staff/settings').length, sent);
  assert.equal(page.doc.body.querySelector('[data-save-status="pushDelaySec"]').textContent, 'Non enregistré : entre 0 et 180 secondes');
  // Une règle changée ailleurs s'affiche dès que le champ n'est plus modifié.
  await page.update({ settings: { ...world.settings, presenceGraceSec: 90, gap: 3 } });
  assert.equal(page.$('presenceGraceSec').value, 90);
  assert.equal(page.$('pushDelaySec').value, '', 'la saisie refusée reste à corriger');
  // Pendant la frappe, un rafraîchissement ne remet pas l'ancienne valeur.
  page.$('cap').focus();
  await page.type(page.$('cap'), '7');
  page.doc.activeElement = null;
  await page.poll();
  assert.equal(page.$('cap').value, '7');
  page.runTimers(800);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { cap: 7 });
  // Page passée en arrière-plan : la saisie en attente part tout de suite.
  await page.type(page.$('gap'), '5');
  page.doc.hidden = true;
  for (const listener of page.doc.listeners.visibilitychange) listener({});
  await page.flush();
  page.doc.hidden = false;
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { gap: 5 });
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

// ------------------------------------------------------------------ v1.4 : retours du bar
test('duo improvisé : le partenaire choisi reste choisi pendant les rafraîchissements', async () => {
  const world = baseWorld();
  world.stage = { ours: true, ids: ['alice'], queueId: 'q-live', title: 'Seul', singers: [{ id: 'alice', name: 'Alice', table: 'Table 1' }] };
  const page = await openPage({ world });
  const select = page.$('markDuoPartner');
  select.focus();
  select.value = 'dora';
  await page.poll();
  assert.equal(select.value, 'dora', 'choix gardé pendant que la liste a le focus');
  page.doc.activeElement = null; // liste native refermée sur le téléphone
  await page.poll();
  assert.equal(page.$('markDuoPartner').value, 'dora', 'choix gardé après la fermeture de la liste');
  await page.click(page.$('markDuoBtn'));
  assert.match(page.confirms.at(-1), /Dora/, 'la confirmation nomme le partenaire');
  assert.deepEqual(page.lastPost('/api/staff/duo-mark').body, { queueId: 'q-live', partnerId: 'dora' });
});

test('réglage Battle tapé puis champ quitté : le rafraîchissement ne remet pas l’ancienne valeur', async () => {
  const world = baseWorld();
  world.settings = { ...world.settings, battleCooldownMin: 10, battleRejectedCooldownMin: 5, battleVoteMin: 5, battleMinVoters: 5 };
  const page = await openPage({ world });
  const field = page.$('battleCooldownMin');
  assert.equal(String(field.value), '10');
  field.focus();
  await page.type(field, '20');
  page.doc.activeElement = null; // clavier du téléphone refermé
  await page.poll();
  assert.equal(page.$('battleCooldownMin').value, '20');
});

test('repère tapé puis champ quitté : le rafraîchissement ne l’efface pas', async () => {
  const page = await openPage();
  const note = () => page.in('identityBody', '[data-identity-person="alice"] [data-identity-note]');
  note().focus();
  await page.type(note(), 'casquette');
  page.doc.activeElement = null;
  await page.poll();
  assert.equal(note().value, 'casquette');
});

test('enregistrement automatique : une réponse en retard n’écrase pas la saisie suivante', async () => {
  const page = await openPage();
  const field = page.$('gap');
  const status = () => page.doc.body.querySelector('[data-save-status="gap"]').textContent;
  let release;
  page.replies['/api/staff/settings'] = () => new Promise(resolve => { release = resolve; });
  await page.type(field, '6');
  page.runTimers(800);
  await page.flush();
  assert.equal(status(), 'Enregistrement…');
  await page.type(field, '7');
  release({ ok: true });
  await page.flush();
  assert.equal(status(), 'Modifié…', 'la réponse pour 6 ne marque pas 7 comme enregistré');
  assert.equal(field.value, '7');
  page.replies['/api/staff/settings'] = { ok: true };
  page.runTimers(800);
  await page.flush();
  assert.deepEqual(page.postsTo('/api/staff/settings').map(post => post.body), [{ gap: 6 }, { gap: 7 }]);
  assert.equal(status(), 'Enregistré ✓');
  // Refus pendant qu'une nouvelle saisie attend : la nouvelle saisie prime.
  page.replies['/api/staff/settings'] = () => new Promise(resolve => { release = resolve; });
  await page.type(field, '8');
  page.runTimers(800);
  await page.flush();
  await page.type(field, '9');
  release({ status: 400, error: 'Refusé.' });
  await page.flush();
  assert.equal(status(), 'Modifié…');
  // Valeur remise à celle du serveur avant l'envoi : rien ne part.
  const sent = page.postsTo('/api/staff/settings').length;
  await page.type(field, '4');
  page.runTimers(800);
  await page.flush();
  assert.equal(page.postsTo('/api/staff/settings').length, sent);
  // La confirmation s'efface après quelques secondes.
  page.runTimers(2600);
});

test('téléphone : cinq onglets, onglet gardé dans l’adresse, Retour d’Android et badges', async () => {
  const world = queueWorld();
  world.soloInvitations = [{ id: 'one', tableId: 'Comptoir', expiresAt: Date.now() + 60000 }];
  const page = await openPage({ world, hash: '#file' });
  const body = page.doc.body;
  const tab = name => body.querySelector(`[data-tab-btn="${name}"]`);
  assert.equal(body.dataset.tab, 'file', 'onglet repris de l’adresse');
  assert.equal(tab('file').getAttribute('aria-current'), 'page');
  assert.ok(tab('file').classList.contains('on'));
  assert.deepEqual([...new Set(body.querySelectorAll('section.card').map(section => section.dataset.tab))],
    ['scene', 'file', 'accueil', 'reperes', 'plus'], 'chaque carte appartient à un onglet, dans l’ordre');
  assert.equal(page.$('tabBadgeFile').textContent, '8');
  assert.equal(page.$('tabBadgeFile').hidden, false);
  assert.equal(page.$('tabBadgeAccueil').textContent, '1', 'invitations individuelles en attente');
  assert.equal(page.$('tabDotPlus').hidden, true);
  await page.click(tab('accueil'));
  assert.equal(body.dataset.tab, 'accueil');
  assert.equal(page.history.at(-1).url, `/staff?key=${KEY}#accueil`);
  assert.equal(page.stored.get('bar-tab'), 'accueil');
  await page.poll();
  assert.equal(body.dataset.tab, 'accueil', 'le rafraîchissement ne change jamais d’onglet');
  const steps = page.history.length;
  await page.click(tab('accueil'));
  assert.equal(page.history.length, steps, 'retoucher l’onglet ouvert n’ajoute pas d’étape');
  await page.click(tab('plus'));
  await page.back();
  assert.equal(body.dataset.tab, 'accueil', 'Retour revient à l’onglet précédent');
  // Une fenêtre ouverte a sa propre étape : Retour la ferme sans changer d'onglet.
  await page.click(tab('accueil'));
  const before = page.history.length;
  await page.click(page.in('tBody', '[data-table-more="1"]'));
  assert.equal(page.history.length, before + 1);
  await page.click(page.$('tableSheetQr'));
  assert.equal(page.history.length, before + 1, 'le QR reprend l’étape de la fiche');
  assert.equal(page.history.at(-1).state.dialog, 'tableQrDialog');
  await page.back();
  assert.equal(page.$('tableQrDialog').open, false, 'Retour ferme d’abord une fenêtre ouverte');
  assert.equal(body.dataset.tab, 'accueil', 'sans changer d’onglet');
  await page.click(page.in('tBody', '[data-table-qr="1"]'));
  await page.click(page.$('tableQrClose'));
  assert.equal(page.history.length, before, 'fermée d’un bouton : son étape est retirée');
  // Fenêtre ouverte autrement (ancienne étape) : Retour la ferme aussi.
  page.$('shareDialog').showModal();
  await page.back();
  assert.equal(page.$('shareDialog').open, false);
  assert.equal(body.dataset.tab, 'file');
  await page.click(page.$('staffTabs'));
  assert.equal(body.dataset.tab, 'file', 'un appui hors des boutons ne change rien');
  // Point sur « Plus » : Battle demandée, KaraFun perdu ou Spotify en erreur.
  await page.update({ battle: { id: 5, phase: 'requested', selectedSong: { title: 'Africa' } } });
  assert.equal(page.$('tabDotPlus').hidden, false);
  await page.update({ battle: { phase: 'idle' }, spotify: { configured: true, connected: false, lastError: 'Spotify : erreur.' } });
  assert.equal(page.$('tabDotPlus').hidden, false);
  await page.update({ spotify: null, kf: { ...baseWorld().kf, ready: false, connected: false } });
  assert.equal(page.$('tabDotPlus').hidden, false);
  await page.update({ kf: baseWorld().kf, queue: [], soloInvitations: [] });
  assert.equal(page.$('tabDotPlus').hidden, true);
  assert.equal(page.$('tabBadgeFile').hidden, true, 'file vide : pas de badge');
  assert.equal(page.$('tabBadgeAccueil').hidden, true);
  // Sans onglet dans l'adresse : le dernier ouvert ; mémoire indisponible : Scène.
  const again = await openPage({ storage: { 'bar-tab': 'reperes' } });
  assert.equal(again.doc.body.dataset.tab, 'reperes');
  const strict = await openPage({ storageThrows: true, storage: { 'bar-tab': 'inconnu' } });
  assert.equal(strict.doc.body.dataset.tab, 'scene');
  await strict.click(strict.doc.body.querySelector('[data-tab-btn="plus"]'));
  assert.equal(strict.doc.body.dataset.tab, 'plus', 'fonctionne sans mémoire du navigateur');
  await strict.back();
  assert.equal(strict.doc.body.dataset.tab, 'scene');
});

test('barre du haut : état KaraFun du pont, alerte impossible à manquer, reconnexion et avertissements', async () => {
  const world = baseWorld();
  world.kf = { ...world.kf, connection: { phase: 'ready', level: 'ok', label: 'KaraFun connecté au bar', since: Date.now(), attempt: 0 } };
  const page = await openPage({ world });
  const pill = page.$('kfPill');
  assert.equal(pill.textContent, 'KaraFun connecté au bar');
  assert.equal(pill.className, 'pill ok');
  await page.update({ kf: { ...world.kf, ready: false, connection: { phase: 'retry', level: 'wait', label: 'Reconnexion à KaraFun…', since: Date.now(), attempt: 2 } } });
  assert.equal(pill.className, 'pill warn');
  assert.equal(page.in('staffAlerts', '.kf-alert'), null, 'une reconnexion en cours n’alarme pas');
  await page.update({ kf: { ...world.kf, ready: false, connection: { phase: 'failed', level: 'error', label: 'KaraFun injoignable', since: Date.now(), attempt: 5 } } });
  assert.equal(pill.className, 'pill bad');
  assert.equal(page.in('staffAlerts', '.kf-alert span').textContent, 'KaraFun injoignable : les titres ne partent plus.');
  await page.click(page.in('staffAlerts', '[data-alert-reconnect]'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'reconnect' });
  assert.equal(page.toast().text, 'Reconnexion…');
  // Reconnecter garde une connexion qui marche : la réponse du serveur le dit.
  page.replies['/api/staff/kf'] = { ok: true, kept: true, message: 'KaraFun est déjà connecté : connexion gardée.' };
  await page.click(page.in('staffAlerts', '[data-alert-reconnect]'));
  assert.equal(page.toast().text, 'KaraFun est déjà connecté : connexion gardée.');
  delete page.replies['/api/staff/kf'];
  // Nom encore tenu par l'ancienne connexion : alerte impossible à fermer,
  // avec le changement de nom immédiat.
  const alert = 'KaraFun garde encore l’ancienne connexion de FileKaraoke : un autre nom sera pris dans 1 min 20.';
  await page.update({ kf: { ...world.kf, ready: false, connection: { phase: 'waiting-name', level: 'wait', label: 'KaraFun garde encore l’ancienne connexion de FileKaraoke', since: Date.now(), attempt: 1, canRename: true, alert } } });
  assert.equal(page.in('staffAlerts', '.kf-alert span').textContent, alert);
  assert.equal(page.in('staffAlerts', '.kf-alert [data-dismiss-alert]'), null, 'cette alerte ne se ferme pas');
  await page.click(page.in('staffAlerts', '[data-alert-rename]'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'new-name' });
  assert.match(page.toast().text, /redonne-lui les droits/);
  await page.update({ kf: { ...world.kf, ready: false, connection: { phase: 'waiting-name', level: 'wait', label: 'Nom en cours', since: Date.now(), attempt: 1, canRename: false, alert } } });
  assert.equal(page.in('staffAlerts', '[data-alert-rename]'), null, 'pas de bouton quand le changement de nom n’est plus possible');
  // Conflit de nom pendant une attente de relance (KaraFun relancé puis
  // reparti) : KaraFun est absent, le nom n'est pas redemandé. L'alerte
  // « Reconnecter » passe avant celle du conflit, comme avant la limite.
  await page.update({ kf: { ...world.kf, ready: false, connection: { phase: 'retry', level: 'error',
    label: 'KaraFun fermé ou télécommande désactivée : nouvel essai dans 6 s', since: Date.now(), attempt: 2, canRename: true, alert,
    nameConflict: { holder: 'FileKaraoke', since: Date.now(), tries: 1, switchAt: Date.now() + 80000 } } } });
  assert.equal(page.in('staffAlerts', '.kf-alert span').textContent, 'KaraFun fermé ou télécommande désactivée : nouvel essai dans 6 s : les titres ne partent plus.');
  assert.ok(page.in('staffAlerts', '[data-alert-reconnect]'), 'Reconnecter à portée de doigt');
  assert.equal(page.in('staffAlerts', '[data-alert-rename]'), null, 'pas de changement de nom pendant que KaraFun est absent');
  // KaraFun limite les essais depuis ce PC : alerte impossible à fermer, sans
  // bouton « Reconnecter » (inutile de cliquer) ; un clic reçoit une erreur.
  const limit = 'KaraFun limite les essais depuis cette connexion jusqu’à 20:00 : inutile de cliquer, la file réessaiera seule. Un téléphone sur un autre réseau (4G/5G) n’est pas concerné.';
  await page.update({ kf: { ...world.kf, ready: false, connection: { phase: 'retry', level: 'error', label: 'KaraFun limite les essais jusqu’à 20:00',
    since: Date.now(), attempt: 1, canRename: false, alert: limit, discovery: { used: 1, limit: 12, hourEndsAt: Date.now(), limitedUntil: Date.now() } } } });
  assert.equal(pill.textContent, 'KaraFun limite les essais jusqu’à 20:00');
  assert.equal(pill.className, 'pill bad');
  assert.equal(page.in('staffAlerts', '.kf-alert span').textContent, limit);
  assert.equal(page.in('staffAlerts', '[data-alert-reconnect]'), null, 'pas de Reconnecter : la file réessaiera seule');
  assert.equal(page.in('staffAlerts', '[data-alert-rename]'), null);
  assert.equal(page.in('staffAlerts', '.kf-alert [data-dismiss-alert]'), null, 'cette alerte ne se ferme pas');
  page.replies['/api/staff/kf'] = { ok: false, kept: false, message: limit };
  await page.click(page.$('reconnectBtn'));
  assert.deepEqual(page.toast(), { text: limit, bad: true });
  page.replies['/api/staff/kf'] = { ok: false };
  await page.click(page.$('reconnectBtn'));
  assert.deepEqual(page.toast(), { text: 'Action refusée', bad: true });
  delete page.replies['/api/staff/kf'];
  // Code vide : le refus du serveur s'affiche en erreur.
  page.replies['/api/staff/connect'] = { status: 400, error: 'Saisis le code affiché par KaraFun.' };
  page.$('code').value = '';
  await page.click(page.$('connectBtn'));
  assert.deepEqual(page.toast(), { text: 'Saisis le code affiché par KaraFun.', bad: true });
  delete page.replies['/api/staff/connect'];
  // Sans phrase du pont : état déduit comme avant.
  await page.update({ kf: { ...baseWorld().kf, ready: false, connected: false } });
  assert.equal(pill.textContent, 'KaraFun déconnecté');
  assert.match(page.$('staffAlerts').textContent, /KaraFun déconnecté : les titres ne partent plus\./);
  await page.update({ kf: { ...baseWorld().kf, ready: false, connected: true } });
  assert.equal(pill.textContent, 'Connexion…');
  assert.equal(page.in('staffAlerts', '.kf-alert'), null);
  await page.update({ kf: { ...baseWorld().kf, ready: false, connected: true, unreachable: true } });
  assert.equal(pill.textContent, 'KaraFun injoignable');
  await page.click(pill);
  assert.equal(page.doc.body.dataset.tab, 'plus', 'toucher l’état ouvre les réglages KaraFun');
  // Envoi ou lecture automatique coupés : avertissement sur Scène.
  const warn = page.$('autoWarn');
  assert.equal(warn.textContent, 'Envoi et lecture automatiques coupés');
  await page.update({ settings: { ...world.settings, auto: true } });
  assert.equal(warn.textContent, 'Lecture automatique coupée');
  await page.update({ settings: { ...world.settings, auto: false, autoPlay: true } });
  assert.equal(warn.textContent, 'Envoi automatique coupé');
  await page.click(page.doc.body.querySelector('[data-tab-btn="scene"]'));
  await page.click(warn);
  assert.equal(page.doc.body.dataset.tab, 'plus');
  await page.update({ settings: { ...world.settings, auto: true, autoPlay: true } });
  assert.equal(warn.hidden, true);
});

// KaraFun fermé ou code changé après les relances rapides : la file n'essaie
// plus seule. Le bar clique « Reconnecter » à l'ouverture, ou saisit le
// nouveau code ; pendant les relances rapides, l'alerte reste celle d'avant.
test('barre du haut : essais KaraFun arrêtés, alerte avec Reconnecter et Saisir le code', async () => {
  const world = baseWorld();
  const page = await openPage({ world });
  const pill = page.$('kfPill');
  const retrying = 'KaraFun fermé ou code changé : prochain essai à 17:40';
  await page.update({ kf: { ...world.kf, ready: false, connected: false, unreachable: true,
    connection: { phase: 'retry', level: 'error', label: retrying, since: Date.now(), attempt: 2, retryAt: Date.now() + 5000, alert: null } } });
  assert.equal(pill.textContent, retrying);
  assert.equal(page.in('staffAlerts', '.kf-alert span').textContent, `${retrying} : les titres ne partent plus.`, 'relances rapides : alerte inchangée');
  assert.deepEqual(texts(page.all('staffAlerts', '.kf-alert button')), ['Reconnecter']);
  await page.update({ kf: { ...world.kf, ready: false, connected: false, unreachable: true,
    connection: { phase: 'stopped', level: 'error', label: 'KaraFun fermé ou code changé : essais arrêtés', since: Date.now(), attempt: 0,
      retryAt: null, alert: null, canRename: false, nameConflict: null } } });
  assert.equal(pill.textContent, 'KaraFun fermé ou code changé : essais arrêtés');
  assert.equal(pill.className, 'pill bad');
  assert.equal(page.all('staffAlerts', '.kf-alert').length, 1);
  assert.equal(page.in('staffAlerts', '.kf-alert span').textContent,
    'KaraFun fermé ou code changé : la file n’essaie plus seule, les titres ne partent plus. Une fois KaraFun ouvert (télécommande activée), clique sur « Reconnecter » ; si le code a changé, utilise « Saisir le code ».');
  assert.deepEqual(texts(page.all('staffAlerts', '.kf-alert button')), ['Reconnecter', 'Saisir le code']);
  assert.equal(page.in('staffAlerts', '.kf-alert [data-dismiss-alert]'), null, 'cette alerte ne se ferme pas');
  assert.ok(page.in('staffAlerts', '[data-alert-reconnect]').className.includes('primary'));
  await page.click(page.in('staffAlerts', '[data-alert-reconnect]'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'reconnect' });
  assert.equal(page.toast().text, 'Reconnexion…');
  await page.click(page.in('staffAlerts', '[data-alert-goto]'));
  assert.equal(page.doc.body.dataset.tab, 'plus', 'Saisir le code ouvre les réglages KaraFun');
  assert.equal(page.doc.activeElement, page.$('code'));
});

test('soliste sur scène : prénom seul (carte, Repères, partenaires), autres solistes hors « Même table » (lot K)', async () => {
  const world = baseWorld();
  world.stage = { ours: true, ids: ['dora'], queueId: 'q-solo', singers: [{ id: 'dora', name: 'Dora', table: 'En solo', individual: true }], title: 'Solo' };
  world.people.push({ id: 'sam', name: 'Sam', tableId: 'Comptoir', active: true, songCount: 0, sung: 0 },
    { id: 's9', name: 'Solo 9', tableId: 'Comptoir', active: true, nameRequired: true, songCount: 0, sung: 0 });
  const page = await openPage({ world });
  assert.equal(page.in('stage', '[data-stage-person="dora"]').querySelector('.live-table'), null, 'pas de pastille « En solo »');
  assert.doesNotMatch(page.$('stage').textContent, /En solo/);
  assert.doesNotMatch(page.$('identityStage').textContent, /En solo/, 'Repères : prénom seul');
  assert.deepEqual(page.all('markDuoPartner', 'optgroup').map(g => g.getAttribute('label')), ['Autres personnes'],
    'les autres solistes ne sont pas « Même table »');
  const options = texts(page.$('markDuoPartner').options);
  assert.ok(options.includes('Sam') && options.includes('Alice — Table 1'), options.join(' | '));
  assert.ok(!options.some(text => /Solo 9|En solo/.test(text)), 'ni prénom provisoire ni nom de groupe');
});

test('sur scène : photo, repère de la personne et titre KaraFun sans fiche', async () => {
  const world = baseWorld();
  world.stage = { ours: true, ids: ['alice'], queueId: 'q1', singers: [{ id: 'alice', name: 'Alice', table: 'Table 1' }], title: 'Titre' };
  world.next = { ours: true, ids: ['dora'], singers: [{ id: 'dora', name: 'Dora', table: 'En solo', individual: true }], title: 'Suivant' };
  const page = await openPage({ world });
  const card = () => page.in('stage', '[data-stage-person="alice"]');
  assert.equal(card().querySelector('.marker-label').textContent, 'Repère');
  assert.equal(card().querySelector('[data-autosave="note"]').value, 't-shirt rouge');
  assert.equal(card().querySelector('.identity-avatar').textContent, 'A', 'initiale sans photo');
  const next = page.in('next', '[data-stage-person="dora"]');
  assert.equal(next.querySelector('img').src, '/photo/dora.jpg');
  assert.equal(next.querySelector('[data-autosave="note"]').value, '', 'sans repère, champ vide à remplir');
  assert.equal(next.querySelector('[data-autosave="note"]').placeholder, 'ex. t-shirt rouge');
  assert.equal(next.querySelector('.live-table'), null, 'Ensuite : soliste sans pastille de groupe');
  assert.equal(page.$('identityStageBox').hidden, false, 'Repères : la personne sur scène en tête');
  assert.ok(page.in('identityStage', '[data-identity-stage="alice"]'));
  // Repère modifié sur la carte : enregistré seul, recopié dans l'écran Repères.
  const input = card().querySelector('[data-autosave="note"]');
  input.focus();
  await page.type(input, 'veste verte');
  assert.equal(page.in('identityBody', '[data-identity-person="alice"] [data-identity-note]').value, 'veste verte');
  assert.equal(page.in('stage', '[data-save-status="note:alice"]').textContent, 'Modifié…');
  page.world.people[0] = { ...page.world.people[0], photoUrl: '/photo/alice.jpg' };
  await page.poll();
  assert.equal(card().querySelector('[data-autosave="note"]'), input, 'carte non redessinée pendant la saisie');
  page.doc.activeElement = null;
  await page.poll();
  assert.equal(card().querySelector('[data-autosave="note"]').value, 'veste verte', 'saisie gardée après la mise à jour');
  assert.equal(card().querySelector('img').src, '/photo/alice.jpg', 'photo affichée une fois la saisie finie');
  page.runTimers(1000);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/person/identify').body, { personId: 'alice', note: 'veste verte' });
  // Titre ajouté directement dans KaraFun : pas de fiche à montrer.
  await page.update({ stage: { ours: false, singer: 'Client', title: 'Manuel' } });
  assert.match(page.$('stage').textContent, /Client.*Ajouté dans KaraFun : pas de fiche.*Manuel/s);
  assert.equal(page.$('identityStageBox').hidden, true);
  // Titre de la file sans liste de chanteurs : retrouvée par les fiches.
  await page.update({ stage: { ours: true, ids: ['bruno'], title: 'Seul' } });
  assert.match(page.$('stage').textContent, /Bruno.*Table 1.*Repère/s);
  await page.update({ stage: { ours: true, ids: ['inconnu'], singer: 'Quelqu’un', title: 'Seul' } });
  assert.match(page.$('stage').textContent, /Quelqu’un.*Seul/s);
});

// Lot F : barre de lecture du titre sur scène, avancée seule chaque seconde
// (minuteur de 1100 ms), horloge du serveur corrigée par S.now.
test('barre de lecture sur scène : temps, reste, tempo, pause, durée inconnue, Battle, jamais sur « Ensuite »', async () => {
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const world = baseWorld();
    const progress = (fields = {}) => ({ elapsedSec: 102, durationSec: 237, paused: false, rate: 1, ...fields });
    world.now = now - 2000; // horloge du serveur 2 s en retard sur ce PC
    const stage = { ours: false, singer: 'Client', title: 'Manuel' };
    world.stage = { ...stage, progress: progress() };
    world.next = { ours: false, singer: 'Suivant', title: 'Après', progress: progress() };
    const page = await openPage({ world });
    const text = () => page.in('stageProgress', '.stage-progress-text')?.textContent;
    const width = () => page.in('stageProgress', '.stage-progress-fill')?.getAttribute('style');
    assert.equal(page.$('stageProgress').hidden, false);
    assert.equal(text(), '1:42 / 3:57 · reste 2:15');
    assert.equal(width(), 'width:43.0%');
    assert.equal(page.$('next').querySelector('.stage-progress-fill'), null, 'pas de barre sur le titre suivant');
    now += 1000;
    page.runTimers(1100);
    assert.equal(text(), '1:43 / 3:57 · reste 2:14', 'avance seule entre deux lectures');
    // Tempo +20 en direct : le titre avance plus vite, le reste raccourcit.
    await page.update({ now, stage: { ...stage, progress: progress({ elapsedSec: 120, durationSec: 240, rate: 1.2 }) } });
    assert.equal(text(), '2:00 / 4:00 · reste 1:40');
    now += 5000;
    page.runTimers(1100);
    assert.equal(text(), '2:06 / 4:00 · reste 1:35');
    // Pause : figée, plus de minuteur.
    await page.update({ now, stage: { ...stage, progress: progress({ elapsedSec: 60, durationSec: 200, paused: true }) } });
    assert.equal(text(), 'En pause · 1:00 / 3:20 · reste 2:20');
    now += 10000;
    page.runTimers(1100);
    page.runTimers(1100);
    assert.equal(text(), 'En pause · 1:00 / 3:20 · reste 2:20');
    // Titre plus long que prévu : barre pleine, jamais au-delà.
    await page.update({ now, stage: { ...stage, progress: progress({ elapsedSec: 250 }) } });
    assert.equal(text(), '3:57 / 3:57 · reste 0:00');
    assert.equal(width(), 'width:100.0%');
    // Durée inconnue, puis Battle (même avec une durée) : temps écoulé seul.
    await page.update({ now, stage: { ...stage, progress: progress({ elapsedSec: 75, durationSec: null }) } });
    assert.equal(text(), '1:15 écoulées');
    assert.equal(width(), undefined, 'pas de barre sans durée');
    await page.update({ now, stage: { ...stage, kind: 'battle', progress: progress({ elapsedSec: 75 }) } });
    assert.equal(text(), '1:15 écoulées');
    // État sans heure du serveur : valeur reçue montrée telle quelle.
    await page.update({ now: undefined, stage: { ...stage, progress: progress() } });
    now += 30000;
    page.runTimers(1100);
    assert.equal(text(), '1:42 / 3:57 · reste 2:15');
    await page.update({ stage: { ...stage, progress: null } });
    assert.equal(page.$('stageProgress').hidden, true);
    await page.update({ stage: null });
    assert.equal(page.$('stageProgress').hidden, true);
  } finally { Date.now = realNow; }
});

test('duo improvisé noté : changer de partenaire ou annuler, sur scène puis dans les derniers passages', async () => {
  const world = baseWorld();
  const markedAt = Date.now() - 120000;
  const alice = { id: 'alice', name: 'Alice', table: 'Table 1' }, dora = { id: 'dora', name: 'Dora', table: 'En solo', individual: true };
  world.stage = { ours: true, ids: ['alice', 'dora'], queueId: 'q-live', kind: 'duo', title: 'Ensemble', singers: [alice, dora],
    staffDuo: { partnerId: 'dora', partnerName: 'Dora', at: markedAt, canUndo: true, reason: null } };
  const page = await openPage({ world });
  assert.equal(page.$('markDuoBox').hidden, false);
  assert.equal(page.$('markDuoState').textContent, `Duo noté avec Dora à ${hhmm(markedAt)}.`);
  assert.equal(page.$('markDuoDoneActions').hidden, false);
  assert.equal(page.$('markDuoForm').hidden, true);
  page.confirmAnswer = false;
  await page.click(page.$('markDuoCancel'));
  assert.equal(page.confirms.at(-1), 'Annuler le duo noté avec Dora ? Alice chante seul ce titre ; Dora retrouve son tour.');
  assert.equal(page.postsTo('/api/staff/duo-unmark').length, 0);
  page.confirmAnswer = true;
  page.replies['/api/staff/duo-unmark'] = { ok: true, message: 'Duo avec Dora annulé : Alice chante seul ce titre.' };
  await page.click(page.$('markDuoCancel'));
  assert.deepEqual(page.lastPost('/api/staff/duo-unmark').body, { queueId: 'q-live' });
  assert.equal(page.toast().text, 'Duo avec Dora annulé : Alice chante seul ce titre.');
  // Changer de partenaire : la liste exclut le chanteur et l'ancien partenaire.
  await page.click(page.$('markDuoChange'));
  assert.equal(page.$('markDuoForm').hidden, false);
  assert.equal(page.$('markDuoDoneActions').hidden, true);
  assert.equal(page.$('markDuoBtn').textContent, 'Remplacer');
  assert.equal(page.$('markDuoLabel').textContent, 'Qui chante vraiment avec Alice ? Dora retrouvera son tour.');
  assert.deepEqual(texts(page.$('markDuoPartner').options), ['Choisir…', 'Bruno — Table 1']);
  await page.poll();
  assert.equal(page.$('markDuoForm').hidden, false, 'le rafraîchissement garde le changement ouvert');
  await page.click(page.$('markDuoKeep'));
  assert.equal(page.$('markDuoForm').hidden, true);
  await page.click(page.$('markDuoChange'));
  page.$('markDuoPartner').value = 'bruno';
  await page.click(page.$('markDuoBtn'));
  assert.equal(page.confirms.at(-1), 'Remplacer Dora par Bruno dans le duo avec Alice ? Dora retrouve son tour ; Bruno garde le sien.');
  assert.deepEqual(page.lastPost('/api/staff/duo-mark').body, { queueId: 'q-live', partnerId: 'bruno', replace: true });
  page.confirmAnswer = false;
  await page.click(page.$('markDuoBtn'));
  assert.equal(page.postsTo('/api/staff/duo-mark').length, 1, 'remplacement refusé : rien ne part');
  page.confirmAnswer = true;
  // Trop tard : plus d'annulation possible.
  await page.update({ stage: { ...world.stage, staffDuo: { ...world.stage.staffDuo, canUndo: false, reason: 'Trop tard : Dora a déjà rechanté' } } });
  assert.equal(page.$('markDuoState').textContent, `Duo noté avec Dora à ${hhmm(markedAt)}. Trop tard : Dora a déjà rechanté.`);
  assert.equal(page.$('markDuoDoneActions').hidden, true);
  assert.equal(page.$('markDuoForm').hidden, true);
  // Nouvelle chanson : la liste repart sur « Choisir… ».
  await page.update({ stage: { ours: true, ids: ['alice'], queueId: 'q-2', title: 'Seul', singers: [alice] } });
  page.$('markDuoPartner').value = 'bruno';
  await page.poll();
  assert.equal(page.$('markDuoPartner').value, 'bruno');
  await page.update({ stage: { ours: true, ids: ['alice'], queueId: 'q-3', title: 'Autre', singers: [alice] } });
  assert.equal(page.$('markDuoPartner').value, '', 'autre chanteur sur scène : choix remis à zéro');
  page.$('markDuoCancel').onclick();
  assert.equal(page.postsTo('/api/staff/duo-unmark').length, 1, 'sans duo noté, rien à annuler');

  // Derniers passages : annuler ou changer un duo noté après la chanson.
  const at = Date.now() - 600000;
  await page.update({ stageHistory: [
    { id: 'h1', at, endedAt: at + 1000, onStage: false, title: 'Fini', people: [{ ...alice, active: true }, { ...dora, active: true }],
      staffDuo: { partnerId: 'dora', partnerName: 'Dora', at, canUndo: true, reason: null } },
    { id: 'h2', at, endedAt: at + 1000, onStage: false, title: 'Plus ancien', people: [{ ...alice, active: true }],
      staffDuo: { partnerId: 'bruno', partnerName: 'Bruno', at, canUndo: false, reason: 'Trop tard : Bruno a déjà rechanté' } }] });
  assert.match(page.$('stageHistoryCount').textContent, /^2$/);
  assert.match(page.$('stageHistory').textContent, /Duo noté au bar avec Dora/);
  assert.match(page.$('stageHistory').textContent, /Trop tard : Bruno a déjà rechanté/);
  assert.equal(page.in('stageHistory', '[data-history-unmark="h2"]'), null);
  page.confirmAnswer = false;
  await page.click(page.in('stageHistory', '[data-history-unmark="h1"]'));
  assert.equal(page.confirms.at(-1), 'Annuler le duo noté avec Dora sur « Fini » ? Dora retrouve son tour.');
  page.confirmAnswer = true;
  await page.click(page.in('stageHistory', '[data-history-unmark="h1"]'));
  assert.deepEqual(page.lastPost('/api/staff/duo-unmark').body, { stageEntryId: 'h1' });
  await page.click(page.in('stageHistory', '[data-history-change="h1"]'));
  const select = page.in('stageHistory', '[data-history-partner]');
  assert.deepEqual(texts(select.options), ['Choisir…', 'Bruno — Table 1']);
  await page.click(page.in('stageHistory', '[data-history-replace="h1"]'));
  assert.deepEqual(page.toast(), { text: 'Choisis d’abord le second chanteur dans la liste.', bad: true });
  page.in('stageHistory', '[data-history-partner]').value = 'bruno';
  page.confirmAnswer = false;
  await page.click(page.in('stageHistory', '[data-history-replace="h1"]'));
  assert.equal(page.postsTo('/api/staff/duo-mark').length, 1);
  page.confirmAnswer = true;
  await page.click(page.in('stageHistory', '[data-history-replace="h1"]'));
  assert.deepEqual(page.lastPost('/api/staff/duo-mark').body, { stageEntryId: 'h1', partnerId: 'bruno', replace: true });
  assert.equal(page.in('stageHistory', '[data-history-partner]'), null, 'liste refermée après le remplacement');
  await page.click(page.in('stageHistory', '[data-history-change="h1"]'));
  await page.click(page.in('stageHistory', '[data-history-change="h1"]'));
  assert.equal(page.in('stageHistory', '[data-history-partner]'), null, 'second appui : liste refermée');
  await page.click(page.in('stageHistory', '[data-history-change="h1"]'));
  await page.update({ stageHistory: [] });
  assert.equal(page.$('stageHistory').textContent, 'Aucun passage pour le moment.');
});

test('file au téléphone : menu ⋯ par ligne et mode sélection', async () => {
  const page = await openPage({ world: queueWorld() });
  const line = index => rows(page)[index];
  assert.equal(line(2).querySelector('[data-row-menu]'), null, 'sans action, pas de menu');
  await page.click(line(4).querySelector('[data-row-menu]'));
  assert.ok(line(4).querySelector('.row-actions').classList.contains('open'));
  assert.equal(line(4).querySelector('[data-row-menu]').getAttribute('aria-expanded'), 'true');
  await page.poll();
  assert.ok(line(4).querySelector('.row-actions').classList.contains('open'), 'menu gardé ouvert au rafraîchissement');
  await page.click(line(4).querySelector('[data-row-menu]'));
  assert.ok(!line(4).querySelector('.row-actions').classList.contains('open'));
  await page.click(line(4).querySelector('[data-row-menu]'));
  page.world.queue = page.world.queue.filter(q => q.id !== 'duo1');
  await page.poll();
  assert.equal(page.all('qBody', '.row-actions.open').length, 0, 'ligne disparue : menu refermé');
  // Mode sélection : les cases n'apparaissent qu'à la demande.
  await page.click(page.$('selectMode'));
  assert.equal(page.$('selectMode').getAttribute('aria-pressed'), 'true');
  assert.ok(page.$('selectMode').closest('.queue-panel').classList.contains('selecting'));
  assert.equal(page.$('selectMode').textContent, 'Terminer la sélection');
  await page.change(line(3).querySelector('[data-pick]'), true);
  assert.equal(page.$('removeSelected').disabled, false);
  await page.click(page.$('selectMode'));
  assert.equal(page.$('removeSelected').disabled, true, 'quitter le mode vide la sélection');
  assert.equal(page.$('selectMode').textContent, 'Sélectionner');
  await page.click(page.$('selectMode'));
  await page.click(page.$('selectMode'));
  assert.equal(page.$('selectMode').getAttribute('aria-pressed'), 'false');
});

test('accueil : donner un chanteur à un autre téléphone depuis une recherche par prénom', async () => {
  const page = await openPage();
  const results = () => texts(page.all('transferResults', '[data-transfer-person]'));
  await page.type(page.$('transferSearch'), 'table 1');
  assert.deepEqual(results(), ['Alice Table 1', 'Bruno Table 1'], 'personnes présentes seulement');
  await page.type(page.$('transferSearch'), 'zzz');
  assert.equal(page.$('transferResults').textContent, 'Aucun chanteur présent à ce nom.');
  await page.type(page.$('transferSearch'), '');
  assert.equal(page.$('transferResults').innerHTML, '');
  await page.type(page.$('transferSearch'), 'DOR');
  assert.deepEqual(results(), ['Dora'], 'un soliste : son prénom seul');
  page.replies['/api/staff/person/share'] = { code: '1234', expiresAt: Date.now() + 600000 };
  await page.click(page.in('transferResults', '[data-transfer-person="dora"]'));
  assert.deepEqual(page.lastPost('/api/staff/person/share').body, { personId: 'dora' });
  assert.equal(page.$('shareDialog').open, true);
  assert.equal(page.$('shareTitle').textContent, 'Accès à Dora');
  assert.match(page.$('shareHelp').textContent, /perdra seulement ce chanteur/);
  await page.click(page.$('transferResults'));
  assert.equal(page.postsTo('/api/staff/person/share').length, 1, 'un appui hors d’un prénom ne fait rien');
});

test('scène : demandes de duo en attente et Battle à décider sans quitter l’écran', async () => {
  const world = baseWorld();
  const at = Date.now() - 30000;
  world.joinRequests = [{ ownerId: 'alice', ownerName: 'Alice', requesterId: 'bruno', requesterName: 'Bruno', entryId: 'e1', title: 'Africa', at, seenAt: null },
    { ownerId: 'dora', ownerName: 'Dora', requesterId: 'alice', requesterName: 'Alice', entryId: 'e2', title: 'Hello', seenAt: at }];
  const page = await openPage({ world });
  assert.equal(page.$('joinRequestsBox').hidden, false);
  // Le bar sait qui n'a pas encore vu sa demande, pour aller le lui dire.
  assert.deepEqual(texts(page.all('joinRequestsList', '.join-request')),
    [`Bruno demande à chanter « Africa » avec Alice · ${hhmm(at)} · pas encore vue par Alice`, 'Alice demande à chanter « Hello » avec Dora · vue']);
  await page.update({ joinRequests: [] });
  assert.equal(page.$('joinRequestsBox').hidden, true);
  assert.equal(page.$('battleStrip').hidden, true, 'rien à décider : pas de Battle sur Scène');
  await page.update({ battle: { id: 4, phase: 'requested', selectedSong: { title: 'Africa' }, voters: 3, eligible: 5, threshold: 3, yesVotes: 3 } });
  assert.equal(page.$('battleStrip').hidden, false);
  assert.equal(page.$('battleStripText').textContent, page.$('battleStatus').textContent);
  assert.equal(page.$('battleActions').hidden, false);
  await page.update({ battle: { phase: 'idle' } });
  assert.equal(page.$('battleStrip').hidden, true);
  assert.equal(page.$('battleStripText').textContent, '');
});

// ------------------------------------------------------------------ réglages de titre
// Tonalité, tempo, voix guide et chœurs : le bar règle le titre en cours en
// direct (Scène), tous les titres à venir (File, menu ⋯) et décide si les
// chanteurs peuvent régler les leurs (Plus).
const unknownSupport = () => ({ pitch: 'unknown', tempo: 'unknown', trackVolume: 'unknown', queueItemOptions: 'unknown', addOptions: 'unknown' });
function tuneWorld() {
  const world = baseWorld();
  world.settings.singerSongSettings = true;
  world.stage = { ours: true, kind: null, queueId: 7, ids: ['alice'], song: { title: 'Tube', artist: 'Star', entryId: 'st1' } };
  world.songSettings = { enabled: true, ranges: { pitch: { min: -6, max: 6, step: 1 }, tempo: { min: -50, max: 50, step: 5 },
    volume: { min: 0, max: 100, step: 25 } }, defaults: { pitch: 0, tempo: 0, guide: 0, backing: 53 },
  permissions: { manageVolumes: true, manageQueue: true }, support: unknownSupport(), notice: null,
  live: { queueId: 7, pitch: 0, tempo: 0, guide: 0, backing: 53, voices: { 5: 0 }, tracks: [4, 5], entryId: 'st1', title: 'Tube', settings: null } };
  world.queue = [
    { source: 'karafun', ours: true, queueId: 9, pos: 1, name: 'Alice', singer: 'Alice', ids: ['alice'], tracks: [5],
      song: { entryId: 'k1', title: 'Déjà chargé', artist: 'A', settings: { pitch: 2, tempo: -10 } } },
    { source: 'envoi', ours: true, pos: 2, name: 'Dora', ids: ['dora'], song: { entryId: 's1', title: 'En route', settings: null } },
    { source: 'helper', id: 'bruno', pos: 3, name: 'Bruno', ids: ['bruno'], song: { entryId: 'b1', title: 'Rock', artist: 'R', settings: null } },
    { source: 'helper', id: 'duo1', pos: 4, name: 'Alice & Dora', ids: ['alice', 'dora'], kind: 'duo',
      song: { entryId: 'd1', title: 'Duo', settings: { guide: 50 } } },
  ];
  return world;
}
// Les valeurs affichées sont lues dans leur conteneur redessiné (le DOM simulé
// garde en cache les éléments remplacés par innerHTML).
const sheetPressed = (page, field) => page.all('songSheetBody', `[data-tune="${field}"]`).filter(node => node.getAttribute('aria-pressed') === 'true')
  .map(node => node.dataset.value);

test('réglages de titre : interrupteur des chanteurs dans « Plus », enregistré tout seul, état de KaraFun', async () => {
  const page = await openPage({ world: tuneWorld() });
  const status = () => page.doc.body.querySelector('[data-save-status="singerSongSettings"]').textContent;
  assert.equal(page.$('singerSongSettings').checked, true, 'activé par défaut');
  assert.equal(page.$('singerSongSettings').closest('section').dataset.tab, 'plus', 'dans l’onglet « Plus »');
  assert.match(page.$('songSettingsInfo').textContent, /Pas encore essayé avec ce KaraFun/);
  let release;
  page.replies['/api/staff/settings'] = body => new Promise(resolve => { release = () => { page.world.settings.singerSongSettings = body.singerSongSettings; resolve({ ok: true }); }; });
  await page.change(page.$('singerSongSettings'), false);
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { singerSongSettings: false });
  assert.equal(status(), 'Enregistrement…');
  await page.poll();
  assert.equal(page.$('singerSongSettings').checked, false, 'le rafraîchissement ne remet pas l’ancienne valeur');
  release();
  await page.flush();
  assert.equal(status(), 'Enregistré ✓');
  await page.poll();
  assert.equal(page.$('singerSongSettings').checked, false);
  // Réponses de KaraFun : réglages acceptés, refusés, droits retirés.
  page.world.songSettings.support = { ...unknownSupport(), pitch: 'ok', addOptions: 'ok' };
  await page.poll();
  assert.match(page.$('songSettingsInfo').textContent, /KaraFun a accepté : tonalité, réglages à l’ajout\./);
  page.world.songSettings.support.tempo = 'refused';
  page.world.songSettings.notices = { tempo: 'KaraFun refuse de régler le tempo : Not allowed' };
  page.world.songSettings.notice = 'KaraFun refuse de régler le tempo : Not allowed';
  page.world.songSettings.permissions = { manageVolumes: false, manageQueue: false };
  await page.poll();
  const info = page.$('songSettingsInfo').textContent;
  assert.match(info, /KaraFun refuse de régler le tempo : Not allowed/);
  assert.match(info, /« Personnaliser la chanson en cours » refusé à FileKaraoke/);
  assert.match(info, /« Éditer la file d’attente » refusé à FileKaraoke/);
  page.world.kf.ready = false;
  await page.poll();
  assert.equal(page.$('songSettingsInfo').textContent, '', 'KaraFun déconnecté : rien à dire');
});

test('réglages de titre : la carte « Sur scène » règle le titre en cours en direct, valeurs lues dans KaraFun', async () => {
  const page = await openPage({ world: tuneWorld() });
  const live = page.world.songSettings.live;
  assert.equal(page.$('liveTuneBox').hidden, false);
  assert.equal(page.in('liveTune', '[id="livePitch"]').textContent, '0');
  assert.equal(page.in('liveTune', '[id="liveTempo"]').textContent, '0 %');
  assert.equal(page.$('liveTuneSummary').textContent, 'Réglages en direct · réglages d’origine');
  await page.click(page.in('liveTune', '[data-live="pitch"][data-step="1"]'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'pitch', value: 1, queueId: 7 }, 'le titre affiché est visé');
  assert.equal(page.in('liveTune', '[id="livePitch"]').textContent, '+1', 'valeur envoyée affichée en attendant KaraFun');
  assert.equal(page.$('liveTuneStatus').textContent, 'Envoyé à KaraFun…');
  await page.poll();
  assert.equal(page.in('liveTune', '[id="livePitch"]').textContent, '+1', 'le rafraîchissement ne remet pas l’ancienne valeur tout de suite');
  live.pitch = 1;
  await page.poll();
  assert.equal(page.$('liveTuneStatus').textContent, 'Appliqué par KaraFun ✓');
  assert.equal(page.$('liveTuneSummary').textContent, 'Réglages en direct · ♯ +1');
  // Titre suivant : l'avis du titre précédent disparaît.
  live.queueId = 8;
  await page.poll();
  assert.equal(page.$('liveTuneStatus').textContent, '', 'nouveau titre : pas d’ancien avis');
  live.tracks = [4];
  await page.poll();
  assert.match(page.$('liveTune').textContent, /Ce titre n’a pas de voix guide\./);
  assert.equal(page.in('liveTune', '[data-live="guide"]'), null);
  live.tracks = [4, 5];
  await page.click(page.in('liveTune', '[data-live="tempo"][data-step="-5"]'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'tempo', value: -5, queueId: 8 });
  await page.click(page.in('liveTune', '[data-live="guide"][data-value="50"]'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'track', track: 'guide', value: 50, queueId: 8 });
  await page.click(page.in('liveTune', '[data-live="backing"][data-value="0"]'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'track', track: 'backing', value: 0, queueId: 8 });
  // KaraFun n'applique pas : au bout de quelques secondes, la valeur de KaraFun revient.
  page.runTimers(8000);
  await page.poll();
  assert.equal(page.in('liveTune', '[id="liveTempo"]').textContent, '0 %');
  assert.equal(page.$('liveTuneStatus').textContent, 'KaraFun n’a pas confirmé ce réglage : vérifie dans KaraFun.');
  // Voix guide restée à 25 d'un titre à l'autre : le résumé la montre (coupée par défaut).
  live.guide = 25;
  await page.poll();
  assert.match(page.$('liveTuneSummary').textContent, /guide 25/);
  live.guide = 0;
  // Titre changé entre-temps : le refus du serveur est affiché.
  page.replies['/api/staff/kf'] = { status: 400, error: 'Le titre a changé : réglage non envoyé.' };
  await page.click(page.in('liveTune', '[data-live="pitch"][data-step="1"]'));
  assert.equal(page.$('liveTuneStatus').textContent, 'Non appliqué : Le titre a changé : réglage non envoyé.');
  page.replies['/api/staff/kf'] = { ok: true };
  // Refus du serveur.
  page.replies['/api/staff/kf'] = { status: 400, error: 'Ce titre n’a pas de chœurs.' };
  await page.click(page.in('liveTune', '[data-live="backing"][data-value="100"]'));
  assert.equal(page.$('liveTuneStatus').textContent, 'Non appliqué : Ce titre n’a pas de chœurs.');
  assert.equal(page.in('liveTune', '[id="liveBacking"]').textContent.includes('100'), true, 'les choix restent affichés');
  page.replies['/api/staff/kf'] = { ok: true };
  // Pistes du titre : pas de chœurs.
  live.tracks = [5];
  await page.poll();
  assert.equal(page.in('liveTune', '[data-live="backing"]'), null, 'titre sans chœurs');
  assert.match(page.$('liveTune').textContent, /Ce titre n’a pas de chœurs\./);
  // Droit « Personnaliser la chanson en cours » refusé : tout est désactivé, avec l'explication.
  page.world.songSettings.permissions.manageVolumes = false;
  await page.poll();
  assert.equal(page.in('liveTune', '[data-live="pitch"][data-step="1"]').disabled, true);
  assert.match(page.$('liveTuneReason').textContent, /KaraFun ne laisse pas FileKaraoke personnaliser la chanson en cours/);
  page.world.songSettings.permissions.manageVolumes = true;
  // Tonalité refusée par KaraFun : seule la tonalité est désactivée.
  page.world.songSettings.support = { ...unknownSupport(), pitch: 'refused' };
  page.world.songSettings.notices = { pitch: 'KaraFun refuse de régler la tonalité : non pris en charge' };
  page.world.songSettings.notice = 'KaraFun refuse de régler la tonalité : non pris en charge';
  await page.poll();
  assert.equal(page.in('liveTune', '[data-live="pitch"][data-step="1"]').disabled, true);
  assert.equal(page.in('liveTune', '[data-live="tempo"][data-step="5"]').disabled, false);
  assert.match(page.$('liveTuneReason').textContent, /KaraFun refuse de régler la tonalité/);
  // Battle ou rien en cours : pas de réglage en direct.
  await page.update({ stage: { ...page.world.stage, kind: 'battle' } });
  assert.equal(page.$('liveTuneBox').hidden, true);
  page.world.songSettings.live = null;
  await page.update({ stage: null });
  assert.equal(page.$('liveTuneBox').hidden, true);
});

test('réglages de titre : « File », menu ⋯ → Réglages, fiche enregistrée toute seule sans écrasement au rafraîchissement', async () => {
  const page = await openPage({ world: tuneWorld() });
  const row = entryId => page.in('qBody', `[data-song-settings="${entryId}"]`).closest('.queue-item');
  assert.equal(row('k1').querySelector('.badge.tune').textContent, '♯ +2 · tempo −10 %', 'badge des réglages dans la file');
  assert.ok(page.in('qBody', '[data-song-settings="s1"]'), 'titre en cours d’envoi : réglable');
  let release;
  page.replies['/api/staff/song/settings'] = body => new Promise(resolve => {
    release = () => { page.world.queue.find(q => q.song.entryId === body.entryId).song.settings = body.settings; resolve({ ok: true, applied: 'list' }); };
  });
  await page.click(page.in('qBody', '[data-song-settings="b1"]'));
  assert.equal(page.$('songSheet').open, true);
  assert.equal(page.$('songSheetTitle').textContent, 'Réglages · Rock');
  assert.match(page.$('songSheetInfo').textContent, /Bruno/);
  assert.match(page.$('songSheetBody').textContent, /Si le titre en a\./);
  assert.deepEqual(sheetPressed(page, 'backing'), [], 'chœurs à 53 par défaut');
  assert.match(page.$('songSheetBody').textContent, /Réglage de KaraFun : 53/);
  await page.click(page.in('songSheetBody', '[data-tune="tempo"][data-step="-5"]'));
  assert.equal(page.in('songSheetBody', '[id="sheetTempo"]').textContent, '−5 %');
  assert.equal(page.$('songSheetStatus').textContent, 'Modifié…');
  page.runTimers(700);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/song/settings').body, { personId: 'bruno', entryId: 'b1', settings: { tempo: -5, guideVoices: {} } });
  assert.equal(page.$('songSheetStatus').textContent, 'Enregistrement…');
  await page.poll();
  assert.equal(page.in('songSheetBody', '[id="sheetTempo"]').textContent, '−5 %', 'le rafraîchissement de 2 s n’écrase pas le réglage en cours d’envoi');
  release();
  await page.flush();
  assert.equal(page.$('songSheetStatus').textContent, 'Enregistré ✓');
  await page.poll();
  assert.equal(page.in('songSheetBody', '[id="sheetTempo"]').textContent, '−5 %');
  assert.equal(row('b1').querySelector('.badge.tune').textContent, 'tempo −5 %');
  await page.click(page.in('songSheetBody', '[data-tune="guide"][data-value="75"]'));
  await page.click(page.$('songSheetReset'));
  assert.equal(page.in('songSheetBody', '[id="sheetTempo"]').textContent, '0 %');
  page.runTimers(700);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/song/settings').body.settings, { guideVoices: {} }, 'réinitialiser : réglages de KaraFun (clé des autres voix toujours envoyée)');
  release();
  await page.flush();
  // Fermer la fiche : un changement en attente part tout de suite.
  await page.click(page.in('songSheetBody', '[data-tune="pitch"][data-step="1"]'));
  await page.click(page.$('songSheetClose'));
  assert.equal(page.$('songSheet').open, false);
  assert.deepEqual(page.lastPost('/api/staff/song/settings').body.settings, { pitch: 1, guideVoices: {} });
  release();
  await page.flush();

  // Titre déjà dans KaraFun, sans chœurs, droit « Éditer la file » refusé.
  page.world.songSettings.permissions.manageQueue = false;
  page.replies['/api/staff/song/settings'] = { ok: true, applied: 'start' };
  await page.poll();
  await page.click(page.in('qBody', '[data-song-settings="k1"]'));
  assert.equal(page.in('songSheetBody', '[id="sheetPitch"]').textContent, '+2');
  assert.equal(page.in('songSheetBody', '[data-tune="backing"]'), null, 'titre sans chœurs');
  assert.match(page.$('songSheetNote').textContent, /appliqués au début du titre/);
  await page.click(page.in('songSheetBody', '[data-tune="pitch"][data-step="-1"]'));
  page.runTimers(700);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/song/settings').body, { personId: 'alice', entryId: 'k1', settings: { pitch: 1, tempo: -10, guideVoices: {} } });
  assert.equal(page.$('songSheetStatus').textContent, 'Enregistré ✓ · appliqué au début du titre');
  // Le titre monte sur scène pendant que la fiche est ouverte.
  page.world.queue = page.world.queue.filter(q => q.song.entryId !== 'k1');
  page.world.stage = { ...page.world.stage, song: { title: 'Déjà chargé', entryId: 'k1' } };
  page.world.songSettings.live.entryId = 'k1';
  await page.poll();
  assert.match(page.$('songSheetNote').textContent, /Ce titre est sur scène : règle-le en direct sur l’écran Scène\./);
  assert.equal(page.in('songSheetBody', '[data-tune="pitch"][data-step="1"]').disabled, true);
  // Duo, pistes pas encore connues : « Voix 1 » et « Voix 2 », chacune la sienne ; refus du serveur.
  await page.click(page.$('songSheetClose'));
  page.replies['/api/staff/song/settings'] = { status: 409, error: 'Ce titre n’est plus prévu : il a peut-être déjà été chanté ou retiré.' };
  await page.click(page.in('qBody', '[data-song-settings="d1"]'));
  assert.equal(page.$('songSheetBody').textContent.includes('Duo : les deux voix guides'), false, 'plus de voix 2 qui suit la voix 1');
  assert.match(page.$('songSheetBody').textContent, /Voix 1[\s\S]*Voix 2Si le titre en a deux\./);
  assert.deepEqual(sheetPressed(page, 'guide'), ['50']);
  assert.deepEqual(sheetPressed(page, 'voice:6'), ['0'], 'voix 2 sans réglage : coupée');
  await page.click(page.in('songSheetBody', '[data-tune="guide"][data-value="0"]'));
  await page.click(page.in('songSheetBody', '[data-tune="voice:6"][data-value="25"]'));
  assert.deepEqual(sheetPressed(page, 'voice:6'), ['25']);
  page.runTimers(700);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/song/settings').body.settings, { guide: 0, guideVoices: { 6: 25 } });
  assert.equal(page.$('songSheetStatus').textContent, 'Non enregistré : Ce titre n’est plus prévu : il a peut-être déjà été chanté ou retiré. · Réessayer');
  // Retirée de la file : la fiche le dit.
  page.world.queue = page.world.queue.filter(q => q.song.entryId !== 'd1');
  await page.poll();
  assert.match(page.$('songSheetNote').textContent, /Ce titre n’est plus dans la file\./);
  // Bouton Retour d'Android : la fiche se ferme sans changer d'onglet.
  await page.back();
  assert.equal(page.$('songSheet').open, false);
});

test('réglages de titre : silence de KaraFun, avis par fonction et ancienne télécommande expliqués au bar', async () => {
  const page = await openPage({ world: tuneWorld() });
  const tune = page.world.songSettings;
  const pitchUp = () => page.in('liveTune', '[data-live="pitch"][data-step="1"]');
  // KaraFun n'a pas répondu en 8 s : avis affiché, le bar peut réessayer.
  const silent = 'KaraFun n’a pas répondu aux réglages de tonalité en 8 s : vérifie dans KaraFun ; un nouvel essai reste possible.';
  tune.support = { ...unknownSupport(), pitch: 'silent' };
  tune.notices = { pitch: silent };
  tune.notice = silent;
  await page.poll();
  assert.equal(pitchUp().disabled, false, 'boutons actifs malgré le silence');
  assert.equal(page.$('liveTuneReason').hidden, false);
  assert.equal(page.$('liveTuneReason').textContent, silent);
  assert.match(page.$('songSettingsInfo').textContent, /n’a pas répondu aux réglages de tonalité/);
  assert.doesNotMatch(page.$('songSettingsInfo').textContent, /Pas encore essayé/);
  // Tonalité refusée, puis un titre de la file : sous les boutons, seul l'avis de la tonalité.
  tune.support = { ...unknownSupport(), pitch: 'refused', queueItemOptions: 'refused' };
  tune.notices = { pitch: 'KaraFun refuse de régler la tonalité : Not allowed',
    queueItemOptions: 'KaraFun refuse de régler un titre de la file : Not supported' };
  tune.notice = tune.notices.queueItemOptions;
  await page.poll();
  assert.equal(pitchUp().disabled, true);
  assert.equal(page.$('liveTuneReason').textContent, 'KaraFun refuse de régler la tonalité : Not allowed');
  const info = page.$('songSettingsInfo').textContent;
  assert.match(info, /refuse de régler la tonalité : Not allowed/);
  assert.match(info, /refuse de régler un titre de la file : Not supported/);
  // Ancienne télécommande d'un vrai KaraFun : rien n'est possible, c'est dit avant l'appui.
  tune.support = unknownSupport();
  tune.notices = {};
  tune.notice = null;
  tune.available = false;
  await page.poll();
  assert.equal(pitchUp().disabled, true);
  assert.equal(page.in('liveTune', '[data-live="guide"][data-value="50"]').disabled, true);
  assert.match(page.$('liveTuneReason').textContent, /^Cette ancienne télécommande KaraFun ne connaît pas les réglages de titre/);
  assert.match(page.$('songSettingsInfo').textContent, /ancienne télécommande KaraFun/);
  assert.match(page.$('songSettingsInfo').textContent, /les téléphones n’affichent pas le bouton « Réglages »/);
  assert.doesNotMatch(page.$('songSettingsInfo').textContent, /Pas encore essayé/);
  await page.click(page.in('qBody', '[data-song-settings="b1"]'));
  assert.match(page.$('songSheetNote').textContent, /ancienne télécommande KaraFun/);
  assert.equal(page.in('songSheetBody', '[data-tune="pitch"][data-step="1"]').disabled, true);
  assert.equal(page.$('songSheetReset').disabled, true);
});

// Lot G2 (décision D6) : un réglage par voix guide, sans curseur commun.
test('réglages de titre : une voix guide par curseur en direct et dans la fiche, résumé voix par voix', async () => {
  const world = tuneWorld();
  Object.assign(world.songSettings.live, { guide: 50, voices: { 5: 50, 6: 25 }, tracks: [4, 5, 6] });
  world.queue[0].tracks = [4, 5, 6];
  world.queue[0].song.settings = { guide: 50, guideVoices: { 6: 25 } };
  const page = await openPage({ world });
  const pressed = field => page.all('liveTune', `[data-live="${field}"]`).filter(node => node.getAttribute('aria-pressed') === 'true')
    .map(node => node.dataset.value);
  const labels = container => page.all(container, '.tune-label').map(node => node.textContent);
  assert.deepEqual(labels('liveTune'), ['Tonalité', 'Tempo', 'Voix 1', 'Voix 2', 'Chœurs'], 'pas de curseur commun');
  assert.equal(page.$('liveTuneSummary').textContent, 'Réglages en direct · voix 1 50 · voix 2 25');
  assert.deepEqual([pressed('guide'), pressed('voice:6')], [['50'], ['25']]);
  assert.ok(page.in('liveTune', '[id="liveVoice6"]'));
  // La voix 2 seule : envoyée par sa piste, affichée en attendant KaraFun.
  await page.click(page.in('liveTune', '[data-live="voice:6"][data-value="75"]'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'track', track: 6, value: 75, queueId: 7 });
  assert.deepEqual([pressed('guide'), pressed('voice:6')], [['50'], ['75']]);
  page.world.songSettings.live.voices = { 5: 50, 6: 75 };
  await page.poll();
  assert.equal(page.$('liveTuneStatus').textContent, 'Appliqué par KaraFun ✓');
  assert.equal(page.$('liveTuneSummary').textContent, 'Réglages en direct · voix 1 50 · voix 2 75');
  // Troisième voix annoncée par KaraFun : « Voix 3 », sans valeur connue encore.
  page.world.songSettings.live.tracks = [4, 5, 6, 7];
  await page.poll();
  assert.deepEqual(labels('liveTune'), ['Tonalité', 'Tempo', 'Voix 1', 'Voix 2', 'Voix 3', 'Chœurs']);
  assert.deepEqual(pressed('voice:7'), ['0']);
  await page.click(page.in('liveTune', '[data-live="voice:7"][data-value="100"]'));
  assert.deepEqual(page.lastPost('/api/staff/kf').body, { action: 'track', track: 7, value: 100, queueId: 7 });
  // Une seule voix : « Voix guide ». Pistes inconnues : voix 1, et voix 2 si le titre en a deux.
  page.world.songSettings.live.tracks = [4, 5];
  await page.poll();
  assert.deepEqual(labels('liveTune'), ['Tonalité', 'Tempo', 'Voix guide', 'Chœurs']);
  page.world.songSettings.live.tracks = null;
  await page.poll();
  assert.deepEqual(labels('liveTune'), ['Tonalité', 'Tempo', 'Voix 1', 'Voix 2', 'Chœurs']);
  assert.match(page.$('liveTune').textContent, /Si le titre en a deux\./);
  // File : badge voix par voix, d'après les pistes du titre.
  const row = entryId => page.in('qBody', `[data-song-settings="${entryId}"]`).closest('.queue-item');
  assert.equal(row('k1').querySelector('.badge.tune').textContent, 'voix 1 50 · voix 2 25');
  page.world.queue[0].tracks = [5];
  page.world.queue[0].song.settings = { guide: 50 };
  await page.poll();
  assert.equal(row('k1').querySelector('.badge.tune').textContent, 'guide 50', 'une seule voix : « guide »');
  page.world.queue[0].song.settings = { guideVoices: { 6: 0 } };
  page.world.songSettings.defaults.guide = 25;
  await page.poll();
  assert.equal(row('k1').querySelector('.badge.tune').textContent, 'voix 2 coupée', 'voix 2 réglée : nommée même si le titre n’en annonce qu’une');
  page.world.songSettings.defaults.guide = 0;
  // Fiche d'un titre chargé à deux voix : chaque voix enregistrée pour elle-même.
  page.world.queue[0].tracks = [4, 5, 6];
  page.world.queue[0].song.settings = { guide: 50, guideVoices: { 6: 25 } };
  page.replies['/api/staff/song/settings'] = { ok: true, applied: 'karafun' };
  await page.poll();
  await page.click(page.in('qBody', '[data-song-settings="k1"]'));
  assert.deepEqual(labels('songSheetBody'), ['Tonalité', 'Tempo', 'Voix 1', 'Voix 2', 'Chœurs']);
  assert.deepEqual(sheetPressed(page, 'voice:6'), ['25']);
  await page.click(page.in('songSheetBody', '[data-tune="voice:6"][data-value="100"]'));
  page.runTimers(700);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/song/settings').body.settings, { guide: 50, guideVoices: { 6: 100 } });
  assert.equal(page.$('songSheetStatus').textContent, 'Enregistré ✓ · envoyé à KaraFun');
});

test('réglages de titre : file au téléphone, nom du titre avant le badge des réglages', async () => {
  const page = await openPage({ world: tuneWorld() });
  const cell = page.in('qBody', '[data-song-settings="k1"]').closest('.queue-item').querySelector('.song-cell');
  // Cellule sur une ligne coupée à droite : le titre doit passer en premier, le badge ensuite.
  assert.deepEqual(cell.children.filter(child => typeof child !== 'string').map(child => child.className),
    ['song-title', 'badge tune', 'song-artist']);
});

test('réglages de titre : refus arrivé fiche fermée, signalé au bar par un message et sur la ligne de la file', async () => {
  const page = await openPage({ world: tuneWorld() });
  const row = entryId => page.in('qBody', `[data-song-settings="${entryId}"]`).closest('.queue-item');
  page.replies['/api/staff/song/settings'] = { status: 409, error: 'Ce titre est sur scène : règle-le en direct.' };
  await page.click(page.in('qBody', '[data-song-settings="b1"]'));
  await page.click(page.in('songSheetBody', '[data-tune="pitch"][data-step="1"]'));
  await page.click(page.$('songSheetClose'));
  await page.flush();
  assert.equal(page.$('songSheet').open, false);
  assert.deepEqual(page.toast(), { text: 'Réglages de « Rock » non enregistrés : Ce titre est sur scène : règle-le en direct.', bad: true });
  assert.equal(row('b1').querySelector('.badge.bad').textContent, 'réglages non enregistrés', 'le refus reste visible dans la file');
  await page.poll();
  assert.equal(row('b1').querySelector('.badge.bad').textContent, 'réglages non enregistrés');
  // La fiche rouverte : l'erreur et « Réessayer », qui enregistre.
  await page.click(page.in('qBody', '[data-song-settings="b1"]'));
  assert.match(page.$('songSheetStatus').textContent, /^Non enregistré : Ce titre est sur scène/);
  page.replies['/api/staff/song/settings'] = body => { page.world.queue.find(q => q.song.entryId === body.entryId).song.settings = body.settings; return { ok: true, applied: 'list' }; };
  await page.click(page.in('songSheetStatus', '[data-retry]'));
  await page.flush();
  assert.equal(page.$('songSheetStatus').textContent, 'Enregistré ✓');
  await page.poll();
  assert.equal(row('b1').querySelector('.badge.bad'), null);
  // Fiche ouverte sur ce titre : le refus reste dans la fiche, sans message en plus.
  page.replies['/api/staff/song/settings'] = { status: 409, error: 'Ce titre n’est plus prévu : il a peut-être déjà été chanté ou retiré.' };
  page.$('toast').hidden = true;
  page.$('toast').textContent = '';
  await page.click(page.in('songSheetBody', '[data-tune="tempo"][data-step="5"]'));
  page.runTimers(700);
  await page.flush();
  assert.match(page.$('songSheetStatus').textContent, /^Non enregistré/);
  assert.equal(page.toast().text, '', 'pas de message en double');
});

// ------------------------------------------------------------------ QA navigateur du 2026-10-03
// Found by /qa on 2026-10-03
// Report: .gstack/qa-reports/run-20261003T140104Z/qa-report-127.0.0.1-2026-10-03.md

// Regression: ISSUE-001 — le menu ⋯ des dernières lignes de la File ne doit pas finir sous la barre d'onglets
test('file au téléphone : le menu ⋯ des deux dernières lignes s’ouvre vers le haut', async () => {
  const world = queueWorld();
  world.queue.pop(); // dernière ligne : un titre de la salle, sans menu
  const page = await openPage({ world });
  const line = index => rows(page)[index];
  const last = rows(page).length - 1;
  await page.click(line(last).querySelector('[data-row-menu]'));
  assert.ok(line(last).querySelector('.row-actions').classList.contains('up'), 'dernière ligne : menu au-dessus');
  await page.click(line(last - 1).querySelector('[data-row-menu]'));
  assert.ok(line(last - 1).querySelector('.row-actions').classList.contains('up'), 'avant-dernière ligne : menu au-dessus');
  await page.click(line(3).querySelector('[data-row-menu]'));
  assert.ok(!line(3).querySelector('.row-actions').classList.contains('up'), 'plus haut : menu en dessous');
});

// Regression: ISSUE-002 — la fiche « Détails » affichait dans « Nom affiché » le nom d'une autre table
test('tables : la fiche « Détails » montre le nom de la table ouverte même si le champ a le focus', async () => {
  const page = await openPage();
  // Comme un navigateur, la fenêtre donne le focus à son premier champ en s'ouvrant.
  page.$('tableSheet').showModal = function () { this.open = true; page.$('tableSheetName').focus(); };
  const card = id => page.in('tBody', `[data-table-card="${id}"]`);
  await page.click(card('1').querySelector('[data-table-more]'));
  assert.equal(page.$('tableSheetName').value, 'Table 1');
  await page.click(page.$('tableSheetClose'));
  page.doc.activeElement = null;
  await page.click(card('2').querySelector('[data-table-more]'));
  assert.equal(page.$('tableSheetTitle').textContent, 'Table 2');
  assert.equal(page.$('tableSheetName').value, 'Table 2', 'le champ suit la table ouverte, pas la précédente');
  assert.equal(page.$('tableSheetHc').value, 2, 'places de la table ouverte');
  await page.poll();
  assert.equal(page.$('tableSheetName').value, 'Table 2', 'et le reste aux rafraîchissements');
  await page.click(page.$('tableSheetClose'));
  page.doc.activeElement = null; // le navigateur rend le focus au bouton « Détails »
  page.world.tables[1].name = 'Grande';
  await page.poll();
  await page.click(card('Comptoir').querySelector('[data-table-more]'));
  assert.equal(page.$('tableSheetName').value, 'En solo');
  assert.equal(page.postsTo('/api/staff/table/rename').length, 0, 'ouvrir une fiche n’enregistre rien');
});

// Regression: ISSUE-006 — « Nouvelle table » envoyait un renommage refusé et restait en rouge
test('tables : quitter le champ « Nouvelle table » n’envoie aucun renommage', async () => {
  const page = await openPage();
  const field = page.$('tableName');
  field.focus();
  await page.type(field, 'Zinc2');
  dispatch(field, 'blur', { bubbles: false });
  await page.flush();
  page.runTimers(1000);
  await page.flush();
  assert.equal(page.postsTo('/api/staff/table/rename').length, 0, 'aucun renommage pour une table qui n’existe pas');
  assert.equal(field.getAttribute('aria-invalid'), null, 'pas de bordure d’erreur');
  page.$('tableHeadcount').value = '4';
  page.doc.activeElement = null;
  await page.click(page.$('createTable'));
  assert.deepEqual(page.lastPost('/api/staff/table').body, { id: 'Zinc2', headcount: 4 });
  assert.equal(field.getAttribute('aria-invalid'), null);
  // Le nom affiché d'une table s'enregistre toujours depuis sa fiche.
  await page.click(page.in('tBody', '[data-table-more="2"]'));
  await page.type(page.$('tableSheetName'), 'Grande');
  page.runTimers(1000);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/table/rename').body, { tableId: '2', name: 'Grande' });
});

// Regression: ISSUE-007 — « Comptoir » refusé avec « Cette table existe déjà » alors qu'aucune table visible ne porte ce nom
test('tables : « Comptoir » est réservé au groupe En solo, et un nom affiché déjà pris est refusé', async () => {
  const page = await openPage();
  page.world.tables[1].name = 'Grande';
  await page.poll();
  for (const [name, message] of [['Comptoir', '« Comptoir » est réservé au groupe « En solo » : choisis un autre nom de table.'],
    ['comptoir 2', '« Comptoir » est réservé au groupe « En solo » : choisis un autre nom de table.'],
    ['grande', 'Une table s’appelle déjà « Grande ».'], ['En solo', 'Une table s’appelle déjà « En solo ».'],
    ['Table 1', 'Une table s’appelle déjà « Table 1 ».'], ['2', 'Cette table existe déjà.']]) {
    const count = page.posts.length;
    page.$('tableName').value = name; page.$('tableHeadcount').value = '4';
    await page.click(page.$('createTable'));
    assert.deepEqual(page.toast(), { text: message, bad: true }, name);
    assert.equal(page.posts.length, count, name);
  }
});

// Regression: ISSUE-003 — « Supprimer toutes les tables » coupait l'envoi automatique sans l'annoncer
test('fin de soirée : la confirmation annonce ce qui sera coupé et le message le rappelle', async () => {
  const world = baseWorld();
  world.settings.auto = true;
  world.settings.autoPlay = true;
  world.closing = { at: Date.now() + 3600000, passed: false, full: false, fitCount: 3, afterCount: 0 };
  world.stage = { ours: true, queueId: 3, ids: ['alice'], song: { title: 'Tube' } };
  world.tracked = [{ queueId: 3, startedAt: Date.now() }, { queueId: 4 }];
  const page = await openPage({ world });
  page.confirmAnswer = false;
  await page.click(page.$('clearTables'));
  const message = page.confirms.at(-1);
  assert.match(message, /^Supprimer les 3 tables/);
  assert.match(message, /L’envoi automatique sera coupé : titres encore dans KaraFun à vérifier\. Réactive-le dans « Plus » ensuite\./);
  assert.match(message, /La lecture automatique sera coupée et l’heure de fermeture retirée\. Cette action ne peut pas être annulée\.$/);
  page.confirmAnswer = true;
  page.replies['/api/staff/tables-clear'] = { ok: true, autoStopped: true, removalPending: 1 };
  await page.click(page.$('clearTables'));
  assert.equal(page.toast().text, 'Tables effacées. Vérifie et vide les titres restants dans KaraFun, puis réactive l’envoi automatique dans « Plus ».');
  // Rien dans KaraFun ni en envoi : l'envoi automatique reste actif, la confirmation ne l'annonce pas.
  const calm = baseWorld();
  calm.settings.auto = true;
  const quiet = await openPage({ world: calm });
  quiet.confirmAnswer = false;
  await quiet.click(quiet.$('clearTables'));
  assert.ok(!/envoi automatique sera coupé/.test(quiet.confirms.at(-1)), quiet.confirms.at(-1));
  assert.ok(!/lecture automatique/.test(quiet.confirms.at(-1)), 'lecture automatique déjà coupée : rien à annoncer');
});

// Regression: ISSUE-005 — Retour d'Android avec le menu ⋯ ouvert quittait l'onglet File
test('file au téléphone : Retour et Échap ferment d’abord le menu ⋯ ouvert', async () => {
  const page = await openPage({ world: queueWorld(), hash: '#plus' });
  await page.click(page.doc.body.querySelector('[data-tab-btn="file"]'));
  const line = index => rows(page)[index];
  const steps = page.history.length;
  await page.click(line(3).querySelector('[data-row-menu]'));
  assert.equal(page.history.length, steps + 1, 'le menu ouvert a sa propre étape');
  await page.back();
  assert.equal(page.doc.body.dataset.tab, 'file', 'Retour ne quitte pas l’onglet');
  assert.ok(!line(3).querySelector('.row-actions').classList.contains('open'), 'Retour ferme le menu');
  assert.equal(line(3).querySelector('[data-row-menu]').getAttribute('aria-expanded'), 'false');
  // Fermé d'un appui sur ⋯ : son étape est retirée, l'onglet précédent reste à un Retour.
  await page.click(line(3).querySelector('[data-row-menu]'));
  await page.click(line(3).querySelector('[data-row-menu]'));
  assert.equal(page.history.length, steps);
  // Un menu ouvert puis un autre : une seule étape.
  await page.click(line(3).querySelector('[data-row-menu]'));
  await page.click(line(4).querySelector('[data-row-menu]'));
  assert.equal(page.history.length, steps + 1);
  // Échap ferme le menu.
  dispatch(page.doc.body, 'keydown', { key: 'Escape' });
  await page.flush();
  assert.equal(page.all('qBody', '.row-actions.open').length, 0, 'Échap ferme le menu');
  assert.equal(page.history.length, steps, 'et retire son étape');
  await page.back();
  assert.equal(page.doc.body.dataset.tab, 'plus', 'Retour suivant : onglet précédent');
});

// Regression: ISSUE-009 — les lignes « Titre suivant » n'avaient pas « Retirer » dans le menu ⋯
test('file du bar : « Retirer » sur une ligne « Titre suivant » retire ce titre-là seulement', async () => {
  const page = await openPage({ world: queueWorld() });
  const future = rows(page)[6];
  assert.deepEqual(badges(future), ['Titre suivant']);
  const remove = future.querySelector('[data-rm-entry]');
  assert.ok(remove, 'le menu ⋯ propose « Retirer »');
  assert.equal(remove.textContent, 'Retirer');
  assert.equal(remove.getAttribute('aria-label'), 'Retirer « Plus tard » de Bruno');
  page.confirmAnswer = false;
  await page.click(remove);
  assert.equal(page.postsTo('/api/staff/remove-many').length, 0);
  page.confirmAnswer = true;
  page.replies['/api/staff/remove-many'] = { ok: true, removed: 1, message: '1 titre retiré.' };
  await page.click(rows(page)[6].querySelector('[data-rm-entry]'));
  assert.match(page.confirms.at(-1), /^Retirer « Plus tard » de la liste de Bruno \?/);
  assert.deepEqual(page.lastPost('/api/staff/remove-many').body, { items: [{ personId: 'bruno', entryId: 'e3' }] });
  assert.equal(page.toast().text, '1 titre retiré.');
});

// Regression: ISSUE-008 — une invitation de duo en attente n'apparaissait nulle part sur la page du bar
test('scène : les invitations de duo en attente sont listées avec leur état vu / pas encore vue', async () => {
  const world = baseWorld();
  world.duoInvites = [{ ownerId: 'chloe', ownerName: 'Chloé', partnerId: 'dora', partnerName: 'Dora', entryId: 'h1', title: 'Hotel California', seenAt: null },
    { ownerId: 'alice', ownerName: 'Alice', partnerId: 'bruno', partnerName: 'Bruno', entryId: 'h2', title: 'Mamma Mia', seenAt: Date.now() }];
  const page = await openPage({ world });
  assert.equal(page.$('joinRequestsBox').hidden, false, 'une invitation suffit à montrer l’encadré');
  assert.deepEqual(texts(page.all('joinRequestsList', '.join-request')),
    ['Chloé invite Dora à chanter « Hotel California » en duo · pas encore vue par Dora', 'Alice invite Bruno à chanter « Mamma Mia » en duo · vue']);
  await page.update({ duoInvites: [] });
  assert.equal(page.$('joinRequestsBox').hidden, true);
});

// Regression: relecture PR #11 — deux envois du même champ pouvaient être en
// route ensemble : arrivés dans le désordre, la dernière valeur était perdue.
test('enregistrement automatique : un envoi à la fois par champ, le suivant part après la réponse avec la dernière valeur', async () => {
  const page = await openPage({ world: tuneWorld() });
  const held = [];
  page.replies['/api/staff/song/settings'] = body => new Promise(resolve => held.push(() => {
    page.world.queue.find(q => q.song.entryId === body.entryId).song.settings = body.settings;
    resolve({ ok: true, applied: 'list' });
  }));
  const sent = () => page.posts.filter(post => post.path === '/api/staff/song/settings').map(post => post.body.settings);
  await page.click(page.in('qBody', '[data-song-settings="b1"]'));
  await page.click(page.in('songSheetBody', '[data-tune="pitch"][data-step="1"]'));
  page.runTimers(700);
  await page.flush();
  assert.deepEqual(sent(), [{ pitch: 1, guideVoices: {} }]);
  // Le premier envoi traîne (Wi-Fi) : un second « + » attend sa réponse.
  await page.click(page.in('songSheetBody', '[data-tune="pitch"][data-step="1"]'));
  page.runTimers(700);
  await page.flush();
  assert.deepEqual(sent(), [{ pitch: 1, guideVoices: {} }], 'pas de second envoi en parallèle');
  assert.equal(page.$('songSheetStatus').textContent, 'Modifié…');
  held.shift()();
  await page.flush();
  assert.deepEqual(sent(), [{ pitch: 1, guideVoices: {} }, { pitch: 2, guideVoices: {} }], 'la dernière valeur part après la réponse');
  held.shift()();
  await page.flush();
  await page.poll();
  assert.equal(page.$('songSheetStatus').textContent, 'Enregistré ✓');
  assert.deepEqual(page.world.queue.find(q => q.song.entryId === 'b1').song.settings, { pitch: 2, guideVoices: {} });

  // Case à cocher : deux appuis rapides, un seul envoi à la fois, la dernière valeur gagne.
  let release;
  page.replies['/api/staff/settings'] = body => new Promise(resolve => { release = () => {
    page.world.settings.singerSongSettings = body.singerSongSettings; resolve({ ok: true }); }; });
  const toggles = () => page.posts.filter(post => post.path === '/api/staff/settings').map(post => post.body.singerSongSettings);
  await page.change(page.$('singerSongSettings'), false);
  await page.change(page.$('singerSongSettings'), true);
  assert.deepEqual(toggles(), [false]);
  release();
  await page.flush();
  assert.deepEqual(toggles(), [false, true]);
  release();
  await page.flush();
  await page.poll();
  assert.equal(page.world.settings.singerSongSettings, true, 'le serveur garde le dernier choix');
  assert.equal(page.$('singerSongSettings').checked, true);
});

// ------------------------------------------------------------------ retours du test du 4 octobre
// Position d'un élément dans la page, pour comparer l'ordre d'affichage.
const order = (page, el) => [...page.doc.body.descendants()].indexOf(el);

test('Scène : l’interrupteur « Lecture automatique » est sur l’écran Scène, une seule fois, enregistré tout seul', async () => {
  const page = await openPage();
  const toggle = page.$('autoPlay');
  assert.equal(toggle.closest('section[data-tab]').dataset.tab, 'scene', 'lecture automatique sur l’écran Scène');
  assert.ok(order(page, toggle) > order(page, page.$('skipBtn')), 'sous Lecture / Passer');
  assert.ok(order(page, toggle) < order(page, page.$('next')), 'avant « Ensuite »');
  assert.equal(page.doc.body.querySelectorAll('input[type="checkbox"]').filter(el => /lecture/i.test(el.parent?.textContent || '')).length, 1,
    'un seul interrupteur de lecture automatique');
  assert.equal(page.$('auto').closest('section[data-tab]').dataset.tab, 'plus', 'l’envoi automatique reste dans « Plus »');
  await page.change(toggle, true);
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { autoPlay: true });
  // Avertissement « Lecture automatique coupée » : il mène à l'interrupteur de Scène.
  await page.update({ settings: { ...page.world.settings, auto: true, autoPlay: false } });
  assert.equal(page.$('autoWarn').textContent, 'Lecture automatique coupée');
  await page.click(page.in('staffTabs', '[data-tab-btn="file"]'));
  assert.equal(page.doc.body.dataset.tab, 'file');
  await page.click(page.$('autoWarn'));
  assert.equal(page.doc.body.dataset.tab, 'scene', 'lecture automatique seule coupée : direction Scène');
  await page.update({ settings: { ...page.world.settings, auto: false, autoPlay: true } });
  await page.click(page.$('autoWarn'));
  assert.equal(page.history.at(-1).state.barTab, 'plus', 'envoi automatique coupé : direction « Plus »');
});

test('Accueil : le formulaire « Nouvelle table » vient avant la liste des tables existantes', async () => {
  const page = await openPage();
  const form = page.$('createTable').closest('.new-table');
  assert.equal(form.closest('section[data-tab]').dataset.tab, 'accueil');
  assert.ok(order(page, form) < order(page, page.$('tBody')), 'ajouter une table avant de voir les tables');
  assert.ok(order(page, page.$('tableName')) < order(page, page.in('tBody', '[data-table-card="1"]')));
});

test('QR d’une table au téléphone : aucun champ de saisie ne prend le focus à l’ouverture (zoom de l’iPhone)', async () => {
  // iOS zoome sur un champ de saisie focalisé de moins de 16 px quand le focus
  // vient d'un toucher : la fenêtre du QR ne donne le focus à aucun champ.
  // Elle le donne à son titre, en haut : un élément focalisé plus bas (« Fermer »,
  // le lien) fait défiler la fenêtre à l'ouverture et sort le titre et le haut du
  // QR de l'écran d'un téléphone (test/staff-qr-layout.test.js le mesure).
  const page = await openPage({ dialogFocus: true });
  const field = () => /^(INPUT|SELECT|TEXTAREA)$/.test(page.doc.activeElement?.tagName || '');
  const atTop = (dialog, title, qr) => {
    assert.equal(field(), false, `${dialog} : focus à l’ouverture sur #${page.doc.activeElement?.id}`);
    assert.equal(page.doc.activeElement?.id, page.$(title).id, `${dialog} : le focus va au titre, en haut de la fenêtre`);
    assert.ok(order(page, page.doc.activeElement) < order(page, page.$(qr)), `${dialog} : rien sous le QR ne prend le focus`);
  };
  await page.click(page.in('tBody', '[data-table-qr="1"]'));
  assert.equal(page.$('tableQrDialog').open, true);
  atTop('QR de la table', 'tableQrName', 'tableQrImg');
  assert.equal(page.$('tableQrName').textContent, 'Table 1', 'le titre dit de quelle table il s’agit');
  await page.click(page.$('tableQrClose'));
  page.doc.activeElement = null;
  // Même QR ouvert depuis « Détails » › « Montrer le QR ».
  await page.click(page.in('tBody', '[data-table-more="1"]'));
  page.doc.activeElement = null;
  await page.click(page.$('tableSheetQr'));
  assert.equal(page.$('tableQrDialog').open, true);
  atTop('QR ouvert depuis Détails', 'tableQrName', 'tableQrImg');
  await page.click(page.$('tableQrClose'));
  // Les autres fenêtres de QR (personne seule, transfert) suivent la même règle.
  page.replies['/api/staff/solo-invite'] = { qr: 'data:image/png;base64,QR', url: 'http://192.168.1.20:3000/i/abc', expiresAt: Date.now() + 1800000 };
  await page.click(page.$('issueSoloInvitation'));
  assert.equal(page.$('soloInviteDialog').open, true);
  atTop('QR individuel', 'soloInviteTitle', 'soloInviteQr');
  await page.click(page.$('soloInviteClose'));
  page.replies['/api/staff/person/share'] = { code: '123456', qr: 'data:image/png;base64,QR', url: 'http://192.168.1.20:3000/t/1/abc#transfert', expiresAt: Date.now() + 600000 };
  await page.type(page.$('transferSearch'), 'Ali');
  await page.click(page.in('transferResults', '[data-transfer-person="alice"]'));
  assert.equal(page.$('shareDialog').open, true);
  atTop('QR de transfert', 'shareTitle', 'shareQr');
  assert.equal(page.$('shareTitle').textContent, 'Accès à Alice');
  // Un titre focalisé n'a pas de cadre de focus : ce n'est pas une commande.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  assert.match(css, /\.staff-dialog \[tabindex="-1"\]:focus\s*\{\s*outline:\s*none;?\s*\}/);
  for (const id of ['tableQrName', 'soloInviteTitle', 'shareTitle']) {
    assert.equal(page.$(id).getAttribute('tabindex'), '-1', `#${id} focalisable sans entrer dans l’ordre de tabulation`);
  }
});

test('page du bar au téléphone : champs de saisie d’au moins 16 px, QR entier dans la largeur, zoom laissé libre', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // Règles de chaque bloc @media (un seul niveau d'imbrication dans app.css).
  const media = [];
  for (const m of css.matchAll(/@media([^{]+)\{/g)) {
    let depth = 1, i = m.index + m[0].length;
    for (; depth && i < css.length; i++) depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
    const inner = css.slice(m.index + m[0].length, i - 1);
    media.push({ condition: m[1].trim(), rules: [...inner.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(r => ({ selectors: r[1].split(',').map(x => x.trim()), body: r[2] })) });
  }
  const phone = media.filter(block => /max-width:\s*899px/.test(block.condition));
  const sized = phone.flatMap(block => block.rules).filter(rule => {
    const size = /font-size:\s*(\d+)px/.exec(rule.body);
    return size && Number(size[1]) >= 16;
  });
  for (const tag of ['input', 'select', 'textarea']) {
    assert.ok(sized.some(rule => rule.selectors.some(sel => new RegExp(`^body\\.staff ${tag}\\b`).test(sel))),
      `au téléphone, les ${tag} de la page du bar ont au moins 16 px`);
  }
  const qr = /\.staff-qr\.big-qr\s*\{([^}]*)\}/.exec(css);
  assert.ok(qr && /width:\s*min\([^)]*100%[^)]*\)/.test(qr[1]), 'le grand QR ne dépasse jamais la largeur de sa fenêtre');
  const viewport = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] || '';
  assert.ok(viewport && !/maximum-scale|user-scalable/.test(viewport), `zoom de l’utilisateur laissé libre : ${viewport}`);
});

test('repère : un simple indice noté sur la personne, consultable sur Scène, dans Repères et la file, sans vérification', async () => {
  const world = baseWorld();
  world.stage = { ours: true, ids: ['alice'], queueId: 'q1', singers: [{ id: 'alice', name: 'Alice', table: 'Table 1' }], title: 'Titre' };
  world.queue = [{ ids: ['bruno'], name: 'Bruno', table: 'Table 1', source: 'helper', song: { entryId: 'e2', title: 'Suivant' } }];
  world.people[1] = { ...world.people[1], privateNote: 'casquette' };
  const page = await openPage({ world });
  const text = page.doc.body.textContent;
  for (const word of ['À vérifier', 'C’est bien', 'vérifié', 'Vérifié', 'reconnu']) {
    assert.ok(!page.$('stage').textContent.includes(word) && !page.$('identityBody').textContent.includes(word) && !page.$('identityStage').textContent.includes(word),
      `aucune notion de vérification : « ${word} »`);
  }
  assert.equal(page.doc.body.querySelector('[data-marker-verify]'), null, 'plus de bouton « C’est bien lui/elle »');
  assert.ok(!/marker-verify|verifyMarker|verified/.test(script), 'plus de code de vérification dans la page');
  // Le repère lui-même reste visible et modifiable : Scène, Repères et file.
  assert.equal(page.in('stage', '[data-stage-person="alice"] [data-autosave="note"]').value, 't-shirt rouge');
  assert.equal(page.in('identityStage', '[data-autosave="note"]').value, 't-shirt rouge');
  assert.equal(page.in('identityBody', '[data-identity-person="alice"] [data-identity-note]').value, 't-shirt rouge');
  assert.match(page.in('qBody', '.note-pop').textContent, /casquette/, 'repère consultable depuis la file');
  const input = page.in('identityBody', '[data-identity-person="bruno"] [data-identity-note]');
  input.focus();
  await page.type(input, 'casquette bleue');
  page.runTimers(1000);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/person/identify').body, { personId: 'bruno', note: 'casquette bleue' }, 'seul le texte part');
  assert.ok(text.includes('Repère'), 'le mot « Repère » reste');
});

test('fermeture du bar : changer l’heure fait un brouillon, seule « Valider l’heure » l’enregistre', async () => {
  const page = await openPage();
  const field = page.$('closingTime');
  const status = () => page.doc.body.querySelector('[data-save-status="closingTime"]').textContent;
  const sent = () => page.postsTo('/api/staff/closing').map(post => post.body);
  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
  assert.equal(page.$('closingDraftActions').hidden, true, 'sans changement, rien à valider');
  assert.equal(page.$('closingConfirm').textContent, 'Valider l’heure');
  assert.equal(page.$('closingCancel').textContent, 'Annuler');
  // La roue de l'iPhone tourne : chaque cran émet « input » ; rien ne part.
  for (const value of ['22:00', '23:00', '23:30']) await page.type(field, value);
  for (const ms of [800, 1000, 1500, 2600]) page.runTimers(ms);
  await page.flush();
  assert.deepEqual(sent(), [], 'pas d’enregistrement pendant que l’heure change');
  assert.equal(status(), 'Heure pas encore validée');
  assert.equal(page.$('closingDraftActions').hidden, false, '« Valider l’heure » et « Annuler » proposés');
  // Fermeture du sélecteur (change, puis perte du focus) et Entrée : rien ne part.
  dispatch(field, 'change');
  dispatch(field, 'blur');
  dispatch(field, 'focusout');
  await page.key(field, 'Enter');
  for (const ms of [800, 1000, 1500, 2600]) page.runTimers(ms);
  await page.flush();
  assert.deepEqual(sent(), [], 'fermer le sélecteur n’enregistre rien');
  // Le rafraîchissement de 2 s n'écrase pas le brouillon.
  await page.update({ closing: { at: at(1, 0), passed: false, full: false, fitCount: 9, afterCount: 0 } });
  assert.equal(field.value, '23:30', 'brouillon gardé au rafraîchissement');
  assert.equal(status(), 'Heure pas encore validée');
  // « Annuler » : l'heure enregistrée revient, sans rien envoyer.
  await page.click(page.$('closingCancel'));
  assert.equal(field.value, '01:00');
  assert.equal(page.$('closingDraftActions').hidden, true);
  assert.deepEqual(sent(), []);
  // Revenir à l'heure enregistrée : plus rien à valider.
  await page.type(field, '01:15');
  await page.type(field, '01:00');
  assert.equal(page.$('closingDraftActions').hidden, true, 'même heure que celle annoncée : pas de brouillon');
  // Sélecteur vidé puis refermé : l'heure enregistrée revient.
  await page.type(field, '');
  dispatch(field, 'blur');
  await page.flush();
  assert.equal(field.value, '01:00');
  assert.equal(page.$('closingDraftActions').hidden, true);
  // « Valider l'heure » : seul enregistrement. Le serveur annonce l'heure.
  page.replies['/api/staff/closing'] = body => {
    if (body.time) page.world.closing = { at: at(...body.time.split(':').map(Number)), passed: false, full: false, fitCount: 9, afterCount: 0 };
    return { ok: true };
  };
  await page.type(field, '01:30');
  await page.click(page.$('closingConfirm'));
  assert.deepEqual(sent(), [{ time: '01:30' }]);
  assert.equal(status(), 'Annoncée aux clients : 01:30 ✓');
  assert.equal(page.$('closingDraftActions').hidden, true);
  assert.equal(field.value, '01:30');
  assert.equal(page.$('closingChipText').textContent, 'Fermeture 01:30');
  // Refus du serveur : raison affichée, brouillon gardé, nouvel essai possible.
  page.replies['/api/staff/closing'] = { status: 400, error: 'Heure de fermeture invalide.' };
  await page.type(field, '01:45');
  await page.click(page.$('closingConfirm'));
  assert.equal(status(), 'Non enregistré : Heure de fermeture invalide.');
  assert.equal(page.$('closingDraftActions').hidden, false);
  assert.equal(field.value, '01:45');
  // Pendant l'envoi : « Enregistrement… », un seul envoi, l'heure reste affichée.
  let release;
  page.replies['/api/staff/closing'] = () => new Promise(resolve => { release = () => resolve({ ok: true, message: 'Fermeture à 01:45 ; 4 titres passeront.' }); });
  await page.click(page.$('closingConfirm'));
  assert.equal(status(), 'Enregistrement…');
  assert.equal(page.$('closingConfirm').disabled, true, 'un seul envoi à la fois');
  assert.equal(field.disabled, true, 'heure figée pendant l’envoi');
  // L'heure est déjà partie : « Annuler » ne peut plus la reprendre, et rien
  // d'autre ne change la fermeture avant la réponse (+10 / +15 / +30, Retirer).
  const others = () => [page.$('closingCancel'), page.$('closingClear'), ...page.doc.body.querySelectorAll('[data-closing-extend]')];
  page.world.closing = { at: at(1, 0), passed: false, full: false, fitCount: 9, afterCount: 0 };
  await page.poll();
  for (const button of others()) assert.equal(button.disabled, true, `« ${button.textContent} » indisponible pendant l’envoi`);
  page.$('closingCancel').onclick();
  await page.click(page.doc.body.querySelector('.closing-actions [data-closing-extend="10"]'));
  assert.equal(field.value, '01:45', 'le rafraîchissement ne remet pas l’ancienne heure, « Annuler » non plus');
  assert.equal(status(), 'Enregistrement…', 'l’envoi en cours reste annoncé');
  assert.equal(sent().length, 3, 'aucun autre envoi pendant celui de l’heure');
  page.world.closing = { at: at(1, 45), passed: false, full: false, fitCount: 4, afterCount: 0 };
  release();
  await page.flush();
  assert.deepEqual(sent().at(-1), { time: '01:45' });
  assert.equal(status(), 'Fermeture à 01:45 ; 4 titres passeront.', 'le message du serveur prime');
  assert.equal(field.disabled, false);
  for (const button of others()) assert.equal(button.disabled, false, `« ${button.textContent} » de nouveau disponible`);
  // Heure incomplète validée : refusée sur place.
  await page.type(field, '');
  await page.click(page.$('closingConfirm'));
  assert.equal(status(), 'Non enregistré : choisis une heure ; « Retirer » enlève l’heure annoncée');
  assert.deepEqual(sent().at(-1), { time: '01:45' }, 'rien d’envoyé');
  // +10 / +15 / +30 min et « Retirer » restent immédiats, et remplacent le brouillon.
  await page.type(field, '02:00');
  await page.click(page.doc.body.querySelector('.closing-actions [data-closing-extend="30"]'));
  assert.deepEqual(sent().at(-1), { extendMin: 30 });
  assert.equal(page.$('closingDraftActions').hidden, true);
  await page.update({ closing: { at: at(2, 15), passed: false, full: false, fitCount: 9, afterCount: 0 } });
  assert.equal(field.value, '02:15', 'le champ suit l’heure décalée');
  await page.type(field, '03:00');
  await page.click(page.$('closingClear'));
  assert.deepEqual(sent().at(-1), { clear: true });
  assert.equal(page.$('closingDraftActions').hidden, true);
  await page.update({ closing: null });
  assert.equal(field.value, '');
  page.runTimers(2600);
});

// Regression: relecture des retours du 4 octobre — sans heure annoncée,
// « +30 min » jetait l'heure choisie (brouillon) puis échouait ; le message
// « Annoncée aux clients » restait après un décalage ; un brouillon devenu
// l'heure du serveur (autre téléphone, réponse perdue) restait « à valider ».
test('fermeture du bar (relecture) : décalages sans heure annoncée, message effacé, brouillon rejoint par le serveur', async () => {
  const page = await openPage();
  const field = page.$('closingTime');
  const status = () => page.$('closingStatus').textContent;
  const extends_ = () => page.doc.body.querySelectorAll('.closing-actions [data-closing-extend]');
  const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
  const closing = (h, m) => ({ at: at(h, m), passed: false, full: false, fitCount: 3, afterCount: 0 });
  // Aucune heure annoncée : rien à décaler, l'heure choisie reste en brouillon.
  for (const button of extends_()) assert.equal(button.disabled, true, `« ${button.textContent} » sans heure annoncée`);
  await page.type(field, '01:00');
  await page.click(extends_()[2]);
  assert.equal(field.value, '01:00', 'heure choisie gardée');
  assert.equal(status(), 'Heure pas encore validée');
  assert.deepEqual(page.postsTo('/api/staff/closing'), [], 'rien d’envoyé');
  // Validée puis décalée tout de suite : l'ancien message disparaît.
  page.replies['/api/staff/closing'] = body => {
    page.world.closing = body.time ? closing(...body.time.split(':').map(Number)) : body.extendMin ? closing(1, 30) : null;
    return { ok: true };
  };
  await page.click(page.$('closingConfirm'));
  assert.equal(status(), 'Annoncée aux clients : 01:00 ✓');
  for (const button of extends_()) assert.equal(button.disabled, false, 'heure annoncée : décalage possible');
  await page.click(extends_()[2]);
  assert.deepEqual(page.lastPost('/api/staff/closing').body, { extendMin: 30 });
  await page.poll();
  assert.equal(field.value, '01:30');
  assert.equal(status(), '', 'plus d’« Annoncée aux clients : 01:00 »');
  // Brouillon rejoint par le serveur (un autre téléphone valide la même heure) : plus rien à valider.
  await page.type(field, '02:00');
  dispatch(field, 'blur');
  page.doc.activeElement = null;
  await page.update({ closing: closing(2, 0) });
  assert.equal(page.$('closingDraftActions').hidden, true, 'brouillon devenu l’heure annoncée');
  assert.equal(status(), '');
  // Réponse perdue alors que le serveur a bien pris l'heure : l'erreur s'efface au rafraîchissement.
  page.replies['/api/staff/closing'] = { status: 500, error: 'Failed to fetch' };
  await page.type(field, '02:15');
  await page.click(page.$('closingConfirm'));
  assert.equal(status(), 'Non enregistré : Failed to fetch');
  page.doc.activeElement = null;
  await page.update({ closing: closing(2, 15) });
  assert.equal(status(), '', 'l’heure est annoncée : plus d’erreur');
  assert.equal(page.$('closingDraftActions').hidden, true);
  assert.equal(field.value, '02:15');
  page.runTimers(2600);
});

test('Battle : durée du vote de 1 à 120 min (plus de limite de 10), repli à 15 min de vote et 30 min entre Battles', async () => {
  const world = baseWorld();
  delete world.settings.battleVoteMin; delete world.settings.battleCooldownMin;
  const page = await openPage({ world });
  assert.equal(String(page.$('battleVoteMin').value), '15', 'durée du vote par défaut');
  assert.equal(String(page.$('battleCooldownMin').value), '30', 'délai entre Battles par défaut');
  assert.equal(String(page.$('battleRejectedCooldownMin').value), '5', 'délai après un refus inchangé');
  assert.match(page.$('battleVoteMin').closest('label').textContent, /^Durée du vote \(1 à 120 min\)/);
  assert.equal(page.$('battleVoteMin').getAttribute('max'), '120');
  await page.type(page.$('battleVoteMin'), '45');
  page.runTimers(800);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { battleVoteMin: 45 }, '45 minutes acceptées');
  await page.type(page.$('battleVoteMin'), '121');
  page.runTimers(800);
  await page.flush();
  assert.equal(page.doc.body.querySelector('[data-save-status="battleVoteMin"]').textContent, 'Non enregistré : entre 1 et 120 minutes');
  assert.ok(!/1 à 10 min/.test(html), 'plus de mention « 1 à 10 min »');
});

// ------------------------------------------------------------------ retours du 4 octobre : accès solo, événement privé, activité
// Solos à des moments différents de leur dernière activité, comptée à l'heure
// du serveur (`now`), jamais à celle de l'appareil du bar.
const MIN = 60000;
function soloWorld() {
  const world = baseWorld();
  const now = Date.parse('2026-10-04T21:00:00');
  world.now = now;
  world.tables[2].activeCount = 6; world.tables[2].count = 7;
  world.people[0].lastActiveAt = now - 80 * MIN; // table ordinaire : jamais d'indication
  world.people.push(
    { id: 'eva', name: 'Eva', tableId: 'Comptoir', active: true, songCount: 1, sung: 0, joinedAt: now - 90 * MIN, lastActiveAt: now - 30000 },
    { id: 'farid', name: 'Farid', tableId: 'Comptoir', active: true, songCount: 0, sung: 1, joinedAt: now - 90 * MIN, lastActiveAt: now - 12 * MIN - 20000, privateNote: 'casquette' },
    { id: 'gael', name: 'Gaël', tableId: 'Comptoir', active: true, songCount: 1, sung: 0, joinedAt: now - 90 * MIN, lastActiveAt: now - 25 * MIN },
    { id: 'hana', name: 'Hana', tableId: 'Comptoir', active: true, songCount: 1, sung: 2, joinedAt: now - 120 * MIN, lastActiveAt: now - 65 * MIN - 5000 },
    { id: 'solo3', name: 'Solo 3', tableId: 'Comptoir', active: true, songCount: 0, sung: 0, nameRequired: true, joinedAt: now - 50 * MIN, lastActiveAt: now - 50 * MIN },
    { id: 'ines', name: 'Inès', tableId: 'Comptoir', active: false, songCount: 0, sung: 1, joinedAt: now - 150 * MIN, lastActiveAt: now - 100 * MIN });
  return world;
}

test('activité des solos : libellés, seuils 20 et 45 min, info-bulle, rien pour les tables ni les partis (Repères)', async () => {
  const world = soloWorld();
  const page = await openPage({ world });
  const row = id => page.in('identityBody', `[data-identity-person="${id}"]`);
  const activity = id => row(id).querySelector('.activity');
  assert.equal(activity('eva').textContent, 'Actif à l’instant');
  assert.equal(activity('eva').className, 'activity');
  assert.equal(activity('farid').textContent, 'Actif il y a 12 min');
  assert.equal(activity('gael').textContent, 'Sans nouvelles depuis 25 min');
  assert.equal(activity('gael').className, 'activity warn', 'orange dès 20 min');
  assert.equal(activity('hana').textContent, 'Sans nouvelles depuis 1 h 05', 'au-delà d’une heure');
  assert.equal(activity('hana').className, 'activity late', 'rouge dès 45 min');
  assert.equal(activity('hana').title, `Dernière activité sur son téléphone à ${hhmm(world.now - 65 * MIN - 5000)}`);
  assert.equal(activity('solo3').textContent, `Pas revenu depuis l’ouverture du QR (${hhmm(world.now - 50 * MIN)})`);
  assert.equal(activity('solo3').className, 'activity late');
  assert.equal(activity('alice'), null, 'table ordinaire : un téléphone gère aussi des amis sans téléphone');
  assert.equal(activity('ines'), null, 'personne partie : rien');
  assert.equal(activity('dora'), null, 'activité inconnue (ancienne sauvegarde) : rien');
  // La ligne « N titres · N passages » reste un élément à part.
  assert.equal(row('hana').querySelector('.tiny').textContent, '1 titre · 2 passages');
  assert.equal(row('solo3').querySelector('.badge.name-missing').textContent, 'prénom à saisir', 'prénom provisoire signalé');
  assert.equal(row('solo3').querySelector('strong').textContent, 'Solo 3');
  assert.equal(row('eva').querySelector('.badge.name-missing'), null);

  // Le libellé ne change qu'à la minute : pas de redessin toutes les 2 s.
  const before = row('eva');
  await page.update({ now: world.now + 20000 });
  assert.equal(row('eva'), before, 'même minute : la liste n’est pas réécrite');
  await page.update({ now: world.now + 100000 });
  assert.notEqual(row('eva'), before);
  assert.equal(activity('eva').textContent, 'Actif il y a 2 min');
  // La page redevenue visible : l'activité repart à « Actif à l'instant ».
  page.world.people.find(p => p.id === 'gael').lastActiveAt = page.world.now - 10000;
  await page.poll();
  assert.equal(activity('gael').textContent, 'Actif à l’instant');
});

test('activité des solos : sans heure du serveur, l’heure de l’appareil sert de repli', async () => {
  const world = baseWorld();
  world.people[3].lastActiveAt = Date.now() - 3 * MIN - 1000;
  const page = await openPage({ world });
  assert.equal(page.in('identityBody', '[data-identity-person="dora"] .activity').textContent, 'Actif il y a 3 min');
});

test('Accueil : liste « Solistes » triée par activité, prénom à saisir, QR de reprise en un toucher, recherche au-delà de 8', async () => {
  const world = soloWorld();
  const page = await openPage({ world });
  const names = () => texts(page.all('soloistList', '.soloist-row strong'));
  assert.deepEqual(names(), ['Eva', 'Farid', 'Gaël', 'Solo 3', 'Hana', 'Dora'], 'activité la plus récente d’abord, partis exclus');
  assert.equal(page.$('soloistCount').textContent, '6');
  assert.equal(page.$('soloistSearchBox').hidden, true, 'pas de recherche jusqu’à 8 solistes');
  const row = id => page.in('soloistList', `[data-soloist="${id}"]`);
  assert.equal(row('solo3').querySelector('.badge.name-missing').textContent, 'prénom à saisir');
  assert.equal(row('gael').querySelector('.activity').textContent, 'Sans nouvelles depuis 25 min');
  assert.equal(row('farid').querySelector('.soloist-note').textContent, 'casquette', 'repère du bar pour la reconnaître');
  assert.equal(row('dora').querySelector('.activity'), null);
  // « QR de reprise » : la fenêtre de transfert habituelle, sans recherche.
  page.replies['/api/staff/person/share'] = { code: '1234', qr: 'data:image/png;base64,QR', url: 'http://192.168.1.20:3000/r/x', expiresAt: world.now + 10 * MIN };
  await page.click(row('gael').querySelector('[data-soloist-share]'));
  assert.deepEqual(page.lastPost('/api/staff/person/share').body, { personId: 'gael' });
  assert.equal(page.$('shareDialog').open, true);
  assert.equal(page.$('shareTitle').textContent, 'Accès à Gaël');
  await page.click(page.$('shareClose'));
  const shares = page.postsTo('/api/staff/person/share').length;
  await page.click(row('gael').querySelector('.activity'));
  assert.equal(page.postsTo('/api/staff/person/share').length, shares, 'toucher la ligne ailleurs ne fait rien');

  // Plus de 8 solistes : recherche par prénom (ou repère).
  for (let i = 1; i <= 3; i++) {
    page.world.people.push({ id: `x${i}`, name: `Xavier ${i}`, tableId: 'Comptoir', active: true, songCount: 0, sung: 0, joinedAt: world.now - 200 * MIN });
  }
  await page.poll();
  assert.equal(page.$('soloistSearchBox').hidden, false);
  await page.type(page.$('soloistSearch'), 'ga');
  assert.deepEqual(names(), ['Gaël']);
  await page.type(page.$('soloistSearch'), 'CASQ');
  assert.deepEqual(names(), ['Farid'], 'recherche aussi sur le repère');
  await page.type(page.$('soloistSearch'), 'zz');
  assert.equal(page.$('soloistList').textContent.trim(), 'Aucun soliste à ce nom.');
  await page.type(page.$('soloistSearch'), '');
  assert.equal(names().length, 9);
  // Retour sous 9 solistes : la recherche disparaît et ne filtre plus.
  await page.type(page.$('soloistSearch'), 'ga');
  page.world.people = page.world.people.filter(p => !p.id.startsWith('x'));
  page.doc.activeElement = null;
  await page.poll();
  assert.equal(page.$('soloistSearchBox').hidden, true);
  assert.equal(names().length, 6);

  // Personne en solo.
  page.world.people = page.world.people.filter(p => p.tableId !== 'Comptoir');
  await page.poll();
  assert.equal(page.$('soloistList').textContent.trim(), 'Personne en solo pour le moment.');
  // Pas de groupe « En solo » : pas de liste.
  page.world.tables = page.world.tables.filter(t => t.id !== 'Comptoir');
  await page.poll();
  assert.equal(page.$('soloistsBox').hidden, true);
});

test('activité des solos : tuile « En solo », ligne de la file au-delà de 45 min et alerte « Je suis là »', async () => {
  const world = soloWorld();
  world.queue = [
    { source: 'helper', id: 'hana', pos: 1, name: 'Hana', table: 'En solo', ids: ['hana'], song: { title: 'A', entryId: 'h1' } },
    { source: 'helper', id: 'gael', pos: 2, name: 'Gaël', table: 'En solo', ids: ['gael'], song: { title: 'B', entryId: 'g1' } },
    { source: 'helper', id: 'alice', pos: 3, name: 'Alice', table: 'Table 1', ids: ['alice'], song: { title: 'C', entryId: 'a1' } },
    { source: 'helper', id: 'duo9', pos: 4, name: 'Eva & Solo 3', table: 'En solo', ids: ['eva', 'solo3'], kind: 'duo', song: { title: 'D', entryId: 'd1' } },
    { source: 'karafun', ours: false, pos: 5, singer: 'Invité', title: 'E' },
  ];
  world.maybeGone = [{ id: 'hana', name: 'Hana', table: 'En solo', skips: 2, title: 'A' }, { id: 'alice', name: 'Alice', table: 'Table 1', skips: 2, title: 'C' }];
  const page = await openPage({ world });
  const card = id => page.in('tBody', `[data-table-card="${id}"]`);
  assert.equal(card('Comptoir').querySelector('.occupancy').textContent, '6 solistes · 3 sans nouvelles');
  assert.equal(card('1').querySelector('.occupancy').textContent, '2 actifs / 2 inscrits / 4 places', 'tables : inchangé');
  const lines = page.all('qBody', '.queue-item');
  // Repère court, la durée d'abord (jamais coupé au téléphone) ; la phrase complète dans l'infobulle.
  assert.equal(lines[0].querySelector('.idle-tag').textContent, 'inactif 1 h 05');
  assert.equal(lines[0].querySelector('.idle-tag .idle-for').textContent, 'inactif 1 h 05', 'la durée est dans la partie jamais abrégée');
  assert.equal(lines[0].querySelector('.idle-tag .idle-who'), null, 'solo : pas de prénom répété');
  assert.equal(lines[0].querySelector('.idle-tag').title, `Sans nouvelles depuis 1 h 05 · Dernière activité sur son téléphone à ${hhmm(world.now - 65 * MIN - 5000)}`);
  assert.equal(lines[1].querySelector('.idle-tag'), null, '25 min : pas encore sur la file');
  assert.equal(lines[2].querySelector('.idle-tag'), null, 'table ordinaire : rien');
  assert.equal(lines[3].querySelector('.idle-tag').textContent, `Solo 3 : inactif depuis ${hhmm(world.now - 50 * MIN)}`, 'duo : la personne concernée est nommée');
  assert.equal(lines[3].querySelector('.idle-tag .idle-who').textContent, 'Solo 3 : ', 'duo : seul le prénom peut prendre les « … »');
  assert.equal(lines[3].querySelector('.idle-tag .idle-for').textContent, `inactif depuis ${hhmm(world.now - 50 * MIN)}`);
  assert.equal(lines[3].querySelector('.idle-tag').title, `Solo 3 : Pas revenu depuis l’ouverture du QR (${hhmm(world.now - 50 * MIN)}) · Dernière activité sur son téléphone à ${hhmm(world.now - 50 * MIN)}`);
  assert.equal(lines[4].querySelector('.idle-tag'), null);
  const gone = page.all('staffAlerts', '.gone-alert');
  assert.equal(gone[0].querySelector('.activity').textContent, 'Sans nouvelles depuis 1 h 05');
  // Moins d'une heure : « inactif 52 min » ; l'Accueil et les Repères gardent la phrase complète.
  const hana = page.world.people.find(p => p.id === 'hana');
  const hanaBefore = hana.lastActiveAt;
  hana.lastActiveAt = page.world.now - 52 * MIN;
  await page.poll();
  assert.equal(page.all('qBody', '.queue-item')[0].querySelector('.idle-tag').textContent, 'inactif 52 min');
  assert.equal(page.all('staffAlerts', '.gone-alert')[0].querySelector('.activity').textContent, 'Sans nouvelles depuis 52 min');
  hana.lastActiveAt = hanaBefore;
  await page.poll();
  assert.equal(gone[1].querySelector('.activity'), null, 'table ordinaire : pas d’activité');
  // Plus personne sans nouvelles : la tuile ne compte que les solistes.
  for (const p of page.world.people) if (p.lastActiveAt) p.lastActiveAt = page.world.now;
  await page.poll();
  assert.equal(card('Comptoir').querySelector('.occupancy').textContent, '6 solistes');
});

test('événement privé : interrupteur, QR en grand, copier, imprimer, renouveler avec confirmation', async () => {
  const world = soloWorld();
  world.privateEvent = { enabled: false, url: null, qrUrl: null };
  const page = await openPage({ world });
  const toggle = page.$('privateEventToggle');
  assert.match(toggle.closest('label').textContent, /Événement privé : un seul QR pour tout le monde/);
  assert.match(page.$('privateEventBox').textContent, /Bar privatisé : chaque personne scanne le même QR avec son téléphone et gère ses propres chansons\./);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  assert.equal(page.$('privateEventPanel').hidden, true, 'mode coupé : pas de QR');
  await page.change(toggle, true);
  assert.deepEqual(page.lastPost('/api/staff/private-event').body, { enabled: true });
  assert.equal(page.toast().text, 'Événement privé activé : montre ou imprime son QR');
  const url = 'http://192.168.1.20:3000/t/Comptoir/abc?evenement=secret';
  await page.update({ privateEvent: { enabled: true, url, qrUrl: '/qr-evenement.svg' } });
  assert.equal(toggle.checked, true);
  assert.equal(page.$('privateEventPanel').hidden, false);
  const src = page.$('privateEventQr').src;
  assert.match(src, new RegExp(`^/qr-evenement\\.svg\\?v=[0-9a-f]+&key=${KEY}$`), 'QR réservé au bar, versionné par son adresse');
  assert.equal(page.$('privateEventUrl').value, url);
  assert.equal(page.$('privateEventPrint').getAttribute('href'), `/print?key=${KEY}`);
  await page.poll();
  assert.equal(page.$('privateEventQr').src, src, 'pas de rechargement du QR à chaque rafraîchissement');
  await page.click(page.$('privateEventCopy'));
  assert.deepEqual(page.clipboard, [url]);
  assert.equal(page.toast().text, 'Lien de l’événement copié');
  // Renouveler : confirmation obligatoire.
  page.confirmAnswer = false;
  await page.click(page.$('privateEventRotate'));
  assert.match(page.confirms.at(-1), /^Renouveler le QR de l’événement privé \?/);
  assert.match(page.confirms.at(-1), /les personnes déjà inscrites gardent leur accès/);
  assert.equal(page.postsTo('/api/staff/private-event').length, 1, 'refusé : rien n’est envoyé');
  page.confirmAnswer = true;
  await page.click(page.$('privateEventRotate'));
  assert.deepEqual(page.lastPost('/api/staff/private-event').body, { rotate: true });
  assert.equal(page.toast().text, 'Nouveau QR d’événement privé : l’ancien est refusé');
  await page.update({ privateEvent: { enabled: true, url: url.replace('secret', 'neuf'), qrUrl: '/qr-evenement.svg' } });
  assert.notEqual(page.$('privateEventQr').src, src, 'nouveau QR affiché');
  // Couper.
  await page.change(toggle, false);
  assert.deepEqual(page.lastPost('/api/staff/private-event').body, { enabled: false });
  assert.equal(page.toast().text, 'Événement privé coupé : son QR ne permet plus de s’inscrire');
  // Refus du serveur : le message s'affiche, l'interrupteur suit ensuite le serveur.
  page.replies['/api/staff/private-event'] = { status: 400, error: 'Refusé.' };
  await page.change(toggle, false);
  assert.deepEqual(page.toast(), { text: 'Refusé.', bad: true });
  await page.poll();
  assert.equal(toggle.checked, true, 'l’état affiché est celui du serveur');
  // Ancien serveur (pas de privateEvent) ou pas de groupe « En solo ».
  delete page.world.privateEvent;
  await page.poll();
  assert.equal(toggle.checked, false);
  assert.equal(page.$('privateEventPanel').hidden, true);
  page.world.tables = page.world.tables.filter(t => t.id !== 'Comptoir');
  await page.poll();
  assert.equal(toggle.disabled, true);
});

// Lot J (8 octobre) : durée maximale des titres, dans « Plus » › règles ;
// titres déjà dans la file gardés, signalés, retirés d'un geste (décision D9).
test('durée maximale : interrupteur coupé par défaut, 5:00 à l’activation, minutes et secondes, badge et retrait groupé', async () => {
  const world = baseWorld();
  world.settings.maxSongSec = null;
  world.tooLong = { limitSec: null, count: 0 };
  world.queue = [
    { source: 'karafun', ours: true, queueId: 9, pos: 1, name: 'Alice', ids: ['alice'], song: { entryId: 'k1', title: 'Déjà chargé' } },
    { source: 'helper', id: 'bruno', pos: 2, name: 'Bruno', ids: ['bruno'], song: { entryId: 'b1', title: 'Épopée', duration: 372 } },
    { source: 'helper', id: 'dora', pos: 3, name: 'Dora', ids: ['dora'], song: { entryId: 'd1', title: 'Court', duration: 200 } },
  ];
  const page = await openPage({ world });
  assert.equal(page.$('maxSongOn').closest('section').dataset.tab, 'plus', 'avec les autres règles, dans « Plus »');
  assert.equal(page.$('maxSongOn').checked, false, 'coupé par défaut');
  assert.equal(page.$('maxSongFields').hidden, true, 'durée cachée tant que l’option est coupée');
  assert.equal(page.$('tooLongActions').hidden, true);
  assert.doesNotMatch(page.$('qBody').innerHTML, /plus long que/);

  page.replies['/api/staff/settings'] = body => {
    page.world.settings.maxSongSec = body.maxSongSec;
    page.world.tooLong = { limitSec: body.maxSongSec, count: body.maxSongSec != null && body.maxSongSec < 372 ? 1 : 0 };
    page.world.queue[1].tooLongSec = page.world.tooLong.count ? 372 : undefined;
    return { ok: true };
  };
  await page.change(page.$('maxSongOn'), true);
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { maxSongSec: 300 }, '5:00 proposé à l’activation');
  await page.poll();
  assert.equal(page.$('maxSongOn').checked, true);
  assert.equal(page.$('maxSongFields').hidden, false);
  assert.equal(page.$('maxSongMin').value, 5);
  assert.equal(page.$('maxSongSecPart').value, 0);
  // File : seul le titre pas encore envoyé et trop long porte le repère.
  const badges = page.all('qBody', '.badge').map(node => node.textContent).filter(text => text.startsWith('plus long'));
  assert.deepEqual(badges, ['plus long que 5:00']);
  assert.match(page.$('qBody').innerHTML, /Ce titre dure 6:12/);
  assert.equal(page.$('tooLongActions').hidden, false);
  assert.equal(page.$('removeTooLong').textContent, 'Retirer le titre trop long');

  // Minutes et secondes : valeur vérifiée avant l'envoi, puis enregistrée ensemble.
  const status = key => page.doc.body.querySelector(`[data-save-status="${key}"]`).textContent;
  await page.type(page.$('maxSongMin'), '1');
  assert.equal(status('maxSongMin'), 'Non enregistré : entre 2:00 et 15:00');
  await page.type(page.$('maxSongMin'), '6');
  page.runTimers(800);
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { maxSongSec: 360 });
  await page.poll();
  await page.type(page.$('maxSongSecPart'), '75');
  assert.equal(status('maxSongSecPart'), 'Non enregistré : minutes et secondes entières (0 à 59 s)');
  await page.type(page.$('maxSongSecPart'), '');
  assert.equal(status('maxSongSecPart'), 'Non enregistré : minutes et secondes entières (0 à 59 s)');
  await page.type(page.$('maxSongSecPart'), '30');
  dispatch(page.$('maxSongSecPart'), 'blur');
  await page.flush();
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { maxSongSec: 390 });
  await page.poll();
  assert.equal(page.$('tooLongActions').hidden, true, 'plus aucun titre au-delà de 6:30');

  // Plusieurs titres trop longs : confirmation, puis retrait groupé.
  Object.assign(page.world, { tooLong: { limitSec: 300, count: 2 } });
  page.world.settings.maxSongSec = 300;
  await page.poll();
  assert.equal(page.$('removeTooLong').textContent, 'Retirer les 2 titres trop longs');
  page.confirmAnswer = false;
  await page.click(page.$('removeTooLong'));
  assert.match(page.confirms.at(-1), /^Retirer de la file les 2 titres plus longs que 5:00 \? Chaque personne est prévenue sur son téléphone\./);
  assert.equal(page.postsTo('/api/staff/songs-too-long/remove').length, 0, 'annulé : rien n’est retiré');
  page.confirmAnswer = true;
  page.replies['/api/staff/songs-too-long/remove'] = { ok: true, removed: 2, message: '2 titres trop longs retirés.' };
  await page.click(page.$('removeTooLong'));
  assert.deepEqual(page.lastPost('/api/staff/songs-too-long/remove').body, {});
  assert.equal(page.toast().text, '2 titres trop longs retirés.');
  page.world.tooLong = { limitSec: 300, count: 1 };
  await page.poll();
  await page.click(page.$('removeTooLong'));
  assert.match(page.confirms.at(-1), /^Retirer de la file le titre plus long que 5:00 \?/);

  // Coupé : plus de champs ni de bouton.
  await page.change(page.$('maxSongOn'), false);
  assert.deepEqual(page.lastPost('/api/staff/settings').body, { maxSongSec: null });
  await page.poll();
  assert.equal(page.$('maxSongFields').hidden, true);
  assert.equal(page.$('tooLongActions').hidden, true);
});

// ---------------------------------------------------------------- relecture finale (affichage)
// Regression: U1 — la pastille du panneau Spotify portait la phrase longue
// (« Spotify connecté, aucun appareil : ouvre Spotify sur … », nowrap) et
// débordait de la carte à 390 px. Pastille courte, phrase dans le texte.
// Regression: U11 — un refus de Spotify (401, 403…) s'affichait « Spotify
// injoignable, nouvel essai à … » alors que Spotify avait répondu.
test('Spotify : pastille courte, phrase longue sous le titre, refus de Spotify distinct de « injoignable »', async () => {
  const world = baseWorld();
  const at = Date.now() - 60000;
  world.spotify = { configured: true, connected: true, clientId: '0123456789abcdef', autoResume: true, autoPause: false,
    deviceId: 'dev-3', deviceName: 'Tablette', player: null, lastAction: null, lastError: null, devices: [],
    health: { state: 'no-device', device: { id: 'dev-3', name: 'Tablette', active: false }, checkedAt: at } };
  const page = await openPage({ world });
  assert.equal(page.$('spotifyPill').textContent, 'Spotify : aucun appareil', 'pastille courte');
  assert.equal(page.$('spotifyPill').className, 'pill warn');
  assert.equal(page.$('spotifyText').textContent, `Spotify connecté, aucun appareil : ouvre Spotify sur Tablette. Vérifié à ${hhmm(at)}.`,
    'la phrase complète reste lisible sous le titre');
  const retryAt = Date.now() + 120000;
  await page.update({ spotify: { ...world.spotify, health: { state: 'error', device: null, checkedAt: at, retryAt, message: 'réseau' } } });
  assert.equal(page.$('spotifyPill').textContent, 'Spotify injoignable');
  assert.match(page.$('spotifyText').textContent, new RegExp(`^Spotify injoignable, nouvel essai à ${hhmm(retryAt)}\\.`));
  // Refus de Spotify : le code et le message, sans promesse de nouvel essai.
  await page.update({ spotify: { ...world.spotify, lastError: 'Spotify refuse la commande pour ce compte.',
    health: { state: 'error', status: 403, device: null, checkedAt: at, retryAt, message: 'Spotify refuse la commande pour ce compte.' } } });
  assert.equal(page.$('spotifyPill').textContent, 'Spotify refuse la demande');
  assert.equal(page.$('spotifyPill').className, 'pill bad');
  assert.equal(page.$('spotifyChip').textContent, 'Spotify refuse la demande');
  assert.equal(page.$('spotifyText').textContent, `Spotify refuse la demande : Spotify refuse la commande pour ce compte. Vérifié à ${hhmm(at)}.`,
    'message une seule fois, pas d’« injoignable » ni de nouvel essai annoncé');
  assert.doesNotMatch(page.$('spotifyText').textContent, /injoignable|nouvel essai/);
  assert.equal(page.$('tabDotPlus').hidden, false, 'refus : point sur « Plus »');
});

// Regression: U7 — les boutons « QR de reprise » répétés n'avaient pas de nom distinct.
// Regression: U10 — le repère « plus long que … » était dans .queue-tags,
// caché au téléphone : un repère court hors de .queue-tags le remplace.
// Regression: U12 — l'aide promettait un « ajout pour quelqu’un » du bar, qui n'existe pas.
test('relecture : nom accessible des « QR de reprise », repère trop long au téléphone, aide de la durée maximale', async () => {
  const solo = await openPage({ world: soloWorld() });
  const share = solo.in('soloistList', '[data-soloist="gael"] [data-soloist-share]');
  assert.equal(share.getAttribute('aria-label'), 'QR de reprise pour Gaël');

  const world = baseWorld();
  world.settings.maxSongSec = 300;
  world.tooLong = { limitSec: 300, count: 1 };
  world.queue = [{ source: 'helper', id: 'bruno', pos: 1, name: 'Bruno', ids: ['bruno'], tooLongSec: 372, song: { entryId: 'b1', title: 'Épopée', duration: 372 } },
    { source: 'helper', id: 'dora', pos: 2, name: 'Dora', ids: ['dora'], song: { entryId: 'd1', title: 'Court', duration: 200 } }];
  const page = await openPage({ world });
  const [long, short] = page.all('qBody', '.queue-item');
  const mark = long.querySelector('.person-cell .too-long-tag');
  assert.ok(mark, 'repère court dans la cellule du nom');
  assert.equal(mark.closest('.queue-tags'), null, 'hors des badges cachés au téléphone');
  assert.equal(mark.textContent, 'trop long');
  assert.match(mark.title, /Ce titre dure 6:12/);
  assert.equal(short.querySelector('.too-long-tag'), null);
  const help = page.$('maxSongOn').closest('section').textContent;
  assert.doesNotMatch(help, /ajout pour quelqu/, 'aucune route du bar n’ajoute pour quelqu’un');
  assert.match(help, /Battle lancée par le bar/);
  assert.match(help, /« Relancer »/);
  assert.match(help, /déjà dans KaraFun/);
});
