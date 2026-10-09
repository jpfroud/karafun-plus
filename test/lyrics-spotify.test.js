'use strict';
// Paroles lues sur la page publique d'un titre KaraFun, et musique Spotify
// pendant les silences : tout est simulé, aucun accès réseau.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Lyrics, parsePage, songLinks, slug } = require('../lyrics');
const { SpotifyLink, SpotifyAutomation } = require('../spotify');

// Page inventée, au format observé sur www.karafun.fr (paroles fictives).
const page = (id, title, lines) => `<html><head><title>Karaoké ${title} - Chanson Karaoke Vidéo</title></head><body>
  <div class="lyrics js-lyrics" data-song-id="${id}" data-url="/ajax/lyrics.php">
  <div class="lyrics__content flex">${lines.map((line, index) =>
    `<p class="text4" data-original="${index ? '&#x0A;' : ''}${line.replace(/ /g, '&#x20;').replace(/'/g, '&#x27;')}" title="lyrics[${index}]">x</p>`).join('\n')}
  </div><div class="lyrics__action js-lyrics__action"></div></div>
  <form><p data-original="NE PAS LIRE"></p></form></body></html>`;

test('paroles : extraction ligne à ligne, adresses et liens de la page de recherche', () => {
  const parsed = parsePage(page(42, 'Ma chanson', ['Premier vers', 'C\'est le deuxième', '', '', 'Refrain']));
  assert.equal(parsed.songId, 42);
  assert.deepEqual(parsed.lines, ['Premier vers', 'C\'est le deuxième', '', 'Refrain'], 'un seul blanc entre couplets');
  assert.equal(slug('Pour que tu m\'aimes encore'), 'pour-que-tu-m-aimes-encore');
  assert.equal(slug('Céline Dion'), 'celine-dion');
  assert.deepEqual(songLinks('<a href="https://www.karafun.fr/karaoke/queen/">x</a><a href="https://www.karafun.fr/karaoke/queen/radio-ga-ga/">y</a><a href="https://evil.example/karaoke/a/b/">z</a><a href="/karaoke/queen/radio-ga-ga/">doublon</a>'),
    ['/karaoke/queen/radio-ga-ga/']);
});

test('paroles : identifiant vérifié, recherche si l’adresse devinée échoue, cache et panne', async () => {
  const calls = [];
  let down = false;
  const fetchImpl = async url => {
    calls.push(url);
    if (down) throw new Error('réseau coupé');
    const path = new URL(url).pathname + new URL(url).search;
    const html = path === '/karaoke/queen/ma-chanson/' ? page(7, 'Ma chanson', ['Vers A'])
      : path.startsWith('/search/') ? '<a href="/karaoke/film/ma-chanson-live/">a</a><a href="/karaoke/film/ma-chanson/">b</a>'
        : path === '/karaoke/film/ma-chanson/' ? page(8, 'Ma chanson', ['Vers B'])
          : path === '/karaoke/film/ma-chanson-live/' ? page(9, 'Ma chanson (Live)', ['Vers C']) : null;
    return html == null ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => html };
  };
  const lyrics = new Lyrics({ fetchImpl });
  const exact = await lyrics.find({ songId: 7, title: 'Ma chanson', artist: 'Queen' });
  assert.deepEqual(exact, { lines: ['Vers A'], url: 'https://www.karafun.fr/karaoke/queen/ma-chanson/', exact: true });
  const searched = await lyrics.find({ songId: 8, title: 'Ma chanson', artist: 'Autre interprète' });
  assert.equal(searched.url, 'https://www.karafun.fr/karaoke/film/ma-chanson/', 'la page exacte passe avant la version live');
  assert.equal(searched.exact, true);
  const before = calls.length;
  await lyrics.find({ songId: 8, title: 'Ma chanson', artist: 'Autre interprète' });
  assert.equal(calls.length, before, 'deuxième demande servie par le cache');
  const unknown = await lyrics.find({ songId: 999, title: 'Ma chanson', artist: 'Queen' });
  assert.equal(unknown.exact, false, 'autre identifiant : même titre gardé faute de mieux');
  assert.deepEqual(unknown.lines, ['Vers A']);
  down = true;
  const offline = await lyrics.find({ songId: 5, title: 'Inconnue', artist: 'Personne' });
  assert.equal(offline.lines, null);
  assert.match(offline.url, /^https:\/\/www\.karafun\.fr\/search\/\?query=Inconnue/);
});

