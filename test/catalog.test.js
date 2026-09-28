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
