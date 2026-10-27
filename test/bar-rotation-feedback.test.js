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

// Constats du gérant des 25 et 26 octobre : en « Chacun son tour », le tour
// des solos, tous des premiers passages, fait tourner les tables (premier de
// chaque table : un cycle où chaque table fait passer une personne, les tables
// dans l'ordre d'ajout de leur candidat, dans une table ses personnes dans
// l'ordre d'ajout). Tout le monde a ajouté avant le premier passage : le
// cycle k fait passer le k-ième ajouté de chaque table. La grande table n'y
// reprend le micro qu'en fin de tour, quand il ne reste qu'elle (premier
// ajouté, premier servi pur : 143 reprises sur ces 25 soirées). Elle garde
// alors le micro tant que seuls ses passages sont permis : ses derniers
// premiers passages, puis des duos où elle chante, qui présentent encore une
// personne ou parce qu'il ne reste qu'eux (graine 3 : A10 A4 A3 A5 A8, puis
// C5&A9 A10&B1 A3&C3 A5&A10, neuf passages de suite). Les modes de tables
// gardent l'alternance dès le premier tour.
test('essai au bar (chacun son tour) : premiers passages par cycle des tables, séries de la grande table bornées sur toute la soirée', () => {
  let rest = 0, longest = 0, firstRuns = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const s = barEvening({}, seed);
    const rank = new Map();
    const cycles = [...s.people.values()].sort((a, b) => a.readySince - b.readySince)
      .map(p => { const k = rank.get(p.group) || 0; rank.set(p.group, k + 1); return { p, k }; })
      .sort((a, b) => a.k - b.k || a.p.readySince - b.p.readySince).map(({ p }) => p);
    const { played } = playAll(s);
    assert.deepEqual(played.slice(0, 20).map(item => item.ids[0]), cycles.map(p => p.id),
      `graine ${seed} : le tour des solos suit le cycle des tables`);
    const round = tableRuns(played.slice(0, 20));
    assert.equal(round.same, tableRuns(cycles.map(p => ({ groups: [p.group] }))).same,
      `graine ${seed} : pas d'autre reprise de table que celles du cycle`);
    firstRuns += round.same;
    rest += tableRuns(played).same - round.same;
    longest = Math.max(longest, tableRuns(played).longest);
  }
  // Tour des solos : la table de 10 enchaîne ses derniers chanteurs quand il
  // ne reste qu'elle : 100 reprises sur ces 25 soirées, quatre par soirée.
  assert.ok(firstRuns <= 100, `tour des solos : ${firstRuns} reprises`);
  // Mesures de l'ancien ordonnanceur sur la suite de ces 25 soirées : 69
  // reprises (63 avec l'ordre d'ajout), séries de 6 au plus.
  assert.ok(rest <= 75, `après le tour des solos, duos compris : ${rest} reprises`);
  // Série la plus longue sur toute la soirée : avec le cycle des tables, la
  // fin du tour des solos, quand il ne reste que les passages de la grande
  // table (ses premiers passages, puis des duos où elle chante) : 9 au plus
  // sur ces 25 soirées (6 avant le cycle des tables).
  assert.ok(longest <= 9, `série la plus longue de la soirée (fin du tour des solos et duos de la grande table compris) : ${longest}`);
});

