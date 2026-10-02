'use strict';
// Page des chanteurs (public/client.html) : parcours encore sans test.
// Langue du téléphone, lien invalide, perte de connexion, ancien jeton,
// catalogue ouvert pour un chanteur (ou refusé), choix d'un partenaire de duo,
// lien de transfert reçu ou envoyé, alertes (son, vibration, notifications),
// bannières, fiches des personnes, actions de la liste, Battle, catalogue en
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
  select() { this.selected = true; }
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
const reply = (status, data = {}) => ({ [REPLY]: true, status, data });
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
    execCommand: command => { page.execCommands = (page.execCommands || 0) + 1; return command === 'copy' && !!options.execCopy; },
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
    return { ok: response.status < 400, status: response.status, json: async () => response.data };
  };

  const navigator = {
    ...(options.languages !== undefined ? { languages: options.languages } : { languages: ['fr-FR'] }),
    ...(options.language !== undefined ? { language: options.language } : {}),
    vibrate: pattern => { page.vibrations.push([...pattern]); return true; },
    ...(options.share ? { share: async data => { page.shares.push({ ...data }); } } : {}),
    clipboard: { writeText: async text => { if (options.clipboardFails) throw new Error('refusé'); page.copies.push(text); } },
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
  assert.equal(page.toast().text, 'La gestion de Alice est passée sur un autre téléphone.');
  assert.equal(page.node('catalogTarget').textContent,
    'Explore le catalogue. Pour ajouter un titre, inscris une personne ou reprends sa gestion avec un code.', 'plus de chanteur visé');
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
  assert.equal(page.find('peopleList', '[data-person-card="chloe"]').querySelector('[data-add-song]'), null, 'pas de bouton pour Chloé');
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
  { id: 'sam', name: 'Sam', tableId: 'Comptoir', table: 'En solo', guestDuos: 1 },
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
  assert.deepEqual(others.querySelectorAll('option').map(option => option.textContent), ['↗ Zoé · Table 2', '↗ Sam · En solo']);
  assert.equal(select.value, 'marc');
  assert.equal(page.node('sendDuo').textContent, 'Ajouter le duo');
  assert.equal(page.node('duoConsent').textContent, 'Même table : le duo est ajouté directement.');
  assert.equal(page.node('duoPartnerHint').hidden, true);

  await page.change('duoPartner', 'zoe');
  assert.equal(page.node('sendDuo').textContent, 'Envoyer l’invitation');
  assert.equal(page.node('duoConsent').textContent, 'Son téléphone devra accepter l’invitation.');
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
  assert.match(page.find('peopleList', '[data-person-card="bob"]').textContent, /géré sur ce téléphone/);
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
  assert.equal(already.node('transferText').textContent, 'Ce téléphone gère déjà les chansons de Alice. Rien à faire.');
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
  const message = `Pour gérer les chansons de Alice au karaoké (Table 1), ouvre ce lien : ${shared.url}`;
  assert.ok(sheet.includes(`https://wa.me/?text=${encodeURIComponent(message)}`), 'WhatsApp préremplit le lien');
  assert.ok(sheet.includes(`sms:?&body=${encodeURIComponent(message)}`), 'SMS');
  assert.ok(sheet.includes(`mailto:?subject=${encodeURIComponent('Karaoké : Alice')}`), 'e-mail');
  assert.equal(page.node('transferUrl').value, shared.url);
  assert.equal(page.find('sheetPanel', '.share-code').textContent, '4321');
  assert.ok(sheet.includes(`jusqu’à ${timeOf(shared.linkExpiresAt)}`), 'heure limite du lien');
  assert.match(sheet, /Ce lien ne fonctionne que sur le Wi-Fi du bar\./, 'adresse locale : prévenir');
  assert.equal('open' in page.find('sheetPanel', 'details').attrs, false, 'le code reste replié sous le QR');

  await page.click(page.node('shareTransfer'));
  assert.deepEqual(page.shares, [{ title: 'Karaoké', text: 'Pour gérer les chansons de Alice au karaoké (Table 1), ouvre ce lien :', url: shared.url }]);
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
  assert.match(codeOnly.sheetHtml(), /ouvre le QR code de la table, touche « Je suis Alice »/);

  const state = baseState({ table: { id: 'Comptoir', name: 'En solo', individual: true, count: 2 } });
  const solo = await open({ state, path: '/t/Comptoir/secret', respond: url => url === '/api/table/person/share' ? share() : undefined });
  await solo.tap('peopleList', '[data-share-person="alice"]');
  assert.equal(solo.find('sheetPanel', 'h3').textContent, 'Changer de téléphone');
  assert.ok(solo.sheetHtml().includes(encodeURIComponent('Lien pour récupérer mes chansons du karaoké sur ce téléphone :')));
  assert.match(solo.sheetHtml(), /ouvre le QR « En solo » que te montre le bar/);
});

