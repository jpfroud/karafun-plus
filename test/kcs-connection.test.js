'use strict';
// Connexion à la télécommande KaraFun (v1.4) : conflit de nom qui ne boucle
// plus, relances espacées, diagnostic de découverte, état lisible pour le bar
// et lignes du journal du serveur. Tout est simulé (faux WebSocket, faux
// fetch, horloge factice) : aucun réseau, aucun vrai code de télécommande.
const assert = require('node:assert/strict');
const { test } = require('node:test');

const { KaraFunBridge } = require('../karafun');

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url, protocol) {
    this.url = url; this.protocol = protocol; this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = {}; this.sent = []; this.closeCalls = 0;
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); }
  open() { this.readyState = FakeWebSocket.OPEN; this.dispatch('open'); }
  receive(message) { this.dispatch('message', { data: JSON.stringify(message) }); }
  serverClose(code) { this.readyState = FakeWebSocket.CLOSED; this.dispatch('close', { code }); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.closeCalls++; this.readyState = FakeWebSocket.CLOSED; }
}
FakeWebSocket.instances = [];

const KCS_URL = 'wss://kcs.exemple.invalid/remote?token=jeton-factice-000';
const CODE = '123456';
const page = (settings = { kcs_url: KCS_URL }) => `<script>var Settings = ${JSON.stringify(settings)};</script>`;
const ok = html => ({ ok: true, status: 200, text: async () => html });
const USED = { type: 'Error', payload: { type: 4, message: 'Username is already used' } };

function fakes(t, respond = () => ok(page())) {
  const saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
  FakeWebSocket.instances = [];
  const calls = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return respond(url, options); };
  t.after(() => { globalThis.WebSocket = saved.WebSocket; globalThis.fetch = saved.fetch; });
  return { calls, sockets: FakeWebSocket.instances };
}
const mockTime = t => t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const nameRequests = ws => ws.sent.filter(m => m.type === 'remote.UpdateUsernameRequest');

function bridgeFor(t, options = {}) {
  const lines = [];
  const bridge = new KaraFunBridge({ bases: ['https://kf.exemple.invalid'], log: line => lines.push(line), ...options });
  bridge.random = () => 0.5;
  t.after(() => bridge.disconnect());
  return { bridge, lines };
}

// KaraFun tient encore le nom : chaque demande reçoit « déjà utilisé », avec
// ou sans l'identifiant de la demande. Avance l'horloge seconde par seconde en
// ouvrant chaque nouveau WebSocket, comme le ferait KaraFun.
async function conflictFor(t, env, seconds, { echoId = false, from = 0 } = {}) {
  const answered = new Set();
  for (let s = 0; s < seconds; s++) {
    await flush();
    for (const ws of env.sockets) {
      if (ws.readyState === FakeWebSocket.CONNECTING) {
        ws.open();
        ws.receive({ type: 'core.AuthenticatedEvent', payload: {} });
      }
      if (ws.readyState !== FakeWebSocket.OPEN) continue;
      for (const request of nameRequests(ws)) {
        const key = `${env.sockets.indexOf(ws)}:${request.id}`;
        if (answered.has(key)) continue;
        answered.add(key);
        ws.receive(echoId ? { ...USED, id: request.id } : USED);
      }
      // KaraFun vivant : un Ping toutes les 5 s garde le chien de garde calme.
      if ((s + from) % 5 === 0) ws.receive({ id: 1000 + s, type: 'core.PingRequest', payload: {} });
    }
    t.mock.timers.tick(1000);
  }
}

test('nom occupé, Error sans identifiant : la connexion n’est pas coupée au bout de 8 s', async t => {
  mockTime(t);
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await conflictFor(t, env, 30);
  assert.equal(env.sockets.length, 1, 'un seul WebSocket pendant le conflit de nom');
  assert.equal(env.calls.length, 1, 'une seule découverte');
  assert.equal(bridge.events.some(e => e.name === 'connexion-perdue'), false);
  assert.ok(nameRequests(env.sockets[0]).length >= 7, 'le même nom est redemandé toutes les 4 s');
});

