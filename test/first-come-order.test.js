'use strict';
// Premiers passages, premier ajouté premier servi (constat du gérant du
// 25 octobre) : au démarrage d'une soirée, 12 personnes ajoutent leur premier
// titre l'une après l'autre. La première se voyait prochaine, puis reculait à
// chaque ajout (jusqu'à la 5e place) : la part des tables passait avant l'heure
// de la demande. Tout le monde chante pour la première fois : la première
// arrivée passe la première.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');

const song = n => ({ songId: n, title: `Titre ${n}`, artist: 'Essai' });
// Ordre d'ajout du constat : une personne en solo, puis les tables A (4),
// B (3) et C (3) mêlées, et une autre personne en solo à la fin.
const ARRIVALS = [['Comptoir', 'S1'], ['A', 'A1'], ['B', 'B1'], ['A', 'A2'], ['C', 'C1'], ['A', 'A3'],
  ['B', 'B2'], ['A', 'A4'], ['C', 'C2'], ['B', 'B3'], ['C', 'C3'], ['Comptoir', 'S2']];
const HEADCOUNT = { A: 4, B: 3, C: 3 };
const NAMES = ARRIVALS.map(([, name]) => name);
const settings = () => ({ auto: true, autoPlay: false, baseUrl: 'https://chant.example.test',
  pushDelaySec: 45, playDelaySec: 8 });

function evening(options = {}) {
  const s = new Scheduler(options);
  const people = ARRIVALS.map(([tableId, name]) => s.join({ tableId, name, headcount: HEADCOUNT[tableId] }));
  return { s, people };
}
const order = s => s.readyView().map(item => item.name);
const playAll = s => {
  const sung = [];
  for (let guard = 0; guard < 50; guard++) {
    const sel = s.select();
    if (!sel) break;
    s.commit(sel); s.songEnded(sel.ids);
    sung.push(sel.names.join(' & '));
  }
  return sung;
};
// Horloge réglée par le test : chaque ajout a lieu une seconde après le précédent.
function withClock(run) {
  const realNow = Date.now;
  let clock = Date.UTC(2026, 9, 25, 20, 0, 0);
  Date.now = () => clock;
  try { return run(() => { clock += 1000; }); } finally { Date.now = realNow; }
}

test('chacun son tour : la première personne à ajouter reste première, la file suit l’ordre d’ajout', () => {
  const { s, people } = evening();
  people.forEach((p, k) => {
    s.chooseSong(p, song(k + 1));
    assert.deepEqual(order(s), NAMES.slice(0, k + 1), `après l’ajout de ${p.name}`);
  });
  assert.deepEqual(playAll(s), NAMES, 'les passages suivent l’ordre annoncé');
});

test('chacun son tour : deux ajouts dans la même milliseconde gardent leur ordre', () => {
  withClock(() => {
    const { s, people } = evening();
    people.forEach((p, k) => s.chooseSong(p, song(k + 1)));
    assert.deepEqual(order(s), NAMES);
    const stamps = people.map(p => p.readySince);
    assert.ok(stamps.every((at, k) => !k || at > stamps[k - 1]), 'heures strictement croissantes');
  });
});

test('premiers passages : un duo compte par l’heure de son auteur, dans les trois modes', () => {
  for (const options of [{}, { tableRotation: true }, { tableRotation: true, weightedTables: true }]) {
    const s = new Scheduler(options);
    s.setHeadcount('A', 3); s.setHeadcount('B', 2);
    const [a1, a2, a3] = ['A1', 'A2', 'A3'].map(name => s.join({ tableId: 'A', name }));
    const [b1, b2] = ['B1', 'B2'].map(name => s.join({ tableId: 'B', name }));
    const s1 = s.join({ tableId: 'Comptoir', name: 'S1' });
    const mode = JSON.stringify(options);
    // S1 propose un duo à B1 (autre table, réponse attendue) avant tout le
    // monde ; la table A, plus grande, ajoute ensuite trois titres. En
    // « Compromis », la part de A (racine de 3) passe d'abord.
    const duo = s.inviteDuet(s1, b1.id, song(1));
    s.chooseSong(a1, song(2));
    s.chooseSong(a2, song(3));
    s.chooseSong(a3, song(4));
    const shared = options.weightedTables ? ['A1'] : [];
    assert.deepEqual(order(s).slice(0, shared.length + 1), [...shared, 'S1'],
      `${mode} : le titre de S1 attend sa réponse à sa place : ${order(s).join(' ')}`);
    // L'invitée accepte plus tard : le duo garde l'heure de son auteur.
    s.answerDuet(b1, true, duo.entryId);
    s.chooseSong(b2, song(5));
    const view = order(s);
    assert.deepEqual(view.slice(0, shared.length + 1), [...shared, 'S1 & B1'], `${mode} : ${view.join(' ')}`);
    assert.ok(view.indexOf('A1') < view.indexOf('A2') && view.indexOf('A2') < view.indexOf('A3'),
      `${mode} : une même table dans l’ordre d’ajout : ${view.join(' ')}`);
    assert.deepEqual(playAll(s), view, `${mode} : les passages suivent l’ordre annoncé`);
  }
});