// ================================================================ alertes
test('alertes : notifications autorisées, son à deux notes, vibration et notification de présence', async () => {
  const page = await open({ secure: true, hidden: true, notification: { permission: 'default', grant: 'granted' }, audio: { state: 'suspended' } });
  assert.equal(page.node('alertsToggle').textContent, 'Activer les notifications');
  assert.match(page.node('alertsHelp').textContent, /^Sur cette connexion sécurisée/);
  await page.click(page.node('alertsToggle'));
  assert.equal(page.permissionRequests, 1, 'autorisation du navigateur demandée');
  assert.equal(page.storage.get('kfAlerts:1:secret'), '1', 'choix gardé sur ce téléphone');
  assert.equal(page.node('alertsToggle').textContent, 'Désactiver les notifications');
  assert.equal(page.node('alertsToggle').getAttribute('aria-pressed'), 'true');
  assert.equal(page.toast().text, 'Notifications activées tant que la page reste ouverte.');
  assert.equal(page.audio.resumes, 1, 'son débloqué par le geste');
  assert.deepEqual(page.audio.oscillators.map(note => [note.frequency.value, note.startAt]), [[660, 10], [880, 10.18]], 'deux notes');
  assert.equal(page.audio.toSpeaker, 2);

  page.state.tablePeople[0].needConfirm = true;
  await page.poll();
  assert.equal(page.node('presenceBanner').hidden, false);
  assert.match(page.node('presenceBannerText').textContent, /^Présence à confirmer pour Alice\./);
  assert.deepEqual(page.vibrations, [[160, 80, 160]]);
  assert.equal(page.audio.oscillators.length, 4, 'nouveau son');
  const [notice] = page.notifications;
  assert.equal(notice.title, 'Karaoké : présence à confirmer');
  assert.equal(notice.body, 'Alice : ouvre la page pour confirmer avant le passage.');
  assert.equal(notice.tag, 'presence-1');
  await page.click(page.node('nav-catalog'));
  notice.onclick();
  await page.settle();
  assert.equal(page.focusWindow, 1);
  assert.equal(page.tabShown(), 'table', 'la notification ramène à « Ma table »');
  assert.equal(notice.closed, true);
  await page.poll();
  assert.equal(page.vibrations.length, 1, 'pas de nouvelle alerte pour la même demande');

  // Nouvelle invitation de duo : notification « nouvelle demande ».
  page.state.tablePeople[0].invites = [{ entryId: 'x1', fromName: 'Zoé', song: { title: 'Hit' } }];
  await page.poll();
  const request = page.notifications.at(-1);
  assert.equal(request.title, 'Karaoké : nouvelle demande');
  assert.equal(request.body, 'Zoé propose un duo à Alice. Réponds depuis « Ma table ».');
  assert.equal(request.tag, 'demande-1-duo:alice:x1');
  assert.equal(page.vibrations.length, 2);
  request.onclick();
  assert.equal(request.closed, true);

  await page.click(page.node('alertsToggle'));
  assert.equal(page.toast().text, 'Alertes désactivées.');
  assert.equal(page.storage.get('kfAlerts:1:secret'), '0');
  assert.equal(page.node('alertsToggle').textContent, 'Activer les notifications');
  page.state.tablePeople[0].invites.push({ entryId: 'x2', fromName: 'Marc', song: { title: 'Autre' } });
  await page.poll();
  assert.equal(page.vibrations.length, 2, 'alertes coupées : plus de vibration');
});

