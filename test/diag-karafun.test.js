'use strict';
// Diagnostic KaraFun (tools/diag-karafun.js, issue #20) : classement de la
// page de découverte partagé par la file et l'outil (classifyDiscovery), sortie
// de l'outil contre un faux site sur 127.0.0.1, puis lancement dans un vrai
// processus. Aucun test ne joint KaraFun : la garde ci-dessous rejette toute
// requête vers karafun.com ou karafun.fr, et le dernier test vérifie qu'aucune
// n'a été tentée.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

// Garde : posée avant tout chargement, sous les faux fetch des tests.
const blocked = [];
const realFetch = globalThis.fetch;
async function guardedFetch(input, init) {
  let host = '';
  try { host = new URL(String(input?.url ?? input)).hostname; } catch { /* adresse illisible : laissée à fetch */ }
  if (host.endsWith('karafun.com') || host.endsWith('karafun.fr')) {
    blocked.push(host);
    throw new TypeError('lecture de KaraFun interdite dans les tests');
  }
  return realFetch(input, init);
}
globalThis.fetch = guardedFetch;

const { KaraFunBridge, CHALLENGE, DISCOVERY_HEADERS, classifyDiscovery } = require('../karafun');
const { runDiag, main } = require('../tools/diag-karafun');

const root = path.join(__dirname, '..');
const CODE = '123456';
const KCS_URL = 'wss://kcs.exemple.invalid/remote?token=jeton-factice-diag';
const VALID = '<script>var Settings = {"kcs_url":"' + KCS_URL + '"};</script>';
const CHALLENGE_PAGE = '<title>Just a moment...</title><div id="cf-chl"></div>';
const STUB_BASE = 'https://kf.exemple.invalid';
const HOST = 'kf.exemple.invalid';
const ok = html => ({ ok: true, status: 200, text: async () => html });
const no = (status, headers) => ({ ok: false, status, text: async () => '', ...(headers ? { headers: new Headers(headers) } : {}) });
const K11 = { Settings: true, kcs_url: true };
const K10 = { Settings: true, kcs_url: false };
const K00 = { Settings: false, kcs_url: false };

// Textes attendus, recopiés de la spécification (et non de l'outil).
const USAGE = [
  'Usage : node tools/diag-karafun.js <code de télécommande KaraFun>',
  'Aucune page lue : le code doit contenir au moins un chiffre.',
];
const WARNING = 'Attention : cette lecture compte dans la limite horaire de KaraFun pour l\'adresse Internet de ce serveur '
  + '(KaraFun ne répond qu\'aux 20 à 40 premières pages de chaque heure pleine, www.karafun.com et www.karafun.fr confondus). '
  + 'La file n\'en est pas informée et peut en lire jusqu\'à 12 de plus dans la même heure. Ne lance pas cet outil en boucle.';
const AH = 'absent (la file attendrait l\'heure pleine suivante)';
const OK_VERDICT = 'KaraFun répond normalement à ce serveur. La migration peut continuer.';
const refusedVerdict = (status, challenge) => `KaraFun refuse ce serveur (HTTP ${status}, défi anti-robot ${challenge}). `
  + 'Ne déplace pas la file. Relance ce diagnostic une seule fois, au moins une heure plus tard : un second refus confirme '
  + 'que KaraFun bloque l\'adresse de ce serveur. Ne cherche pas à contourner ce refus.';
const unknownVerdict = status => `non concluant. KaraFun répond (HTTP ${status}) sans page de télécommande pour ce code : `
  + 'vérifie le code affiché dans KaraFun et que sa télécommande est activée, puis relance.';
const httpVerdict = status => `non concluant. Le site KaraFun répond mal (HTTP ${status}) : relance plus tard.`;
const BAD_PAGE_VERDICT = 'non concluant. Page de télécommande KaraFun inattendue : la file ne saurait pas la lire non plus. Relance plus tard.';
const NETWORK_VERDICT = 'non concluant. Site KaraFun injoignable depuis ce serveur : vérifie sa connexion Internet et son adresse IPv4 sortante.';
const TIMEOUT_VERDICT = 'non concluant. Le site KaraFun ne répond pas à temps : relance plus tard.';

// Faux fetch le temps d'un test (la garde revient ensuite) : rend ses appels.
function stubFetch(t, respond) {
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return respond(url, options); };
  t.after(() => { globalThis.fetch = guardedFetch; });
  return calls;
}