function fakeSpotify({ playing = false } = {}) {
  const calls = [];
  const state = { playing, refreshes: 0, status: null };
  const json = (data, status = 200) => ({ ok: status < 300, status, json: async () => data, text: async () => JSON.stringify(data) });
  const fetchImpl = async (url, options = {}) => {
    calls.push(`${options.method || 'GET'} ${url.replace(/^https:\/\/[^/]+/, '')}`);
    if (url === 'https://accounts.spotify.com/api/token') {
      const form = new URLSearchParams(options.body);
      if (form.get('grant_type') === 'refresh_token') state.refreshes++;
      return json({ access_token: `jeton-${calls.length}`, expires_in: 3600, refresh_token: 'renouvellement' });
    }
    if (state.status) return json({ error: { status: state.status, message: 'No active device', reason: 'NO_ACTIVE_DEVICE' } }, state.status);
    if (url.endsWith('/me/player')) return json({ is_playing: state.playing, device: { id: 'pc', name: 'PC du bar' }, item: { name: 'Ambiance', artists: [{ name: 'DJ' }] } });
    if (url.includes('/me/player/play')) { state.playing = true; return { ok: true, status: 204, text: async () => '' }; }
    if (url.includes('/me/player/pause')) { state.playing = false; return { ok: true, status: 204, text: async () => '' }; }
    if (url.endsWith('/me/player/devices')) return json({ devices: [{ id: 'pc', name: 'PC du bar', type: 'Computer', is_active: true }] });
    throw new Error(`inattendu : ${url}`);
  };
  return { calls, state, fetchImpl };
}

test('Spotify : connexion PKCE sans secret, relance seulement si rien ne joue', async () => {
  const fake = fakeSpotify();
  let now = 1_000_000;
  const link = new SpotifyLink({ fetchImpl: fake.fetchImpl, now: () => now });
  assert.throws(() => link.authUrl('http://127.0.0.1:3000/spotify/callback'), /Client ID/);
  link.setClientId('0123456789abcdef0123456789abcdef');
  const url = new URL(link.authUrl('http://127.0.0.1:3000/spotify/callback'));
  assert.equal(url.searchParams.get('scope'), 'user-read-playback-state user-modify-playback-state');
  await assert.rejects(link.finishAuth({ code: 'c', state: 'autre' }), /expirée/);
  link.authUrl('http://127.0.0.1:3000/spotify/callback');
  await link.finishAuth({ code: 'c', state: link.pendingAuth.state });
  assert.equal(link.connected, true);
  const token = fake.calls.find(call => call.startsWith('POST /api/token'));
  assert.ok(token);
  assert.equal(await link.resume('silence'), 'done', 'Spotify était en pause : relancé');
  assert.equal(await link.resume('silence'), 'already', 'déjà en lecture : aucune commande');
  assert.equal(fake.calls.filter(call => call.startsWith('PUT /v1/me/player/play')).length, 1);
  assert.equal(await link.pause('karaoke'), 'done');
  assert.equal(await link.pause('karaoke'), 'already');
  link.setDevice('enceinte', 'Enceinte');
  await link.resume('silence');
  assert.ok(fake.calls.includes('PUT /v1/me/player/play?device_id=enceinte'), 'appareil choisi par le bar');
  now += 2 * 3600000;
  await link.readPlayer();
  assert.equal(fake.state.refreshes, 1, 'jeton renouvelé après expiration');
  fake.state.status = 404;
  await assert.rejects(link.pause('karaoke'), /Aucun appareil Spotify actif/);
  assert.match(link.view().lastError, /Aucun appareil/);
  assert.doesNotMatch(JSON.stringify(link.view()), /renouvellement/, 'le jeton n’est jamais montré');
  // Retour du bar : un silence de moins de 5 s avant la relance est permis.
  assert.throws(() => link.setOptions({ resumeDelaySec: -1 }), /entre 0 et 300/);
  link.setOptions({ resumeDelaySec: 2 });
  assert.equal(link.view().resumeDelaySec, 2);
});

