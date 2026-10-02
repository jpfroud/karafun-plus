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
  assert.throws(() => link.setOptions({ resumeDelaySec: 2 }), /entre 5 et 300/);
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
