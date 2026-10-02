'use strict';
// Recette API des retours du premier essai réel au bar (v0.4) : heure de
// fermeture, demande de duo sur un titre de la file, « Pas prêt » (titre
// encore prévu ou déjà chargé dans KaraFun), relance depuis le début, duo
// improvisé qui décale le titre suivant du partenaire, délai court après une
// Battle refusée, paroles et connexion Spotify.
const assert = require('node:assert/strict');
const { staffRoute } = require('./staff-auth');
const BASE = process.env.BASE || 'http://127.0.0.1:3113';

async function request(route, body) {
  const target = await staffRoute(BASE, route);
  const response = await fetch(BASE + target, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}
const ok = async (route, body) => {
  const result = await request(route, body);
  assert.equal(result.status, 200, `${route} : ${result.data.error}`);
  return result.data;
};
const staff = async () => (await request('/api/staff/state')).data;
const wait = async (predicate, label, attempts = 150) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const state = await staff();
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Délai dépassé : ${label}`);
};
const pad = n => String(n).padStart(2, '0');
const clock = at => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

(async () => {
  await ok('/api/staff/settings', { auto: false, autoPlay: false });
  for (const [id, headcount] of [['A', 3], ['B', 2], ['C', 1]]) await ok('/api/staff/table', { id, headcount });
  let state = await staff();
  const access = id => new URL(state.tables.find(t => t.id === id).url).pathname.split('/').pop();
  const people = {};
  for (const [table, names] of [['A', ['A1', 'A2', 'A3']], ['B', ['B1', 'B2']], ['C', ['C1']]]) {
    for (const name of names) people[name] = { table, ...(await ok('/api/table/person', { table, access: access(table), name })) };
  }
  const as = name => ({ table: people[name].table, access: access(people[name].table),
    personId: people[name].id, token: people[name].token });
  const view = async name => (await request(`/api/state?table=${people[name].table}&access=${access(people[name].table)}`, undefined)).data;
  const person = async name => (await view(name)).tablePeople.find(p => p.id === people[name].id);
  const catalog = await (await fetch(BASE + '/api/search?q=an')).json();
  let index = 0;
  const addSong = (name, mode = 'append') => request('/api/table/song', { ...as(name), song: catalog[index++ % catalog.length], mode });
  for (const name of ['A1', 'A2', 'A3', 'B1', 'B2', 'C1']) assert.equal((await addSong(name)).status, 200);

  // ---------------------------------------------------------- heure de fermeture
  assert.equal((await request('/api/staff/closing', { time: '25:00' })).status, 400);
  await ok('/api/staff/closing', { time: clock(Date.now() + 3 * 3600000) });
  state = await staff();
  assert.equal(state.closing.full, false);
  assert.equal(state.closing.fitCount, state.queue.length, 'tous les titres passent avant la fermeture');
  assert.ok(state.queue.every(line => line.afterClosing === false));
  const client = await view('A1');
  assert.equal(client.closing.at, state.closing.at, 'l’heure de fermeture est annoncée aux clients');
  await ok('/api/staff/closing', { time: clock(Date.now() - 60000) });
  state = await staff();
  assert.equal(state.closing.passed, true);
  assert.ok(state.queue.every(line => line.afterClosing), 'après la fermeture, plus rien ne passe');
  const refused = await addSong('A1');
  assert.equal(refused.status, 400);
  assert.equal(refused.data.code, 'CLOSING');
  assert.match(refused.data.error, /^Le bar ferme à \d\d:\d\d : plus de nouveau titre ce soir\.$/);
  assert.equal((await addSong('A1', 'replace')).status, 200, 'remplacer son titre reste possible');
  const extended = await ok('/api/staff/closing', { extendMin: 30 });
  assert.ok(extended.closingAt > Date.now() + 25 * 60000, 'décalage à partir de maintenant');
  assert.equal((await addSong('A1')).status, 200, 'après décalage, l’ajout est de nouveau possible');
  await ok('/api/staff/closing', { clear: true });
  assert.equal((await staff()).closing, null);

  // ---------------------------------------------------------- demande de duo
  state = await staff();
  const c1Line = state.queue.find(line => line.source === 'helper' && line.id === people.C1.id);
  const joined = await ok('/api/table/duet/join', { ...as('B1'), ownerId: people.C1.id, entryId: c1Line.song.entryId });
  assert.equal(joined.direct, false, 'autre table : C1 doit accepter');
  assert.equal((await request('/api/table/duet/join', { ...as('B1'), ownerId: people.C1.id, entryId: c1Line.song.entryId })).status, 400);
  assert.deepEqual((await person('C1')).joinRequests.map(r => r.fromName), ['B1'], 'C1 voit la demande');
  assert.deepEqual((await person('B1')).sentJoinRequests.map(r => r.ownerName), ['C1'], 'B1 voit sa demande en attente');
  await ok('/api/table/duet/join/answer', { ...as('C1'), entryId: c1Line.song.entryId, fromId: people.B1.id, accept: true });
  state = await staff();
  const duo = state.queue.find(line => line.source === 'helper' && line.id === people.C1.id);
  assert.deepEqual(duo.ids, [people.C1.id, people.B1.id], 'C1 garde son passage, B1 chante avec elle');
  // La notice d'un titre déjà prévu permet de proposer un duo à son auteur.
  const a2Line = state.queue.find(line => line.source === 'helper' && line.id === people.A2.id);
  const notice = (await request(`/api/song/notice?table=B&access=${access('B')}&songId=${a2Line.song.songId}&title=${encodeURIComponent(a2Line.song.title)}`)).data.notice;
  assert.equal(notice.queued[0].ownerId, people.A2.id);
  assert.equal(notice.queued[0].entryId, a2Line.song.entryId);

  // ---------------------------------------------------------- « Pas prêt » (titre encore prévu)
  state = await staff();
  const planned = state.queue.filter(line => line.source === 'helper' && !line.future);
  const firstName = Object.keys(people).find(name => people[name].id === planned[0].ids[0]);
  assert.equal((await person(firstName)).canDefer, true, 'le prochain passage peut être repoussé');
  const otherName = Object.keys(people).find(name => !planned[0].ids.includes(people[name].id) &&
    planned.findIndex(line => line.ids.includes(people[name].id)) > 1);
  assert.equal((await person(otherName)).canDefer, false, 'pas encore pour les suivants');
  assert.equal((await request('/api/table/defer', as(otherName))).status, 400);
  await ok('/api/table/defer', as(firstName));
  state = await staff();
  const deferredOrder = state.queue.filter(line => line.source === 'helper' && !line.future);
  assert.equal(deferredOrder[1].song.entryId, planned[0].song.entryId, 'repoussé d’une seule place');
  assert.notEqual(deferredOrder[0].song.entryId, planned[0].song.entryId, 'un autre chanteur passe d’abord');
  assert.equal(deferredOrder[1].deferred, true, 'repère pour le bar');
  assert.equal((await person(firstName)).deferral.remaining, 1);
  await ok('/api/table/defer/cancel', as(firstName));
  assert.equal((await person(firstName)).deferral, null, '« Je suis prêt » annule le report');

  // ---------------------------------------------------------- réglages Battle
  assert.equal((await request('/api/staff/settings', { battleRejectedCooldownMin: 0 })).status, 400);
  await ok('/api/staff/settings', { battleRejectedCooldownMin: 4 });
  assert.equal((await staff()).settings.battleRejectedCooldownMin, 4);

  // ---------------------------------------------------------- paroles (accès) et Spotify (configuration)
  assert.equal((await request('/api/lyrics?table=A&access=AAAAAAAAAAAAAAAAAAAAAA&title=Toxic')).status, 403,
    'paroles réservées aux QR des tables');
  assert.equal((await request('/api/lyrics?title=Toxic')).status, 400);
  assert.equal((await request(`/api/lyrics?table=A&access=${access('A')}`)).status, 400);
  assert.equal((await request('/api/staff/spotify', { action: 'client', clientId: 'pas bon' })).status, 400);
  assert.equal((await request('/api/staff/spotify', { action: 'auth-url' })).status, 400, 'Client ID nécessaire');
  await ok('/api/staff/spotify', { action: 'client', clientId: '0123456789abcdef0123456789abcdef' });
  const auth = new URL((await ok('/api/staff/spotify', { action: 'auth-url' })).url);
  assert.equal(auth.origin, 'https://accounts.spotify.com');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.match(auth.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/spotify\/callback$/);
  state = await staff();
  assert.equal(state.spotify.configured, true);
  assert.equal(state.spotify.connected, false);
  assert.doesNotMatch(JSON.stringify(state.spotify), /refresh/i, 'aucun jeton dans la page du bar');
  const callback = await fetch(BASE + '/spotify/callback?code=x&state=faux');
  assert.match(await callback.text(), /expirée/, 'un retour Spotify sans demande valable est refusé');

  // ---------------------------------------------------------- en direct avec le faux KaraFun
  await ok('/api/staff/settings', { auto: true, autoPlay: true, playDelaySec: 0, pushDelaySec: 0 });
  state = await wait(s => s.stage?.ours && s.queue[0]?.source === 'karafun' && s.queue[0].ours,
    'un titre sur scène et le suivant chargé dans KaraFun');
  const stageBefore = state.stage;
  const historyBefore = state.stageHistory.length;

  // Relancer depuis le début : même passage, nouvelle copie dans KaraFun.
  await ok('/api/staff/kf', { action: 'restart' });
  state = await wait(s => !s.restarting && s.stage && s.stage.queueId !== stageBefore.queueId,
    'titre relancé depuis le début');
  assert.equal(state.stage.title, stageBefore.title);
  assert.deepEqual(state.stage.ids, stageBefore.ids, 'le même passage continue');
  assert.equal(state.stageHistory.length, historyBefore, 'la relance n’ajoute pas de passage');
  assert.ok(state.log.some(line => /repart du début/.test(line.msg)));
  assert.equal(state.tracked.filter(t => String(t.queueId) === String(stageBefore.queueId)).length, 0);

  // « Pas prêt » pour un titre déjà chargé dans KaraFun.
  state = await wait(s => s.queue[0]?.source === 'karafun' && s.queue[0].ours, 'titre suivant chargé');
  const loaded = state.queue[0];
  const loadedName = Object.keys(people).find(name => people[name].id === loaded.ids[0]);
  assert.equal((await person(loadedName)).canDefer, true);
  await ok('/api/table/defer', as(loadedName));
  state = await wait(s => s.queue[0]?.source === 'karafun' && s.queue[0].ours && s.queue[0].queueId !== loaded.queueId &&
    !s.queue[0].ids.includes(loaded.ids[0]), 'un autre chanteur passe devant');
  const nextAfter = state.queue.find(line => line.source !== 'karafun' && line.ids?.includes(loaded.ids[0]));
  assert.ok(nextAfter && state.queue.indexOf(nextAfter) === 1, 'le titre repoussé passe juste après');
  assert.equal(nextAfter.guaranteed, true, 'il est le prochain annoncé, son tour est gardé');

  // Duo improvisé : le partenaire dont le titre est déjà chargé chantera plus tard.
  const partnerLine = state.queue[0];
  const partnerId = partnerLine.ids[0];
  await ok('/api/staff/duo-mark', { queueId: state.stage.queueId, partnerId });
  state = await wait(s => !s.queue.some(line => line.source === 'karafun' && line.queueId === partnerLine.queueId) &&
    s.log.some(line => /après le duo improvisé/.test(line.msg)), 'titre du partenaire retiré de KaraFun');
  const back = state.queue.findIndex(line => line.source === 'helper' && line.ids?.[0] === partnerId &&
    line.title === partnerLine.title);
  assert.ok(back > 0, 'son titre revient dans la file, pas juste après le duo');
  assert.equal(state.stage.kind, 'duo');

  await ok('/api/staff/settings', { auto: false, autoPlay: false });
  console.log('API retours du bar v0.4 : fermeture, demande de duo, Pas prêt, relance, duo improvisé, Battle, paroles et Spotify OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