test('Spotify : une action par silence ou par titre, jamais à l’aveugle si KaraFun est absent', () => {
  let now = 0;
  const auto = new SpotifyAutomation({ now: () => now });
  const opts = { autoResume: true, autoPause: true, resumeDelaySec: 15 };
  assert.equal(auto.step('unknown', opts), null, 'KaraFun déconnecté : rien');
  assert.equal(auto.step('singing', opts), 'pause', 'un titre démarre : pause');
  auto.settle(true);
  assert.equal(auto.step('singing', opts), null, 'une seule fois par titre');
  now = 1000;
  assert.equal(auto.step('silent', opts), null, 'transition entre deux titres');
  now = 15999;
  assert.equal(auto.step('silent', opts), null);
  now = 16000;
  assert.equal(auto.step('silent', opts), 'resume', 'silence prolongé : relance');
  auto.settle(false);
  assert.equal(auto.step('silent', opts), null, 'échec : nouvel essai plus tard');
  now += 30000;
  assert.equal(auto.step('silent', opts), 'resume');
  auto.settle(true);
  now += 60000;
  assert.equal(auto.step('silent', opts), null, 'le bar a pu couper la musique lui-même : on ne la relance pas');
  assert.equal(auto.step('singing', { ...opts, autoPause: false }), null, 'pause automatique désactivée');
  now += 1000;
  assert.equal(auto.step('silent', { ...opts, autoResume: false }), null, 'relance désactivée');
});

