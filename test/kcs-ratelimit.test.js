'use strict';
// Limite horaire de la page de découverte KaraFun (soirée du 2 octobre) :
// KaraFun ne répond qu'aux 20 à 40 premières requêtes de chaque heure pleine
// depuis une même adresse, puis refuse tout jusqu'à l'heure pleine suivante.
// La file ne doit plus épuiser ce quota : budget horaire, cadence lente quand
// KaraFun est fermé, URL KCS gardée en mémoire pour les reconnexions, refus
// compris comme une limite, état clair pour le bar. Tout est simulé (faux
// WebSocket, faux fetch, horloge factice) : aucun réseau, aucun vrai code.
process.env.TZ = 'Europe/Paris';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  fail() { this.dispatch('error', {}); }
  serverClose(code) { this.readyState = FakeWebSocket.CLOSED; this.dispatch('close', { code }); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.closeCalls++; this.readyState = FakeWebSocket.CLOSED; }
}
FakeWebSocket.instances = [];

const HOUR = 3600000, MIN = 60000;
const CODE = '123456';
const NEW_CODE = '654321';
// Jeton factice propre à chaque code : il ne doit jamais être écrit.
const kcsUrl = code => `wss://kcs.exemple.invalid/remote?token=jeton-factice-${code}`;
const page = code => `<script>var Settings = ${JSON.stringify({ kcs_url: kcsUrl(code) })};</script>`;
const ok = html => ({ ok: true, status: 200, text: async () => html });
// KaraFun fermé : la page répond, sans paramètres de télécommande.
const CLOSED = ok('<html>Cette session est terminée</html>');
const refused = (headers = {}) => ({ ok: false, status: 429, headers: new Headers(headers), text: async () => '' });
const codeOf = url => /\/(\d+)\/$/.exec(url)[1];
const openPage = url => ok(page(codeOf(url)));

function fakes(t, respond = openPage) {
  const saved = { WebSocket: globalThis.WebSocket, fetch: globalThis.fetch };
  FakeWebSocket.instances = [];
  const calls = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (url, options) => { calls.push({ url, at: Date.now(), options }); return respond(url, options); };
  t.after(() => { globalThis.WebSocket = saved.WebSocket; globalThis.fetch = saved.fetch; });
  return { calls, sockets: FakeWebSocket.instances };
}
const mockTime = (t, now) => t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
// Hasard reproductible : la gigue varie d'un essai à l'autre.
const seeded = (seed = 7) => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

function bridgeFor(t, options = {}) {
  const lines = [];
  const bridge = new KaraFunBridge({ bases: ['https://www.kf-a.invalid', 'https://www.kf-b.invalid'], log: line => lines.push(line), ...options });
  bridge.random = () => 0.5;
  t.after(() => bridge.disconnect());
  return { bridge, lines };
}

// KaraFun accepte la connexion : code validé, nom accepté, file et lecture.
function accept(ws, { appLeft = false } = {}) {
  ws.open();
  ws.receive({ type: 'core.AuthenticatedEvent', payload: {} });
  ws.receive({ id: 1, type: 'remote.UpdateUsernameResponse', payload: {} });
  ws.receive({ type: 'remote.StatusEvent', payload: { status: { state: 1 } } });
  ws.receive({ type: 'remote.QueueEvent', payload: { queue: { items: [] } } });
  // KaraFun absent : le serveur KCS renvoie son dernier état puis AppLeftEvent.
  if (appLeft) ws.receive({ type: 'remote.AppLeftEvent', payload: {} });
}

// Avance jusqu'au prochain essai prévu (pas de WebSocket : pas d'intervalle).
async function untilNextTry(t, bridge) {
  await flush();
  const wait = bridge.retryAt - Date.now();
  assert.ok(Number.isFinite(wait) && wait >= 0, `essai prévu (${bridge.connectionState().phase})`);
  t.mock.timers.tick(wait);
  await flush();
}
const hourOf = at => Math.floor(at / HOUR);

// Avance l'horloge jusqu'au prochain essai ou jusqu'à `end`, en confiant
// chaque nouveau WebSocket à `onSocket`, et s'arrête dès que `done()` est vrai.
async function drive(t, bridge, env, { end = Infinity, onSocket = () => {}, done = () => false } = {}) {
  for (;;) {
    await flush();
    for (const ws of env.sockets) {
      if (ws.handled || ws.readyState !== FakeWebSocket.CONNECTING) continue;
      ws.handled = true;
      onSocket(ws);
      await flush();
    }
    if (done() || Date.now() >= end) return;
    const next = bridge.retryAt ?? Date.now() + 1000;
    t.mock.timers.tick(Math.max(0, Math.min(next, end) - Date.now()));
  }
}
// KaraFun fermé comme le 2 octobre : la page donne une URL KCS, puis le
// serveur KCS ferme le WebSocket (4403) avant toute authentification.
const rejectBeforeAuth = ws => { ws.open(); ws.serverClose(4403); };

// ---------------------------------------------------------------------------
// KaraFun fermé toute la journée
// ---------------------------------------------------------------------------

