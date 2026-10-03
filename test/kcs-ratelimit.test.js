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

test('après un échec de découverte : 5 s, 15 s, 30 s, 1 min, 2 min, puis le budget réparti sur l’heure', async t => {
  const start = Date.parse('2026-10-02T15:00:00Z');
  mockTime(t, start);
  fakes(t, () => CLOSED);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  const delays = [];
  for (let i = 0; i < 9; i++) {
    await flush();
    delays.push(bridge.retryAt - Date.now());
    t.mock.timers.tick(bridge.retryAt - Date.now());
  }
  // 6 pages en 230 s : il reste 3 essais automatiques jusqu'à 17:00:32,5.
  const spread = Math.round((HOUR + 32500 - 230000) / 4);
  assert.deepEqual(delays.slice(0, 6), [5000, 15000, 30000, 60000, 120000, spread]);
  assert.ok(delays.slice(5).every(delay => delay >= 5 * MIN), 'jamais moins de 5 min ensuite');
  assert.equal(bridge.connectionState().discovery.used, 1, 'nouvelle heure pleine : budget neuf');
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
  while (bridge.connectionState().discovery.used < 9) await untilNextTry(t, bridge);
  await flush();
  assert.ok(bridge.retryAt >= Date.parse('2026-10-02T17:00:05Z'), 'budget automatique épuisé : heure pleine suivante');
  open = true;
  assert.equal(bridge.connect(CODE), 'started', 'il reste les 3 essais réservés au bar');
  await flush();
  assert.equal(env.calls.length, 10);
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

test('URL gardée injoignable (erreur puis fermeture) ou délai dépassé : oubliée, page relue', async t => {
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
  t.mock.timers.tick(0);
  await flush();
  assert.equal(env.calls.length, 2, 'erreur avant authentification : page relue');
  // KaraFun parle 12 s puis coupe : l'URL reste gardée, nouvel essai 3 s après.
  accept(env.sockets[2]);
  alive(env.sockets[2], 12000);
  env.sockets[2].serverClose(1006);
  assert.equal(bridge.retryAt - Date.now(), 3000);
  t.mock.timers.tick(3000);
  await flush();
  assert.equal(env.sockets.length, 4);
  assert.equal(env.calls.length, 2);
  // Cette fois le WebSocket ne s'ouvre jamais : le chien de garde coupe à 15 s.
  for (let i = 0; i < 8; i++) t.mock.timers.tick(2000);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(env.calls.length, 3, 'délai dépassé avant authentification : page relue');
  assert.ok(bridge.events.some(e => e.name === 'url-kcs-oubliee' && e.data.code === null));
});

test('URL toute neuve refusée avant authentification : nouvelles pages espacées, jamais en boucle', async t => {
  const start = Date.parse('2026-10-02T18:00:00Z');
  mockTime(t, start);
  const env = fakes(t);
  const { bridge } = bridgeFor(t);
  bridge.connect(CODE);
  const at = [];
  while (Date.now() < start + HOUR - 5 * MIN) {
    await flush();
    const ws = env.sockets.at(-1);
    if (ws && ws.readyState === FakeWebSocket.CONNECTING) { ws.open(); ws.serverClose(4403); at.push(Date.now()); }
    await untilNextTry(t, bridge);
  }
  assert.deepEqual(at.slice(1, 6).map((time, i) => time - at[i]), [5000, 15000, 30000, 60000, 120000]);
  assert.ok(env.calls.filter(call => hourOf(call.at) === hourOf(start)).length <= 9);
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