// Regression: retours de la soirée du 4 octobre — le contrôle de Spotify
// lâchait : identifiant d'appareil périmé (404 sur la lecture, la liste
// retombait sur « Appareil actif »), 204 affiché en vert, erreur ancienne
// jamais effacée. Faux Spotify avec une liste d'appareils modifiable.
function deviceSpotify({ devices = [], active = null, playing = false } = {}) {
  const calls = [];
  const state = { devices, active, playing, down: false, grant: true };
  const json = (data, status = 200) => ({ ok: status < 300, status, headers: { get: () => null },
    json: async () => data, text: async () => JSON.stringify(data) });
  const empty = { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
  const notFound = () => json({ error: { status: 404, message: 'Device not found', reason: 'NO_ACTIVE_DEVICE' } }, 404);
  const fetchImpl = async (url, options = {}) => {
    const route = url.replace(/^https:\/\/[^/]+/, '');
    calls.push({ method: options.method || 'GET', route, body: options.body });
    if (state.down) throw new TypeError('fetch failed');
    if (route === '/api/token') return state.grant ? json({ access_token: 'jeton', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
    const device = state.devices.find(d => d.id === state.active);
    if (route === '/v1/me/player/devices') return json({ devices: state.devices.map(d => ({ ...d, is_active: d.id === state.active })) });
    if (route === '/v1/me/player' && (options.method || 'GET') === 'GET') {
      return device ? json({ is_playing: state.playing, device: { id: device.id, name: device.name } }) : empty;
    }
    if (route === '/v1/me/player' && options.method === 'PUT') {
      const body = JSON.parse(options.body);
      if (!state.devices.some(d => d.id === body.device_ids[0])) return notFound();
      state.active = body.device_ids[0];
      state.playing = !!body.play;
      return empty;
    }
    if (route.startsWith('/v1/me/player/play')) {
      const id = new URL(url).searchParams.get('device_id') || state.active;
      if (!id || !state.devices.some(d => d.id === id)) return notFound();
      state.active = id; state.playing = true;
      return empty;
    }
    throw new Error(`inattendu : ${route}`);
  };
  return { calls, state, fetchImpl };
}

function linkedTo(fake, config = {}, extra = {}) {
  const link = new SpotifyLink({ fetchImpl: fake.fetchImpl, ...extra });
  link.config = { ...link.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'r', ...config };
  return link;
}

test('Spotify : identifiant d’appareil périmé, l’appareil du même nom est repris, enregistré et la lecture repart', async () => {
  const fake = deviceSpotify({ devices: [{ id: 'pc-NEW', name: 'PC du bar', type: 'Computer' }] });
  const logs = [];
  const link = linkedTo(fake, { deviceId: 'pc-OLD', deviceName: 'PC du bar', deviceType: 'Computer' }, { log: m => logs.push(m) });
  assert.equal(await link.resume(), 'done', 'la lecture repart sans le bar');
  assert.equal(link.config.deviceId, 'pc-NEW', 'nouvel identifiant enregistré');
  assert.equal(link.config.deviceName, 'PC du bar', 'le nom n’est jamais effacé');
  assert.ok(logs.includes('Appareil Spotify retrouvé : PC du bar'), logs.join('\n'));
  const transfer = fake.calls.find(c => c.method === 'PUT' && c.route === '/v1/me/player');
  assert.deepEqual(JSON.parse(transfer.body), { device_ids: ['pc-NEW'], play: true }, 'un seul nouvel essai, par transfert');
  assert.equal(fake.calls.filter(c => c.method === 'PUT').length, 2, '404 puis un seul nouvel essai');
  assert.equal(link.view().health.state, 'ready');
  assert.equal(link.view().health.device.name, 'PC du bar');
  assert.equal(link.lastError, null);
});

test('Spotify : vérification — 204 sans appareil, jeton refusé, réseau coupé, erreur ancienne effacée', async () => {
  let now = 1_000_000;
  // Aucun appareil actif (204) ni choisi, plusieurs appareils : pas « prêt ».
  const idle = deviceSpotify({ devices: [{ id: 'a', name: 'PC', type: 'Computer' }, { id: 'b', name: 'Enceinte', type: 'Speaker' }] });
  const link = linkedTo(idle, {}, { now: () => now });
  assert.equal(link.view().health.state, 'unknown', 'pas encore vérifié');
  assert.equal(link.checkDue, true);
  link.lastError = 'Aucun appareil Spotify actif : ouvre Spotify sur l’appareil choisi, puis réessaie.';
  const seen = await link.checkHealth();
  assert.equal(seen.state, 'no-device', 'un 204 n’est plus « en pause » en vert');
  assert.equal(seen.device, null);
  assert.equal(seen.checkedAt, now);
  assert.equal(seen.okAt, now, 'Spotify a répondu');
  assert.equal(link.player.isPlaying, false);
  assert.equal(link.lastError, null, 'une vérification réussie efface l’erreur ancienne');
  assert.deepEqual(link.view().devices.map(d => d.id), ['a', 'b'], 'la liste reste sur le serveur pour la page');
  assert.equal(link.checkDue, false);
  now += 59999;
  assert.equal(link.checkDue, false, 'une vérification par minute');
  now += 1;
  assert.equal(link.checkDue, true);
  // Appareil enregistré absent, sans homonyme : « aucun appareil », le nom reste affiché.
  link.config.deviceId = 'disparu'; link.config.deviceName = 'Tablette';
  const missing = await link.checkHealth();
  assert.equal(missing.state, 'no-device');
  assert.deepEqual(missing.device, { id: 'disparu', name: 'Tablette', active: false });
  assert.equal(missing.adopted, false);
  assert.equal(link.config.deviceId, 'disparu', 'rien n’est remplacé sans appareil du même nom');
  // Un seul appareil et aucun choix : il est prêt, la préférence n'est pas écrite.
  const single = deviceSpotify({ devices: [{ id: 'seul', name: 'PC du bar', type: 'Computer' }] });
  const solo = linkedTo(single);
  assert.equal((await solo.checkHealth()).state, 'ready');
  assert.equal(solo.config.deviceId, '');
  // Lecture sans appareil actif ni choisi : 404, puis transfert vers le seul appareil.
  assert.equal(await solo.resume(), 'done');
  assert.equal(single.state.active, 'seul');
  // Plusieurs appareils, aucun actif, aucun choix : 404 puis « aucun appareil ».
  await assert.rejects(link.resume(), /Aucun appareil Spotify actif/);
  link.config.deviceId = '';
  await assert.rejects(link.resume(), /Aucun appareil Spotify actif/);
  assert.equal(link.view().health.state, 'no-device');
  assert.equal(idle.calls.filter(c => c.route === '/v1/me/player' && c.method === 'PUT').length, 0, 'pas de transfert à l’aveugle');

  // Jeton refusé : « non connecté ».
  const revoked = deviceSpotify();
  revoked.state.grant = false;
  const lost = linkedTo(revoked);
  assert.equal((await lost.checkHealth()).state, 'disconnected');
  assert.equal(lost.connected, false);
  assert.match(lost.lastError, /reconnecte/);
  assert.equal((await lost.checkHealth()).state, 'disconnected', 'plus d’appel une fois déconnecté');
  assert.equal(revoked.calls.length, 1);

  // Réseau coupé : « injoignable », nouvel essai après le délai, toujours connecté.
  let t = 5_000_000;
  const offline = deviceSpotify({ devices: [{ id: 'pc', name: 'PC du bar', type: 'Computer' }], active: 'pc' });
  offline.state.down = true;
  const cut = linkedTo(offline, { deviceId: 'pc', deviceName: 'PC du bar' }, { now: () => t });
  const down = await cut.checkHealth();
  assert.equal(down.state, 'error');
  assert.equal(down.retryAt, t + 30000, 'nouvel essai à la fin du délai');
  assert.equal(down.message, 'fetch failed');
  assert.equal(cut.connected, true);
  assert.equal(cut.lastError, 'fetch failed');
  assert.equal(cut.checkDue, true, 'à revérifier dès la fin du délai');
  t += 40000;
  assert.equal(cut.view().health.retryAt, t, 'délai passé : nouvel essai maintenant');
  offline.state.down = false;
  const back = await cut.checkHealth();
  assert.equal(back.state, 'ready');
  assert.deepEqual(back.device, { id: 'pc', name: 'PC du bar', active: true });
  assert.equal(cut.lastError, null);
  // Une commande qui passe après une panne : à revérifier.
  offline.state.down = true;
  await assert.rejects(cut.readPlayer());
  assert.equal(cut.health.state, 'error');
  offline.state.down = false;
  await cut.readPlayer();
  assert.equal(cut.health.state, 'unknown', 'Spotify répond de nouveau');
  assert.equal(cut.checkDue, true);
});

test('Spotify : type d’appareil enregistré, homonyme du même type préféré, oubli à la déconnexion', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-type-'));
  const file = path.join(dir, 'spotify.json');
  try {
    const fake = deviceSpotify({ devices: [{ id: 'tel', name: 'Bar', type: 'Smartphone' }, { id: 'pc-1', name: 'Bar', type: 'Computer' }] });
    const link = new SpotifyLink({ file, fetchImpl: fake.fetchImpl });
    link.config = { ...link.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'r' };
    await link.devices();
    link.setDevice('pc-1', '');
    assert.equal(link.config.deviceName, 'Bar', 'nom repris de la liste');
    assert.equal(link.config.deviceType, 'Computer');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).deviceType, 'Computer', 'type enregistré');
    // Le PC redémarre : nouvel identifiant ; le téléphone, du même nom, est actif.
    fake.state.devices = [{ id: 'tel', name: 'Bar', type: 'Smartphone' }, { id: 'pc-2', name: ' bar ', type: 'Computer' }];
    fake.state.active = 'tel';
    const seen = await link.checkHealth();
    assert.equal(seen.state, 'ready');
    assert.equal(seen.adopted, true);
    assert.equal(link.config.deviceId, 'pc-2', 'même type d’abord, puis actif');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).deviceId, 'pc-2', 'enregistré dans data/spotify.json');
    assert.equal(link.config.deviceName, 'Bar', 'le nom n’est jamais effacé');
    // Relu au démarrage : le type est gardé ; une valeur abîmée est ignorée.
    assert.equal(new SpotifyLink({ file }).config.deviceType, 'Computer');
    fs.writeFileSync(file, JSON.stringify({ deviceId: 'x', deviceType: 42 }));
    assert.equal(new SpotifyLink({ file }).config.deviceType, '');
    // Un appareil absent de la liste : enregistré sans type.
    link.setDevice('ailleurs', 'Ailleurs');
    assert.equal(link.config.deviceType, '');
    link.disconnect();
    assert.deepEqual(link.view().devices, []);
    assert.equal(link.view().health.state, 'disconnected');
    assert.equal(link.config.deviceType, '');
    link.config.refreshToken = 'r';
    assert.equal(link.view().health.state, 'unknown', 'vérification oubliée');
    link.setClientId('fedcba9876543210');
    assert.equal(link.view().health.state, 'disconnected');
    assert.doesNotMatch(JSON.stringify(link.view()), /"r"|jeton/, 'aucun jeton dans la vue');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Spotify : reprise de l’automate après un rétablissement, jamais contre un choix du bar', () => {
  let now = 0;
  const auto = new SpotifyAutomation({ now: () => now });
  const opts = { autoResume: true, autoPause: true, resumeDelaySec: 0 };
  assert.equal(auto.recover(), false, 'rien à reprendre');
  assert.equal(auto.step('silent', opts), 'resume');
  for (let i = 0; i < 3; i++) { auto.settle(false); now += 30000; }
  assert.equal(auto.step('silent', opts), null, 'trois essais : abandon');
  assert.equal(auto.recover(), true);
  assert.equal(auto.step('silent', opts), 'resume', 'Spotify rétabli : la relance repart pour ce silence');
  auto.settle(false);
  assert.equal(auto.step('silent', opts), null, 'nouvel essai dans 30 s…');
  assert.equal(auto.recover(), false, 'une reprise par 10 minutes au plus');
  now += 10 * 60000;
  assert.equal(auto.recover(), true);
  assert.equal(auto.step('silent', opts), 'resume', '… ou tout de suite si Spotify est rétabli');
  auto.settle(true);
  assert.equal(auto.recover(), false, 'réussite : rien à reprendre');
  assert.equal(auto.step('silent', opts), null);
  // Échec puis pause du bar : le choix du bar reste.
  now += 1000;
  auto.step('singing', opts); auto.settle(true);
  auto.step('silent', opts); auto.settle(false);
  auto.handled();
  assert.equal(auto.recover(), false);
  assert.equal(auto.step('silent', opts), null, 'pause décidée par le bar respectée');
  // Deuxième relecture finale R5 : seul l'appel de relance échoue en 5xx (les
  // vérifications réussissent) : rien n'est repris ; une vérification en
  // échec depuis montre une panne de Spotify, reprise une fois rétabli.
  now += 10 * 60000;
  auto.step('singing', opts); auto.settle(true);
  assert.equal(auto.step('silent', opts), 'resume');
  auto.settle(false, Object.assign(new Error('Spotify est indisponible'), { status: 503 }));
  assert.equal(auto.recover(), false, 'relance seule en 5xx : la vérification n’en dit rien');
  auto.checkFailed();
  assert.equal(auto.recover(), true, 'panne de Spotify vue aussi par la vérification');
  auto.settle(false, Object.assign(new Error('Spotify refuse la commande'), { status: 403 }));
  now += 10 * 60000;
  assert.equal(auto.recover(), true, 'un refus (403) suit la règle des 10 minutes');
});