test('nom occupé : le changement de nom arrive vers 2 min, même si KaraFun coupe entre-temps', async t => {
  mockTime(t);
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  const name = bridge.username;
  bridge.connect(CODE);
  await conflictFor(t, env, 50);
  env.sockets.at(-1).serverClose(1006);
  await conflictFor(t, env, 60, { from: 50 });
  assert.equal(bridge.username, name, 'pas encore deux minutes : même nom');
  assert.equal(bridge.identityNotice, null);
  await conflictFor(t, env, 15, { from: 110 });
  assert.notEqual(bridge.username, name, 'le conflit est compté sur toute la durée, pas par WebSocket');
  assert.match(bridge.identityNotice, /s’appelle maintenant/);
  assert.ok(bridge.events.some(e => e.name === 'identity-changed'));
});

test('Reconnecter pendant le conflit ne remet pas l’horloge du changement de nom à zéro', async t => {
  mockTime(t);
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  const name = bridge.username;
  bridge.connect(CODE);
  await conflictFor(t, env, 60, { echoId: true });
  bridge.connect(CODE);
  await conflictFor(t, env, 65, { echoId: true, from: 60 });
  assert.notEqual(bridge.username, name, 'nom changé vers 2 min après le début du conflit, pas 3 min');
});

// ---------------------------------------------------------------------------
// Transport : réponses sans identifiant, demandes non critiques
// ---------------------------------------------------------------------------

const { KcsTransport } = require('../kcs-transport');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { maskCode, lockIdentity } = require('../karafun');

test('KcsTransport.settle : une réponse sans identifiant solde la plus ancienne demande du type', t => {
  mockTime(t);
  fakes(t);
  const transport = new KcsTransport(KCS_URL);
  t.after(() => transport.close());
  const timeouts = [];
  transport.on('request-timeout', type => timeouts.push(type));
  FakeWebSocket.instances[0].open();
  transport.send('remote.UpdateUsernameRequest', { username: 'A' });
  transport.send('remote.PlayRequest');
  transport.send('remote.UpdateUsernameRequest', { username: 'A' });
  assert.equal(transport.settle('remote.UpdateUsernameRequest'), true);
  assert.equal(transport.settle('remote.NextRequest'), false, 'aucune demande de ce type');
  t.mock.timers.tick(8000);
  assert.deepEqual(timeouts, ['remote.PlayRequest', 'remote.UpdateUsernameRequest'], 'seule la plus ancienne est soldée');
});

// Connexion complète jusqu'à « prêt ».
async function readyBridge(t, options = {}) {
  const env = fakes(t, options.respond);
  const { bridge, lines } = bridgeFor(t, options.bridge);
  bridge.connect(options.code || CODE);
  await flush();
  const ws = env.sockets.at(-1);
  ws.open();
  ws.receive({ type: 'core.AuthenticatedEvent', payload: {} });
  ws.receive({ id: 1, type: 'remote.UpdateUsernameResponse', payload: {} });
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1 } } });
  return { env, bridge, lines, ws };
}

test('demande de nom restée sans réponse : simple avertissement, la connexion reste prête', async t => {
  mockTime(t);
  const env = fakes(t);
  const { bridge, lines } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  const ws = env.sockets[0];
  ws.open();
  ws.receive({ type: 'core.AuthenticatedEvent', payload: {} });
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1 } } });
  assert.equal(bridge.connectionState().phase, 'ready', 'données reçues : prête même avant la réponse au nom');
  ws.receive({ type: 'core.AuthenticatedEvent', payload: {} });
  t.mock.timers.tick(8000);
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1 } } });
  t.mock.timers.tick(8000);
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1 } } });
  assert.equal(env.sockets.length, 1, 'pas de reconnexion pour une demande de nom sans réponse');
  assert.equal(bridge.ready, true);
  assert.equal(bridge.connectionState().phase, 'ready');
  assert.ok(bridge.events.some(e => e.name === 'sans-reponse' && e.data === 'remote.UpdateUsernameRequest'));
  assert.equal(lines.filter(l => /pas de réponse à remote\.UpdateUsernameRequest/.test(l)).length, 1, 'une seule ligne au journal');
  t.mock.timers.tick(16000);
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(env.calls.length, 2, 'un vrai silence de KaraFun relance toujours la connexion');
});

