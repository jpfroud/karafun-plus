'use strict';
// Regression: retours du bar — « Quand une personne rejoint alors qu'une
// battle a été lancée avant qu'il rejoigne, il ne peut pas participer, il
// doit pouvoir. » L'électorat du vote Battle était figé à la proposition.
// Parcours sur le serveur de démo : arrivée à une table, solo qui saisit son
// prénom après l'ouverture, entrée par le QR de l'événement privé.
const assert = require('node:assert/strict');
const { staffRoute } = require('./staff-auth');
const BASE = process.env.BASE || 'http://127.0.0.1:3127';

async function request(path, body, cookie = '', headers = {}) {
  const route = await staffRoute(BASE, path);
  const response = await fetch(BASE + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value = {};
  try { value = JSON.parse(text); } catch (_) { value = text; }
  return { status: response.status, value, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
async function ok(path, body, cookie = '', headers = {}) {
  const result = await request(path, body, cookie, headers);
  assert.equal(result.status, 200, `${path}: HTTP ${result.status} ${JSON.stringify(result.value)}`);
  return result;
}

(async () => {
  await ok('/api/staff/settings', { auto: false });
  const staff = async () => (await ok('/api/staff/state')).value;
  await ok('/api/staff/table', { id: 'late', headcount: 8 });
  const tables = (await staff()).tables;
  const accessOf = id => new URL(tables.find(item => item.id === id).url).pathname.split('/').pop();
  const access = accessOf('late');
  const soloAccess = accessOf('Comptoir');
  const at = (person, extra = {}) => ({ table: 'late', access, personId: person.id, token: person.token, ...extra });
  const solo = (person, extra = {}) => ({ table: 'Comptoir', access: soloAccess, personId: person.id, token: person.token, ...extra });

  const people = [];
  for (const name of ['Alice', 'Bob', 'Chloé', 'Dam', 'Emma']) {
    people.push((await ok('/api/table/person', { table: 'late', access, name })).value);
  }
  // Partie avant le vote : pas d'électrice.
  const gone = (await ok('/api/table/person', { table: 'late', access, name: 'Wanda' })).value;
  await ok('/api/staff/person/leave', { personId: gone.id });
  // QR solo ouvert avant le vote, prénom pas encore saisi.
  const invitation = (await ok('/api/staff/solo-invite', { tableId: 'Comptoir' })).value;
  const opened = await ok('/api/table/solo/open', { table: 'Comptoir', access: soloAccess,
    invitation: new URL(invitation.url).searchParams.get('invitation') });
  assert.equal(opened.value.nameRequired, true);
  const sam = { ...opened.value, cookie: opened.cookie };

  const queen = (await ok('/api/search?q=Queen')).value;
  const songs = [queen.find(song => song.title === 'Bohemian Rhapsody'), queen.find(song => song.title === "Don't Stop Me Now")];
  assert.ok(songs.every(Boolean));
  const proposed = await ok('/api/table/battle/propose', at(people[0], { songs, proposerChoice: songs[0].songId }));
  assert.equal(proposed.value.battle.phase, 'voting');
  assert.equal(proposed.value.battle.eligible, 5, 'à l’ouverture : les cinq inscrits nommés');
  assert.ok(!proposed.value.battle.eligiblePersonIds.includes(sam.id), 'prénom pas encore saisi : pas encore électeur');

  // ---- Une sixième personne rejoint la table après l'ouverture du vote.
  const late = (await ok('/api/table/person', { table: 'late', access, name: 'Fanny' })).value;
  const phone = (await ok('/api/state?' + new URLSearchParams({ table: 'late', access }), undefined, '',
    { 'x-person-tokens': JSON.stringify([late.token]) })).value;
  assert.deepEqual(phone.managedIds, [late.id]);
  assert.ok(phone.battle.eligiblePersonIds.includes(late.id), 'le téléphone de l’arrivée la voit électrice');
  assert.equal(phone.battle.eligible, 6, '« votants sur » compte l’arrivée');
  const lateVote = await request('/api/table/battle/vote', at(late, { choice: songs[1].songId }));
  assert.equal(lateVote.status, 200, `l’arrivée peut voter : ${JSON.stringify(lateVote.value)}`);
  assert.equal(lateVote.value.battle.voters, 2, 'son vote compte');
  assert.equal(lateVote.value.battle.songOptions.find(song => song.songId === songs[1].songId).votes, 1);
  assert.equal((await request('/api/table/battle/vote', at(late, { choice: songs[0].songId }))).value.error,
    'Cette personne a déjà voté.');

  // ---- Le solo saisit son prénom après l'ouverture : il peut voter.
  assert.equal((await request('/api/table/battle/vote', solo(sam, { choice: songs[0].songId }), sam.cookie)).value.code,
    'NAME_REQUIRED', 'sans prénom, toujours pas de vote');
  await ok('/api/table/person/rename', solo(sam, { name: 'Samia' }), sam.cookie);
  const samState = (await ok('/api/state?' + new URLSearchParams({ table: 'Comptoir', access: soloAccess }), undefined, sam.cookie,
    { 'x-person-tokens': JSON.stringify([sam.token]) })).value;
  assert.ok(samState.battle.eligiblePersonIds.includes(sam.id), 'prénom saisi : électeur sans recharger');
  assert.equal((await ok('/api/table/battle/vote', solo(sam, { choice: songs[0].songId }), sam.cookie)).value.battle.voters, 3);

  // ---- Entrée par le QR de l'événement privé après l'ouverture.
  const event = (await ok('/api/staff/private-event', { enabled: true })).value;
  const entered = await ok('/api/table/enter', { table: 'Comptoir', access: soloAccess,
    event: new URL(event.url).searchParams.get('evenement') });
  const guest = { ...entered.value, cookie: entered.cookie };
  await ok('/api/table/person/rename', solo(guest, { name: 'Gaëlle' }), guest.cookie);
  assert.equal((await ok('/api/table/battle/vote', solo(guest, { choice: 'none' }), guest.cookie)).value.battle.voters, 4,
    'l’entrée par l’événement privé vote aussi');

  // ---- La personne partie n'a toujours aucun droit.
  let battle = (await staff()).battle;
  assert.ok(!battle.eligiblePersonIds.includes(gone.id), 'partie : pas électrice');
  assert.equal((await request('/api/table/battle/vote', at(gone, { choice: songs[0].songId }))).value.code, 'PERSON_LEFT');
  assert.deepEqual([battle.phase, battle.eligible, battle.voters], ['voting', 8, 4],
    'cinq inscrits, l’arrivée, le solo et l’entrée privée');

  // Une électrice marquée partie reste comptée (comme avant), sans pouvoir voter.
  await ok('/api/staff/person/leave', { personId: people[4].id });
  battle = (await staff()).battle;
  assert.equal(battle.eligible, 8);
  // Les votes restants closent le vote dès que tous les électeurs ont voté...
  // sauf la partie : le bar clôt alors le vote.
  for (const index of [1, 2, 3]) await ok('/api/table/battle/vote', at(people[index], { choice: songs[1].songId }));
  battle = (await staff()).battle;
  assert.deepEqual([battle.phase, battle.voters], ['voting', 7]);
  const closed = (await ok('/api/staff/battle/close', {})).value.battle;
  assert.equal(closed.phase, 'requested');
  assert.equal(closed.eligible, 8, 'la décision garde l’électorat agrandi');
  assert.equal(closed.selectedSong.songId, songs[1].songId, 'les voix des arrivées comptent dans le résultat');
  console.log('Battle : les personnes arrivées après l’ouverture du vote peuvent voter OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
