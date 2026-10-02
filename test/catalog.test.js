const test = require('node:test');
const assert = require('node:assert/strict');
const { Catalog } = require('../catalog');

function fixture(body, calls, status = 200) {
  return async (url, options) => {
    calls.push({ url: new URL(url), options });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

test('les listes officielles playlist/styles/top donnent des filtres utilisables', async () => {
  const calls = [];
  const api = new Catalog({ base: 'https://www.karafun.fr', code: '123456',
    fetchImpl: fixture([{ id: 42, name: 'Années 80', img: '/cover.jpg' }, { id: null, name: 'invalide' }], calls) });
  assert.deepEqual(await api.categories('playlist'),
    [{ id: 42, name: 'Années 80', filter: 'pl_42', img: '/cover.jpg' }]);
  assert.equal((await api.categories('top'))[0].filter, 'pl_42');
  assert.equal((await api.categories('styles'))[0].filter, 'st_42');
  assert.equal(calls[0].url.pathname, '/123456/');
  assert.equal(calls[0].url.searchParams.get('type'), 'playlist');
  assert.equal(calls[2].url.searchParams.get('type'), 'styles');
  assert.ok(calls.every(c => c.options.signal instanceof AbortSignal));
});

test('les sélections news et featured reprennent les chansons du catalogue', async () => {
  const calls = [];
  const api = new Catalog({ base: 'https://www.karafun.com', code: '123456',
    fetchImpl: fixture([{ songId: 12617, title: 'Bohemian Rhapsody', artist: 'Queen', duration: 362,
      img: 'https://cdnaws.recis.io/i/img/01/8b/3d/a0_2389ee_sq200.jpg', isExplicit: false }], calls) });
  assert.equal((await api.highlights('news'))[0].songId, 12617);
  assert.equal((await api.highlights('featured'))[0].title, 'Bohemian Rhapsody');
  assert.equal(calls[0].url.searchParams.get('types'), 'karaoke');
  assert.equal(calls[1].url.searchParams.get('type'), 'featured');
});

test('la pagination de chanson encode le filtre officiel et normalise les résultats', async () => {
  const calls = [];
  const api = new Catalog({ base: 'https://www.karafun.fr', code: '123456',
    fetchImpl: fixture({ total: 2, songs: [
      { songId: 7300, title: 'Dancing Queen', artist: 'ABBA', duration: 237 },
      { songId: 'bad', title: 'À exclure' },
    ] }, calls) });
  assert.deepEqual(await api.songs('pl_12', 25), {
    total: 2, songs: [{ songId: 7300, title: 'Dancing Queen', artist: 'ABBA',
      duration: 237, img: null, year: null, isExplicit: false }],
  });
  assert.equal(calls[0].url.searchParams.get('type'), 'song_list');
  assert.equal(calls[0].url.searchParams.get('filter'), 'pl_12');
  assert.equal(calls[0].url.searchParams.get('offset'), '25');
  assert.equal(calls[0].url.searchParams.get('filters'), 'karaoke');
});

test('les paramètres invalides sont rejetés avant la requête', async () => {
  const calls = [];
  const api = new Catalog({ base: 'https://www.karafun.fr', code: '123456', fetchImpl: fixture([], calls) });
  await assert.rejects(api.categories('admin'));
  await assert.rejects(api.highlights('top'));
  await assert.rejects(api.songs('pl_1&types=community'));
  await assert.rejects(api.songs('pl_1', -1));
  await assert.rejects(api.songs('pl_1', 100001));
  assert.equal(calls.length, 0);
  assert.throws(() => new Catalog({ base: 'wss://signed.example', code: '123456' }));
});

test('les erreurs HTTP et JSON inattendu remontent clairement', async () => {
  const calls = [];
  const failed = new Catalog({ base: 'https://www.karafun.fr', code: '123456',
    fetchImpl: fixture({}, calls, 503) });
  await assert.rejects(failed.categories('playlist'), /HTTP 503/);
  const malformed = new Catalog({ base: 'https://www.karafun.fr', code: '123456',
    fetchImpl: fixture({ songs: [], total: -1 }, calls) });
  await assert.rejects(malformed.songs('st_2'), /invalide/);
});

test('une requête lente expire au délai choisi', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const api = new Catalog({ base: 'https://www.karafun.fr', code: '123456', fetchImpl, timeoutMs: 15 });
  await assert.rejects(api.categories('playlist'), /timeout|aborted/i);
});

// ------------------------------------------------ deux domaines KaraFun (refus HTTP 403 au bar)
// Au bar, un des deux domaines KaraFun refusait les sélections (HTTP 403) alors
// que la recherche, qui essaie les deux domaines, marchait : le catalogue fait
// pareil, envoie les mêmes en-têtes et retient le domaine qui répond.
const BASES = ['https://www.karafun.com', 'https://www.karafun.fr'];
function byHost(answers, calls) {
  return async (url, options) => {
    const u = new URL(url);
    calls.push({ url: u, options });
    const answer = answers[u.host];
    if (typeof answer === 'function') return answer(options);
    const { status = 200, body = [], badJson = false } = answer || {};
    return { ok: status >= 200 && status < 300, status,
      json: async () => { if (badJson) throw new SyntaxError('Unexpected token <'); return body; } };
  };
}
const STYLE = [{ id: 7, name: 'Rock' }];

test('un domaine qui refuse (HTTP 403) passe la main au second, retenu ensuite', async () => {
  const calls = [];
  const failures = [];
  const api = new Catalog({ bases: BASES, code: '123456', onFailure: f => failures.push(f),
    fetchImpl: byHost({ 'www.karafun.com': { status: 403 }, 'www.karafun.fr': { body: STYLE } }, calls) });
  assert.deepEqual((await api.categories('styles')).map(c => c.filter), ['st_7']);
  assert.deepEqual(calls.map(c => c.url.host), ['www.karafun.com', 'www.karafun.fr']);
  // Le domaine qui a répondu est essayé en premier la fois suivante.
  await api.highlights('news');
  await api.categories('playlist');
  assert.deepEqual(calls.slice(2).map(c => c.url.host), ['www.karafun.fr', 'www.karafun.fr']);
  // Le journal reçoit le domaine et le statut, jamais le code de la télécommande.
  assert.equal(failures.length, 1);
  assert.equal(failures[0].host, 'www.karafun.com');
  assert.equal(failures[0].status, 403);
  assert.ok(!JSON.stringify(failures).includes('123456'));
});

// Regression: essai au bar du 2 octobre (après-midi) — depuis la France,
// karafun.com sert les playlists, les styles et la liste des tops, mais
// refuse (HTTP 403) « Nouveautés » et les tops étrangers (Top US, Top UK).
// Depuis les États-Unis, les deux domaines servent tout : le refus dépend du
// pays d'où part la requête. Hypothèse, à confirmer au bar : karafun.fr sert
// ces listes en France (sinon, voir le test des deux domaines qui refusent).
test('karafun.com refuse seulement les nouveautés et les tops étrangers : karafun.fr prend le relais', async () => {
  const calls = [];
  const failures = [];
  const refusedByCom = url => url.searchParams.get('type') === 'news' ||
    ['pl_7', 'pl_23'].includes(url.searchParams.get('filter'));
  const answer = (url, body) => ({ ok: true, status: 200, json: async () => body(url) });
  const bodies = url => {
    const type = url.searchParams.get('type');
    if (type === 'top') return url.host === 'www.karafun.com' ?
      [{ id: 7, name: 'Top US' }, { id: 23, name: 'Top UK' }, { id: 8, name: 'Top France' }] :
      [{ id: 8, name: 'Top France' }, { id: 7, name: 'Top États-Unis' }, { id: 23, name: 'Top Royaume-Uni' }];
    if (type === 'news') return [{ songId: 11, title: 'Nouveau' }];
    if (type === 'song_list') return { songs: [{ songId: 12, title: 'Hit' }], total: 1 };
    return [{ id: 94, name: 'Best Of' }];
  };
  const api = new Catalog({ bases: BASES, code: '123456', onFailure: f => failures.push(f),
    fetchImpl: async url => {
      const u = new URL(url);
      calls.push(u);
      if (u.host === 'www.karafun.com' && refusedByCom(u)) return { ok: false, status: 403, json: async () => ({}) };
      return answer(u, bodies);
    } });
  // Ouverture du catalogue : karafun.com répond, il reste le domaine retenu.
  assert.equal((await api.categories('playlist')).length, 1);
  assert.deepEqual((await api.categories('top')).map(c => c.name), ['Top US', 'Top UK', 'Top France']);
  assert.deepEqual(calls.map(u => u.host), ['www.karafun.com', 'www.karafun.com']);
  // « Nouveautés » : refus de karafun.com, karafun.fr répond, sans erreur pour le téléphone.
  assert.deepEqual((await api.highlights('news')).map(s => s.title), ['Nouveau']);
  assert.deepEqual(calls.slice(2).map(u => u.host), ['www.karafun.com', 'www.karafun.fr']);
  // Top US (pl_7) : karafun.fr, retenu après le refus, répond directement.
  assert.equal((await api.songs('pl_7')).total, 1);
  assert.deepEqual(calls.slice(4).map(u => u.host), ['www.karafun.fr']);
  // Une seule ligne au journal : le domaine et le statut.
  assert.deepEqual(failures.map(f => [f.host, f.status]), [['www.karafun.com', 403]]);
});

test('le catalogue envoie les mêmes en-têtes que la recherche', async () => {
  const calls = [];
  const api = new Catalog({ bases: BASES, code: '123456', fetchImpl: byHost({}, calls) });
  await api.categories('styles');
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.equal(calls[0].options.headers['X-Requested-With'], 'XMLHttpRequest');
});

test('les deux domaines refusent : l’erreur nomme le statut HTTP', async () => {
  const calls = [];
  const failures = [];
  const api = new Catalog({ bases: BASES, code: '123456', onFailure: f => failures.push(f),
    fetchImpl: byHost({ 'www.karafun.com': { status: 403 }, 'www.karafun.fr': { status: 403 } }, calls) });
  await assert.rejects(api.categories('styles'), error => /HTTP 403/.test(error.message) && error.status === 403 &&
    error.catalogUnavailable === true && error.refusedEverywhere === true);
  assert.equal(calls.length, 2);
  // Même refus au deuxième essai : pas de nouvelle ligne dans le journal.
  await assert.rejects(api.categories('styles'), /HTTP 403/);
  assert.equal(calls.length, 4);
  assert.equal(failures.length, 2);
});

// Regression: relecture du 2 octobre — un refus d'un domaine et une panne de
// l'autre ne prouvent pas que la sélection est fermée : pas de « refus partout ».
test('un domaine refuse, l’autre est injoignable : pas de refus partout', async () => {
  const api = new Catalog({ bases: BASES, code: '123456',
    fetchImpl: byHost({ 'www.karafun.com': { status: 403 }, 'www.karafun.fr': () => { throw new TypeError('fetch failed'); } }, []) });
  await assert.rejects(api.highlights('news'), error => error.status === 403 && error.refusedEverywhere === false);
});

test('un domaine trop lent passe la main au second', async () => {
  const calls = [];
  const api = new Catalog({ bases: BASES, code: '123456', timeoutMs: 20,
    fetchImpl: byHost({ 'www.karafun.com': ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), 'www.karafun.fr': { body: STYLE } }, calls) });
  assert.equal((await api.categories('styles'))[0].name, 'Rock');
  assert.deepEqual(calls.map(c => c.url.host), ['www.karafun.com', 'www.karafun.fr']);
});