test('demande de nom sans réponse avant les données : la file attend toujours son nom', async t => {
  mockTime(t);
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  const ws = env.sockets[0];
  ws.open();
  ws.receive({ type: 'core.AuthenticatedEvent', payload: {} });
  t.mock.timers.tick(8000);
  assert.equal(bridge.connectionState().phase, 'waiting-name');
  assert.equal(env.sockets.length, 1);
});

// ---------------------------------------------------------------------------
// État de la connexion pour le bar (contrat C2) et journal du serveur
// ---------------------------------------------------------------------------

test('phases de la connexion jusqu’à « prêt », avec journal du serveur et code masqué', async t => {
  mockTime(t);
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcs-connexion-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const env = fakes(t);
  const { bridge, lines } = bridgeFor(t, { logDir });
  const seen = [];
  const look = () => { const c = bridge.connectionState(); if (seen.at(-1)?.phase !== c.phase) seen.push(c); };
  bridge.on('change', look);
  assert.equal(bridge.connectionState().label, 'KaraFun déconnecté');
  bridge.connect(CODE);
  look();
  await flush();
  const ws = env.sockets[0];
  look();
  t.mock.timers.tick(1000);
  ws.open();
  ws.receive({ type: 'core.AuthenticatedEvent', payload: {} });
  look();
  ws.receive({ id: 1, type: 'remote.UpdateUsernameResponse', payload: {} });
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1 } } });
  assert.deepEqual(seen.map(c => c.phase), ['discovering', 'opening', 'waiting-auth', 'waiting-name', 'waiting-data', 'ready']);
  assert.deepEqual(seen.map(c => c.level), ['wait', 'wait', 'wait', 'wait', 'wait', 'ok']);
  assert.equal(seen[0].label, 'Recherche de la télécommande KaraFun…');
  assert.equal(seen[1].label, 'Ouverture de la connexion à KaraFun…');
  assert.equal(seen[2].label, 'Connexion ouverte : KaraFun vérifie le code…');
  assert.equal(seen[3].label, `KaraFun reçoit le nom ${bridge.username}…`);
  assert.equal(seen[4].label, 'Connecté : réception de la file KaraFun…');
  const snap = bridge.snapshot().connection;
  assert.equal(snap.label, `KaraFun connecté (${bridge.username})`);
  assert.equal(snap.since, 1000);
  assert.equal(snap.attempt, 1);
  assert.equal(snap.protocol, 'kcs');
  assert.equal(snap.canRename, false);
  assert.equal(snap.alert, null);
  assert.equal(snap.retryAt, null);
  assert.deepEqual(lines, [
    'KaraFun : connexion ouverte (essai 1), attente de KaraFun.',
    `KaraFun : code accepté, demande du nom ${bridge.username}.`,
    `KaraFun : nom ${bridge.username} accepté.`,
    `KaraFun : prêt, file et lecture reçues en 1 s (essai 1, ${bridge.username}).`,
  ]);
  const opening = bridge.events.find(e => e.name === 'connexion');
  assert.deepEqual(opening.data, { base: 'https://kf.exemple.invalid', code: '••••56', essai: 1 });
  const found = bridge.events.find(e => e.name === 'discovery');
  assert.deepEqual(found.data, { host: 'kf.exemple.invalid', status: 200, keys: { Settings: true, kcs_url: true } },
    'présence des clés, jamais leurs valeurs');
  const journal = fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('');
  assert.equal(journal.includes(CODE), false, 'le code complet n’est jamais écrit');
  assert.equal(journal.includes('jeton-factice'), false);
  assert.match(journal, /"id":1,"data":\{\}/, 'identifiant des messages gardé pour le diagnostic');
  bridge.disconnect();
  assert.equal(bridge.connectionState().phase, 'idle');
});

test('socket ouvert : « injoignable » disparaît aussitôt, sans attendre la file', async t => {
  mockTime(t);
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  env.sockets[0].serverClose(1006);
  assert.equal(bridge.unreachable, true);
  t.mock.timers.tick(3000);
  await flush();
  env.sockets[1].open();
  assert.equal(bridge.unreachable, false);
  assert.equal(bridge.connectionState().phase, 'waiting-auth');
});