function capture() {
  const out = [], err = [];
  return { out, err, options: { out: line => out.push(line), err: line => err.push(line) } };
}

// Ni le code, ni l'URL KCS, ni le HTML dans ce que l'outil affiche.
function assertClean(stdout, stderr) {
  for (const text of [stdout, stderr]) {
    for (const secret of [CODE, 'jeton-factice-diag', 'wss:', 'Settings', '<script']) {
      assert.ok(!text.includes(secret), `sortie avec « ${secret} » : ${text}`);
    }
  }
}
const clean = io => assertClean(io.out.join('\n'), io.err.join('\n'));
const lineOf = (out, label) => out.find(line => line.startsWith(label));

function bridgeFor(t) {
  const bridge = new KaraFunBridge({ bases: [STUB_BASE] });
  bridge.code = CODE;
  t.after(() => bridge.disconnect());
  return bridge;
}

// --- A : classement d'une réponse, sans réseau ni état ----------------------

const CASES = {
  A1: ['KCS', () => ok(VALID), { status: 200, keys: K11, settings: { kcs_url: KCS_URL } }],
  A2: ['historique', () => ok('<script>var Settings = {"remote":true};</script>'), { status: 200, keys: K10, settings: { remote: true } }],
  A3: ['401', () => no(401), { status: 401, keys: K00, kind: 'refused', retryAfter: null }],
  A4: ['403', () => no(403), { status: 403, keys: K00, kind: 'refused', retryAfter: null }],
  A5: ['429 et Retry-After', () => no(429, { 'Retry-After': '120' }), { status: 429, keys: K00, kind: 'refused', retryAfter: '120' }],
  A6: ['défi en 200', () => ok(CHALLENGE_PAGE), { status: 200, keys: K00, kind: 'refused', retryAfter: null }],
  A7: ['KCS et le mot captcha', () => ok(VALID + '<p>captcha</p>'), { status: 200, keys: K11, settings: { kcs_url: KCS_URL } }],
  A8: ['404', () => no(404), { status: 404, keys: K00, kind: 'unknown-code' }],
  A9: ['410', () => no(410), { status: 410, keys: K00, kind: 'unknown-code' }],
  A10: ['502', () => no(502), { status: 502, keys: K00, kind: 'http' }],
  A11: ['page sans Settings', () => ok('<html>Accueil</html>'), { status: 200, keys: K00, kind: 'unknown-code' }],
  A12: ['Settings incomplet', () => ok('<script>var Settings = {"kcs_url":"wss://kcs.exemple.invalid/remote"</script>'),
    { status: 200, keys: K11, kind: 'bad-page' }],
  A13: ['kcs_url en https', () => ok('<script>var Settings = {"kcs_url":"https://kcs.exemple.invalid/remote"};</script>'),
    { status: 200, keys: K11, kind: 'bad-page' }],
  A14: ['kcs_url avec #', () => ok('<script>var Settings = {"kcs_url":"wss://kcs.exemple.invalid/remote#x"};</script>'),
    { status: 200, keys: K11, kind: 'bad-page' }],
  A17: ['redirection', () => ({ ok: true, status: 200, url: 'https://www.ailleurs.invalid/accueil', text: async () => '<html>Accueil</html>' }),
    { status: 200, finalHost: 'www.ailleurs.invalid', keys: K00, kind: 'unknown-code' }],
};

function classifyCase(id) {
  const [name, make, expected] = CASES[id];
  test(`${id} ${name} : classifyDiscovery rend le même classement deux fois, sans réseau ni modifier la réponse`, async t => {
    const calls = stubFetch(t, () => { throw new Error('fetch appelé par le classement'); });
    const response = make();
    const before = { ...response };
    const html = await response.text();
    const want = { host: HOST, ...expected };
    assert.deepEqual(classifyDiscovery(HOST, response, html), want);
    assert.deepEqual(classifyDiscovery(HOST, response, html), want);
    assert.deepEqual({ ...response }, before);
    assert.equal(calls.length, 0);
  });
}

for (const id of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'A11', 'A12', 'A13', 'A14']) classifyCase(id);

test('A15 délai dépassé : _discover classe timeout', async t => {
  const bridge = bridgeFor(t);
  const calls = stubFetch(t, () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); });
  assert.deepEqual(await bridge._discover(STUB_BASE), { host: HOST, kind: 'timeout' });
  assert.equal(calls.length, 1);
});