test('tables à tour de rôle : la part des tables d’abord, l’ordre d’ajout à part égale', () => {
  const { s, people } = evening({ tableRotation: true });
  people.forEach((p, k) => {
    s.chooseSong(p, song(k + 1));
    // Au départ, toutes les tables ont la même part : la première arrivée
    // passe la première, la seconde personne en solo ne double personne.
    assert.equal(order(s)[0], 'S1', `après l’ajout de ${p.name} : ${order(s).join(' ')}`);
  });
  const view = order(s);
  assert.deepEqual(view, ['S1', 'A1', 'B1', 'C1', 'S2', 'A2', 'B2', 'A3', 'C2', 'B3', 'A4', 'C3']);
  for (const table of ['A', 'B', 'C']) {
    const members = view.filter(name => name[0] === table);
    assert.deepEqual(members, [...members].sort(), `table ${table} dans l’ordre d’ajout`);
  }
  assert.deepEqual(playAll(s), view);
});

test('compromis : la grande table garde sa part, ses chanteurs passent dans l’ordre d’ajout', () => {
  const s = new Scheduler({ tableRotation: true, weightedTables: true });
  s.setHeadcount('A', 4); s.setHeadcount('B', 1);
  const a = ['A1', 'A2', 'A3', 'A4'].map(name => s.join({ tableId: 'A', name }));
  const b1 = s.join({ tableId: 'B', name: 'B1' });
  // A4 ajoute avant A1 ; la table A (racine de 4 = 2) passe avant B1.
  for (const [k, p] of [a[3], b1, a[1], a[0], a[2]].entries()) s.chooseSong(p, song(k + 1));
  const view = order(s);
  assert.deepEqual(view.filter(name => name[0] === 'A'), ['A4', 'A2', 'A1', 'A3'], view.join(' '));
  assert.equal(view[0], 'A4', 'la part de la grande table reste prioritaire');
});

test('déplacement du bar : il passe toujours avant l’ordre d’ajout', () => {
  const { s, people } = evening();
  people.forEach((p, k) => s.chooseSong(p, song(k + 1)));
  const last = people.at(-1);
  s.staffMove(last.id, 0);
  assert.equal(order(s)[0], 'S2', 'la priorité du bar passe devant');
  assert.deepEqual(order(s).slice(1), NAMES.slice(0, -1), 'les autres gardent l’ordre d’ajout');
});

test('reprise après redémarrage : l’ordre d’ajout est gardé, sauvegarde d’avant ce champ comprise', () => {
  withClock(tick => {
    const { s, people } = evening();
    const access = new TableAccess();
    for (const id of s.tables.keys()) access.issue(id);
    people.slice(0, 6).forEach((p, k) => { tick(); s.chooseSong(p, song(k + 1)); });
    const saved = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings: settings() })));
    assert.ok(saved.scheduler.people.every(p => !p.song || Number.isFinite(p.readySince)), 'heure sauvegardée');
    const resume = snapshot => {
      const back = new Scheduler();
      restoreNight(JSON.parse(JSON.stringify(snapshot)), { scheduler: back, access: new TableAccess(), settings: settings() });
      ARRIVALS.slice(6).forEach(([, name], k) => {
        tick();
        back.chooseSong([...back.people.values()].find(p => p.name === name), song(7 + k));
      });
      return back;
    };
    assert.deepEqual(order(resume(saved)), NAMES, 'reprise : même ordre, les nouveaux à la suite');
    // Sauvegarde d'avant ce champ : l'heure d'entrée dans la file en tient lieu.
    const legacy = JSON.parse(JSON.stringify(saved));
    for (const p of legacy.scheduler.people) delete p.readySince;
    legacy.scheduler.people[1].readySince = 'abîmé';
    assert.deepEqual(order(resume(legacy)), NAMES, 'ancienne sauvegarde : lisible, même ordre');
  });
});