// Premiers passages : « Chacun son tour » fait tourner les tables comme
// « Tables à tour de rôle » (cycle des tables, décision du gérant du
// 26 octobre) ; « Compromis » donne à la grande table une part plus grande.
test('les modes donnent des parts différentes aux tables ; chacun son tour fait tourner les tables aux premiers passages', () => {
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
  assert.ok(compromise > tables && compromise > people,
    `part de la table de 10 dans les 10 premiers passages : chacun ${people}, compromis ${compromise}, tables ${tables}`);
  assert.ok(people <= 0.35, `chacun son tour : un premier de chaque table par cycle (${people})`);
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

// En « Chacun son tour », les premiers passages suivent l'ordre d'ajout
// (constat du gérant du 25 octobre) : le bonus n'y change rien, il joue dès le
// tour suivant. Les tables ajoutent leurs titres mêlées (A1, B1, C1, A2…).
test('bonus de table : la table favorisée passe plus tôt dans le tour, sans reprendre le micro', () => {
  const build = bonus => {
    const s = new Scheduler();
    for (const tableId of ['A', 'B', 'C']) s.setHeadcount(tableId, 4);
    const people = [];
    for (let i = 0; i < 4; i++) for (const tableId of ['A', 'B', 'C']) people.push(s.join({ tableId, name: `${tableId}${i + 1}` }));
    let n = 1;
    for (const p of people) s.chooseSong(p, song(n++));
    for (const p of people) s.chooseSong(p, song(n++), 'append');
    if (bonus) s.setTableBonus('C', bonus);
    return s;
  };
  const names = s => s.readyView().map(item => item.name);
  const added = names(build(0)).slice(0, 12);
  for (const bonus of [3, -3]) assert.deepEqual(names(build(bonus)).slice(0, 12), added, `bonus ${bonus} : premier tour`);
  const rank = s => s.readyView().slice(12).map((item, index) => item.tableId === 'C' ? index : null).filter(x => x !== null);
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

// Retour du bar : deux tables de quatre et une personne seule, deux titres
// chacun. Au deuxième tour, la personne seule passait devant une personne
// qui avait chanté avant elle au premier tour : celle-ci la voyait chanter
// deux fois pendant sa propre attente (règle de patience de _pick).
function twoTablesAndSolo() {
  const s = new Scheduler();
  s.setHeadcount('A', 6);
  s.setHeadcount('B', 6);
  const solo = s.join({ tableId: 'Comptoir', name: 'S' });
  const people = ['A1', 'B1', 'A2', 'B2', 'S', 'A3', 'B3', 'A4', 'B4'].map(name =>
    name === 'S' ? solo : s.join({ tableId: name[0], name }));
  let n = 1;
  for (const p of people) for (let k = 0; k < 2; k++) s.chooseSong(p, song(n++), 'append');
  return { s, more: () => song(1000 + n++) };
}

// Même soirée, mais la personne seule ajoute ses titres après les deux
// premiers passages : le premier tour reste A1 B1 A2 B2 S A3 B3 A4 B4 (cycle
// des tables : S rejoint le deuxième cycle, après A2 et B2). Joue `count`
// passages en tout.
function twoTablesAndLateSolo(count) {
  const s = new Scheduler();
  s.setHeadcount('A', 6);
  s.setHeadcount('B', 6);
  const solo = s.join({ tableId: 'Comptoir', name: 'S' });
  const people = ['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'A4', 'B4'].map(name => s.join({ tableId: name[0], name }));
  let n = 1;
  for (const p of people) for (let k = 0; k < 2; k++) s.chooseSong(p, song(n++), 'append');
  const play = () => { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); return sel.names.join(' & '); };
  const played = [];
  for (let i = 0; i < count; i++) {
    if (i === 2) for (let k = 0; k < 2; k++) s.chooseSong(solo, song(n++), 'append');
    played.push(play());
  }
  return { s, play, played, more: () => song(1000 + n++) };
}

// Pour chaque passage, personnes vues deux fois depuis le passage précédent
// du même chanteur.
function doublesDuringWait(played) {
  let doubles = 0;
  const last = new Map();
  played.forEach((current, index) => {
    for (const pid of current.ids) {
      if (last.has(pid)) {
        const seen = new Map();
        for (const other of played.slice(last.get(pid) + 1, index)) {
          for (const q of other.ids) seen.set(q, (seen.get(q) || 0) + 1);
        }
        doubles += [...seen.values()].filter(count => count >= 2).length;
      }
      last.set(pid, index);
    }
  });
  return doubles;
}

test('deux tables de quatre et une personne seule : le deuxième tour reprend l’ordre du premier', () => {
  const { s } = twoTablesAndSolo();
  const first = s.select();
  s.commit(first);
  const forecast = [first.names.join('&'), ...s.readyView().map(item => item.name)];
  assert.equal(forecast.length, 18);
  assert.deepEqual(forecast.slice(9), forecast.slice(0, 9), `prévision : ${forecast.join(' ')}`);
  s.songEnded(first.ids);
  const played = [first];
  for (let guard = 0; guard < 40; guard++) {
    const selected = s.select();
    if (!selected) break;
    s.commit(selected); s.songEnded(selected.ids);
    played.push(selected);
  }
  assert.deepEqual(played.map(item => item.names.join('&')), forecast, 'ordre joué = ordre annoncé');
  assert.equal(doublesDuringWait(played), 0);
});

test('chacun rajoute un titre après avoir chanté : personne ne voit quelqu’un chanter deux fois pendant son attente', () => {
  const { s, more } = twoTablesAndSolo();
  const played = [];
  for (let i = 0; i < 45; i++) {
    const selected = s.select();
    s.commit(selected); s.songEnded(selected.ids);
    played.push(selected);
    s.chooseSong(s.people.get(selected.ids[0]), more(), 'append');
  }
  const names = played.map(item => item.names.join('&'));
  assert.equal(doublesDuringWait(played), 0, names.join(' '));
  assert.equal(tableRuns(played).same, 0, `pas deux fois la même table de suite : ${names.join(' ')}`);
});

test('un plan adopté ne contourne pas la règle de patience', () => {
  const { s } = twoTablesAndSolo();
  // Premier tour : A1 B1 S A2 B2 A3 B3 A4 B4 (cycle des tables), puis A1.
  for (let i = 0; i < 10; i++) {
    const selected = s.select();
    s.commit(selected); s.songEnded(selected.ids);
  }
  const view = s.readyView();
  assert.equal(view[0].name, 'B1', view.map(item => item.name).join(' '));
  const solo = view.find(item => item.name === 'S');
  // Le plan met la personne seule en tête : elle chanterait une deuxième fois
  // pendant l'attente de B1, passé avant elle au premier tour.
  s.solverPlan = { version: s.version, ranks: new Map([
    [solo.entryId, 0], ...view.filter(item => item !== solo).map((item, index) => [item.entryId, index + 1]),
  ]) };
  assert.deepEqual(s.select().names, ['B1']);
});

// Le bar retire le dernier titre d'une personne puis en ajoute un autre,
// sans passage entre les deux : c'est un échange, l'attente continue. Sans
// cela, la personne n'était plus protégée par la règle de patience et la
// personne seule repassait devant elle au deuxième tour.
test('titre échangé sans passage entre le retrait et l’ajout : la prévision ne bouge pas', () => {
  for (const by of ['self', 'staff']) {
    for (let k = 9; k <= 12; k++) {
      for (const name of ['A1', 'B1', 'A2', 'B2', 'S', 'A3', 'B3', 'A4', 'B4']) {
        const { s, more } = twoTablesAndSolo();
        const played = [];
        for (let i = 0; i < k; i++) {
          const selected = s.select();
          s.commit(selected); s.songEnded(selected.ids);
          played.push(selected);
        }
        const p = [...s.people.values()].find(person => person.name === name);
        if (!s.songsOf(p).length) continue;
        const before = s.readyView().map(item => item.name);
        if (by === 'staff') s.staffRemove(p.id);
        else s.removeSong(p, s.songsOf(p)[0].entryId, 'self');
        assert.equal(s.songsOf(p).length, 0);
        s.chooseSong(p, more(), 'append');
        const after = s.readyView();
        assert.deepEqual(after.map(item => item.name), before, `${by}, ${k} passages, échange de ${name}`);
        assert.equal(doublesDuringWait([...played, ...after]), 0, `${by}, ${k} passages, échange de ${name} : ${before.join(' ')}`);
      }
    }
  }
});

// Choix du bar après le 12 octobre : quand les tables n'ont pas le même
// nombre de titres prêts (4 contre 3), la règle de patience passe avant la
// règle des tables en « Chacun son tour ». Au changement de tour, la même
// table chante deux fois de suite plutôt que de faire voir à quelqu'un un
// passage en double.
test('chacun son tour, tables inégales : la patience passe avant la règle des tables', () => {
  const s = new Scheduler();
  s.setHeadcount('A', 6);
  s.setHeadcount('B', 6);
  const people = ['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'A4'].map(name => s.join({ tableId: name[0], name }));
  let n = 1;
  for (const p of people) s.chooseSong(p, song(n++), 'append');
  const played = [];
  for (let i = 0; i < 35; i++) {
    const selected = s.select();
    s.commit(selected); s.songEnded(selected.ids);
    played.push(selected);
    s.chooseSong(s.people.get(selected.ids[0]), song(n++), 'append');
  }
  const names = played.map(item => item.names.join('&'));
  assert.equal(doublesDuringWait(played), 0, names.join(' '));
  assert.deepEqual(names.slice(7, 14), names.slice(0, 7), `le tour 2 reprend l’ordre du tour 1 : ${names.join(' ')}`);
  const runs = tableRuns(played);
  assert.ok(runs.same > 0, 'la même table enchaîne au changement de tour');
  assert.equal(runs.longest, 2, `jamais trois fois de suite : ${names.join(' ')}`);
});

// « Tables à tour de rôle » et « Compromis » : la rotation des tables passe
// avant la patience. Avec 4 contre 3, la même table ne chante deux fois de
// suite qu'en fin de tour, quand l'autre table a déjà toute chanté.
for (const [mode, opts] of [['tables à tour de rôle', { tableRotation: true }],
  ['compromis', { tableRotation: true, weightedTables: true }]]) {
  test(`${mode}, tables inégales : la rotation des tables passe avant la patience`, () => {
    const s = new Scheduler(opts);
    s.setHeadcount('A', 6);
    s.setHeadcount('B', 6);
    const people = ['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'A4'].map(name => s.join({ tableId: name[0], name }));
    let n = 1;
    for (const p of people) s.chooseSong(p, song(n++), 'append');
    const played = [];
    for (let i = 0; i < 28; i++) {
      const selected = s.select();
      s.commit(selected); s.songEnded(selected.ids);
      played.push(selected);
      s.chooseSong(s.people.get(selected.ids[0]), song(n++), 'append');
    }
    const names = played.map(item => item.names.join('&')).join(' ');
    played.forEach((current, index) => {
      if (!index || current.groups[0] !== played[index - 1].groups[0]) return;
      // Même table deux fois de suite : dernier passage de son tour.
      assert.ok(!played[index + 1] || played[index + 1].newPersonRound, `${index} : ${names}`);
    });
    assert.equal(tableRuns(played).longest, 2, names);
  });
}

// « Compromis » : la taille d'une table est le nombre de chanteurs inscrits
// qui ont un titre, prêt ou non. Une table de 4 chanteurs dont 2 ont un titre
// prêt (les 2 autres « Pas prêt ») passe devant une table de 2 chanteurs,
// créée avant elle ; « Chacun son tour » compte les seuls titres prêts et
// départage ici par l'ordre des tables.
test('compromis : la part d’une table suit ses chanteurs inscrits, pas ses seuls titres prêts', () => {
  const first = (opts, idle = 0) => {
    const s = new Scheduler(opts);
    s.setHeadcount('B', 8);
    s.setHeadcount('A', 6);
    const b = ['B1', 'B2'].map(name => s.join({ tableId: 'B', name }));
    const a = ['A1', 'A2', 'A3', 'A4'].map(name => s.join({ tableId: 'A', name }));
    let n = 100;
    for (const p of [...b, a[0], a[1]]) s.chooseSong(p, song(n++), 'append');
    // A3 et A4 ont un titre, mais « Pas prêt » : inscrits, sans titre prêt.
    for (const p of [a[2], a[3]]) {
      s.chooseSong(p, song(n++), 'append');
      s.deferPassage(p.id, { entryId: p.song.entryId, ids: [p.id] }, 2);
    }
    // Prénoms inscrits à B sans aucun titre : ils ne comptent pas.
    for (let k = 0; k < idle; k++) s.join({ tableId: 'B', name: `B-sans-titre-${k}` });
    return s.people.get(s.select().ids[0]).tableId;
  };
  assert.equal(first({ tableRotation: true, weightedTables: true }), 'A');
  assert.equal(first({ tableRotation: true, weightedTables: true }, 5), 'A', 'des prénoms sans titre ne font pas passer B');
  assert.equal(first({}), 'B');
});

// Relecture : un titre choisi puis retiré ne compte pas dans la taille de la
// table, même répété après chaque passage (sinon des tickets vides
// gonfleraient la part d'une table).
test('compromis : un titre choisi puis retiré ne compte pas', () => {
  const s = new Scheduler({ tableRotation: true, weightedTables: true });
  s.setHeadcount('A', 6); s.setHeadcount('B', 6);
  const a = s.join({ tableId: 'A', name: 'A1' }), b = s.join({ tableId: 'B', name: 'B1' });
  for (let k = 0; k < 3; k++) { s.chooseSong(a, song(10 + k), 'append'); s.chooseSong(b, song(20 + k), 'append'); }
  const r = s.join({ tableId: 'B', name: 'B2' });
  for (let i = 0; i < 3; i++) {
    s.chooseSong(r, song(30 + i)); s.removeSong(r, r.song.entryId);
    assert.equal(s._registeredWeights().get(b.group), 1, `titre retiré (${i + 1}) : ne compte pas`);
    const sel = s.select(); s.commit(sel); s.songEnded(sel.ids);
  }
  s.chooseSong(r, song(40));
  assert.equal(s._registeredWeights().get(b.group), 2, 'titre gardé : compte');
});

// Échange de titre : seul un retrait réel, sans passage entre le retrait et
// l'ajout, garde l'attente. Retrait du bar sans titre, passage annulé puis
// nouveau passage, et deuxième vidage de la liste commencent une attente.
test('échange de titre : retrait du bar sans titre, passage annulé, liste revidée', () => {
  const fresh = () => {
    const s = new Scheduler();
    s.setHeadcount('A', 4); s.setHeadcount('B', 4); s.setHeadcount('C', 4);
    const [a, b, c] = ['A', 'B', 'C'].map(t => s.join({ tableId: t, name: `${t}1` }));
    return { s, a, b, c };
  };
  // Le bar confirme un retrait resté affiché alors que la liste était déjà vide.
  {
    const { s, a, b } = fresh();
    s.chooseSong(a, song(1)); s.chooseSong(b, song(2)); s.chooseSong(b, song(3), 'append');
    for (let i = 0; i < 2; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
    assert.equal(s.songsOf(a).length, 0);
    s.staffRemove(a.id);
    s.chooseSong(a, song(4), 'append');
    assert.equal(a.readySerial, s.appearanceSerial, 'retrait sans titre : nouvelle attente');
  }
  // Retrait après un envoi, envoi annulé, puis vrai passage avant l'ajout.
  {
    const { s, a, b, c } = fresh();
    s.chooseSong(a, song(1)); s.chooseSong(b, song(2)); s.chooseSong(c, song(3));
    const first = s.select(); s.commit(first); s.songEnded(first.ids);
    const p = s.people.get(first.ids[0]);
    s.chooseSong(p, song(4), 'append');
    const skipped = s.select(); s.commit(skipped);
    s.removeSong(p, p.song.entryId);
    s.rollbackUnplayed(skipped);
    const sung = s.select(); s.commit(sung); s.songEnded(sung.ids);
    s.chooseSong(p, song(5));
    assert.equal(p.readySerial, s.appearanceSerial, 'un passage a eu lieu pendant la liste vide');
  }
  // Échange, puis liste revidée autrement (départ) et rechoisie : nouvelle attente.
  {
    const { s, a, b } = fresh();
    s.chooseSong(a, song(1)); s.chooseSong(b, song(2)); s.chooseSong(b, song(3), 'append');
    const sel = s.select(); s.commit(sel); s.songEnded(sel.ids);
    const p = s.people.get(sel.ids[0]);
    s.chooseSong(p, song(4), 'append');
    const before = p.readySerial;
    s.removeSong(p, p.song.entryId);
    s.chooseSong(p, song(5));
    assert.equal(p.readySerial, before, 'échange : même attente');
    assert.equal(p.emptiedAt, undefined, 'la marque d’échange sert une seule fois');
  }
});

// Relecture : dans les modes de rotation des tables, la patience choisit
// encore entre les passages des autres tables. Tables équilibrées, chacun
// reprend un titre : au plus un double au recalage, jamais deux fois la même
// table.
for (const [mode, opts] of [['tables à tour de rôle', { tableRotation: true }],
  ['compromis', { tableRotation: true, weightedTables: true }]]) {
  test(`${mode}, tables équilibrées : la patience départage les autres tables`, () => {
    const s = new Scheduler(opts);
    for (const t of ['A', 'B', 'C', 'D']) s.setHeadcount(t, 8);
    const people = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1'].map(name => s.join({ tableId: name[0], name }));
    let n = 1;
    for (const p of people) s.chooseSong(p, song(n++), 'append');
    const played = [];
    for (let i = 0; i < 28; i++) {
      const selected = s.select(); s.commit(selected); s.songEnded(selected.ids); played.push(selected);
      s.chooseSong(s.people.get(selected.ids[0]), song(n++), 'append');
    }
    assert.ok(doublesDuringWait(played) <= 1, played.map(x => x.names.join('&')).join(' '));
    assert.equal(tableRuns(played).same, 0);
  });
}

// Un malus n'est pas protégé par la patience : la personne seule, passée
// pendant l'attente de B2, peut repasser devant elle.
test('malus : la personne n’est pas protégée par la patience', () => {
  const { s, played } = twoTablesAndLateSolo(9);
  assert.deepEqual(played, ['A1', 'B1', 'A2', 'B2', 'S', 'A3', 'B3', 'A4', 'B4']);
  const order = () => s.readyView().map(x => x.name);
  assert.ok(order().indexOf('B2') < order().indexOf('S'), order().join(' '));
  const b2 = [...s.people.values()].find(p => p.name === 'B2');
  s.setPersonBonus(b2.id, -1);
  assert.ok(order().indexOf('S') < order().indexOf('B2'), order().join(' '));
});

// Retrait du dernier titre, un passage, puis ajout : ce n'est pas un échange,
// l'attente recommence et la personne seule passe devant.
test('retrait du dernier titre, un passage, puis ajout : l’attente recommence', () => {
  const { s, more, play } = twoTablesAndLateSolo(9);
  const b2 = [...s.people.values()].find(p => p.name === 'B2');
  const swapped = s.readyView().map(x => x.name);
  assert.ok(swapped.indexOf('B2') < swapped.indexOf('S'), swapped.join(' '));
  s.removeSong(b2, s.songsOf(b2)[0].entryId, 'self');
  play();
  s.chooseSong(b2, more(), 'append');
  const order = s.readyView().map(x => x.name);
  assert.ok(order.indexOf('S') < order.indexOf('B2'), order.join(' '));
});

// Duo : ses propres chanteurs ne comptent pas comme doublés.
test('duo : ses propres chanteurs ne comptent pas comme doublés', () => {
  const s = new Scheduler();
  for (const t of ['A', 'B', 'C']) s.setHeadcount(t, 6);
  const [b0, c1, c2, b3] = [['B', 'B0'], ['C', 'C1'], ['C', 'C2'], ['B', 'B3']].map(([tableId, name]) => s.join({ tableId, name }));
  let n = 1;
  // Ordre d'ajout = ordre des premiers passages (« Chacun son tour »).
  for (const p of [b0, c2, b3, c1]) s.chooseSong(p, song(n++));
  const play = () => { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); return sel.names; };
  assert.deepEqual(play(), ['B0']);
  s.inviteDuet(b0, b3.id, song(n++));
  assert.deepEqual(play(), ['C2']);
  s.chooseSong(c2, song(n++));
  assert.deepEqual(play(), ['B3']);
  assert.deepEqual(play(), ['C1']);
  assert.deepEqual(play(), ['B0', 'B3']);
});

// Relecture : un déplacement du bar ne touche que la ligne déplacée, dans
// tous les modes, même si l'ordre gardé fait alors voir un double.
for (const [mode, opts] of modes) {
  test(`${mode} : un déplacement du bar garde l’ordre des autres lignes`, () => {
    let broken = 0, total = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const s = new Scheduler(opts);
      const random = rng(seed);
      let n = 1;
      for (let t = 0; t < 3; t++) {
        s.setHeadcount(`T${t}`, 6);
        const count = 1 + Math.floor(random() * 4);
        for (let k = 0; k < count; k++) {
          const p = s.join({ tableId: `T${t}`, name: `T${t}-${k}` });
          s.chooseSong(p, song(n++), 'append'); s.chooseSong(p, song(n++), 'append');
        }
      }
      for (let i = 0; i < 4; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
      const before = s.presenceView().filter(v => !v.future).map(v => v.ids[0]);
      if (before.length < 4) continue;
      const moved = before[before.length - 1];
      s.staffMove(moved, 1);
      const after = s.presenceView().filter(v => !v.future).map(v => v.ids[0]);
      const others = list => list.filter(pid => pid !== moved);
      total++;
      if (JSON.stringify(others(after)) !== JSON.stringify(others(before))) broken++;
    }
    assert.ok(total >= 20, `${total} essais`);
    assert.equal(broken, 0, `${broken} déplacements sur ${total} ont bougé d’autres lignes`);
  });
}

// Même règle sur un cas où la patience aurait réordonné les autres lignes :
// en « Compromis », un passage avancé en tête par le bar.
test('compromis : un passage avancé en tête par le bar ne réordonne pas les autres lignes', () => {
  const s = new Scheduler({ tableRotation: true, weightedTables: true });
  const random = rng(2);
  let n = 1;
  for (let t = 0; t < 3; t++) {
    s.setHeadcount(`T${t}`, 6);
    const count = 1 + Math.floor(random() * 4);
    for (let k = 0; k < count; k++) {
      const p = s.join({ tableId: `T${t}`, name: `T${t}-${k}` });
      for (let j = 0; j < 4; j++) s.chooseSong(p, song(n++), 'append');
    }
  }
  for (let i = 0; i < 4; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
  const before = s.presenceView().filter(v => !v.future).map(v => v.ids[0]);
  const moved = before[2];
  s.staffMove(moved, 0);
  const after = s.presenceView().filter(v => !v.future).map(v => v.ids[0]);
  const others = list => list.filter(pid => pid !== moved);
  assert.deepEqual(others(after), others(before));
});

// Relecture : un duo corrigé sur un passage ancien ne fait pas reculer le
// dernier passage du nouveau partenaire, qui garde sa place.
test('duo corrigé sur un passage ancien : le partenaire garde sa place', () => {
  const s = new Scheduler();
  const names = ['O', 'Q', 'B', 'C', 'D', 'P', 'E'];
  const people = Object.fromEntries(names.map((name, i) => {
    s.setHeadcount(`S${i}`, 4);
    const p = s.join({ tableId: `S${i}`, name });
    for (let k = 0; k < 3; k++) s.chooseSong(p, song(i * 10 + k + 1), 'append');
    return [name, p];
  }));
  const played = [];
  for (let i = 0; i < names.length; i++) {
    const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); played.push(sel);
  }
  const first = played.find(sel => sel.ids[0] === people.O.id);
  const lastP = people.P.lastAppearanceTurn;
  s.staffCountPartner(people.O.id, people.Q.id, first);
  s.staffUncountPartner(first.staffDuo, first, []);
  s.staffCountPartner(people.O.id, people.P.id, { song: { entryId: first.song.entryId }, turn: people.O.lastAppearanceTurn });
  assert.equal(people.P.lastAppearanceTurn, lastP);
  const order = s.readyView().map(v => v.name);
  assert.ok(order.indexOf('P') > order.indexOf('D'), order.join(' '));
});

// Relecture : un titre envoyé puis remis en file (« Pas prêt », retrait du
// bar) rend à sa personne son début d'attente, même si elle a choisi un autre
// titre entre-temps.
test('passage remis en file : la personne retrouve son début d’attente', () => {
  const s = new Scheduler();
  const people = ['A', 'B', 'C', 'D', 'E'].map((name, i) => { s.setHeadcount(String(i + 1), 4); return s.join({ tableId: String(i + 1), name }); });
  let n = 1;
  for (const p of people) s.chooseSong(p, song(n++));
  const play = () => { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); return sel; };
  for (let i = 0; i < 5; i++) { const sel = play(); s.chooseSong(s.people.get(sel.ids[0]), song(n++)); }
  const sent = s.select(); s.commit(sent);
  const owner = s.people.get(sent.ids[0]);
  const before = owner.readySerial;
  s.chooseSong(owner, song(n++), 'append');
  assert.ok(owner.readySerial >= before);
  s.rollbackUnplayed(sent, { requeue: true });
  assert.ok(owner.readySerial <= before, `${owner.readySerial} > ${before}`);
  assert.ok(owner.readySerial <= s.appearanceSerial);
});

// Coût (relecture) : au premier tour, aucun passage proposé n'a encore
// chanté, la patience ne calcule aucun début d'attente ; en « Compromis »,
// les chanteurs inscrits sont comptés une fois par prévision.
test('patience et compromis : pas de calcul inutile pendant une prévision', () => {
  const s = new Scheduler({ tableRotation: true, weightedTables: true });
  let n = 1;
  for (const t of ['T1', 'T2', 'T3']) {
    s.setHeadcount(t, 6);
    for (let i = 0; i < 5; i++) s.chooseSong(s.join({ tableId: t, name: `${t}P${i}` }), song(n++));
  }
  let calls = 0, waits = 0, scans = 0;
  const patient = s._patient, registered = s._registeredWeights;
  s._patient = function (...args) {
    calls++;
    const waitStart = args[4];
    args[4] = pid => { waits++; return waitStart(pid); };
    return patient.apply(this, args);
  };
  s._registeredWeights = function () { scans++; return registered.call(this); };
  s._forecast(false, [], null, true);
  assert.ok(calls > 0, 'la patience est bien consultée pendant la prévision');
  assert.equal(waits, 0, 'premier tour : aucun début d’attente calculé');
  assert.equal(scans, 1, `${scans} parcours des inscrits pour une prévision`);
});

// Relecture : une personne avec bonus peut chanter plus souvent, sans
// enchaîner deux de ses titres tant qu'un autre passage du tour est possible.
// (En fin de tour, il peut ne rester qu'elle : invitée d'un duo puis son
// propre titre, ou ses deux passages du tour, comme avant la patience.)
test('bonus : pas deux titres de suite de la même personne tant qu’un autre passage du tour est possible', () => {
  for (const level of [1, 2, 3]) {
    const s = new Scheduler();
    s.setHeadcount('1', 5);
    const alice = s.join({ tableId: '1', name: 'Alice' });
    const bruno = s.join({ tableId: '1', name: 'Bruno' });
    const chloe = s.join({ tableId: '1', name: 'Chloé' });
    const sam = s.join({ tableId: 'Comptoir', name: 'Sam' });
    let n = 1;
    // Chloé ajoute d'abord : premier tour Chloé Sam Alice Bruno (cycle des
    // tables). Dernière du cycle, il ne resterait qu'elle dans le tour pour
    // son passage en plus (fin de tour, voir plus haut).
    for (let k = 0; k < 3; k++) s.chooseSong(chloe, song(n++), 'append');
    for (let k = 0; k < 4; k++) s.chooseSong(alice, song(n++), 'append');
    for (let k = 0; k < 4; k++) s.chooseSong(bruno, song(n++), 'append');
    s.chooseSong(sam, song(n++), 'append');
    const duo = s.inviteDuet(sam, chloe.id, song(n++));
    s.answerDuet(chloe, true, duo.entryId);
    s.setPersonBonus(chloe.id, level);
    const played = [];
    for (let i = 0; i < 13; i++) {
      const sel = s.select();
      if (!sel) break;
      s.commit(sel); s.songEnded(sel.ids);
      played.push(sel);
    }
    const names = played.map(sel => sel.names.join(' & '));
    played.forEach((sel, i) => {
      if (i) assert.notEqual(sel.ids[0], played[i - 1].ids[0], `bonus ${level} : ${names.join(' ')}`);
    });
  }
});

// Bonus étalé (soirée du 23 octobre, « le bonus ne fait rien ») : dix
// chanteurs toujours prêts, tables A de 3, B de 3, C de 2 et deux solistes ;
// le bonus est posé après le premier tour. `at` : rangs des passages de
// chacun sur scène (titre ou invitée d'un duo), comptés après le bonus.
function steadyTen(options, setup, passages = 230) {
  const s = new Scheduler(options);
  const people = {};
  for (const [tableId, count] of [['A', 3], ['B', 3], ['C', 2], ['S1', 1], ['S2', 1]]) {
    s.setHeadcount(tableId, count);
    for (let i = 1; i <= count; i++) {
      const name = count > 1 ? `${tableId}${i}` : tableId;
      people[name] = s.join({ tableId, name });
    }
  }
  let n = 1;
  const refill = () => { for (const p of Object.values(people)) if (!s.songsOf(p).length) s.chooseSong(p, song(n++)); };
  refill();
  const at = new Map(Object.keys(people).map(name => [name, []]));
  for (let i = 0; i < passages; i++) {
    if (i === 10) setup(s, people);
    const sel = s.select();
    if (!sel) break;
    s.commit(sel); s.songEnded(sel.ids);
    if (i >= 10) for (const pid of sel.ids) at.get(s.people.get(pid).name).push(i);
    refill();
  }
  return { s, people, at, more: () => song(n++) };
}
const gapsOf = list => list.slice(1).map((rank, i) => rank - list[i]);
// Passages des chanteurs `names` rapportés à la moyenne des autres.
const shareOf = (at, names) => {
  const others = [...at.keys()].filter(name => !names.includes(name));
  const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
  return mean(names.map(name => at.get(name).length)) / mean(others.map(name => at.get(name).length));
};

// Avant : +3 chantait deux fois à quatre chansons d'écart dès que
// l'espacement le permettait, puis attendait sept chansons (dix personnes),
// et bien plus avec des arrivées. Le total reste doublé ; le rythme devient
// régulier : environ n/2 = 5 chansons entre deux passages.
test('bonus étalé : +3 repasse environ toutes les 5 chansons sur 10 personnes, total doublé, trois modes', () => {
  for (const [mode, options] of modes) {
    for (const name of ['S1', 'A1']) {
      const { at } = steadyTen(options, (s, p) => s.setPersonBonus(p[name].id, 3));
      const gaps = gapsOf(at.get(name));
      const label = `${mode}, ${name} +3 : écarts ${gaps.join(' ')}`;
      assert.ok(Math.min(...gaps) >= 5, label);
      assert.ok(Math.max(...gaps) <= 7, label);
      const share = shareOf(at, [name]);
      assert.ok(share >= 1.9 && share <= 2.1, `${label} ; part ×${share.toFixed(2)}`);
    }
  }
});

// Bonus de table : le poids vaut pour chaque personne de la table. +2 sur la
// table C (deux personnes, ×1,5) : environ 10/1,5 ≈ 7 chansons entre deux
// passages (avant : 6 puis 8) ; +3 sur la table A (trois personnes) déjà
// régulier, inchangé.
test('bonus étalé : bonus de table, passages réguliers et part gardée, trois modes', () => {
  for (const [mode, options] of modes) {
    const c = steadyTen(options, s => s.setTableBonus('C', 2));
    for (const name of ['C1', 'C2']) {
      const gaps = gapsOf(c.at.get(name));
      assert.ok(Math.min(...gaps) >= 7 && Math.max(...gaps) <= 9, `${mode}, table C +2, ${name} : écarts ${gaps.join(' ')}`);
    }
    const shareC = shareOf(c.at, ['C1', 'C2']);
    assert.ok(shareC >= 1.4 && shareC <= 1.6, `${mode}, table C +2 : part ×${shareC.toFixed(2)}`);
    const a = steadyTen(options, s => s.setTableBonus('A', 3));
    for (const name of ['A1', 'A2', 'A3']) {
      const gaps = gapsOf(a.at.get(name));
      assert.ok(Math.min(...gaps) >= 5, `${mode}, table A +3, ${name} : écarts ${gaps.join(' ')}`);
    }
    const shareA = shareOf(a.at, ['A1', 'A2', 'A3']);
    assert.ok(shareA >= 1.85 && shareA <= 2.1, `${mode}, table A +3 : part ×${shareA.toFixed(2)}`);
  }
});

// Malus : inchangé, il fait sauter des tours (rien ne le retient en plus).
test('bonus étalé : un malus garde sa fréquence et saute des tours, trois modes', () => {
  for (const [mode, options] of modes) {
    for (const [level, low, high] of [[-3, 0.45, 0.56], [-1, 0.75, 0.9]]) {
      const person = steadyTen(options, (s, p) => s.setPersonBonus(p.A1.id, level));
      const share = shareOf(person.at, ['A1']);
      assert.ok(share >= low && share <= high, `${mode}, A1 ${level} : part ×${share.toFixed(2)}`);
      assert.ok(Math.min(...gapsOf(person.at.get('A1'))) >= 10, `${mode}, A1 ${level} : ${gapsOf(person.at.get('A1')).join(' ')}`);
    }
    const table = steadyTen(options, s => s.setTableBonus('A', -3));
    const share = shareOf(table.at, ['A1', 'A2', 'A3']);
    assert.ok(share >= 0.45 && share <= 0.56, `${mode}, table A -3 : part ×${share.toFixed(2)}`);
  }
});

// Bonus retiré entre les deux passages du tour : la personne redevient une
// chanteuse comme les autres, sans repasser aussitôt ni rester retenue.
test('bonus étalé : bonus retiré en cours de tour, retour au rythme des autres', () => {
  for (const name of ['S1', 'A1']) {
    let removedAt = null;
    const { at } = steadyTen({}, (s, p) => {
      s.setPersonBonus(p[name].id, 3);
      const commit = s.commit.bind(s);
      s.commit = sel => {
        commit(sel);
        const pid = p[name].id;
        if (removedAt === null && sel.ids.includes(pid) && s.appearanceSerial > 25 &&
            (s.roundUse.get(pid) || 0) > 0 && !s.roundPeople.has(pid)) {
          s.setPersonBonus(pid, 0);
          removedAt = s.appearanceSerial - 1;
        }
      };
    }, 90);
    assert.ok(removedAt !== null, name);
    const after = at.get(name).filter(rank => rank >= removedAt);
    const gaps = gapsOf(after);
    assert.ok(gaps.length >= 4 && Math.min(...gaps) >= 6, `${name} sans bonus depuis ${removedAt} : écarts ${gaps.join(' ')}`);
    const later = list => list.filter(rank => rank > removedAt + 10).length;
    const others = [...at.keys()].filter(other => other !== name).map(other => later(at.get(other)));
    assert.ok(Math.abs(later(at.get(name)) - others.reduce((a, b) => a + b, 0) / others.length) <= 1,
      `${name} : ${later(at.get(name))} passages contre ${others.join(',')}`);
  }
});

// Duo avec une personne à bonus. Gus (sans bonus) invite Bea : un titre sur
// deux (`every` 2) ou tous (`every` 1), à une autre table (invitation
// acceptée) ou à la sienne (duo direct). `levels` : bonus de Bea et de Gus.
// Rend les rangs de chacun sur scène (titre ou invitée). Fin de chaque
// passage notée comme par le serveur (songEnded puis endStage) : un titre
// redemandé ensuite compte de cette fin, pas d'une chanson encore en cours.
function duoNight(options, { beaLevel = 0, gusLevel = 0, every = 2, sameTable = false, solos = 8, passages = 240 } = {}) {
  const s = new Scheduler(options);
  s.setHeadcount('T', sameTable ? 2 : 1);
  const bea = s.join({ tableId: 'T', name: 'Bea' });
  if (!sameTable) s.setHeadcount('G', 1);
  const gus = s.join({ tableId: sameTable ? 'T' : 'G', name: 'Gus' });
  const others = [];
  for (let i = 1; i <= solos; i++) { s.setHeadcount(`S${i}`, 1); others.push(s.join({ tableId: `S${i}`, name: `X${i}` })); }
  let n = 1, turn = 0;
  const refill = () => {
    for (const p of [bea, ...others]) if (!s.songsOf(p).length) s.chooseSong(p, song(n++));
    if (s.songsOf(gus).length) return;
    if (turn++ % every === every - 1) {
      const duo = s.inviteDuet(gus, bea.id, song(n++));
      if (duo.duet.state === 'pending') s.answerDuet(bea, true, duo.entryId);
    } else s.chooseSong(gus, song(n++));
  };
  refill();
  if (beaLevel) s.setPersonBonus(bea.id, beaLevel);
  if (gusLevel) s.setPersonBonus(gus.id, gusLevel);
  const at = new Map([['Bea', []], ['Gus', []], ...others.map(p => [p.name, []])]);
  for (let i = 0; i < passages; i++) {
    const sel = s.select();
    if (!sel) break;
    s.commit(sel); s.songEnded(sel.ids); s.endStage(sel);
    for (const pid of sel.ids) at.get(s.people.get(pid).name).push(i);
    refill();
  }
  return at;
}

// Relecture du bonus étalé : un bonus ne retient que les titres de la
// personne. Invitée d'un duo, elle ne retarde pas la personne qui l'invite
// (comme un malus) ; avant, le duo de Gus attendait le rythme étalé de Bea
// (« Chacun son tour », 20 solistes : premier duo au rang 44 au lieu de 30 ;
// 12 solistes : 3 passages de Gus au lieu de 4 avant la 60e chanson ;
// « Tables à tour de rôle » : chaque passage 7 chansons plus tard). Les
// passages en plus de Bea allongent chaque tour d'une chanson pour tout le
// monde : Gus garde le rythme des solistes (même nombre de passages, écart
// moyen au plus d'une demi-chanson de plus), sans retard de plus qu'eux.
// Avant, à égalité d'attente, le propre titre de Bea passait devant son duo,
// que l'espacement repoussait de trois chansons : un passage de moins.
test('bonus étalé : l’invitée à bonus ne retarde pas la personne qui l’invite, trois modes', () => {
  const meanGap = list => (list[list.length - 1] - list[0]) / (list.length - 1);
  for (const [mode, options] of modes) {
    for (const level of [3, 2]) {
      const at = duoNight(options, { beaLevel: level, solos: 20, passages: 180 });
      const gus = at.get('Gus');
      const solos = [...at.keys()].filter(name => name.startsWith('X')).map(name => at.get(name));
      const soloGap = solos.reduce((sum, list) => sum + meanGap(list), 0) / solos.length;
      const label = `${mode}, Bea +${level} : Gus aux rangs ${gus.join(' ')} (écart moyen ${meanGap(gus).toFixed(1)}, solistes ${soloGap.toFixed(1)})`;
      assert.ok(gus.length >= Math.min(...solos.map(list => list.length)), label);
      assert.ok(meanGap(gus) <= soloGap + 0.5, label);
    }
    const gus = duoNight(options, { beaLevel: 3, solos: 12, passages: 61 }).get('Gus');
    assert.ok(gus.length >= 4, `${mode}, 12 solistes : Gus aux rangs ${gus.join(' ')}`);
  }
});

// Bea (+1 ou +2) invitée sur chaque titre de Gus : ses propres titres se
// placent entre ses duos sans les serrer. Avant, retenu pour le rythme étalé,
// son titre passait juste avant le duo de fin de tour (13 écarts de 2 ou 3
// chansons avec +2 sur 240). Avec +3, seulement en « Chacun son tour » : dans
// les modes par table, la table de Bea a plus de passages que sa part et les
// serre déjà en fin de tour, avec ou sans étalement (écarts de 2, inchangés).
test('bonus étalé : invitée à bonus sur chaque titre, l’espacement est gardé, trois modes', () => {
  for (const [mode, options] of modes) {
    for (const level of options.tableRotation ? [1, 2] : [1, 2, 3]) {
      for (const sameTable of [false, true]) {
        const at = duoNight(options, { beaLevel: level, every: 1, sameTable });
        const gaps = gapsOf(at.get('Bea'));
        const label = `${mode}, Bea +${level}${sameTable ? ', même table' : ''} : écarts ${gaps.join(' ')}`;
        assert.ok(Math.min(...gaps) >= 4, label);
        const solo = [...at.keys()].filter(name => name.startsWith('X')).map(name => at.get(name).length);
        assert.ok(Math.max(...solo) - Math.min(...solo) <= 1, `${label} ; solistes ${solo.join(',')}`);
        assert.ok(at.get('Gus').length >= Math.min(...solo) / 2, `${label} ; Gus ${at.get('Gus').length}, solistes ${solo.join(',')}`);
      }
    }
  }
});

// Gus (+3) invite Bea (sans bonus) un titre sur deux, 20 solistes : Bea ne
// chante pas plus que les autres (avant, en « Tables à tour de rôle », le duo
// retenu en fin de tour laissait passer son titre juste avant : 19 passages
// contre 11). Les passages de Gus sont étalés : l'invitée reposée d'un bonus
// reposé ne retient plus son duo par la patience (avant, le duo attendait la
// fin de chaque tour et le titre suivant de Gus passait deux chansons après
// lui, puis vingt), en « Chacun son tour ». Gus est dernier du premier tour (premier ajouté, premier
// servi) : ses passages s'étalent à partir du quatrième tour ; avant, dans
// les deux premiers tours, Bea chante son titre et le duo (l'invitée garde
// son titre), deux passages de plus que les solistes, puis plus aucun.
test('bonus étalé : l’auteur du duo a le bonus, l’invitée garde son rythme', () => {
  for (const [mode, options] of modes) {
    const at = duoNight(options, { gusLevel: 3, solos: 20 });
    const solo = [...at.keys()].filter(name => name.startsWith('X')).map(name => at.get(name).length);
    const mean = solo.reduce((a, b) => a + b, 0) / solo.length;
    const late = name => at.get(name).filter(rank => rank >= 70);
    const lateSolo = [...at.keys()].filter(name => name.startsWith('X')).map(name => late(name).length);
    const label = `${mode} : Gus ${at.get('Gus').length}, Bea ${at.get('Bea').length}, solistes ${solo.join(',')} ; ` +
      `à partir du 70e : Gus ${late('Gus').length}, Bea ${late('Bea').length}, solistes ${lateSolo.join(',')}`;
    assert.ok(at.get('Gus').length >= 1.8 * mean, label);
    assert.ok(at.get('Bea').length - mean <= 2.5, label);
    assert.ok(late('Bea').length <= Math.max(...lateSolo), label);
    if (!options.tableRotation) assert.ok(Math.min(...gapsOf(late('Gus'))) >= 6, `${label} ; écarts de Gus ${gapsOf(late('Gus')).join(' ')}`);
  }
});

// Espacement réglé à 0 ou 1 (option de l'ordonnanceur, pas de la page du
// bar) : un bonus garde au moins trois chansons de place en fin de tour.
// Avant : +1 en « Tables à tour de rôle », cinq écarts de 2 chansons.
test('bonus étalé : espacement réglé bas, pas de passages serrés en fin de tour', () => {
  for (const spacingSongs of [0, 1]) {
    for (const [mode, options] of modes) {
      const { at } = steadyTen({ ...options, spacingSongs }, (s, p) => s.setPersonBonus(p.A1.id, 1));
      const gaps = gapsOf(at.get('A1'));
      assert.ok(Math.min(...gaps) >= 4, `${mode}, espacement ${spacingSongs}, A1 +1 : écarts ${gaps.join(' ')}`);
    }
  }
});

// La règle ne retient jamais la scène : si plus personne d'autre ne peut
// chanter, la personne à bonus repasse ; un premier passage de la soirée
// passe toujours avant son passage en plus.
test('bonus étalé : premiers passages d’abord, et la scène ne reste pas vide', () => {
  // Dix chanteurs, S1 à +3, arrêtés juste après le premier passage d'un tour de S1.
  const { s, people, more } = steadyTen({}, (sched, p) => {
    sched.setPersonBonus(p.S1.id, 3);
    const select = sched.select.bind(sched);
    sched.select = (...args) => sched.appearanceSerial > 30 && sched.people.get(p.S1.id).lastAppearanceTurn === sched.appearanceSerial &&
      !sched.roundPeople.has(p.S1.id) ? null : select(...args);
  }, 80);
  delete s.select;
  assert.ok(!s.roundPeople.has(people.S1.id) && s.people.get(people.S1.id).lastAppearanceTurn === s.appearanceSerial);
  // Son passage en plus vient environ 10/2 chansons après le dernier.
  const view = s.readyView();
  assert.ok(view.findIndex(item => item.ids.includes(people.S1.id)) >= 4, view.map(item => item.name).join(' '));
  // Une arrivée passe d'abord.
  s.setHeadcount('N', 1);
  const newcomer = s.join({ tableId: 'N', name: 'Nouvelle' });
  s.chooseSong(newcomer, more());
  assert.deepEqual(s.select().ids, [newcomer.id]);
  // Plus personne d'autre ne peut chanter : S1 repasse quand même.
  for (const p of [...Object.values(people), newcomer]) {
    if (p.id === people.S1.id) continue;
    for (const entry of s.songsOf(p)) s.removeSong(p, entry.entryId);
  }
  assert.deepEqual(s.select().ids, [people.S1.id]);
});

// Relecture : « Je pars » vide la file de la personne ; un titre rechoisi
// ensuite commence une nouvelle attente, même juste après un retrait.
test('retrait du dernier titre puis « Je pars » : l’attente recommence', () => {
  const { s, more } = twoTablesAndSolo();
  for (let i = 0; i < 9; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
  const solo = [...s.people.values()].find(p => p.name === 'S');
  s.removeSong(solo, s.songsOf(solo)[0].entryId, 'self');
  s.leave(solo);
  s.chooseSong(solo, more(), 'append');
  assert.equal(solo.readySerial, s.appearanceSerial);
});

// Relecture : un titre échangé pendant qu'un passage part vers KaraFun, puis
// ce passage annulé (retiré avant d'être chanté) : toujours un échange.
test('échange de titre pendant un envoi ensuite annulé : l’attente est gardée', () => {
  const s = new Scheduler();
  for (const t of ['A', 'B', 'C', 'D']) s.setHeadcount(t, 4);
  const people = ['A', 'B', 'C', 'D'].map(t => s.join({ tableId: t, name: `${t}1` }));
  people.forEach((p, i) => s.chooseSong(p, song(i + 1)));
  const first = s.select(); s.commit(first); s.songEnded(first.ids);
  const inFlight = s.select(); s.commit(inFlight);
  const p = people.find(q => !first.ids.includes(q.id) && !inFlight.ids.includes(q.id));
  const before = p.readySerial || 0;
  s.removeSong(p, p.song.entryId);
  s.rollbackUnplayed(inFlight);
  s.chooseSong(p, song(9));
  assert.equal(p.readySerial || 0, before);
});

// Relecture : en « Compromis », la part d'une table suit ses chanteurs
// inscrits, titre prêt ou non ; le départ d'un chanteur sans titre prêt doit
// donc redemander un plan à Timefold (groupSizes).
test('compromis : un chanteur sans titre prêt qui part change l’empreinte du plan', () => {
  const s = new Scheduler({ tableRotation: true, weightedTables: true });
  s.setHeadcount('A', 8); s.setHeadcount('B', 8);
  const a = s.join({ tableId: 'A', name: 'A1' }), b = s.join({ tableId: 'B', name: 'B1' });
  s.chooseSong(a, song(1)); s.chooseSong(b, song(2));
  // A2 a chanté son titre et n'en a pas d'autre : inscrite à A, sans titre prêt.
  const a2 = s.join({ tableId: 'A', name: 'A2' });
  s.chooseSong(a2, song(3));
  s.chooseSong(a, song(5), 'append'); s.chooseSong(b, song(6), 'append');
  for (let i = 0; i < 3 && !a2.sung; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
  assert.ok(a2.sung && !s.songsOf(a2).length && s.songsOf(a).length);
  const before = s.solverContextFingerprint();
  s.leave(a2);
  assert.notEqual(s.solverContextFingerprint(), before, 'A compte un chanteur de moins');
  // Hors « Compromis », ce départ sans titre ne relance pas Timefold.
  const t = new Scheduler();
  t.setHeadcount('A', 8);
  t.chooseSong(t.join({ tableId: 'A', name: 'A1' }), song(1));
  const t2 = t.join({ tableId: 'A', name: 'A2' });
  t.chooseSong(t2, song(3)); t.removeSong(t2, t2.song.entryId);
  const still = t.solverContextFingerprint();
  t.leave(t2);
  assert.equal(t.solverContextFingerprint(), still);
  // En « Compromis », le départ d'une chanteuse d'une table sans titre prêt
  // (elle a chanté, sa liste est vide) garde le plan : rien n'y change.
  const u = new Scheduler({ tableRotation: true, weightedTables: true });
  for (const table of ['A', 'B', 'C']) u.setHeadcount(table, 4);
  const [ua, ub, uc] = ['A', 'B', 'C'].map(table => u.join({ tableId: table, name: `${table}1` }));
  let n = 10;
  for (const p of [uc, ua, ua, ub, ub]) u.chooseSong(p, song(n++), 'append');
  for (let i = 0; i < 6 && !uc.sung; i++) { const sel = u.select(); u.commit(sel); u.songEnded(sel.ids); }
  assert.ok(uc.sung && !u.songsOf(uc).length);
  const kept = u.solverContextFingerprint();
  u.leave(uc);
  assert.equal(u.solverContextFingerprint(), kept, 'table sans titre prêt : plan gardé');
});

// Relecture : la table de l'invitée d'un duo accepté entre aussi dans le plan
// Timefold ; un changement de ses chanteurs inscrits le redemande.
test('compromis : la table de l’invitée d’un duo accepté relance aussi le plan', () => {
  const v = new Scheduler({ tableRotation: true, weightedTables: true });
  for (const t of ['A', 'G', 'C']) v.setHeadcount(t, 4);
  const va = v.join({ tableId: 'A', name: 'A1' }), vc = v.join({ tableId: 'C', name: 'C1' });
  const g = v.join({ tableId: 'G', name: 'G1' }), g2 = v.join({ tableId: 'G', name: 'G2' });
  v.chooseSong(g2, song(30)); v.chooseSong(va, song(31)); v.chooseSong(vc, song(32));
  v.chooseSong(va, song(33), 'append'); v.chooseSong(vc, song(34), 'append');
  for (let i = 0; i < 6 && !g2.sung; i++) { const sel = v.select(); v.commit(sel); v.songEnded(sel.ids); }
  assert.ok(g2.sung && !v.songsOf(g2).length && !v.songsOf(g).length);
  v.inviteDuet(va, g.id, song(35)); v.answerDuet(g, true, v.songsOf(va).at(-1).entryId);
  const duoKept = v.solverContextFingerprint();
  v.leave(g2);
  assert.notEqual(v.solverContextFingerprint(), duoKept, 'table de l’invitée d’un duo accepté : plan relancé');
});

// Relecture : la page et le guide promettent une échelle précise en
// « Compromis » (racine de la taille) : une table de 4 compte comme 2
// solistes, une table de 9 comme 3. La taille compte les inscrits qui ont un
// titre, même quand un seul passage de la table est candidat, et pas les
// places déclarées ni un prénom sans titre.
test('compromis : une table de 4 compte comme 2 solistes, une table de 9 comme 3', () => {
  const s = new Scheduler({ tableRotation: true, weightedTables: true });
  let k = 1;
  const seat = (t, titled, idle) => {
    s.setHeadcount(t, titled + idle + 3);
    const people = Array.from({ length: titled }, (_, i) => {
      const p = s.join({ tableId: t, name: `${t}${i}` });
      s.chooseSong(p, song(k++));
      return p;
    });
    for (let i = 0; i < idle; i++) s.join({ tableId: t, name: `${t}x${i}` });
    return people;
  };
  const [a, b, c] = [seat('A', 4, 2), seat('B', 9, 1), seat('C', 1, 0)];
  const w = s._groupWeights([a[0], b[0], c[0]].map(p => ({ ids: [p.id], groups: [p.group] })));
  assert.deepEqual([w.get(a[0].group), w.get(b[0].group), w.get(c[0].group)], [2, 3, 1]);
});

// Relecture : titre retiré juste avant ou pendant l'envoi d'un passage
// ensuite annulé, puis rechoisi : l'attente continue, à sa place.
test('échange de titre autour d’un passage annulé : l’attente continue', () => {
  for (const removeFirst of [true, false]) {
    const { s, more } = twoTablesAndSolo();
    for (let i = 0; i < 9; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
    const b1 = [...s.people.values()].find(p => p.name === 'B1');
    const before = b1.readySerial;
    let sent;
    if (removeFirst) { s.removeSong(b1, s.songsOf(b1)[0].entryId, 'self'); sent = s.select(); s.commit(sent); }
    else { sent = s.select(); s.commit(sent); s.removeSong(b1, s.songsOf(b1)[0].entryId, 'self'); }
    s.rollbackUnplayed(sent, { requeue: true });
    s.chooseSong(b1, more(), 'append');
    assert.equal(b1.readySerial, before, `removeFirst=${removeFirst}`);
    const order = s.readyView().map(x => x.name);
    assert.ok(order.indexOf('B1') < order.indexOf('S'), `removeFirst=${removeFirst}: ${order.join(' ')}`);
  }
});

// Relecture : un duo annulé ne rend l'échange de titre qu'à la personne dont
// le titre est parti, pas à l'invitée, qui commence une nouvelle attente.
test('duo annulé : l’invitée sans titre ne garde pas une ancienne attente', () => {
  const s = new Scheduler();
  const people = ['A', 'B', 'C', 'D'].map(t => s.join({ tableId: t, name: `${t}1`, headcount: 2 }));
  let n = 1;
  people.forEach(p => s.chooseSong(p, song(n++), 'append'));
  const play = () => { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); return sel; };
  const guest = s.people.get(play().ids[0]);
  assert.equal(s.songsOf(guest).length, 0);
  for (let i = 0; i < 3; i++) play();
  const owner = people.find(p => p.id !== guest.id);
  for (const p of people) if (p.id !== guest.id) s.chooseSong(p, song(n++), 'append');
  const duo = s.inviteDuet(owner, guest.id, song(n++));
  s.answerDuet(guest, true, duo.entryId);
  let sel = s.select();
  while (!sel.ids.includes(guest.id)) { s.commit(sel); s.songEnded(sel.ids); sel = s.select(); }
  s.commit(sel);
  s.rollbackUnplayed(sel, { requeue: true });
  assert.equal(guest.emptiedAt, undefined, 'l’invitée n’est pas en échange de titre');
  s.chooseSong(guest, song(n++), 'append');
  assert.equal(guest.readySerial, s.appearanceSerial, 'nouvelle attente pour l’invitée');
});

// Même règle quand l'invitée choisit son titre pendant l'envoi du duo.
test('duo annulé : l’invitée qui choisit un titre pendant l’envoi ne garde pas une ancienne attente', () => {
  const s = new Scheduler();
  const people = ['A', 'B', 'C', 'D'].map(t => s.join({ tableId: t, name: `${t}1`, headcount: 2 }));
  let n = 1;
  people.forEach(p => s.chooseSong(p, song(n++), 'append'));
  const play = () => { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); return sel; };
  const guest = s.people.get(play().ids[0]);
  for (let i = 0; i < 3; i++) play();
  const owner = people.find(p => p.id !== guest.id);
  for (const p of people) if (p.id !== guest.id) s.chooseSong(p, song(n++), 'append');
  const duo = s.inviteDuet(owner, guest.id, song(n++));
  s.answerDuet(guest, true, duo.entryId);
  let sel = s.select();
  while (!sel.ids.includes(guest.id)) { s.commit(sel); s.songEnded(sel.ids); sel = s.select(); }
  s.commit(sel);
  s.chooseSong(guest, song(n++), 'append');
  s.rollbackUnplayed(sel, { requeue: true });
  assert.equal(guest.readySerial, s.appearanceSerial);
});

// Relecture : une personne arrivée pendant un passage ensuite annulé
// n'attend pas depuis un passage qui n'existe plus.
test('passage annulé : une arrivée pendant ce passage n’attend pas depuis un passage disparu', () => {
  const { s, more } = twoTablesAndSolo();
  for (let i = 0; i < 9; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
  s.setHeadcount('C', 4);
  const sent = s.select(); s.commit(sent);
  const late = s.join({ tableId: 'C', name: 'X' });
  s.chooseSong(late, more(), 'append');
  s.rollbackUnplayed(sent, { requeue: true });
  assert.ok(late.readySerial <= s.appearanceSerial, `${late.readySerial} > ${s.appearanceSerial}`);
});

// Relecture : en modes tables, un duo noté tard par le bar met l'invitée au
// répit ; la patience ne doit pas alors laisser la table qui vient de
// chanter reprendre le micro alors qu'une autre table peut chanter.
for (const [mode, opts] of [['tables à tour de rôle', { tableRotation: true }],
  ['compromis', { tableRotation: true, weightedTables: true }]]) {
  test(`${mode} : un duo noté tard ne redonne pas le micro à la même table`, () => {
    const s = new Scheduler(opts);
    let n = 1;
    const people = {};
    for (const [t, names] of [['A', ['a1', 'a2', 'a3', 'a4']], ['B', ['b1', 'b2']], ['C', ['c1', 'c2']]]) {
      s.setHeadcount(t, names.length);
      for (const name of names) people[name] = s.join({ tableId: t, name });
    }
    Object.values(people).forEach(p => s.chooseSong(p, song(n++), 'append'));
    const played = [];
    for (let i = 0; i < 8; i++) {
      const sel = s.select(); s.commit(sel); s.songEnded(sel.ids);
      played.push({ sel, turn: s.appearanceSerial });
      for (const pid of sel.ids) { const p = s.people.get(pid); if (!s.songsOf(p).length) s.chooseSong(p, song(n++), 'append'); }
    }
    const first = played[0];
    const guest = Object.values(people).find(p => p.tableId !== s.people.get(first.sel.ids[0]).tableId &&
      p.id !== first.sel.ids[0] && p.lastAppearanceTurn < 4);
    s.staffCountPartner(first.sel.ids[0], guest.id, { song: { entryId: first.sel.song.entryId }, turn: first.turn }, []);
    const last = new Set(s.lastGroup);
    const pick = s.select();
    assert.ok(pick.groups.every(g => !last.has(g)), `${pick.names} (table ${pick.groups}) après la table ${[...last]}`);
    // Un plan Timefold (sans répit) qui classe l'invitée d'abord, puis la
    // table qui vient de chanter, ne redonne pas non plus le micro à celle-ci.
    const own = guest.song, again = Object.values(people).find(p => last.has(p.group) && p.song);
    if (own && again) {
      const others = Object.values(people).filter(p => p.song && p !== guest && p !== again);
      const ranks = new Map([own, again.song, ...others.map(p => p.song)].map((x, i) => [x.entryId, i]));
      s.solverPlan = { version: s.version, fingerprint: s.solverContextFingerprint(), ranks, source: 'timefold' };
      const planned = s.select();
      s.solverPlan = null;
      assert.ok(planned.groups.every(g => !last.has(g)), `plan : ${planned.names} (table ${planned.groups})`);
    }
  });
}

// Relecture : un passage passé dans KaraFun sans être chanté (titre non
// rendu) ; rechoisir un titre avant ou après l'annulation garde l'attente.
test('passage annulé, titre rechoisi avant ou après l’annulation : même attente', () => {
  for (const repickFirst of [true, false]) {
    const s = new Scheduler();
    const people = ['A', 'B', 'C', 'D'].map(t => s.join({ tableId: t, name: `${t}1`, headcount: 2 }));
    let n = 1;
    people.forEach(p => s.chooseSong(p, song(n++), 'append'));
    const play = () => { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); return sel; };
    const owner = s.people.get(play().ids[0]);
    play();
    s.chooseSong(owner, song(n++), 'append');
    const waitStart = owner.readySerial;
    play(); play();
    people.forEach(p => { if (!s.songsOf(p).length) s.chooseSong(p, song(n++), 'append'); });
    const sel = s.select();
    assert.equal(sel.ids[0], owner.id);
    s.commit(sel);
    if (repickFirst) s.chooseSong(owner, song(n++), 'append');
    s.rollbackUnplayed(sel, { requeue: true });
    if (!repickFirst) s.chooseSong(owner, song(n++), 'append');
    assert.equal(owner.readySerial, waitStart, `rechoisi ${repickFirst ? 'avant' : 'après'} l’annulation`);
  }
});

// Relecture : un duo noté sans passage connu ajoute un passage au compteur ;
// le retirer le rend, et personne n'attend depuis un passage disparu.
test('duo noté puis retiré sans passage connu : début d’attente ramené au compteur', () => {
  const s = new Scheduler();
  const [a, b, c] = ['A', 'B', 'C'].map(t => { s.setHeadcount(t, 2); return s.join({ tableId: t, name: t }); });
  s.chooseSong(a, song(1));
  const sel = { song: { entryId: 'inconnu' } };
  s.staffCountPartner(a.id, b.id, sel);
  s.chooseSong(c, song(2));
  assert.equal(c.readySerial, s.appearanceSerial);
  s.staffUncountPartner(sel.staffDuo, sel, []);
  assert.ok((c.readySerial || 0) <= s.appearanceSerial, `${c.readySerial} > ${s.appearanceSerial}`);
});

// Relecture : un titre retiré pendant qu'un duo noté sans passage connu
// compte un passage reste un échange quand le bar retire ce duo.
test('duo noté puis retiré sans passage connu : un échange de titre fait entre-temps est gardé', () => {
  const s = new Scheduler();
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(t => { s.setHeadcount(t, 2); return s.join({ tableId: t, name: t }); });
  s.chooseSong(a, song(1)); s.chooseSong(c, song(2));
  const first = s.select(); s.commit(first); s.songEnded(first.ids);
  assert.deepEqual(first.names, ['A']);
  const before = c.readySerial;
  const sel = { song: { entryId: 'inconnu' } };
  s.staffCountPartner(d.id, b.id, sel); // D n'a jamais chanté : le duo ajoute un passage
  assert.equal(s.appearanceSerial, 2);
  s.removeSong(c, c.song.entryId);
  s.staffUncountPartner(sel.staffDuo, sel, []);
  s.chooseSong(c, song(3));
  assert.equal(c.readySerial, before);
});

// Relecture : en « Compromis », des invités de duo sans titre à eux ne
// grossissent pas leur table (un duo de la même table se fait sans l'accord
// de l'invité) ; un chanteur qui a chanté son titre compte, liste vide ou non.
test('compromis : des invités de duo sans titre à eux ne grossissent pas leur table', () => {
  const s = new Scheduler({ tableRotation: true, weightedTables: true });
  s.setHeadcount('B', 4); s.setHeadcount('A', 6);
  const b = ['B1', 'B2'].map(name => s.join({ tableId: 'B', name }));
  const a = ['A1', 'A2', 'A3', 'A4'].map(name => s.join({ tableId: 'A', name }));
  let n = 9500;
  for (const p of [...b, a[0], a[1]]) s.chooseSong(p, song(n++), 'append');
  for (const guest of [a[2], a[3]]) s.staffCountPartner(a[0].id, guest.id, { song: { entryId: `inconnu-${guest.id}` } });
  assert.equal(s._registeredWeights().get(a[0].group), 2);
  assert.equal(s._registeredWeights().get(b[0].group), 2);
  for (let i = 0; i < 4; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
  assert.ok(b.every(p => p.sung && !s.songsOf(p).length));
  assert.equal(s._registeredWeights().get(b[0].group), 2, 'B1 et B2 ont chanté : comptent encore');
});

// Relecture : un titre retiré faute de « Je suis là » (trois fois manqué)
// n'est pas un échange ; le titre rechoisi commence une nouvelle attente.
test('titre retiré faute de présence : le titre suivant commence une nouvelle attente', () => {
  const { s, more } = twoTablesAndSolo();
  for (let i = 0; i < 9; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
  const solo = [...s.people.values()].find(p => p.name === 'S');
  s.removeSong(solo, s.songsOf(solo)[0].entryId, 'presence-max');
  s.chooseSong(solo, more(), 'append');
  assert.equal(solo.readySerial, s.appearanceSerial);
});

// Relecture : retrait faute de « Je suis là » alors qu'un autre titre attend
// dans la liste : ce titre commence lui aussi une nouvelle attente.
test('titre retiré faute de présence avec une liste : le titre suivant commence une nouvelle attente', () => {
  const s = new Scheduler();
  s.setHeadcount('A', 6); s.setHeadcount('B', 6);
  const solo = s.join({ tableId: 'Comptoir', name: 'S' });
  const people = ['A1', 'B1', 'A2', 'B2', 'S', 'A3', 'B3', 'A4', 'B4'].map(name => name === 'S' ? solo : s.join({ tableId: name[0], name }));
  let n = 1;
  for (const p of people) for (let k = 0; k < (p === solo ? 3 : 2); k++) s.chooseSong(p, song(n++), 'append');
  for (let i = 0; i < 9; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
  for (let i = 0; i < 3; i++) s.skipUnconfirmed(solo.id, 3);
  assert.equal(s.songsOf(solo).length, 1);
  assert.equal(Math.max(solo.lastAppearanceTurn || 0, solo.readySerial || 0), s.appearanceSerial);
});

// Relecture : un passage annulé puis rendu laisse un repère d'échange ; un
// retrait faute de « Je suis là » l'efface, le titre rechoisi recommence.
test('passage rendu puis retiré faute de présence : le titre rechoisi commence une nouvelle attente', () => {
  const s = new Scheduler();
  const [bob, alice, carl] = ['B', 'A', 'C'].map(t => { s.setHeadcount(t, 2); return s.join({ tableId: t, name: t }); });
  s.chooseSong(bob, song(1)); s.chooseSong(alice, song(2)); s.chooseSong(carl, song(3));
  const first = s.select(); s.commit(first); s.songEnded(first.ids);
  let sel = s.select();
  while (sel.ids[0] !== alice.id) { s.commit(sel); s.songEnded(sel.ids); sel = s.select(); }
  s.commit(sel);
  s.requeueUnplayed(sel);
  assert.equal(s.songsOf(alice).length, 1, 'titre rendu');
  s.skipUnconfirmed(alice.id, 1);
  assert.equal(alice.emptiedAt, undefined);
  s.chooseSong(alice, song(4));
  assert.equal(alice.readySerial, s.appearanceSerial);
});