test('Ping et Timestamp de KaraFun : comptés, mais hors des 40 derniers événements', async t => {
  mockTime(t);
  const { bridge, ws } = await readyBridge(t);
  const before = bridge.events.length;
  for (let i = 0; i < 50; i++) ws.receive({ id: 100 + i, type: i % 2 ? 'core.PingRequest' : 'core.TimestampRequest', payload: {} });
  assert.equal(bridge.events.length, before, 'aucun battement dans la liste du diagnostic');
  const snap = bridge.snapshot();
  assert.equal(snap.pings, 100, 'requêtes et réponses comptées');
  assert.ok(snap.events.some(e => e.name === 'remote.StatusEvent'), 'les vrais événements restent visibles');
});

test('conflit de nom : compte à rebours, alerte et bouton pour le bar, journal de début et de fin', async t => {
  mockTime(t);
  const env = fakes(t);
  const { bridge, lines } = bridgeFor(t);
  const name = bridge.username;
  bridge.connect(CODE);
  await flush();
  const ws = env.sockets[0];
  ws.open();
  ws.receive({ type: 'core.AuthenticatedEvent', payload: {} });
  ws.receive(USED);
  // KaraFun reste vivant (Ping) mais ne répond plus aux demandes de nom.
  const alive = ms => { for (let i = 0; i < ms; i += 1000) { if (i % 5000 === 0) ws.receive({ id: 900 + i, type: 'core.PingRequest', payload: {} }); t.mock.timers.tick(1000); } };
  alive(40000);
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1 } } });
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  const c = bridge.snapshot().connection;
  assert.equal(c.phase, 'waiting-name', 'données reçues mais nom refusé : pas encore « prêt »');
  assert.equal(c.level, 'wait');
  assert.equal(c.label, `KaraFun garde encore l’ancienne connexion de ${name} : nouvel essai, changement de nom dans 1 min 20`);
  assert.deepEqual(c.nameConflict, { holder: name, since: 0, tries: 1, switchAt: 120000 });
  assert.equal(c.canRename, true);
  assert.match(c.alert, /prendre un autre nom maintenant/);
  alive(79000);
  assert.match(bridge.connectionState().label, /changement de nom dans 1 s$/);
  alive(1000);
  assert.match(bridge.connectionState().label, /changement de nom imminent$/);
  ws.receive({ id: 7, type: 'remote.UsernameUpdateEvent', payload: { username: name } });
  assert.equal(bridge.connectionState().phase, 'ready');
  assert.equal(bridge.nameConflictSince, null);
  assert.ok(lines.includes(`KaraFun : le nom ${name} est encore pris par une ancienne connexion ; même nom redemandé toutes les 4 s, autre nom dans 2 min si besoin.`));
  assert.ok(lines.some(l => /^KaraFun : conflit de nom terminé après 2 min \(\d+ refus\)\.$/.test(l)));
  ws.receive({ type: 'remote.UsernameUpdateEvent', payload: { username: 'Quelqu’un-d’autre' } });
  assert.equal(bridge.connectionState().phase, 'ready', 'le nom d’un autre participant ne compte pas');
});

test('changement de nom automatique : journal et conflit oublié', async t => {
  mockTime(t);
  const env = fakes(t);
  const { bridge, lines } = bridgeFor(t);
  const name = bridge.username;
  bridge.connect(CODE);
  await conflictFor(t, env, 125);
  assert.notEqual(bridge.username, name);
  assert.ok(lines.some(l => l.startsWith(`KaraFun : nom changé ${name} → ${bridge.username} (nom encore pris après 2 min`)));
});

test('« Prendre un autre nom maintenant » : nouveau nom demandé tout de suite ; refusé si le nom marche', async t => {
  mockTime(t);
  const { bridge, ws, lines } = await readyBridge(t);
  assert.throws(() => bridge.forceNewName(), /fonctionne : rien à changer/);
  const name = bridge.username;
  ws.receive(USED);
  bridge.forceNewName();
  assert.notEqual(bridge.username, name);
  assert.deepEqual(ws.sent.at(-1).payload, { username: bridge.username });
  assert.match(bridge.identityNotice, /À ta demande, la file s’appelle maintenant/);
  assert.equal(bridge.nameConflictSince, null);
  assert.ok(bridge.events.some(e => e.name === 'identity-changed' && e.data.byBar));
  assert.ok(lines.includes(`KaraFun : nom changé ${name} → ${bridge.username} (demande du bar).`));
  t.mock.timers.tick(4000);
  assert.equal(ws.sent.filter(m => m.type === 'remote.UpdateUsernameRequest').length, 2, 'l’ancienne relance est annulée');
});