test('Spotify : déconnexion pendant une vérification, rien n’est gardé', async () => {
  for (const slowRoute of ['/v1/me/player', '/api/token']) {
    const fake = deviceSpotify({ devices: [{ id: 'pc', name: 'PC', type: 'Computer' }], active: 'pc' });
    let release;
    const base = fake.fetchImpl;
    const link = linkedTo({ fetchImpl: async (url, options = {}) => {
      if (url.replace(/^https:\/\/[^/]+/, '') === slowRoute) await new Promise(resolve => { release = resolve; });
      return base(url, options);
    } });
    const checking = link.checkHealth();
    await new Promise(resolve => setImmediate(resolve));
    link.disconnect();
    release();
    const seen = await checking;
    assert.equal(seen.state, 'disconnected', slowRoute);
    assert.equal(link.lastError, null, 'pas d’erreur pour une connexion déjà remplacée');
    assert.equal(link.health.state, 'unknown');
  }
});

// Regression: U11 (relecture finale) — toute erreur de vérification était
// « error », affichée « Spotify injoignable, nouvel essai à … », même quand
// Spotify avait répondu en refusant (401, 403). Réseau, 5xx et 429 restent
// « injoignable » ; un autre refus garde son code dans l'état vu par le bar.
test('Spotify : vérification refusée (401, 403) distincte d’un Spotify injoignable (réseau, 5xx, 429)', async () => {
  const answer = (status, error = {}) => ({ ok: status < 300, status, headers: { get: () => null },
    json: async () => ({ error }), text: async () => JSON.stringify({ error }) });
  let reply = null;
  const fetchImpl = async url => {
    if (url.endsWith('/api/token')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ access_token: 'jeton', expires_in: 3600 }) };
    if (reply === 'down') throw new TypeError('fetch failed');
    return reply;
  };
  const link = new SpotifyLink({ fetchImpl });
  link.config = { ...link.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'r' };
  reply = answer(403, { status: 403, message: 'Forbidden', reason: 'PREMIUM_REQUIRED' });
  const refused = await link.checkHealth();
  assert.equal(refused.state, 'error');
  assert.equal(refused.status, 403, 'Spotify a répondu : son code est gardé');
  assert.equal(refused.message, 'Spotify refuse la commande : un abonnement Premium est nécessaire.');
  assert.equal(link.connected, true);
  reply = answer(401, { status: 401, message: 'Invalid access token' });
  const expired = await link.checkHealth();
  assert.equal(expired.status, 401);
  assert.match(expired.message, /reconnecte Spotify/);
  for (const [why, next] of [['réseau', 'down'], ['5xx', answer(503)], ['429', answer(429)]]) {
    reply = next;
    const down = await link.checkHealth();
    assert.equal(down.state, 'error', `${why} : injoignable`);
    assert.equal('status' in down, false, `${why} : pas de code de refus`);
  }
  reply = answer(400, { status: 400, message: 'Bad request' });
  assert.equal((await link.checkHealth()).status, 400, 'tout autre refus garde son code');
});

