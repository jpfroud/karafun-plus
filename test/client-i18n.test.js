'use strict';
// Page des chanteurs en français ou en anglais : chaque texte a sa traduction,
// la langue suit celle du téléphone, le choix FR/EN est gardé et les messages
// d'erreur du serveur sont traduits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { BattleVote } = require('../battle-vote');
const { Scheduler } = require('../scheduler');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'client.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0]?.[1];
assert.ok(script, 'script de la page client');
assert.match(html, /<script src="\/client-i18n\.js"><\/script>\s*<script>/, 'les traductions sont chargées avant la page');
const loaded = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'client-i18n.js'), 'utf8'), loaded, { filename: 'client-i18n.js' });
const english = loaded.window.CLIENT_TRANSLATIONS?.en;
assert.ok(english?.texts && english.errors && english.errorPatterns, 'dictionnaire anglais');

// ---------------------------------------------------------------- complétude
const placeholders = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
const used = new Map();
for (const match of script.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) used.set(match[1], 'texte');
for (const match of script.matchAll(/\btp\(\s*[^,]+,\s*'((?:[^'\\]|\\.)*)',\s*'((?:[^'\\]|\\.)*)'/g)) {
  used.set(match[1], 'pluriel');
  assert.deepEqual(placeholders(match[1]), placeholders(match[2]), `mêmes paramètres au pluriel : ${match[1]}`);
}
// Une clé non littérale échapperait à ce contrôle : seuls les textes fixes en ont.
const dynamic = [...script.matchAll(/\bt\(\s*(?!')([^)]*)\)/g)].map(match => match[1]);
assert.deepEqual([...new Set(dynamic)], ['text'], 'les appels t() utilisent un texte français littéral');
assert.equal((script.match(/(?<!function )\btp\(/g) || []).length, [...script.matchAll(/\btp\(\s*[^,]+,\s*'/g)].length,
  'les appels tp() utilisent des textes français littéraux');
const statics = [...html.matchAll(/<(\w+)\b([^>]*\bdata-i18n\b(?!-)[^>]*)>([^<]*)<\/\1>/g)];
assert.equal(statics.length, (html.split('<script')[0].match(/\bdata-i18n\b(?!-)/g) || []).length,
  'un élément data-i18n ne contient que du texte');
for (const match of statics) used.set(match[3], used.get(match[3]) || 'texte');
for (const match of html.matchAll(/<\w+\b[^>]*\bdata-i18n-attr="([^"]+)"[^>]*>/g)) {
  for (const name of match[1].split(/\s+/)) {
    const value = new RegExp(`\\b${name}="([^"]*)"`).exec(match[0])?.[1];
    assert.ok(value, `attribut ${name} à traduire`);
    used.set(value, used.get(value) || 'texte');
  }
}
assert.ok(used.size > 250, `textes repérés : ${used.size}`);
for (const [french, kind] of used) {
  const translation = english.texts[french];
  assert.ok(translation !== undefined, `traduction anglaise manquante : « ${french} »`);
  if (kind === 'pluriel') {
    assert.ok(Array.isArray(translation) && translation.length === 2, `[singulier, pluriel] attendu : « ${french} »`);
    for (const form of translation) {
      assert.deepEqual(placeholders(form), placeholders(french), `paramètres de « ${form} »`);
    }
  } else {
    assert.equal(typeof translation, 'string', `texte simple attendu : « ${french} »`);
    assert.deepEqual(placeholders(translation), placeholders(french), `paramètres de « ${translation} »`);
  }
}
for (const french of Object.keys(english.texts)) {
  assert.ok(used.has(french), `traduction inutilisée (texte français modifié ?) : « ${french} »`);
}

// Les messages du serveur traduits existent toujours à l'identique.
const serverSources = ['server.js', 'scheduler.js', 'battle-vote.js', 'song-settings.js']
  .map(file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\\'/g, '\'')).join('\n');
for (const [french, translation] of Object.entries(english.errors)) {
  assert.ok(serverSources.includes(french), `message serveur introuvable : « ${french} »`);
  assert.equal(typeof translation, 'string');
}
const serverText = message => {
  if (english.errors[message]) return english.errors[message];
  for (const [pattern, text] of english.errorPatterns) {
    const match = pattern.exec(message);
    if (match) return text.replace(/\{(\d)\}/g, (all, index) => match[index] ?? all);
  }
  return null;
};
const thrown = work => { try { work(); } catch (error) { return error.message; } assert.fail('erreur attendue'); };
const ballot = new BattleVote({ minVoters: 5 });
assert.equal(serverText(thrown(() => ballot.propose({ personId: 'a', personName: 'Ana', eligiblePersonIds: ['a', 'b'],
  songs: [{ songId: 1, title: 'Titre' }], proposerChoice: 1 }))), 'A Battle can be suggested once 5 people are signed up.');
const sched = new Scheduler();
sched.join({ tableId: '7', name: 'Anne', headcount: 1 });
assert.equal(serverText(thrown(() => sched.join({ tableId: '7', name: 'Bruno' }))),
  'Table 7 is full (1 signed up for 1 places). If there are more of you, ask the bar to adjust.');
sched.setHeadcount('7', 3);
sched.join({ tableId: '7', name: 'Bruno' });
sched.join({ tableId: '7', name: 'Chloé' });
const fullTable = thrown(() => sched.join({ tableId: '7', name: 'Dan' }));
assert.match(serverText(fullTable), /^Table 7 is full \(3 signed up for 3 places\)/);
assert.ok(serverSources.includes('Recherche KaraFun impossible : ${e.message}'));
assert.equal(serverText('Recherche KaraFun impossible : délai dépassé'), 'KaraFun search failed: délai dépassé');
assert.equal(serverText('Catalogue KaraFun : HTTP 503'), 'KaraFun catalogue: HTTP 503');
// Catalogue refusé par les deux domaines KaraFun : texte clair, traduit, recherche encore possible.
assert.ok(serverSources.includes('Catalogue KaraFun indisponible pour le moment (refus HTTP ${e.status}). La recherche reste possible.'));
assert.equal(serverText('Catalogue KaraFun indisponible pour le moment (refus HTTP 403). La recherche reste possible.'),
  'The KaraFun catalogue is unavailable right now (HTTP 403 refusal). Search still works.');
for (const reason of ['délai dépassé', 'réponse illisible', 'réseau injoignable']) {
  assert.match(serverText(`Catalogue KaraFun indisponible pour le moment (${reason}). La recherche reste possible.`) || '',
    /^The KaraFun catalogue is unavailable right now \((timed out|unreadable answer|network unreachable)\)\. Search still works\.$/, reason);
}
console.log(`ok - ${used.size} textes de la page des chanteurs traduits en anglais, ${Object.keys(english.errors).length} messages du serveur`);

// ---------------------------------------------------------------- page réelle
class Element {
  constructor(id = '', text = '', attributes = {}) {
    this.id = id;
    this.hidden = false;
    this.value = '';
    this.textContent = text;
    this.innerHTML = '';
    this.className = '';
    this.dataset = {};
    this.listeners = {};
    this.attributes = { ...attributes };
    this.classList = { toggle() {} };
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  querySelector() { return new Element(); }
  querySelectorAll() { return []; }
  focus() {}
  select() {}
  scrollIntoView() {}
}

function boot({ languages, language, saved = null, translations = true, respond = () => null } = {}) {
  const elements = new Map();
  const get = id => elements.get(id) || (elements.set(id, new Element(id)), elements.get(id));
  // Éléments marqués dans la page, avec leur texte français d'origine.
  const marked = statics.map(match => {
    const id = /\bid="([^"]+)"/.exec(match[2])?.[1];
    const node = id ? get(id) : new Element();
    node.textContent = match[3];
    return node;
  });
  const markedAttributes = [...html.matchAll(/<\w+\b([^>]*\bdata-i18n-attr="([^"]+)"[^>]*)>/g)].map(match => {
    const attributes = {};
    for (const [, name, value] of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) attributes[name] = value;
    return attributes.id ? Object.assign(get(attributes.id), { attributes }) : new Element('', '', attributes);
  });
  const tabs = ['table', 'queue', 'catalog'].map(name => Object.assign(get(`nav-${name}`), { dataset: { tab: name } }));
  get('sheet').hidden = true;
  const document = {
    title: '', activeElement: null, hidden: false, listeners: {}, documentElement: { lang: 'fr' },
    getElementById: get,
    querySelector: () => new Element(),
    querySelectorAll(selector) {
      if (selector === '.tabs button') return tabs;
      if (selector === '[data-i18n]') return marked;
      if (selector === '[data-i18n-attr]') return markedAttributes;
      return [];
    },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    contains() { return true; },
  };
  const storage = new Map(saved ? [['kfLang', saved]] : []);
  const localStorage = { getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  const state = { table: { id: '1', name: 'Table 1', headcount: 4, activeCount: 2 },
    tablePeople: [{ id: 'alice', name: 'Alice', active: true, songs: [{ entryId: 'e1', songId: 1, title: 'Song 2' }], invites: [], inKaraFun: [] },
      { id: 'bob', name: 'Bob', active: true, songs: [], invites: [], inKaraFun: [] }],
    managedIds: ['alice'], people: [], waiting: [], catalogAvailable: true, rules: {},
    queue: [{ pos: 2, ids: ['alice'], singer: 'Alice · Table 1', title: 'Song 2', eta: Date.UTC(2026, 9, 1, 20, 5) },
      { pos: 3, ids: ['zoe'], singer: 'Zoé · En solo', singers: [{ id: 'zoe', name: 'Zoé', table: 'En solo', individual: true }], title: 'Solo song' }],
    stage: { ours: false, kind: 'battle', singer: 'Battle collective', title: 'We Are The Champions', artist: 'Queen' },
    next: null,
    battle: { id: 'b1', phase: 'voting', mode: 'songs', closesAt: Date.now() + 90000, voters: 1, eligible: 2, threshold: 2,
      noVotes: 0, eligiblePersonIds: ['alice'], votedPersonIds: [], songOptions: [{ songId: 9, title: 'Bohemian Rhapsody', artist: 'Queen', votes: 1 }] } };
  const requests = [];
  const fetch = async (url, options = {}) => {
    requests.push(url);
    const custom = respond(url, options);
    if (custom) return custom;
    if (url.startsWith('/api/state?')) return { ok: true, json: async () => state };
    if (url.startsWith('/api/catalog/categories?')) return { ok: true, json: async () => [{ name: 'Années 80', filter: 'pl_1' }] };
    throw new Error(`Requête inattendue : ${url}`);
  };
  let poll;
  const context = { document, fetch, localStorage, location: { pathname: '/t/1/secret', search: '' },
    window: { isSecureContext: false, scrollTo() {}, ...(translations ? { CLIENT_TRANSLATIONS: loaded.window.CLIENT_TRANSLATIONS } : {}) },
    navigator: { ...(languages ? { languages } : {}), ...(language ? { language } : {}) }, URLSearchParams,
    setInterval: fn => { poll = fn; }, setTimeout: () => 0, clearTimeout() {},
    console, Date, Number, String, Set, Array, JSON, Math };
  vm.runInNewContext(script, context, { filename: 'client.html' });
  return { get, document, storage, requests, state, poll: () => poll() };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const click = (node, target) => node.listeners.click({ target: { closest: selector => target(selector) } });

(async () => {
  // Téléphone en anglais : toute la page passe en anglais.
  let page = boot({ languages: ['en-US', 'fr-FR'] });
  await settle();
  const { get } = page;
  assert.equal(page.document.documentElement.lang, 'en');
  assert.equal(get('navTableLabel').textContent, 'My table');
  assert.equal(get('stageLabel').textContent, 'On stage', 'texte fixe de la page');
  assert.equal(get('firstName').attributes.placeholder, 'e.g. Mary', 'attribut traduit');
  assert.equal(get('conn').textContent, 'Live');
  assert.equal(get('stageWho').textContent, 'Group Battle', 'Battle ajoutée dans KaraFun');
  assert.equal(get('peopleCount').textContent, '2 here · 2 signed up');
  assert.match(get('peopleList').innerHTML, /THEIR LIST · 1 SONG</);
  assert.match(get('peopleList').innerHTML, /2nd in the queue · around \d\d:\d\d/);
  assert.match(get('peopleList').innerHTML, /aria-label="Add a song for Alice">＋ Song</, 'bouton court, intitulé complet (avec le prénom) pour les lecteurs d’écran');
  assert.match(get('queueList').innerHTML, /Zoé · Solo/, 'le groupe « En solo » est traduit');
  assert.match(get('queueList').innerHTML, /Alice · Table 1/);
  assert.match(get('battleText').textContent, /^Choose a song or “No Battle”\. Vote ends in \d:\d\d\. 1 voter out of 2; at least 2 needed\./);
  assert.match(get('battleVotes').innerHTML, /1 vote · leading/);
  assert.match(get('battleVotes').innerHTML, /0 votes</, '0 au pluriel en anglais');
  // Vote ouvert : la demande s'affiche en grand, en anglais.
  assert.equal(get('attention').hidden, false);
  assert.equal(get('attentionWho').textContent, 'For Alice');
  assert.equal(get('attentionTitle').textContent, 'Battle vote: the whole room sings!');
  assert.match(get('attentionText').innerHTML, /^Choose a song or “No Battle”\. <span id="attentionClock">Vote ends in \d:\d\d\.<\/span>$/);
  assert.match(get('attentionChoices').innerHTML, /Bohemian Rhapsody — Queen.*No Battle.*Later \(1 min\)/);
  assert.equal(page.document.title, '(1) Karaoke — my table');

  // Les erreurs du serveur sont traduites ; une erreur inconnue reste lisible.
  page = boot({ languages: ['de-DE'], respond: url => url === '/api/table/song/remove'
    ? { ok: false, status: 400, json: async () => ({ error: 'Ce titre est en cours d’envoi à KaraFun. Réessaie dans un instant.' }) }
    : url === '/api/table/confirm' ? { ok: false, status: 400, json: async () => ({ error: 'Erreur inédite.' }) }
    : url === '/api/table/person' ? { ok: false, status: 400, json: async () => ({ error: fullTable }) } : null });
  await settle();
  click(page.get('peopleList'), selector => selector === '[data-remove-song]' ? { dataset: { personId: 'alice', removeSong: 'e1' } } : null);
  await settle(); await settle();
  assert.equal(page.get('toast').textContent, 'This song is being sent to KaraFun. Try again in a moment.', 'autre langue que le français : anglais');
  click(page.get('peopleList'), selector => selector === '[data-confirm-person]' ? { dataset: { confirmPerson: 'alice' } } : null);
  await settle(); await settle();
  assert.equal(page.get('toast').textContent, 'Erreur inédite.');
  page.get('newName').value = 'Zed';
  page.get('addPersonForm').listeners.submit({ preventDefault() {} });
  await settle(); await settle();
  assert.equal(page.get('toast').textContent, 'Table 7 is full (3 signed up for 3 places). If there are more of you, ask the bar to adjust.',
    'message serveur avec valeurs, traduit par la page');

  // Téléphone en français, ou langue inconnue : français.
  for (const options of [{ languages: ['fr-CA', 'en-US'] }, { language: 'fr' }, {}]) {
    page = boot(options);
    await settle();
    assert.equal(page.document.documentElement.lang, 'fr', JSON.stringify(options));
    assert.equal(page.get('navTableLabel').textContent, 'Ma table');
    assert.equal(page.get('peopleCount').textContent, '2 présentes · 2 inscrites');
    assert.match(page.get('battleVotes').innerHTML, /0 voix</, '0 au singulier en français');
  }
  // Sans le fichier de traductions, la page reste entièrement en français.
  page = boot({ languages: ['en-GB'], translations: false });
  await settle();
  assert.equal(page.get('navTableLabel').textContent, 'Ma table');

  // Le choix fait sur le téléphone l'emporte sur sa langue, dans les deux sens.
  page = boot({ languages: ['en-US'], saved: 'fr' });
  await settle();
  assert.equal(page.get('stageLabel').textContent, 'Sur scène');
  page = boot({ languages: ['fr-FR'], saved: 'en' });
  await settle();
  assert.equal(page.get('stageLabel').textContent, 'On stage');

  // Bouton FR/EN : la page change sans rechargement et le choix est gardé.
  page = boot({ languages: ['fr-FR'] });
  await settle();
  const tab = page.get('nav-catalog');
  tab.listeners.click();
  await settle(); await settle();
  assert.match(page.get('catalogContent').innerHTML, /Choisis une sélection\..*Années 80/);
  click(page.get('langSwitch'), selector => selector === '[data-lang]' ? { dataset: { lang: 'en' } } : null);
  assert.equal(page.storage.get('kfLang'), 'en');
  assert.equal(page.document.documentElement.lang, 'en');
  assert.equal(page.get('stageLabel').textContent, 'On stage');
  assert.equal(page.get('conn').textContent, 'Live');
  assert.equal(page.get('navTableLabel').textContent, 'My table');
  assert.match(page.get('battleText').textContent, /^Choose a song/);
  assert.match(page.get('catalogContent').innerHTML, /Choose a selection\..*Années 80/, 'le catalogue affiché est redessiné');
  assert.match(page.get('catalogTarget').textContent, /^Choose a song, then who will sing it\./);
  assert.equal(page.get('searchInput').attributes.placeholder, 'e.g. Queen');
  click(page.get('langSwitch'), selector => selector === '[data-lang]' ? { dataset: { lang: 'fr' } } : null);
  assert.equal(page.storage.get('kfLang'), 'fr');
  assert.equal(page.get('stageLabel').textContent, 'Sur scène');
  assert.equal(page.get('searchInput').attributes.placeholder, 'Ex. Queen');
  assert.match(page.get('catalogContent').innerHTML, /Choisis une sélection\./);
  assert.ok(!page.requests.some(url => /lang/.test(url)), 'la langue reste sur le téléphone');
  console.log('ok - langue du téléphone, choix FR/EN gardé, page redessinée et erreurs du serveur traduites');
})().catch(error => { console.error(error); process.exitCode = 1; });