test('« Prendre un autre nom » avant authentification : le nouveau nom servira à la prochaine demande', async t => {
  mockTime(t);
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  const ws = env.sockets[0];
  ws.open();
  bridge.forceNewName();
  assert.equal(ws.sent.length, 0);
  ws.receive({ type: 'core.AuthenticatedEvent', payload: {} });
  assert.equal(ws.sent.at(-1).payload.username, bridge.username);
});

// ---------------------------------------------------------------------------
// Connecter / Reconnecter et relances
// ---------------------------------------------------------------------------

test('Reconnecter : connexion prête gardée ; en cours depuis peu gardée ; bloquée relancée', async t => {
  mockTime(t);
  const { bridge, env, lines } = await readyBridge(t);
  assert.equal(bridge.connect(CODE), 'kept');
  assert.equal(env.sockets.length, 1, 'connexion prête : rien n’est coupé');
  assert.equal(env.sockets[0].closeCalls, 0);
  env.sockets[0].serverClose(1006);
  t.mock.timers.tick(3000);
  await flush();
  env.sockets[1].open();
  assert.equal(bridge.connect(CODE), 'kept', 'connexion qui démarre : gardée');
  t.mock.timers.tick(8000);
  env.sockets[1].receive({ id: 1, type: 'core.PingRequest', payload: {} });
  t.mock.timers.tick(8000);
  env.sockets[1].receive({ id: 2, type: 'core.PingRequest', payload: {} });
  assert.equal(bridge.connect(CODE), 'started', 'bloquée depuis plus de 15 s : nouvelle connexion');
  assert.equal(env.sockets[1].closeCalls, 1);
  assert.ok(lines.some(l => l.startsWith('KaraFun : Télécommande KaraFun déconnectée (code 1006).')));
});

test('Reconnecter pendant une attente de relance : nouvel essai immédiat', async t => {
  mockTime(t);
  const env = fakes(t, () => { throw new TypeError('fetch failed'); });
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  assert.equal(bridge.connectionState().phase, 'retry');
  assert.equal(bridge.connectionState().label, 'Réseau coupé : nouvel essai dans 3 s');
  assert.equal(bridge.connect(CODE), 'started');
  await flush();
  assert.equal(env.calls.length, 2);
  assert.equal(bridge.connectionState().label, 'Réseau coupé : nouvel essai dans 6 s (essai 3)', 'les échecs comptent toujours');
});

test('relances espacées : 3, 6, 12, 24 puis 30 s au plus, remises à zéro une fois prêt', async t => {
  mockTime(t);
  let failing = true;
  const env = fakes(t, () => { if (failing) throw new TypeError('fetch failed'); return ok(page()); });
  const { bridge, lines } = bridgeFor(t);
  bridge.connect(CODE);
  const delays = [];
  for (let i = 0; i < 6; i++) {
    await flush();
    const wait = bridge.retryAt - Date.now();
    delays.push(wait);
    if (i === 5) failing = false;
    t.mock.timers.tick(wait);
  }
  assert.deepEqual(delays, [3000, 6000, 12000, 24000, 30000, 30000]);
  assert.equal(lines.filter(l => l.startsWith('KaraFun : Réseau coupé')).length, 1, 'une même panne : une seule ligne');
  await flush();
  const ws = env.sockets.at(-1);
  ws.open();
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1 } } });
  assert.equal(bridge.connectionState().attempt, 7);
  ws.serverClose(1006);
  assert.equal(bridge.retryAt - Date.now(), 3000, 'après « prêt » : de nouveau 3 s');
  assert.equal(bridge.connectionState().label, 'KaraFun a fermé la connexion (code 1006) : nouvel essai dans 3 s',
    'les essais se recomptent depuis le dernier « prêt »');
  assert.ok(lines.at(-1).endsWith('Nouvel essai dans 3 s (essai 1).'));
  t.mock.timers.tick(3000);
  assert.equal(bridge.connectionState().attempt, 1);
});