test('KaraFun fermé 24 h : au plus 12 pages par heure pleine dont 9 automatiques, 5 min d’écart en régime établi', async t => {
  const start = Date.parse('2026-10-02T00:17:00Z');
  mockTime(t, start);
  const env = fakes(t, () => CLOSED);
  const { bridge, lines } = bridgeFor(t);
  bridge.random = seeded();
  assert.equal(bridge.connect(CODE), 'started');
  while (Date.now() < start + 24 * HOUR) await untilNextTry(t, bridge);
  const perHour = new Map();
  for (const call of env.calls) perHour.set(hourOf(call.at), (perHour.get(hourOf(call.at)) || 0) + 1);
  for (const [hour, count] of perHour) {
    assert.ok(count <= 12, `heure ${hour} : ${count} pages`);
    const automatic = count - (hour === hourOf(start) ? 1 : 0);
    assert.ok(automatic <= 9, `heure ${hour} : ${automatic} pages automatiques`);
  }
  // Régime établi (à partir de la 2e heure pleine) : écarts réguliers.
  const steady = env.calls.filter(call => call.at >= (hourOf(start) + 2) * HOUR).map(call => call.at);
  const gaps = steady.slice(1).map((at, i) => at - steady[i]);
  assert.ok(Math.min(...gaps) >= 5 * MIN, `écart minimal ${Math.min(...gaps) / 1000} s`);
  assert.ok(Math.max(...gaps) <= 7.5 * MIN, `ouverture repérée en ${Math.max(...gaps) / 1000} s au plus`);
  assert.ok(env.calls.length >= 24 * 8, 'la file continue d’essayer toute la nuit');
  const state = bridge.connectionState();
  assert.equal(state.phase, 'retry');
  assert.equal(state.level, 'error');
  assert.match(state.label, /^KaraFun fermé ou code changé : prochain essai à \d\d:\d\d$/);
  assert.equal(state.discovery.limit, 12);
  assert.ok(state.discovery.used <= 12);
  assert.equal(state.discovery.hourEndsAt, (hourOf(Date.now()) + 1) * HOUR);
  assert.equal(state.discovery.limitedUntil, null);
  assert.ok(lines.length <= 30, `journal du serveur sobre : ${lines.length} lignes en 24 h`);
});

test('après un échec de découverte en milieu d’heure : 5 s, 15 s, 30 s, 1 min, 2 min, puis le budget réparti sur l’heure', async t => {
  const start = Date.parse('2026-10-02T15:30:00Z');
  mockTime(t, start);
  fakes(t, () => CLOSED);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  const delays = [];
  for (let i = 0; i < 10; i++) {
    await flush();
    delays.push(bridge.retryAt - Date.now());
    t.mock.timers.tick(bridge.retryAt - Date.now());
  }
  // 5 relances rapides en 230 s (le démarrage compte comme un clic) : les 4
  // essais automatiques restants et l'heure pleine (18:00:32,5) se partagent
  // les 1602,5 s qui restent, soit 320,5 s d'écart.
  assert.deepEqual(delays, [5000, 15000, 30000, 60000, 120000, 320500, 320500, 320500, 320500, 320500]);
  assert.equal(Date.now(), Date.parse('2026-10-02T16:00:32.500Z'));
  assert.equal(bridge.connectionState().discovery.used, 1, 'nouvelle heure pleine : budget neuf');
});

test('après un échec de découverte à l’heure pile : une seule relance rapide, puis 7 min d’écart au plus', async t => {
  // 5 s, 15 s, 30 s, 1 min et 2 min videraient 5 des 9 essais de l'heure en
  // 4 min : il n'en resterait que 4 pour 56 min (14 min d'écart). Seules les
  // relances qui laissent assez d'essais pour la fin de l'heure sont prises.
  const start = Date.parse('2026-10-02T15:00:00Z');
  mockTime(t, start);
  const env = fakes(t, () => CLOSED);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  const delays = [];
  while (Date.now() < start + HOUR) {
    await flush();
    delays.push(bridge.retryAt - Date.now());
    t.mock.timers.tick(bridge.retryAt - Date.now());
  }
  assert.equal(delays[0], 5000);
  assert.ok(delays.slice(1).every(delay => delay >= 5 * MIN && delay <= 7 * MIN), `écarts ${delays.map(d => d / 1000)}`);
  assert.equal(env.calls.filter(call => hourOf(call.at) === hourOf(start)).length, 10, '1 clic et 9 essais automatiques');
});

// ---------------------------------------------------------------------------
// Refus de KaraFun (401/403/429, page de défi) : une limite, pas une panne
// ---------------------------------------------------------------------------

const LIMIT_ALERT = until => `KaraFun limite les essais depuis cette connexion jusqu’à ${until} : inutile de cliquer, la file réessaiera seule. Un téléphone sur un autre réseau (4G/5G) n’est pas concerné.`;

test('page refusée (429) : plus aucune page avant l’heure pleine, clic refusé sans requête, alerte du bar', async t => {
  // 19:46:10 au bar (UTC+2).
  const start = Date.parse('2026-10-02T17:46:10Z');
  mockTime(t, start);
  let answer = () => refused();
  const env = fakes(t, url => answer(url));
  const { bridge, lines } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  const state = bridge.connectionState();
  const hour = Date.parse('2026-10-02T18:00:00Z');
  assert.equal(state.phase, 'retry');
  assert.equal(state.level, 'error');
  assert.equal(state.label, 'KaraFun limite les essais jusqu’à 20:00');
  assert.equal(state.alert, LIMIT_ALERT('20:00'));
  assert.equal(state.canRename, false);
  assert.deepEqual(state.discovery, { used: 1, limit: 12, hourEndsAt: hour, limitedUntil: hour });
  assert.equal(bridge.retryAt, hour + 32500, 'heure pleine suivante + gigue de 5 à 60 s');
  // Les clics du bar ne refont pas la page.
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(bridge.connect(CODE), { ok: false, reason: 'limited', message: LIMIT_ALERT('20:00') });
  }
  assert.equal(env.calls.length, 1);
  assert.equal(bridge.retryAt, hour + 32500, 'le clic ne déplace pas l’essai prévu');
  t.mock.timers.tick(hour + 32499 - Date.now());
  await flush();
  assert.equal(env.calls.length, 1, 'aucune page avant l’heure pleine suivante');
  answer = openPage;
  t.mock.timers.tick(1);
  await flush();
  assert.equal(env.calls.length, 2);
  accept(env.sockets.at(-1));
  assert.equal(bridge.connectionState().phase, 'ready');
  assert.equal(bridge.connectionState().alert, null);
  assert.equal(bridge.connectionState().discovery.limitedUntil, null);
  const failure = bridge.events.find(e => e.name === 'discovery-error').data;
  assert.equal(failure.kind, 'refused');
  assert.equal(failure.status, 429);
  assert.equal(failure.host, 'www.kf-a.invalid');
  assert.deepEqual(failure.pages, { used: 1, limit: 12 });
  assert.equal(failure.nextAt, new Date(hour + 32500).toISOString());
  assert.equal(failure.limitedUntil, new Date(hour).toISOString());
  assert.ok(lines.some(line => line.includes('[refused, HTTP 429')), 'limite au journal du serveur');
});