test('passage annulé : la personne retrouve l’heure de son attente', () => {
  const { s, people } = evening();
  people.slice(0, 3).forEach((p, k) => s.chooseSong(p, song(k + 1)));
  const sel = s.select();
  assert.equal(sel.names[0], 'S1');
  const before = people[0].readySince;
  s.commit(sel);
  s.chooseSong(people[0], song(20)); // titre rechoisi pendant l'envoi
  assert.ok(people[0].readySince > before);
  s.rollbackUnplayed(sel, { requeue: true });
  assert.equal(people[0].readySince, before, 'heure d’avant l’envoi rendue');
  assert.equal(order(s)[0], 'S1', 'S1 reste la première arrivée');
});

test('grande table arrivée tard puis un nouveau d’une autre table : ordre d’ajout, sans habitué intercalé', () => {
  withClock(tick => {
    // Relecture du 26 octobre : quatre habitués ont chanté, une table de six
    // ajoute ses premiers titres, puis X1, d'une autre table, le sien. Seule,
    // la table T est intercalée d'habitués (anti-série). Dès que X1 attend
    // aussi, les premiers passages partent dans l'ordre d'ajout : T enchaîne
    // ses six titres, ajoutés avant celui de X1, et les habitués repassent
    // derrière eux. Choix à soumettre au gérant : trancher l'anti-série sur
    // le seul premier ajouté garderait R1 2e, mais les premiers passages
    // attendraient nettement plus (1re chanson de sim-night : 18 → 27 min).
    const s = new Scheduler();
    const habitues = ['R1', 'R2', 'R3', 'R4'].map((name, k) => s.join({ tableId: `H${k}`, name, headcount: 1 }));
    let n = 0;
    for (const p of habitues) { tick(); s.chooseSong(p, song(++n)); s.chooseSong(p, song(++n), 'append'); }
    for (let k = 0; k < 4; k++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); tick(); }
    const table = Array.from({ length: 6 }, (_, k) => s.join({ tableId: 'T', name: `T${k + 1}`, headcount: 6 }));
    for (const p of table) { tick(); s.chooseSong(p, song(++n)); }
    assert.deepEqual(order(s), ['T1', 'R1', 'T2', 'R2', 'T3', 'R3', 'T4', 'R4', 'T5', 'T6'], 'T seule : intercalée');
    const x1 = s.join({ tableId: 'X', name: 'X1', headcount: 1 });
    tick(); s.chooseSong(x1, song(++n));
    const after = order(s);
    assert.deepEqual(after, ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'X1', 'R1', 'R2', 'R3', 'R4'], after.join(' '));
    assert.deepEqual(playAll(s), after, 'les passages suivent l’ordre annoncé');
  });
});

test('reprise après redémarrage : un ajout part après les heures sauvegardées, même si l’horloge a reculé', () => {
  withClock(tick => {
    const { s, people } = evening();
    const access = new TableAccess();
    for (const id of s.tables.keys()) access.issue(id);
    people.slice(0, 3).forEach((p, k) => { tick(); s.chooseSong(p, song(k + 1)); });
    const saved = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings: settings() })));
    const realNow = Date.now;
    const back = new Scheduler();
    restoreNight(saved, { scheduler: back, access: new TableAccess(), settings: settings() });
    Date.now = () => Date.UTC(2026, 9, 25, 19, 0, 0); // une heure plus tôt
    try {
      const next = [...back.people.values()].find(p => p.name === NAMES[3]);
      back.chooseSong(next, song(4));
    } finally { Date.now = realNow; }
    assert.deepEqual(order(back), NAMES.slice(0, 4));
  });
});

test('céder sa place : deux premiers passages d’une même table suivent l’ordre affiché', () => {
  const s = new Scheduler();
  s.setHeadcount('A', 2);
  const [a1, a2] = ['A1', 'A2'].map(name => s.join({ tableId: 'A', name }));
  const b1 = s.join({ tableId: 'B', name: 'B1', headcount: 1 });
  for (const [k, p] of [a1, a2, b1].entries()) s.chooseSong(p, song(k + 1));
  assert.deepEqual(order(s), ['A1', 'A2', 'B1']);
  assert.throws(() => s.giveSpot(a2, a1.id), /A1 est déjà devant toi/);
  s.giveSpot(a1, a2.id);
  assert.deepEqual(order(s), ['A2', 'A1', 'B1'], 'A2 prend la place de A1');
  assert.throws(() => s.giveSpot(a1, a2.id), /A2 est déjà devant toi/);
});