test('une même panne réécrit une ligne toutes les 10 relances', async t => {
  mockTime(t);
  fakes(t, () => { throw new TypeError('fetch failed'); });
  const { bridge, lines } = bridgeFor(t);
  bridge.connect(CODE);
  for (let i = 0; i < 10; i++) {
    await flush();
    t.mock.timers.tick(bridge.retryAt - Date.now());
  }
  await flush();
  assert.equal(lines.length, 2);
});

test('relances dispersées : le hasard décale chaque délai de ±15 % au plus', async t => {
  mockTime(t);
  fakes(t, () => { throw new TypeError('fetch failed'); });
  const { bridge } = bridgeFor(t);
  bridge.random = () => 0;
  bridge.connect(CODE);
  await flush();
  assert.equal(bridge.retryAt - Date.now(), 3000, 'premier essai exact');
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(bridge.retryAt - Date.now(), 5100);
  bridge.random = () => 1;
  t.mock.timers.tick(5100);
  await flush();
  assert.equal(bridge.retryAt - Date.now(), 13800);
});

test('nouveau code : conflit de nom et compteur d’essais oubliés', async t => {
  mockTime(t);
  const { bridge, ws } = await readyBridge(t);
  ws.receive(USED);
  assert.notEqual(bridge.nameConflictSince, null);
  assert.equal(bridge.connect('654321'), 'started');
  assert.equal(bridge.nameConflictSince, null);
  assert.equal(bridge.connectionState().attempt, 1);
});

// ---------------------------------------------------------------------------
// Diagnostic de la découverte
// ---------------------------------------------------------------------------

for (const [name, respond, kind, pattern, minDelay] of [
  ['HTTP 403', () => ({ ok: false, status: 403, text: async () => 'Forbidden' }), 'refused',
    /^Le site KaraFun refuse ce PC \(HTTP 403\)/, 15000],
  ['HTTP 429', () => ({ ok: false, status: 429, text: async () => '' }), 'refused', /HTTP 429/, 15000],
  ['page de vérification anti-robot', () => ok('<title>Just a moment...</title><div id="cf-chl"></div>'), 'refused', /HTTP 200/, 15000],
  ['HTTP 502', () => ({ ok: false, status: 502, text: async () => '' }), 'http', /^Le site KaraFun répond mal \(HTTP 502\)/, 3000],
  ['délai dépassé', () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }, 'timeout', /ne répond pas à temps/, 3000],
  ['adresse KCS illisible', () => ok(page({ kcs_url: 'pas une adresse' })), 'bad-page', /inattendue/, 3000],
]) {
  test(`découverte : ${name} → message distinct`, async t => {
    mockTime(t);
    fakes(t, respond);
    const { bridge, lines } = bridgeFor(t);
    bridge.connect(CODE);
    await flush();
    assert.match(bridge.lastError, pattern);
    const failure = bridge.events.find(e => e.name === 'discovery-error');
    assert.equal(failure.data.kind, kind);
    assert.equal(bridge.retryAt - Date.now(), minDelay);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(`[${kind}`), 'nature de l’échec au journal du serveur');
    assert.equal(lines.join('').includes(CODE), false);
  });
}

test('découverte : en-têtes de navigateur, hôte final et clés notés sans leurs valeurs', async t => {
  mockTime(t);
  const env = fakes(t, () => ({ ok: true, status: 200, url: 'https://www.ailleurs.invalid/accueil', text: async () => '<html>Accueil</html>' }));
  const { bridge, lines } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  assert.equal(env.calls[0].options.headers.Accept.startsWith('text/html'), true);
  assert.match(env.calls[0].options.headers['Accept-Language'], /^fr-FR/);
  const failure = bridge.events.find(e => e.name === 'discovery-error').data;
  assert.equal(failure.kind, 'unknown-code');
  assert.equal(failure.finalHost, 'www.ailleurs.invalid', 'redirection visible');
  assert.deepEqual(failure.keys, { Settings: false, kcs_url: false });
  assert.match(lines[0], /\[unknown-code, HTTP 200, kf\.exemple\.invalid, → www\.ailleurs\.invalid, Settings absent, kcs_url absent\]/);
});

