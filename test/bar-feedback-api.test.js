'use strict';
// Recette API des retours de l'essai au bar : bonus/malus invisible des
// clients, retrait groupé, recalcul forcé, historique de scène, Battle lancée
// par le bar et vote clos par le bar, QR commun « En solo » retiré.
const assert = require('node:assert/strict');
const { staffRoute } = require('./staff-auth');
const BASE = process.env.BASE || 'http://127.0.0.1:3111';

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
const wait = async (predicate, label) => {
  for (let attempt = 0; attempt < 80; attempt++) {
    const state = await staff();
    if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Délai dépassé : ${label}`);
};

(async () => {
  await ok('/api/staff/settings', { auto: false, autoPlay: false });
  for (const [id, headcount] of [['grande', 4], ['petite', 2]]) await ok('/api/staff/table', { id, headcount });
  let state = await staff();
  const access = id => new URL(state.tables.find(t => t.id === id).url).pathname.split('/').pop();
  const people = {};
  for (const [table, names] of [['grande', ['G1', 'G2', 'G3', 'G4']], ['petite', ['P1', 'P2']]]) {
    for (const name of names) {
      people[name] = { table, ...(await ok('/api/table/person', { table, access: access(table), name })) };
    }
  }
  const catalog = await (await fetch(BASE + '/api/search?q=an')).json();
  let index = 0;
  const addSong = async (name, mode = 'append') => {
    const p = people[name];
    await ok('/api/table/song', { table: p.table, access: access(p.table), personId: p.id, token: p.token,
      song: catalog[index++ % catalog.length], mode });
  };
  for (const name of Object.keys(people)) await addSong(name);
  await addSong('G1'); await addSong('G1');

  // Bonus et malus : réglages du bar, jamais visibles côté client.
  assert.equal((await request('/api/staff/bonus', { personId: people.P2.id, level: 4 })).status, 400);
  await ok('/api/staff/bonus', { personId: people.P2.id, level: 3 });
  await ok('/api/staff/bonus', { tableId: 'grande', level: -2 });
  state = await staff();
  assert.equal(state.people.find(p => p.id === people.P2.id).bonus, 3);
  assert.equal(state.tables.find(t => t.id === 'grande').bonus, -2);
  const clientView = JSON.stringify((await request(`/api/state?table=grande&access=${access('grande')}`)).data);
  assert.doesNotMatch(clientView, /"bonus"/, 'le client ne voit ni bonus ni malus');
  assert.ok(!state.log.some(line => /bonus|malus/i.test(line.msg)), 'le journal public ne mentionne pas le bonus');
  await ok('/api/staff/bonus', { tableId: 'grande', level: 0 });
  await ok('/api/staff/bonus', { personId: people.P2.id, level: 0 });

  // Retrait groupé : le premier titre de G1 et son troisième titre.
  state = await staff();
  const g1Lines = state.queue.filter(line => line.source === 'helper' && line.id === people.G1.id);
  assert.equal(g1Lines.length, 3, 'G1 a trois titres dans la file prévue');
  const p1Line = state.queue.find(line => line.source === 'helper' && line.id === people.P1.id);
  const removed = await ok('/api/staff/remove-many', { items: [
    { personId: people.G1.id, entryId: g1Lines[2].song.entryId },
    { personId: people.P1.id, entryId: p1Line.song.entryId },
  ] });
  assert.equal(removed.removed, 2);
  state = await staff();
  assert.equal(state.queue.filter(line => line.id === people.G1.id).length, 2);
  assert.ok(!state.queue.some(line => line.id === people.P1.id));
  assert.ok(state.people.some(p => p.id === people.P1.id && p.active), 'le chanteur reste inscrit');
  assert.equal((await request('/api/staff/remove-many', { items: [] })).status, 400);

  // Priorité : le reste de la file garde son ordre.
  const before = state.queue.filter(line => line.source === 'helper' && !line.future);
  const target = before[3];
  await ok('/api/staff/move', { personId: target.id, toIndex: 0, priority: true });
  state = await staff();
  const after = state.queue.filter(line => line.source === 'helper' && !line.future);
  assert.equal(after[0].song.entryId, target.song.entryId);
  assert.deepEqual(after.slice(1).map(line => line.song.entryId),
    before.filter(line => line.song.entryId !== target.song.entryId).map(line => line.song.entryId));
  assert.equal(state.solver.plan, 'manual');

  // Recalcul forcé : les déplacements manuels sont abandonnés, sans erreur
  // même quand Timefold n'est pas utilisé (mode démo).
  const forced = await ok('/api/staff/queue-optimize', {});
  assert.match(forced.message, /Timefold|règle locale/);
  state = await staff();
  assert.equal(state.manualChanges.length, 0);
  assert.notEqual(state.solver.plan, 'manual');

  // Réglages : mode et intercalage exposés au bar.
  await ok('/api/staff/settings', { tableRotation: true, weightedTables: true, interleaveArrivals: false });
  state = await staff();
  assert.deepEqual([state.settings.tableRotation, state.settings.weightedTables, state.settings.interleaveArrivals],
    [true, true, false]);
  await ok('/api/staff/settings', { tableRotation: false, weightedTables: false, interleaveArrivals: true });

  // Historique de scène : l'envoi puis la lecture enregistrent le passage.
  await ok('/api/staff/settings', { auto: true, autoPlay: true, playDelaySec: 0, pushDelaySec: 0 });
  state = await wait(s => (s.stageHistory || []).length > 0, 'premier passage sur scène');
  const first = state.stageHistory[0];
  assert.ok(first.people.length >= 1 && first.people[0].name, 'nom de la personne passée');
  assert.ok(first.title, 'titre chanté');
  await ok('/api/staff/settings', { auto: false, autoPlay: false });

  // Battle : réglages, vote clos par le bar avec le minimum de votants.
  await ok('/api/staff/settings', { battleVoteMin: 5, battleMinVoters: 2, battleCooldownMin: 20 });
  state = await staff();
  assert.deepEqual([state.settings.battleVoteMin, state.settings.battleMinVoters, state.settings.battleCooldownMin], [5, 2, 20]);
  assert.equal((await request('/api/staff/settings', { battleMinVoters: 0 })).status, 400);
  const queen = (await (await fetch(BASE + '/api/search?q=Queen')).json())[0];
  const g2 = people.G2, g3 = people.G3;
  await ok('/api/table/battle/propose', { table: g2.table, access: access(g2.table), personId: g2.id, token: g2.token,
    songs: [queen] });
  state = await staff();
  assert.equal(state.battle.phase, 'voting');
  assert.equal(state.battle.threshold, 2);
  assert.ok(state.battle.closesAt - Date.now() > 4 * 60_000, 'durée de vote réglée à cinq minutes');
  await ok('/api/table/battle/vote', { table: g3.table, access: access(g3.table), personId: g3.id, token: g3.token,
    choice: queen.songId });
  await ok('/api/staff/battle/close', {});
  state = await staff();
  assert.equal(state.battle.phase, 'requested', 'deux votants, deux voix pour : Battle acceptée');
  await ok('/api/staff/battle/resolve', { outcome: 'dismissed' });
  state = await staff();
  assert.equal(state.battle.phase, 'cooldown');

  // Le bar lance directement une Battle, sans vote et malgré la pause.
  assert.equal((await request('/api/staff/battle/launch', { song: { songId: 99999999, title: 'Inventé' } })).status, 400,
    'titre absent du catalogue refusé');
  const launched = await ok('/api/staff/battle/launch', { song: queen });
  assert.equal(launched.battle.phase, 'requested');
  assert.equal(launched.battle.mode, 'staff');
  assert.equal((await request('/api/staff/battle/launch', { song: queen })).status, 400, 'une seule Battle à la fois');

  // Personne seule : le partage d'accès fournit le QR de reprise.
  const solo = state.tables.find(t => t.individual);
  assert.ok(solo, 'groupe En solo présent');
  const share = await ok('/api/staff/person/share', { personId: people.G4.id });
  assert.equal(share.qr, undefined, 'une table ordinaire utilise son QR imprimé');
  console.log('API retours du bar : bonus privé, retrait groupé, priorité stable, recalcul, historique, Battle du bar OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