test('alertes : sans HTTPS, déblocage du son au premier toucher, échecs silencieux', async () => {
  const plain = await open({ audio: {} });
  assert.match(plain.node('alertsHelp').textContent, /^Les demandes restent visibles ici\./);
  await plain.click(plain.node('alertsToggle'));
  assert.equal(plain.toast().text, 'Alertes dans la page activées tant qu’elle reste ouverte.');
  assert.equal(plain.permissionRequests, undefined, 'pas de demande d’autorisation sans HTTPS');

  // Alertes déjà choisies : le premier toucher prépare le son (une seule fois).
  const touched = await open({ audio: { state: 'suspended' }, storage: { 'kfAlerts:1:secret': '1' } });
  assert.equal(touched.node('alertsToggle').textContent, 'Désactiver les notifications');
  touched.dispatch(touched.document, 'pointerdown');
  touched.dispatch(touched.document, 'pointerdown');
  await touched.settle();
  assert.equal(touched.audio.contexts, 1);
  assert.equal(touched.audio.resumes, 1);
  const off = await open({ audio: {} });
  off.dispatch(off.document, 'pointerdown');
  assert.equal(off.audio.contexts, 0, 'alertes coupées : aucun son préparé');
  const refused = await open({ audio: { refuse: true }, storage: { 'kfAlerts:1:secret': '1' } });
  assert.doesNotThrow(() => refused.dispatch(refused.document, 'pointerdown'), 'son interdit par le navigateur : aucune erreur');
  await refused.click(refused.node('alertsToggle'));
  await refused.click(refused.node('alertsToggle'));
  assert.equal(refused.toast().text, 'Alertes dans la page activées tant qu’elle reste ouverte.', 'les alertes visuelles restent');

  // Son bloqué et notifications refusées par le navigateur : la page continue.
  const broken = await open({ secure: true, hidden: true, audio: { fail: true }, notification: { permission: 'granted', throws: true },
    storage: { 'kfAlerts:1:secret': '1' } });
  assert.match(broken.node('alertsHelp').textContent, /^Sur cette connexion sécurisée/);
  broken.state.tablePeople[0].needConfirm = true;
  broken.state.tablePeople[0].invites = [{ entryId: 'x1', fromName: 'Zoé', song: { title: 'Hit' } }];
  await broken.poll();
  assert.equal(broken.node('presenceBanner').hidden, false, 'la bannière de présence reste visible');
  assert.equal(broken.node('activityBanner').hidden, false, 'la bannière de demande aussi');
  assert.equal(broken.notifications.length, 0);
  assert.equal(broken.vibrations.length, 2, 'la vibration fonctionne encore');
  await broken.click(broken.node('alertsToggle'));
  await broken.click(broken.node('alertsToggle'));
  assert.equal(broken.toast().text, 'Notifications activées tant que la page reste ouverte.');
});

// ================================================================ bannières
test('bannières : plusieurs invitations, « Voir les confirmations », « Répondre au duo », « Voir la Battle »', async () => {
  const state = baseState();
  state.tablePeople[0].needConfirm = true;
  state.tablePeople[0].invites = [{ entryId: 'x1', fromName: 'Zoé', song: { title: 'Hit' } }, { entryId: 'x2', fromName: 'Marc', song: { title: 'Slow' } }];
  const page = await open({ state });
  assert.match(page.node('activityBannerText').textContent, /^2 invitations de duo attendent une réponse\. /);
  assert.equal(page.node('activityBannerGo').textContent, 'Répondre au duo');
  assert.equal(page.document.title, '(2) Karaoké — ma table');

  await page.click(page.node('nav-queue'));
  await page.click(page.node('presenceBannerGo'));
  assert.equal(page.tabShown(), 'table');
  const card = page.find('peopleList', '[data-person-card="alice"]');
  assert.ok(card.scrolled, 'la fiche d’Alice est amenée à l’écran');
  assert.equal(page.document.activeElement, card.querySelector('[data-confirm-person]'), '« Je suis là » reçoit le focus');

  await page.click(page.node('nav-queue'));
  await page.click(page.node('activityBannerGo'));
  assert.equal(page.tabShown(), 'table');
  assert.equal(page.document.activeElement, page.find('peopleList', '[data-person-card="alice"]').querySelector('[data-duet-answer="yes"]'),
    '« Accepter » de l’invitation reçoit le focus');

  page.state.tablePeople[0].invites = [];
  page.state.tablePeople[0].needConfirm = false;
  page.state.battle = { id: 'b7', phase: 'voting', mode: 'yesno', eligiblePersonIds: ['alice'], votedPersonIds: [], closesAt: Date.now() + 120000, eligible: 4, threshold: 2 };
  await page.poll();
  assert.equal(page.node('presenceBanner').hidden, true);
  assert.equal(page.node('activityBannerGo').textContent, 'Voir la Battle');
  assert.equal(page.node('activityBannerText').textContent, 'Un vote Battle est ouvert. Alice peut voter avant la fin du délai.');
  await page.click(page.node('activityBannerGo'));
  assert.ok(page.node('battleBox').scrolled);
  assert.equal(page.document.activeElement, page.find('battleVotes', '[data-battle-vote="alice"]'));

  // Plus aucune demande : la bannière disparaît et son bouton ne fait rien.
  page.state.battle = baseState().battle;
  await page.poll();
  assert.equal(page.node('activityBanner').hidden, true);
  assert.equal(page.document.title, 'Karaoké — ma table');
});