test('découverte : WebSocket indisponible sur ce PC', async t => {
  mockTime(t);
  fakes(t);
  globalThis.WebSocket = undefined;
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  assert.equal(bridge.lastError, 'WebSocket indisponible sur ce PC : le kit doit utiliser Node 22.');
  assert.equal(bridge.connectionState().label, 'WebSocket indisponible : nouvel essai dans 3 s');
  assert.equal(bridge.protocol, null);
});

test('maskCode : seuls les deux derniers chiffres restent', () => {
  assert.equal(maskCode('123456'), '••••56');
  assert.equal(maskCode('12 34 35'), '••••35');
  assert.equal(maskCode('12'), '••••');
  assert.equal(maskCode(null), '••••');
});

// ---------------------------------------------------------------------------
// Un seul programme par dossier data/
// ---------------------------------------------------------------------------

test('verrou du dossier data/ : un second programme prend un nom provisoire', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-verrou-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data', 'karafun-login.json');
  const lines = [];
  const first = new KaraFunBridge({ identityFile: file, lockOwner: { port: 3000 }, log: l => lines.push(l) });
  assert.equal(first.identityLock.ok, true);
  const name = first.username;
  const second = new KaraFunBridge({ identityFile: file, log: l => lines.push(l),
    lockOwner: { pid: process.pid + 1, port: 3010, alive: () => true } });
  assert.equal(second.identityLock.ok, false);
  assert.deepEqual(second.identityLock.holder, { pid: process.pid, port: 3000 });
  assert.match(second.identityNotice, /Une autre File karaoké tourne déjà depuis ce dossier \(port 3000\)/);
  assert.equal(second.identityFile, null, 'le nom provisoire n’est pas gardé');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).suffix, Number(name.slice(-4)), 'le nom du premier reste intact');
  assert.equal(lines.length, 1);
  second.releaseIdentity();
  assert.ok(fs.existsSync(`${file}.lock`), 'le second ne libère pas le verrou du premier');
  first.releaseIdentity();
  assert.equal(fs.existsSync(`${file}.lock`), false);
  first.releaseIdentity();
});

test('verrou abandonné, illisible ou dossier impossible : la file démarre quand même', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-verrou-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'karafun-login.json');
  const now = () => new Date().toISOString();
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, port: 3000, at: now() }));
  const stale = lockIdentity(file, { pid: 42, alive: () => false });
  assert.equal(stale.ok, true, 'programme arrêté brutalement : verrou repris');
  assert.equal(JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8')).pid, 42);
  assert.equal(lockIdentity(file, { pid: 42 }).ok, true, 'même processus : verrou à lui');
  fs.writeFileSync(`${file}.lock`, 'pas du json');
  assert.equal(lockIdentity(file, { pid: 43 }).ok, true, 'verrou illisible : repris');
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, at: now() }));
  const owner = lockIdentity(file, { pid: 44 });
  assert.equal(owner.ok, true, 'processus inexistant : verrou repris');
  owner.release();
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 7, at: new Date(Date.now() - 91000).toISOString() }));
  assert.equal(lockIdentity(file, { pid: 46, alive: () => true }).ok, true,
    'verrou plus rafraîchi depuis 90 s : repris, même si le numéro de processus sert ailleurs');
  const blocker = path.join(dir, 'fichier');
  fs.writeFileSync(blocker, 'x');
  const free = lockIdentity(path.join(blocker, 'sous', 'karafun-login.json'), { pid: 45 });
  assert.equal(free.ok, true, 'dossier impossible à écrire : pas de garde');
  free.release();
});

test('verrou rafraîchi toutes les 30 s tant que la file tourne', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.parse('2026-10-03T20:00:00Z') });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-verrou-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'karafun-login.json');
  const lock = lockIdentity(file, { pid: 50, port: 3000 });
  t.mock.timers.tick(30000);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8')).at, '2026-10-03T20:00:30.000Z');
  assert.equal(lockIdentity(file, { pid: 51, alive: () => true }).ok, false, 'verrou frais d’un programme vivant : respecté');
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 52, at: '2026-10-03T20:00:30.000Z' }));
  t.mock.timers.tick(30000);
  assert.equal(JSON.parse(fs.readFileSync(`${file}.lock`, 'utf8')).pid, 52, 'le verrou d’un autre n’est pas écrasé');
  lock.release();
  assert.ok(fs.existsSync(`${file}.lock`), 'ni supprimé');
});
