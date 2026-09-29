'use strict';
// Retours de l'essai au bar (29/09) : table de 10, de 4, de 5 et une personne
// seule, une chanson chacun et quelques duos. On mesure factuellement :
//  - une personne qui rechante avant qu'une autre, prête, ait chanté une fois ;
//  - une table qui garde le micro deux ou trois fois de suite ;
//  - l'effet réel des modes de rotation et des bonus/malus.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const song = n => ({ songId: n, title: `Titre ${n}`, artist: 'Essai au bar' });

// Soirée de l'essai : chacun son titre, puis quelques duos (même table ou
// entre tables, acceptés).
function barEvening(options, seed) {
  const random = rng(seed);
  const s = new Scheduler(options);
  const people = [];
  for (const [tableId, count] of [['A', 10], ['B', 4], ['C', 5]]) {
    s.setHeadcount(tableId, count);
    for (let i = 0; i < count; i++) people.push(s.join({ tableId, name: `${tableId}${i + 1}` }));
  }
  people.push(s.join({ tableId: 'Comptoir', name: 'S1', headcount: 40 }));
  let n = 1;
  for (const p of people.slice().sort(() => random() - 0.5)) s.chooseSong(p, song(n++), 'append');
  for (let k = 0; k < 4; k++) {
    const a = people[Math.floor(random() * people.length)];
    const b = people[Math.floor(random() * people.length)];
    if (a === b) continue;
    const duo = s.inviteDuet(a, b.id, song(n++));
    if (duo.duet.state === 'pending') s.answerDuet(b, true, duo.entryId);
  }
  return s;
}

function playAll(s) {
  const played = [];
  const forecast = s.readyView().map(item => item.entryId);
  for (let guard = 0; guard < 200; guard++) {
    const selected = s.select();
    if (!selected) break;
    s.commit(selected);
    s.songEnded(selected.ids);
    played.push(selected);
  }
  return { played, forecast };
}

// Nombre de passages où quelqu'un remonte sur scène alors qu'une personne
// dont un titre passera plus tard n'est encore jamais montée.
function secondBeforeFirst(played) {
  const seen = new Set();
  let count = 0;
  played.forEach((current, index) => {
    const repeat = current.ids.some(pid => seen.has(pid));
    const unseenLater = played.slice(index + 1).some(next =>
      next.ids.some(pid => !seen.has(pid) && !current.ids.includes(pid)));
    if (repeat && unseenLater) count++;
    current.ids.forEach(pid => seen.add(pid));
  });
  return count;
}

function tableRuns(played) {
  let same = 0, run = 1, longest = 1, previous = null;
  for (const current of played) {
    const groups = current.groups || [current.group];
    if (previous && groups.some(g => previous.includes(g))) { same++; run++; longest = Math.max(longest, run); }
    else run = 1;
    previous = groups;
  }
  return { same, longest };
}

const modes = [
  ['chacun son tour', {}],
  ['tables à tour de rôle', { tableRotation: true }],
  ['compromis', { tableRotation: true, weightedTables: true }],
];

for (const [mode, options] of modes) {
  test(`essai au bar (${mode}) : personne ne rechante avant les premiers passages`, () => {
    for (let seed = 1; seed <= 25; seed++) {
      const s = barEvening(options, seed);
      const { played, forecast } = playAll(s);
      assert.equal(played.length, forecast.length, `graine ${seed} : tout ce qui était annoncé a chanté`);
      assert.deepEqual(played.map(item => item.song.entryId), forecast,
        `graine ${seed} : l'ordre réellement joué est celui annoncé au départ`);
      assert.equal(secondBeforeFirst(played), 0, `graine ${seed} : ${played.map(p => p.names.join('&')).join(' ')}`);
    }
  });
}