// Regression: deuxième relecture finale R6 — refus de PUT /me/player/play
// autre que 404 : resume() échoue avec ce code, sans liste d'appareils ni
// transfert, et sans croire Spotify en lecture. Seuls le réseau et les 5xx
// rendent Spotify « injoignable » (403 : Spotify a répondu).
test('Spotify : relance refusée (403, 503) ou réseau coupé : échec avec ce code, ni appareils ni transfert', async () => {
  for (const [why, reply, status] of [['403', 403, 403], ['503', 503, 503], ['réseau', 'down', undefined]]) {
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const route = url.replace(/^https:\/\/[^/]+/, '').split('?')[0];
      const method = options.method || 'GET';
      calls.push(`${method} ${route}`);
      if (url.endsWith('/api/token')) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ access_token: 'jeton', expires_in: 3600 }) };
      if (method === 'GET' && route === '/v1/me/player') {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ is_playing: false, device: { id: 'pc', name: 'PC' } }) };
      }
      if (method === 'GET' && route === '/v1/me/player/devices') {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ devices: [{ id: 'pc', name: 'PC', type: 'Computer', is_active: true }] }) };
      }
      if (method === 'PUT' && route === '/v1/me/player/play') {
        if (reply === 'down') throw new TypeError('fetch failed');
        return { ok: false, status: reply, headers: { get: () => null }, text: async () => JSON.stringify({ error: { status: reply, message: 'refus' } }) };
      }
      throw new Error(`inattendu : ${method} ${route}`);
    };
    const link = new SpotifyLink({ fetchImpl });
    link.config = { ...link.config, clientId: '0123456789abcdef0123456789abcdef', refreshToken: 'r', deviceId: 'pc', deviceName: 'PC' };
    assert.equal((await link.checkHealth()).state, 'ready', `${why} : appareils en bonne santé`);
    calls.length = 0;
    await assert.rejects(link.resume(), error => {
      assert.equal(error.status, status, why);
      if (reply === 'down') assert.match(error.message, /fetch failed|injoignable|réseau/i);
      return true;
    });
    assert.deepEqual(calls.filter(call => !call.endsWith('/api/token')), ['GET /v1/me/player', 'PUT /v1/me/player/play'],
      `${why} : ni liste des appareils ni transfert`);
    assert.equal(link.player.isPlaying, false, `${why} : Spotify pas cru en lecture`);
    assert.deepEqual(link.lastAction && { kind: link.lastAction.kind, result: link.lastAction.result }, { kind: 'resume', result: 'error' });
    assert.equal(link.health.state, reply === 403 ? 'ready' : 'error', `${why} : injoignable seulement pour le réseau et les 5xx`);
  }
});
