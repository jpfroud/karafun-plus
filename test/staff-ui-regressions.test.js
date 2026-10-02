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
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const elements = new Map();
const get = id => elements.get(id) || (elements.set(id, new Element()), elements.get(id));
// Gestionnaires délégués de la page (× des recherches, +10 min…).
const documentListeners = {};
const document = { activeElement: null, hidden: false, getElementById: get,
  addEventListener: (name, listener) => { (documentListeners[name] ||= []).push(listener); } };
const documentEvent = (name, target) => (documentListeners[name] || []).forEach(listener => listener({ target }));
const singer = { id: 'alice', name: 'Alice', tableId: '1', active: true, songCount: 1,
  sung: 0, privateNote: 't-shirt rouge', verified: true };
let connected = true;
let manualChanges = [];
let queue = [];
let stage = null;
let tracked = [];
let extraSingers = [];
let battle = { phase: 'idle' };
let soloInvitations = [];
let presencePending = [];
let bootId = 'boot-1';
let restarting = false;
let closing = null;
let autoPlayHeld = false;
let spotifyView = null;
const stored = new Map();
const posts = [];
const state = () => ({
  kf: { ready: connected, connected, base: 'demo', code: '1234', queue: [], events: [] },
  karafun: { demo: true }, code: '1234',
  settings: { gap: 4, cap: 2, requirePresence: false, pushDelaySec: 10,
    playDelaySec: 8, auto: false, autoPlay: false, autoPlayHeld, tableRotation: false, weightedTables: false },
  spotify: spotifyView,
  tables: [{ id: '1', name: 'Table 1', headcount: 2, activeCount: 1, count: 1 },
    { id: '2', name: 'Table 2', headcount: 2, activeCount: 1, count: 1 },
    { id: 'Comptoir', name: 'En solo', individual: true, headcount: 40, activeCount: 0, count: 0 }],
  people: [singer, ...extraSingers], stage, tracked, ips: [], queue, blocked: [], log: [], manualChanges,
  soloInvitations, presencePending, bootId, restarting, closing,
  phoneBase: 'http://127.0.0.1:3000', port: 3000, avgSlotMin: 4,
  battle,
});
const response = data => ({ ok: true, json: async () => data });
// Recherches de titres : la réponse à « Abba » peut être retenue pour
// vérifier qu'une réponse en retard n'écrase pas la dernière.
const searches = [];
let releaseAbba = null;
const fetch = async (url, options = {}) => {
  if (url.startsWith('/api/staff/state')) return response(state());
  if (url.startsWith('/api/search?')) {
    const q = new URLSearchParams(url.split('?')[1]).get('q');
    searches.push(q);
    if (q === 'Abba') await new Promise(resolve => { releaseAbba = resolve; });
    if (q === 'Panne') return { ok: false, json: async () => ({ error: 'Catalogue KaraFun indisponible.' }) };
    return response(q === 'Abba' ? [{ songId: 7, title: 'Dancing Queen', artist: 'ABBA' }]
      : [{ songId: 42, title: 'Bohemian Rhapsody', artist: 'Queen' }]);
  }
  if (url.startsWith('/api/staff/closing') || url.startsWith('/api/staff/spotify') ||
      url.startsWith('/api/staff/battle/reset-cooldown')) {
    posts.push({ url, ...JSON.parse(options.body) });
    return response({ ok: true });
  }
  if (url.startsWith('/api/staff/person/identify')) {
    posts.push(JSON.parse(options.body));
    return response({ ok: true });
  }
  if (url.startsWith('/api/staff/solo-invite')) {
    soloInvitations = [{ id: 'one', tableId: 'Comptoir', expiresAt: Date.now() + 30 * 60 * 1000 }];
    return response({ id: 'one', url: 'https://bar.example/t/Comptoir/secret?invitation=private',
      qr: 'data:image/png;base64,abc', expiresAt: soloInvitations[0].expiresAt });
  }
  throw new Error(`Requête inattendue : ${url}`);
};
let poll;
const timers = new Map();
let timerId = 0;
// Fin de frappe : lance les recherches en attente (délai de 300 ms).
const finishTyping = () => {
  for (const [id, timer] of timers) if (timer.ms === 300) { timers.delete(id); timer.fn(); }
};
const context = { document, fetch, location: { search: '' }, window: {}, URL, URLSearchParams,
  localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) },
  setInterval: fn => { poll = fn; }, setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
  clearTimeout: id => timers.delete(id),
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
  assert.equal(get('issueSoloInvitation').disabled, false);
  await get('issueSoloInvitation').onclick();
  await settle();
  assert.equal(get('soloInviteDialog').open, true, 'le bar voit le QR individuel après sa création');
  assert.match(get('soloInviteQr').src, /^data:image\/png;base64,/);
  assert.match(get('soloInviteUrl').value, /\?invitation=private$/);
  assert.match(get('soloInvitationList').innerHTML, /data-solo-revoke="one"/,
    'le bar peut retrouver et annuler une invitation en attente');

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
  stage = { ours: true, ids: ['alice'], queueId: 'live', singer: 'Alice', title: 'Titre en cours' };
  extraSingers = [
    { id: 'same', name: 'Camille', tableId: '1', active: true },
    { id: 'other', name: 'Yannick', tableId: '2', active: true },
    { id: 'gone', name: 'Parti', tableId: '2', active: false },
  ];
  tracked = [{ queueId: 'following', ids: ['other'], startedAt: null }];
  poll();
  await settle();
  assert.equal(get('markDuoBox').hidden, false);
  assert.match(get('markDuoPartner').innerHTML, /Même table[\s\S]*Camille[\s\S]*Autres tables et personnes en solo[\s\S]*Yannick/,
    'un chanteur déjà chargé comme prochain titre KaraFun peut aussi chanter sur scène en duo');
  assert.doesNotMatch(get('markDuoPartner').innerHTML, /Parti/);
  battle = { phase: 'requested', selectedSong: { title: 'Titre Battle' },
    automation: { status: 'failed', failure: 'Permission Battle refusée par KaraFun pour cette télécommande.' } };
  poll();
  await settle();
  assert.match(get('battleStatus').textContent, /Ajout automatique impossible : Permission Battle refusée/,
    'un refus explicite ne doit pas être présenté comme un simple délai de confirmation');
  assert.doesNotMatch(get('battleStatus').textContent, /\.\./, 'la ponctuation du message reste lisible');

  // Alerte fermée : elle reste fermée pendant ce démarrage, revient après un redémarrage.
  battle = { phase: 'idle' };
  presencePending = ['Zoé'];
  poll();
  await settle();
  assert.match(get('staffAlerts').innerHTML, /Je suis là » pour Zoé[\s\S]*data-dismiss-alert="presence"/);
  const text = get('staffAlerts').innerHTML.match(/<span>([^<]*Zoé[^<]*)<\/span>/)[1];
  const alertBox = { querySelector: () => ({ textContent: text }) };
  const closeButton = { dataset: { dismissAlert: 'presence' }, closest: () => alertBox };
  get('staffAlerts').listeners.click({ target: { closest: selector => selector === '[data-dismiss-alert]' ? closeButton : null } });
  assert.doesNotMatch(get('staffAlerts').innerHTML, /Zoé/, 'l’alerte fermée disparaît');
  poll();
  await settle();
  assert.doesNotMatch(get('staffAlerts').innerHTML, /Zoé/, 'elle reste fermée tant que rien ne change');
  bootId = 'boot-2';
  poll();
  await settle();
  assert.match(get('staffAlerts').innerHTML, /Zoé/, 'après un redémarrage, la même alerte réapparaît');

  // Battle lancée par le bar : la recherche part pendant la frappe, sans
  // bouton « Chercher », comme l'ajout d'une chanson.
  assert.doesNotMatch(html, /id="battleLaunchFind"/, 'plus de bouton Chercher pour la Battle');
  const battleSearch = get('battleLaunchSearch');
  const battleResults = get('battleLaunchResults');
  battleSearch.value = 'Q';
  battleSearch.oninput();
  finishTyping();
  assert.match(battleResults.innerHTML, /au moins 2 lettres/);
  assert.deepEqual(searches, [], 'une seule lettre ne lance pas de recherche');
  battleSearch.value = 'Abb';
  battleSearch.oninput();
  battleSearch.value = 'Abba';
  battleSearch.oninput();
  assert.deepEqual(searches, [], 'la recherche attend la fin de la frappe');
  finishTyping();
  assert.deepEqual(searches, ['Abba'], 'une recherche pour le dernier texte tapé');
  battleSearch.value = 'Queen';
  battleSearch.oninput();
  let prevented = false;
  battleSearch.onkeydown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await settle(); await settle();
  finishTyping();
  assert.deepEqual(searches, ['Abba', 'Queen'], 'Entrée cherche tout de suite, sans recherche en double');
  assert.match(battleResults.innerHTML, /Bohemian Rhapsody[\s\S]*Lancer en Battle/);
  releaseAbba();
  await settle(); await settle();
  assert.doesNotMatch(battleResults.innerHTML, /Dancing Queen/, 'une réponse en retard n’écrase pas la dernière recherche');
  // Réponse en retard pendant l'attente de fin de frappe de la saisie suivante.
  // Regression: revue Codex de la PR #7 — le numéro de requête ne changeait
  // qu'au lancement différé.
  battleSearch.value = 'Abba';
  battleSearch.oninput();
  finishTyping();
  battleSearch.value = 'Queen';
  battleSearch.oninput();
  releaseAbba();
  await settle(); await settle();
  assert.doesNotMatch(battleResults.innerHTML, /Dancing Queen/, 'une réponse en retard ne s’affiche pas pendant la frappe suivante');
  finishTyping();
  await settle(); await settle();
  assert.match(battleResults.innerHTML, /Bohemian Rhapsody/);
  battleSearch.value = 'Panne';
  battleSearch.oninput();
  finishTyping();
  await settle(); await settle();
  assert.match(battleResults.innerHTML, /Catalogue KaraFun indisponible\./, 'une recherche en échec affiche la raison');
  assert.doesNotMatch(battleResults.innerHTML, /Lancer en Battle/, 'pas de bouton de lancement après un échec');
  battleSearch.value = '';
  battleSearch.oninput();
  assert.equal(battleResults.innerHTML, '', 'champ vidé : résultats effacés');

  // ---------------------------------------------------------------- v0.4
  connected = true;
  stage = { ours: true, kind: 'solo', queueId: 1, ids: ['alice'], singers: [{ name: 'Alice', table: 'Table 1' }], title: 'En cours' };
  queue = [
    { source: 'karafun', ours: true, pos: 1, singer: 'Bob', title: 'Avant', eta: Date.now(), ids: [] },
    { source: 'helper', ours: true, pos: 2, singer: 'Chloé', title: 'Trop tard', eta: Date.now(), ids: [], afterClosing: true, deferred: true },
  ];
  closing = { at: Date.now() + 600000, passed: false, full: true, fitCount: 1, afterCount: 1 };
  poll(); await settle();
  assert.equal(get('restartBtn').disabled, false, 'un titre joue : il peut être relancé');
  assert.match(get('qBody').innerHTML, /queue-closing" role="note">— Fermeture à/, 'séparateur lisible par un lecteur d’écran');
  assert.ok(get('qBody').innerHTML.indexOf('queue-closing') < get('qBody').innerHTML.indexOf('Trop tard'), 'le séparateur précède les titres après la fermeture');
  assert.match(get('qBody').innerHTML, /Pas prêt/, 'repère « Pas prêt » dans la file du bar');
  assert.match(get('closingPill').textContent, /File complète/);
  restarting = true;
  poll(); await settle();
  assert.equal(get('restartBtn').disabled, true, 'pas de seconde relance pendant la première');
  restarting = false;
  stage = { ...stage, kind: 'battle' };
  poll(); await settle();
  assert.equal(get('restartBtn').disabled, true, 'une Battle se relance depuis KaraFun');
  documentEvent('click', { closest: selector => selector === '[data-closing-extend]' ? { dataset: { closingExtend: '10' } } : null });
  await settle();
  assert.deepEqual(posts.at(-1), { url: '/api/staff/closing', extendMin: 10 }, '« +10 min » décale l’heure');
  const field = get('testQ');
  field.value = 'Queen';
  const clearButton = { dataset: { clearFor: 'testQ' }, hidden: false };
  documentEvent('click', { closest: selector => selector === '[data-clear-for]' ? clearButton : null });
  assert.equal(field.value, '', '× vide la recherche du bar');
  assert.equal(clearButton.hidden, true);
  // Retours de l'essai de la PR #10 : Spotify en fin de file et silence avant un titre.
  assert.equal(get('autoPlayHeldTxt').hidden, true, 'lecture automatique non suspendue : pas d’avis');
  autoPlayHeld = true;
  spotifyView = { configured: true, connected: true, clientId: '0123456789abcdef', autoResume: true, autoPause: true,
    resumeDelaySec: 0, pauseLeadSec: 2, player: null, lastAction: null, lastError: null };
  poll(); await settle();
  assert.equal(get('autoPlayHeldTxt').hidden, false, 'le bar voit que la lecture automatique attend « Lecture »');
  assert.equal(get('spotifyDelay').value, 0, 'un délai de 0 s s’affiche tel quel');
  assert.equal(get('spotifyLead').value, 2);
  get('spotifyDelay').value = '1'; get('spotifyLead').value = '3';
  get('spotifyAutoResume').checked = true; get('spotifyAutoPause').checked = true;
  get('spotifySaveOptions').onclick();
  await settle();
  const saved = posts.filter(post => post.url === '/api/staff/spotify').at(-1);
  assert.equal(saved.action, 'options');
  assert.equal(saved.resumeDelaySec, 1);
  assert.equal(saved.pauseLeadSec, 3);
  assert.match(html, /id="spotifyDelay" type="number" min="0"/, 'moins de 5 s permis');
  // Retour du bar : l'admin lève la pause entre Battles, seulement quand
  // une pause tourne vraiment.
  assert.match(html, /id="battleResetCooldown"[^>]*>Autoriser une nouvelle Battle maintenant</);
  battle = { phase: 'idle' };
  poll(); await settle();
  assert.equal(get('battleCooldownActions').hidden, true, 'sans pause, pas de bouton');
  battle = { phase: 'cooldown', cooldownUntil: Date.now() + 300000, automation: { status: 'released' } };
  poll(); await settle();
  assert.equal(get('battleCooldownActions').hidden, false, 'pause en cours : le bar peut la lever');
  assert.match(get('battleStatus').textContent, /Prochain vote possible dans/, 'le temps restant reste affiché');
  get('battleResetCooldown').onclick();
  await settle();
  assert.deepEqual(posts.at(-1), { url: '/api/staff/battle/reset-cooldown' });
  for (const [view, why] of [
    [{ phase: 'cooldown', cooldownUntil: null, automation: { status: 'manual' } }, 'Battle encore en cours'],
    [{ phase: 'cooldown', cooldownUntil: Date.now() + 300000, automation: { status: 'after' } }, 'prochain titre à lancer d’abord'],
    [{ phase: 'cooldown', cooldownUntil: Date.now() - 1000 }, 'pause déjà écoulée'],
    [{ phase: 'voting', closesAt: Date.now() + 60000, songOptions: [] }, 'vote en cours']]) {
    battle = view;
    poll(); await settle();
    assert.equal(get('battleCooldownActions').hidden, true, why);
  }
  battle = { phase: 'idle' };
  autoPlayHeld = false;
  console.log('Bar : connexion, repères chanteurs et recherche Battle à la frappe OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