test('essai au bar (chacun son tour) : la grande table ne garde plus le micro', () => {
  let same = 0, longest = 0, firstRound = 0, firstRoundLongest = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const s = barEvening({}, seed);
    const { played } = playAll(s);
    const runs = tableRuns(played);
    same += runs.same;
    longest = Math.max(longest, runs.longest);
    // Tour des 20 solos : 10 chanteurs de A pour 10 autres, une alternance
    // parfaite est possible.
    const round = tableRuns(played.slice(0, 20));
    firstRound += round.same;
    firstRoundLongest = Math.max(firstRoundLongest, round.longest);
  }
  // Mesures de l'ancien ordonnanceur sur ces 25 soirées : 100 reprises de
  // table dans le tour des solos (séries de 5) et 165 sur toute la soirée
  // (séries de 9), identiques en mode personnes et en rotation des tables.
  assert.ok(firstRound <= 15, `tour des solos : ${firstRound} reprises de table sur 25 soirées`);
  assert.ok(firstRoundLongest <= 2, `tour des solos : série la plus longue ${firstRoundLongest}`);
  assert.ok(same <= 90, `soirée complète, duos compris : ${same} reprises`);
  assert.ok(longest <= 6, `série la plus longue (duos entre tables en fin de liste compris) : ${longest}`);
});

test('les trois modes donnent réellement des parts différentes aux tables', () => {
  const shareOfA = options => {
    let a = 0, total = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const s = barEvening(options, seed);
      // Premier tiers du tour : qui a la priorité ?
      const firstTen = s.readyView().slice(0, 10);
      a += firstTen.filter(item => item.tableId === 'A').length;
      total += firstTen.length;
    }
    return a / total;
  };
  const people = shareOfA({}), tables = shareOfA({ tableRotation: true }),
    compromise = shareOfA({ tableRotation: true, weightedTables: true });
  assert.ok(people > compromise && compromise > tables,
    `part de la table de 10 dans les 10 premiers passages : chacun ${people}, compromis ${compromise}, tables ${tables}`);
  assert.ok(people >= 0.45, 'chacun son tour : la table de 10 a environ la moitié des passages');
  assert.ok(tables <= 0.35, 'tables à tour de rôle : parts égales, les petites tables passent tôt');
});

function lateTable(options) {
  const s = new Scheduler(options);
  let n = 1;
  const regulars = [];
  for (const [tableId, count] of [['B', 3], ['C', 3], ['D', 2]]) {
    s.setHeadcount(tableId, count);
    for (let i = 0; i < count; i++) {
      const p = s.join({ tableId, name: `${tableId}${i + 1}` });
      regulars.push(p);
      for (let k = 0; k < 6; k++) s.chooseSong(p, song(n++), 'append');
    }
  }
  const played = [];
  const play = () => {
    const selected = s.select();
    s.commit(selected); s.songEnded(selected.ids);
    played.push(selected);
    return selected;
  };
  for (let i = 0; i < 16; i++) play();
  s.setHeadcount('X', 8);
  const newcomers = [];
  for (let i = 0; i < 8; i++) {
    const p = s.join({ tableId: 'X', name: `X${i + 1}` });
    newcomers.push(p);
    s.chooseSong(p, song(n++), 'append');
  }
  const arrival = played.length;
  for (let i = 0; i < 20; i++) play();
  return { s, played, arrival, newcomers };
}

test('une table de 8 qui arrive tard est intercalée, sans double passage pendant son attente', () => {
  const { played, arrival, newcomers } = lateTable({});
  const after = played.slice(arrival);
  const names = after.map(item => item.names.join('&')).join(' ');
  assert.ok(tableRuns(after.slice(0, 16)).longest <= 1, `table X intercalée : ${names}`);
  // Personne ne chante deux fois pendant l'attente d'un nouvel arrivant.
  const pending = new Set(newcomers.map(p => p.id));
  const sangSinceArrival = new Map();
  for (const item of after) {
    for (const pid of item.ids) {
      if (!pending.has(pid)) {
        const count = (sangSinceArrival.get(pid) || 0) + 1;
        sangSinceArrival.set(pid, count);
        assert.ok(count <= 1 || pending.size === 0, `${item.names} rechante pendant l'attente des nouveaux : ${names}`);
      }
      pending.delete(pid);
    }
  }
  assert.equal(pending.size, 0, 'tous les nouveaux ont chanté dans les vingt passages suivants');
});

