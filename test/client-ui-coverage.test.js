'use strict';
// Page des chanteurs (public/client.html) : parcours encore sans test.
// Langue du téléphone, lien invalide, perte de connexion, ancien jeton,
// catalogue ouvert pour un chanteur (ou refusé), choix d'un partenaire de duo,
// lien de transfert reçu ou envoyé, alertes (son, vibration, notifications),
// demandes en grand et infos en haut de page, fiches des personnes, actions de la liste, Battle, catalogue en
// erreur, paroles, fermeture du bar.
//
// Chaque test charge le premier <script> en ligne de la page dans un bac à
// sable `vm` nommé « client.html » (test/coverage.js y ramène la couverture),
// sur un DOM simulé construit à partir du vrai balisage de la page : les
// identifiants, les attributs data-*, l'imbrication (bouton dans une fiche,
// fiche dans une liste) et les éléments recréés par innerHTML sont ceux que
// verrait un téléphone. Aucun réseau : les réponses du serveur sont simulées.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'client.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
assert.ok(script, 'script de la page client');
const bodyMarkup = html.slice(html.indexOf('<body'), html.indexOf('<script'));
const i18nSource = fs.readFileSync(path.join(root, 'public', 'client-i18n.js'), 'utf8');
const loadedI18n = { window: {} };
vm.runInNewContext(i18nSource, loadedI18n, { filename: 'client-i18n.js' });
const TRANSLATIONS = loadedI18n.window.CLIENT_TRANSLATIONS;
assert.ok(TRANSLATIONS?.en?.texts, 'dictionnaire anglais chargé');