test('A16 réseau coupé : _discover classe network', async t => {
  const bridge = bridgeFor(t);
  const calls = stubFetch(t, () => { throw new TypeError('fetch failed'); });
  assert.deepEqual(await bridge._discover(STUB_BASE), { host: HOST, kind: 'network' });
  assert.equal(calls.length, 1);
});

classifyCase('A17');

// --- B, C : la file et l'outil partagent le même classement -----------------

test('B1 : _discover rend le classement de classifyDiscovery, lu à la même adresse avec une copie des en-têtes', async t => {
  const bridge = bridgeFor(t);
  let response;
  const calls = stubFetch(t, () => response);
  for (const id of ['A1', 'A4', 'A6', 'A17']) {
    calls.length = 0;
    response = CASES[id][1]();
    const found = await bridge._discover(STUB_BASE);
    assert.deepEqual(found, classifyDiscovery(HOST, response, await response.text()), id);
    // Même objet que le tableau A, après les autres classements : rien ne
    // reste d'un appel précédent (une redirection d'A17, par exemple).
    assert.deepEqual(found, { host: HOST, ...CASES[id][2] }, id);
    assert.equal(calls.length, 1, id);
    const [{ url, options }] = calls;
    assert.equal(url, 'https://kf.exemple.invalid/123456/', id);
    assert.deepEqual(options.headers, DISCOVERY_HEADERS, id);
    assert.notEqual(options.headers, DISCOVERY_HEADERS, `${id} : en-têtes partagés au lieu d'une copie`);
    assert.ok(options.signal instanceof AbortSignal, id);
  }
});

test('B2 : _discover n\'a plus de classement propre', () => {
  const source = KaraFunBridge.prototype._discover.toString().replace(/\r\n/g, '\n');
  assert.ok(source.endsWith('    return classifyDiscovery(info.host, response, html);\n  }'), source);
  for (const word of ['CHALLENGE', 'readSettings', 'retry-after', 'kcs_url']) assert.ok(!source.includes(word), word);
});

test('C1 : domaines de la file dans l\'ordre, en-têtes gelés, motif CHALLENGE sans état', t => {
  const bridge = new KaraFunBridge();
  t.after(() => bridge.disconnect());
  // Le premier est celui que lit runDiag par défaut (E3 : https://www.karafun.com/<code>/).
  assert.deepEqual(bridge.bases, ['https://www.karafun.com', 'https://www.karafun.fr']);
  assert.ok(Object.isFrozen(DISCOVERY_HEADERS));
  assert.equal(CHALLENGE.flags, 'i');
});

// --- D : l'outil contre un faux site sur 127.0.0.1 --------------------------