test('option désactivée : les nouveaux chantent tous avant les habitués (ancien comportement)', () => {
  const { played, arrival } = lateTable({ interleaveArrivals: false });
  const after = played.slice(arrival, arrival + 8);
  assert.ok(after.every(item => item.groups.includes('X')), after.map(item => item.names).join(' '));
});

test('bonus et malus : fréquence réglable, premiers passages protégés', () => {
  const s = new Scheduler();
  let n = 1;
  const people = [];
  for (let t = 1; t <= 6; t++) {
    s.setHeadcount(String(t), 1);
    const p = s.join({ tableId: String(t), name: `P${t}` });
    people.push(p);
    for (let k = 0; k < 20; k++) s.chooseSong(p, song(n++), 'append');
  }
  const [vip, lowSpender] = people;
  s.setPersonBonus(vip.id, 3);
  s.setPersonBonus(lowSpender.id, -3);
  const first = [];
  for (let i = 0; i < 6; i++) {
    const selected = s.select();
    s.commit(selected); s.songEnded(selected.ids);
    first.push(selected.ids[0]);
  }
  assert.equal(new Set(first).size, 6, 'le malus chante quand même une fois avant les reprises');
  const counts = new Map(people.map(p => [p.id, 0]));
  for (let i = 0; i < 60; i++) {
    const selected = s.select();
    s.commit(selected); s.songEnded(selected.ids);
    counts.set(selected.ids[0], counts.get(selected.ids[0]) + 1);
  }
  assert.ok([...counts.values()].every(value => value < 20), 'aucune liste épuisée pendant la mesure');
  const normal = (counts.get(people[2].id) + counts.get(people[3].id) + counts.get(people[4].id)) / 3;
  assert.ok(counts.get(vip.id) >= normal * 1.6, `bonus +3 : ${counts.get(vip.id)} passages contre ${normal} en moyenne`);
  assert.ok(counts.get(lowSpender.id) <= normal * 0.65, `malus -3 : ${counts.get(lowSpender.id)} passages contre ${normal}`);
  assert.throws(() => s.setPersonBonus(vip.id, 4), /-3 à \+3/);
  assert.throws(() => s.setTableBonus('inconnue', 1), /Table inconnue/);
});

test('bonus de table : la table favorisée passe plus tôt dans le tour, sans reprendre le micro', () => {
  const build = bonus => {
    const s = new Scheduler();
    let n = 1;
    for (const [tableId, count] of [['A', 4], ['B', 4], ['C', 4]]) {
      s.setHeadcount(tableId, count);
      for (let i = 0; i < count; i++) s.chooseSong(s.join({ tableId, name: `${tableId}${i + 1}` }), song(n++));
    }
    if (bonus) s.setTableBonus('C', bonus);
    return s;
  };
  const rank = s => s.readyView().map((item, index) => item.tableId === 'C' ? index : null).filter(x => x !== null);
  const neutral = rank(build(0)), favoured = rank(build(3)), penalised = rank(build(-3));
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
  assert.ok(mean(favoured) < mean(neutral), `bonus : places ${favoured} contre ${neutral}`);
  assert.ok(mean(penalised) > mean(neutral), `malus : places ${penalised} contre ${neutral}`);
  assert.ok(tableRuns(build(3).readyView().map(item => ({ groups: [item.tableId] }))).longest <= 2);
});