// ---------------------------------------------------------------- DOM simulé
const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source']);
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (all, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': '\'' }[name]));
const camel = name => name.replace(/-(\w)/g, (all, letter) => letter.toUpperCase());
function parseAttrs(text) {
  const attrs = {};
  for (const match of String(text || '').matchAll(/([^\s=/"]+)(?:="([^"]*)")?/g)) attrs[match[1]] = match[2] === undefined ? '' : decode(match[2]);
  return attrs;
}

// Un sélecteur simple : balise, classes, attributs ([a], [a=b], [a="b"]) et :not([a]).
function matchSimple(node, simple) {
  const nots = [];
  const rest = simple.replace(/:not\(\[([\w-]+)\]\)/g, (all, name) => { nots.push(name); return ''; });
  const parts = /^([a-z0-9]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(rest);
  if (!parts) throw new Error(`Sélecteur non simulé : ${simple}`);
  if (parts[1] && node.tag !== parts[1].toLowerCase()) return false;
  for (const name of (parts[2] || '').split('.').filter(Boolean)) if (!node.classList.contains(name)) return false;
  for (const attr of (parts[3] || '').matchAll(/\[([\w-]+)(?:=("?)([^"\]]*)\2)?\]/g)) {
    if (!(attr[1] in node.attrs)) return false;
    if (attr[3] !== undefined && attr[0].includes('=') && node.attrs[attr[1]] !== attr[3]) return false;
  }
  for (const name of nots) {
    if (name === 'hidden' ? node.hidden : name === 'disabled' ? node.disabled : name in node.attrs) return false;
  }
  return true;
}
// Découpe hors des crochets : « a, b » (liste) et « a b » (descendant).
function splitOutside(text, separator) {
  const parts = [];
  let depth = 0, quoted = false, current = '';
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '[') depth++;
    else if (!quoted && ch === ']') depth--;
    if (!quoted && depth === 0 && separator.test(ch)) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}
function matches(node, selector) {
  if (node.tag === '#text') return false;
  return splitOutside(selector, /,/).some(part => {
    const chain = splitOutside(part, /\s/);
    if (!matchSimple(node, chain.at(-1))) return false;
    let index = chain.length - 2;
    for (let current = node.parent; index >= 0 && current; current = current.parent) if (matchSimple(current, chain[index])) index--;
    return index < 0;
  });
}

class Element {
  constructor(page, tag, attrs = {}) {
    const classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
    Object.assign(this, { page, tag: tag.toLowerCase(), attrs: { ...attrs }, id: attrs.id || '', className: attrs.class || '',
      hidden: 'hidden' in attrs, disabled: 'disabled' in attrs, value: attrs.value ?? '', style: {}, listeners: {},
      children: [], parent: null, detached: false, focusCount: 0, dataset: {} });
    for (const [name, value] of Object.entries(attrs)) if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = value;
    this.classList = {
      toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
      add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
    };
    this._html = '';
    this._text = '';
  }
  get tagName() { return this.tag.toUpperCase(); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.clear(); this._text = String(value); }
  get innerHTML() { return this._html; }
  set innerHTML(value) {
    this.clear();
    this._html = String(value);
    parseInto(this.page, this, this._html);
    if (this.tag === 'select') this.value = selectValue(this);
  }
  clear() {
    for (const child of this.children) child.detached = true;
    this.children = [];
    this._html = '';
    this._text = '';
  }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  hasAttribute(name) { return name in this.attrs; }
  addEventListener(type, listener, options = {}) { (this.listeners[type] ||= []).push({ listener, once: !!options?.once }); }
  descendants() {
    const out = [];
    const visit = node => { for (const child of node.children) { out.push(child); visit(child); } };
    visit(this);
    return out;
  }
  querySelectorAll(selector) { return this.descendants().filter(node => matches(node, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    for (let node = this; node; node = node.parent) if (node.tag !== '#body' && matches(node, selector)) return node;
    return null;
  }
  focus() { this.focusCount++; this.page.document.activeElement = this; }
  appendChild(child) { child.parent = this; child.detached = false; this.children.push(child); return child; }
  remove() {
    if (!this.parent) return;
    // Comme un navigateur : retirer l'élément qui a le focus le rend à la page.
    for (let node = this.page.document.activeElement; node; node = node.parent) if (node === this) { this.page.document.activeElement = this.page.body; break; }
    this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
    this.detached = true;
  }
  blur() { if (this.page.document.activeElement === this) this.page.document.activeElement = this.page.body; }
  setSelectionRange(start, end) { this.selection = [start, end]; }
  // Comme un navigateur : select() donne aussi le focus au champ.
  select() { this.selected = true; this.page.document.activeElement = this; }
  scrollIntoView(options) { this.scrolled = options || true; }
}
function selectValue(select) {
  const options = select.descendants().filter(node => node.tag === 'option');
  return (options.find(option => 'selected' in option.attrs) || options[0])?.attrs.value ?? '';
}
function parseInto(page, rootNode, markup) {
  const stack = [rootNode];
  const pattern = /<!--[\s\S]*?-->|<\/(\w+)\s*>|<(\w+)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  for (const match of markup.matchAll(pattern)) {
    const top = stack.at(-1);
    if (match[1]) {
      const at = stack.map(node => node.tag).lastIndexOf(match[1].toLowerCase());
      if (at > 0) {
        for (const closed of stack.splice(at)) if (closed.tag === 'select') closed.value = selectValue(closed);
      }
    } else if (match[2]) {
      const node = new Element(page, match[2], parseAttrs(match[3]));
      node.parent = top;
      top.children.push(node);
      if (node.id) page.byId.set(node.id, node);
      if (!VOID.has(node.tag) && !match[4]) stack.push(node);
    } else if (match[5]) {
      // Nœud texte : l'ordre du texte et des éléments est gardé.
      const text = new Element(page, '#text');
      text._text = decode(match[5]);
      text.parent = top;
      top.children.push(text);
    }
  }
}

// ---------------------------------------------------------------- page chargée
const REPLY = Symbol('réponse');
const reply = (status, data = {}, headers = {}) => ({ [REPLY]: true, status, data, headers });
const timeOf = (value, lang = 'fr') => new Date(value).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'fr-FR', { hour: '2-digit', minute: '2-digit' });

const person = (id, name, extra = {}) => ({ id, name, active: true, songs: [], invites: [], inKaraFun: [], joinRequests: [],
  sentJoinRequests: [], canDefer: false, deferral: null, ...extra });
const baseState = (extra = {}) => ({
  table: { id: '1', name: 'Table 1', headcount: 4, activeCount: 1 },
  tablePeople: [person('alice', 'Alice', { songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre', artist: 'Moi' }] })],
  managedIds: ['alice'], people: [], queue: [], waiting: [], closing: null,
  battle: { phase: 'idle', eligiblePersonIds: [], votedPersonIds: [], minVoters: 2, registered: 4 },
  catalogAvailable: true, stage: null, next: null, rules: {}, ...extra,
});

function defaultRoute(url) {
  if (url.startsWith('/api/catalog/categories?')) return [{ name: 'Années 80', filter: 'pl_1' }];
  if (url.startsWith('/api/catalog/highlights?')) return [{ songId: 21, title: 'Nouveau tube', artist: 'Révélation' }];
  if (url.startsWith('/api/catalog/songs?')) return { songs: [{ songId: 9, title: 'Tube', artist: 'Groupe' }], total: 1 };
  if (url.startsWith('/api/search?')) return [{ songId: 42, title: 'Bohemian Rhapsody', artist: 'Queen' }, { songId: 43, title: 'Under Pressure', artist: 'Queen' }];
  if (url.startsWith('/api/song/notice?')) return { notice: null };
  if (url.startsWith('/api/lyrics?')) return { lines: ['Premier vers'], url: 'https://www.karafun.fr/karaoke/a/b/', exact: true };
  if (url.startsWith('/api/duo/partners?')) return [];
  return { ok: true };
}

function makeAudio(log, { state = 'running', fail = false, refuse = false } = {}) {
  return class FakeAudioContext {
    constructor() {
      if (refuse) throw new Error('audio interdit');
      log.contexts++; this.state = state; this.currentTime = 10; this.destination = { output: true };
    }
    resume() { log.resumes++; this.state = 'running'; return Promise.resolve(); }
    createOscillator() {
      if (fail) throw new Error('audio bloqué');
      const oscillator = { frequency: {}, connect: gain => gain, start: at => { oscillator.startAt = at; }, stop: at => { oscillator.stopAt = at; } };
      log.oscillators.push(oscillator);
      return oscillator;
    }
    createGain() {
      const destination = this.destination;
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: target => { if (target === destination) log.toSpeaker++; return target; } };
    }
  };
}

function boot(options = {}) {
  const page = { byId: new Map(), posts: [], requests: [], timers: new Map(), vibrations: [], notifications: [],
    shares: [], copies: [], scrolls: [], focusWindow: 0, audio: { contexts: 0, resumes: 0, oscillators: [], toSpeaker: 0 } };
  page.state = options.state || baseState();
  const storage = new Map(Object.entries(options.storage || {}));
  page.storage = storage;
  const body = new Element(page, '#body');
  const document = {
    title: '', hidden: !!options.hidden, documentElement: { lang: 'fr' }, activeElement: body, listeners: {},
    getElementById: id => { const node = page.byId.get(id); return node && connected(node) ? node : null; },
    querySelectorAll: selector => body.querySelectorAll(selector),
    querySelector: selector => body.querySelector(selector),
    addEventListener(type, listener, opts = {}) { (this.listeners[type] ||= []).push({ listener, once: !!opts?.once }); },
    contains: node => connected(node),
    createElement: tag => new Element(page, tag),
    // Copie de secours : le champ sélectionné au moment de la copie est noté.
    execCommand: command => {
      page.execCommands = (page.execCommands || 0) + 1;
      const field = [...page.body.descendants()].reverse().find(node => node.selected);
      page.execCopied = (page.execCopied || []).concat(field ? [field.value] : []);
      return command === 'copy' && !!options.execCopy;
    },
  };
  const connected = node => {
    for (let current = node; current; current = current.parent) {
      if (current.detached) return false;
      if (current === body) return true;
    }
    return false;
  };
  page.document = document;
  page.body = body;
  body.innerHTML = bodyMarkup;
  // Le balisage commence à <body> : c'est lui, document.body.
  document.body = body.children.find(node => node.tag === 'body') || body;

  // Historique du navigateur : URL réécrites par la page (lien de transfert oublié).
  const windowListeners = {};
  const history = {
    entries: [], index: -1, urls: [],
    get state() { return this.entries[this.index]?.state ?? null; },
    replaceState(state, title, url) {
      if (options.historyThrows) throw new Error('SecurityError');
      if (url !== undefined) this.urls.push(url);
      this.entries[this.index < 0 ? (this.index = 0) : this.index] = { state };
    },
    pushState(state) { this.entries.splice(this.index + 1); this.entries.push({ state }); this.index++; },
    back() { if (this.index <= 0) return; this.index--; queueMicrotask(() => windowListeners.popstate?.({ state: this.state })); },
    go(delta) { this.index = Math.max(0, this.index + delta); queueMicrotask(() => windowListeners.popstate?.({ state: this.state })); },
  };
  page.history = history;

  const Notification = options.notification ? (() => {
    const config = options.notification;
    return class FakeNotification {
      static permission = config.permission || 'default';
      static async requestPermission() { page.permissionRequests = (page.permissionRequests || 0) + 1; FakeNotification.permission = config.grant || 'granted'; return FakeNotification.permission; }
      constructor(title, opts) {
        if (config.throws) throw new Error('notifications bloquées');
        Object.assign(this, { title, ...opts, closed: false });
        page.notifications.push(this);
      }
      close() { this.closed = true; }
    };
  })() : undefined;
  const AudioContext = options.audio ? makeAudio(page.audio, options.audio) : undefined;

  const localStorage = options.storageThrows ? {
    getItem() { throw new Error('stockage désactivé'); }, setItem() { throw new Error('stockage désactivé'); }, removeItem() { throw new Error('stockage désactivé'); },
  } : {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };

  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    page.requests.push({ url, headers: init.headers || {}, body });
    if (init.method === 'POST') page.posts.push([url, body]);
    let result = options.respond ? options.respond(url, body, page) : undefined;
    if (result === undefined) result = url.startsWith('/api/state?') ? JSON.parse(JSON.stringify(page.state)) : defaultRoute(url);
    if (result instanceof Error) throw result;
    const response = result?.[REPLY] ? result : { status: 200, data: result };
    const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
    return { ok: response.status < 400, status: response.status, json: async () => response.data,
      headers: { get: name => headers[String(name).toLowerCase()] ?? null } };
  };

  const navigator = {
    ...(options.languages !== undefined ? { languages: options.languages } : { languages: ['fr-FR'] }),
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.userAgent !== undefined ? { userAgent: options.userAgent } : {}),
    vibrate: pattern => { page.vibrations.push([...pattern]); return true; },
    // options.share en fonction : sa réponse (refus, annulation) suit le partage.
    ...(options.share ? { share: async data => { page.shares.push({ ...data }); if (typeof options.share === 'function') await options.share(data); } } : {}),
    // Page en http sur le Wi-Fi du bar : ni partage ni presse-papiers.
    ...(options.noClipboard ? {} : { clipboard: { writeText: async text => { if (options.clipboardFails) throw new Error('refusé'); page.copies.push(text); } } }),
  };
  const window = {
    isSecureContext: !!options.secure, history,
    scrollTo: position => page.scrolls.push({ ...position }),
    addEventListener: (type, listener) => { windowListeners[type] = listener; },
    focus: () => { page.focusWindow++; },
    open() {},
    ...(options.translations === false ? {} : { CLIENT_TRANSLATIONS: TRANSLATIONS }),
    ...(Notification ? { Notification } : {}),
    ...(AudioContext ? { AudioContext } : {}),
    ...(options.session ? { sessionStorage: options.session } : {}),
  };
  let poll = null;
  const context = {
    document, window, navigator, localStorage, fetch, URLSearchParams, queueMicrotask, console, Date,
    location: { pathname: options.path || '/t/1/secret', search: options.search || '' },
    setInterval: fn => { poll = fn; return 1; },
    setTimeout: (fn, ms) => { const id = Symbol('minuteur'); page.timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => page.timers.delete(id),
    ...(Notification ? { Notification } : {}),
  };
  vm.runInNewContext(script, context, { filename: 'client.html' });

  page.$ = id => document.getElementById(id);
  page.node = id => { const node = page.$(id); assert.ok(node, `élément #${id} affiché`); return node; };
  page.settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
  page.poll = async () => { poll(); await page.settle(); };
  page.dispatch = (target, type, extra = {}) => {
    const event = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    const results = [];
    const fire = holder => {
      for (const entry of [...(holder.listeners[type] || [])]) {
        if (entry.once) holder.listeners[type] = holder.listeners[type].filter(item => item !== entry);
        results.push(entry.listener(event));
      }
    };
    for (let node = target; node; node = node.parent) fire(node);
    fire(document);
    return event;
  };
  page.click = async target => {
    assert.ok(target, 'élément à toucher');
    assert.ok(connected(target), 'élément touché encore affiché');
    assert.equal(target.disabled, false, 'élément touché actif');
    page.dispatch(target, 'click');
    await page.settle();
  };
  page.find = (container, selector) => {
    const holder = typeof container === 'string' ? page.node(container) : container;
    const found = holder.querySelector(selector);
    assert.ok(found, `${selector} présent dans #${holder.id || holder.tag}`);
    return found;
  };
  page.tap = (container, selector) => page.click(page.find(container, selector));
  page.type = async (id, value) => { const input = page.node(id); input.value = value; page.dispatch(input, 'input'); await page.settle(); };
  page.change = async (id, value) => { const select = page.node(id); select.value = value; page.dispatch(select, 'change'); await page.settle(); };
  page.submit = async id => { const form = page.node(id); const event = page.dispatch(form, 'submit'); assert.equal(event.defaultPrevented, true, 'la page ne se recharge pas'); await page.settle(); };
  page.runTimers = async ms => {
    for (const [id, timer] of [...page.timers]) if (timer.ms === ms) { page.timers.delete(id); timer.fn(); }
    await page.settle();
  };
  page.toast = () => ({ text: page.node('toast').textContent, bad: /\bbad\b/.test(page.node('toast').className),
    warn: /\bwarn\b/.test(page.node('toast').className), hidden: page.node('toast').hidden });
  page.stateRequests = () => page.requests.filter(request => request.url.startsWith('/api/state?'));
  page.sheetOpen = () => page.node('sheet').hidden === false;
  page.sheetHtml = () => page.node('sheetPanel').innerHTML;
  page.tabShown = () => ['table', 'queue', 'catalog'].find(name => page.node(`tab-${name}`).hidden === false);
  return page;
}
async function open(options) {
  const page = boot(options);
  await page.settle();
  return page;
}
// Catalogue : sélections, puis titres de la première, puis un titre.
async function pickCatalogSong(page, index = 0) {
  await page.tap('catalogContent', '[data-category-index="0"]');
  await page.tap('catalogContent', `[data-song-index="${index}"]`);
}

// ================================================================ langue
test('langue : un téléphone en anglais affiche la page en anglais, attributs et bouton EN compris', async () => {
  const page = await open({ languages: ['en-US', 'fr-FR'] });
  assert.equal(page.document.documentElement.lang, 'en');
  assert.equal(page.node('stageLabel').textContent, 'On stage', 'texte fixe traduit');
  assert.equal(page.node('nav-table').textContent, 'My table');
  assert.equal(page.node('searchInput').getAttribute('placeholder'), 'e.g. Queen', 'attribut traduit');
  assert.equal(page.node('searchClear').getAttribute('aria-label'), 'Clear the search');
  const [fr, en] = page.node('langSwitch').querySelectorAll('[data-lang]');
  assert.equal(fr.getAttribute('aria-pressed'), 'false');
  assert.equal(en.getAttribute('aria-pressed'), 'true', 'le bouton EN est indiqué comme choisi');
  assert.equal(page.document.title, 'Karaoke — my table');
  assert.equal(page.node('conn').textContent, 'Live');
});

test('langue : réglage du téléphone, choix gardé et stockage désactivé', async () => {
  const lang = async options => (await open(options)).document.documentElement.lang;
  assert.equal(await lang({ languages: [], language: 'fr_CA' }), 'fr', 'navigator.language seul, variante fr_CA');
  assert.equal(await lang({ languages: [], language: 'de-DE' }), 'en', 'autre langue : anglais');
  assert.equal(await lang({ languages: [], language: '' }), 'fr', 'aucune langue connue : français');
  assert.equal(await lang({ languages: ['fr'] }), 'fr');
  assert.equal(await lang({ languages: ['en-GB'], storage: { kfLang: 'fr' } }), 'fr', 'le choix FR/EN gardé l’emporte');
  assert.equal(await lang({ languages: ['fr-FR'], storage: { kfLang: 'xx' } }), 'fr', 'valeur gardée inconnue : ignorée');

  // Stockage désactivé (navigation privée stricte) : langue du téléphone, page utilisable.
  const page = await open({ languages: ['en-US'], storageThrows: true, respond: (url, body, self) => {
    if (url !== '/api/table/person') return undefined;
    self.state.tablePeople.push(person('zoe', 'Zoé', { songs: [{ entryId: 'z1', songId: 5, title: 'Son titre' }] }));
    self.state.managedIds.push('zoe');
    return { id: 'zoe', token: 'jeton-zoe' };
  } });
  assert.equal(page.document.documentElement.lang, 'en');
  assert.equal(page.node('conn').textContent, 'Live', 'l’état est chargé malgré le stockage');
  assert.equal(page.node('alertsToggle').textContent, 'Turn on notifications', 'alertes désactivées par défaut');
  await page.click(page.node('alertsToggle'));
  assert.equal(page.node('alertsToggle').getAttribute('aria-pressed'), 'true', 'les alertes restent actives pendant la visite');
  // Le jeton d'une personne ajoutée reste en mémoire et accompagne ses actions.
  page.node('newName').value = 'Zoé';
  await page.submit('addPersonForm');
  assert.deepEqual(page.posts.at(-1), ['/api/table/person', { table: '1', access: 'secret', name: 'Zoé' }]);
  assert.equal(page.toast().text, 'Zoé was added to the table.', 'confirmation affichée en anglais');
  assert.ok(JSON.parse(page.stateRequests().at(-1).headers['x-person-tokens']).includes('jeton-zoe'), 'jeton présenté au serveur');
  await page.tap('peopleList', '[data-remove-song="z1"]');
  assert.equal(page.posts.at(-1)[1].token, 'jeton-zoe', 'l’action de Zoé porte son jeton');
});

// ================================================================ lien invalide et connexion
function assertInvalidLink(page, { who = 'Lien invalide', conn = 'Accès refusé' } = {}) {
  assert.equal(page.node('fatalBox').hidden, false, 'message « lien invalide » affiché');
  for (const tab of ['table', 'queue', 'catalog']) assert.equal(page.node(`tab-${tab}`).hidden, true, `onglet ${tab} masqué`);
  assert.equal(page.document.querySelector('.tabs').hidden, true, 'barre d’onglets masquée');
  assert.equal(page.node('stageWho').textContent, who);
  assert.equal(page.node('stageWhat').textContent, '');
  assert.equal(page.node('nextBox').hidden, true);
  assert.equal(page.node('conn').textContent, conn);
  assert.equal(page.node('conn').className, 'pill bad');
}

test('lien invalide : adresse incomplète ou mal encodée, sans appel au serveur', async () => {
  for (const pathname of ['/t/1', '/t/%E0%A4%A/secret']) {
    const page = await open({ path: pathname });
    assertInvalidLink(page);
    assert.equal(page.stateRequests().length, 0, `${pathname} : aucun état demandé`);
    await page.poll();
    assert.equal(page.stateRequests().length, 0, 'pas de rafraîchissement périodique');
  }
  const english = await open({ path: '/t/1', languages: ['en'] });
  assertInvalidLink(english, { who: 'Invalid link', conn: 'Access denied' });
});

test('lien invalide : refus 403 du serveur, puis plus aucun rafraîchissement', async () => {
  const page = await open({ respond: url => url.startsWith('/api/state?') ? reply(403, { error: 'Lien de table invalide ou périmé. Scanne le QR code affiché à ta table.' }) : undefined });
  assertInvalidLink(page);
  const count = page.stateRequests().length;
  await page.poll();
  page.dispatch(page.document, 'visibilitychange');
  await page.settle();
  assert.equal(page.stateRequests().length, count, 'la page ne redemande plus l’état');
});

test('connexion perdue : « Hors ligne », puis « À jour » au retour du réseau', async () => {
  let offline = true;
  const page = await open({ respond: url => url.startsWith('/api/state?') && offline ? new TypeError('Failed to fetch') : undefined });
  assert.equal(page.node('conn').textContent, 'Hors ligne');
  assert.equal(page.node('conn').className, 'pill bad');
  assert.equal(page.node('fatalBox').hidden, true, 'une coupure réseau n’est pas un lien invalide');
  offline = false;
  await page.poll();
  assert.equal(page.node('conn').textContent, 'À jour');
  assert.equal(page.node('conn').className, 'pill ok');
  assert.match(page.node('peopleList').innerHTML, /Alice/);
});

test('historique indisponible au chargement : la page fonctionne quand même', async () => {
  const page = await open({ historyThrows: true });
  assert.equal(page.node('conn').textContent, 'À jour');
  assert.match(page.node('peopleList').innerHTML, /Alice/);
});

// ================================================================ jetons
test('ancien jeton unique : repris pour la personne du téléphone puis effacé', async () => {
  const state = baseState({ me: { id: 'alice', name: 'Alice' } });
  const page = await open({ state, storage: { 'kfTok:1:secret': 'jeton-ancien' } });
  assert.deepEqual(JSON.parse(page.stateRequests()[0].headers['x-person-tokens']), ['jeton-ancien'], 'l’ancien jeton est présenté au serveur');
  assert.deepEqual(JSON.parse(page.storage.get('kfPeople:1:secret')), { alice: 'jeton-ancien' }, 'rangé au nom de la personne');
  assert.equal(page.storage.has('kfTok:1:secret'), false, 'l’ancien format est effacé');
  await page.tap('peopleList', '[data-remove-song="e1"]');
  assert.deepEqual(page.posts.at(-1), ['/api/table/song/remove', { table: '1', access: 'secret', personId: 'alice', entryId: 'e1', token: 'jeton-ancien' }],
    'les actions de la personne portent son jeton');
  assert.equal(page.toast().text, 'Chanson retirée de la liste.');
});

test('gestion passée sur un autre téléphone : prévenu, jeton oublié, catalogue sans cible', async () => {
  const state = baseState();
  state.tablePeople.push(person('bob', 'Bob'));
  const page = await open({ state, storage: { 'kfPeople:1:secret': JSON.stringify({ alice: 'jeton-a', bob: 'jeton-b' }) } });
  assert.equal(page.toast().text, 'La gestion de Bob est passée sur un autre téléphone.');
  assert.deepEqual(JSON.parse(page.storage.get('kfPeople:1:secret')), { alice: 'jeton-a' });
  await page.tap('peopleList', '[data-add-song="alice"]');
  assert.equal(page.node('catalogTarget').textContent, 'Chansons pour Alice.');
  page.state.managedIds = [];
  await page.poll();
  assert.equal(page.toast().text, 'La gestion d’Alice est passée sur un autre téléphone.');
  assert.equal(page.node('catalogTarget').textContent,
    'Explore le catalogue. Pour ajouter un titre, inscris une personne ou reprends sa gestion avec un code.', 'plus de chanteur visé');
});

// Demande du gérant (8 octobre) : voir la durée d'un titre avant de l'ajouter.
test('durée des titres : catalogue, fiche avant l’ajout et « Mes titres »', async () => {
  const page = await open({
    state: baseState({ tablePeople: [person('alice', 'Alice', { songs: [
      { entryId: 'e1', songId: 1, title: 'Mon titre', artist: 'Moi', duration: 245 },
      { entryId: 'e2', songId: 2, title: 'Sans durée', artist: 'Lui' }] })] }),
    respond: url => url.startsWith('/api/catalog/songs?') ? { songs: [
      { songId: 9, title: 'Tube', artist: 'Groupe', duration: 237 },
      { songId: 10, title: 'Inconnu', artist: 'Personne', duration: null },
      { songId: 11, title: 'Aberrant', artist: 'Erreur', duration: 99999 },
      { songId: 12, title: 'Court', artist: '', duration: 59.6 }], total: 4 } : undefined,
  });
  assert.match(page.node('peopleList').innerHTML, /Moi · 4:05 · prochain titre/, 'durée dans « Mes titres »');
  assert.match(page.node('peopleList').innerHTML, /Lui · à suivre/, 'sans durée connue, rien de plus');
  await page.click(page.node('nav-catalog'));
  await page.tap('catalogContent', '[data-category-index="0"]');
  const list = page.node('catalogContent').innerHTML;
  assert.match(list, /Groupe · 3:57/, 'durée à côté de l’artiste');
  assert.match(list, />Personne</, 'durée inconnue : artiste seul');
  assert.doesNotMatch(list, /Erreur ·/, 'durée aberrante ignorée');
  assert.match(list, />1:00</, 'sans artiste : la durée seule, arrondie');
  await page.tap('catalogContent', '[data-song-index="0"]');
  assert.equal(page.sheetOpen(), true);
  assert.match(page.sheetHtml(), /Groupe · 3:57/, 'durée dans la fiche, avant l’ajout');
});

// Lot J (8 octobre) : durée maximale réglée au bar, envoyée dans rules.maxSongSec.
test('durée maximale : titre trop long grisé « trop long », fiche avec le message, Battle refusée, traduit', async () => {
  const catalog = [{ songId: 9, title: 'Tube', artist: 'Groupe', duration: 237 },
    { songId: 13, title: 'Épopée', artist: 'Rock', duration: 372 },
    { songId: 10, title: 'Inconnu', artist: 'Personne', duration: null }];
  const respond = url => url.startsWith('/api/catalog/songs?') ? { songs: catalog, total: 3 }
    : url.startsWith('/api/search?') ? catalog : undefined;
  const page = await open({ state: baseState({ rules: { maxSongSec: 300 } }), respond });
  await page.click(page.node('nav-catalog'));
  await page.tap('catalogContent', '[data-category-index="0"]');
  const rows = page.node('catalogContent').querySelectorAll('[data-song-index]');
  assert.deepEqual(rows.map(row => row.className), ['song-row', 'song-row too-long', 'song-row'], 'seul le titre trop long est grisé');
  assert.match(page.node('catalogContent').innerHTML, /Rock · 6:12 · trop long/);
  assert.match(page.node('catalogContent').innerHTML, /Groupe · 3:57</, 'un titre normal reste inchangé');
  assert.match(page.node('catalogContent').innerHTML, />Personne</, 'durée inconnue : rien ne change');
  await page.tap('catalogContent', '[data-song-index="1"]');
  assert.equal(page.sheetOpen(), true);
  assert.match(page.sheetHtml(), /Ce titre dure 6:12 : le bar limite les chansons à 5:00\./);
  assert.equal(page.$('appendSong'), null, 'pas de bouton d’ajout pour un titre trop long');
  assert.equal(page.posts.filter(([url]) => url === '/api/table/song').length, 0);
  await page.tap('sheetPanel', '[data-close-sheet]');
  await page.tap('catalogContent', '[data-song-index="0"]');
  assert.ok(page.$('appendSong'), 'titre normal : la fiche d’ajout habituelle');
  await page.tap('sheetPanel', '[data-close-sheet]');

  // Proposition de Battle : le titre trop long est grisé et refusé.
  await page.click(page.node('nav-queue'));
  await page.tap('battleVotes', '[data-battle-propose]');
  page.node('battleSearch').value = 'Rock';
  await page.submit('battleSearchForm');
  const result = page.find('battleSearchResults', '[data-battle-result="1"]');
  assert.equal(result.className, 'too-long');
  assert.match(page.node('battleSearchResults').innerHTML, /Rock · 6:12 · trop long/);
  assert.match(page.node('battleSearchResults').innerHTML, />Groupe</, 'les autres titres gardent leur artiste seul');
  await page.click(result);
  assert.deepEqual(page.toast(), { text: 'Ce titre dure 6:12 : le bar limite les chansons à 5:00.', bad: true, warn: false, hidden: false });
  assert.equal(page.node('battleSelected').querySelectorAll('[data-battle-remove]').length, 0, 'titre trop long non retenu');

  // En anglais, et sans limite : rien de grisé.
  const english = await open({ state: baseState({ rules: { maxSongSec: 300 } }), respond, languages: ['en'] });
  await english.click(english.node('nav-catalog'));
  await english.tap('catalogContent', '[data-category-index="0"]');
  assert.match(english.node('catalogContent').innerHTML, /Rock · 6:12 · too long/);
  await english.tap('catalogContent', '[data-song-index="1"]');
  assert.match(english.sheetHtml(), /This song lasts 6:12: the bar limits songs to 5:00\./);
  const free = await open({ state: baseState(), respond });
  await free.click(free.node('nav-catalog'));
  await free.tap('catalogContent', '[data-category-index="0"]');
  assert.doesNotMatch(free.node('catalogContent').innerHTML, /trop long/);
  await free.tap('catalogContent', '[data-song-index="1"]');
  assert.ok(free.$('appendSong'), 'option coupée : le titre long s’ajoute comme avant');
});

// ================================================================ catalogue ouvert pour un chanteur
test('catalogue pour un chanteur : cible, duo, et refus pour un chanteur non géré', async () => {
  const state = baseState();
  state.tablePeople.push(person('bob', 'Bob'), person('chloe', 'Chloé'));
  state.managedIds = ['alice', 'bob'];
  const page = await open({ state });
  await page.tap('peopleList', '[data-add-song="alice"]');
  assert.equal(page.tabShown(), 'catalog');
  assert.equal(page.node('catalogTarget').textContent, 'Chansons pour Alice. Tu pourras changer de chanteur avant de valider.');
  assert.deepEqual(page.scrolls.at(-1), { top: 0, behavior: 'smooth' }, 'retour en haut de page');
  assert.equal(page.node('battlePickBar').hidden, true);
  await page.click(page.node('nav-table'));
  await page.tap('peopleList', '[data-duet-song="bob"]');
  assert.equal(page.node('catalogTarget').textContent, 'Choisis un titre pour un duo avec Bob.');

  // Garde-fou : un bouton visant une personne gérée par un autre téléphone.
  await page.click(page.node('nav-table'));
  assert.equal(page.node('peopleList').querySelector('[data-person-card="chloe"]'), null, 'Chloé, gérée ailleurs, n’est pas sur la page');
  const stray = new Element(page, 'button', { 'data-add-song': 'chloe' });
  stray.parent = page.node('peopleList');
  page.dispatch(stray, 'click');
  await page.settle();
  assert.deepEqual(page.toast(), { text: 'Ce téléphone ne gère pas ce chanteur.', bad: true, warn: false, hidden: false });
  assert.equal(page.tabShown(), 'table', 'on reste sur « Ma table »');

  const english = await open({ state, languages: ['en'] });
  english.dispatch(Object.assign(new Element(english, 'button', { 'data-duet-song': 'chloe' }), { parent: english.node('peopleList') }), 'click');
  await english.settle();
  assert.equal(english.toast().text, 'This phone doesn’t manage this singer.');
  await english.tap('peopleList', '[data-duet-song="alice"]');
  assert.equal(english.node('catalogTarget').textContent, 'Choose a song for a duet with Alice.');
});

test('catalogue en solo : « Choisir une chanson » ouvre le catalogue pour soi', async () => {
  const state = baseState({ table: { id: 'Comptoir', name: 'En solo', individual: true, count: 3 }, soloInvitationReady: false });
  const page = await open({ state, path: '/t/Comptoir/secret' });
  assert.equal(page.node('quickSongBox').hidden, false);
  await page.tap('quickSongActions', '[data-quick-song="alice"]');
  assert.equal(page.tabShown(), 'catalog');
  assert.equal(page.node('catalogTarget').textContent, 'Chansons pour Alice.');
});

// ================================================================ partenaire de duo
const partners = [
  { id: 'alice', name: 'Alice', tableId: '1', table: 'Table 1' },
  { id: 'marc', name: 'Marc', tableId: '1', table: 'Table 1' },
  { id: 'marc', name: 'Marc', tableId: '1', table: 'Table 1' },
  { id: 'zoe', name: 'Zoé', tableId: '2', table: 'Table 2', guestDuos: 2 },
  { id: 'sam', name: 'Sam', tableId: 'Comptoir', table: '', individual: true, guestDuos: 1 },
];

test('duo : partenaires de la table et des autres tables, invitation ou ajout direct', async () => {
  const page = await open({ respond: (url, body, self) => {
    if (url.startsWith('/api/duo/partners?')) return partners;
    if (url.startsWith('/api/catalog/songs?')) return { songs: [{ songId: 9, title: 'Tube', artist: 'Groupe', duration: 200 }], total: 1 };
    if (url === '/api/table/duet') return body.partnerId === 'marc' ? { ok: true } : { ok: true, notice: { queued: [{ pos: 3, name: 'Léa' }] } };
    return undefined;
  } });
  await page.tap('peopleList', '[data-duet-song="alice"]');
  await pickCatalogSong(page);
  assert.ok(page.requests.some(request => request.url === '/api/duo/partners?table=1&access=secret'), 'liste des partenaires demandée');
  assert.equal(page.sheetOpen(), true);
  const sheet = page.sheetHtml();
  assert.match(sheet, /Duo sur « Tube »/);
  assert.match(sheet, /Alice utilise son tour/);
  const select = page.node('duoPartner');
  const own = select.querySelector('optgroup[label="À ma table"]');
  const others = select.querySelector('optgroup[label="Autres tables · invitation à accepter"]');
  assert.deepEqual(own.querySelectorAll('option').map(option => option.textContent), ['Marc · Table 1'], 'Marc une seule fois, jamais soi-même');
  assert.deepEqual(others.querySelectorAll('option').map(option => option.textContent), ['↗ Zoé · Table 2', '↗ Sam'], 'un soliste : son prénom seul');
  assert.equal(select.value, 'marc');
  assert.equal(page.node('sendDuo').textContent, 'Ajouter le duo');
  assert.equal(page.node('duoConsent').textContent, 'Même table : le duo est ajouté directement.');
  assert.equal(page.node('duoPartnerHint').hidden, true);

  await page.change('duoPartner', 'zoe');
  assert.equal(page.node('sendDuo').textContent, 'Envoyer l’invitation');
  assert.equal(page.node('duoConsent').textContent, 'Son téléphone devra accepter l’invitation. Sans réponse avant son tour, Alice chantera seul.',
    'repère : sans réponse, le titre part en solo');
  assert.equal(page.node('duoPartnerHint').hidden, false);
  assert.match(page.node('duoPartnerHint').textContent, /^Zoé a déjà 2 duos prévus\. Personne ne monte sur scène plus de deux fois par tour/);
  await page.change('duoPartner', 'sam');
  assert.match(page.node('duoPartnerHint').textContent, /^Sam a déjà 1 duo prévu\./, 'singulier');

  await page.change('duoPartner', 'zoe');
  await page.click(page.node('sendDuo'));
  assert.deepEqual(page.posts.at(-1), ['/api/table/duet', { table: '1', access: 'secret', personId: 'alice', partnerId: 'zoe',
    song: { songId: 9, title: 'Tube', artist: 'Groupe', duration: 200 } }]);
  assert.equal(page.sheetOpen(), false);
  assert.equal(page.tabShown(), 'table', 'retour à « Ma table »');
  const sent = page.toast();
  assert.match(sent.text, /^Invitation de duo envoyée\. ⚠ Quelqu’un l’a aussi prévu plus tard dans la file \(n°3, Léa\)\.$/);
  assert.equal(sent.warn, true, 'titre déjà prévu : avertissement');

  await page.tap('peopleList', '[data-duet-song="alice"]');
  // Le catalogue est resté sur les titres de la sélection.
  await page.tap('catalogContent', '[data-song-index="0"]');
  await page.click(page.node('sendDuo'));
  assert.equal(page.posts.at(-1)[1].partnerId, 'marc');
  assert.deepEqual(page.toast(), { text: 'Duo ajouté à la liste.', bad: false, warn: false, hidden: false });
});

test('duo : refus, liste vide, erreur réseau et erreur du serveur à l’envoi', async () => {
  let mode = 'error';
  const page = await open({ respond: url => {
    if (url.startsWith('/api/duo/partners?')) {
      if (mode === 'error') return reply(503, { error: 'Liste des partenaires indisponible.' });
      if (mode === 'network') return new TypeError('Failed to fetch');
      if (mode === 'alone') return [partners[0]];
      return partners;
    }
    if (url === '/api/table/duet') return reply(409, { error: 'Zoé chante déjà deux fois ce tour-ci.' });
    return undefined;
  } });
  await page.tap('peopleList', '[data-duet-song="alice"]');
  await pickCatalogSong(page);
  assert.deepEqual(page.toast(), { text: 'Liste des partenaires indisponible.', bad: true, warn: false, hidden: false });
  assert.equal(page.sheetOpen(), false, 'pas de fenêtre vide');
  mode = 'network';
  await page.tap('catalogContent', '[data-song-index="0"]');
  assert.equal(page.toast().bad, true);
  // Regression: relecture — le message brut du navigateur, en anglais, n'est plus montré.
  assert.equal(page.toast().text, 'Connexion perdue : réessaie dans un instant.');
  assert.equal(page.sheetOpen(), false);
  mode = 'alone';
  await page.tap('catalogContent', '[data-song-index="0"]');
  assert.deepEqual(page.toast(), { text: 'Aucun partenaire disponible pour un duo.', bad: true, warn: false, hidden: false });
  mode = 'ok';
  await page.tap('catalogContent', '[data-song-index="0"]');
  await page.change('duoPartner', 'zoe');
  await page.click(page.node('sendDuo'));
  assert.deepEqual(page.toast(), { text: 'Zoé chante déjà deux fois ce tour-ci.', bad: true, warn: false, hidden: false });
  assert.equal(page.sheetOpen(), true, 'la fenêtre reste ouverte pour choisir quelqu’un d’autre');
  assert.equal(page.node('sendDuo').disabled, false, 'bouton de nouveau utilisable');

  const english = await open({ languages: ['en'], respond: url => url.startsWith('/api/duo/partners?') ? [partners[0]] : undefined });
  await english.tap('peopleList', '[data-duet-song="alice"]');
  await pickCatalogSong(english);
  assert.equal(english.toast().text, 'No one available for a duet.');
});

test('duo depuis la fiche du titre : chanteur choisi parmi plusieurs, « Chanter en duo »', async () => {
  const state = baseState();
  state.tablePeople.push(person('bob', 'Bob'));
  state.managedIds = ['alice', 'bob'];
  const page = await open({ state, respond: url => url.startsWith('/api/duo/partners?') ? partners : undefined });
  await page.click(page.node('nav-catalog'));
  await pickCatalogSong(page);
  assert.equal(page.node('songPerson').tag, 'select', 'deux chanteurs : liste de choix');
  assert.deepEqual(page.node('songPerson').querySelectorAll('option').map(option => option.textContent), ['Alice', 'Bob']);
  assert.equal(page.node('replaceSong').hidden, false, 'Alice a une chanson à remplacer');
  await page.change('songPerson', 'bob');
  assert.equal(page.node('replaceSong').hidden, true, 'Bob n’a rien à remplacer');
  await page.click(page.node('duetSongChoice'));
  assert.match(page.sheetHtml(), /Bob utilise son tour/);
  assert.deepEqual(page.node('duoPartner').querySelectorAll('option').map(option => option.attrs.value), ['alice', 'marc', 'zoe', 'sam'],
    'Alice devient partenaire possible de Bob');
});

// ================================================================ lien de transfert reçu
function transferPage(offer, extra = {}) {
  const state = baseState(extra.state || {});
  return open({ search: '?reprise=LIEN-TEST&utm=affiche', ...extra, state, respond: (url, body, page) => {
    if (url.startsWith('/api/state?')) {
      const data = JSON.parse(JSON.stringify(page.state));
      if (new URLSearchParams(url.split('?')[1]).get('reprise')) data.transferOffer = offer;
      return data;
    }
    return extra.respond?.(url, body, page);
  } });
}

test('transfert reçu : récupérer un chanteur, lien oublié ensuite', async () => {
  const page = await transferPage({ personId: 'bob', name: 'Bob' }, { respond: (url, body, self) => {
    if (url === '/api/table/person/claim') {
      self.state.tablePeople.push(person('bob', 'Bob'));
      self.state.managedIds.push('bob');
      return { id: 'bob', token: 'jeton-bob' };
    }
    return undefined;
  } });
  assert.match(page.stateRequests()[0].url, /reprise=LIEN-TEST/, 'le lien est transmis au serveur');
  assert.equal(page.node('transferBox').hidden, false);
  assert.equal(page.node('transferHeading').textContent, 'Gérer Bob sur ce téléphone');
  assert.match(page.node('transferText').textContent, /choisir les chansons de Bob.*garde ses autres chanteurs\.$/);
  assert.deepEqual(page.node('transferActions').querySelectorAll('button').map(button => button.textContent), ['Récupérer Bob', 'Pas maintenant']);
  await page.tap('transferActions', '[data-transfer-claim]');
  assert.deepEqual(page.posts.at(-1), ['/api/table/person/claim', { table: '1', access: 'secret', link: 'LIEN-TEST' }]);
  assert.deepEqual(JSON.parse(page.storage.get('kfPeople:1:secret')), { bob: 'jeton-bob' });
  assert.equal(page.history.urls.at(-1), '/t/1/secret?utm=affiche', 'le lien disparaît de l’adresse, le reste est gardé');
  const last = page.stateRequests().at(-1);
  assert.doesNotMatch(last.url, /reprise/, 'le lien déjà servi n’est plus envoyé');
  assert.ok(JSON.parse(last.headers['x-person-tokens']).includes('jeton-bob'));
  assert.equal(page.node('transferBox').hidden, true);
  assert.equal(page.toast().text, 'Tu gères maintenant Bob sur ce téléphone.');
  assert.ok(page.find('peopleList', '[data-person-card="bob"]'), 'Bob apparaît parmi les chanteurs du téléphone');
});

test('transfert reçu : lien expiré, déjà géré, « En solo », « Pas maintenant » et refus du serveur', async () => {
  const expired = await transferPage({ invalid: true });
  assert.equal(expired.node('transferHeading').textContent, 'Lien de transfert expiré');
  assert.match(expired.node('transferText').textContent, /^Ce lien a déjà servi ou n’est plus valable\./);
  await expired.tap('transferActions', '[data-transfer-dismiss]');
  assert.equal(expired.node('transferBox').hidden, true, '« Fermer » masque l’encadré');
  assert.equal(expired.history.urls.at(-1), '/t/1/secret?utm=affiche');
  await expired.poll();
  assert.doesNotMatch(expired.stateRequests().at(-1).url, /reprise/);
  assert.equal(expired.node('transferBox').hidden, true, 'il ne revient pas au rafraîchissement suivant');

  const already = await transferPage({ personId: 'alice', name: 'Alice' });
  assert.equal(already.node('transferHeading').textContent, 'Déjà sur ce téléphone');
  assert.equal(already.node('transferText').textContent, 'Ce téléphone gère déjà les chansons d’Alice. Rien à faire.');
  assert.equal(already.node('transferActions').querySelector('[data-transfer-claim]'), null);

  const solo = await transferPage({ personId: 'bob', name: 'Bob' }, { path: '/t/Comptoir/secret',
    state: { table: { id: 'Comptoir', name: 'En solo', individual: true, count: 2 }, managedIds: [], soloInvitationReady: false } });
  assert.equal(solo.node('transferHeading').textContent, 'Récupérer tes chansons sur ce téléphone');
  assert.match(solo.node('transferText').textContent, /L’autre téléphone perdra cette gestion\.$/);
  assert.equal(solo.find('transferActions', '[data-transfer-claim]').textContent, 'Récupérer mes chansons');

  const english = await transferPage({ personId: 'bob', name: 'Bob' }, { languages: ['en'] });
  assert.equal(english.node('transferHeading').textContent, 'Manage Bob on this phone');

  const later = await transferPage({ personId: 'bob', name: 'Bob' });
  await later.tap('transferActions', '[data-transfer-dismiss]');
  assert.equal(later.node('transferBox').hidden, true, '« Pas maintenant »');
  assert.equal(later.posts.length, 0, 'rien n’est demandé au serveur');

  const refused = await transferPage({ personId: 'bob', name: 'Bob' }, { respond: url =>
    url === '/api/table/person/claim' ? reply(410, { error: 'Ce lien de transfert a expiré.' }) : undefined });
  await refused.tap('transferActions', '[data-transfer-claim]');
  assert.deepEqual(refused.toast(), { text: 'Ce lien de transfert a expiré.', bad: true, warn: false, hidden: false });
  assert.equal(refused.history.urls.length, 0, 'le lien n’est pas oublié après un échec');
  assert.equal(refused.node('transferBox').hidden, false);

  const noLink = await open({ state: baseState({ transferOffer: { personId: 'bob', name: 'Bob' } }) });
  assert.equal(noLink.node('transferBox').hidden, true, 'sans lien dans l’adresse, rien à proposer');
});

// ================================================================ transfert envoyé (QR, lien)
const share = (extra = {}) => ({ url: 'http://192.168.1.20:3000/t/1/secret?reprise=abc', qr: 'data:image/png;base64,QRFAUX',
  code: '4321', linkExpiresAt: Date.now() + 10 * 60000, ...extra });

test('transférer un chanteur : QR code, liens de partage, code, partage et copie', async () => {
  const shared = share();
  const page = await open({ share: true, respond: url => url === '/api/table/person/share' ? shared : undefined });
  await page.tap('peopleList', '[data-share-person="alice"]');
  assert.deepEqual(page.posts.at(-1), ['/api/table/person/share', { table: '1', access: 'secret', personId: 'alice' }]);
  assert.equal(page.sheetOpen(), true);
  const sheet = page.sheetHtml();
  assert.match(page.find('sheetPanel', 'h3').textContent, /^Transférer Alice vers un autre téléphone$/);
  assert.equal(page.find('sheetPanel', 'img').attrs.src, 'data:image/png;base64,QRFAUX');
  assert.equal(page.find('sheetPanel', 'img').attrs.alt, 'QR code pour transférer Alice sur un autre téléphone');
  assert.match(sheet, /touche « Récupérer Alice »/);
  const message = `Pour gérer les chansons d’Alice au karaoké (Table 1), ouvre ce lien : ${shared.url}`;
  assert.ok(sheet.includes(`https://wa.me/?text=${encodeURIComponent(message)}`), 'WhatsApp préremplit le lien');
  assert.ok(sheet.includes(`sms:?&body=${encodeURIComponent(message)}`), 'SMS');
  assert.ok(sheet.includes(`mailto:?subject=${encodeURIComponent('Karaoké : Alice')}`), 'e-mail');
  assert.equal(page.node('transferUrl').value, shared.url);
  assert.equal(page.find('sheetPanel', '.share-code').textContent, '4321');
  assert.ok(sheet.includes(`jusqu’à ${timeOf(shared.linkExpiresAt)}`), 'heure limite du lien');
  assert.match(sheet, /Ce lien ne fonctionne que sur le Wi-Fi du bar\./, 'adresse locale : prévenir');
  assert.equal('open' in page.find('sheetPanel', 'details').attrs, false, 'le code reste replié sous le QR');

  await page.click(page.node('shareTransfer'));
  assert.deepEqual(page.shares, [{ title: 'Karaoké', text: 'Pour gérer les chansons d’Alice au karaoké (Table 1), ouvre ce lien :', url: shared.url }]);
  await page.click(page.node('copyTransfer'));
  assert.deepEqual(page.copies, [shared.url]);
  assert.deepEqual(page.toast(), { text: 'Lien copié : colle-le dans ton message.', bad: false, warn: false, hidden: false });
});

test('transférer : copie refusée, lien https sans heure, code seul et « En solo »', async () => {
  const refused = await open({ clipboardFails: true, respond: url => url === '/api/table/person/share' ? share() : undefined });
  await refused.tap('peopleList', '[data-share-person="alice"]');
  assert.equal(refused.$('shareTransfer'), null, 'sans partage natif, pas de bouton « Partager… »');
  await refused.click(refused.node('copyTransfer'));
  assert.equal(refused.node('transferUrl').selected, true, 'le lien est sélectionné pour une copie à la main');
  assert.equal(refused.execCommands, 1);
  assert.deepEqual(refused.toast(), { text: 'Sélectionne le lien ci-dessous pour le copier.', bad: true, warn: false, hidden: false });

  const fallback = await open({ clipboardFails: true, execCopy: true, respond: url => url === '/api/table/person/share' ? share() : undefined });
  await fallback.tap('peopleList', '[data-share-person="alice"]');
  await fallback.click(fallback.node('copyTransfer'));
  assert.equal(fallback.toast().text, 'Lien copié : colle-le dans ton message.', 'copie de secours réussie');

  const secure = await open({ respond: url => url === '/api/table/person/share' ? share({ url: 'https://karaoke.example/t/1/secret?reprise=abc', linkExpiresAt: null }) : undefined });
  await secure.tap('peopleList', '[data-share-person="alice"]');
  assert.doesNotMatch(secure.sheetHtml(), /Wi-Fi du bar/);
  assert.match(secure.sheetHtml(), /QR code et lien valables une seule fois\. Ne les envoie qu’à la personne concernée\./);

  const codeOnly = await open({ respond: url => url === '/api/table/person/share' ? { code: '9876' } : undefined });
  await codeOnly.tap('peopleList', '[data-share-person="alice"]');
  assert.equal(codeOnly.node('sheetPanel').querySelector('img'), null, 'pas de QR sans lien');
  assert.equal('open' in codeOnly.find('sheetPanel', 'details').attrs, true, 'le code est déplié');
  assert.equal(codeOnly.find('sheetPanel', '.share-code').textContent, '9876');
  assert.match(codeOnly.sheetHtml(), /ouvre le QR code de la table, touche « Voir toute la table », puis « C’est moi » à côté du prénom Alice/);

  const state = baseState({ table: { id: 'Comptoir', name: 'En solo', individual: true, count: 2 } });
  const solo = await open({ state, path: '/t/Comptoir/secret', respond: url => url === '/api/table/person/share' ? share() : undefined });
  await solo.tap('peopleList', '[data-share-person="alice"]');
  assert.equal(solo.find('sheetPanel', 'h3').textContent, 'Changer de téléphone');
  assert.ok(solo.sheetHtml().includes(encodeURIComponent('Lien pour récupérer mes chansons du karaoké sur ce téléphone :')));
  assert.match(solo.sheetHtml(), /ouvre le QR que te montre le bar \(si la page demande un prénom, touche d’abord « Déjà inscrit\u00a0\? J’ai un code »\), touche « Je suis Alice »/);
  assert.doesNotMatch(solo.sheetHtml(), /En solo/, 'le groupe n’est jamais nommé');
});

// ================================================================ alertes
// Stockage de l'onglet (sessionStorage) partagé entre deux chargements.
function sessionMap(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { map, getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)) };
}
// L'horloge de la page avance de `ms` pendant `work`.
async function later(ms, work) {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try { return await work(); } finally { Date.now = realNow; }
}
const ACTION_BUZZ = [200, 100, 200, 100, 400];

test('alertes : son et vibration actifs par défaut, notifications du navigateur au choix', async () => {
  const page = await open({ secure: true, hidden: true, notification: { permission: 'default', grant: 'granted' }, audio: { state: 'suspended' } });
  assert.equal(page.node('signalsBox').hidden, false, 'réglage en haut de « Ma table »');
  assert.equal(page.node('signalsToggle').textContent, '🔔 Son et vibration : activés');
  assert.equal(page.node('signalsToggle').getAttribute('aria-pressed'), 'true');
  assert.equal(page.node('alertsToggle').textContent, 'Activer les notifications');
  assert.match(page.node('alertsHelp').textContent, /^Les demandes s’affichent en grand sur cet écran\. Les notifications du navigateur/);

  page.state.tablePeople[0].needConfirm = true;
  await page.poll();
  assert.deepEqual(page.vibrations, [ACTION_BUZZ], 'longue vibration sans rien activer');
  assert.deepEqual(page.audio.oscillators.map(note => [note.frequency.value, note.startAt]), [[660, 10], [880, 10.18]], 'deux notes');
  assert.equal(page.audio.toSpeaker, 2);
  assert.equal(page.notifications.length, 0, 'notifications du navigateur : seulement sur demande');

  await page.click(page.node('alertsToggle'));
  assert.equal(page.permissionRequests, 1, 'autorisation du navigateur demandée');
  assert.equal(page.storage.get('kfAlerts:1:secret'), '1');
  assert.equal(page.node('alertsToggle').textContent, 'Désactiver les notifications');
  assert.equal(page.toast().text, 'Notifications activées tant que la page reste ouverte.');

  page.state.tablePeople[0].invites = [{ entryId: 'x1', fromName: 'Zoé', song: { title: 'Hit' } }];
  await page.poll();
  const [notice] = page.notifications;
  assert.deepEqual([notice.title, notice.body, notice.tag], ['Karaoké : réponse attendue', 'Zoé propose un duo à Alice', 'invite:alice:x1-1']);
  assert.equal(page.vibrations.length, 2);
  notice.onclick();
  assert.equal(page.focusWindow, 1);
  assert.equal(notice.closed, true);
  await page.poll();
  assert.equal(page.vibrations.length, 2, 'la même demande ne vibre pas deux fois');

  // Page visible, demande sans réponse : le son revient toutes les 20 s.
  page.document.hidden = false;
  await page.poll();
  assert.equal(page.audio.oscillators.length, 4, 'pas avant 20 s');
  await later(21000, () => page.poll());
  assert.equal(page.audio.oscillators.length, 6, 'rappel sonore');
  assert.equal(page.vibrations.length, 2, 'le rappel ne vibre pas');

  await page.click(page.node('signalsToggle'));
  assert.equal(page.storage.get('kfSignals:1:secret'), '0');
  assert.equal(page.node('signalsToggle').textContent, '🔕 Son et vibration : coupés');
  assert.equal(page.toast().text, 'Son et vibration coupés.');
  page.state.tablePeople[0].invites.push({ entryId: 'x2', fromName: 'Marc', song: { title: 'Autre' } });
  await page.poll();
  assert.equal(page.vibrations.length, 2, 'son et vibration coupés');
  await later(60000, () => page.poll());
  assert.equal(page.audio.oscillators.length, 6, 'ni rappel sonore');
  await page.click(page.node('signalsToggle'));
  assert.equal(page.toast().text, 'Son et vibration activés.');
  assert.deepEqual(page.vibrations.at(-1), [120], 'courte vibration pour essayer');
  await page.click(page.node('alertsToggle'));
  assert.equal(page.toast().text, 'Notifications du navigateur désactivées.');
  assert.equal(page.storage.get('kfAlerts:1:secret'), '0');
});

test('alertes : son débloqué au premier toucher, choix coupé gardé, échecs silencieux', async () => {
  const plain = await open({ audio: {} });
  assert.equal(plain.node('alertsToggle').hidden, true, 'sans HTTPS : pas de bouton de notification');
  assert.match(plain.node('alertsHelp').textContent, /^Les demandes s’affichent en grand sur cet écran, avec un son/);
  plain.dispatch(plain.document, 'pointerdown');
  plain.dispatch(plain.document, 'pointerdown');
  assert.equal(plain.audio.contexts, 1, 'le premier toucher prépare le son, sans réglage');
  const refused = await open({ audio: { refuse: true } });
  assert.doesNotThrow(() => refused.dispatch(refused.document, 'pointerdown'), 'son interdit : aucune erreur');

  const quiet = await open({ audio: {}, storage: { 'kfSignals:1:secret': '0' } });
  assert.equal(quiet.node('signalsToggle').getAttribute('aria-pressed'), 'false');
  quiet.state.tablePeople[0].needConfirm = true;
  await quiet.poll();
  assert.equal(quiet.node('attention').hidden, false, 'la demande s’affiche quand même');
  assert.deepEqual([quiet.vibrations.length, quiet.audio.oscillators.length], [0, 0]);

  // Son bloqué, notifications refusées par le navigateur : la page continue.
  const broken = await open({ secure: true, hidden: true, audio: { fail: true }, notification: { permission: 'granted', throws: true },
    storage: { 'kfAlerts:1:secret': '1' } });
  broken.state.tablePeople[0].needConfirm = true;
  broken.state.tablePeople[0].invites = [{ entryId: 'x1', fromName: 'Zoé', song: { title: 'Hit' } }];
  await broken.poll();
  assert.equal(broken.node('attention').hidden, false);
  assert.equal(broken.notifications.length, 0);
  assert.deepEqual(broken.vibrations, [ACTION_BUZZ], 'une seule alerte pour deux demandes arrivées ensemble');

  const denied = await open({ secure: true, notification: { permission: 'default', grant: 'denied' } });
  await denied.click(denied.node('alertsToggle'));
  assert.deepEqual(denied.toast(), { text: 'Le navigateur refuse ses notifications : le son et la vibration restent actifs.', bad: true, warn: false, hidden: false });
});

test('demandes : fenêtre bloquante, une demande à la fois dans l’ordre, pour chaque personne du téléphone', async () => {
  const state = baseState({ battle: { id: 'b1', phase: 'voting', mode: 'yesno', eligiblePersonIds: ['alice', 'bob'], votedPersonIds: [],
    closesAt: Date.now() + 120000, eligible: 4, threshold: 2, minVoters: 2, registered: 4 } });
  // La demande de Marc vise le deuxième titre d'Alice : la présence (premier titre) passe avant.
  state.tablePeople = [person('alice', 'Alice', { needConfirm: true, canDefer: true, songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre' },
    { entryId: 'e2', songId: 2, title: 'Deuxième' }],
    invites: [{ entryId: 'x1', fromName: 'Zoé', song: { title: 'Hit' } }],
    joinRequests: [{ entryId: 'e2', fromId: 'marc', fromName: 'Marc', song: { title: 'Deuxième' } }] }), person('bob', 'Bob')];
  state.managedIds = ['alice', 'bob'];
  let answer = null;
  const page = await open({ state, respond: (url, body, self) => {
    const alice = self.state.tablePeople[0];
    if (url === '/api/table/confirm') alice.needConfirm = false;
    if (url === '/api/table/duet/answer') return answer || ((alice.invites = []), { ok: true });
    if (url === '/api/table/duet/join/answer') alice.joinRequests = [];
    if (url === '/api/table/battle/vote') self.state.battle.votedPersonIds.push(body.personId);
    return undefined;
  } });
  const choices = () => page.node('attentionChoices').querySelectorAll('button').map(button => button.textContent);
  // Les signaux « vue » partent à l'affichage d'un duo ; ils ne sont pas une réponse.
  const lastAction = () => page.posts.filter(([url]) => url !== '/api/table/duet/seen').at(-1);
  assert.equal(page.node('attention').hidden, false);
  assert.equal(page.node('attentionPanel').getAttribute('role'), 'alertdialog');
  assert.equal(page.node('attentionPanel').getAttribute('aria-modal'), 'true');
  assert.equal(page.node('attentionWho').textContent, 'Pour Alice', 'le nom de la personne d’abord');
  assert.equal(page.node('attentionTitle').textContent, 'C’est bientôt au tour d’Alice\u00a0!');
  assert.equal(page.node('attentionCount').textContent, '1 / 5');
  assert.deepEqual(choices(), ['Je suis là', 'Pas prêt : repousser d’une chanson'], 'présence : jamais « Plus tard »');
  for (const id of ['topBar', 'tabsNav', 'mainContent', 'sheet', 'infoBar']) assert.equal(page.node(id).inert, true, `${id} inerte`);
  const first = page.node('attentionChoices').querySelector('button');
  assert.equal(page.document.activeElement, first, 'le bouton principal reçoit le focus');
  assert.equal(page.document.title, '(5) Karaoké — ma table');

  // Clavier : Échap ne ferme pas, Tab reste dans la fenêtre.
  const escape = page.dispatch(first, 'keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(page.node('attention').hidden, false);
  const last = page.node('attentionChoices').querySelectorAll('button').at(-1);
  last.focus();
  assert.equal(page.dispatch(last, 'keydown', { key: 'Tab', shiftKey: false }).defaultPrevented, true);
  assert.equal(page.document.activeElement, first);
  assert.equal(page.dispatch(first, 'keydown', { key: 'Tab', shiftKey: true }).defaultPrevented, true);
  assert.equal(page.document.activeElement, last);
  page.dispatch(last, 'keydown', { key: 'a' });
  // La mise à jour régulière ne recrée pas la fenêtre et ne déplace pas le focus.
  await page.poll();
  assert.equal(page.node('attentionChoices').querySelectorAll('button').at(-1), last, 'mêmes boutons');
  assert.equal(page.document.activeElement, last);

  await page.click(first);
  assert.deepEqual(lastAction(), ['/api/table/confirm', { table: '1', access: 'secret', personId: 'alice' }]);
  assert.equal(page.toast().text, 'Présence confirmée.');
  assert.equal(page.node('attentionTitle').textContent, 'Zoé propose un duo à Alice');
  assert.deepEqual(page.posts.at(-1), ['/api/table/duet/seen', { table: '1', access: 'secret', personId: 'alice', entryId: 'x1' }],
    'invitation affichée : vue');
  assert.equal(page.node('attentionText').textContent,
    'Sur « Hit ». Seul Zoé dépense son tour ; Alice garde ses propres chansons. Réponds avant son tour, sinon l’invitation expire.');
  assert.equal(page.node('attentionCount').textContent, '1 / 4');
  assert.deepEqual(choices(), ['Accepter', 'Refuser', 'Plus tard (1 min)']);

  // Erreur du serveur : affichée dans la fenêtre, boutons de nouveau actifs.
  answer = reply(400, { error: 'Invitation expirée.' });
  await page.tap('attentionChoices', '[data-attn="yes"]');
  assert.equal(page.node('attentionError').hidden, false);
  assert.equal(page.node('attentionError').textContent, 'Invitation expirée.');
  assert.equal(page.find('attentionChoices', '[data-attn="yes"]').disabled, false);
  answer = null;

  // Plus tard : l'invitation revient dans une minute, la demande suivante passe.
  await page.tap('attentionChoices', '[data-attn="later"]');
  assert.equal(page.node('attentionTitle').textContent, 'Marc aimerait chanter « Deuxième » avec Alice.');
  assert.equal(page.node('attentionError').hidden, true, 'l’erreur ne suit pas la demande suivante');
  await page.tap('attentionChoices', '[data-attn="no"]');
  assert.deepEqual(lastAction()[1], { table: '1', access: 'secret', personId: 'alice', entryId: 'e2', fromId: 'marc', accept: false });
  assert.equal(page.toast().text, 'Demande refusée.');
  assert.equal(page.node('attentionTitle').textContent, 'Vote Battle : toute la salle chante\u00a0!');
  assert.deepEqual(choices(), ['Oui', 'Non', 'Plus tard (1 min)']);
  await page.tap('attentionChoices', '[data-choice="yes"]');
  assert.deepEqual(lastAction(), ['/api/table/battle/vote', { table: '1', access: 'secret', personId: 'alice', choice: 'yes' }]);
  assert.equal(page.node('attentionWho').textContent, 'Pour Bob', 'le téléphone répond ensuite pour Bob');
  assert.equal(page.node('attentionCount').textContent, '', 'dernière demande');
  await page.tap('attentionChoices', '[data-choice="no"]');
  assert.equal(page.toast().text, 'Vote enregistré.');
  assert.equal(page.node('attention').hidden, true, 'plus rien à répondre');
  assert.equal(page.node('mainContent').inert, false);
  assert.equal(page.document.title, 'Karaoké — ma table');

  // Une minute plus tard, l'invitation remise revient.
  await later(61000, () => page.poll());
  assert.equal(page.node('attentionTitle').textContent, 'Zoé propose un duo à Alice');
  await page.tap('attentionChoices', '[data-attn="yes"]');
  assert.equal(page.toast().text, 'Duo accepté.');
  assert.equal(page.node('attention').hidden, true);
});

test('demandes : vote par titre, refus d’invitation, lien refusé et changement de langue', async () => {
  const state = baseState({ battle: { id: 'b2', phase: 'voting', mode: 'songs', eligiblePersonIds: ['alice'], votedPersonIds: [],
    closesAt: Date.now() + 65000, songOptions: [{ songId: 9, title: 'Tube', artist: 'Groupe', votes: 0 }], minVoters: 2, registered: 4 } });
  const page = await open({ state, respond: url => url === '/api/table/battle/vote'
    ? reply(403, { error: 'Lien de table invalide ou périmé. Scanne le QR code affiché à ta table.', code: 'TABLE_ACCESS' }) : undefined });
  assert.match(page.node('attentionText').textContent, /^Choisis un titre ou « Pas de Battle »\. Fin du vote dans 1:0\d\.$/);
  assert.deepEqual(page.node('attentionChoices').querySelectorAll('button').map(button => button.textContent), ['Tube — Groupe', 'Pas de Battle', 'Plus tard (1 min)']);
  await later(10000, () => page.runTimers(1000));
  assert.match(page.node('attentionClock').textContent, /^Fin du vote dans 0:5\d\.$/, 'compte à rebours à la seconde');
  await page.click(page.find('langSwitch', '[data-lang="en"]'));
  assert.equal(page.node('attentionTitle').textContent, 'Battle vote: the whole room sings!', 'la fenêtre suit la langue');
  assert.equal(page.document.title, '(1) Karaoke — my table');
  await page.tap('attentionChoices', '[data-choice="none"]');
  assert.equal(page.node('attention').hidden, true, 'lien refusé : la fenêtre se ferme');
  assertInvalidLink(page, { who: 'Invalid link', conn: 'Access denied' });

  // Invitation refusée.
  const invited = baseState();
  invited.tablePeople[0].invites = [{ entryId: 'x1', fromName: 'Zoé', song: { title: 'Hit' } }];
  const second = await open({ state: invited, respond: (url, body, self) => { if (url === '/api/table/duet/answer') self.state.tablePeople[0].invites = []; } });
  await second.tap('attentionChoices', '[data-attn="no"]');
  assert.deepEqual(second.posts.at(-1)[1], { table: '1', access: 'secret', personId: 'alice', entryId: 'x1', accept: false });
  assert.equal(second.toast().text, 'Invitation refusée.');
});

test('demandes : la fenêtre ouverte dessous reste intacte, Retour ne ferme pas la demande, le focus revient', async () => {
  const page = await open({ respond: (url, body, self) => { if (url === '/api/table/duet/answer') self.state.tablePeople[0].invites = []; } });
  await page.click(page.node('nav-catalog'));
  await pickCatalogSong(page);
  assert.equal(page.sheetOpen(), true);
  const append = page.node('appendSong');
  append.focus();
  page.state.tablePeople[0].invites = [{ entryId: 'x1', fromName: 'Zoé', song: { title: 'Hit' } }];
  await page.poll();
  assert.equal(page.node('attention').hidden, false, 'la demande passe devant la fenêtre du titre');
  assert.equal(page.node('sheet').inert, true);
  const depth = page.history.index;
  page.history.back();
  await page.settle();
  assert.equal(page.node('attention').hidden, false, 'Retour ne ferme pas la demande');
  assert.equal(page.sheetOpen(), true, 'ni la fenêtre du titre');
  assert.equal(page.history.index, depth, 'l’étape d’historique est remise');
  await page.tap('attentionChoices', '[data-attn="no"]');
  assert.equal(page.node('attention').hidden, true);
  assert.equal(page.sheetOpen(), true, 'la fenêtre du titre est toujours là');
  assert.equal(page.node('appendSong'), append, 'avec le même titre choisi');
  assert.equal(page.tabShown(), 'catalog', 'sur le catalogue');
  assert.equal(page.document.activeElement, append, 'le focus revient où il était');
  assert.equal(page.node('sheet').inert, false);
});

test('infos : Battle, résultat, passage imminent, fermeture et messages ; deux au plus, × gardé pour l’onglet', async () => {
  const now = Date.now();
  const state = baseState({
    battle: { id: 'b3', phase: 'requested', mode: 'staff', selectedSong: { title: 'Tube', artist: 'Groupe' }, eligiblePersonIds: [], votedPersonIds: [],
      lastOutcome: { id: 'b2', outcome: 'rejected', at: now - 60000 } },
    next: { ours: true, ids: ['alice'], song: { entryId: 'e1' }, title: 'Mon titre' },
    closing: { at: now + 3600000, full: true, passed: false, fitCount: 2 },
  });
  state.tablePeople = [person('alice', 'Alice', { canDefer: true, songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre' }],
    guestDuos: [{ entryId: 'g1', ownerId: 'bob', fromName: 'Bob', song: { title: 'Slow' } }],
    inbox: [{ id: 'n1', kind: 'joinExpired', params: { name: 'Zoé', title: 'Hit', reason: 'sent' }, at: now },
      { id: 'n2', kind: 'duoAdded', params: { name: 'Bob', fromId: 'bob', title: 'Slow', entryId: 'g1' }, at: now },
      { id: 'n3', kind: 'inconnu', params: {}, at: now }] }),
  person('carla', 'Carla', { inbox: [{ id: 'n4', kind: 'duoAdded', params: { name: 'Alice', fromId: 'alice', title: 'Duo' }, at: now }] })];
  state.managedIds = ['alice', 'carla'];
  const session = sessionMap();
  const page = await open({ state, session });
  const items = () => page.node('infoBar').querySelectorAll('.info-item').map(item => item.querySelector('p').textContent);
  assert.equal(page.node('infoBar').hidden, false);
  assert.deepEqual(items(), ['Le bar lance une Battle\u00a0! Tube — Groupe. Scanne le QR code affiché par KaraFun : ton téléphone sert de micro.',
    'Pas de Battle cette fois : la salle a voté contre.']);
  assert.equal(page.find('infoBar', '[data-info-more]').textContent, '+4 autres messages');
  assert.deepEqual(page.vibrations, [[120]], 'courte vibration pour les infos');
  assert.deepEqual(page.posts.filter(([url]) => url === '/api/table/notice/ack').map(([, body]) => [body.personId, body.ids]), [['carla', ['n4']]],
    'duo ajouté depuis ce même téléphone : effacé sans être montré');
  await page.tap('infoBar', '[data-info-more]');
  assert.deepEqual(items().slice(2), ['Alice passe juste après la chanson en cours : prépare-toi\u00a0!',
    'Fermeture du bar à ' + timeOf(now + 3600000) + ' : La file est complète jusqu’à la fermeture : plus de nouvel ajout. Les titres prévus restent.',
    'La demande de duo d’Alice à Zoé a expiré : « Hit » est parti dans KaraFun.', 'Bob chantera « Slow » en duo avec Alice.']);
  // « Pas prêt » depuis l'info du passage imminent.
  await page.tap('infoBar', '[data-info-defer="alice"]');
  assert.deepEqual(page.posts.at(-1), ['/api/table/defer', { table: '1', access: 'secret', personId: 'alice', songs: 1 }]);
  // × : l'info disparaît, le message est effacé sur le serveur.
  await page.tap('infoBar', '[data-info-dismiss="notice:n1"]');
  assert.deepEqual(page.posts.at(-1), ['/api/table/notice/ack', { table: '1', access: 'secret', personId: 'alice', ids: ['n1'] }]);
  assert.ok(!items().some(text => /a expiré/.test(text)));
  await page.tap('infoBar', '[data-info-dismiss="battle-req:b3"]');
  // « Je ne chante pas ce duo » : confirmation dans la fenêtre.
  await page.tap('infoBar', '[data-info-leave="notice:n2"]');
  assert.equal(page.node('attentionTitle').textContent, 'Alice ne chante plus ce duo\u00a0?');
  await page.tap('attentionChoices', '[data-attn="yes"]');
  assert.deepEqual(page.posts.at(-1), ['/api/table/duet/leave', { table: '1', access: 'secret', personId: 'alice', ownerId: 'bob', entryId: 'g1' }]);

  // Rechargement : les infos fermées ne reviennent pas, rien ne vibre de nouveau.
  const reloaded = await open({ state: page.state, session });
  assert.ok(!reloaded.node('infoBar').querySelectorAll('.info-item').some(item => /Battle\u00a0!/.test(item.textContent)));
  assert.deepEqual(reloaded.vibrations, []);
  // Sur scène : plus d'avis de passage (retour du bar, 4 octobre), rien ne vibre.
  reloaded.state.stage = { ours: true, ids: ['alice'], queueId: 5, title: 'Mon titre' };
  reloaded.state.next = null;
  await reloaded.poll();
  reloaded.node('infoBar').querySelector('[data-info-more]') && await reloaded.tap('infoBar', '[data-info-more]');
  assert.ok(!reloaded.node('infoBar').querySelectorAll('.info-item p').some(p => /sur scène/.test(p.textContent)));
  assert.deepEqual(reloaded.vibrations, []);
  // Plus rien à montrer : la barre disparaît.
  reloaded.state.stage = null;
  reloaded.state.battle = baseState().battle;
  reloaded.state.closing = null;
  reloaded.state.tablePeople.forEach(row => { row.inbox = []; });
  await reloaded.poll();
  assert.equal(reloaded.node('infoBar').hidden, true);
});

test('infos : chaque message du serveur a son texte, et la fermeture annoncée ou passée', async () => {
  const at = Date.now();
  const notices = [['duoCancelled', { name: 'Bob', title: 'T' }, 'Bob a annulé le duo avec Alice sur « T ».'],
    ['duoRefused', { name: 'Bob', title: 'T' }, 'Bob ne chantera pas « T » avec Alice : Alice le chantera en solo.'],
    ['duoLeft', { name: 'Bob', title: 'T', sent: true }, 'Bob ne chante plus « T » avec Alice : Alice le chantera en solo. KaraFun affiche encore les deux noms.'],
    ['duoLeft', { name: 'Bob', title: 'T', sent: false }, 'Bob ne chante plus « T » avec Alice : Alice le chantera en solo.'],
    ['joinAccepted', { name: 'Bob', title: 'T' }, 'Bob accepte de chanter « T » avec Alice.'],
    ['joinRefused', { title: 'T' }, 'Quelqu’un préfère chanter « T » sans Alice.'],
    ['joinExpired', { name: 'Bob', reason: 'removed' }, 'La demande de duo d’Alice à Bob est close : « ce titre » n’est plus dans sa liste.'],
    ['presenceRemoved', { title: 'T', skips: 3 }, '« T » est retiré de la liste d’Alice : présence non confirmée 3 fois. Vois avec le bar si besoin.'],
    ['closingPulled', { title: 'T' }, '« T » passerait après la fermeture : il est retiré de KaraFun et reste dans la liste d’Alice.'],
    // Durée maximale : retrait groupé des titres trop longs par le bar.
    ['tooLongRemoved', { title: 'T', limit: '5:00' }, '« T » est retiré de la liste d’Alice : le bar limite maintenant les chansons à 5:00.'],
    ['tooLongRemoved', { title: 'T', limit: '5:00', name: 'Bob' }, 'Le duo « T » avec Bob est retiré de la file : le bar limite maintenant les chansons à 5:00.'],
    // Invitée d'un duo : le titre revient dans la liste de son auteur.
    ['closingPulled', { title: 'T', name: 'Bob' }, '« T » passerait après la fermeture : il est retiré de KaraFun et reste dans la liste de Bob.']];
  const state = baseState({ closing: { at: at + 600000, passed: true } });
  state.tablePeople[0].inbox = notices.map(([kind, params], index) => ({ id: `m${index}`, kind, params, at }));
  const page = await open({ state });
  await page.tap('infoBar', '[data-info-more]');
  assert.deepEqual(page.node('infoBar').querySelectorAll('.info-item p').map(p => p.textContent),
    ['Le bar ferme : plus de nouveau titre ce soir.', ...notices.map(row => row[2])]);
  const english = await open({ state, languages: ['en'] });
  await english.tap('infoBar', '[data-info-more]');
  assert.ok(english.node('infoBar').querySelectorAll('.info-item p').some(p => p.textContent === '“T” was removed from Alice’s list: presence not confirmed 3 times. Check with the bar if needed.'));
  assert.ok(english.node('infoBar').querySelectorAll('.info-item p').some(p => p.textContent === '“T” would play after closing time: it was taken out of KaraFun and stays on Bob’s list.'));
  assert.ok(english.node('infoBar').querySelectorAll('.info-item p').some(p => p.textContent === '“T” was removed from Alice’s list: the bar now limits songs to 5:00.'));
  state.closing = { at: at + 600000, passed: false, full: false };
  state.tablePeople[0].inbox = [];
  state.battle = { ...state.battle, lastOutcome: { id: 'old', outcome: 'quorum', at } };
  const open2 = await open({ state });
  assert.deepEqual(open2.node('infoBar').querySelectorAll('.info-item p').map(p => p.textContent),
    ['Pas de Battle cette fois : pas assez de votants.', `Fermeture du bar à ${timeOf(at + 600000)}`]);
  state.battle = { ...state.battle, phase: 'requested', id: 'v', mode: 'songs', lastOutcome: { id: 'v0', outcome: 'dismissed', at } };
  state.closing = null;
  const open3 = await open({ state });
  assert.deepEqual(open3.node('infoBar').querySelectorAll('.info-item p').map(p => p.textContent),
    ['La Battle aura lieu\u00a0! Scanne le QR code affiché par KaraFun : ton téléphone sert de micro.', 'Le bar a écarté la Battle proposée.']);
});

test('duos : se retirer, chanter seul, avec confirmation dans la fenêtre ; repères « ⇅ » et « réponse avant l’envoi »', async () => {
  const state = baseState({ queue: [
    { pos: 1, source: 'helper', id: 'bruno', ids: ['bruno'], name: 'Bruno', title: 'Tube', song: { entryId: 'b1', title: 'Tube' } },
    { pos: 2, source: 'helper', id: 'chloe', ids: ['chloe'], name: 'Chloé', title: 'Slow', song: { entryId: 'c1', title: 'Slow' } }] });
  state.tablePeople[0] = person('alice', 'Alice', {
    songs: [{ entryId: 'e1', songId: 1, title: 'Un' }, { entryId: 'e2', songId: 2, title: 'Deux' }],
    guestDuos: [{ entryId: 'g1', ownerId: 'bruno', fromName: 'Bruno', song: { title: 'Hit' } }],
    sentJoinRequests: [{ ownerId: 'chloe', ownerName: 'Chloé', entryId: 'c1', song: { title: 'Slow' } }],
    inKaraFun: [{ title: 'Envoyé', entryId: 'k1', duo: { role: 'guest', ownerId: 'zoe', ownerName: 'Zoé', guestName: 'Alice' }, canLeave: true },
      { title: 'Mien', entryId: 'k2', duo: { role: 'owner', ownerId: 'alice', ownerName: 'Alice', guestName: 'Marc' }, canLeave: true },
      { title: 'Trop tard', entryId: 'k3', duo: { role: 'owner', ownerId: 'alice', ownerName: 'Alice', guestName: 'Léa' }, canLeave: false }] });
  let leaveAnswer;
  const page = await open({ state, respond: url => url === '/api/table/duet/leave' ? leaveAnswer : undefined });
  const card = () => page.find('peopleList', '[data-person-card="alice"]');
  assert.match(card().textContent, /Envoyé.*duo avec Zoé/s);
  assert.match(card().textContent, /Mien.*duo avec Marc/s);
  assert.equal(card().querySelector('[data-duet-solo="k3"]'), null, 'duo déjà sur scène : plus de retrait');
  assert.match(card().textContent, /⇅ change l’ordre de ses titres sans perdre sa place dans la file\./);
  assert.match(card().textContent, /Demande de duo envoyée à Chloé pour « Slow »\. Sans réponse avant l’envoi de son titre, elle expire\./);
  assert.match(page.node('queueList').innerHTML, /data-join-request="bruno"[^]*?réponse avant l’envoi/);
  assert.equal((page.node('queueList').innerHTML.match(/réponse avant l’envoi/g) || []).length, 1, 'seulement le prochain titre');

  await page.tap('peopleList', '[data-duet-leave="g1"]');
  assert.equal(page.node('attentionWho').textContent, 'Pour Alice');
  assert.equal(page.node('attentionTitle').textContent, 'Alice ne chante plus ce duo\u00a0?');
  assert.equal(page.node('attentionText').textContent, 'Bruno chantera « Hit » en solo. Alice garde ses propres chansons.');
  assert.equal(page.vibrations.length, 0, 'une confirmation ne sonne pas');
  await page.tap('attentionChoices', '[data-attn="cancel"]');
  assert.equal(page.node('attention').hidden, true);
  assert.ok(!page.posts.some(([url]) => url === '/api/table/duet/leave'), 'annulé : rien d’envoyé');
  await page.tap('peopleList', '[data-duet-leave="g1"]');
  leaveAnswer = reply(400, { error: 'Duo introuvable.' });
  await page.tap('attentionChoices', '[data-attn="yes"]');
  assert.equal(page.node('attentionError').textContent, 'Duo introuvable.', 'erreur dans la fenêtre');
  leaveAnswer = undefined;
  await page.tap('attentionChoices', '[data-attn="yes"]');
  assert.deepEqual(page.posts.at(-1), ['/api/table/duet/leave', { table: '1', access: 'secret', personId: 'alice', ownerId: 'bruno', entryId: 'g1' }]);
  assert.equal(page.toast().text, 'Alice ne chante plus ce duo.');
  assert.equal(page.node('attention').hidden, true);
  await page.tap('peopleList', '[data-duet-leave="k1"]');
  await page.tap('attentionChoices', '[data-attn="yes"]');
  assert.deepEqual(page.posts.at(-1)[1], { table: '1', access: 'secret', personId: 'alice', ownerId: 'zoe', entryId: 'k1' });
  await page.tap('peopleList', '[data-duet-solo="k2"]');
  assert.equal(page.node('attentionTitle').textContent, 'Alice chante « Mien » en solo\u00a0?');
  assert.equal(page.node('attentionText').textContent, 'Marc ne chantera plus ce duo. Le titre garde sa place ; KaraFun affichera encore les deux noms.');
  await page.tap('attentionChoices', '[data-attn="yes"]');
  assert.deepEqual(page.posts.at(-1), ['/api/table/duet/solo', { table: '1', access: 'secret', personId: 'alice', entryId: 'k2' }]);
  assert.equal(page.toast().text, 'Alice chantera en solo.');

  const solo = await open({ state: baseState({ table: { id: 'Comptoir', name: 'En solo', individual: true },
    tablePeople: [person('alice', 'Alice', { songs: [{ entryId: 'e1', songId: 1, title: 'Un' }, { entryId: 'e2', songId: 2, title: 'Deux' }] })] }),
  path: '/t/Comptoir/secret' });
  assert.match(solo.node('peopleList').textContent, /⇅ change l’ordre de tes titres sans perdre ta place dans la file\./);
});

test('mise à jour : la page cachée continue de se mettre à jour et son titre clignote tant qu’une demande attend', async () => {
  const page = await open({ hidden: true });
  const before = page.stateRequests().length;
  await page.poll();
  assert.equal(page.stateRequests().length, before + 1, 'page cachée : mise à jour quand même');
  page.state.tablePeople[0].needConfirm = true;
  await page.poll();
  assert.equal(page.document.title, '🔴 Réponse attendue');
  await page.runTimers(1000);
  assert.equal(page.document.title, '(1) Karaoké — ma table');
  await page.runTimers(1000);
  assert.equal(page.document.title, '🔴 Réponse attendue');
  page.document.hidden = false;
  page.document.listeners.visibilitychange.forEach(entry => entry.listener());
  await page.settle();
  assert.equal(page.document.title, '(1) Karaoké — ma table', 'page revenue : plus de clignotement');
  assert.equal(page.stateRequests().length, before + 3, 'et mise à jour immédiate');
});

// ================================================================ fiches des personnes
// Retours du 4 octobre (D3) : la page d'une table ne montre plus que les
// personnes gérées par ce téléphone ; une personne gérée ailleurs se retrouve
// dans « Voir toute la table », avec « C'est moi ».
test('fiches : sur scène, duos, présence, report, parti, personne gérée ailleurs', async () => {
  const at = Date.now() + 15 * 60000;
  const state = baseState({ rules: { requirePresence: true }, me: { id: 'eve', inKaraFun: [{ title: 'Prête', artist: '' }] } });
  state.tablePeople = [
    person('alice', 'Alice', { inKaraFun: [{ title: 'Chanson KF', artist: 'Artiste', stage: true }],
      songs: [{ entryId: 'e1', title: 'Duo 1', artist: 'A', duet: { state: 'pending', partnerName: 'Zoé' } }, { entryId: 'e2', title: 'Duo 2', artist: 'B', duet: { state: 'accepted' } }],
      guestDuos: [{ fromName: 'Marc', song: { title: 'Hit' } }], needConfirm: true, canDefer: true }),
    person('bob', 'Bob', { invites: [{ entryId: 'x9', fromName: 'Léa', song: { title: 'Slow', artist: 'Lui' } }],
      songs: [{ entryId: 'b1', title: 'Rock', artist: 'R' }] }),
    person('carla', 'Carla', { confirmed: true, deferral: { remaining: 2, pendingRemoval: true, canDeferMore: true } }),
    person('dan', 'Dan', { active: false, invites: [{ entryId: 'x8', fromName: 'Léa', song: { title: 'Slow', artist: 'Lui' } }],
      songs: [{ entryId: 'd1', title: 'Rock', artist: 'R' }] }),
    person('eve', 'Eve'),
  ];
  state.managedIds = ['alice', 'carla', 'dan', 'eve'];
  state.queue = [{ pos: 2, ids: ['carla'], id: 'carla', name: 'Carla', title: 'Rock', source: 'helper', eta: at, song: { entryId: 'c1' } }];
  const page = await open({ state });
  const card = id => page.find('peopleList', `[data-person-card="${id}"]`);
  const status = id => card(id).querySelector('.person-state').textContent;

  assert.equal(status('alice'), 'Sur scène');
  assert.match(card('alice').textContent, /DÉJÀ PRÊTE DANS LA FILE.*Chanson KF.*Artiste · sur scène/s);
  assert.match(card('alice').textContent, /SA LISTE · 2 CHANSONS/);
  assert.match(card('alice').textContent, /A · prochain titre · duo avec Zoé \(en attente de sa réponse\)/);
  assert.match(card('alice').textContent, /B · à suivre · duo avec un autre chanteur/);
  assert.equal(card('alice').querySelectorAll('[data-reorder-song]').length, 2, 'ordre modifiable');
  assert.equal(card('alice').querySelectorAll('[data-duet-cancel]').length, 2, 'duos annulables');
  assert.match(card('alice').textContent, /Alice chantera aussi en duo avec Marc sur « Hit »\. Ses propres chansons restent dans sa liste/);
  assert.match(card('alice').textContent, /Confirme la présence d’Alice pour son prochain passage\./);
  assert.ok(card('alice').querySelector('[data-confirm-person="alice"]') && card('alice').querySelector('[data-defer-person="alice"]'),
    'présence et report : une seule question, deux réponses');
  assert.doesNotMatch(card('alice').textContent, /C’est bientôt au tour/, 'pas de seconde question');

  assert.equal(page.node('peopleList').querySelector('[data-person-card="bob"]'), null, 'Bob, géré ailleurs, n’est pas sur la page');
  assert.equal(status('carla'), `2e dans la file · vers ${timeOf(at)}`);
  // Regression: soirée du 2 octobre — Mel voyait la demande de JP sans aucun
  // bouton. Si c'est bien Bob, il reprend sa fiche avec le code du bar, depuis
  // « Voir toute la table ».
  await page.click(page.node('tableAllButton'));
  await page.tap('tableSheetList', '[data-sheet-claim="bob"]');
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Gérer les chansons de Bob');
  assert.ok(page.node('claimCode'), 'code de reprise demandé');
  await page.click(page.find('sheetPanel', '[data-close-sheet]'));
  // Personne partie : sa fiche reste, sans réponse ni modification possibles.
  assert.match(card('dan').textContent, /Léa propose un duo sur « Slow » — Lui\..*Seul le téléphone qui gère Dan peut répondre\./s);
  assert.equal(card('dan').querySelector('[data-duet-answer]'), null, 'pas de réponse pour une personne partie');
  assert.equal(card('dan').querySelector('[data-rename-person]'), null);
  assert.equal(card('dan').querySelector('[data-remove-song]'), null);
  assert.ok(card('dan').querySelector('[data-lyrics-title="Rock"]'), 'les paroles restent consultables');

  assert.match(card('carla').textContent, /Passage repoussé : encore 2 chansons avant Carla\. Son titre sort de KaraFun et garde son tour\./);
  assert.ok(card('carla').querySelector('[data-ready-person="carla"]'));
  assert.equal(card('carla').querySelector('[data-defer-person="carla"]').textContent, 'Encore une chanson');
  assert.match(card('carla').textContent, /Présence confirmée pour ce passage\./);
  assert.match(card('carla').textContent, /Aucune chanson préparée\./);

  assert.equal(status('dan'), 'Parti · historique conservé');
  assert.equal(status('eve'), 'Chanson prête dans la file', 'titre envoyé connu par « me »');
  assert.match(card('eve').textContent, /Prête · bientôt sur scène/);

  const english = await open({ state, languages: ['en'] });
  assert.match(english.find('peopleList', '[data-person-card="carla"]').querySelector('.person-state').textContent,
    new RegExp(`^2nd in the queue · around ${timeOf(at, 'en')}`));
});

// ================================================================ actions depuis les fiches
test('fiches : répondre, annuler, retirer, confirmer, avec le message de chaque action', async () => {
  const state = baseState({ rules: { requirePresence: true } });
  state.tablePeople[0] = person('alice', 'Alice', {
    songs: [{ entryId: 'e1', title: 'Duo 1', duet: { state: 'pending', partnerName: 'Zoé' } }],
    invites: [{ entryId: 'x1', fromName: 'Marc', song: { title: 'Hit' } }],
    sentJoinRequests: [{ ownerId: 'bruno', ownerName: 'Bruno', entryId: 'b1', song: { title: 'Tube' } }],
    needConfirm: true,
  });
  const page = await open({ state });
  const base = { table: '1', access: 'secret', personId: 'alice' };
  const steps = [
    ['[data-duet-answer="yes"]', '/api/table/duet/answer', { entryId: 'x1', accept: true }, 'Duo accepté.'],
    ['[data-duet-answer="no"]', '/api/table/duet/answer', { entryId: 'x1', accept: false }, 'Invitation refusée.'],
    ['[data-duet-cancel="e1"]', '/api/table/duet/cancel', { entryId: 'e1' }, 'Duo annulé.'],
    ['[data-join-cancel="bruno"]', '/api/table/duet/join/cancel', { ownerId: 'bruno', entryId: 'b1' }, 'Demande de duo annulée.'],
    ['[data-confirm-person="alice"]', '/api/table/confirm', {}, 'Présence confirmée.'],
    ['[data-remove-song="e1"]', '/api/table/song/remove', { entryId: 'e1' }, 'Chanson retirée de la liste.'],
  ];
  for (const [selector, url, extra, message] of steps) {
    const before = page.stateRequests().length;
    await page.tap('peopleList', selector);
    assert.deepEqual(page.posts.at(-1), [url, { ...base, ...extra }], selector);
    assert.equal(page.stateRequests().length, before + 1, `${selector} : la page se met à jour`);
    assert.deepEqual(page.toast(), { text: message, bad: false, warn: false, hidden: false });
  }
  assert.match(page.find('peopleList', '[data-person-card="alice"]').textContent, /Demande de duo envoyée à Bruno pour « Tube »\./);
});

test('fiches : erreurs du serveur (traduites en anglais), réseau coupé, lien de table refusé', async () => {
  let answer = reply(409, { error: 'Cette chanson est déjà prête dans KaraFun.' });
  const page = await open({ respond: url => url === '/api/table/song/remove' ? answer : undefined });
  const remove = page.find('peopleList', '[data-remove-song="e1"]');
  await page.click(remove);
  assert.deepEqual(page.toast(), { text: 'Cette chanson est déjà prête dans KaraFun.', bad: true, warn: false, hidden: false });
  assert.equal(remove.disabled, false, 'bouton de nouveau utilisable');
  answer = new TypeError('Failed to fetch');
  await page.tap('peopleList', '[data-remove-song="e1"]');
  assert.equal(page.toast().bad, true, 'réseau coupé : message d’erreur');
  assert.equal(page.toast().text, 'Connexion perdue : réessaie dans un instant.');
  answer = reply(500, {});
  await page.tap('peopleList', '[data-remove-song="e1"]');
  assert.equal(page.toast().text, 'Une erreur est survenue.', 'erreur sans message : texte générique');
  answer = reply(403, {});
  await page.tap('peopleList', '[data-remove-song="e1"]');
  assert.equal(page.toast().text, 'Lien de table invalide.', '403 sans code : message de lien');
  assert.equal(page.node('fatalBox').hidden, true);
  answer = reply(403, { error: 'Lien de table invalide ou périmé. Scanne le QR code affiché à ta table.', code: 'TABLE_ACCESS' });
  await page.tap('peopleList', '[data-remove-song="e1"]');
  assertInvalidLink(page);

  const english = await open({ languages: ['en'], respond: url => url === '/api/table/song/remove'
    ? reply(403, { error: 'Ce téléphone ne gère pas cette personne. Demande au bar un code de reprise si tu as changé de téléphone.' }) : undefined });
  await english.tap('peopleList', '[data-remove-song="e1"]');
  assert.equal(english.toast().text, 'This phone doesn’t manage this person. Ask the bar for a recovery code if you changed phones.');
  assert.equal(english.toast().bad, true);
});

test('renommer et changer l’ordre : fenêtres, contrôles et envois', async () => {
  const state = baseState();
  state.tablePeople[0].songs.push({ entryId: 'e2', songId: 2, title: 'Deuxième', artist: 'Moi' });
  const page = await open({ state });
  const renameButton = page.find('peopleList', '[data-rename-person="alice"]');
  renameButton.focus();
  await page.click(renameButton);
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Renommer Alice');
  assert.equal(page.node('renameInput').value, 'Alice');
  assert.equal(page.document.activeElement, page.node('renameInput'), 'curseur dans le champ');
  assert.equal(page.node('renameInput').selected, true, 'prénom sélectionné pour être retapé');
  page.node('renameInput').value = '   ';
  await page.submit('renameForm');
  assert.deepEqual(page.toast(), { text: 'Indique un prénom.', bad: true, warn: false, hidden: false });
  page.node('renameInput').value = 'Alice';
  await page.submit('renameForm');
  assert.equal(page.sheetOpen(), false, 'même prénom : fermeture sans envoi');
  assert.equal(page.posts.length, 0);
  assert.equal(page.document.activeElement, renameButton, 'le focus revient au bouton « Renommer »');
  await page.click(renameButton);
  page.node('renameInput').value = ' Alicia ';
  await page.submit('renameForm');
  assert.deepEqual(page.posts.at(-1), ['/api/table/person/rename', { table: '1', access: 'secret', personId: 'alice', name: 'Alicia' }]);
  assert.equal(page.toast().text, 'Prénom modifié.');
  assert.equal(page.sheetOpen(), false);

  await page.tap('peopleList', '[data-reorder-song="e2"]');
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Ordre des chansons d’Alice');
  assert.match(page.sheetHtml(), /Déplace « Deuxième » sans changer la place d’Alice dans la file\./);
  assert.equal(page.node('newSongPosition').value, '1', 'position actuelle présélectionnée');
  await page.click(page.node('saveSongPosition'));
  assert.equal(page.sheetOpen(), false, 'même position : rien à envoyer');
  assert.equal(page.posts.length, 1);
  await page.tap('peopleList', '[data-reorder-song="e2"]');
  await page.change('newSongPosition', '0');
  await page.click(page.node('saveSongPosition'));
  assert.deepEqual(page.posts.at(-1), ['/api/table/song/reorder', { table: '1', access: 'secret', personId: 'alice', entryId: 'e2', toIndex: 0 }]);
  assert.equal(page.toast().text, 'Ordre des chansons mis à jour.');
});

test('fenêtre : Tab reste dans la fenêtre, Échap la ferme et rend le focus', async () => {
  const page = await open();
  const opener = page.find('peopleList', '[data-rename-person="alice"]');
  opener.focus();
  await page.click(opener);
  const close = page.find('sheetPanel', '[data-close-sheet]');
  const submit = page.node('renameSubmit');
  submit.focus();
  let event = page.dispatch(page.document.activeElement, 'keydown', { key: 'Tab', shiftKey: false });
  assert.equal(event.defaultPrevented, true);
  assert.equal(page.document.activeElement, close, 'après le dernier bouton, retour au premier');
  event = page.dispatch(close, 'keydown', { key: 'Tab', shiftKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(page.document.activeElement, submit, 'Maj+Tab sur le premier : vers le dernier');
  page.node('renameInput').focus();
  event = page.dispatch(page.node('renameInput'), 'keydown', { key: 'Tab', shiftKey: false });
  assert.equal(event.defaultPrevented, false, 'au milieu : Tab normal');
  page.dispatch(page.node('renameInput'), 'keydown', { key: 'a' });
  assert.equal(page.sheetOpen(), true, 'une autre touche ne ferme rien');
  page.dispatch(page.node('renameInput'), 'keydown', { key: 'Escape' });
  await page.settle();
  assert.equal(page.sheetOpen(), false);
  assert.equal(page.document.activeElement, opener, 'focus rendu au bouton d’origine');
  page.dispatch(page.document, 'keydown', { key: 'Escape' });
  assert.equal(page.sheetOpen(), false, 'fenêtre fermée : Échap sans effet');

  // Fond de la fenêtre touché : fermeture ; bouton d'origine disparu : pas de focus perdu.
  await page.click(opener);
  await page.poll();
  await page.click(page.node('sheet'));
  assert.equal(page.sheetOpen(), false);
  assert.notEqual(page.document.activeElement, opener, 'un bouton retiré de la page ne reprend pas le focus');
});

// ================================================================ inscription et accès
test('accès : « Inscrire une personne » et « Reprendre » mènent au bon formulaire, le titre choisi est gardé', async () => {
  const state = baseState({ managedIds: [] });
  const page = await open({ state, respond: (url, body, self) => {
    if (url === '/api/join' || url === '/api/table/person') {
      const id = body.name === 'Zoé' ? 'zoe' : 'karim';
      self.state.tablePeople.push(person(id, body.name));
      self.state.managedIds = [...self.state.managedIds, id];
      return { id, token: `jeton-${id}` };
    }
    return undefined;
  } });
  await page.click(page.node('nav-catalog'));
  assert.equal(page.node('catalogTarget').textContent,
    'Explore le catalogue. Pour ajouter un titre, inscris une personne ou reprends sa gestion avec un code.');
  await pickCatalogSong(page);
  assert.match(page.find('sheetPanel', 'h3').textContent, /^Avant d’ajouter « Tube »$/);
  assert.match(page.sheetHtml(), /Ton titre restera sélectionné pendant l’inscription\./);
  // Retours du 4 octobre (D3) : reprendre se fait depuis la liste de toute la table.
  await page.tap('sheetPanel', '[data-access-go="claim"]');
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Toute la table');
  assert.ok(page.find('tableSheetList', '[data-sheet-claim="alice"]'), '« C’est moi » prêt à toucher');

  await page.click(page.node('nav-catalog'));
  await page.tap('catalogContent', '[data-song-index="0"]');
  await page.tap('sheetPanel', '[data-access-go="register"]');
  assert.equal(page.sheetOpen(), false);
  assert.equal(page.tabShown(), 'table');
  assert.ok(page.node('joinBox').scrolled, 'téléphone sans personne : il rejoint la table');
  assert.equal(page.document.activeElement, page.node('firstName'));
  page.node('firstName').value = 'Zoé';
  await page.submit('joinForm');
  assert.deepEqual(page.posts.at(-1), ['/api/join', { table: '1', access: 'secret', name: 'Zoé' }]);
  assert.deepEqual(JSON.parse(page.storage.get('kfPeople:1:secret')), { zoe: 'jeton-zoe' });
  assert.equal(page.node('firstName').value, '');
  assert.equal(page.toast().text, 'Zoé est inscrit.');
  assert.equal(page.sheetOpen(), true, 'le titre choisi revient tout de suite');
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Tube');
  assert.match(page.sheetHtml(), /Pour Zoé/);
  await page.click(page.find('sheetPanel', '[data-close-sheet]'));

  // Téléphone qui gère déjà quelqu'un : ajouter une personne sans téléphone.
  await page.click(page.node('nav-catalog'));
  await page.tap('catalogContent', '[data-song-index="0"]');
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Tube');
  await page.click(page.find('sheetPanel', '[data-close-sheet]'));
  page.state.managedIds = ['zoe'];
  const register = Object.assign(new Element(page, 'button', { 'data-access-go': 'register' }), { parent: page.node('catalogAccessActions') });
  page.dispatch(register, 'click');
  await page.settle();
  assert.ok(page.node('addPersonBox').scrolled, 'table déjà occupée : ajouter une personne');
  assert.equal(page.document.activeElement, page.node('newName'));
  page.node('newName').value = 'Karim';
  await page.submit('addPersonForm');
  assert.deepEqual(page.posts.at(-1), ['/api/table/person', { table: '1', access: 'secret', name: 'Karim' }]);
  assert.equal(page.node('newName').value, '');
  assert.equal(page.toast().text, 'Karim est ajouté à la table.');

  page.node('newName').value = '';
  await page.submit('addPersonForm');
  assert.deepEqual(page.toast(), { text: 'Indique un prénom.', bad: true, warn: false, hidden: false });
  page.node('firstName').value = '';
  await page.submit('joinForm');
  assert.deepEqual(page.toast(), { text: 'Indique un prénom.', bad: true, warn: false, hidden: false });
});

test('accès : table vide vers « Commencer », « En solo » déjà géré sans effet', async () => {
  const empty = await open({ state: baseState({ tablePeople: [], managedIds: [] }) });
  await empty.click(empty.node('nav-catalog'));
  await empty.tap('catalogAccessActions', '[data-access-go="register"]');
  assert.equal(empty.tabShown(), 'table');
  assert.ok(empty.node('joinBox').scrolled);
  assert.equal(empty.document.activeElement, empty.node('firstName'));

  const state = baseState({ table: { id: 'Comptoir', name: 'En solo', individual: true, count: 2 }, recoveryPeople: [person('bob', 'Bob')] });
  const solo = await open({ state, path: '/t/Comptoir/secret' });
  await solo.click(solo.node('nav-catalog'));
  const stray = Object.assign(new Element(solo, 'button', { 'data-access-go': 'claim' }), { parent: solo.node('catalogAccessActions') });
  solo.dispatch(stray, 'click');
  await solo.settle();
  assert.equal(solo.tabShown(), 'catalog', 'déjà inscrit en solo : pas de reprise');
});

// ================================================================ Battle
test('Battle : vote oui/non, vote par titre, choix obligatoire et résultats en direct', async () => {
  const closesAt = Date.now() + 120000;
  const state = baseState({ battle: { id: 'b1', phase: 'voting', mode: 'yesno', eligiblePersonIds: ['alice'], votedPersonIds: [], closesAt,
    eligible: 4, threshold: 2, voters: 1, minVoters: 2, registered: 4 } });
  const page = await open({ state });
  assert.match(page.node('battleText').textContent, /^Vote ouvert : oui ou non\. Fin du vote dans [12]:\d\d\. 1 votant sur 4 ; il en faut au moins 2\./);
  await page.tap('battleVotes', '[data-battle-vote="alice"][data-choice="no"]');
  assert.deepEqual(page.posts.at(-1), ['/api/table/battle/vote', { table: '1', access: 'secret', personId: 'alice', choice: 'no' }]);
  assert.equal(page.toast().text, 'Vote enregistré.');

  page.state.battle = { ...page.state.battle, id: 'b2', mode: 'songs', noVotes: 1, voters: 3,
    songOptions: [{ songId: 9, title: 'Tube', artist: 'Groupe', votes: 2 }, { songId: 10, title: 'Autre', artist: '', votes: 0 }] };
  await page.poll();
  const rows = () => page.node('battleVotes').querySelectorAll('.battle-options li');
  assert.deepEqual(rows().map(row => [row.querySelector('span').textContent, row.querySelector('b').textContent]),
    [['Tube — Groupe', '2 voix · en tête'], ['Autre', '0 voix'], ['Pas de Battle', '1 voix']]);
  const before = page.posts.length;
  await page.tap('battleVotes', '[data-battle-vote="alice"]');
  assert.deepEqual(page.toast(), { text: 'Choisis un titre ou « Pas de Battle ».', bad: true, warn: false, hidden: false });
  assert.equal(page.posts.length, before, 'rien n’est envoyé sans choix');

  // Pendant le choix, les voix changent : la liste n'est pas recréée, le choix reste.
  const select = page.node('battleChoice-alice');
  select.value = '10';
  page.state.battle.songOptions[1].votes = 3;
  await page.poll();
  assert.equal(page.node('battleChoice-alice'), select, 'même liste de choix');
  assert.equal(select.value, '10');
  assert.deepEqual(rows().map(row => row.querySelector('b').textContent), ['2 voix', '3 voix · en tête', '1 voix']);
  assert.deepEqual(rows().map(row => row.querySelector('i').style.width), ['67%', '100%', '33%']);
  await page.tap('battleVotes', '[data-battle-vote="alice"]');
  assert.deepEqual(page.posts.at(-1)[1], { table: '1', access: 'secret', personId: 'alice', choice: '10' });
});

// Regression: retours du bar — une personne arrivée après l'ouverture du
// vote Battle doit pouvoir voter dès l'état suivant, sans recharger la page.
test('Battle : la personne admise au vote après son ouverture voit le vote au prochain état (FR et EN)', async () => {
  for (const [languages, label, text, notice] of [
    [['fr-FR'], 'Oui', /2 votants sur 6 ; il en faut au moins 5\./, 'Vote Battle : toute la salle chante !'],
    [['en-GB'], 'Yes', /2 voters out of 6; at least 5 needed\./, null],
  ]) {
    const state = baseState({ battle: { id: 'late', phase: 'voting', mode: 'yesno', eligiblePersonIds: ['bob', 'carl', 'dan', 'eve', 'fay'],
      votedPersonIds: ['bob'], closesAt: Date.now() + 120000, eligible: 5, threshold: 5, voters: 1, yesVotes: 1, noVotes: 0,
      minVoters: 5, registered: 6 } });
    const page = await open({ state, languages });
    assert.equal(page.node('battleVotes').querySelector('[data-battle-vote="alice"]'), null, 'pas encore électrice : pas de vote');
    assert.equal(page.node('attention').hidden, true, 'ni notification de vote');
    page.state.battle = { ...page.state.battle, eligiblePersonIds: [...page.state.battle.eligiblePersonIds, 'alice'],
      eligible: 6, voters: 2, votedPersonIds: ['bob', 'carl'] };
    await page.poll();
    assert.match(page.node('battleText').textContent, text, 'l’électorat agrandi est affiché');
    const button = page.find('battleVotes', '[data-battle-vote="alice"][data-choice="yes"]');
    assert.ok(button, 'le vote apparaît sans recharger');
    assert.equal(button.textContent, label);
    assert.equal(page.node('attention').hidden, false, 'la demande de vote s’affiche');
    if (notice) assert.equal(page.node('attentionTitle').textContent, notice);
    await page.tap('battleVotes', '[data-battle-vote="alice"][data-choice="yes"]');
    assert.deepEqual(page.posts.at(-1), ['/api/table/battle/vote', { table: '1', access: 'secret', personId: 'alice', choice: 'yes' }]);
  }
});

test('Battle : proposition à plusieurs, recherche sans résultat, retrait, limites et messages du vote', async () => {
  const state = baseState();
  state.tablePeople.push(person('bob', 'Bob'));
  state.managedIds = ['alice', 'bob'];
  let proposeAnswer = { ok: true, battle: { phase: 'requested' } };
  let searchAnswer = null;
  const songs = [1, 2, 3, 4].map(n => ({ songId: 40 + n, title: `Titre ${n}`, artist: 'Groupe' }));
  const page = await open({ state, respond: url => {
    if (url.startsWith('/api/search?')) return searchAnswer || (url.includes('q=xyz') ? [] : songs);
    if (url === '/api/table/battle/propose') return proposeAnswer;
    return undefined;
  } });
  const openProposal = async () => {
    await page.tap('battleVotes', '[data-battle-propose]');
    assert.equal(page.find('sheetPanel', 'h3').textContent, 'Proposer une Battle');
  };
  const search = async term => { page.node('battleSearch').value = term; await page.submit('battleSearchForm'); };
  await openProposal();
  assert.deepEqual(page.node('battleProposer').querySelectorAll('option').map(option => option.textContent), ['Alice', 'Bob'], 'qui propose ?');
  await search('xyz');
  assert.equal(page.node('battleSearchResults').textContent, 'Aucun titre trouvé.');
  await search('x');
  assert.equal(page.node('battleSearchResults').textContent, 'Tape au moins 2 lettres.');
  await search('Titre');
  for (const index of [0, 1]) await page.tap('battleSearchResults', `[data-battle-result="${index}"]`);
  assert.equal(page.node('battleMyChoice').value, '41', 'son vote : premier titre');
  await page.change('battleMyChoice', '42');
  await page.tap('battleSearchResults', '[data-battle-result="2"]');
  assert.equal(page.node('battleMyChoice').value, '42', 'le vote choisi est gardé quand on ajoute un titre');
  await page.tap('battleSearchResults', '[data-battle-result="2"]');
  assert.deepEqual(page.toast(), { text: 'Titre déjà proposé.', bad: true, warn: false, hidden: false });
  await page.tap('battleSearchResults', '[data-battle-result="3"]');
  assert.deepEqual(page.toast(), { text: 'Trois titres maximum.', bad: true, warn: false, hidden: false });
  await page.tap('battleSelected', '[data-battle-remove="1"]');
  assert.deepEqual(page.node('battleSelected').querySelectorAll('span').map(span => span.textContent), ['Titre 1 — Groupe', 'Titre 3 — Groupe']);
  assert.equal(page.node('battleMyChoice').value, '41', 'titre retiré : le vote revient au premier');
  await page.tap('battleSelected', '[data-battle-remove="0"]');
  await page.tap('battleSelected', '[data-battle-remove="0"]');
  assert.equal(page.node('battleSelected').textContent, 'Aucun titre choisi.');
  assert.equal(page.node('battleMyChoice').textContent, 'Ajoute d’abord un titre');
  assert.equal(page.node('battleMyChoice').disabled, true);
  assert.equal(page.node('startBattleVote').disabled, true, 'rien à proposer');

  await page.tap('battleSearchResults', '[data-battle-result="3"]');
  await page.change('battleProposer', 'bob');
  await page.click(page.node('startBattleVote'));
  assert.deepEqual(page.posts.at(-1), ['/api/table/battle/propose', { table: '1', access: 'secret', personId: 'bob',
    songs: [{ songId: 44, title: 'Titre 4', artist: 'Groupe' }], proposerChoice: 44 }]);
  assert.equal(page.toast().text, 'Majorité obtenue : le bar est prévenu.');
  assert.equal(page.sheetOpen(), false);

  for (const [answer, message] of [[{ battle: { phase: 'voting', voteMinutes: 5 } }, 'Vote Battle ouvert pendant 5 minutes.'],
    [{ battle: { phase: 'voting', voteMinutes: 1 } }, 'Vote Battle ouvert pendant 1 minute.'], [{ ok: true }, 'Vote Battle ouvert.']]) {
    proposeAnswer = answer;
    await openProposal();
    assert.equal(page.node('battleSelected').textContent, 'Aucun titre choisi.', 'nouvelle proposition : liste vide');
    assert.equal(page.node('battleProposer').value, 'bob', 'la personne qui propose est retenue');
    await search('Titre');
    await page.tap('battleSearchResults', '[data-battle-result="0"]');
    await page.click(page.node('startBattleVote'));
    assert.equal(page.toast().text, message);
  }

  // Recherche en panne, puis lien de table refusé.
  await openProposal();
  searchAnswer = reply(503, { error: 'Recherche KaraFun indisponible.' });
  await search('Queen');
  assert.equal(page.node('battleSearchResults').textContent, 'Recherche KaraFun indisponible.');
  searchAnswer = reply(403, { error: 'Lien de table invalide ou périmé. Scanne le QR code affiché à ta table.', code: 'TABLE_ACCESS' });
  await search('Queen');
  assertInvalidLink(page);
});

// ================================================================ catalogue en erreur
test('catalogue : Nouveautés, À découvrir, sélections vides, « Voir plus » et « Réessayer »', async () => {
  const failures = { categories: 1, songs: 1, search: 1, highlights: 1 };
  let categoriesEmpty = false;
  const page = await open({ respond: url => {
    if (url.startsWith('/api/catalog/categories?')) {
      if (failures.categories-- > 0) return reply(503, { error: 'Catalogue KaraFun indisponible.' });
      return categoriesEmpty ? [] : undefined;
    }
    if (url.startsWith('/api/catalog/songs?')) {
      if (failures.songs-- > 0) return new TypeError('Failed to fetch');
      return url.includes('offset=0') ? { songs: [{ songId: 9, title: 'Tube', artist: 'Groupe' }, { songId: 10, title: 'Autre tube', artist: '' }], total: 3 }
        : { songs: [{ songId: 11, title: 'Dernier tube', artist: 'Groupe' }], total: 3 };
    }
    if (url.startsWith('/api/search?') && failures.search-- > 0) return reply(502, {});
    if (url.startsWith('/api/catalog/highlights?') && failures.highlights-- > 0) return reply(503, { error: 'Nouveautés KaraFun indisponibles.' });
    return undefined;
  } });
  await page.click(page.node('nav-catalog'));
  assert.match(page.node('catalogContent').textContent, /^Catalogue KaraFun indisponible\.Réessayer$/);
  await page.tap('catalogContent', '[data-retry]');
  assert.match(page.node('catalogContent').innerHTML, /Années 80/, '« Réessayer » recharge les sélections');

  await page.tap('catalogContent', '[data-category-index="0"]');
  assert.match(page.node('catalogContent').textContent, /^Connexion perdue : réessaie dans un instant\./);
  await page.tap('catalogContent', '[data-retry]');
  assert.equal(page.node('catalogContent').querySelectorAll('[data-song-index]').length, 2);
  assert.equal(page.find('catalogContent', '[data-more]').textContent, 'Voir plus');
  await page.tap('catalogContent', '[data-more]');
  assert.ok(page.requests.some(request => request.url === '/api/catalog/songs?filter=pl_1&offset=2'), 'suite de la sélection demandée');
  assert.deepEqual(page.node('catalogContent').querySelectorAll('.song-title').map(node => node.textContent), ['Tube', 'Autre tube', 'Dernier tube']);
  assert.equal(page.node('catalogContent').querySelector('[data-more]'), null, 'tout est affiché');

  await page.type('searchInput', 'Queen');
  await page.runTimers(300);
  assert.equal(page.node('catalogContent').textContent, 'Une erreur est survenue.Réessayer');
  await page.tap('catalogContent', '[data-retry]');
  assert.match(page.node('catalogContent').textContent, /Résultats pour « Queen »/, '« Réessayer » relance la recherche');

  await page.tap(page.body, '[data-catalog="news"]');
  assert.ok(page.requests.some(request => request.url === '/api/catalog/highlights?type=news'));
  assert.equal(page.node('catalogContent').textContent, 'Nouveautés KaraFun indisponibles.Réessayer', 'Nouveautés en panne');
  await page.tap('catalogContent', '[data-retry]');
  assert.equal(page.requests.filter(request => request.url === '/api/catalog/highlights?type=news').length, 2, '« Réessayer » redemande les Nouveautés');
  assert.match(page.node('catalogContent').textContent, /^Nouveautés.*Nouveau tube.*Révélation/s);
  assert.equal(page.node('catalogContent').querySelector('[data-back]'), null, 'pas de retour aux sélections');
  assert.equal(page.find(page.body, '[data-catalog="news"]').classList.contains('on'), true);
  await page.tap(page.body, '[data-catalog="featured"]');
  assert.match(page.node('catalogContent').textContent, /^À découvrir/);

  categoriesEmpty = true;
  await page.tap(page.body, '[data-catalog="styles"]');
  assert.equal(page.node('catalogContent').textContent, 'Aucune sélection disponible.');
});

test('catalogue indisponible côté bar : message sur l’onglet Catalogue', async () => {
  const page = await open({ respond: url => url.startsWith('/api/catalog/categories?') ? reply(503, { error: 'Catalogue KaraFun indisponible.' }) : undefined });
  page.state.catalogAvailable = false;
  await page.click(page.node('nav-catalog'));
  await page.poll();
  assert.equal(page.node('catalogContent').textContent, 'Le catalogue est momentanément indisponible. Réessaie dans un instant.');
});

// ================================================================ paroles et alerte « déjà chanté »
test('paroles : erreur du service, paroles non publiées, version proche et retour au titre', async () => {
  let lyrics = reply(502, { error: 'Service de paroles indisponible.' });
  const page = await open({ respond: url => url.startsWith('/api/lyrics?') ? lyrics : undefined });
  await page.tap('peopleList', '[data-lyrics-title="Mon titre"]');
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Paroles · Mon titre');
  assert.equal(page.node('lyricsBody').textContent, 'Service de paroles indisponible.');
  assert.ok(page.requests.some(request => request.url.startsWith('/api/lyrics?table=1&access=secret&songId=1&title=Mon+titre&artist=Moi')));
  lyrics = { lines: [], url: 'https://www.karafun.fr/karaoke/x/', exact: true };
  await page.tap('peopleList', '[data-lyrics-title="Mon titre"]');
  assert.equal(page.node('lyricsBody').textContent, 'KaraFun ne publie pas les paroles de ce titre.Chercher sur KaraFun');
  lyrics = { lines: null, unavailable: true };
  await page.tap('peopleList', '[data-lyrics-title="Mon titre"]');
  assert.equal(page.node('lyricsBody').textContent, 'Paroles indisponibles pour le moment.');
  lyrics = { lines: ['Couplet'], exact: false, url: '' };
  await page.click(page.node('nav-catalog'));
  await pickCatalogSong(page);
  await page.click(page.node('songLyrics'));
  assert.equal(page.node('lyricsBody').textContent, 'Version la plus proche trouvée sur KaraFun.Couplet');
  await page.click(page.node('lyricsBack'));
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Tube', '« Revenir au titre » rouvre la fiche du titre');
  assert.ok(page.$('appendSong'));
});

test('titre déjà chanté ce soir : alerte dans la fiche, sans proposition de duo', async () => {
  let notice = { playedAt: Date.now() - 12 * 60000, minutesAgo: 12, queued: [] };
  const page = await open({ respond: url => url.startsWith('/api/song/notice?') ? { notice } : undefined });
  await page.click(page.node('nav-catalog'));
  await pickCatalogSong(page);
  assert.equal(page.node('songNotice').hidden, false);
  assert.equal(page.node('songNotice').textContent, '⚠ Ce titre a été chanté il y a 12 min. Tu peux l’ajouter quand même ou choisir un autre titre.');
  assert.equal(page.node('songJoinOffer').hidden, true, 'personne d’autre ne l’a prévu');
  notice = { playedAt: Date.now(), minutesAgo: 0, queued: [{ pos: 4, name: 'Alice', ownerId: 'alice', entryId: 'e1' }] };
  await page.tap('catalogContent', '[data-song-index="0"]');
  assert.equal(page.node('songNotice').textContent,
    '⚠ Ce titre vient d’être lancé sur scène. Il est déjà prévu dans la file (n°4, Alice). Tu peux l’ajouter quand même ou choisir un autre titre.',
    'son propre titre : pas de duo à proposer');
  assert.equal(page.node('songJoinOffer').hidden, true);
});

test('demande de duo depuis la file : choisir qui chante quand le téléphone gère plusieurs personnes', async () => {
  const state = baseState();
  state.tablePeople.push(person('bob', 'Bob'));
  state.managedIds = ['alice', 'bob'];
  state.queue = [{ pos: 1, source: 'helper', id: 'bruno', ids: ['bruno'], name: 'Bruno', title: 'Tube', song: { entryId: 'b1', title: 'Tube' }, eta: Date.now() + 60000 }];
  let direct = true;
  const page = await open({ state, respond: url => url === '/api/table/duet/join' ? { ok: true, direct } : undefined });
  await page.click(page.node('nav-queue'));
  await page.tap('queueList', '[data-join-request="bruno"]');
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Chanter « Tube » avec Bruno\u00a0?');
  // Regression: soirée du 2 octobre — le premier nom était choisi d'office.
  assert.equal(page.$('joinPerson'), null, 'plus de liste avec un choix par défaut');
  assert.equal(page.$('sendJoin'), null);
  assert.deepEqual(page.node('sheetPanel').querySelectorAll('[data-join-as]').map(button => button.textContent), ['Alice', 'Bob']);
  await page.tap('sheetPanel', '[data-join-as="bob"]');
  assert.deepEqual(page.posts.at(-1), ['/api/table/duet/join', { table: '1', access: 'secret', personId: 'bob', ownerId: 'bruno', entryId: 'b1' }]);
  assert.equal(page.toast().text, 'Duo ajouté : Bob chante avec Bruno.', 'même table : duo direct, le nom de celui qui chante');
  direct = false;
  await page.tap('queueList', '[data-join-request="bruno"]');
  await page.tap('sheetPanel', '[data-join-as="alice"]');
  assert.equal(page.toast().text, 'Demande de duo d’Alice envoyée à Bruno.');
});

// Soirée du 2 octobre : JP ne pouvait pas savoir que Mel n'avait jamais vu sa demande.
test('demande et invitation de duo : « vue » signalée à l’affichage, statut chez le demandeur', async () => {
  const state = baseState();
  state.tablePeople = [person('alice', 'Alice', {
    songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre', duet: { state: 'pending', partnerName: 'Zoé', seen: false } }],
    joinRequests: [{ entryId: 'e1', fromId: 'marc', fromName: 'Marc', song: { title: 'Mon titre' } }],
    sentJoinRequests: [{ ownerId: 'mel', ownerName: 'Mel', entryId: 'm1', song: { title: 'Barbie Girl' }, seen: false }],
  }), person('bob', 'Bob', { invites: [{ entryId: 'x1', fromName: 'Léa', song: { title: 'Slow' } }] })];
  state.managedIds = ['alice', 'bob'];
  const page = await open({ state, hidden: true });
  const seenPosts = () => page.posts.filter(([url]) => url === '/api/table/duet/seen').map(([, body]) => body);
  assert.equal(page.node('attention').hidden, false);
  assert.deepEqual(seenPosts(), [], 'page cachée : rien n’est encore vu');
  page.document.hidden = false;
  page.document.listeners.visibilitychange.forEach(entry => entry.listener());
  await page.settle();
  assert.deepEqual(seenPosts(), [{ table: '1', access: 'secret', personId: 'bob', entryId: 'x1' }],
    'seule l’invitation affichée (la première) est vue');
  await page.poll();
  assert.equal(seenPosts().length, 1, 'une seule fois');
  await page.tap('attentionChoices', '[data-attn="later"]');
  assert.deepEqual(seenPosts().at(-1), { table: '1', access: 'secret', personId: 'alice', entryId: 'e1', fromId: 'marc' },
    'la demande affichée ensuite');
  await page.tap('attentionChoices', '[data-attn="later"]');
  const card = page.find('peopleList', '[data-person-card="alice"]').textContent;
  assert.match(card, /Demande de duo envoyée à Mel pour « Barbie Girl »\. Mel ne l’a pas encore vue : va lui en parler\u00a0!/);
  assert.match(card, /duo avec Zoé \(invitation pas encore vue\)/);
  page.state.tablePeople[0].sentJoinRequests[0].seen = true;
  page.state.tablePeople[0].songs[0].duet.seen = true;
  await page.poll();
  const after = page.find('peopleList', '[data-person-card="alice"]').textContent;
  assert.match(after, /Mel l’a vue\. Sans réponse/);
  assert.match(after, /duo avec Zoé \(en attente de sa réponse\)/);
});

// Soirée du 2 octobre : une invitée ne voyait pas la demande et son auteur
// était sauté sans limite. L'invitation ne retient plus le titre : à son
// tour, il part en solo. Chacun le sait à l'avance, et après coup.
test('invitation de duo sans réponse : avertie chez l’auteur et l’invité, marquée dans la file, avis d’expiration', async () => {
  const at = Date.now();
  const pending = { state: 'pending', partnerName: 'Zoé', seen: false };
  const state = baseState({ queue: [
    { pos: 1, source: 'helper', id: 'carla', ids: ['carla'], name: 'Carla', title: 'Valse', song: { entryId: 'c1', title: 'Valse', duet: { ...pending, partnerName: 'Dan' } } },
    { pos: 2, source: 'helper', id: 'marc', ids: ['marc'], name: 'Marc', title: 'Tube', song: { entryId: 'm1', title: 'Tube' } }] });
  state.tablePeople = [person('alice', 'Alice', {
    songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre', duet: pending }, { entryId: 'e2', songId: 2, title: 'Seul' }],
    inbox: [{ id: 'n1', kind: 'inviteUnanswered', params: { name: 'Zoé', title: 'Avant' }, at }] }),
  person('bob', 'Bob', { invites: [{ entryId: 'x1', fromName: 'Léa', song: { title: 'Slow' } }],
    inbox: [{ id: 'n2', kind: 'inviteExpired', params: { name: 'Léa', title: 'Tango' }, at }] })];
  state.managedIds = ['alice', 'bob'];
  const page = await open({ state });
  // Fenêtre de l'invité : répondre avant le tour de l'auteur.
  assert.equal(page.node('attentionTitle').textContent, 'Léa propose un duo à Bob');
  assert.equal(page.node('attentionText').textContent,
    'Sur « Slow ». Seul Léa dépense son tour ; Bob garde ses propres chansons. Réponds avant son tour, sinon l’invitation expire.');
  await page.tap('attentionChoices', '[data-attn="later"]');
  const card = id => page.find('peopleList', `[data-person-card="${id}"]`).textContent;
  assert.match(card('bob'), /Léa propose un duo sur « Slow »\.\s*Réponds avant son tour, sinon l’invitation expire\./);
  // Chez l'auteur : sous le titre en attente seulement.
  assert.match(card('alice'), /duo avec Zoé \(invitation pas encore vue\)\s*Sans réponse avant son tour, Alice chantera seul\./);
  assert.equal((card('alice').match(/Sans réponse avant son tour/g) || []).length, 1, 'pas sous le titre solo');
  // File : le titre est à sa place, marqué, sans « Duo ? » (il a déjà son invitée).
  const queue = page.node('queueList').innerHTML;
  assert.match(queue, /Valse[^]*?invitation de duo en attente/);
  assert.equal(page.node('queueList').querySelector('[data-join-request="carla"]'), null);
  assert.ok(page.find('queueList', '[data-join-request="marc"]'), 'un titre solo reste proposable');
  // En cours d'envoi : plus de repère, l'invitation expire à l'accusé.
  page.state.queue[0] = { ...page.state.queue[0], source: 'envoi' };
  await page.poll();
  assert.doesNotMatch(page.node('queueList').innerHTML, /invitation de duo en attente/);
  page.state.queue[0] = { ...page.state.queue[0], source: 'helper' };
  await page.poll();
  // Avis d'expiration, des deux côtés.
  const infos = () => page.node('infoBar').querySelectorAll('.info-item p').map(p => p.textContent);
  assert.deepEqual(infos(), ['Zoé n’a pas répondu à temps : Alice chante « Avant » en solo.',
    'L’invitation de duo de Léa sur « Tango » a expiré : son tour est arrivé avant la réponse de Bob. Léa le chante en solo.']);

  const english = await open({ state, languages: ['en'] });
  await english.tap('attentionChoices', '[data-attn="later"]');
  assert.deepEqual(english.node('infoBar').querySelectorAll('.info-item p').map(p => p.textContent),
    ['Zoé didn’t answer in time: Alice sings “Avant” solo.',
      'Léa’s duet invitation for “Tango” has expired: their turn came before Bob answered. Léa sings it solo.']);
  assert.match(english.find('peopleList', '[data-person-card="alice"]').textContent, /Without an answer before their turn, Alice will sing solo\./);
  assert.match(english.find('peopleList', '[data-person-card="bob"]').textContent, /Answer before their turn, or the invitation expires\./);
  assert.match(english.node('queueList').innerHTML, /duet invitation pending/);

  // Une personne seule sur son téléphone : à la deuxième personne.
  const solo = await open({ state: baseState({ table: { id: 'Comptoir', name: 'En solo', individual: true },
    tablePeople: [person('alice', 'Alice', { songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre', duet: { ...pending, seen: true } }] })] }),
  path: '/t/Comptoir/secret' });
  assert.match(solo.node('peopleList').textContent, /duo avec Zoé \(en attente de sa réponse\)\s*Sans réponse avant ton tour, tu chanteras seul\./);
  // Repère dès l'invitation, à côté de « Envoyer l'invitation ».
  const soloDuo = await open({ state: baseState({ table: { id: 'Comptoir', name: 'En solo', individual: true } }), path: '/t/Comptoir/secret',
    respond: url => url.startsWith('/api/duo/partners?') ? partners : undefined });
  await soloDuo.tap('peopleList', '[data-duet-song="alice"]');
  await pickCatalogSong(soloDuo);
  assert.equal(soloDuo.node('sendDuo').textContent, 'Envoyer l’invitation');
  assert.equal(soloDuo.node('duoConsent').textContent, 'Son accord est nécessaire. Sans réponse avant ton tour, tu chanteras seul.');
});

// ================================================================ prénom seul des solistes (lot K)
test('soliste : prénom en en-tête, « Bienvenue » avant le prénom, partenaires sans « À ma table » (FR et EN)', async () => {
  const soloTable = { id: 'Comptoir', name: 'En solo', individual: true, count: 3 };
  const page = await open({ state: baseState({ table: soloTable }), path: '/t/Comptoir/secret',
    respond: url => url.startsWith('/api/duo/partners?') ? partners : undefined });
  assert.equal(page.node('tableName').textContent, 'Alice', 'en-tête : le prénom du soliste');
  assert.equal(page.node('joinHeading').textContent, 'Bienvenue');
  await page.tap('peopleList', '[data-duet-song="alice"]');
  await pickCatalogSong(page);
  const select = page.node('duoPartner');
  assert.equal(select.querySelector('optgroup[label="À ma table"]'), null, 'les autres solistes ne sont pas « à ma table »');
  const others = select.querySelector('optgroup[label="Autres personnes · invitation à accepter"]');
  assert.deepEqual(others.querySelectorAll('option').map(option => option.textContent), ['↗ Marc · Table 1', '↗ Zoé · Table 2', '↗ Sam']);
  assert.doesNotMatch(page.sheetHtml(), /En solo/);

  const english = await open({ state: baseState({ table: soloTable }), path: '/t/Comptoir/secret', languages: ['en'],
    respond: url => url.startsWith('/api/duo/partners?') ? partners : undefined });
  assert.equal(english.node('tableName').textContent, 'Alice');
  await english.tap('peopleList', '[data-duet-song="alice"]');
  await pickCatalogSong(english);
  const englishOthers = english.node('duoPartner').querySelector('optgroup[label="Other people · invitation to accept"]');
  assert.deepEqual(englishOthers.querySelectorAll('option').map(option => option.textContent), ['↗ Marc · Table 1', '↗ Zoé · Table 2', '↗ Sam']);
  assert.doesNotMatch(english.sheetHtml(), /Solo\b/);

  // Prénom pas encore donné, ou personne gérée : « Bienvenue » / « Welcome ».
  const waiting = await open({ state: baseState({ table: soloTable, tablePeople: [person('alice', 'Solo 1', { nameRequired: true })] }),
    path: '/t/Comptoir/secret' });
  assert.equal(waiting.node('tableName').textContent, 'Bienvenue', 'jamais le prénom provisoire');
  const nobody = await open({ state: baseState({ table: soloTable, managedIds: [] }), path: '/t/Comptoir/secret', languages: ['en'] });
  assert.equal(nobody.node('tableName').textContent, 'Welcome');

  // Une table garde son nom en en-tête.
  const table = await open({ state: baseState() });
  assert.equal(table.node('tableName').textContent, 'Table 1');
  assert.equal(table.node('joinHeading').textContent, 'Bienvenue à Table 1\u00a0!');
});

// ================================================================ fermeture du bar
test('fermeture : place restante, file complète, heure passée, annonce retirée', async () => {
  const at = Date.now() + 45 * 60000;
  const page = await open({ state: baseState({ closing: { at, passed: false, full: false, fitCount: 2, afterCount: 0 } }) });
  const box = page.node('closingBox');
  assert.equal(box.hidden, false);
  assert.equal(box.textContent, `Fermeture du bar à ${timeOf(at)}2 titres prévus passeront avant la fermeture : il reste de la place.`);
  assert.equal(box.classList.contains('warn'), false, 'simple information tant qu’il reste de la place');
  const shown = box.querySelector('b');
  await page.poll();
  assert.equal(box.querySelector('b'), shown, 'texte inchangé : pas réécrit (lecteur d’écran)');
  page.state.closing.fitCount = 1;
  await page.poll();
  assert.match(box.textContent, /1 titre prévu passera avant la fermeture : il reste de la place\.$/);
  page.state.closing = { at, passed: false, full: true, fitCount: 1, afterCount: 2 };
  await page.poll();
  assert.match(box.textContent, /La file est complète jusqu’à la fermeture : plus de nouvel ajout\./);
  assert.equal(box.classList.contains('warn'), true);
  page.state.closing = { at: Date.now() - 60000, passed: true, full: true, fitCount: 0, afterCount: 0 };
  await page.poll();
  assert.equal(box.querySelector('b').textContent, 'Le bar ferme : plus de nouveau titre ce soir.');
  // Regression: essai au bar du 2 octobre — les titres d'après l'heure ne sont plus lancés.
  assert.match(box.textContent, /Les titres prévus après l’heure ne seront pas lancés, sauf si le bar la décale\.$/);
  assert.equal(box.classList.contains('warn'), true);
  page.state.closing = null;
  await page.poll();
  assert.equal(box.hidden, true, 'heure de fermeture retirée par le bar');

  const english = await open({ languages: ['en'], state: baseState({ closing: { at, passed: false, full: false, fitCount: 3 } }) });
  assert.equal(english.node('closingBox').querySelector('b').textContent, `The bar closes at ${timeOf(at, 'en')}`);
  english.state.closing = { at: Date.now() - 60000, passed: true, full: true, fitCount: 0, afterCount: 0 };
  await english.poll();
  assert.match(english.node('closingBox').textContent, /Songs planned after closing time will not be started, unless the bar moves the time\.$/);
});

// ================================================================ réglages de titre
// Tonalité, tempo, voix guide et chœurs : le chanteur règle ses titres à
// venir depuis son téléphone (duo : l'auteur seul), tant qu'ils n'ont pas
// commencé et que le bar n'a pas coupé la fonction.
const SONG_SETTINGS = { enabled: true, ranges: { pitch: { min: -6, max: 6, step: 1 }, tempo: { min: -50, max: 50, step: 5 },
  volume: { min: 0, max: 100, step: 25 } }, defaults: { pitch: 0, tempo: 0, guide: 0, backing: 53 } };
function tuneState(extra = {}) {
  const state = baseState({ songSettings: JSON.parse(JSON.stringify(SONG_SETTINGS)), ...extra });
  state.tablePeople = [
    person('alice', 'Alice', {
      songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre', artist: 'Moi', settings: null }],
      inKaraFun: [{ entryId: 'k1', songId: 2, title: 'Déjà prête', artist: 'Elle', queueId: 11, canAdjust: true, tracks: [5],
        settings: { pitch: 2, tempo: -10 } }],
    }),
    person('bob', 'Bob', { songs: [{ entryId: 'b1', songId: 3, title: 'Rock', artist: 'R', settings: { pitch: -1, guide: 50 } }] }),
  ];
  state.managedIds = ['alice'];
  return state;
}
// Le serveur garde les réglages reçus (tonalité et tempo d'origine retirés).
function keepSettings(self, body) {
  const out = {};
  for (const [field, value] of Object.entries(body.settings || {})) {
    if (Number.isInteger(value) && !((field === 'pitch' || field === 'tempo') && value === 0)) out[field] = value;
  }
  if (Object.keys(body.settings?.guideVoices || {}).length) out.guideVoices = { ...body.settings.guideVoices };
  for (const p of self.state.tablePeople) for (const song of [...p.songs, ...p.inKaraFun]) {
    if (song.entryId === body.entryId) song.settings = Object.keys(out).length ? out : null;
  }
  return { ok: true, settings: Object.keys(out).length ? out : null, applied: body.entryId === 'k1' ? 'karafun' : 'list' };
}
const tunePosts = page => page.posts.filter(([url]) => url === '/api/table/song/settings').map(([, body]) => body);
const pressed = (page, field) => page.node('songSettingsBody').querySelectorAll(`[data-tune="${field}"][aria-pressed="true"]`)
  .map(node => node.dataset.value);

test('réglages de titre : bouton sur chaque titre à venir, fiche, enregistrement automatique et badge', async () => {
  const page = await open({ state: tuneState(), respond: (url, body, self) => url === '/api/table/song/settings' ? keepSettings(self, body) : undefined });
  const card = id => page.find('peopleList', `[data-person-card="${id}"]`);
  const button = card('alice').querySelector('[data-song-settings="e1"]');
  assert.ok(button, 'titre de sa liste : bouton « Réglages »');
  assert.equal(button.getAttribute('aria-label'), 'Réglages de Mon titre', 'texte lu par le lecteur d’écran');
  assert.ok(card('alice').querySelector('[data-song-settings="k1"]'), 'titre déjà dans KaraFun, pas commencé : réglable');
  assert.equal(card('alice').querySelector('.tune-badge').textContent, '♯ +2 · tempo −10 %', 'badge des réglages');
  assert.equal(page.node('peopleList').querySelector('[data-person-card="bob"]'), null, 'autre téléphone : pas sur la page');
  const gone = tuneState({ managedIds: ['alice', 'bob'] });
  gone.tablePeople[1].active = false;
  gone.managedIds = ['alice', 'bob'];
  const bobCard = (await open({ state: gone })).find('peopleList', '[data-person-card="bob"]');
  assert.equal(bobCard.querySelector('[data-song-settings]'), null, 'personne partie : aucun bouton');
  assert.equal(bobCard.querySelector('.tune-badge').textContent, '♭ −1 · guide 50', 'réglages visibles');

  await page.click(button);
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Réglages · Mon titre');
  assert.equal(page.node('tunePitch').textContent, '0');
  assert.match(page.node('songSettingsBody').textContent, /0 = originale/);
  assert.equal(page.node('tuneTempo').textContent, '0 %');
  assert.deepEqual(pressed(page, 'guide'), ['0'], 'voix guide par défaut : coupée');
  assert.deepEqual(pressed(page, 'backing'), [], 'chœurs à 53 par défaut : aucun choix marqué');
  assert.match(page.node('songSettingsBody').textContent, /Réglage de KaraFun : 53/);
  assert.match(page.node('songSettingsBody').textContent, /Si le titre en a\./, 'pistes encore inconnues avant l’envoi');
  assert.equal(page.node('tuneReset').disabled, true, 'rien à réinitialiser');

  await page.tap('songSettingsBody', '[data-tune="pitch"][data-step="1"]');
  await page.tap('songSettingsBody', '[data-tune="pitch"][data-step="1"]');
  assert.equal(page.node('tunePitch').textContent, '+2');
  assert.equal(page.node('tuneStatus').textContent, 'Modifié…');
  assert.deepEqual(tunePosts(page), [], 'enregistré après un court instant');
  assert.equal(card('alice').querySelector('[data-song-settings="e1"]').closest('li').querySelector('.tune-badge').textContent, '♯ +2',
    'le badge suit le réglage tout de suite');
  await page.runTimers(600);
  assert.deepEqual(tunePosts(page), [{ table: '1', access: 'secret', personId: 'alice', entryId: 'e1', settings: { pitch: 2, guideVoices: {} } }]);
  assert.equal(page.node('tuneStatus').textContent, 'Enregistré ✓');
  await page.tap('songSettingsBody', '[data-tune="tempo"][data-step="-5"]');
  await page.tap('songSettingsBody', '[data-tune="guide"][data-value="50"]');
  await page.tap('songSettingsBody', '[data-tune="backing"][data-value="0"]');
  assert.equal(page.node('tuneTempo').textContent, '−5 %');
  assert.deepEqual(pressed(page, 'guide'), ['50']);
  assert.deepEqual(pressed(page, 'backing'), ['0']);
  await page.runTimers(600);
  assert.deepEqual(tunePosts(page).at(-1).settings, { pitch: 2, tempo: -5, guide: 50, backing: 0, guideVoices: {} }, 'un seul envoi pour trois changements');
  await page.poll();
  assert.equal(page.node('tunePitch').textContent, '+2', 'valeur relue sur le serveur');
  // Bornes de KaraFun : + désactivé à +6.
  for (let i = 0; i < 6; i++) {
    const plus = page.find('songSettingsBody', '[data-tune="pitch"][data-step="1"]');
    if (!plus.disabled) await page.click(plus);
  }
  assert.equal(page.node('tunePitch').textContent, '+6');
  assert.equal(page.find('songSettingsBody', '[data-tune="pitch"][data-step="1"]').disabled, true, 'plus haut que +6 : impossible');
  await page.click(page.node('tuneReset'));
  assert.equal(page.node('tunePitch').textContent, '0');
  await page.runTimers(600);
  assert.deepEqual(tunePosts(page).at(-1).settings, { guideVoices: {} }, 'réinitialiser : réglages de KaraFun (clé des autres voix toujours envoyée)');
  await page.poll();
  assert.equal(card('alice').querySelector('[data-song-settings="e1"]').closest('li').querySelector('.tune-badge') === null, true, 'plus de badge');

  // Titre déjà dans KaraFun : ses pistes sont connues, sans chœurs.
  await page.click(page.find('sheetPanel', '[data-close-sheet]'));
  await page.tap('peopleList', '[data-song-settings="k1"]');
  assert.equal(page.node('tunePitch').textContent, '+2');
  assert.equal(page.node('songSettingsBody').querySelector('[data-tune="backing"]') === null, true, 'titre sans chœurs : pas de réglage des chœurs');
  assert.doesNotMatch(page.node('songSettingsBody').textContent, /Si le titre en a/);
  await page.tap('songSettingsBody', '[data-tune="tempo"][data-step="5"]');
  await page.runTimers(600);
  assert.deepEqual(tunePosts(page).at(-1), { table: '1', access: 'secret', personId: 'alice', entryId: 'k1', settings: { pitch: 2, tempo: -5, guideVoices: {} } });
  assert.equal(page.node('tuneStatus').textContent, 'Enregistré ✓ · envoyé à KaraFun');
});

test('réglages de titre : le rafraîchissement n’écrase pas un réglage en cours d’envoi ; fermer la fiche l’envoie', async () => {
  const waiting = [];
  const page = await open({ state: tuneState(), respond: (url, body, self) => url === '/api/table/song/settings'
    ? new Promise(resolve => waiting.push(() => resolve(keepSettings(self, body)))) : undefined });
  await page.tap('peopleList', '[data-song-settings="e1"]');
  await page.tap('songSettingsBody', '[data-tune="pitch"][data-step="1"]');
  await page.runTimers(600);
  assert.equal(page.node('tuneStatus').textContent, 'Enregistrement…');
  await page.poll();
  assert.equal(page.node('tunePitch').textContent, '+1', 'l’état du serveur (sans réglage) ne remplace pas la valeur envoyée');
  // Nouveau changement pendant l'envoi : il repart après la réponse, dans l'ordre.
  await page.tap('songSettingsBody', '[data-tune="pitch"][data-step="1"]');
  assert.equal(page.node('tunePitch').textContent, '+2');
  await page.runTimers(600);
  assert.equal(tunePosts(page).length, 1, 'un seul envoi à la fois');
  waiting.shift()();
  await page.settle();
  assert.deepEqual(tunePosts(page).map(body => body.settings), [{ pitch: 1, guideVoices: {} }, { pitch: 2, guideVoices: {} }]);
  await page.poll();
  assert.equal(page.node('tunePitch').textContent, '+2', 'réponse du premier envoi sans effet sur la valeur suivante');
  waiting.shift()();
  await page.settle();
  await page.poll();
  assert.equal(page.node('tunePitch').textContent, '+2');
  assert.equal(page.node('tuneStatus').textContent, 'Enregistré ✓');
  await page.runTimers(2600);
  assert.equal(page.node('tuneStatus').textContent, 'Chaque changement s’enregistre tout seul.');

  // Fiche fermée avant le court instant : le réglage part tout de suite.
  await page.tap('songSettingsBody', '[data-tune="guide"][data-value="25"]');
  await page.click(page.find('sheetPanel', '[data-close-sheet]'));
  assert.equal(page.sheetOpen(), false);
  assert.deepEqual(tunePosts(page).at(-1).settings, { pitch: 2, guide: 25, guideVoices: {} });
  waiting.shift()();
  await page.settle();
});

test('réglages de titre : duo, titre commencé, envoi en cours, fonction coupée par le bar et refus du serveur', async () => {
  const state = tuneState();
  state.tablePeople[0].songs[0].duet = { state: 'accepted', partnerName: 'Bob' };
  state.tablePeople[0].inKaraFun = [
    { entryId: 'k1', title: 'Sur scène', stage: true, canAdjust: false, settings: { tempo: 5 } },
    { entryId: 's1', title: 'En route', sending: true, canAdjust: true, settings: null },
  ];
  state.tablePeople[1].songs = [];
  state.tablePeople[1].guestDuos = [{ entryId: 'e1', ownerId: 'alice', fromName: 'Alice', song: { title: 'Mon titre', settings: { pitch: 3 } } }];
  state.managedIds = ['alice', 'bob'];
  let answer = null;
  const page = await open({ state, respond: (url, body, self) => url === '/api/table/song/settings' ? answer || keepSettings(self, body) : undefined });
  const card = id => page.find('peopleList', `[data-person-card="${id}"]`);
  assert.equal(card('alice').querySelector('[data-song-settings="k1"]') === null, true, 'titre commencé : plus réglable du téléphone');
  assert.equal(card('alice').querySelector('.tune-badge').textContent, 'tempo +5 %');
  assert.ok(card('alice').querySelector('[data-song-settings="s1"]'), 'titre en cours d’envoi : encore réglable');
  assert.equal(card('bob').querySelector('[data-song-settings]') === null, true, 'partenaire du duo : pas de bouton');
  assert.equal(card('bob').querySelector('.tune-badge').textContent, '♯ +3', 'partenaire : réglages de l’auteur visibles');

  await page.tap('peopleList', '[data-song-settings="e1"]');
  // Duo : plus de voix 2 qui suit la voix 1 ; chaque voix a son réglage (D6).
  assert.doesNotMatch(page.node('songSettingsBody').textContent, /Duo : les deux voix guides/);
  assert.match(page.node('songSettingsBody').textContent, /Voix 2Si le titre en a deux\./);
  // Refus du serveur : message dans la fiche, « Réessayer ».
  answer = reply(409, { error: 'Ce titre a déjà commencé : seul le bar peut encore le régler.', code: 'SONG_STARTED' });
  await page.tap('songSettingsBody', '[data-tune="pitch"][data-step="-1"]');
  await page.runTimers(600);
  assert.equal(page.node('tuneStatus').textContent, 'Non enregistré : Ce titre a déjà commencé : seul le bar peut encore le régler. · Réessayer');
  const refusedLine = card('alice').querySelector('[data-song-settings="e1"]').closest('li');
  assert.deepEqual(refusedLine.querySelectorAll('.tune-badge').map(node => node.textContent), ['Réglages non enregistrés'],
    'réglage refusé : le badge montre ce que le serveur a gardé (rien), pas le choix non enregistré, et signale le refus');
  answer = null;
  await page.tap('tuneStatus', '[data-tune-retry]');
  assert.deepEqual(tunePosts(page).at(-1).settings, { pitch: -1, guideVoices: {} }, 'réessayé avec la même valeur');
  assert.equal(page.node('tuneStatus').textContent, 'Enregistré ✓');

  // Le titre part sur scène pendant que la fiche est ouverte.
  page.state.tablePeople[0].songs = [];
  await page.poll();
  assert.match(page.node('songSettingsBody').textContent, /Ce titre n’est plus prévu : il a peut-être déjà été chanté ou retiré\./);
  assert.equal(page.find('songSettingsBody', '[data-tune="pitch"][data-step="1"]').disabled, true, 'plus rien à régler');
  await page.click(page.find('sheetPanel', '[data-close-sheet]'));

  // Le bar coupe la fonction : plus de bouton ni de badge ; une fiche ouverte se fige.
  await page.tap('peopleList', '[data-song-settings="s1"]');
  page.state.songSettings.enabled = false;
  await page.poll();
  assert.match(page.node('songSettingsBody').textContent, /Le bar a désactivé les réglages de titre depuis les téléphones\./);
  assert.equal(page.find('songSettingsBody', '[data-tune="guide"][data-value="50"]').disabled, true);
  assert.equal(page.node('tuneReset').disabled, true);
  await page.click(page.find('sheetPanel', '[data-close-sheet]'));
  assert.equal(page.node('peopleList').querySelector('[data-song-settings]') === null, true, 'fonction coupée : aucun bouton');
  assert.equal(page.node('peopleList').querySelector('.tune-badge') === null, true, 'ni badge');
  assert.equal(tunePosts(page).length, 2, 'rien d’envoyé fonction coupée (le refus, puis « Réessayer »)');
});

test('réglages de titre : en anglais, textes de la fiche et refus traduits', async () => {
  const page = await open({ languages: ['en'], state: tuneState(), respond: url => url === '/api/table/song/settings'
    ? reply(403, { error: 'Le bar a désactivé les réglages de titre depuis les téléphones.', code: 'SONG_SETTINGS_OFF' }) : undefined });
  const button = page.find('peopleList', '[data-song-settings="e1"]');
  assert.equal(button.getAttribute('aria-label'), 'Settings for Mon titre');
  assert.equal(page.find('peopleList', '.tune-badge').textContent, '♯ +2 · tempo −10%', 'typographie anglaise');
  await page.click(button);
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Settings · Mon titre');
  const body = page.node('songSettingsBody').textContent;
  for (const text of ['Key', '0 = original', 'Tempo', 'Voice 1', 'Voice 2', 'If the song has two.', 'Backing vocals', 'Off', 'If the song has them.', 'KaraFun setting: 53']) {
    assert.ok(body.includes(text), `texte anglais : ${text}`);
  }
  assert.equal(page.node('tuneReset').textContent, 'Reset');
  await page.tap('songSettingsBody', '[data-tune="guide"][data-value="75"]');
  assert.equal(page.node('tuneStatus').textContent, 'Changed…');
  await page.runTimers(600);
  assert.equal(page.node('tuneStatus').textContent, 'Not saved: The bar has turned off song settings from phones. · Try again');
  const duo = await open({ languages: ['en'], state: tuneState(), respond: url => url === '/api/table/song/settings'
    ? reply(403, { error: 'Alice a choisi ce duo : les réglages se font sur son téléphone.', code: 'DUO_GUEST' }) : undefined });
  await duo.tap('peopleList', '[data-song-settings="e1"]');
  await duo.tap('songSettingsBody', '[data-tune="tempo"][data-step="5"]');
  await duo.runTimers(600);
  assert.equal(duo.node('tuneStatus').textContent, 'Not saved: Alice picked this duet: settings are made on their phone. · Try again');
});

// Lot G2 (décision D6) : un réglage par voix guide, sans réglage commun ;
// pistes inconnues avant l'envoi : voix 1, et voix 2 si le titre en a deux.
test('réglages de titre : une voix guide par réglage, voix 1 et voix 2, résumé voix par voix, en français et en anglais', async () => {
  const state = tuneState();
  state.tablePeople[0].inKaraFun[0].tracks = [4, 5, 6];
  state.tablePeople[0].inKaraFun[0].settings = { guide: 50, guideVoices: { 6: 25 } };
  const page = await open({ state, respond: (url, body, self) => url === '/api/table/song/settings' ? keepSettings(self, body) : undefined });
  const labels = () => page.node('songSettingsBody').querySelectorAll('.tune-label').map(node => node.textContent);
  const badge = entryId => page.find('peopleList', `[data-song-settings="${entryId}"]`).closest('li').querySelector('.tune-badge');
  assert.equal(badge('k1').textContent, 'voix 1 50 · voix 2 25');
  await page.tap('peopleList', '[data-song-settings="k1"]');
  assert.deepEqual(labels(), ['Tonalité', 'Tempo', 'Voix 1', 'Voix 2', 'Chœurs']);
  assert.deepEqual([pressed(page, 'guide'), pressed(page, 'voice:6')], [['50'], ['25']]);
  assert.ok(page.node('tuneLabel-voice6'));
  await page.tap('songSettingsBody', '[data-tune="voice:6"][data-value="75"]');
  assert.equal(badge('k1').textContent, 'voix 1 50 · voix 2 75', 'le badge suit tout de suite');
  await page.runTimers(600);
  assert.deepEqual(tunePosts(page).at(-1).settings, { guide: 50, guideVoices: { 6: 75 } }, 'la voix 1 garde son réglage');
  await page.poll();
  assert.deepEqual(pressed(page, 'voice:6'), ['75'], 'valeur relue sur le serveur');
  // Troisième voix annoncée : « Voix 3 ». Une seule voix : « Voix guide ».
  page.state.tablePeople[0].inKaraFun[0].tracks = [4, 5, 6, 7];
  await page.poll();
  assert.deepEqual(labels(), ['Tonalité', 'Tempo', 'Voix 1', 'Voix 2', 'Voix 3', 'Chœurs']);
  page.state.tablePeople[0].inKaraFun[0].tracks = [4, 5];
  page.state.tablePeople[0].inKaraFun[0].settings = { guide: 50 };
  await page.poll();
  assert.deepEqual(labels(), ['Tonalité', 'Tempo', 'Voix guide', 'Chœurs']);
  assert.equal(badge('k1').textContent, 'guide 50');
  // Voix 2 coupée alors que KaraFun la mettrait ailleurs par défaut : rappelée.
  page.state.tablePeople[0].inKaraFun[0].settings = { guideVoices: { 6: 0 } };
  page.state.songSettings.defaults.guide = 25;
  await page.poll();
  assert.equal(badge('k1').textContent, 'voix 2 coupée');
  await page.click(page.find('sheetPanel', '[data-close-sheet]'));
  // En anglais.
  const english = tuneState();
  english.tablePeople[0].inKaraFun[0].tracks = [4, 5, 6];
  english.tablePeople[0].inKaraFun[0].settings = { guide: 50, guideVoices: { 6: 25 } };
  const en = await open({ languages: ['en'], state: english });
  assert.equal(en.find('peopleList', '[data-song-settings="k1"]').closest('li').querySelector('.tune-badge').textContent, 'voice 1 50 · voice 2 25');
  en.state.tablePeople[0].inKaraFun[0].settings = { guideVoices: { 6: 0 } };
  en.state.songSettings.defaults.guide = 25;
  await en.poll();
  assert.equal(en.find('peopleList', '[data-song-settings="k1"]').closest('li').querySelector('.tune-badge').textContent, 'voice 2 off');
  en.state.tablePeople[0].inKaraFun[0].tracks = [5];
  await en.poll();
  await en.tap('peopleList', '[data-song-settings="k1"]');
  assert.match(en.node('songSettingsBody').textContent, /Guide vocals/);
});

test('réglages de titre : un refus oublié quand le titre n’est plus réglable ; titre sans voix guide', async () => {
  const state = tuneState();
  state.tablePeople[0].inKaraFun[0].tracks = [4];
  let answer = reply(409, { error: 'Ce titre a déjà commencé : seul le bar peut encore le régler.', code: 'SONG_STARTED' });
  const page = await open({ state, respond: (url, body, self) => url === '/api/table/song/settings' ? answer || keepSettings(self, body) : undefined });
  await page.tap('peopleList', '[data-song-settings="k1"]');
  assert.match(page.node('songSettingsBody').textContent, /Ce titre n’a pas de voix guide\./);
  assert.equal(page.node('songSettingsBody').querySelector('[data-tune="guide"]') === null, true);
  assert.ok(page.node('songSettingsBody').querySelector('[data-tune="backing"]'), 'chœurs présents');
  await page.tap('songSettingsBody', '[data-tune="pitch"][data-step="1"]');
  await page.runTimers(600);
  assert.match(page.node('tuneStatus').textContent, /^Non enregistré/);
  // Le titre commence : le choix refusé est oublié.
  page.state.tablePeople[0].inKaraFun[0].canAdjust = false;
  await page.poll();
  assert.match(page.node('songSettingsBody').textContent, /Ce titre a commencé : seul le bar peut encore le régler\./);
  assert.equal(page.node('tunePitch').textContent, '+2', 'valeur gardée par le serveur');
  // Puis redevient réglable (relance refusée, par exemple) : plus d'ancien refus ni d'ancien choix.
  page.state.tablePeople[0].inKaraFun[0].canAdjust = true;
  await page.poll();
  assert.equal(page.node('tunePitch').textContent, '+2');
  assert.equal(page.node('tuneStatus').textContent, 'Chaque changement s’enregistre tout seul.');
  answer = null;
});

test('réglages de titre : refus arrivé fiche fermée, signalé par un message et sur la ligne du titre', async () => {
  let answer = reply(409, { error: 'Ce titre est en train de sortir de KaraFun. Réessaie dans un instant.' });
  const page = await open({ state: tuneState(), respond: (url, body, self) => url === '/api/table/song/settings' ? answer || keepSettings(self, body) : undefined });
  const line = entryId => page.find('peopleList', `[data-song-settings="${entryId}"]`).closest('li');
  await page.tap('peopleList', '[data-song-settings="e1"]');
  await page.tap('songSettingsBody', '[data-tune="pitch"][data-step="1"]');
  // « Terminé » tout de suite : le réglage part, la fiche est déjà fermée quand le refus arrive.
  await page.click(page.find('sheetPanel', '.sheet-actions [data-close-sheet]'));
  assert.equal(page.sheetOpen(), false);
  assert.deepEqual(page.toast(), { text: 'Réglages de « Mon titre » non enregistrés : Ce titre est en train de sortir de KaraFun. Réessaie dans un instant.',
    bad: true, warn: false, hidden: false });
  assert.equal(line('e1').querySelector('.tune-badge.bad').textContent, 'Réglages non enregistrés', 'le refus reste visible sur la ligne');
  await page.poll();
  assert.equal(line('e1').querySelector('.tune-badge.bad').textContent, 'Réglages non enregistrés', 'et au rafraîchissement suivant');
  // La fiche rouverte le dit aussi, avec « Réessayer ».
  await page.tap('peopleList', '[data-song-settings="e1"]');
  assert.match(page.node('tuneStatus').textContent, /^Non enregistré : Ce titre est en train de sortir de KaraFun/);
  answer = null;
  await page.tap('tuneStatus', '[data-tune-retry]');
  assert.equal(page.node('tuneStatus').textContent, 'Enregistré ✓');
  await page.click(page.find('sheetPanel', '.sheet-actions [data-close-sheet]'));
  await page.poll();
  assert.equal(line('e1').querySelector('.tune-badge.bad') === null, true);
  assert.equal(line('e1').querySelector('.tune-badge').textContent, '♯ +1');
  // Le titre commence pendant l'envoi : plus réglable, mais le message reste affiché.
  answer = reply(409, { error: 'Ce titre a déjà commencé : seul le bar peut encore le régler.', code: 'SONG_STARTED' });
  await page.tap('peopleList', '[data-song-settings="k1"]');
  await page.tap('songSettingsBody', '[data-tune="pitch"][data-step="1"]');
  Object.assign(page.state.tablePeople[0].inKaraFun[0], { canAdjust: false, stage: true, lock: 'started' });
  await page.click(page.find('sheetPanel', '.sheet-actions [data-close-sheet]'));
  assert.equal(page.toast().text, 'Réglages de « Déjà prête » non enregistrés : Ce titre a déjà commencé : seul le bar peut encore le régler.');
  assert.equal(page.toast().bad, true);
  // Fiche ouverte sur ce titre : le refus s'affiche dans la fiche, pas en message.
  answer = reply(409, { error: 'Ce titre est en train de sortir de KaraFun. Réessaie dans un instant.' });
  await page.runTimers(4000);
  await page.tap('peopleList', '[data-song-settings="e1"]');
  await page.tap('songSettingsBody', '[data-tune="pitch"][data-step="1"]');
  await page.runTimers(600);
  assert.match(page.node('tuneStatus').textContent, /^Non enregistré/);
  assert.equal(page.toast().hidden, true, 'pas de message en double');
});

test('réglages de titre : la fiche dit pourquoi le titre ne se règle plus (sortie de KaraFun, sur scène, autre téléphone, parti)', async () => {
  const state = tuneState();
  state.tablePeople[0].inKaraFun[0].lock = null;
  const page = await open({ state });
  const lock = () => page.find('songSettingsBody', '.tune-lock').textContent;
  await page.tap('peopleList', '[data-song-settings="k1"]');
  // « Pas prêt » ou retrait du bar : le titre sort de KaraFun et reviendra dans la liste.
  Object.assign(page.state.tablePeople[0].inKaraFun[0], { canAdjust: false, lock: 'leaving' });
  await page.poll();
  assert.equal(lock(), 'Ce titre est en train de sortir de KaraFun : il se réglera de nouveau une fois revenu dans la liste.');
  Object.assign(page.state.tablePeople[0].inKaraFun[0], { canAdjust: false, stage: true, lock: 'started' });
  await page.poll();
  assert.equal(lock(), 'Ce titre a commencé : seul le bar peut encore le régler.');
  Object.assign(page.state.tablePeople[0].inKaraFun[0], { canAdjust: false, stage: false, lock: 'duo' });
  await page.poll();
  assert.equal(lock(), 'Seul l’auteur de ce duo peut régler ce titre.');
  await page.click(page.find('sheetPanel', '.sheet-actions [data-close-sheet]'));
  // Titre de sa liste, gestion passée sur un autre téléphone.
  await page.tap('peopleList', '[data-song-settings="e1"]');
  page.state.managedIds = [];
  await page.poll();
  assert.equal(lock(), 'Ce téléphone ne gère plus Alice : ses titres se règlent depuis l’autre téléphone.');
  // Partie de la soirée.
  page.state.managedIds = ['alice'];
  page.state.tablePeople[0].active = false;
  await page.poll();
  assert.equal(lock(), 'Alice a quitté la soirée : ses titres ne se règlent plus.');
});

// ================================================================ QA navigateur du 2026-10-03
// Found by /qa on 2026-10-03
// Report: .gstack/qa-reports/run-20261003T140104Z/qa-report-127.0.0.1-2026-10-03.md

// Regression: ISSUE-019 — élision manquante (« de Alice »)
// Regression: ISSUE-021 — le « ? » final passait seul à la ligne
// Fiche d'une personne gérée par un autre téléphone, avec une demande qui l'attend.
const otherPhoneState = name => {
  const state = baseState();
  state.tablePeople.push(person('other', name, { invites: [{ entryId: 'x1', fromName: 'Léa', song: { title: 'Slow' } }] }));
  return state;
};
test('français : « d’Alice », « de Bruno », espace insécable avant « ? » et « ! », rien de tel en anglais', async () => {
  const state = baseState();
  state.tablePeople = [person('alice', 'Alice', { needConfirm: true, songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre' }] })];
  const page = await open({ state });
  assert.equal(page.node('attentionTitle').textContent, 'C’est bientôt au tour d’Alice\u00a0!');
  const bruno = baseState();
  bruno.tablePeople = [person('bruno', 'Bruno', { needConfirm: true, songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre' }] })];
  bruno.managedIds = ['bruno'];
  assert.equal((await open({ state: bruno })).node('attentionTitle').textContent, 'C’est bientôt au tour de Bruno\u00a0!');
  const hugo = baseState();
  hugo.tablePeople = [person('hugo', 'Hugo', { needConfirm: true, songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre' }] })];
  hugo.managedIds = ['hugo'];
  assert.equal((await open({ state: hugo })).node('attentionTitle').textContent, 'C’est bientôt au tour d’Hugo\u00a0!', 'h muet');
  const en = await open({ state, languages: ['en-GB'] });
  assert.ok(!/\u00a0/.test(en.node('attentionTitle').textContent), 'pas d’espace insécable en anglais');
  // Feuille de reprise.
  const claim = await open({ state: otherPhoneState('Émilie') });
  await claim.click(claim.node('tableAllButton'));
  await claim.tap('tableSheetList', '[data-sheet-claim="other"]');
  assert.equal(claim.find('sheetPanel', 'h3').textContent, 'Gérer les chansons d’Émilie');
});

// Regression: ISSUE-015 — « Pas prêt » seul : la fenêtre revenait aussitôt avec « Je suis là » seul, sans explication
test('demandes : « Je suis là » sans « Pas prêt » quand personne d’autre n’attend, avec la raison ; refus traduit', async () => {
  const state = baseState();
  state.tablePeople = [person('alice', 'Alice', { needConfirm: true, canDefer: false, deferAlone: true, songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre' }] })];
  const page = await open({ state });
  assert.deepEqual(page.node('attentionChoices').querySelectorAll('button').map(button => button.textContent), ['Je suis là']);
  assert.equal(page.find('attentionChoices', '.attention-note').textContent,
    'Personne d’autre n’attend pour chanter : ton passage ne peut pas être repoussé.');
  const en = await open({ state, languages: ['en-GB'] });
  assert.equal(en.find('attentionChoices', '.attention-note').textContent, 'Nobody else is waiting to sing: your turn can’t be pushed back.');
  // Refus du serveur (course entre deux téléphones) : message traduit dans la fenêtre.
  const raced = baseState();
  raced.tablePeople = [person('alice', 'Alice', { needConfirm: true, canDefer: true, songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre' }] })];
  const late = await open({ state: raced, languages: ['en-GB'], respond: url => url === '/api/table/defer'
    ? reply(400, { error: 'Personne d’autre n’attend pour chanter : ton passage ne peut pas être repoussé.', code: 'DEFER_ALONE' }) : undefined });
  await late.tap('attentionChoices', '[data-attn="defer"]');
  assert.equal(late.node('attentionError').textContent, 'Nobody else is waiting to sing: your turn can’t be pushed back.');
});

// Regression: ISSUE-014 — « Je suis là » faisait partir le titre avant que la demande de duo sur ce titre soit vue
// Regression: relecture PR #11 — la règle du propriétaire prévoit « Plus tard (1 min) » pour toute demande de duo
test('demandes : une demande de duo sur le titre attendu passe avant « Je suis là », avec « Plus tard » ; avis à l’auteur', async () => {
  const state = baseState();
  state.tablePeople = [person('alice', 'Alice', { needConfirm: true, songs: [{ entryId: 'w1', songId: 1, title: 'Waterloo' }],
    joinRequests: [{ entryId: 'w1', fromId: 'dan', fromName: 'Dan', song: { title: 'Waterloo' } }] })];
  const page = await open({ state, respond: (url, body, self) => {
    if (url === '/api/table/duet/join/answer') self.state.tablePeople[0].joinRequests = [];
    return undefined;
  } });
  assert.equal(page.node('attentionCount').textContent, '1 / 2');
  assert.equal(page.node('attentionTitle').textContent, 'Dan aimerait chanter « Waterloo » avec Alice.', 'la demande d’abord');
  const choices = () => page.node('attentionChoices').querySelectorAll('button').map(button => button.textContent);
  assert.deepEqual(choices(), ['Accepter', 'Refuser', 'Plus tard (1 min)'], '« Plus tard » existe pour les duos');
  // « Plus tard » : « Je suis là » passe en tête pendant une minute.
  const later = await open({ state: JSON.parse(JSON.stringify(state)) });
  await later.tap('attentionChoices', '[data-attn="later"]');
  assert.equal(later.node('attentionTitle').textContent, 'C’est bientôt au tour d’Alice\u00a0!');
  assert.deepEqual(later.posts.filter(([url]) => url === '/api/table/duet/join/answer'), [], 'aucune réponse envoyée');
  await page.tap('attentionChoices', '[data-attn="yes"]');
  assert.equal(page.node('attentionTitle').textContent, 'C’est bientôt au tour d’Alice\u00a0!', 'puis la présence');
  // Demande expirée quand même (titre parti) : l'auteur est prévenu.
  page.state.tablePeople[0].needConfirm = false;
  page.state.tablePeople[0].inbox = [{ id: 'm1', kind: 'joinMissed', params: { name: 'Dan', title: 'Waterloo' }, at: Date.now() }];
  await page.poll();
  assert.ok(page.node('infoBar').querySelectorAll('.info-item p').some(p => p.textContent ===
    'Dan demandait à chanter « Waterloo » avec Alice : le titre est parti dans KaraFun avant la réponse, la demande a expiré.'));
});

// Regression: ISSUE-016 — les messages dépliés s'empilaient sans limite et couvraient les fiches
test('infos : messages dépliés repliables, hauteur bornée et sous les fiches', async () => {
  const now = Date.now();
  const state = baseState();
  state.tablePeople = [person('alice', 'Alice', { inbox: Array.from({ length: 6 }, (_, i) =>
    ({ id: `n${i}`, kind: 'joinRefused', params: { name: `Ami ${i}`, title: `Titre ${i}` }, at: now })) })];
  const page = await open({ state });
  const shown = () => page.node('infoBar').querySelectorAll('.info-item').length;
  assert.equal(shown(), 2);
  await page.tap('infoBar', '[data-info-more]');
  assert.equal(shown(), 6);
  assert.equal(page.node('infoBar').classList.contains('expanded'), true, 'dépliés : hauteur bornée, défilement');
  assert.equal(page.find('infoBar', '[data-info-less]').textContent, 'Replier les messages');
  await page.tap('infoBar', '[data-info-less]');
  assert.equal(shown(), 2);
  assert.equal(page.node('infoBar').classList.contains('expanded'), false);
  assert.equal(page.find('infoBar', '[data-info-more]').textContent, '+4 autres messages');
  const css = html.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = selector => (new RegExp(`${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css) || [])[1] || '';
  const z = selector => Number(/z-index:\s*(\d+)/.exec(rule(selector))?.[1]);
  assert.ok(z('.client .info-bar') < 20, 'les messages passent sous une fiche ouverte (z-index 20)');
  assert.match(rule('.client .info-bar.expanded'), /max-height:\s*45vh/);
  assert.match(rule('.client .info-bar.expanded'), /overflow-y:\s*auto/);
});

// Regression: ISSUE-017 — la fiche « Transférer … » restait ouverte sur l'ancien téléphone après la reprise
test('transfert : la fiche se ferme quand l’autre téléphone a repris la personne', async () => {
  const state = baseState();
  state.tablePeople.push(person('bruno', 'Bruno'));
  state.managedIds = ['alice', 'bruno'];
  const page = await open({ state, respond: url => url === '/api/table/person/share' ? share() : undefined });
  await page.tap('peopleList', '[data-share-person="bruno"]');
  assert.equal(page.sheetOpen(), true);
  await page.poll();
  assert.equal(page.sheetOpen(), true, 'tant que le transfert attend, la fiche reste');
  page.state.managedIds = ['alice'];
  await page.poll();
  assert.equal(page.sheetOpen(), false, 'repris ailleurs : la fiche se ferme');
  // Une autre fiche ouverte n'est pas fermée par la reprise d'une autre personne.
  page.state.managedIds = ['alice', 'bruno'];
  await page.poll();
  await page.tap('peopleList', '[data-share-person="alice"]');
  page.state.managedIds = ['alice'];
  await page.poll();
  assert.equal(page.sheetOpen(), true, 'la fiche d’Alice reste ouverte');
});

// Regression: ISSUE-018 — le champ du code de reprise n'avait pas le style des autres champs
test('reprise : le champ du code à 4 chiffres a le type texte (style des champs), clavier numérique', async () => {
  const page = await open({ state: otherPhoneState('Bob') });
  await page.click(page.node('tableAllButton'));
  await page.tap('tableSheetList', '[data-sheet-claim="other"]');
  const input = page.node('claimCode');
  assert.equal(input.getAttribute('type'), 'text', 'input[type=text] reçoit le style commun (48 px, coins arrondis)');
  assert.equal(input.getAttribute('inputmode'), 'numeric');
});

// Regression: ISSUE-020 — « (à ta table, le duo est direct) » s'affichait pour une personne d'une autre table
test('demande de duo : le duo direct n’est annoncé que pour une personne de sa table', async () => {
  const state = baseState();
  state.tablePeople.push(person('marc', 'Marc', { songs: [{ entryId: 'm1', songId: 3, title: 'Hit' }] }));
  state.queue = [{ pos: 1, source: 'helper', id: 'dan', ids: ['dan'], name: 'Dan', title: 'Waterloo', song: { entryId: 'w1', title: 'Waterloo' }, eta: Date.now() + 60000 },
    { pos: 2, source: 'helper', id: 'marc', ids: ['marc'], name: 'Marc', title: 'Hit', song: { entryId: 'm1', title: 'Hit' }, eta: Date.now() + 120000 }];
  const page = await open({ state });
  await page.click(page.node('nav-queue'));
  await page.tap('queueList', '[data-join-request="dan"]');
  const text = () => page.find('sheetPanel', 'p.small').textContent;
  assert.equal(text(), 'Dan garde son passage et accepte ou refuse ta demande. Tes propres chansons restent dans ta liste.');
  assert.ok(!/direct/.test(page.sheetHtml()), 'autre table : pas de mention du duo direct');
  await page.tap('sheetPanel', '[data-close-sheet]');
  // Même table : la proposition vient du catalogue (titre déjà prévu par Marc).
  const same = await open({ state, respond: url => url.startsWith('/api/song/notice?')
    ? { notice: { playedAt: null, queued: [{ pos: 2, name: 'Marc', ownerId: 'marc', entryId: 'm1' }] } } : undefined });
  await same.click(same.node('nav-catalog'));
  await pickCatalogSong(same);
  await same.tap('songJoinOffer', '[data-join-request="marc"]');
  assert.equal(same.find('sheetPanel', 'p.small').textContent,
    'Marc est à ta table : le duo est ajouté tout de suite et Marc garde son passage. Tes propres chansons restent dans ta liste.');
});

// Regression: ISSUE-022 — les boutons d'Alice et de Bruno avaient les mêmes noms accessibles
test('fiches : le prénom figure dans le nom accessible de « Chanson », « Duo » et « Transférer la gestion »', async () => {
  const state = baseState();
  state.tablePeople.push(person('bruno', 'Bruno'));
  state.managedIds = ['alice', 'bruno'];
  const page = await open({ state });
  const label = (selector) => page.find('peopleList', selector).getAttribute('aria-label');
  assert.equal(label('[data-add-song="alice"]'), 'Ajouter une chanson pour Alice');
  assert.equal(label('[data-add-song="bruno"]'), 'Ajouter une chanson pour Bruno');
  assert.equal(label('[data-duet-song="bruno"]'), 'Ajouter un duo pour Bruno');
  assert.equal(label('[data-share-person="alice"]'), 'Transférer la gestion d’Alice');
  assert.equal(label('[data-share-person="bruno"]'), 'Transférer la gestion de Bruno');
});

// Regression: relecture PR #11 — pendant une demande bloquante, le message de
// confirmation était rendu inerte : un lecteur d'écran ne l'annonçait pas.
test('demandes : la confirmation d’une réponse reste annoncée quand une autre demande suit', async () => {
  const state = baseState();
  state.tablePeople = [person('alice', 'Alice', { invites: [{ entryId: 'x1', fromName: 'Zoé', song: { title: 'Hit' } },
    { entryId: 'x2', fromName: 'Marc', song: { title: 'Autre' } }] })];
  const page = await open({ state, respond: (url, body, self) => {
    if (url === '/api/table/duet/answer') self.state.tablePeople[0].invites = self.state.tablePeople[0].invites.filter(i => i.entryId !== body.entryId);
    return undefined;
  } });
  assert.equal(page.node('attention').hidden, false);
  assert.equal(page.node('mainContent').inert, true);
  await page.tap('attentionChoices', '[data-attn="no"]');
  assert.equal(page.node('attention').hidden, false, 'la seconde invitation reste ouverte');
  assert.match(page.node('attentionTitle').textContent, /Marc/);
  assert.equal(page.node('toast').textContent, 'Invitation refusée.');
  assert.equal(page.node('toast').hidden, false);
  assert.equal(page.node('toast').getAttribute('role'), 'status');
  assert.notEqual(page.node('toast').inert, true, 'zone d’état annoncée, jamais inerte');
  assert.equal(page.node('mainContent').inert, true, 'le reste de la page reste bloqué');
});

// ================================================================ retours du test du 4 octobre
test('infos : plus d’avis « c’est à toi, sur scène maintenant », l’avis « passe juste après » reste', async () => {
  const state = baseState({ next: { ours: true, ids: ['alice'], song: { entryId: 'e1' }, title: 'Mon titre' } });
  state.tablePeople = [person('alice', 'Alice', { canDefer: true, songs: [{ entryId: 'e1', songId: 1, title: 'Mon titre' }] })];
  const page = await open({ state });
  const items = () => page.node('infoBar').querySelectorAll('.info-item p').map(p => p.textContent);
  assert.deepEqual(items(), ['Alice passe juste après la chanson en cours : prépare-toi !'], 'prévenue juste avant son passage');
  assert.equal(page.vibrations.length, 1);
  // Sur scène : aucun nouvel avis, rien ne vibre.
  page.state.stage = { ours: true, ids: ['alice'], queueId: 5, title: 'Mon titre' };
  page.state.next = null;
  await page.poll();
  assert.ok(!items().some(text => /sur scène/.test(text)), `aucun avis de passage sur scène : ${items().join(' | ')}`);
  assert.equal(page.node('infoBar').hidden, true, 'plus rien à annoncer');
  assert.equal(page.vibrations.length, 1, 'pas de vibration pour le passage sur scène');
  assert.ok(!/sur scène maintenant/.test(html), 'le texte a disparu de la page');
});

// Recherche du catalogue : nombre de demandes envoyées et résultats « Queen »
// encore affichés, champ vidé et sans × (la recherche suivante se tape tout de suite).
const searchUrls = page => page.requests.filter(request => request.url.startsWith('/api/search?')).map(request => request.url);
function assertQueenKept(page, label) {
  assert.equal(page.tabShown(), 'catalog', label);
  assert.equal(page.node('searchInput').value, '', `${label} : champ vidé`);
  assert.equal(page.node('searchClear').hidden, true, `${label} : plus de ×`);
  assert.match(page.node('catalogContent').textContent, /^Résultats pour « Queen »/, `${label} : recherche précédente affichée`);
  assert.deepEqual(page.node('catalogContent').querySelectorAll('.song-title').map(node => node.textContent),
    ['Bohemian Rhapsody', 'Under Pressure'], `${label} : avec ses titres`);
}

test('catalogue : « ＋ Chanson », « ＋ Duo » et « Choisir une chanson » gardent les résultats précédents, champ de recherche vidé', async () => {
  const state = baseState();
  state.tablePeople = [person('alice', 'Alice'), person('bruno', 'Bruno')];
  state.managedIds = ['alice', 'bruno'];
  const page = await open({ state });
  const searchQueen = async () => {
    await page.type('searchInput', 'Queen');
    await page.runTimers(300);
    assert.match(page.node('catalogContent').textContent, /^Résultats pour « Queen »/);
  };
  // « ＋ Chanson » pour Alice, recherche, titre ajouté à sa liste…
  await page.tap('peopleList', '[data-add-song="alice"]');
  await searchQueen();
  await page.tap('catalogContent', '[data-song-index="0"]');
  await page.click(page.node('appendSong'));
  assert.equal(page.tabShown(), 'table');
  // … puis « ＋ Chanson » de nouveau, pour elle ou pour Bruno, et « ＋ Duo » :
  // la recherche « Queen » est encore ouverte, sans nouvelle demande.
  const sent = searchUrls(page).length;
  await page.tap('peopleList', '[data-add-song="alice"]');
  assertQueenKept(page, '« ＋ Chanson » pour la même personne');
  await page.click(page.node('nav-table'));
  await page.tap('peopleList', '[data-add-song="bruno"]');
  assertQueenKept(page, '« ＋ Chanson » pour une autre personne');
  assert.match(page.node('catalogTarget').textContent, /Bruno/);
  await page.click(page.node('nav-table'));
  await page.tap('peopleList', '[data-duet-song="alice"]');
  assertQueenKept(page, '« ＋ Duo »');
  assert.equal(searchUrls(page).length, sent, 'résultats gardés : aucune nouvelle recherche');
  // Une autre recherche se tape normalement.
  await page.type('searchInput', 'A');
  assert.equal(page.node('searchClear').hidden, false, 'le × revient avec le texte');
  assert.equal(page.node('catalogContent').textContent, 'Tape au moins 2 lettres.');
  await page.type('searchInput', 'Abba');
  await page.runTimers(300);
  assert.equal(searchUrls(page).at(-1), '/api/search?q=Abba');
  assert.match(page.node('catalogContent').textContent, /^Résultats pour « Abba »/);

  // Recherche encore en attente (« Que », quitté avant 300 ms) : abandonnée,
  // les résultats « Queen » restent affichés, sans nouvelle demande, et
  // « Que » ne part pas après coup.
  await searchQueen();
  const queenSent = searchUrls(page).length;
  await page.type('searchInput', 'Que');
  await page.click(page.node('nav-table'));
  const tableStep = page.history.index;
  await page.tap('peopleList', '[data-add-song="bruno"]');
  assertQueenKept(page, 'frappe interrompue');
  assert.equal(page.history.index, tableStep + 1, 'une seule étape ajoutée, celle du catalogue');
  assert.equal(page.history.state.term, 'Queen', 'l’étape garde le terme affiché');
  await page.runTimers(300);
  assertQueenKept(page, 'frappe interrompue, 300 ms plus tard');
  assert.ok(!searchUrls(page).includes('/api/search?q=Que'), 'la recherche « Que » n’est jamais envoyée');
  assert.equal(searchUrls(page).length, queenSent, 'résultats « Queen » encore affichés : pas redemandés');
  // Une seule lettre tapée : les résultats d'avant, pas « Tape au moins 2 lettres. ».
  await page.type('searchInput', 'Q');
  assert.equal(page.node('catalogContent').textContent, 'Tape au moins 2 lettres.');
  await page.click(page.node('nav-table'));
  await page.tap('peopleList', '[data-add-song="alice"]');
  assertQueenKept(page, 'une lettre tapée');
  // Champ vide, donc sans × : les boutons « Playlists », « Styles »… ramènent aux sélections.
  await page.tap(page.body, '[data-catalog="playlist"]');
  assert.match(page.node('catalogContent').textContent, /^Choisis une sélection\./, '« Playlists » ramène aux sélections');

  // Titres d'une sélection ouverte : ils restent affichés, une lettre tapée comprise.
  await page.tap('catalogContent', '[data-category-index="0"]');
  const selectionKept = label => {
    assert.equal(page.node('searchInput').value, '', `${label} : champ vidé`);
    assert.match(page.node('catalogContent').textContent, /^← SélectionsAnnées 80/, `${label} : sélection ouverte`);
    assert.deepEqual(page.node('catalogContent').querySelectorAll('.song-title').map(node => node.textContent), ['Tube'], `${label} : avec ses titres`);
  };
  await page.click(page.node('nav-table'));
  await page.tap('peopleList', '[data-add-song="alice"]');
  selectionKept('sélection ouverte');
  await page.type('searchInput', 'Z');
  await page.click(page.node('nav-table'));
  await page.tap('peopleList', '[data-add-song="bruno"]');
  selectionKept('sélection ouverte, une lettre tapée');
  // Deux lettres en attente : la liste est encore là, elle n'est pas rechargée
  // (les pages « Voir plus » déjà lues restent).
  const songsAsked = () => page.requests.filter(request => request.url.startsWith('/api/catalog/songs?')).length;
  const asked = songsAsked();
  await page.type('searchInput', 'Zo');
  await page.click(page.node('nav-table'));
  await page.tap('peopleList', '[data-add-song="alice"]');
  await page.runTimers(300);
  selectionKept('sélection ouverte, deux lettres en attente');
  assert.equal(songsAsked(), asked, 'sélection gardée telle quelle, sans nouvelle demande');
  assert.ok(!searchUrls(page).includes('/api/search?q=Zo'), 'la recherche « Zo » n’est jamais envoyée');
  // Sélections, une lettre tapée : les sélections reviennent.
  await page.tap(page.body, '[data-catalog="playlist"]');
  await page.type('searchInput', 'Z');
  await page.click(page.node('nav-table'));
  await page.tap('peopleList', '[data-add-song="alice"]');
  assert.equal(page.node('searchInput').value, '', 'sélections, une lettre tapée : champ vidé');
  assert.match(page.node('catalogContent').textContent, /^Choisis une sélection\.Années 80$/, 'sélections, une lettre tapée : les sélections');
  // Nouveautés : la liste reste aussi, une lettre tapée comprise.
  await page.tap(page.body, '[data-catalog="news"]');
  const newsKept = label => {
    assert.equal(page.node('searchInput').value, '', `${label} : champ vidé`);
    assert.match(page.node('catalogContent').textContent, /^Nouveautés/, `${label} : Nouveautés affichées`);
    assert.deepEqual(page.node('catalogContent').querySelectorAll('.song-title').map(node => node.textContent), ['Nouveau tube'], `${label} : avec leurs titres`);
  };
  await page.click(page.node('nav-table'));
  await page.tap('peopleList', '[data-add-song="alice"]');
  newsKept('Nouveautés');
  await page.type('searchInput', 'Z');
  await page.click(page.node('nav-table'));
  await page.tap('peopleList', '[data-add-song="bruno"]');
  newsKept('Nouveautés, une lettre tapée');

  // « Choisir une chanson » (En solo) : titre ajouté à ma liste, puis
  // « Choisir une chanson » de nouveau : la recherche précédente est ouverte.
  const solo = baseState({ table: { id: 'Comptoir', name: 'En solo', individual: true, headcount: 40, activeCount: 1 } });
  solo.tablePeople = [person('zoe', 'Zoé')];
  solo.managedIds = ['zoe'];
  const single = await open({ state: solo, path: '/t/Comptoir/secret' });
  await single.tap('quickSongActions', '[data-quick-song="zoe"]');
  await single.type('searchInput', 'Queen');
  await single.runTimers(300);
  await single.tap('catalogContent', '[data-song-index="0"]');
  assert.equal(single.node('appendSong').textContent, 'Ajouter à ma liste');
  await single.click(single.node('appendSong'));
  assert.equal(single.tabShown(), 'table');
  await single.tap('quickSongActions', '[data-quick-song="zoe"]');
  assertQueenKept(single, '« Choisir une chanson »');
  // L'onglet Catalogue (simple visite, pour personne) garde aussi le texte du champ.
  await single.type('searchInput', 'Queen');
  await single.runTimers(300);
  await single.click(single.node('nav-table'));
  await single.click(single.node('nav-catalog'));
  assert.equal(single.node('searchInput').value, 'Queen', 'l’onglet Catalogue retrouve la recherche en cours');
});

test('catalogue : « Réessayer » relance le dernier terme cherché, même champ vidé par « ＋ Chanson »', async () => {
  let failures = 1;
  const page = await open({ respond: url => (url.startsWith('/api/search?') && failures-- > 0 ? reply(502, {}) : undefined) });
  await page.tap('peopleList', '[data-add-song="alice"]');
  await page.type('searchInput', 'Queen');
  await page.runTimers(300);
  assert.equal(page.node('catalogContent').textContent, 'Une erreur est survenue.Réessayer');
  await page.click(page.node('nav-table'));
  await page.tap('peopleList', '[data-add-song="alice"]');
  assert.equal(page.node('searchInput').value, '', 'champ vidé');
  assert.equal(page.node('catalogContent').textContent, 'Une erreur est survenue.Réessayer', 'l’échec reste affiché');
  await page.tap('catalogContent', '[data-retry]');
  assert.deepEqual(searchUrls(page), ['/api/search?q=Queen', '/api/search?q=Queen'], 'le dernier terme cherché, pas le champ vide');
  assertQueenKept(page, '« Réessayer »');
});

test('catalogue : Retour vers les résultats gardés par « ＋ Chanson » ne remplit pas le champ et ne relance pas la recherche', async () => {
  const page = await open();
  await page.tap('peopleList', '[data-add-song="alice"]');
  await page.type('searchInput', 'Queen');
  await page.runTimers(300);
  await page.click(page.node('nav-table'));
  await page.tap('peopleList', '[data-add-song="alice"]');
  assertQueenKept(page, '« ＋ Chanson »');
  assert.equal(page.history.state.catalog, 'search', 'l’étape du catalogue est celle des résultats');
  assert.equal(page.history.state.term, 'Queen');
  const sent = searchUrls(page).length;
  // « Ma table », puis le bouton Retour d'Android : retour sur ces résultats.
  await page.click(page.node('nav-table'));
  page.history.back();
  await page.settle();
  assertQueenKept(page, 'Retour');
  assert.equal(searchUrls(page).length, sent, 'pas de nouvelle recherche');
});

// Lot F : barre de lecture sous le titre sur scène, avancée seule chaque
// seconde (minuteur de 1100 ms) ; rien pour une Battle ou sans durée.
test('barre de lecture sur scène : reste en minutes traduit, pause, Battle et durée inconnue sans barre', async () => {
  const realNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const progress = (fields = {}) => ({ elapsedSec: 102, durationSec: 237, paused: false, rate: 1, ...fields });
    const stage = { ours: false, singer: 'Client', title: 'Manuel', artist: 'X' };
    const page = await open({ state: baseState({ now: now + 3000, stage: { ...stage, progress: progress() } }) });
    const box = page.node('stageProgress');
    const text = () => box.querySelector('.stage-progress-text')?.textContent;
    const width = () => box.querySelector('.stage-progress-fill')?.getAttribute('style');
    assert.equal(box.hidden, false);
    assert.equal(text(), 'reste 2 min');
    assert.equal(width(), 'width:43.0%');
    now += 60_000;
    await page.runTimers(1100);
    assert.equal(text(), 'reste 1 min', 'avance seule entre deux lectures (horloge du serveur 3 s en avance)');
    now += 60_000;
    await page.runTimers(1100);
    assert.equal(text(), 'Bientôt fini', '15 s avant la fin');
    assert.equal(width(), 'width:93.7%');
    now += 60_000;
    await page.runTimers(1100);
    assert.equal(width(), 'width:100.0%', 'jamais au-delà de la durée');
    // Tempo +50 : le reste raccourcit.
    Object.assign(page.state, { now, stage: { ...stage, progress: progress({ elapsedSec: 0, durationSec: 300, rate: 1.5 }) } });
    await page.poll();
    assert.equal(text(), 'reste 3 min');
    Object.assign(page.state, { now, stage: { ...stage, progress: progress({ paused: true }) } });
    await page.poll();
    assert.equal(text(), 'En pause');
    now += 60_000;
    await page.runTimers(1100);
    await page.runTimers(1100);
    assert.equal(text(), 'En pause', 'figée pendant la pause');
    for (const shown of [{ ...stage, progress: progress({ durationSec: null }) }, { ...stage, kind: 'battle', progress: progress() },
      { ...stage, progress: null }, null]) {
      Object.assign(page.state, { now, stage: shown });
      await page.poll();
      assert.equal(box.hidden, true, JSON.stringify(shown));
    }
    // Sans heure du serveur : valeur reçue montrée telle quelle. En anglais.
    const english = await open({ languages: ['en-US'], state: baseState({ stage: { ...stage, progress: progress() } }) });
    now += 600_000;
    await english.runTimers(1100);
    assert.equal(english.node('stageProgress').querySelector('.stage-progress-text').textContent, '2 min left');
  } finally { Date.now = realNow; }
});

// ================================================================ retours du 4 octobre (accès solo, événement privé, tables)
// Regression: retours de la soirée du 4 octobre (docs/designs/retours-soiree-4-octobre.md,
// lots A, B, C et D). Ouvrir un QR individuel n'enregistrait rien (inscription
// au prénom seulement, 30 min après l'émission), la page retirait ensuite la
// clé de l'adresse, et un téléphone de table affichait toute la table.
const soloState = (extra = {}) => baseState({ table: { id: 'Comptoir', name: 'En solo', individual: true, count: 3 },
  tablePeople: [], managedIds: [], soloInvitationReady: true, ...extra });
const soloPage = (search, state, respond, extra = {}) => open({ path: '/t/Comptoir/secret', search, state, respond, ...extra });
const postsTo = (page, route) => page.posts.filter(([url]) => url === route);

test('QR individuel : ouverture comptée par un seul POST, fenêtre de prénom bloquante, adresse gardée', async () => {
  const page = await soloPage('?invitation=CLE-SOLO', soloState(), (url, body, self) => {
    if (url === '/api/table/solo/open') {
      self.state.tablePeople = [person('s1', 'Solo 1', { nameRequired: true })];
      self.state.managedIds = ['s1'];
      return { id: 's1', token: 'jeton-s1', nameRequired: true };
    }
    if (url === '/api/table/person/rename') {
      if (body.name === 'Marie') return reply(400, { error: 'Ce prénom est déjà inscrit à cette table. Utilise la fiche existante ou précise le nom.', code: 'NAME_TAKEN', recoverable: true });
      if (body.name === 'Erreur') return reply(400, { error: 'Prénom limité à 24 caractères.' });
      self.state.tablePeople = [person('s1', body.name)];
      return { ok: true };
    }
    return undefined;
  });
  assert.match(page.stateRequests()[0].url, /invitation=CLE-SOLO/, 'la lecture d’état transmet seulement le QR, sans rien créer');
  assert.deepEqual(postsTo(page, '/api/table/solo/open'), [['/api/table/solo/open', { table: 'Comptoir', access: 'secret', invitation: 'CLE-SOLO' }]]);
  assert.deepEqual(JSON.parse(page.storage.get('kfPeople:Comptoir:secret')), { s1: 'jeton-s1' });
  assert.equal(page.node('nameGate').hidden, false, 'fenêtre de prénom affichée');
  assert.equal(page.node('tabsNav').hidden, true, 'onglets masqués');
  assert.equal(page.node('mainContent').hidden, true, 'reste de la page masqué');
  assert.equal(page.find('nameGate', 'h2').textContent, 'Bienvenue ! Quel est ton prénom ?');
  assert.equal(page.node('nameGate').querySelector('[data-close-sheet]'), null, 'aucune croix');
  assert.equal(page.history.urls.length, 0, 'l’adresse garde ?invitation= : c’est la clé de la soirée');
  await page.poll();
  await page.poll();
  assert.equal(postsTo(page, '/api/table/solo/open').length, 1, 'jamais une deuxième ouverture');

  page.node('nameGateInput').value = '  ';
  await page.submit('nameGateForm');
  assert.equal(page.node('nameGateError').textContent, 'Indique un prénom.');
  assert.equal(page.node('nameGateError').hidden, false);
  page.dispatch(page.body, 'keydown', { key: 'Escape' });
  assert.equal(page.node('nameGate').hidden, false, 'Échap ne ferme pas la fenêtre');

  // Regression: deuxième relecture finale (RT1) — « déjà inscrit » ne parlait
  // que de l'initiale : la personne qui tapait son propre prénom s'inscrivait
  // une deuxième fois au lieu de reprendre son profil par le code.
  page.node('nameGateInput').value = 'Marie';
  await page.submit('nameGateForm');
  assert.equal(page.node('nameGateError').textContent, 'Ce prénom est déjà inscrit. Si c’est toi, touche « Déjà inscrit\u00a0? J’ai un code » ; sinon ajoute l’initiale de ton nom (ex. Marie L.).');
  assert.equal(page.node('nameGate').hidden, false);
  page.node('nameGateInput').value = 'Erreur';
  await page.submit('nameGateForm');
  assert.equal(page.node('nameGateError').textContent, 'Prénom limité à 24 caractères.');

  await page.tap('nameGateLang', '[data-lang="en"]');
  assert.equal(page.find('nameGate', 'h2').textContent, 'Welcome! What’s your first name?');
  assert.equal(page.find('nameGateLang', '[data-lang="en"]').attrs['aria-pressed'], 'true');
  assert.equal(page.node('nameGate').hidden, false, 'la langue change sans fermer la fenêtre');
  await page.tap('nameGateLang', '[data-lang="fr"]');

  page.node('nameGateInput').value = 'Marie L.';
  await page.submit('nameGateForm');
  assert.deepEqual(page.posts.at(-1), ['/api/table/person/rename',
    { table: 'Comptoir', access: 'secret', personId: 's1', name: 'Marie L.', token: 'jeton-s1' }]);
  assert.equal(page.node('nameGate').hidden, true);
  assert.equal(page.node('nameGateError').hidden, true);
  assert.equal(page.node('tabsNav').hidden, false);
  assert.equal(page.node('mainContent').hidden, false);
  assert.equal(page.toast().text, 'Marie L. est inscrit.');
  assert.equal(page.history.urls.length, 0, 'la clé reste dans l’adresse après le prénom');

  // Fenêtre ouverte au moment où la personne doit donner son prénom : elle se referme.
  const sheet = await soloPage('', soloState({ tablePeople: [person('s1', 'Léa')], managedIds: ['s1'] }));
  await sheet.tap('peopleList', '[data-rename-person="s1"]');
  assert.equal(sheet.sheetOpen(), true);
  sheet.state.tablePeople = [person('s1', 'Solo 1', { nameRequired: true })];
  await sheet.poll();
  assert.equal(sheet.sheetOpen(), false);
  assert.equal(sheet.node('nameGate').hidden, false);
  assert.equal(sheet.posts.length, 0, 'téléphone qui gère déjà sa personne : aucune ouverture');
});

test('QR individuel rouvert ailleurs : « C’est bien toi ? », récupération par la clé ; erreurs sans nouvel essai', async () => {
  let refuse = true;
  const page = await soloPage('?invitation=CLE-SOLO', soloState({ soloInvitationReady: false }), (url, body, self) => {
    if (url === '/api/table/solo/open') return { recover: { id: 'm1', name: 'Marie' } };
    if (url === '/api/table/person/claim') {
      if (refuse) { refuse = false; return reply(400, { error: 'Ce QR personnel n’est plus valable. Demande au bar un QR de reprise.' }); }
      self.state.tablePeople = [person('m1', 'Marie')];
      self.state.managedIds = ['m1'];
      return { id: 'm1', token: 'jeton-m1' };
    }
    return undefined;
  });
  assert.equal(page.node('transferBox').hidden, false);
  assert.equal(page.node('transferHeading').textContent, 'C’est bien toi, Marie ?');
  assert.match(page.node('transferText').textContent, /ce téléphone/);
  assert.equal(page.node('noSingerBox').hidden, true, 'pas de message « invitation utilisée »');
  assert.match(page.node('catalogAccessText').textContent, /Marie/);
  assert.ok(page.find('catalogAccessActions', '[data-key-claim]'), 'la récupération aussi depuis le catalogue');
  await page.tap('transferActions', '[data-key-claim]');
  assert.deepEqual(page.posts.at(-1), ['/api/table/person/claim', { table: 'Comptoir', access: 'secret', key: 'CLE-SOLO' }]);
  assert.deepEqual(page.toast(), { text: 'Ce QR personnel n’est plus valable. Demande au bar un QR de reprise.', bad: true, warn: false, hidden: false });
  assert.equal(page.node('transferBox').hidden, false, 'la carte reste après un refus');
  await page.tap('transferActions', '[data-key-claim]');
  assert.deepEqual(JSON.parse(page.storage.get('kfPeople:Comptoir:secret')), { m1: 'jeton-m1' });
  assert.equal(page.node('transferBox').hidden, true);
  assert.equal(page.toast().text, 'Tu gères maintenant Marie sur ce téléphone.');
  assert.equal(page.history.urls.length, 0, 'la clé reste dans l’adresse après la récupération');
  assert.equal(postsTo(page, '/api/table/solo/open').length, 1);
  const english = await soloPage('?invitation=CLE-SOLO', soloState({ soloInvitationReady: false }),
    url => url === '/api/table/solo/open' ? { recover: { id: 'm1', name: 'Marie' } } : undefined, { languages: ['en'] });
  assert.equal(english.node('transferHeading').textContent, 'Is that you, Marie?');
  assert.equal(english.find('transferActions', '[data-key-claim]').textContent, 'Recover my songs');

  const used = await soloPage('?invitation=VIEUX', soloState({ soloInvitationReady: false }), url => url === '/api/table/solo/open'
    ? reply(403, { error: 'Cette invitation a déjà été utilisée ou a expiré. Demande un nouveau QR individuel au bar.', code: 'SOLO_INVITATION' }) : undefined);
  assert.equal(used.node('noSingerBox').hidden, false);
  assert.equal(used.node('noSingerText').textContent, 'Cette invitation a déjà été utilisée ou a expiré. Demande un nouveau QR individuel au bar.');
  assert.equal(used.node('fatalBox').hidden, true, 'un refus de l’invitation n’est pas un lien de table invalide');
  await used.poll();
  assert.equal(postsTo(used, '/api/table/solo/open').length, 1, 'refus du serveur : pas de nouvel essai');

  let offline = true;
  const network = await soloPage('?invitation=CLE-SOLO', soloState(), (url, body, self) => {
    if (url !== '/api/table/solo/open') return undefined;
    if (offline) { offline = false; return new Error('réseau coupé'); }
    self.state.tablePeople = [person('s1', 'Solo 1', { nameRequired: true })];
    self.state.managedIds = ['s1'];
    return { id: 's1', token: 'jeton-s1', nameRequired: true };
  });
  assert.equal(network.node('noSingerText').textContent, 'Un instant : ouverture de ton QR…');
  await network.poll();
  assert.equal(postsTo(network, '/api/table/solo/open').length, 2, 'réseau coupé : nouvel essai au rafraîchissement suivant');
  assert.equal(network.node('nameGate').hidden, false);

  const bare = await soloPage('', soloState({ soloInvitationReady: false }));
  assert.equal(bare.posts.length, 0, 'lien commun : rien à ouvrir');
  assert.match(bare.node('noSingerText').textContent, /^Pour t’inscrire, demande au bar un QR individuel\./);
});

test('événement privé : un seul POST d’entrée, paramètre retiré de l’adresse, QR inactif ou complet signalé', async () => {
  const page = await soloPage('?evenement=SECRET-EV&utm=x', soloState({ soloInvitationReady: false, privateEventReady: true }), (url, body, self) => {
    if (url === '/api/table/enter') {
      self.state.tablePeople = [person('s2', 'Solo 2', { nameRequired: true })];
      self.state.managedIds = ['s2'];
      return { id: 's2', token: 'jeton-s2', nameRequired: true };
    }
    return undefined;
  });
  assert.match(page.stateRequests()[0].url, /evenement=SECRET-EV/);
  assert.deepEqual(postsTo(page, '/api/table/enter'), [['/api/table/enter', { table: 'Comptoir', access: 'secret', event: 'SECRET-EV' }]]);
  assert.equal(page.history.urls.at(-1), '/t/Comptoir/secret?utm=x');
  assert.doesNotMatch(page.stateRequests().at(-1).url, /evenement/);
  assert.equal(page.node('nameGate').hidden, false, 'le prénom est demandé tout de suite');
  await page.poll();
  assert.equal(postsTo(page, '/api/table/enter').length, 1);

  // QR coupé ou renouvelé : la page demande quand même (un inscrit de ce
  // navigateur y retrouve sa place) ; le refus dit « QR plus actif ».
  const inactive = await soloPage('?evenement=VIEUX', soloState({ soloInvitationReady: false, privateEventReady: false }), url => url === '/api/table/enter'
    ? reply(403, { error: 'Ce QR d’événement n’est plus actif. Demande au bar.', code: 'PRIVATE_EVENT' }) : undefined);
  assert.equal(postsTo(inactive, '/api/table/enter').length, 1);
  assert.equal(inactive.node('noSingerText').textContent, 'Ce QR d’événement n’est plus actif. Demande au bar.');

  const mine = await soloPage('?evenement=SECRET-EV', soloState({ privateEventReady: true, tablePeople: [person('s2', 'Léa')], managedIds: ['s2'] }));
  assert.equal(mine.posts.length, 0, 'son chanteur est déjà sur ce téléphone');
  assert.equal(mine.history.urls.at(-1), '/t/Comptoir/secret');

  const busy = await soloPage('?evenement=SECRET-EV', soloState({ soloInvitationReady: false, privateEventReady: true }), url => url === '/api/table/enter'
    ? reply(429, { error: 'Trop d’inscriptions d’un coup : réessaie dans une minute.', code: 'PRIVATE_EVENT_BUSY' }) : undefined, { languages: ['en'] });
  assert.equal(busy.node('noSingerText').textContent, 'Lots of people arriving at once: trying again in a moment…');
});

// Regression: deuxième relecture finale (vérification E1(d)) — la place sans
// prénom ouverte par le QR de l'événement, retirée par « Renouveler le QR »,
// laissait sa page (et son rechargement) dire « demande au bar un QR
// individuel » : l'adresse avait déjà perdu ?evenement=.
// Regression: vérification de la troisième relecture — retirée aussi par
// « Parti » du bar, la page disait « QR plus actif » alors que rescanner le
// QR de l'événement donne une nouvelle place. La page ne distingue pas les
// deux cas : elle dit de rescanner (un QR renouvelé refusera, « QR plus actif »).
test('événement privé : place sans prénom retirée (« Parti » du bar ou QR renouvelé) = rescanner le QR, même après rechargement', async () => {
  const session = sessionMap();
  const page = await soloPage('?evenement=SECRET-EV', soloState({ soloInvitationReady: false, privateEventReady: true }), (url, body, self) => {
    if (url !== '/api/table/enter') return undefined;
    self.state.tablePeople = [person('s2', 'Solo 2', { nameRequired: true })];
    self.state.managedIds = ['s2'];
    return { id: 's2', token: 'jeton-s2', nameRequired: true };
  }, { session });
  assert.equal(page.node('nameGate').hidden, false);
  assert.equal(page.history.urls.at(-1), '/t/Comptoir/secret');
  // Le bar touche « Parti » sur « Solo 2 » (ou renouvelle le QR) : la place part sans trace.
  page.state.tablePeople = [];
  page.state.managedIds = [];
  page.state.privateEventReady = false;
  await page.poll();
  assert.equal(page.node('nameGate').hidden, true);
  assert.equal(page.node('noSingerText').textContent, 'Ta place sans prénom a été retirée. Rescanne le QR de l’événement pour en avoir une nouvelle, ou demande au bar.');
  const reloaded = await soloPage('', page.state, undefined, { session, languages: ['en'] });
  assert.equal(reloaded.posts.length, 0);
  assert.equal(reloaded.node('noSingerText').textContent, 'Your spot without a name was removed. Scan the event QR code again to get a new one, or ask the bar.');

  // Place nommée puis passée sur un autre téléphone : pas un QR inactif.
  const named = sessionMap();
  const moved = await soloPage('?evenement=SECRET-EV', soloState({ soloInvitationReady: false, privateEventReady: true }), (url, body, self) => {
    if (url !== '/api/table/enter') return undefined;
    self.state.tablePeople = [person('s3', 'Léa')];
    self.state.managedIds = ['s3'];
    return { id: 's3', token: 'jeton-s3', nameRequired: true };
  }, { session: named });
  await moved.poll();
  moved.state.managedIds = [];
  await moved.poll();
  assert.match(moved.node('noSingerText').textContent, /^Pour t’inscrire, demande au bar un QR individuel\./);
});

// Regression: relecture finale (ADV1) — refusée parce que beaucoup d'invités
// arrivaient dans la même minute, la page restait en échec sans jamais
// réessayer ; le plafond de l'événement, lui, ne doit pas boucler.
const retryDelay = page => [...page.timers.values()].map(timer => timer.ms).find(ms => ms >= 15000 && ms <= 20000);
const eventBusy = () => reply(429, { error: 'Trop d’inscriptions d’un coup : réessaie dans une minute.', code: 'PRIVATE_EVENT_BUSY' });
test('événement privé : arrivées nombreuses = nouvel essai automatique, puis prénom', async () => {
  let busyLeft = 2;
  const page = await soloPage('?evenement=SECRET-EV', soloState({ soloInvitationReady: false, privateEventReady: true }), (url, body, self) => {
    if (url !== '/api/table/enter') return undefined;
    if (busyLeft-- > 0) return eventBusy();
    self.state.tablePeople = [person('s3', 'Solo 3', { nameRequired: true })];
    self.state.managedIds = ['s3'];
    return { id: 's3', token: 'jeton-s3', nameRequired: true };
  });
  assert.equal(page.node('noSingerText').textContent, 'Beaucoup d’arrivées en même temps : nouvel essai dans un instant…');
  assert.equal(page.node('noSingerTitle').textContent, 'Inscription en cours…');
  assert.equal(page.node('nameGate').hidden, true);
  await page.poll();
  assert.equal(postsTo(page, '/api/table/enter').length, 1, 'le rafraîchissement régulier ne relance pas tout de suite');
  assert.ok(retryDelay(page), 'nouvel essai prévu dans 15 à 20 s');
  await page.runTimers(retryDelay(page));
  assert.equal(postsTo(page, '/api/table/enter').length, 2);
  assert.equal(page.node('noSingerText').textContent, 'Beaucoup d’arrivées en même temps : nouvel essai dans un instant…');
  await page.runTimers(retryDelay(page));
  assert.equal(postsTo(page, '/api/table/enter').length, 3);
  assert.equal(page.node('nameGate').hidden, false, 'inscrite : le prénom est demandé');
  assert.equal(retryDelay(page), undefined, 'plus aucun essai prévu après le succès');
  await page.poll();
  assert.equal(postsTo(page, '/api/table/enter').length, 3);
});

// Regression: deuxième relecture finale (A2-2, D2-4) — quatre essais en une
// minute à peine puis un échec définitif, sans bouton pour réessayer ; le
// délai annoncé par le serveur (Retry-After) était ignoré.
test('événement privé : nouveaux essais pendant 5 minutes environ, puis « Réessayer » ; titre « Inscription en cours… »', async () => {
  const page = await soloPage('?evenement=SECRET-EV', soloState({ soloInvitationReady: false, privateEventReady: true }),
    url => url === '/api/table/enter' ? eventBusy() : undefined);
  assert.equal(page.node('noSingerTitle').textContent, 'Inscription en cours…');
  assert.equal(page.node('noSingerText').textContent, 'Beaucoup d’arrivées en même temps : nouvel essai dans un instant…');
  let waited = 0;
  for (let i = 0; i < 40 && retryDelay(page); i++) { waited += retryDelay(page); await page.runTimers(retryDelay(page)); }
  const tries = postsTo(page, '/api/table/enter').length;
  assert.ok(tries >= 15 && tries <= 21, `essais pendant environ 5 minutes : ${tries}`);
  assert.ok(waited <= 5 * 60000 && waited > 4 * 60000, `attente totale : ${waited} ms`);
  assert.equal(retryDelay(page), undefined, 'puis plus rien d’automatique');
  assert.equal(page.node('noSingerText').textContent, 'Trop d’inscriptions d’un coup : réessaie dans une minute.');
  assert.equal(page.node('noSingerTitle').textContent, 'Pour ajouter une chanson');
  const again = page.find('noSingerActions', '[data-entry-retry]');
  assert.equal(again.textContent, 'Réessayer');
  await page.poll();
  assert.equal(postsTo(page, '/api/table/enter').length, tries, 'le rafraîchissement ne relance pas');
  // « Réessayer » : un essai tout de suite, puis de nouveau les essais automatiques.
  await page.tap('noSingerActions', '[data-entry-retry]');
  assert.equal(postsTo(page, '/api/table/enter').length, tries + 1);
  assert.equal(page.node('noSingerTitle').textContent, 'Inscription en cours…');
  assert.ok(retryDelay(page), 'nouvelle série d’essais');
});

test('événement privé : le délai Retry-After du serveur est suivi', async () => {
  let busyLeft = 1;
  const page = await soloPage('?evenement=SECRET-EV', soloState({ soloInvitationReady: false, privateEventReady: true }), (url, body, self) => {
    if (url !== '/api/table/enter') return undefined;
    if (busyLeft-- > 0) return reply(429, { error: 'Trop d’inscriptions d’un coup : réessaie dans une minute.', code: 'PRIVATE_EVENT_BUSY' }, { 'Retry-After': '7' });
    self.state.tablePeople = [person('s4', 'Solo 4', { nameRequired: true })];
    self.state.managedIds = ['s4'];
    return { id: 's4', token: 'jeton-s4', nameRequired: true };
  });
  const delays = [...page.timers.values()].map(timer => timer.ms).filter(ms => ms >= 7000 && ms < 10000);
  assert.equal(delays.length, 1, `un essai prévu après 7 s (plus un écart de moins de 3 s) : ${[...page.timers.values()].map(timer => timer.ms)}`);
  assert.equal(retryDelay(page), undefined, 'pas le délai par défaut');
  await page.runTimers(delays[0]);
  assert.equal(postsTo(page, '/api/table/enter').length, 2);
  assert.equal(page.node('nameGate').hidden, false, 'inscrite : le prénom est demandé');
});

test('événement privé en anglais : titre, attente et « Try again » ; plafond atteint = message, sans essai automatique', async () => {
  const page = await soloPage('?evenement=SECRET-EV', soloState({ soloInvitationReady: false, privateEventReady: true }),
    url => url === '/api/table/enter' ? eventBusy() : undefined, { languages: ['en'] });
  assert.equal(page.node('noSingerTitle').textContent, 'Signing you up…');
  assert.equal(page.node('noSingerText').textContent, 'Lots of people arriving at once: trying again in a moment…');
  for (let i = 0; i < 40 && retryDelay(page); i++) await page.runTimers(retryDelay(page));
  assert.equal(page.node('noSingerText').textContent, 'Too many sign-ups at once: try again in a minute.');
  assert.equal(page.node('noSingerTitle').textContent, 'To add a song');
  assert.equal(page.find('noSingerActions', '[data-entry-retry]').textContent, 'Try again');

  for (const languages of [['fr'], ['en']]) {
    const full = await soloPage('?evenement=SECRET-EV', soloState({ soloInvitationReady: false, privateEventReady: true }), url => url === '/api/table/enter'
      ? reply(403, { error: 'L’événement est complet par ce QR : demande au bar un QR individuel.', code: 'PRIVATE_EVENT_FULL' }) : undefined, { languages });
    assert.equal(full.node('noSingerText').textContent, languages[0] === 'fr'
      ? 'L’événement est complet par ce QR : demande au bar un QR individuel.'
      : 'This event is full through this QR code: ask the bar for a personal QR code.');
    assert.equal(retryDelay(full), undefined, 'plafond atteint : pas de nouvel essai');
    assert.equal([...full.timers.values()].filter(timer => timer.ms > 1000).length, 0, 'aucun essai prévu');
    assert.equal(full.node('nameGate').hidden, true);
    assert.equal(full.node('fatalBox').hidden, true, 'un refus de l’inscription n’est pas un lien invalide');
    await full.poll();
    assert.equal(postsTo(full, '/api/table/enter').length, 1);
    assert.equal(full.find('noSingerActions', '[data-entry-retry]').textContent, languages[0] === 'fr' ? 'Réessayer' : 'Try again',
      'essai à la main seulement');
  }
});

// Regression: relecture finale (ADV3) — sur un navigateur qui venait de
// rescanner le QR de l'événement (« Solo N » sans prénom), la fenêtre de
// prénom cachait le lien de transfert et la clé personnelle.
test('rescan : le lien de transfert et la clé personnelle passent avant la fenêtre de prénom', async () => {
  const placeholder = () => soloState({ soloInvitationReady: false, tablePeople: [person('s9', 'Solo 9', { nameRequired: true })], managedIds: ['s9'] });
  const withOffer = (offer, extra) => (url, body, self) => {
    if (url.startsWith('/api/state?')) {
      const data = JSON.parse(JSON.stringify(self.state));
      if (new URLSearchParams(url.split('?')[1]).get('reprise')) data.transferOffer = offer;
      return data;
    }
    return extra?.(url, body, self);
  };
  // « Solo 9 » ouvert dans cet onglet par le QR de l'événement.
  const session = sessionMap({ 'kfEventPlace:Comptoir:secret': 's9' });
  const page = await soloPage('?reprise=LIEN-TEST', placeholder(), withOffer({ personId: 'lea', name: 'Léa' }, (url, body, self) => {
    if (url !== '/api/table/person/claim') return undefined;
    self.state.tablePeople = [person('lea', 'Léa')];
    self.state.managedIds = ['lea'];
    return { id: 'lea', token: 'jeton-lea' };
  }), { session });
  assert.equal(page.node('nameGate').hidden, true, 'la reprise passe avant le prénom');
  assert.equal(page.node('mainContent').hidden, false);
  assert.equal(page.node('transferBox').hidden, false);
  assert.equal(page.node('transferHeading').textContent, 'Récupérer tes chansons sur ce téléphone');
  await page.tap('transferActions', '[data-transfer-claim]');
  assert.deepEqual(page.posts.at(-1), ['/api/table/person/claim', { table: 'Comptoir', access: 'secret', link: 'LIEN-TEST' }]);
  assert.equal(page.node('nameGate').hidden, true);
  assert.equal(page.toast().text, 'Tu gères maintenant Léa sur ce téléphone.');
  // Regression: deuxième relecture finale — la place « Solo 9 » retirée par la
  // reprise restait notée : Léa partie plus tard sur un autre téléphone, cet
  // onglet disait « QR d’événement plus actif » alors qu'il l'est toujours.
  assert.equal(session.getItem('kfEventPlace:Comptoir:secret'), '', 'reprise par lien : la place « Solo 9 » oubliée');
  page.state.tablePeople = [person('lea', 'Léa')];
  page.state.managedIds = [];
  await page.poll();
  assert.equal(page.node('noSingerBox').hidden, false);
  assert.doesNotMatch(page.node('noSingerText').textContent, /plus actif/, 'Léa reprise ailleurs : pas « QR plus actif »');

  // « Pas maintenant » : la fenêtre de prénom revient.
  const later = await soloPage('?reprise=LIEN-TEST', placeholder(), withOffer({ personId: 'lea', name: 'Léa' }));
  await later.tap('transferActions', '[data-transfer-dismiss]');
  assert.equal(later.node('nameGate').hidden, false);
  // Lien expiré : rien à reprendre, le prénom reste demandé.
  const expired = await soloPage('?reprise=LIEN-TEST', placeholder(), withOffer({ invalid: true }));
  assert.equal(expired.node('nameGate').hidden, false);

  // Clé personnelle d'une autre personne : « C'est bien toi ? » avant le prénom.
  const keySession = sessionMap({ 'kfEventPlace:Comptoir:secret': 's9' });
  const key = await soloPage('?invitation=CLE-CLARA', placeholder(), (url, body, self) => {
    if (url === '/api/table/solo/open') return { recover: { id: 'c1', name: 'Clara' } };
    if (url !== '/api/table/person/claim') return undefined;
    self.state.tablePeople = [person('c1', 'Clara')];
    self.state.managedIds = ['c1'];
    return { id: 'c1', token: 'jeton-c1' };
  }, { languages: ['en'], session: keySession });
  assert.deepEqual(postsTo(key, '/api/table/solo/open'), [['/api/table/solo/open', { table: 'Comptoir', access: 'secret', invitation: 'CLE-CLARA' }]]);
  assert.equal(key.node('nameGate').hidden, true);
  assert.equal(key.node('transferHeading').textContent, 'Is that you, Clara?');
  await key.tap('transferActions', '[data-key-claim]');
  assert.deepEqual(key.posts.at(-1), ['/api/table/person/claim', { table: 'Comptoir', access: 'secret', key: 'CLE-CLARA' }]);
  assert.equal(key.node('nameGate').hidden, true);
  assert.equal(keySession.getItem('kfEventPlace:Comptoir:secret'), '', 'reprise par la clé personnelle : la place « Solo 9 » oubliée');
  // Un prénom déjà donné sur ce téléphone : la clé n'est pas rouverte (inchangé).
  const named = await soloPage('?invitation=CLE-CLARA', soloState({ soloInvitationReady: false, tablePeople: [person('s9', 'Marie')], managedIds: ['s9'] }));
  assert.equal(postsTo(named, '/api/table/solo/open').length, 0);
});

test('activité : en-tête x-page-visible « 1 » page visible, « 0 » cachée ; la page cachée continue d’interroger', async () => {
  const page = await open({ hidden: true });
  assert.equal(page.stateRequests()[0].headers['x-page-visible'], '0', 'page cachée : « 0 » (sans en-tête, le serveur compte une page d’avant la mise à jour)');
  await page.poll();
  assert.equal(page.stateRequests().length, 2, 'la lecture continue en arrière-plan');
  assert.equal(page.stateRequests().at(-1).headers['x-page-visible'], '0', 'page cachée : pas une activité');
  page.document.hidden = false;
  page.document.listeners.visibilitychange.forEach(entry => entry.listener());
  await page.settle();
  assert.equal(page.stateRequests().at(-1).headers['x-page-visible'], '1', 'page revenue : activité notée tout de suite');
  const visible = await open();
  assert.equal(visible.stateRequests()[0].headers['x-page-visible'], '1');
});

test('doublon marqué parti sur ce navigateur : son QR personnel propose encore « C’est bien toi ? »', async () => {
  // Regression: la page ne demandait rien tant qu'elle « gérait » une personne,
  // même partie : le QR personnel ne pouvait plus reprendre l'ancien profil.
  const gone = soloState({ soloInvitationReady: false, tablePeople: [person('d1', 'Clara B.', { active: false })], managedIds: ['d1'] });
  const page = await soloPage('?invitation=CLE-SOLO', gone,
    url => url === '/api/table/solo/open' ? { recover: { id: 'c1', name: 'Clara' } } : undefined);
  assert.deepEqual(postsTo(page, '/api/table/solo/open'), [['/api/table/solo/open', { table: 'Comptoir', access: 'secret', invitation: 'CLE-SOLO' }]]);
  assert.equal(page.node('transferHeading').textContent, 'C’est bien toi, Clara ?');
  // Sa propre personne marquée partie : le serveur le dit, la page l'affiche.
  const left = await soloPage('?invitation=CLE-SOLO', gone, url => url === '/api/table/solo/open'
    ? reply(403, { error: 'Cette personne a été marquée partie. Demande au bar de la réactiver.', code: 'PERSON_LEFT' }) : undefined, { languages: ['en'] });
  assert.equal(left.node('noSingerText').textContent, 'This person was marked as gone. Ask the bar to bring them back.');
  // Une personne présente sur ce téléphone : rien n'est demandé (inchangé).
  const active = await soloPage('?invitation=CLE-SOLO', soloState({ soloInvitationReady: false, tablePeople: [person('d1', 'Clara B.')], managedIds: ['d1'] }));
  assert.equal(postsTo(active, '/api/table/solo/open').length, 0);
});

// Regression: troisième relecture finale (RT1) — le QR de l'événement rescanné
// par une personne marquée partie comptait sa fiche partie comme « son
// chanteur est déjà là » : ?evenement= retiré sans demande au serveur, et la
// page disait « demande au bar un QR individuel » au lieu de « marquée partie ».
test('personne marquée partie : le QR de l’événement rescanné dit « demande au bar de te réactiver » (FR/EN)', async () => {
  const gone = () => soloState({ soloInvitationReady: false, privateEventReady: true,
    tablePeople: [person('d1', 'Clara B.', { viaEvent: true, active: false })], managedIds: ['d1'] });
  const left = () => reply(403, { error: 'Cette personne a été marquée partie. Demande au bar de la réactiver.', code: 'PERSON_LEFT' });
  for (const [languages, text] of [[undefined, 'Cette personne a été marquée partie. Demande au bar de la réactiver.'],
    [['en'], 'This person was marked as gone. Ask the bar to bring them back.']]) {
    const event = await soloPage('?evenement=SECRET-EV', gone(), url => url === '/api/table/enter' ? left() : undefined, { languages });
    assert.deepEqual(postsTo(event, '/api/table/enter'), [['/api/table/enter', { table: 'Comptoir', access: 'secret', event: 'SECRET-EV' }]]);
    assert.equal(event.node('noSingerText').textContent, text);
    assert.equal(event.node('catalogAccessText').textContent, text);
    // Rechargée sans ?evenement= (lien commun) : le même avis, jamais « QR individuel ».
    const bare = await soloPage('', gone(), undefined, { languages });
    assert.equal(bare.posts.length, 0);
    assert.equal(bare.node('noSingerText').textContent, text);
  }
  // Une place active sur ce téléphone : rien n'est demandé (inchangé).
  const mine = await soloPage('?evenement=SECRET-EV', soloState({ privateEventReady: true,
    tablePeople: [person('d1', 'Clara B.', { active: false }), person('s2', 'Léa')], managedIds: ['d1', 's2'] }));
  assert.equal(postsTo(mine, '/api/table/enter').length, 0);
});

test('navigateur intégré (Instagram, WebView…) : conseil d’ouvrir la page dans son navigateur, en solo seulement', async () => {
  const solo = soloState({ tablePeople: [person('m1', 'Marie')], managedIds: ['m1'] });
  // Son adresse garde sa clé personnelle : Safari ou Chrome la retrouvent.
  const insta = await soloPage('?invitation=CLE', solo, undefined, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Instagram 300.0' });
  assert.equal(insta.node('inAppHint').hidden, false);
  assert.equal(insta.node('inAppHint').textContent, 'Pour retrouver cette page plus tard, ouvre-la dans ton navigateur : menu ⋯ → « Ouvrir dans le navigateur » (Safari ou Chrome).');
  const webview = await soloPage('', solo, undefined, { userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A; wv) AppleWebKit/537.36' });
  assert.equal(webview.node('inAppHint').hidden, false);
  const safari = await soloPage('', solo, undefined, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile/15E148 Safari/604.1' });
  assert.equal(safari.node('inAppHint').hidden, true);
  const table = await open({ userAgent: 'Mozilla/5.0 (iPhone) Instagram 300.0' });
  assert.equal(table.node('inAppHint').hidden, true, 'téléphone de table : rien');
  const unknown = await soloPage('', solo);
  assert.equal(unknown.node('inAppHint').hidden, true, 'navigateur sans identification');
});

test('navigateur intégré, événement privé : le bandeau dit de rescanner le QR de l’événement depuis la même application', async () => {
  // Après l'inscription, l'adresse perd ?evenement= : l'ouvrir dans Safari ou
  // Chrome mène au lien commun, et un autre navigateur crée un deuxième
  // chanteur (décision D1). Seul un nouveau scan dans la même application
  // ramène la même personne.
  const insta = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Instagram 300.0';
  const event = soloState({ tablePeople: [person('e1', 'Léa', { viaEvent: true })], managedIds: ['e1'] });
  const fr = await soloPage('', event, undefined, { userAgent: insta });
  assert.equal(fr.node('inAppHint').hidden, false);
  assert.equal(fr.node('inAppHint').textContent, 'Pour retrouver cette page, rescanne le QR de l’événement depuis la même application.');
  const en = await soloPage('', event, undefined, { userAgent: insta, languages: ['en'] });
  assert.equal(en.node('inAppHint').textContent, 'To get back to this page, scan the event QR code again from the same app.');
  // Changement de langue sur la page : le bandeau suit.
  await en.tap('langSwitch', '[data-lang="fr"]');
  assert.equal(en.node('inAppHint').textContent, 'Pour retrouver cette page, rescanne le QR de l’événement depuis la même application.');

  // QR individuel : son adresse garde la clé, l'ouvrir dans Safari ou Chrome marche.
  const personal = await soloPage('?invitation=CLE', soloState({ tablePeople: [person('p1', 'Marie')], managedIds: ['p1'] }), undefined,
    { userAgent: insta, languages: ['en'] });
  assert.equal(personal.node('inAppHint').hidden, false);
  assert.equal(personal.node('inAppHint').textContent, 'To find this page again later, open it in your browser: menu ⋯ → “Open in browser” (Safari or Chrome).');
  await personal.tap('langSwitch', '[data-lang="fr"]');
  assert.equal(personal.node('inAppHint').textContent, 'Pour retrouver cette page plus tard, ouvre-la dans ton navigateur : menu ⋯ → « Ouvrir dans le navigateur » (Safari ou Chrome).');

  // Prénom encore à saisir : la fenêtre de prénom couvre la page, rien ne change.
  const gate = await soloPage('', soloState({ tablePeople: [person('e2', 'Solo 2', { viaEvent: true, nameRequired: true })], managedIds: ['e2'] }),
    undefined, { userAgent: insta });
  assert.equal(gate.node('nameGate').hidden, false);
  assert.equal(gate.node('mainContent').hidden, true, 'bandeau caché sous la fenêtre de prénom');

  const table = await open({ state: baseState({ tablePeople: [person('alice', 'Alice', { viaEvent: true })], managedIds: ['alice'] }),
    userAgent: insta });
  assert.equal(table.node('inAppHint').hidden, true, 'téléphone de table : rien');
});

test('navigateur intégré : le bandeau suit ce qui ramène vraiment la page (personne partie, profil repris)', async () => {
  const insta = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Instagram 300.0';
  // Regression: une personne venue par l'événement puis marquée partie
  // retrouvait le conseil Safari/Chrome, qui mène au lien commun.
  const gone = soloState({ tablePeople: [person('e1', 'Léa', { viaEvent: true, active: false })], managedIds: ['e1'] });
  for (const [languages, text] of [[undefined, 'Pour retrouver cette page, rescanne le QR de l’événement depuis la même application.'],
    [['en'], 'To get back to this page, scan the event QR code again from the same app.']]) {
    const page = await soloPage('', gone, undefined, { userAgent: insta, languages });
    assert.equal(page.node('inAppHint').hidden, false);
    assert.equal(page.node('inAppHint').textContent, text);
  }
  // Regression: un soliste repris par code ou QR de reprise n'a plus sa clé
  // dans l'adresse ; Safari ou Chrome mènerait au lien commun.
  const recovered = soloState({ tablePeople: [person('p1', 'Marie')], managedIds: ['p1'] });
  const fr = await soloPage('', recovered, undefined, { userAgent: insta });
  assert.equal(fr.node('inAppHint').textContent, 'Pour retrouver cette page, rescanne le même QR depuis la même application, ou demande au bar un QR de reprise.');
  const en = await soloPage('', recovered, undefined, { userAgent: insta, languages: ['en'] });
  assert.equal(en.node('inAppHint').textContent, 'To get back to this page, scan the same QR code again from the same app, or ask the bar for a recovery QR code.');
  // Personne sur ce téléphone (lien commun) : conseil inchangé.
  const nobody = await soloPage('', soloState(), undefined, { userAgent: insta });
  assert.equal(nobody.node('inAppHint').textContent, 'Pour retrouver cette page plus tard, ouvre-la dans ton navigateur : menu ⋯ → « Ouvrir dans le navigateur » (Safari ou Chrome).');
});

test('QR refusé : le message du serveur suit le changement de langue', async () => {
  // Regression: la page gardait le message dans la langue de l'ouverture
  // (« To add a song Cette personne a été marquée partie… »).
  const gone = soloState({ soloInvitationReady: false, tablePeople: [person('d1', 'Clara', { active: false })], managedIds: ['d1'] });
  const left = () => reply(403, { error: 'Cette personne a été marquée partie. Demande au bar de la réactiver.', code: 'PERSON_LEFT' });
  const fr = await soloPage('?invitation=CLE-SOLO', gone, url => url === '/api/table/solo/open' ? left() : undefined);
  assert.equal(fr.node('noSingerText').textContent, 'Cette personne a été marquée partie. Demande au bar de la réactiver.');
  await fr.tap('langSwitch', '[data-lang="en"]');
  assert.equal(fr.node('noSingerText').textContent, 'This person was marked as gone. Ask the bar to bring them back.');
  const en = await soloPage('?invitation=CLE-SOLO', gone, url => url === '/api/table/solo/open' ? left() : undefined, { languages: ['en'] });
  assert.equal(en.node('noSingerText').textContent, 'This person was marked as gone. Ask the bar to bring them back.');
  await en.tap('langSwitch', '[data-lang="fr"]');
  assert.equal(en.node('noSingerText').textContent, 'Cette personne a été marquée partie. Demande au bar de la réactiver.');
});

test('table : la page ne montre que les personnes du téléphone, « Voir toute la table (N) » liste tout le monde', async () => {
  const state = baseState();
  state.tablePeople.push(person('bob', 'Bob', { songs: [{ entryId: 'b1', title: 'Rock' }], inKaraFun: [{ title: 'Pop' }] }),
    person('dan', 'Dan', { active: false }));
  const page = await open({ state });
  assert.ok(page.find('peopleList', '[data-person-card="alice"]'));
  assert.equal(page.node('peopleList').querySelector('[data-person-card="bob"]'), null, 'Bob est géré par un autre téléphone');
  assert.equal(page.node('peopleHeading').textContent, 'Mes chanteurs');
  assert.equal(page.find('peopleList', '[data-person-card="alice"]').querySelector('.person-state').textContent, 'Chansons choisies');
  assert.equal(page.node('claimBox').hidden, true, 'plus de « Je suis… » sur la page principale');
  assert.equal(page.node('tableAllButton').hidden, false);
  assert.equal(page.node('tableAllButton').textContent, 'Voir toute la table (3)');
  // D15-B : la carte ne liste que ce téléphone ; l'effectif de toute la table
  // est à côté de « Voir toute la table », jamais dans l'en-tête de la carte.
  assert.equal(page.node('peopleIntro').textContent, 'Les personnes inscrites avec ce téléphone. Pour voir toute la table : « Voir toute la table ».');
  assert.equal(page.node('peopleCount').textContent, '1 présente · 3 inscrites à la table');
  assert.equal(page.node('tableAllRow').hidden, false);
  const cardSource = /<div class="card" id="peopleCard">([\s\S]*?)<\/div>\s*<div class="card" id="addPersonBox">/.exec(fs.readFileSync(path.join(__dirname, '..', 'public', 'client.html'), 'utf8'))[1];
  assert.doesNotMatch(/<div class="table-head">[\s\S]*?<ul id="peopleList"/.exec(cardSource)[0], /peopleCount/, 'pas d’effectif de la table dans l’en-tête');
  assert.match(cardSource, /<div class="table-all-row" id="tableAllRow">\s*<button[^>]*id="tableAllButton"[^>]*><\/button>\s*<span id="peopleCount"/,
    'l’effectif suit le bouton « Voir toute la table »');
  assert.equal(page.find('addPersonBox', 'h3').textContent, 'Ajouter une personne sans téléphone');
  await page.click(page.node('tableAllButton'));
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Toute la table');
  assert.equal(page.$('tableSearch'), null, 'pas de recherche jusqu’à 8 personnes');
  const row = id => page.find('tableSheetList', `[data-sheet-person="${id}"]`);
  assert.match(row('alice').textContent, /^Alice1 titre prêtgéré par ce téléphone$/);
  assert.match(row('bob').textContent, /^Bob2 titres prêtsC’est moi$/);
  assert.match(row('dan').textContent, /^DanParti · historique conservé$/);
  assert.equal(row('dan').querySelector('[data-sheet-claim]'), null, 'personne partie : rien à reprendre');
  await page.tap('tableSheetList', '[data-sheet-claim="bob"]');
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Gérer les chansons de Bob');
  assert.ok(page.node('claimCode'), 'reprise par code, flux habituel');

  const crowd = baseState();
  crowd.table.headcount = 20;
  for (let i = 1; i <= 8; i++) crowd.tablePeople.push(person(`p${i}`, `Invité ${i}`));
  crowd.tablePeople.push(person('zoe', 'Zoé'));
  const big = await open({ state: crowd });
  assert.equal(big.node('tableAllButton').textContent, 'Voir toute la table (10)');
  await big.click(big.node('tableAllButton'));
  await big.type('tableSearch', 'zoe');
  assert.deepEqual(big.node('tableSheetList').querySelectorAll('[data-sheet-person]').map(node => node.dataset.sheetPerson), ['zoe'],
    'recherche sans accents');
  await big.type('tableSearch', 'xyz');
  assert.equal(big.node('tableSheetList').textContent, 'Aucune personne trouvée.');
  await big.type('tableSearch', '');
  assert.equal(big.node('tableSheetList').querySelectorAll('[data-sheet-person]').length, 10);

  const english = await open({ state, languages: ['en'] });
  assert.equal(english.node('tableAllButton').textContent, 'See the whole table (3)');
  assert.equal(english.node('peopleHeading').textContent, 'My singers');
  assert.equal(english.node('peopleIntro').textContent, 'The people signed up with this phone. To see everyone: “See the whole table”.');
  assert.equal(english.node('peopleCount').textContent, '1 here · 3 signed up at the table');
  await english.tap('langSwitch', '[data-lang="fr"]');
  assert.equal(english.node('peopleCount').textContent, '1 présente · 3 inscrites à la table', 'le changement de langue suit');

  // « Reprendre un chanteur inscrit » (catalogue) ouvre la liste de la table.
  const none = await open({ state: baseState({ managedIds: [] }) });
  await none.click(none.node('nav-catalog'));
  await none.tap('catalogAccessActions', '[data-access-go="claim"]');
  assert.equal(none.find('sheetPanel', 'h3').textContent, 'Toute la table');
});

test('table déjà commencée : « Rejoindre la table » en tête, puis la carte « Fais scanner ta table »', async () => {
  const state = baseState({ managedIds: [] });
  state.tablePeople.push(person('bob', 'Bob'));
  const page = await open({ state, respond: (url, body, self) => {
    if (url === '/api/join') {
      self.state.tablePeople.push(person('zoe', body.name));
      self.state.managedIds = ['zoe'];
      return { id: 'zoe', token: 'jeton-zoe' };
    }
    if (url.startsWith('/api/table/invite?')) return { url: 'http://192.168.1.20:3000/t/1/secret', qr: 'data:image/png;base64,TABLEQR' };
    return undefined;
  } });
  assert.equal(page.node('joinBox').hidden, false, 'la carte d’accueil reste en tête');
  assert.equal(page.node('joinHeading').textContent, 'Bienvenue à Table 1 !');
  assert.equal(page.node('joinNameLabel').textContent, 'Ton prénom');
  assert.equal(page.node('joinSubmit').textContent, 'Rejoindre la table');
  assert.equal(page.node('joinOthers').hidden, false);
  assert.equal(page.node('tableBox').hidden, true, 'les fiches des autres ne s’affichent pas');
  await page.click(page.node('joinOthers'));
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Toute la table');
  assert.match(page.find('tableSheetList', '[data-sheet-person="alice"]').textContent, /C’est moi/);
  await page.click(page.find('sheetPanel', '[data-close-sheet]'));

  page.node('firstName').value = 'Zoé';
  await page.submit('joinForm');
  assert.deepEqual(postsTo(page, '/api/join'), [['/api/join', { table: '1', access: 'secret', name: 'Zoé' }]]);
  assert.equal(page.node('joinBox').hidden, true);
  assert.equal(page.node('inviteBox').hidden, false);
  assert.equal(page.node('invitePanel').hidden, false, 'déployée juste après la première inscription');
  assert.equal(page.node('inviteToggle').hidden, true);
  assert.equal(page.find('inviteQr', 'img').attrs.src, 'data:image/png;base64,TABLEQR');
  const inviteRequests = () => page.requests.filter(request => request.url.startsWith('/api/table/invite?'));
  assert.equal(inviteRequests().length, 1);
  assert.equal(inviteRequests()[0].url, '/api/table/invite?table=1&access=secret');
  assert.deepEqual(page.node('peopleList').querySelectorAll('[data-person-card]').map(node => node.dataset.personCard), ['zoe']);
  await page.click(page.node('inviteShare'));
  assert.deepEqual(page.copies, ['http://192.168.1.20:3000/t/1/secret'], 'sans partage du téléphone : lien copié');
  assert.equal(page.toast().text, 'Lien copié : colle-le dans ton message.');
  await page.click(page.node('inviteClose'));
  assert.equal(page.node('invitePanel').hidden, true);
  assert.equal(page.node('inviteToggle').hidden, false);
  assert.equal(page.node('inviteToggle').textContent, 'Faire scanner ma table');
  await page.poll();
  assert.equal(page.node('invitePanel').hidden, true, 'repliée ensuite');
  await page.click(page.node('inviteToggle'));
  assert.equal(page.node('invitePanel').hidden, false);
  assert.equal(inviteRequests().length, 1, 'QR déjà chargé');

  const invite = { url: 'https://karaoke.example/t/1/secret', qr: 'data:image/png;base64,QR' };
  const shared = await open({ share: true, respond: url => url.startsWith('/api/table/invite?') ? invite : undefined });
  assert.equal(shared.node('inviteBox').hidden, false, 'téléphone déjà inscrit : carte repliée');
  assert.equal(shared.node('invitePanel').hidden, true);
  await shared.click(shared.node('inviteToggle'));
  await shared.click(shared.node('inviteShare'));
  assert.deepEqual(shared.shares, [{ title: 'Karaoké', text: 'Rejoins notre table au karaoké :', url: invite.url }]);
  const failed = await open({ clipboardFails: true, respond: url => url.startsWith('/api/table/invite?') ? invite : undefined });
  await failed.click(failed.node('inviteToggle'));
  await failed.click(failed.node('inviteShare'));
  assert.deepEqual(failed.toast(), { text: `Copie impossible. Lien de la table : ${invite.url}`, bad: true, warn: false, hidden: false });
  const refused = await open({ respond: url => url.startsWith('/api/table/invite?') ? reply(400, { error: 'Une erreur est survenue.' }) : undefined });
  await refused.click(refused.node('inviteToggle'));
  assert.deepEqual(refused.toast(), { text: 'Une erreur est survenue.', bad: true, warn: false, hidden: false });
  assert.equal(refused.node('invitePanel').hidden, true, 'QR indisponible : la carte se replie');
  await refused.click(refused.node('inviteShare'));
  assert.equal(refused.copies.length, 0, 'aucun lien à partager');

  const solo = await soloPage('', soloState({ tablePeople: [person('m1', 'Marie')], managedIds: ['m1'] }));
  assert.equal(solo.node('inviteBox').hidden, true, 'pas pour « En solo »');
  assert.equal(solo.node('tableAllButton').hidden, true);
  assert.equal(solo.node('tableAllRow').hidden, true, 'solo : ni bouton ni effectif de table');
  assert.equal(solo.node('peopleCount').hidden, true);

  const empty = await open({ state: baseState({ tablePeople: [], managedIds: [] }) });
  assert.equal(empty.node('joinNameLabel').textContent, 'Prénom de la première personne');
  assert.equal(empty.node('joinSubmit').textContent, 'Commencer');
  assert.equal(empty.node('joinOthers').hidden, true, 'table vide : personne à retrouver');

  const fullState = baseState({ managedIds: [] });
  fullState.table.headcount = 1;
  const full = await open({ state: fullState });
  assert.equal(full.node('joinBox').hidden, false);
  assert.equal(full.node('joinSubmit').disabled, true);
  assert.equal(full.node('headcountNotice').hidden, false);
  assert.equal(full.node('headcountNotice').textContent, 'La table a atteint son nombre de personnes. Demande au bar d’ajuster l’effectif si nécessaire.');
});

// ================================================================ constats QA du 8 octobre
// Regression: constat QA Q2 — le message de la fenêtre de prénom gardait
// l'ancienne langue après FR/EN, et « prénom déjà pris » restait affiché
// après un nouvel essai.
// Regression: constat QA Q9 — fenêtre de prénom ouverte, Tab atteignait les
// boutons FR/EN de l'en-tête et le contenu derrière.
test('fenêtre de prénom : message retraduit, effacé à chaque essai, reste de la page inerte', async () => {
  const page = await soloPage('?invitation=CLE-SOLO', soloState(), (url, body, self) => {
    if (url === '/api/table/solo/open') {
      self.state.tablePeople = [person('s1', 'Solo 1', { nameRequired: true })];
      self.state.managedIds = ['s1'];
      return { id: 's1', token: 'jeton-s1', nameRequired: true };
    }
    if (url === '/api/table/person/rename') {
      if (body.name === 'Marie') return reply(400, { error: 'Ce prénom est déjà inscrit à cette table. Utilise la fiche existante ou précise le nom.', code: 'NAME_TAKEN', recoverable: true });
      if (body.name === 'Erreur') return reply(400, { error: 'Prénom limité à 24 caractères.' });
      self.state.tablePeople = [person('s1', body.name)];
      return { ok: true };
    }
    return undefined;
  });
  const error = () => page.node('nameGateError');
  assert.equal(page.node('nameGate').hidden, false);
  // Q9 : tout sauf la fenêtre (et la zone d'état) est inerte, en-tête compris.
  const background = () => page.document.body.children.filter(node => node.tag !== '#text' && !['nameGate', 'toast'].includes(node.id));
  assert.ok(background().some(node => node.classList.contains('stagebox')), 'la scène fait partie du fond');
  for (const node of background()) assert.equal(node.inert, true, `${node.id || node.className} inerte`);
  assert.notEqual(page.node('nameGate').inert, true, 'la fenêtre reste utilisable');
  assert.notEqual(page.node('toast').inert, true, 'zone d’état annoncée');

  page.node('nameGateInput').value = 'Marie';
  await page.submit('nameGateForm');
  assert.equal(error().textContent, 'Ce prénom est déjà inscrit. Si c’est toi, touche « Déjà inscrit\u00a0? J’ai un code » ; sinon ajoute l’initiale de ton nom (ex. Marie L.).');
  await page.tap('nameGateLang', '[data-lang="en"]');
  assert.equal(error().textContent, 'This first name is already signed up. If it’s you, tap “Already signed up? I have a code”; otherwise add the initial of your last name (e.g. Mary L.).', 'le message suit la langue');
  assert.equal(error().hidden, false);
  for (const node of background()) assert.equal(node.inert, true, 'toujours inerte après le changement de langue');
  await page.tap('nameGateLang', '[data-lang="fr"]');
  assert.equal(error().textContent, 'Ce prénom est déjà inscrit. Si c’est toi, touche « Déjà inscrit\u00a0? J’ai un code » ; sinon ajoute l’initiale de ton nom (ex. Marie L.).');

  // Message du serveur : retraduit lui aussi.
  page.node('nameGateInput').value = 'Erreur';
  await page.submit('nameGateForm');
  assert.equal(error().textContent, 'Prénom limité à 24 caractères.');
  await page.tap('nameGateLang', '[data-lang="en"]');
  assert.equal(error().textContent, 'First names are limited to 24 characters.');
  await page.tap('nameGateLang', '[data-lang="fr"]');

  // Saisie : l'ancien message disparaît.
  await page.type('nameGateInput', 'Mar');
  assert.equal(error().hidden, true, 'effacé dès la saisie');
  assert.equal(error().textContent, '');
  // Champ vide bloqué par le navigateur (required) : l'ancien message ne reste pas.
  page.node('nameGateInput').value = 'Marie';
  await page.submit('nameGateForm');
  assert.equal(error().hidden, false);
  page.node('nameGateInput').value = '';
  page.dispatch(page.node('nameGateInput'), 'invalid');
  assert.equal(error().hidden, true, 'essai vide refusé par le navigateur : message effacé');
  // Nouvel essai : le message est remplacé, jamais empilé.
  page.node('nameGateInput').value = 'Marie';
  await page.submit('nameGateForm');
  page.node('nameGateInput').value = '   ';
  await page.submit('nameGateForm');
  assert.equal(error().textContent, 'Indique un prénom.');
  await page.tap('nameGateLang', '[data-lang="en"]');
  assert.equal(error().textContent, 'Please enter a first name.');
  await page.tap('nameGateLang', '[data-lang="fr"]');

  page.node('nameGateInput').value = 'Julie';
  await page.submit('nameGateForm');
  assert.equal(page.node('nameGate').hidden, true);
  assert.equal(error().hidden, true);
  for (const node of background()) assert.notEqual(node.inert, true, `${node.id || node.className} rendu à la page`);
});

// Regression: constat QA Q3 — « Partager le lien » ne copiait jamais sur un
// téléphone en http (ni navigator.share ni navigator.clipboard).
test('partager le lien de la table en http : copie de secours, sinon le lien dans le message', async () => {
  const invite = { url: 'http://192.0.2.2:3520/t/Les%20Pirates/secret', qr: 'data:image/png;base64,QR' };
  const respond = url => url.startsWith('/api/table/invite?') ? invite : undefined;
  const page = await open({ noClipboard: true, execCopy: true, respond });
  await page.click(page.node('inviteToggle'));
  page.node('inviteShare').focus();
  await page.click(page.node('inviteShare'));
  assert.equal(page.execCommands, 1, 'copie de secours du navigateur');
  assert.deepEqual(page.execCopied, [invite.url], 'le lien de la table était sélectionné');
  assert.equal(page.document.body.children.some(node => node.tag === 'textarea'), false, 'champ temporaire retiré');
  assert.ok(page.document.activeElement === page.node('inviteShare'), `le focus revient au bouton, pas en haut de la page (${page.document.activeElement.tag})`);
  assert.deepEqual(page.toast(), { text: 'Lien copié : colle-le dans ton message.', bad: false, warn: false, hidden: false });

  const failed = await open({ noClipboard: true, respond, languages: ['en-US'] });
  await failed.click(failed.node('inviteToggle'));
  await failed.click(failed.node('inviteShare'));
  assert.deepEqual(failed.toast(), { text: `Could not copy. Table link: ${invite.url}`, bad: true, warn: false, hidden: false });

  // Fiche « Transférer » : même chemin, sur le champ du lien affiché.
  const shareReply = { code: '4321', url: 'http://192.0.2.2:3520/t/1/secret?reprise=abc', qr: 'data:image/png;base64,T' };
  const transfer = await open({ noClipboard: true, execCopy: true, respond: url => url === '/api/table/person/share' ? shareReply : undefined });
  await transfer.tap('peopleList', '[data-share-person="alice"]');
  transfer.node('transferUrl').readOnly = true; // attribut readonly du balisage
  transfer.node('copyTransfer').focus();
  await transfer.click(transfer.node('copyTransfer'));
  assert.deepEqual(transfer.execCopied, [shareReply.url]);
  assert.equal(transfer.toast().text, 'Lien copié : colle-le dans ton message.');
  // Copié : le champ ne garde pas le focus (clavier et zoom d'iOS) et reste en lecture seule.
  assert.ok(transfer.document.activeElement === transfer.node('copyTransfer'), `focus rendu au bouton « Copier le lien » (${transfer.document.activeElement.id || transfer.document.activeElement.tag})`);
  assert.equal(transfer.node('transferUrl').readOnly, true);
});

// Regression: constat QA Q5 — le téléphone demandait les sélections alors que
// le serveur annonçait déjà le catalogue indisponible (502 dans la console).
test('catalogue annoncé indisponible : aucune demande de sélections, chargement à son retour', async () => {
  const state = baseState({ catalogAvailable: false });
  const page = await open({ state });
  const catalogCalls = () => page.requests.filter(request => request.url.startsWith('/api/catalog/'));
  await page.click(page.node('nav-catalog'));
  assert.equal(catalogCalls().length, 0, 'pas de requête vouée à l’échec');
  assert.equal(page.node('catalogContent').textContent, 'Le catalogue est momentanément indisponible. Réessaie dans un instant.');
  await page.tap(page.body, '[data-catalog="news"]');
  assert.equal(catalogCalls().length, 0, 'Nouveautés non plus');
  await page.poll();
  assert.equal(catalogCalls().length, 0);
  await page.tap(page.body, '[data-catalog="styles"]');
  page.state.catalogAvailable = true;
  // Recherche en cours de saisie quand le catalogue revient : elle n'est pas effacée.
  page.node('searchInput').value = 'que';
  await page.poll();
  assert.equal(page.node('searchInput').value, 'que');
  assert.equal(catalogCalls().length, 0);
  page.node('searchInput').value = '';
  await page.poll();
  assert.equal(catalogCalls().length, 1, 'catalogue revenu : une seule demande');
  assert.match(catalogCalls()[0].url, /^\/api\/catalog\/categories\?type=styles/);
  assert.match(page.node('catalogContent').textContent, /Années 80/);
  await page.poll();
  assert.equal(catalogCalls().length, 1, 'pas de nouvelle demande ensuite');
});

// Regression: constat QA Q10 — « Faire scanner ma table » restait proposé
// alors que la table était complète.
test('table complète : plus d’invitation à scanner la table, elle revient si une place se libère', async () => {
  const state = baseState({ tablePeople: [person('alice', 'Alice'), person('bob', 'Bob')], managedIds: ['alice'] });
  state.table.headcount = 2;
  const page = await open({ state, respond: url => url.startsWith('/api/table/invite?') ? { url: 'http://x/t/1/s', qr: 'data:image/png;base64,Q' } : undefined });
  assert.equal(page.node('inviteBox').hidden, true, 'table complète : ni bouton ni carte');
  page.state.table.headcount = 3;
  await page.poll();
  assert.equal(page.node('inviteBox').hidden, false, 'une place libre : le bouton revient');
  await page.click(page.node('inviteToggle'));
  assert.equal(page.node('invitePanel').hidden, false);
  page.state.tablePeople.push(person('chloe', 'Chloé'));
  await page.poll();
  assert.equal(page.node('inviteBox').hidden, true, 'carte ouverte puis table complète : masquée aussi');
});

// ---------------------------------------------------------------- relecture finale (affichage)
// Regression: U3 — dans la fenêtre de prénom, FR/EN (boîte inline-flex) ne
// se plaçait pas en haut à droite : justify-content n'y changeait rien.
// Regression: U5 — un titre trop long était grisé en entier (opacité .55) :
// « trop long » finissait vers 3:1 de contraste. Seuls pochette et titre pâlissent.
// Regression: U8 — « Déjà inscrit par un autre téléphone ? » : cible de moins de 44 px.
test('relecture : FR/EN en haut à droite de la fenêtre de prénom, « trop long » lisible, lien « Déjà inscrit » de 44 px', () => {
  const css = html.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = selector => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(match => match[1].split(',').map(part => part.trim()).includes(selector)).map(match => match[2]).join(';');
  const gateLang = rules('.client .name-gate-panel .lang-switch');
  assert.match(gateLang, /display:\s*flex/);
  assert.match(gateLang, /width:\s*max-content/);
  assert.match(gateLang, /margin-left:\s*auto/);
  assert.match(gateLang, /margin-bottom:\s*18px/, 'espacement gardé');
  assert.doesNotMatch(rules('.client .catalog-list .too-long'), /opacity/, 'la ligne entière ne pâlit plus');
  for (const part of ['.cover', '.song-title', 'b']) assert.match(rules(`.client .catalog-list .too-long ${part}`), /opacity:\s*\.55/, `${part} pâlit`);
  const join = rules('.client .join-others');
  assert.ok(Number(/min-height:\s*(\d+)px/.exec(join)?.[1]) >= 44, 'cible au doigt de 44 px');
  assert.match(join, /padding:/);
});

// Regression: U4 — la fenêtre de prénom s'ouvrait sans focus : rien n'était
// annoncé. Le focus va à son titre (pas au champ : pas de clavier forcé sur iOS).
test('relecture : fenêtre de prénom ouverte, le focus va au titre, jamais au champ', async () => {
  const page = await soloPage('?invitation=CLE-SOLO', soloState(), (url, body, self) => {
    if (url === '/api/table/solo/open') {
      self.state.tablePeople = [person('s1', 'Solo 1', { nameRequired: true })];
      self.state.managedIds = ['s1'];
      return { id: 's1', token: 'jeton-s1', nameRequired: true };
    }
    return undefined;
  });
  assert.equal(page.node('nameGate').hidden, false);
  assert.equal(page.node('nameGateTitle').getAttribute('tabindex'), '-1', 'titre focalisable par la page seulement');
  assert.equal(page.document.activeElement, page.node('nameGateTitle'), 'le titre est annoncé');
  assert.equal(page.node('nameGateTitle').focusCount, 1);
  assert.equal(page.node('nameGateInput').focusCount || 0, 0, 'pas de clavier forcé');
  page.node('nameGateInput').focus();
  await page.poll();
  assert.equal(page.document.activeElement, page.node('nameGateInput'), 'fenêtre déjà ouverte : le focus n’est pas repris');
  assert.equal(page.node('nameGateTitle').focusCount, 1);
});

// Regression: U7 — les « C’est moi » répétés de « Toute la table » n'avaient pas de nom distinct.
// Regression: U7 (vérification adverse) — en anglais, le nom « It’s me, Bob »
// ne contenait pas le texte visible « That’s me » (WCAG 2.5.3, nom dans le libellé).
test('relecture : chaque « C’est moi » de la fiche de la table porte le prénom (FR et EN)', async () => {
  for (const [languages, label] of [[['fr-FR'], 'C’est moi, Bob'], [['en-US'], 'That’s me, Bob']]) {
    const state = baseState();
    state.tablePeople.push(person('bob', 'Bob'));
    const page = await open({ state, languages });
    await page.click(page.node('tableAllButton'));
    const claim = page.find('tableSheetList', '[data-sheet-claim="bob"]');
    assert.equal(claim.getAttribute('aria-label'), label);
    assert.ok(claim.getAttribute('aria-label').startsWith(claim.textContent.trim()), `${languages[0]} : le nom accessible commence par le texte visible`);
  }
});

// Regression: U9 — « Partager le lien » : tout échec du partage (refus,
// partage indisponible) était avalé ; seule l'annulation reste silencieuse.
test('relecture : partage de la table refusé, le lien est copié ; partage annulé, rien de plus', async () => {
  const invite = { url: 'https://karaoke.example/t/1/secret', qr: 'data:image/png;base64,QR' };
  const respond = url => url.startsWith('/api/table/invite?') ? invite : undefined;
  const failure = name => () => { const error = new Error(name); error.name = name; throw error; };
  const refused = await open({ share: failure('NotAllowedError'), respond });
  await refused.click(refused.node('inviteToggle'));
  await refused.click(refused.node('inviteShare'));
  assert.equal(refused.shares.length, 1);
  assert.deepEqual(refused.copies, [invite.url], 'partage refusé : lien copié');
  assert.equal(refused.toast().text, 'Lien copié : colle-le dans ton message.');
  const cancelled = await open({ share: failure('AbortError'), respond });
  await cancelled.click(cancelled.node('inviteToggle'));
  await cancelled.click(cancelled.node('inviteShare'));
  assert.equal(cancelled.shares.length, 1);
  assert.deepEqual(cancelled.copies, [], 'annulé par la personne : pas de copie');
  assert.equal(cancelled.toast().hidden, true, 'ni message');
});

// ================================================================ troisième relecture finale (RT1, RT3)
// Regression: troisième relecture finale (RT1) — un soliste dont le nouveau
// navigateur avait ouvert un QR montré par le bar se retrouvait dans la
// fenêtre de prénom (« Solo 2 »), sans accès au code à 4 chiffres : redonner
// son prénom répondait « déjà inscrit », et il finissait inscrit deux fois.
test('fenêtre de prénom : « Déjà inscrit ? J’ai un code » reprend son profil par le code, la fenêtre se ferme (FR et EN)', async () => {
  let refuse = true;
  const respond = (url, body, self) => {
    if (url === '/api/table/enter') {
      self.state.tablePeople = [person('s2', 'Solo 2', { nameRequired: true })];
      self.state.managedIds = ['s2'];
      return { id: 's2', token: 'jeton-s2', nameRequired: true };
    }
    if (url === '/api/table/person/claim') {
      if (refuse) { refuse = false; return reply(400, { error: 'Code de partage incorrect.' }); }
      self.state.tablePeople = [person('c1', 'Clara')];
      self.state.managedIds = ['c1'];
      self.state.recoveryPeople = [];
      return { id: 'c1', token: 'jeton-c1' };
    }
    return undefined;
  };
  const session = sessionMap();
  const page = await soloPage('?evenement=SECRET-EV', soloState({ soloInvitationReady: false, privateEventReady: true,
    recoveryPeople: [person('c1', 'Clara'), person('d1', 'Dan')] }), respond, { session });
  assert.equal(page.node('nameGate').hidden, false);
  assert.equal(page.node('claimBox').hidden, false, 'une place sans prénom ne cache pas la reprise');
  const link = page.node('nameGateClaimLink');
  assert.equal(link.hidden, false);
  assert.equal(link.textContent, 'Déjà inscrit\u00a0? J’ai un code');
  assert.equal(page.node('nameGateClaim').hidden, true);
  await page.click(link);
  assert.equal(page.node('nameGateForm').hidden, true, 'le prénom laisse la place au code');
  assert.equal(page.node('nameGateClaimLink').hidden, true);
  assert.equal(page.node('nameGateClaim').hidden, false);
  assert.equal(page.document.activeElement, page.node('nameGateTitle'));
  assert.equal(page.find('nameGateClaim', '[data-gate-claim-person="c1"]').textContent, 'Je suis Clara · reprendre mes chansons');
  // Retour : du choix du prénom à la fenêtre de prénom.
  await page.tap('nameGateClaim', '[data-gate-claim-back]');
  assert.equal(page.node('nameGateForm').hidden, false);
  assert.equal(page.node('nameGateClaim').hidden, true);
  await page.click(page.node('nameGateClaimLink'));
  await page.tap('nameGateClaim', '[data-gate-claim-person="c1"]');
  assert.match(page.node('nameGateClaim').textContent, /Tu es Clara\u00a0\? Demande le code au bar ou à ton ancien téléphone\./);
  const code = page.node('nameGateClaimCode');
  assert.equal(code.getAttribute('inputmode'), 'numeric');
  assert.equal(page.document.activeElement, code);
  // Un rafraîchissement ne vide pas le code en cours de saisie.
  code.value = '12';
  await page.poll();
  assert.equal(page.node('nameGateClaimCode').value, '12');
  page.node('nameGateClaimCode').value = '1234';
  await page.submit('nameGateClaimForm');
  assert.deepEqual(page.posts.at(-1), ['/api/table/person/claim', { table: 'Comptoir', access: 'secret', personId: 'c1', code: '1234' }]);
  assert.deepEqual(page.toast(), { text: 'Code de partage incorrect.', bad: true, warn: false, hidden: false });
  assert.equal(page.node('nameGate').hidden, false, 'refusé : la fenêtre reste');
  await page.submit('nameGateClaimForm');
  assert.equal(JSON.parse(page.storage.get('kfPeople:Comptoir:secret')).c1, 'jeton-c1');
  assert.equal(page.node('nameGate').hidden, true, 'repris : la fenêtre de prénom se ferme');
  assert.equal(page.node('mainContent').hidden, false);
  assert.equal(page.node('tableName').textContent, 'Clara');
  assert.equal(page.toast().text, 'Tu gères maintenant Clara sur ce téléphone.');
  assert.equal(session.getItem('kfEventPlace:Comptoir:secret'), '', 'la place « Solo 2 » retirée n’est pas un « QR plus actif »');

  // Aucun code demandé pour l'instant : la marche à suivre.
  const none = await soloPage('?evenement=SECRET-EV', soloState({ soloInvitationReady: false, privateEventReady: true }), respond);
  await none.click(none.node('nameGateClaimLink'));
  assert.equal(none.node('nameGateClaim').querySelector('[data-gate-claim-person]'), null);
  assert.match(none.node('nameGateClaim').textContent, /Demande d’abord au bar ou à ton ancien téléphone un code de reprise à 4 chiffres : ton prénom apparaîtra ici\./);
  // Le code demandé entre-temps : son prénom apparaît au rafraîchissement suivant.
  none.state.recoveryPeople = [person('c1', 'Clara')];
  await none.poll();
  assert.ok(none.find('nameGateClaim', '[data-gate-claim-person="c1"]'));

  // En anglais, et la langue change sans perdre l'étape.
  const english = await soloPage('?evenement=SECRET-EV', soloState({ soloInvitationReady: false, privateEventReady: true,
    recoveryPeople: [person('c1', 'Clara')] }), respond, { languages: ['en'] });
  assert.equal(english.node('nameGateClaimLink').textContent, 'Already signed up? I have a code');
  await english.click(english.node('nameGateClaimLink'));
  assert.equal(english.node('nameGateTitle').textContent, 'Recover my songs');
  assert.equal(english.find('nameGateClaim', '[data-gate-claim-person="c1"]').textContent, 'I am Clara · recover my songs');
  await english.tap('nameGateClaim', '[data-gate-claim-person="c1"]');
  assert.equal(english.find('nameGateClaim', '[data-gate-claim-back]').textContent, 'Back');
  english.node('nameGateClaimCode').value = '98';
  await english.tap('nameGateLang', '[data-lang="fr"]');
  assert.equal(english.node('nameGateClaimCode').value, '98', 'le code tapé reste');
  assert.equal(english.find('nameGateClaim', 'label').textContent, 'Code de reprise à 4 chiffres');
  // Retour depuis le code : le choix du prénom.
  await english.tap('nameGateClaim', '[data-gate-claim-back]');
  assert.ok(english.find('nameGateClaim', '[data-gate-claim-person="c1"]'));
});

// Regression: troisième relecture finale (RT3) — après « Renouveler le QR »
// ou le mode coupé, la page d'un inscrit qui avait perdu son jeton ne
// demandait plus rien (QR « plus actif ») : le serveur la retrouve par son
// cookie, la page doit donc envoyer sa demande.
test('événement privé : QR renouvelé ou coupé, un inscrit de ce navigateur retrouve sa place', async () => {
  const page = await soloPage('?evenement=VIEUX', soloState({ soloInvitationReady: false, privateEventReady: false }), (url, body, self) => {
    if (url !== '/api/table/enter') return undefined;
    self.state.tablePeople = [person('l1', 'Léa')];
    self.state.managedIds = ['l1'];
    return { id: 'l1', token: 'jeton-l1', nameRequired: false, resumed: true };
  });
  assert.deepEqual(postsTo(page, '/api/table/enter'), [['/api/table/enter', { table: 'Comptoir', access: 'secret', event: 'VIEUX' }]]);
  assert.deepEqual(JSON.parse(page.storage.get('kfPeople:Comptoir:secret')), { l1: 'jeton-l1' });
  assert.equal(page.node('tableName').textContent, 'Léa');
  assert.equal(page.node('nameGate').hidden, true);
  assert.equal(page.node('noSingerBox').hidden, true);
  assert.equal(page.history.urls.at(-1), '/t/Comptoir/secret');

  // Refusé : « QR plus actif », sans « Réessayer » ni nouvel essai.
  const refused = await soloPage('?evenement=VIEUX', soloState({ soloInvitationReady: false, privateEventReady: false }), url => url === '/api/table/enter'
    ? reply(403, { error: 'Ce QR d’événement n’est plus actif. Demande au bar.', code: 'PRIVATE_EVENT' }) : undefined, { languages: ['en'] });
  assert.equal(refused.node('noSingerText').textContent, 'This event QR code is no longer active. Ask the bar.');
  assert.equal(refused.node('noSingerTitle').textContent, 'To add a song');
  assert.equal(refused.node('noSingerActions').querySelector('[data-entry-retry]'), null);
  await refused.poll();
  assert.equal(postsTo(refused, '/api/table/enter').length, 1);
});

// ================================================================ troisième passe finale (E3, E5, E6)
// Regression: troisième relecture finale (A3-1) — « prénom déjà pris »
// renvoyait toujours vers « J’ai un code », même quand la personne de ce
// prénom ne peut pas être reprise d'ici (partie, autre groupe) : la liste
// restait vide et le bar ne peut pas donner de code à une personne partie.
test('prénom déjà pris : « J’ai un code » seulement si le serveur dit la personne reprenable d’ici, sinon l’initiale et le bar (FR et EN)', async () => {
  const taken = recoverable => reply(400, { error: 'Ce prénom est déjà inscrit ce soir. Ajoute l’initiale de ton nom (ex. Marie L.).', code: 'NAME_TAKEN',
    ...(recoverable === undefined ? {} : { recoverable }) });
  const respond = (url, body, self) => {
    if (url === '/api/table/solo/open') {
      self.state.tablePeople = [person('s1', 'Solo 1', { nameRequired: true })];
      self.state.managedIds = ['s1'];
      return { id: 's1', token: 'jeton-s1', nameRequired: true };
    }
    if (url === '/api/table/person/rename') return taken({ Marie: true, Zoé: false }[body.name]);
    return undefined;
  };
  const page = await soloPage('?invitation=CLE-SOLO', soloState(), respond);
  const error = () => page.node('nameGateError').textContent;
  const typed = async name => { page.node('nameGateInput').value = name; await page.submit('nameGateForm'); };
  await typed('Marie');
  assert.equal(error(), 'Ce prénom est déjà inscrit. Si c’est toi, touche « Déjà inscrit ? J’ai un code » ; sinon ajoute l’initiale de ton nom (ex. Marie L.).');
  for (const name of ['Zoé', 'Inconnu']) {
    await typed(name);
    assert.equal(error(), 'Ce prénom est déjà inscrit. Ajoute l’initiale de ton nom (ex. Marie L.). Si c’est bien toi, demande au bar.', name);
  }
  await page.tap('nameGateLang', '[data-lang="en"]');
  assert.equal(error(), 'This first name is already signed up. Add the initial of your last name (e.g. Mary L.). If it really is you, ask the bar.');
  const english = await soloPage('?invitation=CLE-SOLO', soloState(), respond, { languages: ['en'] });
  english.node('nameGateInput').value = 'Zoé';
  await english.submit('nameGateForm');
  assert.equal(english.node('nameGateError').textContent, 'This first name is already signed up. Add the initial of your last name (e.g. Mary L.). If it really is you, ask the bar.');
});

// Regression: troisième relecture finale (D3-3) — en reprise par code, la
// fenêtre gardait le titre « Bienvenue ! Quel est ton prénom ? » au-dessus de
// « Récupérer mes chansons » : un seul titre, celui de l'étape.
test('fenêtre de prénom : en reprise par code, un seul titre « Récupérer mes chansons », rendu par « Retour » (FR et EN)', async () => {
  const respond = (url, body, self) => {
    if (url !== '/api/table/enter') return undefined;
    self.state.tablePeople = [person('s2', 'Solo 2', { nameRequired: true })];
    self.state.managedIds = ['s2'];
    return { id: 's2', token: 'jeton-s2', nameRequired: true };
  };
  const state = () => soloState({ soloInvitationReady: false, privateEventReady: true, recoveryPeople: [person('c1', 'Clara')] });
  const page = await soloPage('?evenement=SECRET-EV', state(), respond);
  const title = () => page.node('nameGateTitle').textContent;
  const headings = () => page.node('nameGate').querySelectorAll('h2, h3').filter(node => !node.hidden);
  assert.equal(title(), 'Bienvenue\u00a0! Quel est ton prénom\u00a0?');
  await page.click(page.node('nameGateClaimLink'));
  assert.equal(title(), 'Récupérer mes chansons');
  assert.deepEqual(headings().map(node => node.textContent), ['Récupérer mes chansons'], 'un seul titre');
  assert.equal(page.document.activeElement, page.node('nameGateTitle'), 'le titre de l’étape est annoncé');
  await page.tap('nameGateClaim', '[data-gate-claim-person="c1"]');
  assert.equal(title(), 'Récupérer mes chansons');
  await page.poll();
  assert.equal(title(), 'Récupérer mes chansons', 'un rafraîchissement garde le titre');
  await page.tap('nameGateLang', '[data-lang="en"]');
  assert.equal(title(), 'Recover my songs', 'la langue change sans revenir au prénom');
  await page.tap('nameGateClaim', '[data-gate-claim-back]');
  assert.equal(title(), 'Recover my songs', 'retour au choix du prénom : toujours la reprise');
  await page.tap('nameGateClaim', '[data-gate-claim-back]');
  assert.equal(title(), 'Welcome! What’s your first name?', '« Retour » rend le titre de la fenêtre');
  assert.equal(page.document.activeElement, page.node('nameGateTitle'));
  await page.tap('nameGateLang', '[data-lang="fr"]');
  assert.equal(title(), 'Bienvenue\u00a0! Quel est ton prénom\u00a0?');
  const english = await soloPage('?evenement=SECRET-EV', state(), respond, { languages: ['en'] });
  await english.click(english.node('nameGateClaimLink'));
  assert.equal(english.node('nameGateTitle').textContent, 'Recover my songs');
});

// Regression: troisième relecture finale (ADV F2) — le téléphone d'un
// soliste marqué parti qui ouvre un QR personnel neuf (sa page ne le gère
// plus) affiche « marquée partie, demande au bar » (PERSON_LEFT), FR et EN.
test('QR personnel neuf sur le téléphone d’un soliste marqué parti : le message PERSON_LEFT (FR et EN)', async () => {
  const left = url => url === '/api/table/solo/open'
    ? reply(403, { error: 'Cette personne a été marquée partie. Demande au bar de la réactiver.', code: 'PERSON_LEFT' }) : undefined;
  const fr = await soloPage('?invitation=CLE-NEUVE', soloState(), left);
  assert.deepEqual(postsTo(fr, '/api/table/solo/open'), [['/api/table/solo/open', { table: 'Comptoir', access: 'secret', invitation: 'CLE-NEUVE' }]]);
  assert.equal(fr.node('noSingerText').textContent, 'Cette personne a été marquée partie. Demande au bar de la réactiver.');
  assert.equal(fr.node('nameGate').hidden, true);
  const en = await soloPage('?invitation=CLE-NEUVE', soloState(), left, { languages: ['en'] });
  assert.equal(en.node('noSingerText').textContent, 'This person was marked as gone. Ask the bar to bring them back.');
  await en.poll();
  assert.equal(postsTo(en, '/api/table/solo/open').length, 1, 'refus du serveur : pas de nouvel essai');
});
