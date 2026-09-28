'use strict';
const assert = require('node:assert/strict');
const { staffRoute } = require('./staff-auth');
const BASE = process.env.BASE || 'http://127.0.0.1:3110';

async function request(route, body) {
  const target = await staffRoute(BASE, route);
  const response = await fetch(BASE + target, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}

(async () => {
  assert.equal((await request('/api/staff/settings', {
    auto: true, autoPlay: true, playDelaySec: 0, pushDelaySec: 0,
  })).status, 200);
  assert.equal((await request('/api/staff/table', { id: 'battle', headcount: 5 })).status, 200);
  const staff = () => request('/api/staff/state');
  const table = (await staff()).data.tables.find(item => item.id === 'battle');
  const access = new URL(table.url).pathname.split('/').pop();
  const people = [];
  for (const name of ['Alice', 'Bob', 'Chloé', 'Dam', 'Emma']) {
    const response = await request('/api/table/person', { table: 'battle', access, name });
    assert.equal(response.status, 200);
    people.push(response.data);
  }
  const body = (index, extra = {}) => ({ table: 'battle', access,
    personId: people[index].id, token: people[index].token, ...extra });
  const queen = await (await fetch(BASE + '/api/search?q=Queen')).json();
  const abba = await (await fetch(BASE + '/api/search?q=ABBA')).json();
  const songs = [queen.find(song => song.title === 'Bohemian Rhapsody'),
    queen.find(song => song.title === "Don't Stop Me Now"),
    abba.find(song => song.title === 'Dancing Queen')];
  assert.ok(songs.every(Boolean), 'les trois titres viennent du vrai catalogue de la simulation');
  assert.equal((await request('/api/table/battle/propose', body(0))).status, 400,
    'une Battle ne peut plus être demandée sans titre');
  assert.equal((await request('/api/table/battle/propose', body(0, {
    songs: [{ songId: 999999999, title: 'Titre inventé' }],
  }))).status, 400, 'un titre absent du catalogue doit être refusé');
  assert.equal((await staff()).data.battle.phase, 'idle');
  assert.equal((await request('/api/table/battle/propose', body(0, { songs: [] }))).status, 400);
  assert.equal((await request('/api/table/battle/propose', body(0, { songs: [songs[0], songs[0]] }))).status, 400);
  const proposed = await request('/api/table/battle/propose', body(0, {
    songs: [{ ...songs[0], title: 'Titre falsifié par le client' }, songs[1], songs[2]],
    proposerChoice: songs[0].songId,
  }));
  assert.equal(proposed.status, 200);
  assert.equal(proposed.data.battle.phase, 'voting');
  assert.equal(proposed.data.battle.threshold, 3);
  assert.equal(proposed.data.battle.songOptions[0].title, songs[0].title,
    'le titre affiché doit provenir du catalogue KaraFun, pas du formulaire');
  assert.deepEqual(proposed.data.battle.songOptions.map(item => item.votes), [1, 0, 0]);
  assert.equal((await request('/api/table/battle/vote', body(1, { choice: 'no' }))).status, 400);
  assert.equal((await request('/api/table/battle/vote', body(1, { choice: songs[1].songId }))).status, 200);
  assert.equal((await request('/api/table/battle/vote', body(2, { choice: songs[1].songId }))).status, 200);
  assert.equal((await staff()).data.battle.phase, 'voting', 'le titre reste ouvert après majorité favorable');
  assert.equal((await request('/api/table/battle/vote', body(3, { choice: 'none' }))).status, 200);
  const outcome = await request('/api/table/battle/vote', body(4, { choice: songs[1].songId }));
  assert.equal(outcome.status, 200);
  assert.equal(outcome.data.battle.phase, 'requested');
  assert.equal(outcome.data.battle.selectedSong.songId, songs[1].songId);
  assert.equal(outcome.data.battle.noVotes, 1);
  const voted = (await staff()).data;
  assert.equal(voted.battle.songOptions.find(item => item.songId === songs[1].songId).votes, 3);
  const publicState = (await request(`/api/state?table=battle&access=${access}`)).data;
  assert.equal(publicState.battle.selectedSong.title, songs[1].title);
  let final;
  for (let attempt = 0; attempt < 40; attempt++) {
    final = (await staff()).data;
    if (final.battle.automation?.status === 'queued') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(final.battle.automation.status, 'queued',
    'la Battle votée entre automatiquement dans la fausse file KaraFun en mode Battle');
  assert.equal(final.queue.find(item => item.kind === 'battle')?.song?.songId, songs[1].songId);
  assert.equal(final.battle.phase, 'cooldown', 'les 15 minutes commencent après confirmation KaraFun');
  assert.equal(final.stage, null, 'le bar doit laisser les téléphones rejoindre avant de lancer');
  assert.equal((await request('/api/staff/kf', { action: 'play' })).status, 400,
    'le bouton du helper ne doit pas lancer la Battle avant le bar');
  assert.equal((await request('/api/table/battle/propose', body(1, { songs }))).status, 400);
  console.log('API Battle : 3 titres, vote contre, majorité, ajout simulé, lecture manuelle et pause OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