test('limite : un clic après l’heure pleine réessaie tout de suite ; un nouveau code aussi, avant', async t => {
  const start = Date.parse('2026-10-02T17:50:00Z');
  mockTime(t, start);
  const env = fakes(t, () => refused());
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  assert.equal(bridge.connect(NEW_CODE), 'started', 'nouveau code : essai tout de suite');
  await flush();
  assert.equal(env.calls.length, 2);
  assert.equal(codeOf(env.calls[1].url), NEW_CODE);
  t.mock.timers.tick(Date.parse('2026-10-02T18:00:05Z') - Date.now());
  assert.equal(bridge.connect(NEW_CODE), 'started', 'heure pleine passée : KaraFun a remis son compteur à zéro');
  await flush();
  assert.equal(env.calls.length, 3);
});

for (const [name, header, wait, label] of [
  ['en secondes', () => '120', 120000, '19:49'],
  ['en date HTTP', now => new Date(now + 10 * MIN).toUTCString(), 10 * MIN, '19:57'],
]) {
  test(`limite : Retry-After ${name} respecté`, async t => {
    const start = Date.parse('2026-10-02T17:47:00Z');
    mockTime(t, start);
    const env = fakes(t, () => refused({ 'Retry-After': header(start) }));
    const { bridge } = bridgeFor(t);
    bridge.connect(CODE);
    await flush();
    assert.equal(bridge.connectionState().discovery.limitedUntil, start + wait);
    assert.equal(bridge.connectionState().label, `KaraFun limite les essais jusqu’à ${label}`);
    assert.equal(bridge.retryAt, start + wait);
    assert.equal(bridge.connect(CODE).reason, 'limited');
    t.mock.timers.tick(wait - 1);
    await flush();
    assert.equal(env.calls.length, 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(env.calls.length, 2, 'nouvel essai à l’heure donnée par KaraFun');
  });
}

for (const value of ['bientôt', String(5 * 3600)]) {
  test(`limite : Retry-After « ${value} » ignoré (heure pleine suivante)`, async t => {
    mockTime(t, Date.parse('2026-10-02T17:47:00Z'));
    fakes(t, () => refused({ 'Retry-After': value }));
    const { bridge } = bridgeFor(t);
    bridge.connect(CODE);
    await flush();
    assert.equal(bridge.connectionState().discovery.limitedUntil, Date.parse('2026-10-02T18:00:00Z'));
    assert.equal(bridge.retryAt, Date.parse('2026-10-02T18:00:32.500Z'));
  });
}

for (const [name, respond] of [
  ['page de défi anti-robot', () => ok('<title>Just a moment...</title><div id="cf-chl"></div>')],
  ['HTTP 403', () => ({ ok: false, status: 403, text: async () => 'Forbidden' })],
  ['HTTP 401', () => ({ ok: false, status: 401, text: async () => '' })],
]) {
  test(`${name} : même limite que 429`, async t => {
    mockTime(t, Date.parse('2026-10-02T17:47:00Z'));
    fakes(t, respond);
    const { bridge } = bridgeFor(t);
    bridge.connect(CODE);
    await flush();
    assert.equal(bridge.connectionState().label, 'KaraFun limite les essais jusqu’à 20:00');
    assert.equal(bridge.connect(CODE).reason, 'limited');
  });
}

// ---------------------------------------------------------------------------
// KaraFun qui s'ouvre, clics du bar et budget
// ---------------------------------------------------------------------------

for (const opensAt of ['2026-10-02T17:45:00Z', '2026-10-02T17:59:30Z', '2026-10-02T18:23:41Z', '2026-10-02T19:08:12Z']) {
  test(`KaraFun ouvert à ${opensAt.slice(11, 19)} UTC après une nuit fermé : connexion automatique en moins de 7 min 30`, async t => {
    const start = Date.parse('2026-10-01T22:03:00Z');
    mockTime(t, start);
    const open = Date.parse(opensAt);
    const env = fakes(t, url => (Date.now() >= open ? openPage(url) : CLOSED));
    const { bridge } = bridgeFor(t);
    bridge.random = seeded(open / 1000 % 97 + 1);
    bridge.connect(CODE);
    while (!env.sockets.length) await untilNextTry(t, bridge);
    const took = Date.now() - open;
    assert.ok(took >= 0 && took <= 7.5 * MIN, `connexion ${took / 1000} s après l’ouverture`);
    accept(env.sockets[0]);
    assert.equal(bridge.connectionState().phase, 'ready');
  });
}

test('KaraFun ouvert : un clic connecte tout de suite tant qu’il reste du budget (réserve comprise)', async t => {
  const start = Date.parse('2026-10-02T16:10:00Z');
  mockTime(t, start);
  let open = false;
  const env = fakes(t, url => (open ? openPage(url) : CLOSED));
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  // Essais automatiques jusqu'à épuiser les 9 de l'heure.
  while (bridge.retryAt < Date.parse('2026-10-02T17:00:00Z')) await untilNextTry(t, bridge);
  await flush();
  assert.ok(bridge.retryAt >= Date.parse('2026-10-02T17:00:05Z'), 'budget automatique épuisé : heure pleine suivante');
  assert.equal(bridge.connectionState().discovery.used, 10, 'le démarrage (un clic) et 9 essais automatiques');
  open = true;
  assert.equal(bridge.connect(CODE), 'started', 'il reste 2 des 3 essais réservés au bar');
  await flush();
  assert.equal(env.calls.length, 11);
  accept(env.sockets[0]);
  assert.equal(bridge.connectionState().phase, 'ready');
});

test('budget total épuisé : le clic répond sans refaire la page et donne l’heure du prochain essai', async t => {
  const start = Date.parse('2026-10-02T17:20:00Z');
  mockTime(t, start);
  const env = fakes(t, () => CLOSED);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  for (let i = 0; i < 11; i++) {
    assert.equal(bridge.connect(CODE), 'started');
    await flush();
  }
  assert.equal(env.calls.length, 12);
  const next = Date.parse('2026-10-02T18:00:32.500Z');
  assert.equal(bridge.retryAt, next);
  const answer = bridge.connect(CODE);
  assert.deepEqual(answer, { ok: false, reason: 'budget',
    message: 'Trop d’essais auprès de KaraFun cette heure-ci : prochain essai automatique à 20:00.' });
  assert.equal(env.calls.length, 12);
  assert.equal(bridge.connectionState().label, 'KaraFun fermé ou code changé : prochain essai à 20:00');
  // Nouveau code sans budget : il est pris, l'essai attend l'heure pleine.
  assert.equal(bridge.connect(NEW_CODE).reason, 'budget');
  assert.equal(bridge.code, NEW_CODE);
  assert.equal(env.calls.length, 12);
  t.mock.timers.tick(next - Date.now());
  await flush();
  assert.equal(env.calls.length, 13);
  assert.equal(codeOf(env.calls[12].url), NEW_CODE);
});

// ---------------------------------------------------------------------------
// URL KCS gardée en mémoire
// ---------------------------------------------------------------------------

test('AppLeftEvent puis reconnexions : URL gardée, aucune page, relances 3, 6, 12, 24, 30 s', async t => {
  mockTime(t, Date.parse('2026-10-02T18:00:00Z'));
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  accept(env.sockets[0]);
  assert.equal(bridge.connectionState().phase, 'ready');
  env.sockets[0].receive({ type: 'remote.AppLeftEvent', payload: {} });
  const delays = [];
  for (let i = 0; i < 6; i++) {
    delays.push(bridge.retryAt - Date.now());
    t.mock.timers.tick(bridge.retryAt - Date.now());
    await flush();
    const ws = env.sockets.at(-1);
    assert.equal(ws.url, kcsUrl(CODE), 'même URL KCS, sans relire la page');
    // KaraFun redémarre : le serveur KCS accepte, renvoie son état, puis AppLeftEvent.
    accept(ws, { appLeft: true });
  }
  assert.deepEqual(delays, [3000, 6000, 12000, 24000, 30000, 30000]);
  t.mock.timers.tick(bridge.retryAt - Date.now());
  await flush();
  accept(env.sockets.at(-1));
  assert.equal(bridge.connectionState().phase, 'ready');
  assert.equal(env.calls.length, 1, 'une seule page pour toute la coupure');
  assert.equal(bridge.connectionState().discovery.used, 1);
  // KaraFun ouvert depuis longtemps puis coupure : de nouveau 3 s.
  for (let i = 0; i < 6; i++) { env.sockets.at(-1).receive({ id: 50 + i, type: 'core.PingRequest', payload: {} }); t.mock.timers.tick(2000); }
  env.sockets.at(-1).serverClose(1006);
  assert.equal(bridge.retryAt - Date.now(), 3000);
});

test('AppLeftEvent sans fin (URL peut-être périmée) : page relue une fois au bout de 20 reconnexions', async t => {
  mockTime(t, Date.parse('2026-10-02T18:00:00Z'));
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  accept(env.sockets[0], { appLeft: true });
  for (let i = 1; i < 20; i++) {
    t.mock.timers.tick(bridge.retryAt - Date.now());
    await flush();
    assert.equal(env.calls.length, 1, `reconnexion ${i} : URL gardée`);
    accept(env.sockets.at(-1), { appLeft: true });
  }
  assert.ok(bridge.events.some(e => e.name === 'url-kcs-oubliee' && e.data.cause === 'AppLeftEvent répétés'));
  t.mock.timers.tick(bridge.retryAt - Date.now());
  await flush();
  assert.equal(env.calls.length, 2, 'une seule page relue');
  assert.ok(Date.now() - Date.parse('2026-10-02T18:00:00Z') >= 8 * MIN, 'pas avant 8 min de KaraFun absent');
  accept(env.sockets.at(-1));
  assert.equal(bridge.connectionState().phase, 'ready');
});

test('URL gardée refusée avant authentification (4403) : une seule nouvelle découverte', async t => {
  mockTime(t, Date.parse('2026-10-02T18:00:00Z'));
  const env = fakes(t);
  const { bridge, lines } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  accept(env.sockets[0]);
  env.sockets[0].receive({ type: 'remote.AppLeftEvent', payload: {} });
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(env.calls.length, 1);
  env.sockets[1].open();
  env.sockets[1].serverClose(4403);
  await flush();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(env.calls.length, 2, 'URL oubliée : la page est relue une fois');
  accept(env.sockets[2]);
  assert.equal(bridge.connectionState().phase, 'ready');
  for (let i = 0; i < 30; i++) { env.sockets[2].receive({ id: 700 + i, type: 'core.PingRequest', payload: {} }); t.mock.timers.tick(2000); }
  await flush();
  assert.equal(env.calls.length, 2, 'pas d’autre page');
  assert.ok(bridge.events.some(e => e.name === 'url-kcs-oubliee' && e.data.code === 4403));
  assert.equal(lines.join('\n').includes('jeton-factice'), false);
});

// Erreur, coupure 1006 ou délai dépassé avant l'authentification : le réseau
// plutôt que l'URL (Wi-Fi qui saute). L'URL reste gardée, sans page ; seule
// une fermeture 44xx de KaraFun la fait oublier (voir aussi les 20 échecs).
test('URL gardée injoignable (erreur puis 1006) ou délai dépassé : gardée, réessayée sans page', async t => {
  mockTime(t, Date.parse('2026-10-02T18:00:00Z'));
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  const alive = (ws, ms) => { for (let i = 0; i < ms; i += 2000) { ws.receive({ id: 900 + i, type: 'core.PingRequest', payload: {} }); t.mock.timers.tick(2000); } };
  bridge.connect(CODE);
  await flush();
  accept(env.sockets[0]);
  env.sockets[0].serverClose(1006);
  t.mock.timers.tick(3000);
  await flush();
  env.sockets[1].fail();
  env.sockets[1].serverClose(1006);
  assert.equal(bridge.retryAt - Date.now(), 6000, 'erreur avant authentification : URL réessayée après 6 s');
  t.mock.timers.tick(6000);
  await flush();
  assert.equal(env.sockets[2].url, kcsUrl(CODE));
  assert.equal(env.calls.length, 1, 'pas de page');
  // Cette fois le WebSocket ne s'ouvre jamais : le chien de garde coupe à 15 s.
  for (let i = 0; i < 8; i++) t.mock.timers.tick(2000);
  await flush();
  assert.equal(bridge.connectionState().phase, 'retry');
  assert.equal(bridge.retryAt - Date.now(), 12000, 'délai dépassé : URL réessayée après 12 s');
  t.mock.timers.tick(12000);
  await flush();
  assert.equal(env.calls.length, 1, 'toujours pas de page');
  // KaraFun parle 12 s puis coupe : nouvel essai 3 s après.
  accept(env.sockets[3]);
  alive(env.sockets[3], 12000);
  env.sockets[3].serverClose(1006);
  assert.equal(bridge.retryAt - Date.now(), 3000);
  assert.equal(bridge.events.some(e => e.name === 'url-kcs-oubliee'), false);
});

test('URL toute neuve refusée avant authentification : nouvelles pages espacées, jamais en boucle', async t => {
  const start = Date.parse('2026-10-02T18:30:00Z');
  mockTime(t, start);
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  const at = [];
  while (Date.now() < start + 29 * MIN) {
    await flush();
    const ws = env.sockets.at(-1);
    if (ws && ws.readyState === FakeWebSocket.CONNECTING) { ws.open(); ws.serverClose(4403); at.push(Date.now()); }
    await untilNextTry(t, bridge);
  }
  assert.deepEqual(at.slice(1, 6).map((time, i) => time - at[i]), [5000, 15000, 30000, 60000, 120000]);
  assert.ok(env.calls.filter(call => hourOf(call.at) === hourOf(start)).length <= 10, '1 clic et 9 essais automatiques au plus');
  await drive(t, bridge, env, { onSocket: rejectBeforeAuth, done: () => bridge.connectionState().phase === 'retry' });
  assert.match(bridge.connectionState().label, /^KaraFun fermé ou code changé : prochain essai à \d\d:\d\d$/);
});

test('URL gardée mais WebSocket indisponible : URL oubliée, panne signalée, page relue 5 s plus tard', async t => {
  mockTime(t, Date.parse('2026-10-02T18:00:00Z'));
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  accept(env.sockets[0]);
  globalThis.WebSocket = undefined;
  env.sockets[0].receive({ type: 'remote.AppLeftEvent', payload: {} });
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(bridge.lastError, 'WebSocket indisponible sur ce PC : le kit doit utiliser Node 22.');
  assert.ok(bridge.events.some(e => e.name === 'url-kcs-oubliee'));
  assert.equal(bridge.retryAt - Date.now(), 5000);
  assert.equal(env.calls.length, 1);
});

test('nouveau code : URL oubliée, budget de l’heure conservé', async t => {
  mockTime(t, Date.parse('2026-10-02T18:10:00Z'));
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  accept(env.sockets[0]);
  assert.equal(bridge.connect(NEW_CODE), 'started');
  await flush();
  assert.equal(env.calls.length, 2, 'nouveau code : nouvelle page');
  assert.equal(codeOf(env.calls[1].url), NEW_CODE);
  assert.equal(env.sockets[1].url, kcsUrl(NEW_CODE));
  assert.equal(bridge.connectionState().discovery.used, 2, 'le compteur de l’heure n’est pas remis à zéro');
  accept(env.sockets[1]);
  env.sockets[1].receive({ type: 'remote.AppLeftEvent', payload: {} });
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(env.sockets[2].url, kcsUrl(NEW_CODE), 'l’URL de l’ancien code n’est plus utilisée');
  assert.equal(env.calls.length, 2);
});

test('Reconnecter sans connexion prête : essaie d’abord l’URL gardée, sans page ni budget', async t => {
  mockTime(t, Date.parse('2026-10-02T18:10:00Z'));
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  accept(env.sockets[0]);
  assert.equal(bridge.connect(CODE), 'kept', 'connexion prête gardée');
  env.sockets[0].serverClose(1006);
  assert.equal(bridge.connectionState().phase, 'retry');
  assert.equal(bridge.connect(CODE), 'started');
  await flush();
  assert.equal(env.sockets.length, 2);
  assert.equal(env.sockets[1].url, kcsUrl(CODE));
  assert.equal(env.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Journal : jamais le code ni l'URL KCS
// ---------------------------------------------------------------------------

test('journal et état : jamais le code ni l’URL KCS, une ligne par panne identique', async t => {
  const start = Date.parse('2026-10-02T17:30:00Z');
  mockTime(t, start);
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcs-limite-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  let answer = () => CLOSED;
  const env = fakes(t, url => answer(url));
  const { bridge, lines } = bridgeFor(t, { logDir });
  bridge.connect(CODE);
  for (let i = 0; i < 8; i++) await untilNextTry(t, bridge);
  const closedLines = lines.filter(line => line.includes('[unknown-code'));
  assert.equal(closedLines.length, 1, 'KaraFun fermé : une seule ligne, quel que soit le site essayé');
  assert.match(closedLines[0], /Page KaraFun : 1\/12 cette heure\. Nouvel essai dans 5 s/);
  answer = () => refused();
  await untilNextTry(t, bridge);
  answer = openPage;
  await untilNextTry(t, bridge);
  accept(env.sockets.at(-1));
  env.sockets.at(-1).receive({ type: 'remote.AppLeftEvent', payload: {} });
  t.mock.timers.tick(3000);
  await flush();
  env.sockets.at(-1).open();
  env.sockets.at(-1).serverClose(4403);
  t.mock.timers.tick(0);
  await flush();
  accept(env.sockets.at(-1));
  bridge.connect(NEW_CODE);
  await flush();
  accept(env.sockets.at(-1));
  const errors = bridge.events.filter(e => e.name === 'discovery-error');
  assert.ok(errors.length >= 9);
  for (const { data } of errors) {
    for (const key of ['kind', 'status', 'host', 'pages', 'nextAt']) assert.ok(key in data, `discovery-error.${key}`);
  }
  const journal = fs.readdirSync(logDir).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('');
  for (const text of [journal, lines.join('\n'), JSON.stringify(bridge.events)]) {
    for (const secret of [CODE, NEW_CODE, 'jeton-factice', 'kcs.exemple']) {
      assert.equal(text.includes(secret), false, `${secret} ne doit jamais être écrit`);
    }
  }
  // L'état du bar garde le code (champ de saisie), jamais l'URL KCS.
  const state = JSON.stringify(bridge.snapshot());
  assert.equal(state.includes('jeton-factice') || state.includes('kcs.exemple'), false);
});

// ---------------------------------------------------------------------------
// Constats de relecture : démarrage, coupure réseau, redémarrage du programme,
// bascule d'heure, Retry-After aberrant, WebSocket impossible, faute de frappe
// ---------------------------------------------------------------------------

for (const [startMin, afterMin] of [[0, 0.5], [0, 4], [0, 13], [2, 4], [2, 18], [10, 4], [10, 30], [45, 13], [55, 3]]) {
  test(`démarrage à H+${startMin} min, KaraFun ouvert ${afterMin} min après : connexion en moins de 7 min 30`, async t => {
    const start = Date.parse('2026-10-02T16:00:00Z') + startMin * MIN;
    mockTime(t, start);
    const open = start + afterMin * MIN;
    const env = fakes(t, url => (Date.now() >= open ? openPage(url) : CLOSED));
    const { bridge } = bridgeFor(t);
    bridge.random = seeded(startMin * 31 + afterMin * 7 + 3);
    bridge.connect(CODE);
    await drive(t, bridge, env, { done: () => env.sockets.length > 0 });
    const took = Date.now() - open;
    assert.ok(took >= 0 && took <= 7.5 * MIN, `connexion ${took / 1000} s après l’ouverture`);
    for (const hour of new Set(env.calls.map(call => hourOf(call.at)))) {
      assert.ok(env.calls.filter(call => hourOf(call.at) === hour).length <= 12);
    }
  });
}

test('nouveau code saisi pendant que KaraFun est fermé, ouverture 5 min plus tard : connexion en moins de 7 min 30', async t => {
  // 19:00 au bar : la file tourne avec l'ancien code, KaraFun fermé.
  const start = Date.parse('2026-10-02T17:00:00Z');
  mockTime(t, start);
  const open = Date.parse('2026-10-02T17:25:00Z');
  const env = fakes(t, url => (Date.now() >= open && codeOf(url) === NEW_CODE ? openPage(url) : CLOSED));
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await drive(t, bridge, env, { end: Date.parse('2026-10-02T17:20:00Z') });
  assert.equal(bridge.connect(NEW_CODE), 'started');
  await drive(t, bridge, env, { done: () => env.sockets.length > 0 });
  const took = Date.now() - open;
  assert.ok(took >= 0 && took <= 7.5 * MIN, `connexion ${took / 1000} s après l’ouverture`);
});

test('KaraFun fermé comme le 2 octobre (URL KCS puis fermeture 4403) : « KaraFun fermé ou code changé », 9 pages automatiques par heure', async t => {
  const start = Date.parse('2026-10-01T22:00:01Z');
  mockTime(t, start);
  const open = Date.parse('2026-10-02T17:47:13Z');
  const env = fakes(t);
  const { bridge, lines } = bridgeFor(t);
  bridge.random = seeded(11);
  bridge.connect(CODE);
  await drive(t, bridge, env, { end: start + 4 * HOUR, onSocket: rejectBeforeAuth });
  const state = bridge.connectionState();
  assert.equal(state.phase, 'retry');
  assert.equal(state.level, 'error');
  assert.match(state.label, /^KaraFun fermé ou code changé : prochain essai à \d\d:\d\d$/);
  assert.equal(state.alert, null);
  await drive(t, bridge, env, { onSocket: ws => (Date.now() >= open ? accept(ws) : rejectBeforeAuth(ws)),
    done: () => bridge.connectionState().phase === 'ready' });
  assert.ok(Date.now() - open <= 7.5 * MIN, `prête ${(Date.now() - open) / 1000} s après l’ouverture`);
  const perHour = new Map();
  for (const call of env.calls) perHour.set(hourOf(call.at), (perHour.get(hourOf(call.at)) || 0) + 1);
  for (const [hour, count] of perHour) assert.ok(count - (hour === hourOf(start) ? 1 : 0) <= 9, `heure ${hour} : ${count} pages`);
  // Une ligne d'ouverture et une ligne de panne toutes les 10 relances.
  assert.ok(lines.length <= 45, `journal du serveur sobre : ${lines.length} lignes en ${Math.round((Date.now() - start) / HOUR)} h`);
});

test('coupure du Wi-Fi de 90 s, 5 min puis 25 min : URL gardée, prête moins de 30 s après le retour du réseau', async t => {
  const start = Date.parse('2026-10-02T17:20:00Z');
  mockTime(t, start);
  let online = true;
  const env = fakes(t, url => { if (!online) throw new TypeError('fetch failed'); return openPage(url); });
  const { bridge } = bridgeFor(t);
  const onSocket = ws => { if (online) accept(ws); else { ws.fail(); ws.serverClose(1006); } };
  bridge.connect(CODE);
  await drive(t, bridge, env, { onSocket, done: () => bridge.connectionState().phase === 'ready' });
  for (const outage of [90000, 5 * MIN]) {
    online = false;
    env.sockets.at(-1).fail();
    env.sockets.at(-1).serverClose(1006);
    await drive(t, bridge, env, { onSocket, end: Date.now() + outage });
    online = true;
    const back = Date.now();
    await drive(t, bridge, env, { onSocket, done: () => bridge.connectionState().phase === 'ready' });
    assert.ok(Date.now() - back <= 30000, `coupure de ${outage / 1000} s : prête ${(Date.now() - back) / 1000} s après le retour du réseau`);
    assert.equal(env.calls.length, 1, 'aucune page pendant ni après la coupure');
  }
  // Longue coupure : après 20 échecs (environ 9 min), la page est lue pour
  // vérifier l'URL ; sans réponse (réseau coupé), l'URL reste gardée.
  online = false;
  env.sockets.at(-1).fail();
  env.sockets.at(-1).serverClose(1006);
  await drive(t, bridge, env, { onSocket, end: Date.now() + 25 * MIN });
  assert.equal(env.calls.length, 3, 'une vérification par la page toutes les 9 à 10 min');
  assert.ok(bridge.retryAt - Date.now() <= 30000, 'le WebSocket reste réessayé toutes les 30 s au plus');
  online = true;
  const back = Date.now();
  await drive(t, bridge, env, { onSocket, done: () => bridge.connectionState().phase === 'ready' });
  assert.ok(Date.now() - back <= 30000, `longue coupure : prête ${(Date.now() - back) / 1000} s après le retour du réseau`);
  assert.equal(env.sockets.at(-1).url, kcsUrl(CODE));
  assert.equal(bridge.events.some(e => e.name === 'url-kcs-oubliee'), false, 'URL jamais oubliée pendant la coupure');
});

test('URL gardée en échec 20 fois de suite sans refus de KaraFun : page relue une seule fois', async t => {
  mockTime(t, Date.parse('2026-10-02T17:20:00Z'));
  let failing = false;
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await drive(t, bridge, env, { onSocket: accept, done: () => bridge.connectionState().phase === 'ready' });
  failing = true;
  env.sockets.at(-1).serverClose(1006);
  let pagesSeen = [];
  await drive(t, bridge, env, {
    onSocket: ws => { pagesSeen.push(env.calls.length); if (failing && env.calls.length < 2) { ws.fail(); ws.serverClose(1006); } else accept(ws); },
    done: () => bridge.connectionState().phase === 'ready',
  });
  assert.equal(pagesSeen.filter(count => count === 1).length, 20, '20 essais par l’URL gardée, sans page');
  assert.equal(env.calls.length, 2, 'une seule page relue ensuite');
  assert.ok(bridge.events.some(e => e.name === 'url-kcs-oubliee' && e.data.cause === 'échecs répétés'));
});

test('relancer la file dans la même heure ne remet pas le budget à zéro : 12 pages au plus', async t => {
  const hour = Date.parse('2026-10-02T17:00:00Z');
  mockTime(t, hour + 40 * MIN);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcs-budget-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const budgetFile = path.join(dir, 'karafun-pages.json');
  const env = fakes(t, () => CLOSED);
  for (const stopAt of [45, 50, 55]) {
    const { bridge } = bridgeFor(t, { budgetFile });
    bridge.connect(CODE);
    await drive(t, bridge, env, { end: hour + (stopAt - 1) * MIN });
    for (let i = 0; i < 3; i++) { bridge.connect(CODE); await flush(); }
    await drive(t, bridge, env, { end: hour + stopAt * MIN });
    bridge.disconnect();
  }
  const { bridge } = bridgeFor(t, { budgetFile });
  bridge.connect(CODE);
  await drive(t, bridge, env, { end: hour + HOUR - 1 });
  const inHour = env.calls.filter(call => hourOf(call.at) === hourOf(hour)).length;
  assert.ok(inHour <= 12, `${inHour} pages entre 19:00 et 20:00 depuis ce PC`);
  assert.equal(bridge.connectionState().discovery.used, inHour, 'compteur repris du fichier');
  const saved = fs.readFileSync(budgetFile, 'utf8');
  assert.equal(saved.includes(CODE) || saved.includes('jeton'), false, 'ni code ni URL dans le fichier');
});

test('limite de KaraFun : gardée après un redémarrage du programme', async t => {
  const start = Date.parse('2026-10-02T17:47:00Z');
  mockTime(t, start);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcs-limite-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const budgetFile = path.join(dir, 'karafun-pages.json');
  let answer = () => refused();
  const env = fakes(t, url => answer(url));
  const first = bridgeFor(t, { budgetFile }).bridge;
  first.connect(CODE);
  await flush();
  first.disconnect();
  t.mock.timers.tick(2 * MIN);
  const { bridge } = bridgeFor(t, { budgetFile });
  assert.deepEqual(bridge.connect(CODE), { ok: false, reason: 'limited', message: LIMIT_ALERT('20:00') });
  assert.equal(env.calls.length, 1, 'pas de page en pleine limite au redémarrage');
  const state = bridge.connectionState();
  assert.equal(state.label, 'KaraFun limite les essais jusqu’à 20:00');
  assert.equal(state.alert, LIMIT_ALERT('20:00'));
  assert.equal(bridge.retryAt, Date.parse('2026-10-02T18:00:32.500Z'));
  answer = openPage;
  t.mock.timers.tick(bridge.retryAt - Date.now());
  await flush();
  assert.equal(env.calls.length, 2);
  accept(env.sockets.at(-1));
  assert.equal(bridge.connectionState().phase, 'ready');
  assert.equal(JSON.parse(fs.readFileSync(budgetFile, 'utf8')).limitUntil ?? null, null, 'limite levée dans le fichier');
});

test('429 reçu juste après l’heure pleine pour une requête partie avant : la limite ne dure pas une heure de plus', async t => {
  // Requête partie à 19:59:59,8 (bar), refus reçu à 20:00:00,1.
  const hour = Date.parse('2026-10-02T18:00:00Z');
  mockTime(t, hour - 200);
  let answer = () => refused();
  const env = fakes(t, url => new Promise(resolve => setTimeout(() => resolve(answer(url)), 300)));
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  t.mock.timers.tick(300);
  await flush();
  const state = bridge.connectionState();
  assert.notEqual(state.label, 'KaraFun limite les essais jusqu’à 21:00');
  assert.ok(bridge.retryAt < hour + 2 * MIN, `prochain essai ${new Date(bridge.retryAt).toISOString()}`);
  answer = openPage;
  assert.equal(bridge.connect(CODE), 'started', 'KaraFun a remis son compteur à zéro : le clic essaie');
  t.mock.timers.tick(300);
  await flush();
  assert.equal(env.calls.length, 2);
});

for (const [value, header] of [
  ['-5', () => '-5'], ['1.5', () => '1.5'], ['0', () => '0'],
  ['date passée', now => new Date(now - 2 * MIN).toUTCString()], ['1er janvier 1970', () => 'Thu, 01 Jan 1970 00:00:00 GMT'],
]) {
  test(`limite : Retry-After « ${value} » ignoré, la limite dure jusqu’à l’heure pleine`, async t => {
    const start = Date.parse('2026-10-02T17:47:00Z');
    mockTime(t, start);
    const env = fakes(t, () => refused({ 'Retry-After': header(start) }));
    const { bridge } = bridgeFor(t);
    bridge.connect(CODE);
    await flush();
    assert.equal(bridge.connectionState().discovery.limitedUntil, Date.parse('2026-10-02T18:00:00Z'));
    assert.equal(bridge.retryAt, Date.parse('2026-10-02T18:00:32.500Z'));
    assert.equal(bridge.connectionState().alert, LIMIT_ALERT('20:00'));
    assert.equal(bridge.connect(CODE).reason, 'limited');
    assert.equal(env.calls.length, 1);
  });
}

test('page lue mais WebSocket impossible à créer : la relance suit la cadence, pas 5 s à chaque fois', async t => {
  mockTime(t, Date.parse('2026-10-02T18:30:00Z'));
  const env = fakes(t);
  globalThis.WebSocket = undefined;
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  const delays = [];
  for (let i = 0; i < 3; i++) {
    await flush();
    delays.push(bridge.retryAt - Date.now());
    t.mock.timers.tick(bridge.retryAt - Date.now());
  }
  assert.deepEqual(delays, [5000, 15000, 30000]);
  assert.equal(env.calls.length, 4);
});

test('URL KCS avec fragment (#) : page inattendue, sans accuser la version de Node', async t => {
  mockTime(t, Date.parse('2026-10-02T18:30:00Z'));
  const env = fakes(t, () => ok(`<script>var Settings = ${JSON.stringify({ kcs_url: `${kcsUrl(CODE)}#f` })};</script>`));
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  assert.equal(env.sockets.length, 0);
  assert.equal(bridge.events.find(e => e.name === 'discovery-error').data.kind, 'bad-page');
  assert.doesNotMatch(bridge.lastError, /Node/);
});

test('budget de l’heure épuisé : un autre code (faute de frappe) ne coupe pas la connexion prête', async t => {
  mockTime(t, Date.parse('2026-10-02T17:20:00Z'));
  let open = false;
  const env = fakes(t, url => (open && codeOf(url) === CODE ? openPage(url) : CLOSED));
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  for (let i = 0; i < 10; i++) { bridge.connect(CODE); await flush(); }
  open = true;
  assert.equal(bridge.connect(CODE), 'started', '12e page : le dernier clic permis');
  await flush();
  accept(env.sockets[0]);
  assert.equal(bridge.connectionState().phase, 'ready');
  assert.equal(bridge.connectionState().discovery.used, 12);
  const answer = bridge.connect(NEW_CODE);
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'budget');
  assert.match(answer.message, /connexion actuelle est gardée/);
  assert.equal(bridge.code, CODE, 'le code qui marche reste en place');
  assert.equal(bridge.connectionState().phase, 'ready');
  assert.equal(env.sockets[0].closeCalls, 0, 'connexion prête jamais coupée');
  assert.equal(bridge.connect(CODE), 'kept', 'le bon code retapé : connexion gardée');
  assert.equal(env.calls.length, 12);
});

test('fichier du budget illisible, d’une autre heure ou à la limite démesurée : ignoré', async t => {
  const start = Date.parse('2026-10-02T17:30:00Z');
  mockTime(t, start);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcs-fichier-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const budgetFile = path.join(dir, 'karafun-pages.json');
  const env = fakes(t, () => CLOSED);
  for (const content of ['pas du JSON', JSON.stringify({ hour: hourOf(start) - 1, used: 12, auto: 9 }),
    JSON.stringify({ hour: hourOf(start), used: -3, auto: 'beaucoup', limitUntil: start + 5 * HOUR, limitRetryAt: start + 5 * HOUR })]) {
    fs.writeFileSync(budgetFile, content);
    const { bridge, lines } = bridgeFor(t, { budgetFile });
    assert.equal(bridge.connectionState().discovery.used, 0);
    assert.equal(bridge.connectionState().discovery.limitedUntil, null);
    assert.deepEqual(lines, [], 'rien de repris, rien à signaler');
    bridge.connect(CODE);
    await flush();
    assert.equal(bridge.connectionState().discovery.used, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(budgetFile, 'utf8')),
      { hour: hourOf(start), used: 1, auto: 0, limitUntil: null, limitRetryAt: null });
    bridge.disconnect();
  }
  // Programme relancé : le compte repris est annoncé au journal du serveur.
  const { bridge, lines } = bridgeFor(t, { budgetFile });
  assert.deepEqual(lines, ['KaraFun : page déjà lue 1/12 fois cette heure avant le redémarrage.']);
  assert.ok(bridge.events.some(e => e.name === 'budget-repris'));
  assert.equal(env.calls.length, 3);
});

test('budget épuisé pendant la simple recherche d’un code mal tapé : le code corrigé est pris, sans promettre de connexion gardée', async t => {
  mockTime(t, Date.parse('2026-10-02T17:20:00Z'));
  const env = fakes(t, url => (codeOf(url) === NEW_CODE ? new Promise(resolve => setTimeout(() => resolve(CLOSED), 1000)) : CLOSED));
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  await flush();
  for (let i = 0; i < 10; i++) { bridge.connect(CODE); await flush(); }
  assert.equal(bridge.connect(NEW_CODE), 'started', '12e page : le code mal tapé est cherché');
  await flush();
  assert.equal(bridge.connectionState().phase, 'discovering');
  const answer = bridge.connect(CODE);
  assert.equal(answer.reason, 'budget');
  assert.doesNotMatch(answer.message, /connexion actuelle est gardée/);
  assert.equal(bridge.code, CODE, 'le code corrigé est pris pour l’heure pleine');
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(bridge.code, CODE, 'la réponse de l’ancienne recherche est ignorée');
  assert.equal(env.calls.length, 12);
});