test('Priorité : seule la ligne choisie bouge, le reste de la file garde son ordre', () => {
  const s = barEvening({}, 3);
  const before = s.readyView().filter(item => !item.future);
  const moved = before[7];
  const change = s.manualOverrideState();
  s.staffMove(moved.ids[0], 0);
  s.recordManualChange({ kind: 'priority', personId: moved.ids[0], name: moved.name, from: 8, to: 1,
    before: change, native: 'x'.repeat(64) });
  const after = s.readyView().filter(item => !item.future);
  assert.equal(after[0].entryId, moved.entryId);
  assert.deepEqual(after.slice(1).map(item => item.entryId),
    before.filter(item => item.entryId !== moved.entryId).map(item => item.entryId),
    'les autres titres restent exactement dans l’ordre affiché');
  assert.equal(s.solverStatus().plan, 'manual');
  s.undoLastManualChange(null, 'x'.repeat(64));
  assert.deepEqual(s.readyView().filter(item => !item.future).map(item => item.entryId),
    before.map(item => item.entryId), 'annuler rétablit l’ordre précédent');
});

test('déplacement manuel vers le bas : le reste ne se réorganise pas', () => {
  const s = barEvening({}, 5);
  const before = s.readyView().filter(item => !item.future);
  const moved = before[1];
  s.staffMove(moved.ids[0], 5);
  const expected = before.filter(item => item.entryId !== moved.entryId).map(item => item.entryId);
  expected.splice(5, 0, moved.entryId);
  assert.deepEqual(s.readyView().filter(item => !item.future).map(item => item.entryId), expected);
});

test('changer de mode ne remet pas à zéro le tour des personnes', () => {
  for (const [, options] of modes) {
    const s = barEvening({}, 7);
    for (let i = 0; i < 8; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
    const seen = new Set(s.roundPeople);
    Object.assign(s.opts, options);
    const next = s.readyView();
    next.forEach((item, index) => {
      const repeat = item.ids.some(pid => seen.has(pid));
      const freshLater = next.slice(index + 1).some(later =>
        later.ids.some(pid => !seen.has(pid) && !item.ids.includes(pid)));
      assert.ok(!(repeat && freshLater), `reprise avant la fin du tour : ${next.map(x => x.name).join(' ')}`);
      item.ids.forEach(pid => seen.add(pid));
    });
  }
});

test('retrait groupé : un titre suivant précis peut être retiré sans toucher au premier', () => {
  const s = new Scheduler();
  s.setHeadcount('1', 1);
  const p = s.join({ tableId: '1', name: 'Alice' });
  s.chooseSong(p, song(1)); s.chooseSong(p, song(2), 'append'); s.chooseSong(p, song(3), 'append');
  const second = s.songsOf(p)[1];
  s.staffRemoveEntry(p.id, second.entryId);
  assert.deepEqual(s.songsOf(p).map(item => item.songId), [1, 3]);
  s.staffRemoveEntry(p.id, s.songsOf(p)[0].entryId);
  assert.deepEqual(s.songsOf(p).map(item => item.songId), [3]);
  assert.throws(() => s.staffRemoveEntry(p.id, 'absent'), /introuvable/);
});

test('historique de scène : passages récents, fin enregistrée', () => {
  const s = barEvening({}, 2);
  const selected = s.select();
  s.commit(selected);
  const entry = s.recordStage(selected, 1000);
  assert.deepEqual(entry.ids, selected.ids);
  assert.equal(s.endStage(selected, 2000).endedAt, 2000);
  assert.equal(s.stageHistory.length, 1);
});

test('un plan adopté survit au passage prévu de sa tête (pas de nouveau calcul à chaque chanson)', async () => {
  const s = barEvening({}, 4);
  const requests = [];
  s.solverBridge = { available: true, lastError: null, solve: request => {
    requests.push(request);
    return Promise.resolve({ requestId: request.requestId, order: request.performances.map(row => row.id) });
  } };
  assert.equal(await s.whenPlanReady(), true);
  assert.equal(requests.length, 1);
  for (let i = 0; i < 5; i++) {
    s.reserveNext();
    const selected = s.select();
    s.commit(selected);
    s.songEnded(selected.ids);
    await s.whenPlanReady();
  }
  assert.equal(requests.length, 1, 'réservation, envoi et fin de chanson ne relancent pas Timefold');
  s.chooseSong(s.people.get(s.Q[0]), song(999), 'append');
  await s.whenPlanReady();
  assert.equal(requests.length, 2, 'un nouveau titre relance le calcul');
});