test('une réponse illisible (page HTML) passe la main au second domaine', async () => {
  const calls = [];
  const api = new Catalog({ bases: BASES, code: '123456',
    fetchImpl: byHost({ 'www.karafun.com': { badJson: true }, 'www.karafun.fr': { body: STYLE } }, calls) });
  assert.equal((await api.categories('styles'))[0].filter, 'st_7');
  assert.equal(calls.length, 2);
});

test('un domaine injoignable passe la main au second', async () => {
  const calls = [];
  const api = new Catalog({ bases: BASES, code: '123456', fetchImpl: byHost({
    'www.karafun.com': () => { throw new TypeError('fetch failed'); }, 'www.karafun.fr': { body: STYLE } }, calls) });
  assert.equal((await api.categories('styles')).length, 1);
  assert.equal(calls.length, 2);
});

test('une réponse de forme inattendue sur un domaine essaie l’autre', async () => {
  const calls = [];
  const api = new Catalog({ bases: BASES, code: '123456',
    fetchImpl: byHost({ 'www.karafun.com': { body: { error: 'forbidden' } }, 'www.karafun.fr': { body: STYLE } }, calls) });
  assert.equal((await api.categories('styles')).length, 1);
  const both = new Catalog({ bases: BASES, code: '123456', fetchImpl: byHost({
    'www.karafun.com': { body: {} }, 'www.karafun.fr': { body: {} } }, []) });
  await assert.rejects(both.categories('styles'), /Réponse de catégories invalide/);
});