// Faux site : note chaque requête et répond par `handle`, fermé après le test.
async function fakeSite(t, handle) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handle(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const { port } = server.address();
  return { server, requests, base: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` };
}
const serve = (status, headers, body = '') => (req, res) => { res.writeHead(status, headers); res.end(body); };

async function diag(t, site, options = {}) {
  const io = capture();
  const code = await runDiag([CODE], { base: site.base, ...io.options, ...options });
  clean(io);
  assert.deepEqual(io.err, []);
  assert.equal(io.out.length, 9, io.out.join('\n'));
  return { code, out: io.out };
}

// Une seule page lue, à l'adresse et avec les en-têtes de la file.
function assertOneRead(site) {
  assert.equal(site.requests.length, 1);
  const [request] = site.requests;
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/123456/');
  assert.equal(request.headers.accept, DISCOVERY_HEADERS.Accept);
  assert.equal(request.headers['accept-language'], DISCOVERY_HEADERS['Accept-Language']);
}

function expected(site, { status, retryAfter = 'absent', challenge = 'non', page = 'non', server = 'absent', via = 'absent', verdict }) {
  return [
    `Diagnostic KaraFun : une seule lecture de la page de télécommande sur ${site.host}, sans WebSocket, sans rien écrire dans data/.`,
    WARNING,
    `Statut HTTP : ${status}`,
    `Retry-After : ${retryAfter}`,
    `Défi anti-robot : ${challenge}`,
    `Page de télécommande valide : ${page}`,
    `En-tête server : ${server}`,
    `En-tête via : ${via}`,
    `Verdict : ${verdict}`,
  ];
}

const D1_RESPONSE = serve(200, { Server: 'faux-karafun', Via: '1.1 varnish' }, VALID);
const d1Output = site => [
  `Diagnostic KaraFun : une seule lecture de la page de télécommande sur ${site.host}, sans WebSocket, sans rien écrire dans data/.`,
  WARNING,
  'Statut HTTP : 200',
  'Retry-After : absent',
  'Défi anti-robot : non',
  'Page de télécommande valide : oui',
  'En-tête server : faux-karafun',
  'En-tête via : 1.1 varnish',
  'Verdict : KaraFun répond normalement à ce serveur. La migration peut continuer.',
];

test('D1 page valide : sortie de référence, code 0, une seule page lue avec les en-têtes de la file', async t => {
  const site = await fakeSite(t, D1_RESPONSE);
  const { code, out } = await diag(t, site);
  assertOneRead(site);
  assert.deepEqual(out, d1Output(site));
  assert.equal(code, 0);
});

test('D2 défi anti-robot en HTTP 200 : refus, code 1', async t => {
  const site = await fakeSite(t, serve(200, {}, CHALLENGE_PAGE));
  const { code, out } = await diag(t, site);
  assertOneRead(site);
  assert.deepEqual(out, expected(site, { status: 200, retryAfter: AH, challenge: 'oui', verdict: refusedVerdict(200, 'oui') }));
  assert.equal(code, 1);
});

test('D3 403 avec Retry-After 120 : durée annoncée comme la file la lit, code 1', async t => {
  const site = await fakeSite(t, serve(403, { 'Retry-After': '120' }, 'Forbidden'));
  const { code, out } = await diag(t, site);
  assertOneRead(site);
  assert.deepEqual(out, expected(site, { status: 403, retryAfter: '120 (la file attendrait 120 s avant de relire la page)',
    verdict: refusedVerdict(403, 'non') }));
  assert.equal(code, 1);
});

test('D4 429 avec Retry-After de 5 h : ignoré comme par la file, code 1', async t => {
  const site = await fakeSite(t, serve(429, { 'Retry-After': '18000' }));
  const { code, out } = await diag(t, site);
  assertOneRead(site);
  assert.deepEqual(out, expected(site, { status: 429,
    retryAfter: '18000 (ignoré par la file : elle attendrait l\'heure pleine suivante)', verdict: refusedVerdict(429, 'non') }));
  assert.equal(code, 1);
});

test('D5 403 sans Retry-After : heure pleine suivante, code 1', async t => {
  const site = await fakeSite(t, serve(403, {}));
  const { code, out } = await diag(t, site);
  assertOneRead(site);
  assert.deepEqual(out, expected(site, { status: 403, retryAfter: AH, verdict: refusedVerdict(403, 'non') }));
  assert.equal(code, 1);
});

test('D6 404 : code inconnu, non concluant, code 2', async t => {
  const site = await fakeSite(t, serve(404, {}));
  const { code, out } = await diag(t, site);
  assertOneRead(site);
  assert.deepEqual(out, expected(site, { status: 404, verdict: unknownVerdict(404) }));
  assert.equal(code, 2);
});

test('D7 site muet : délai dépassé, non concluant en moins de 5 s, code 2', async t => {
  const site = await fakeSite(t, () => { /* jamais de réponse */ });
  const started = Date.now();
  const { code, out } = await diag(t, site, { timeoutMs: 300 });
  // gstack-timing-ok: la borne de 5 s est le contrat de D7 (issue #20), pour un délai de 300 ms.
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  assertOneRead(site);
  assert.deepEqual(out, expected(site, { status: 'aucune réponse (délai dépassé)', retryAfter: 'aucune réponse',
    challenge: 'non vérifié (aucune réponse)', server: 'aucune réponse', via: 'aucune réponse', verdict: TIMEOUT_VERDICT }));
  assert.equal(code, 2);
});

test('D8 port fermé : réseau coupé, non concluant, code 2', async t => {
  const site = await fakeSite(t, serve(200, {}, VALID));
  await new Promise(resolve => { site.server.close(() => resolve()); });
  const { code, out } = await diag(t, site, { timeoutMs: 5000 });
  assert.equal(site.requests.length, 0);
  assert.deepEqual(out, expected(site, { status: 'aucune réponse (réseau coupé ou site injoignable)', retryAfter: 'aucune réponse',
    challenge: 'non vérifié (aucune réponse)', server: 'aucune réponse', via: 'aucune réponse', verdict: NETWORK_VERDICT }));
  assert.equal(code, 2);
});

test('D9 502 avec Retry-After 30 : site en panne, valeur montrée telle quelle, code 2', async t => {
  const site = await fakeSite(t, serve(502, { 'Retry-After': '30' }));
  const { code, out } = await diag(t, site);
  assertOneRead(site);
  assert.deepEqual(out, expected(site, { status: 502, retryAfter: '30', verdict: httpVerdict(502) }));
  assert.equal(code, 2);
});

test('D10 kcs_url illisible : page inattendue, code 2', async t => {
  const site = await fakeSite(t, serve(200, {}, '<script>var Settings = {"kcs_url":"pas une adresse"};</script>'));
  const { code, out } = await diag(t, site);
  assertOneRead(site);
  assert.deepEqual(out, expected(site, { status: 200, verdict: BAD_PAGE_VERDICT }));
  assert.equal(code, 2);
});

test('D11 en-tête server avec tabulation et 302 caractères, via fait d\'espaces : nettoyé, coupé à 120 ou absent, code 0', async t => {
  // Via ne contient que des espaces : valeur vide une fois lue, affichée absent (point 5 de l'issue).
  const site = await fakeSite(t, serve(200, { Server: 'a\tb' + 'x'.repeat(300), Via: '   ' }, VALID));
  const { code, out } = await diag(t, site);
  assertOneRead(site);
  const server = 'a?b' + 'x'.repeat(117);
  assert.equal(server.length, 120);
  assert.deepEqual(out, expected(site, { status: 200, page: 'oui', server, verdict: OK_VERDICT }));
  assert.equal(code, 0);
});

test('D12 défi anti-robot en HTTP 403 : affiché comme défi, code 1', async t => {
  const site = await fakeSite(t, serve(403, {}, CHALLENGE_PAGE));
  const { code, out } = await diag(t, site);
  assertOneRead(site);
  assert.deepEqual(out, expected(site, { status: 403, retryAfter: AH, challenge: 'oui', verdict: refusedVerdict(403, 'oui') }));
  assert.equal(code, 1);
});

// --- E : l'outil dans ce processus, faux fetch -----------------------------

test('E1 sans argument : usage, aucune page lue, code 2', async t => {
  const calls = stubFetch(t, () => ok(VALID));
  const io = capture();
  assert.equal(await runDiag([], io.options), 2);
  clean(io);
  assert.deepEqual(io.err, USAGE);
  assert.deepEqual(io.out, []);
  assert.equal(calls.length, 0);
});

test('E2 code sans chiffre : usage, aucune page lue, code 2', async t => {
  const calls = stubFetch(t, () => ok(VALID));
  const io = capture();
  assert.equal(await runDiag(['abc'], io.options), 2);
  clean(io);
  assert.deepEqual(io.err, USAGE);
  assert.deepEqual(io.out, []);
  assert.equal(calls.length, 0);
});

async function diagDefault(t, args, response) {
  const calls = stubFetch(t, () => response);
  const io = capture();
  const code = await runDiag(args, io.options);
  clean(io);
  return { code, calls, io };
}

for (const [id, args] of [['E3', ['123456']], ['E4', ['12', '34', '56']]]) {
  test(`${id} ${JSON.stringify(args)} : une lecture sur www.karafun.com, réponse sans en-têtes, code 0`, async t => {
    const { code, calls, io } = await diagDefault(t, args, ok(VALID));
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://www.karafun.com/123456/');
    assert.ok(io.out[0].includes('sur www.karafun.com,'), io.out[0]);
    assert.equal(lineOf(io.out, 'Retry-After : '), 'Retry-After : absent');
    assert.equal(lineOf(io.out, 'En-tête server : '), 'En-tête server : absent');
    assert.equal(lineOf(io.out, 'En-tête via : '), 'En-tête via : absent');
    assert.deepEqual(io.err, []);
  });
}

test('E5 403 sans en-têtes : refus, Retry-After absent expliqué, code 1', async t => {
  const { code, io } = await diagDefault(t, ['123456'], { ok: false, status: 403, text: async () => 'Forbidden' });
  assert.equal(code, 1);
  assert.equal(lineOf(io.out, 'Retry-After : '), `Retry-After : ${AH}`);
  assert.equal(lineOf(io.out, 'En-tête server : '), 'En-tête server : absent');
  assert.equal(lineOf(io.out, 'En-tête via : '), 'En-tête via : absent');
  assert.deepEqual(io.err, []);
});

test('E6 en-têtes illisibles : absent, jamais une erreur, code 0', async t => {
  const response = { ok: true, status: 200, headers: { get() { throw new Error('en-têtes illisibles'); } }, text: async () => VALID };
  const { code, io } = await diagDefault(t, ['123456'], response);
  assert.equal(code, 0);
  assert.equal(lineOf(io.out, 'Retry-After : '), 'Retry-After : absent');
  assert.equal(lineOf(io.out, 'En-tête server : '), 'En-tête server : absent');
  assert.equal(lineOf(io.out, 'En-tête via : '), 'En-tête via : absent');
  assert.deepEqual(io.err, []);
});

test('E7 : aucune écriture de fichier ni WebSocket pendant un diagnostic', async t => {
  const site = await fakeSite(t, D1_RESPONSE);
  const writes = [
    t.mock.method(fs, 'writeFileSync'), t.mock.method(fs, 'appendFileSync'), t.mock.method(fs, 'renameSync'),
    t.mock.method(fs, 'mkdirSync'), t.mock.method(fs, 'openSync'),
    t.mock.method(fs.promises, 'writeFile'), t.mock.method(fs.promises, 'appendFile'),
  ];
  const savedWebSocket = globalThis.WebSocket;
  let sockets = 0;
  globalThis.WebSocket = class { constructor() { sockets++; } };
  t.after(() => { globalThis.WebSocket = savedWebSocket; });
  const { code, out } = await diag(t, site);
  for (const write of writes) assert.equal(write.mock.callCount(), 0);
  assert.equal(sockets, 0);
  assertOneRead(site);
  assert.deepEqual(out, d1Output(site));
  assert.equal(code, 0);
});

test('E8 adresse illisible : une ligne sans message d\'erreur, code 2, jamais rejetée', async t => {
  const calls = stubFetch(t, () => ok(VALID));
  const io = capture();
  assert.equal(await main(['123456'], { base: 'pas une adresse', ...io.options }), 2);
  clean(io);
  assert.deepEqual(io.err, ['Diagnostic interrompu : erreur inattendue (TypeError).']);
  assert.deepEqual(io.out, []);
  assert.equal(calls.length, 0);
});

// --- F : vrai processus -----------------------------------------------------

function runTool(args) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, { cwd: root, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('outil toujours lancé après 15 s')); }, 15000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, ms: Date.now() - started }); });
  });
}

test('F1 processus sans code : usage sur stderr, code de sortie 2', async () => {
  const run = await runTool(['tools/diag-karafun.js']);
  assertClean(run.stdout, run.stderr);
  // gstack-timing-ok: la borne de 15 s est le contrat de F1 (issue #20) ; au-delà, runTool arrête l'outil.
  assert.ok(run.ms < 15000);
  assert.equal(run.code, 2);
  assert.equal(run.stderr, USAGE.map(line => `${line}\n`).join(''));
  assert.equal(run.stdout, '');
});

test('F2 processus avec un fetch 403 préchargé : neuf lignes, code de sortie 1', async () => {
  const run = await runTool(['--require', path.join(root, 'test', 'fixtures', 'diag-fetch-403.js'), 'tools/diag-karafun.js', '123456']);
  assertClean(run.stdout, run.stderr);
  // gstack-timing-ok: la borne de 15 s est le contrat de F2 (issue #20) ; au-delà, runTool arrête l'outil.
  assert.ok(run.ms < 15000);
  assert.equal(run.code, 1);
  assert.ok(run.stdout.endsWith('\n'));
  const lines = run.stdout.slice(0, -1).split('\n');
  assert.equal(lines.length, 9, run.stdout);
  assert.ok(lines.includes('Statut HTTP : 403'), run.stdout);
  assert.equal(lines[8], `Verdict : ${refusedVerdict(403, 'non')}`);
  assert.equal(run.stderr, '');
});

// --- G : garde --------------------------------------------------------------

test('G1 : aucun test n\'a tenté de lire www.karafun.com ni www.karafun.fr', () => {
  assert.deepEqual(blocked, []);
});