// ================================================================ fiches des personnes
test('fiches : sur scène, duos, présence, report, parti, autre téléphone', async () => {
  const at = Date.now() + 15 * 60000;
  const state = baseState({ rules: { requirePresence: true }, me: { id: 'eve', inKaraFun: [{ title: 'Prête', artist: '' }] } });
  state.tablePeople = [
    person('alice', 'Alice', { inKaraFun: [{ title: 'Chanson KF', artist: 'Artiste', stage: true }],
      songs: [{ entryId: 'e1', title: 'Duo 1', artist: 'A', duet: { state: 'pending', partnerName: 'Zoé' } }, { entryId: 'e2', title: 'Duo 2', artist: 'B', duet: { state: 'accepted' } }],
      guestDuos: [{ fromName: 'Marc', song: { title: 'Hit' } }], needConfirm: true, canDefer: true }),
    person('bob', 'Bob', { invites: [{ entryId: 'x9', fromName: 'Léa', song: { title: 'Slow', artist: 'Lui' } }],
      songs: [{ entryId: 'b1', title: 'Rock', artist: 'R' }] }),
    person('carla', 'Carla', { confirmed: true, deferral: { remaining: 2, pendingRemoval: true, canDeferMore: true } }),
    person('dan', 'Dan', { active: false }),
    person('eve', 'Eve'),
  ];
  state.managedIds = ['alice', 'carla', 'eve'];
  state.queue = [{ pos: 2, ids: ['bob'], id: 'bob', name: 'Bob', title: 'Rock', source: 'helper', eta: at, song: { entryId: 'b1' } }];
  const page = await open({ state });
  const card = id => page.find('peopleList', `[data-person-card="${id}"]`);
  const status = id => card(id).querySelector('.person-state').textContent;

  assert.equal(status('alice'), 'Sur scène · géré sur ce téléphone');
  assert.match(card('alice').textContent, /DÉJÀ PRÊTE DANS LA FILE.*Chanson KF.*Artiste · sur scène/s);
  assert.match(card('alice').textContent, /SA LISTE · 2 CHANSONS/);
  assert.match(card('alice').textContent, /A · prochain titre · duo avec Zoé \(en attente de sa réponse\)/);
  assert.match(card('alice').textContent, /B · à suivre · duo avec un autre chanteur/);
  assert.equal(card('alice').querySelectorAll('[data-reorder-song]').length, 2, 'ordre modifiable');
  assert.equal(card('alice').querySelectorAll('[data-duet-cancel]').length, 2, 'duos annulables');
  assert.match(card('alice').textContent, /Alice chantera aussi en duo avec Marc sur « Hit »\. Ses propres chansons restent dans sa liste/);
  assert.match(card('alice').textContent, /Confirme la présence de Alice pour son prochain passage\./);
  assert.ok(card('alice').querySelector('[data-confirm-person="alice"]') && card('alice').querySelector('[data-defer-person="alice"]'),
    'présence et report : une seule question, deux réponses');
  assert.doesNotMatch(card('alice').textContent, /C’est bientôt au tour/, 'pas de seconde question');

  assert.equal(status('bob'), `2e dans la file · vers ${timeOf(at)} · autre téléphone`);
  assert.match(card('bob').textContent, /Léa propose un duo sur « Slow » — Lui\..*Son téléphone doit répondre\./s);
  assert.equal(card('bob').querySelector('[data-duet-answer]'), null, 'pas de réponse depuis ce téléphone');
  assert.equal(card('bob').querySelector('[data-rename-person]'), null);
  assert.equal(card('bob').querySelector('[data-remove-song]'), null);
  assert.ok(card('bob').querySelector('[data-lyrics-title="Rock"]'), 'les paroles restent consultables');

  assert.match(card('carla').textContent, /Passage repoussé : encore 2 chansons avant Carla\. Son titre sort de KaraFun et garde son tour\./);
  assert.ok(card('carla').querySelector('[data-ready-person="carla"]'));
  assert.equal(card('carla').querySelector('[data-defer-person="carla"]').textContent, 'Encore une chanson');
  assert.match(card('carla').textContent, /Présence confirmée pour ce passage\./);
  assert.match(card('carla').textContent, /Aucune chanson préparée\./);

  assert.equal(status('dan'), 'Parti · historique conservé · autre téléphone');
  assert.equal(status('eve'), 'Chanson prête dans la file · géré sur ce téléphone', 'titre envoyé connu par « me »');
  assert.match(card('eve').textContent, /Prête · bientôt sur scène/);

  const english = await open({ state, languages: ['en'] });
  assert.match(english.find('peopleList', '[data-person-card="bob"]').querySelector('.person-state').textContent,
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
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Ordre des chansons de Alice');
  assert.match(page.sheetHtml(), /Déplace « Deuxième » sans changer la place de Alice dans la file\./);
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
    if (url === '/api/table/person') {
      self.state.tablePeople.push(person('zoe', 'Zoé'));
      self.state.managedIds = ['zoe'];
      return { id: 'zoe', token: 'jeton-zoe' };
    }
    return undefined;
  } });
  await page.click(page.node('nav-catalog'));
  assert.equal(page.node('catalogTarget').textContent,
    'Explore le catalogue. Pour ajouter un titre, inscris une personne ou reprends sa gestion avec un code.');
  await pickCatalogSong(page);
  assert.match(page.find('sheetPanel', 'h3').textContent, /^Avant d’ajouter « Tube »$/);
  assert.match(page.sheetHtml(), /Ton titre restera sélectionné pendant l’inscription\./);
  await page.tap('sheetPanel', '[data-access-go="claim"]');
  assert.equal(page.sheetOpen(), false);
  assert.equal(page.tabShown(), 'table');
  assert.ok(page.node('claimBox').scrolled);
  assert.equal(page.document.activeElement, page.find('claimPeople', '[data-claim-person="alice"]'), '« Je suis Alice » prêt à toucher');

  await page.click(page.node('nav-catalog'));
  await page.tap('catalogContent', '[data-song-index="0"]');
  await page.tap('sheetPanel', '[data-access-go="register"]');
  assert.ok(page.node('addPersonBox').scrolled, 'table déjà occupée : ajouter une personne');
  assert.equal(page.document.activeElement, page.node('newName'));
  page.node('newName').value = 'Zoé';
  await page.submit('addPersonForm');
  assert.deepEqual(page.posts.at(-1), ['/api/table/person', { table: '1', access: 'secret', name: 'Zoé' }]);
  assert.deepEqual(JSON.parse(page.storage.get('kfPeople:1:secret')), { zoe: 'jeton-zoe' });
  assert.equal(page.node('newName').value, '');
  assert.equal(page.toast().text, 'Zoé est ajouté à la table.');
  assert.equal(page.sheetOpen(), true, 'le titre choisi revient tout de suite');
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Tube');
  assert.match(page.sheetHtml(), /Pour Zoé/);

  page.node('newName').value = '';
  await page.submit('addPersonForm');
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
  const page = await open({ state, respond: url => url === '/api/table/duet/join' ? { ok: true, direct: true } : undefined });
  await page.click(page.node('nav-queue'));
  await page.tap('queueList', '[data-join-request="bruno"]');
  assert.equal(page.find('sheetPanel', 'h3').textContent, 'Chanter « Tube » avec Bruno ?');
  assert.deepEqual(page.node('joinPerson').querySelectorAll('option').map(option => option.textContent), ['Alice', 'Bob']);
  await page.change('joinPerson', 'bob');
  await page.click(page.node('sendJoin'));
  assert.deepEqual(page.posts.at(-1), ['/api/table/duet/join', { table: '1', access: 'secret', personId: 'bob', ownerId: 'bruno', entryId: 'b1' }]);
  assert.equal(page.toast().text, 'Duo ajouté avec Bruno.', 'même table : duo direct');
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
  assert.equal(box.classList.contains('warn'), true);
  page.state.closing = null;
  await page.poll();
  assert.equal(box.hidden, true, 'heure de fermeture retirée par le bar');

  const english = await open({ languages: ['en'], state: baseState({ closing: { at, passed: false, full: false, fitCount: 3 } }) });
  assert.equal(english.node('closingBox').querySelector('b').textContent, `The bar closes at ${timeOf(at, 'en')}`);
});
