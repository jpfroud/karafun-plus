'use strict';
// À patience égale, la plus ancienne attente d'abord ; début d'attente au
// passage sur scène (soirées des 23 et 24 octobre, analyse contre-vérifiée).
// - Le 23 à 00:11:48, Remi (demande de 23:23) passait devant Gaspard (demande
//   de 23:13, 107 min d'attente en tout) : Gaspard avait demandé pendant
//   l'envoi du passage d'Remi (envoyé à 23:12:12, chanté à 23:15:05), ce
//   passage comptait d'avant sa demande et la patience ne le protégeait plus ;
//   puis la règle des tables départageait.
// - Le 24, Kilian redemandait un titre à 00:37 et chantait à 00:47 devant
//   onze personnes qui attendaient depuis 16 à 88 min : la part de sa table
//   passait avant l'ancienneté des attentes.
// « Il faut toujours mesurer le délai à partir duquel quelqu'un demande une
// chanson » (le gérant). En « Chacun son tour », à patience égale, la plus
// ancienne attente de l'auteur d'abord (max(dernier passage, demande après une
// liste vide), à l'heure près) ; la part et la règle des tables ne départagent
// qu'ensuite. Dans les modes de tables, la part d'abord, puis la même règle.
// Une demande faite pendant qu'un passage est envoyé mais pas encore commencé
// prend le début d'attente d'avant ce passage. À compteur égal, à l'heure,
// comme dans les statistiques : l'attente d'un chanteur commence à la fin de
// sa chanson, une demande faite pendant elle passe avant son titre suivant
// (le 24 à 01:55, le dernier titre de la soirée allait au deuxième d'un
// arrivant de 01:25 plutôt qu'à une demande faite pendant son premier).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');

const settings = () => ({ auto: true, autoPlay: false, baseUrl: 'https://chant.example.test',
  pushDelaySec: 45, playDelaySec: 8 });
// Horloge du test, et une scène comme celle du bar : chaque passage est
// envoyé 45 s après le début du titre en cours et commence quand celui-ci
// finit, trois minutes plus tard (fin notée comme par le serveur :
// songEnded puis endStage). `onSent(sel)` : geste pendant l'envoi.
function evening(options = {}) {
  const realNow = Date.now;
  let clock = Date.UTC(2026, 9, 23, 21, 0, 0);
  Date.now = () => clock;
  const tick = (sec = 5) => { clock += sec * 1000; };
  let n = 1;
  const song = () => ({ songId: n, title: `Titre ${n++}`, artist: 'Essai' });
  const s = new Scheduler(options);
  const passages = [];
  let onStage = null;
  const step = onSent => {
    tick(45);
    const sel = s.select();
    if (!sel) return null;
    s.commit(sel);
    onSent?.(sel);
    tick(180);
    if (onStage) { s.songEnded(onStage.ids); s.endStage(onStage); }
    s.recordStage(sel);
    onStage = sel;
    passages.push(sel.names.join(' & '));
    return sel;
  };
  const add = (p, mode = 'append') => { tick(); s.chooseSong(p, song(), mode); };
  const view = () => s.readyView().map(item => item.name);
  // Fin du titre sur scène sans début du suivant (pause du bar).
  const endSong = () => {
    if (!onStage) return;
    s.songEnded(onStage.ids); s.endStage(onStage);
    onStage = null;
  };
  return { s, tick, song, add, step, endSong, passages, view, done: () => { Date.now = realNow; } };
}

// Cas du 24 octobre à 01:55 : Yves, arrivé avec deux titres, chante le
// premier (dernier passage) ; Tess, liste vide depuis le sien, redemande
// pendant cette chanson (`pendant`), ou après sa fin, pendant une pause du
// bar (`après`) ; O, qui attend depuis plus longtemps, passe d'abord.
function yvesEvening(moment, options = {}) {
  const e = evening(options);
  const { s, tick, add, step, endSong } = e;
  const [o, tess, yves] = ['O', 'Tess', 'Yves'].map(name => s.join({ tableId: `T-${name}`, name, headcount: 1 }));
  add(o); add(o); add(tess); add(yves); add(yves);
  for (let k = 0; k < 3; k++) step();
  assert.deepEqual(e.passages, ['O', 'Tess', 'Yves']);
  let endedAt;
  if (moment === 'pendant') { tick(60); add(tess); tick(60); endSong(); endedAt = Date.now(); }
  else { tick(120); endSong(); endedAt = Date.now(); tick(60); add(tess); }
  return { ...e, o, tess, yves, endedAt };
}

// Graine de la recherche faite pour cette correction : table T de trois
// personnes, Remi seul à la sienne. Au deuxième tour, Gaspard (T) chante son
// dernier titre, puis redemande pendant l'envoi du passage d'Remi ; Remi
// redemande à son tour, deux passages après le sien.
function gaspardEvening(options = {}) {
  const e = evening(options);
  const { s, add, step } = e;
  s.setHeadcount('T', 3);
  const gaspard = s.join({ tableId: 'T', name: 'Gaspard' });
  const remi = s.join({ tableId: 'I', name: 'Remi', headcount: 1 });
  const [t1, t2] = ['T1', 'T2'].map(name => s.join({ tableId: 'T', name }));
  for (const [p, count] of [[gaspard, 2], [remi, 2], [t1, 3], [t2, 3]]) for (let k = 0; k < count; k++) add(p);
  for (let k = 0; k < 5; k++) step();
  let during = null;
  step(sel => {
    assert.deepEqual(sel.names, ['Remi']);
    add(gaspard);
    during = { readySerial: gaspard.readySerial, turn: s.appearanceSerial };
  });
  step(); step();
  add(remi);
  return { ...e, gaspard, remi, during };
}

test('cas Gaspard : une demande faite pendant l’envoi d’un passage compte d’avant lui', () => {
  const e = gaspardEvening();
  try {
    const { s, gaspard, remi, during, passages, view } = e;
    assert.deepEqual(passages, ['Gaspard', 'Remi', 'T1', 'T2', 'Gaspard', 'Remi', 'T1', 'T2']);
    assert.equal(during.readySerial, during.turn - 1, 'début d’attente d’avant le passage d’Remi, encore à venir sur scène');
    assert.ok(gaspard.readySince < remi.readySince);
    const order = view();
    assert.ok(order.indexOf('Gaspard') < order.indexOf('Remi'), `Gaspard a demandé avant Remi : ${order.join(' ')}`);
    assert.equal(order[0], 'Gaspard', 'personne ne lui passe devant');
    for (let k = 0; k < 4; k++) e.step();
    assert.deepEqual(passages.slice(8), order, 'les passages suivent l’ordre annoncé');
    assert.ok(!s.unstartedTurn || s.unstartedTurn > during.turn);
  } finally { e.done(); }
});

test('cas Gaspard, sans la mesure à la scène : la plus ancienne attente passe quand même d’abord', () => {
  const e = gaspardEvening();
  try {
    const { gaspard, view } = e;
    // Comme avant la correction : la demande compte après le passage d'Remi.
    gaspard.readySerial += 1;
    const order = view();
    assert.ok(order.indexOf('Gaspard') < order.indexOf('Remi'), `la règle des tables ne départage qu’ensuite : ${order.join(' ')}`);
  } finally { e.done(); }
});

test('cas Kilian : un retour qui redemande un titre tard prend sa place selon sa demande', () => {
  const e = evening();
  try {
    const { s, tick, add, step, passages, view } = e;
    s.setHeadcount('K', 5);
    const [kilian, k2, k3, k4] = ['Kilian', 'K2', 'K3', 'K4'].map(name => s.join({ tableId: 'K', name }));
    const others = ['O1', 'O2', 'O3'].map((name, k) => s.join({ tableId: `O${k}`, name, headcount: 1 }));
    for (const p of [kilian, ...others, k2, k3, k4]) add(p);
    for (const p of [...others, k2, k3, k4]) add(p);
    for (let k = 0; k < 8; k++) step();
    assert.deepEqual(passages, ['Kilian', 'O1', 'O2', 'O3', 'K2', 'K3', 'K4', 'O1']);
    // Kilian, liste vide depuis son passage, redemande dix minutes plus tard :
    // les autres attendent depuis leur dernier passage, avant sa demande.
    tick(600);
    add(kilian);
    const order = view();
    assert.deepEqual(order, ['O2', 'O3', 'K2', 'K3', 'K4', 'Kilian'], `sa table ne passe plus devant : ${order.join(' ')}`);
    for (let k = 0; k < 6; k++) step();
    assert.deepEqual(passages.slice(8), order);
  } finally { e.done(); }
});

test('à compteur égal, à l’heure : une demande faite pendant une chanson passe avant le titre suivant de son chanteur', () => {
  for (const [moment, expected] of [['pendant', ['O', 'Tess', 'Yves']], ['après', ['O', 'Yves', 'Tess']]]) {
    const e = yvesEvening(moment);
    try {
      const { s, tess, yves, view, endedAt } = e;
      assert.equal(tess.readySerial, yves.lastAppearanceTurn, `${moment} : même compteur`);
      assert.equal(s._stageEnd(yves.lastAppearanceTurn), endedAt);
      assert.equal(tess.readySince < endedAt, moment === 'pendant');
      assert.deepEqual(view(), expected, `${moment} : ${view().join(' ')}`);
      // Reprise après un redémarrage : la fin du passage est sauvegardée ;
      // une sauvegarde d'avant ce champ la reprend de l'historique de scène.
      const access = new TableAccess();
      for (const id of s.tables.keys()) access.issue(id);
      const saved = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings: settings() })));
      assert.ok(saved.scheduler.stageEnds.some(([turn]) => turn === yves.lastAppearanceTurn));
      const legacy = JSON.parse(JSON.stringify(saved));
      delete legacy.scheduler.stageEnds;
      for (const data of [saved, legacy]) {
        const back = new Scheduler();
        restoreNight(JSON.parse(JSON.stringify(data)), { scheduler: back, access: new TableAccess(), settings: settings() });
        assert.equal(back._stageEnd(yves.lastAppearanceTurn), s._stageEnd(yves.lastAppearanceTurn));
        assert.deepEqual(back.readyView().map(item => item.name), expected, `${moment}, reprise`);
      }
      // Le bar vide l'historique de scène : l'ordre ne change pas.
      s.clearStageHistory([]);
      assert.deepEqual(view(), expected, `${moment}, historique vidé`);
      e.step(); e.step(); e.step();
      assert.deepEqual(e.passages.slice(3), expected, `${moment} : les passages suivent l’ordre annoncé`);
    } finally { e.done(); }
  }
});

test('à compteur égal : chanson pas encore finie, toute demande déjà faite passe avant son chanteur', () => {
  const e = evening();
  try {
    const { s, tick, add, step, view } = e;
    const [o, tess, yves] = ['O', 'Tess', 'Yves'].map(name => s.join({ tableId: `T-${name}`, name, headcount: 1 }));
    add(o); add(o); add(tess); add(yves); add(yves);
    for (let k = 0; k < 3; k++) step();
    tick(60);
    add(tess); // Yves est encore sur scène
    assert.equal(s._stageEnd(yves.lastAppearanceTurn), Infinity);
    assert.deepEqual(view(), ['O', 'Tess', 'Yves']);
    // Un passage plus ancien, sans fin connue (titre jamais fini dans
    // l'application) : de même, après les demandes faites à son compteur.
    assert.equal(s._stageEnd(0), Infinity);
  } finally { e.done(); }
});

// Yves n'a qu'un titre : sa liste se vide à l'envoi, et il redemande pendant
// sa propre chanson (un téléphone de table ajoute le titre suivant dès que
// son chanteur monte sur scène). Sa demande prend le compteur de son propre
// passage (`readySerial` = `lastAppearanceTurn`) : son attente commence quand
// même à la fin de sa chanson, comme dans les statistiques, et Tess, qui
// redemande après lui mais pendant cette chanson, passe d'abord.
test('à compteur égal : un titre redemandé pendant sa propre chanson attend la fin de celle-ci', () => {
  const e = evening();
  try {
    const { s, tick, add, step, endSong, view } = e;
    const [o, tess, yves] = ['O', 'Tess', 'Yves'].map(name => s.join({ tableId: `T-${name}`, name, headcount: 1 }));
    add(o); add(o); add(tess); add(yves);
    for (let k = 0; k < 3; k++) step();
    assert.deepEqual(e.passages, ['O', 'Tess', 'Yves']);
    tick(30); add(yves); // redemande pendant sa propre chanson
    tick(30); add(tess); // Tess redemande pendant la chanson d'Yves
    assert.equal(yves.readySerial, yves.lastAppearanceTurn);
    assert.equal(tess.readySerial, yves.lastAppearanceTurn);
    assert.ok(yves.readySince < tess.readySince, 'Yves a redemandé le premier');
    assert.deepEqual(view(), ['O', 'Tess', 'Yves'], 'Yves encore sur scène : toute demande déjà faite passe avant lui');
    tick(60); endSong();
    assert.deepEqual(view(), ['O', 'Tess', 'Yves'], 'son attente commence à la fin de sa chanson, comme dans les statistiques');
    let req;
    s.solverBridge = { available: true, solve: r => { req = r; return new Promise(() => {}); } };
    s._requestSolver(s.solverContextFingerprint(), { budgetMs: 100 });
    assert.ok(req.addedOrder[tess.id] < req.addedOrder[yves.id], 'Timefold reçoit le même ordre');
    s.solverBridge = null;
    for (let k = 0; k < 3; k++) step();
    assert.deepEqual(e.passages.slice(3), ['O', 'Tess', 'Yves'], 'les passages suivent l’ordre annoncé');
  } finally { e.done(); }
});

test('demande pendant un envoi : le début d’attente suit la scène, envoi annulé et reprise compris', () => {
  const e = evening();
  try {
    const { s, add } = e;
    const [x, y, z, w] = ['X', 'Y', 'Z', 'W'].map((name, k) => s.join({ tableId: `T${k}`, name, headcount: 1 }));
    for (const p of [x, y, z]) add(p);
    const first = s.select(); s.commit(first); s.recordStage(first);
    assert.equal(s.appearanceSerial, 1);
    const sent = s.select(); s.commit(sent);
    assert.deepEqual(sent.names, ['Y']);
    // X redemande pendant l'envoi de Y : le passage de Y vient après sa demande.
    add(x);
    assert.equal(x.readySerial, 1);
    // Redémarrage pendant cet envoi : la reprise le sait encore.
    const access = new TableAccess();
    for (const id of s.tables.keys()) access.issue(id);
    const saved = JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings: settings() })));
    assert.equal(saved.scheduler.unstartedTurn, 2);
    const back = new Scheduler();
    restoreNight(JSON.parse(JSON.stringify(saved)), { scheduler: back, access: new TableAccess(), settings: settings() });
    const zBack = back.people.get(z.id);
    back.removeSong(zBack, back.songsOf(zBack)[0].entryId);
    back.commit(back.select()); // passage suivant : le titre de Y avait commencé
    back.chooseSong(zBack, { songId: 99, title: 'Titre 99', artist: 'Essai' });
    assert.equal(zBack.readySerial, 2, 'nouvel envoi : le précédent a commencé');
    // Sauvegarde d'avant ce champ : aucun passage attendu sur scène.
    const legacy = JSON.parse(JSON.stringify(saved));
    delete legacy.scheduler.unstartedTurn;
    const old = new Scheduler();
    restoreNight(legacy, { scheduler: old, access: new TableAccess(), settings: settings() });
    assert.equal(old.unstartedTurn, 0);
    // Y commence : une demande compte désormais d'après lui.
    s.songEnded(first.ids);
    assert.equal(s.unstartedTurn, 2, 'la fin du titre d’avant ne fait pas commencer Y');
    s.recordStage(sent);
    assert.equal(s.unstartedTurn, 0);
    const third = s.select(); s.commit(third);
    assert.deepEqual(third.names, ['Z']);
    // Passage annulé pendant son envoi : il n'est plus attendu sur scène.
    s.rollbackUnplayed(third, { requeue: true });
    assert.equal(s.unstartedTurn, 0);
    add(w);
    assert.equal(w.readySerial, 2, 'après le passage de Y, déjà sur scène');
    // Un essai sans scène notée : la fin du titre envoyé vaut son début.
    const again = s.select(); s.commit(again);
    s.songEnded(again.ids);
    assert.equal(s.unstartedTurn, 0);
  } finally { e.done(); }
});

test('duo : l’attente qui compte est celle de son auteur', () => {
  const e = evening();
  try {
    const { s, tick, add, step, passages, view } = e;
    const owner = s.join({ tableId: 'D', name: 'Auteur', headcount: 2 });
    const guest = s.join({ tableId: 'G', name: 'Invitée', headcount: 1 });
    const [a, b] = ['A', 'B'].map((name, k) => s.join({ tableId: `O${k}`, name, headcount: 1 }));
    for (const p of [owner, guest, a, b]) add(p);
    for (const p of [a, b]) add(p);
    for (let k = 0; k < 4; k++) step();
    assert.deepEqual(passages, ['Auteur', 'Invitée', 'A', 'B']);
    // L'auteur, liste vide depuis son passage, invite plus tard l'invitée :
    // son duo attend depuis sa demande, après A, qui attend depuis son passage
    // (avant, la table de l'auteur, ouverte la première, passait devant) ; B,
    // qui vient de chanter, attend ensuite ses trois chansons.
    tick(300);
    const duo = s.inviteDuet(owner, guest.id, e.song());
    s.answerDuet(guest, true, duo.entryId);
    const order = view();
    assert.deepEqual(order, ['A', 'Auteur & Invitée', 'B'], order.join(' '));
    for (let k = 0; k < 3; k++) step();
    assert.deepEqual(passages.slice(4), order);
  } finally { e.done(); }
});

test('tables à tour de rôle : à part égale, la plus ancienne attente d’abord', () => {
  for (const options of [{ tableRotation: true }, { tableRotation: true, weightedTables: true }]) {
    const e = evening(options);
    try {
      const { s, add, step, passages, view } = e;
      const people = ['A', 'B', 'C', 'D', 'E'].map((name, k) => s.join({ tableId: `T${k}`, name, headcount: 1 }));
      const [a, b] = people;
      for (const p of people) add(p);
      for (const p of people.slice(2)) add(p);
      for (let k = 0; k < 5; k++) step();
      assert.deepEqual(passages, ['A', 'B', 'C', 'D', 'E']);
      // A et B redemandent, B d'abord : chaque table a eu sa part, B passe
      // avant A (avant, la table de A, ouverte la première, passait devant).
      add(b);
      add(a);
      const order = view();
      assert.ok(order.indexOf('B') < order.indexOf('A'), `${JSON.stringify(options)} : ${order.join(' ')}`);
    } finally { e.done(); }
  }
});

test('malus : pas protégé par l’ancienneté non plus ; bonus reposé : peut passer avant', () => {
  const e = evening();
  try {
    const { s, add, step, passages, view } = e;
    const names = ['A', 'B', 'C', 'D', 'E', 'F'];
    const people = names.map((name, k) => s.join({ tableId: `T${k}`, name, headcount: 1 }));
    const a = people[0];
    for (const p of people) { add(p); add(p); add(p); }
    for (let k = 0; k < 6; k++) step();
    assert.deepEqual(passages, names);
    assert.deepEqual(view().slice(0, 6), names, 'chacun dans l’ordre de son attente');
    s.setPersonBonus(a.id, -1);
    assert.deepEqual(view().slice(0, 6), ['B', 'C', 'D', 'E', 'F', 'A'], 'malus : les autres passent d’abord');
    // Bonus : son deuxième passage du tour, une fois reposé et espacé, peut
    // passer avant ceux qui attendent depuis plus longtemps (il chante plus
    // souvent), sans enchaîner deux de ses titres.
    s.setPersonBonus(a.id, 1);
    const round = view().slice(0, 7);
    assert.equal(round.filter(name => name === 'A').length, 2, round.join(' '));
    assert.equal(round[0], 'A');
    assert.ok(round.indexOf('A', 1) < 6, `deuxième passage avant la fin du tour : ${round.join(' ')}`);
  } finally { e.done(); }
});

// Relecture (passe 3) : l'exception « bonus reposé » du filtre de la plus
// ancienne attente (rotation.js, `rested`) n'était tenue par aucun test : sans
// elle, A1 rechantait avant B1 au 6e passage et les passages en plus des
// bonus changeaient de main. Son pendant Timefold (QueueScore#restedBonus) a
// son test dans timefold-integration.test.js.
test('chacun son tour : un bonus reposé reste en lice face à la plus ancienne attente', () => {
  const e = evening();
  try {
    const { s, add, step, passages } = e;
    s.setHeadcount('A', 3);
    const [a1, a2, a3] = ['A1', 'A2', 'A3'].map(name => s.join({ tableId: 'A', name }));
    const b1 = s.join({ tableId: 'B', name: 'B1', headcount: 1 });
    const c1 = s.join({ tableId: 'C', name: 'C1', headcount: 1 });
    s.setPersonBonus(a1.id, 1);
    s.setPersonBonus(b1.id, 1);
    for (const p of [a1, a2, a3, b1, c1]) for (let k = 0; k < 4; k++) add(p);
    for (let k = 0; k < 10; k++) step();
    // Sans l'exception : A1 B1 C1 A2 A3 A1 B1 C1 A2 A1.
    assert.deepEqual(passages, ['A1', 'B1', 'C1', 'A2', 'A3', 'B1', 'A1', 'C1', 'A2', 'B1']);
  } finally { e.done(); }
});

// Reprise après un redémarrage, pendant la chanson de Yves (relecture du
// 27 octobre) : les demandes faites ensuite sont datées à leur vraie heure,
// sur la même horloge que les fins de passage. Une demande faite pendant la
// chanson de Yves passe donc avant son titre suivant, une demande faite
// après sa fin après lui. `restart(saved)` : reprise sur un autre ordonnanceur.
function restart(s, saved) {
  const back = new Scheduler();
  const recovered = restoreNight(JSON.parse(JSON.stringify(saved)), { scheduler: back, access: new TableAccess(), settings: settings() });
  const byName = name => [...back.people.values()].find(p => p.name === name);
  // Fin de la chanson sur scène, notée comme par le serveur.
  const endSong = () => {
    const entry = back.stageHistory.at(-1);
    back.songEnded(entry.ids); back.endStage({ ids: entry.ids, song: { entryId: entry.entryId } });
  };
  return { back, byName, endSong, recovered, warnings: recovered.warnings, view: () => back.readyView().map(item => item.name) };
}
const save = (s, extra = {}) => {
  const access = new TableAccess();
  for (const id of s.tables.keys()) access.issue(id);
  return JSON.parse(JSON.stringify(snapshotNight({ scheduler: s, access, settings: settings(), ...extra })));
};

test('reprise d’une sauvegarde d’avant readySince : une attente provisoire ne date pas les demandes dans le futur', () => {
  const e = evening();
  try {
    const { s, tick, add, step, song } = e;
    const [o, tess, yves] = ['O', 'Tess', 'Yves'].map(name => s.join({ tableId: `T-${name}`, name, headcount: 1 }));
    add(o); add(o); add(tess); add(yves); add(yves);
    for (let k = 0; k < 3; k++) step();
    // Yves est sur scène : son attente provisoire finit dans plusieurs minutes.
    assert.ok(yves.waitingSince > Date.now() + 60000);
    const saved = save(s);
    for (const p of saved.scheduler.people) delete p.readySince; // format d'avant readySince
    const { back, byName, endSong, warnings, view } = restart(s, saved);
    assert.ok(!warnings.some(text => /en avance/.test(text)), warnings.join(' ; '));
    for (const p of back.people.values()) assert.ok(p.readySince <= Date.now(), `${p.name} : début d’attente pas dans le futur`);
    assert.ok(back._readyClock <= Date.now());
    tick(60); back.chooseSong(byName('Tess'), song()); // pendant la chanson de Yves
    assert.equal(byName('Tess').readySince, Date.now(), 'demande datée à son heure');
    tick(60); endSong();
    assert.deepEqual(view(), ['O', 'Tess', 'Yves']);
  } finally { e.done(); }
});

test('reprise sur une horloge en retard sur celle de la sauvegarde : les heures reculent ensemble, dans le même ordre', () => {
  // Sauvegarde faite sur un PC en avance de cinq minutes, reprise sur un PC
  // à l'heure (ou l'horloge a reculé entre les deux). `pendant` : O, liste
  // vide depuis son passage, redemande pendant la chanson de Yves, juste
  // avant la sauvegarde (heure sauvegardée la plus tardive) ; Tess redemande
  // après la reprise, toujours pendant cette chanson. `après` : la chanson de
  // Yves finit avant la sauvegarde (fin sauvegardée la plus tardive), Tess
  // redemande après la reprise.
  for (const [moment, expected] of [['pendant', ['O', 'Tess', 'Yves']], ['après', ['O', 'Yves', 'Tess']]]) {
    const e = evening();
    try {
      const { s, tick, add, step, endSong: endOnStage, song } = e;
      const [o, tess, yves] = ['O', 'Tess', 'Yves'].map(name => s.join({ tableId: `T-${name}`, name, headcount: 1 }));
      add(o); if (moment === 'après') add(o);
      add(tess); add(yves); add(yves);
      for (let k = 0; k < 3; k++) step();
      if (moment === 'pendant') { tick(30); add(o); } else { tick(120); endOnStage(); tick(5); }
      // Un envoi en cours, choisi juste avant la sauvegarde : l'heure de son
      // choix (`pickedAt`, cycle des premiers passages) recule avec les autres.
      const sending = { ...s.select(), pickedAt: Date.now() };
      // Plan Timefold adopté (ici l'ordre local) : il survit à la reprise.
      s.solverPlan = { version: s.version, fingerprint: s.solverContextFingerprint(), source: 'timefold',
        ranks: new Map(s.readyView().map((row, index) => [row.entryId, index])) };
      const saved = save(s, { pending: { sel: sending, before: [], at: Date.now(), attempts: 1 } });
      assert.ok(saved.scheduler.solverPlan, `${moment} : plan sauvegardé`);
      tick(-300);
      const { back, byName, endSong, recovered, warnings, view } = restart(s, saved);
      assert.equal(recovered.pending.sel.pickedAt, sending.pickedAt - (moment === 'pendant' ? 300000 : 295000));
      assert.equal(back.solverPlan?.source, 'timefold', `${moment} : plan repris`);
      assert.equal(back.solverPlan.fingerprint, back.solverContextFingerprint(), `${moment} : plan encore valable`);
      assert.ok(warnings.some(text => /en avance de (295|300) s/.test(text)), `${moment} : ${warnings.join(' ; ')}`);
      const now = Date.now();
      for (const p of back.people.values()) assert.ok(p.readySince <= now, `${moment}, ${p.name} : début d’attente pas dans le futur`);
      for (const [turn, at] of back.stageEnds) assert.ok(at <= now, `${moment} : fin du passage ${turn} pas dans le futur`);
      assert.ok(back._readyClock <= now);
      const byStart = list => list.map(p => [p.name, p.readySince]).sort((a, b) => a[1] - b[1]).map(([name]) => name);
      assert.deepEqual(byStart([...back.people.values()]), byStart([...s.people.values()]), `${moment} : même ordre des débuts d’attente`);
      tick(60); back.chooseSong(byName('Tess'), song());
      assert.equal(byName('Tess').readySince, Date.now(), `${moment} : demande datée à son heure`);
      if (moment === 'pendant') { tick(60); endSong(); }
      assert.deepEqual(view(), expected, `${moment} : ${view().join(' ')}`);
    } finally { e.done(); }
  }
});

// Même reprise, avec un titre chargé dans KaraFun au moment de la sauvegarde,
// retiré ensuite sans avoir été chanté : son reçu (`turnCredit`) rend à son
// chanteur l'heure de sa demande, reculée comme les autres. Sinon il perdait
// jusqu'à l'écart des horloges et passait après des demandes plus récentes.
test('reprise sur une horloge en retard : un titre chargé puis retiré rend une heure reculée comme les autres', () => {
  const e = evening();
  try {
    const { s, tick, add, step, endSong } = e;
    const [o, tess, yves] = ['O', 'Tess', 'Yves'].map(name => s.join({ tableId: `T-${name}`, name, headcount: 1 }));
    add(o); add(tess); add(yves);
    for (let k = 0; k < 3; k++) step();
    tick(10); endSong(); // pause du bar, listes vides
    tick(10); add(yves); // Yves redemande le premier
    tick(60); add(o);
    tick(60); add(tess);
    tick(5); const loaded = s.select(); s.commit(loaded); // chargé dans KaraFun, pas commencé
    assert.deepEqual(loaded.names, ['Yves']);
    tick(400); add(yves); // son titre suivant
    const saved = save(s, { tracked: [{ sel: loaded, queueId: 7 }] });
    tick(-300);
    const { back, recovered, warnings, view } = restart(s, saved);
    assert.ok(warnings.some(text => /en avance de 300 s/.test(text)), warnings.join(' ; '));
    back.rollbackUnplayed(recovered.tracked[0].sel, { requeue: true }); // KaraFun le retire
    assert.deepEqual(view(), ['Yves', 'O', 'Tess'], 'Yves avait demandé le premier');
    const byStart = list => list.map(p => [p.name, p.readySince]).sort((a, b) => a[1] - b[1]).map(([name]) => name);
    assert.deepEqual(byStart([...back.people.values()]), ['Yves', 'O', 'Tess']);
  } finally { e.done(); }
});

// Relecture : les autres copies des heures sauvegardées restaient à l'heure
// de l'horloge en avance. La place cédée à quelqu'un encore sans titre
// (`givenWait`, giveSpot) le datait dans le futur à son premier titre : il
// passait derrière la personne qui la lui avait cédée et derrière les
// demandes faites après la reprise.
test('reprise sur une horloge en retard : une place cédée à quelqu’un encore sans titre recule avec les autres heures', () => {
  const e = evening();
  try {
    const { s, tick, add, song } = e;
    const lea = s.join({ tableId: '1', name: 'Léa', headcount: 2 }), max = s.join({ tableId: '1', name: 'Max' });
    const zoe = s.join({ tableId: '2', name: 'Zoé', headcount: 1 }), gus = s.join({ tableId: '3', name: 'Gus', headcount: 1 });
    add(lea); add(zoe); add(gus);
    tick(); s.giveSpot(lea, max.id);
    const saved = save(s);
    tick(-300);
    const { back, byName, warnings, view } = restart(s, saved);
    assert.ok(warnings.some(text => /en avance de 300 s/.test(text)), warnings.join(' ; '));
    assert.ok(byName('Max').givenWait.readySince <= Date.now(), 'place cédée pas dans le futur');
    assert.equal(byName('Max').givenWait.readySince, byName('Zoé').readySince - 5000, 'heure de la demande de Léa');
    tick(10); back.chooseSong(back.join({ tableId: '4', name: 'Inès', headcount: 1 }), song());
    tick(10); back.chooseSong(byName('Max'), song());
    assert.ok(byName('Max').readySince <= Date.now());
    assert.deepEqual(view(), ['Max', 'Zoé', 'Gus', 'Inès', 'Léa']);
  } finally { e.done(); }
});

// Même reprise : un duo noté par le bar garde les reçus d'avant lui
// (`staffDuo.creditBefore`, `inFlight[].creditBefore`). Annulé après la
// reprise, il les rend aux titres encore chargés dans KaraFun ; un titre
// retiré ensuite sans être chanté rendait alors à son chanteur l'heure
// d'avant, non reculée : Tess, qui avait demandé la première, passait après
// O et Yves.
test('reprise sur une horloge en retard : un duo noté puis annulé rend des reçus aux heures reculées', () => {
  const e = evening();
  try {
    const { s, tick, add, step, endSong } = e;
    const [o, tess, yves] = ['O', 'Tess', 'Yves'].map(name => s.join({ tableId: `T-${name}`, name, headcount: 1 }));
    add(o); add(tess); add(yves);
    for (let k = 0; k < 3; k++) step();
    tick(10); endSong(); // pause du bar, listes vides
    tick(10); add(tess); // Tess redemande la première
    tick(60); add(o);
    tick(60); add(yves);
    tick(5); const loaded = s.select(); s.commit(loaded); // chargé dans KaraFun, pas commencé
    assert.deepEqual(loaded.names, ['Tess']);
    tick(400); add(tess); // son titre suivant
    // Le bar note Tess en duo sur le dernier passage, celui de Yves, déjà fini.
    const entry = s.stageHistory.at(-1);
    assert.deepEqual(entry.names, ['Yves']);
    const sel = { song: { entryId: entry.entryId }, turn: entry.turn };
    s.staffCountPartner(yves.id, tess.id, sel, [loaded]);
    entry.staffDuo = sel.staffDuo;
    assert.equal(entry.staffDuo.inFlight.length, 1, 'le titre chargé de Tess garde son reçu d’avant le duo');
    // Le même reçu sur un titre suivi (duo noté pendant sa chanson).
    const sending = { ...loaded, staffDuo: JSON.parse(JSON.stringify(entry.staffDuo)) };
    const saved = save(s, { tracked: [{ sel: loaded, queueId: 7 }, { sel: sending, queueId: 8 }] });
    tick(-300);
    const { back, recovered, warnings, view } = restart(s, saved);
    assert.ok(warnings.some(text => /en avance de 300 s/.test(text)), warnings.join(' ; '));
    const times = record => [record.creditBefore, ...record.inFlight.map(row => row.creditBefore)]
      .flatMap(credit => ['before', 'after'].flatMap(side => credit?.[side]?.people || [])).map(row => row.readySince);
    const pairs = [[back.stageHistory.at(-1).staffDuo, saved.scheduler.stageHistory.at(-1).staffDuo],
      [recovered.tracked[1].sel.staffDuo, saved.tracked[1].sel.staffDuo]];
    for (const [record, before] of pairs) {
      assert.ok(times(before).some(Boolean));
      assert.deepEqual(times(record), times(before).map(at => at && at - 300000), 'reçus du duo reculés comme les autres heures');
    }
    const live = recovered.tracked[0].sel;
    back.staffUncountPartner(back.stageHistory.at(-1).staffDuo, null, [live]); // duo annulé
    back.rollbackUnplayed(live, { requeue: true }); // KaraFun retire le titre de Tess
    assert.deepEqual(view(), ['Tess', 'O', 'Yves'], 'Tess avait demandé la première');
  } finally { e.done(); }
});

// Même reprise : chaque geste du bar garde le plan Timefold affiché avant
// lui (`planBefore`), avec son empreinte, qui contient les heures. Seul le
// plan en cours prenait l'empreinte aux heures reculées : l'annulation
// exacte d'un geste disait « ordre précédent retrouvé » mais montrait
// l'ordre local.
test('reprise sur une horloge en retard : annuler les gestes du bar rend les plans Timefold d’avant eux', () => {
  const e = evening({ tableRotation: true });
  try {
    const { s, add } = e;
    const people = ['Léa', 'Max', 'Zoé', 'Inès'].map((name, k) => s.join({ tableId: `T${k}`, name, headcount: 1 }));
    for (const p of people) add(p);
    const local = s.readyView().map(row => row.entryId);
    const desired = [local[2], local[0], local[3], local[1]];
    s.solverPlan = { version: s.version, fingerprint: s.solverContextFingerprint(), source: 'timefold',
      ranks: new Map(desired.map((entryId, index) => [entryId, index])) };
    const shown = sch => sch.readyView().map(row => row.name);
    assert.deepEqual(shown(s), ['Zoé', 'Léa', 'Inès', 'Max']);
    const native = 'a'.repeat(64);
    const gesture = (name, to) => {
      const p = [...s.people.values()].find(q => q.name === name);
      const before = s.manualOverrideState({ deferrals: true });
      const from = s.readyView().findIndex(row => row.ids[0] === p.id);
      s.staffMove(p.id, to);
      s.recordManualChange({ kind: 'move', personId: p.id, name, from: from + 1, to: to + 1, before, native });
    };
    gesture('Inès', 0);
    const afterFirst = shown(s);
    gesture('Max', 1);
    const saved = save(s);
    e.tick(-300);
    const { back, warnings } = restart(s, saved);
    assert.ok(warnings.some(text => /en avance de 300 s/.test(text)), warnings.join(' ; '));
    assert.ok(back.canUndoManualChange(native));
    back.undoLastManualChange(null, native);
    assert.deepEqual(shown(back), afterFirst, 'ordre d’après le premier geste');
    assert.ok(back.canUndoManualChange(native));
    back.undoLastManualChange(null, native);
    assert.equal(back.solverPlan?.source, 'timefold', 'plan Timefold d’avant les gestes');
    assert.equal(back.solverPlan.fingerprint, back.solverContextFingerprint(), 'encore valable');
    assert.deepEqual(shown(back), ['Zoé', 'Léa', 'Inès', 'Max']);
  } finally { e.done(); }
});

// Reprise dans la même milliseconde que des ajouts (relance immédiate, ou
// essai) : ces ajouts ont pris chacun la milliseconde suivante (_readyStamp),
// un peu après l'heure de l'horloge. Rien n'est corrigé : les heures et le
// plan Timefold repris restent tels quels (night-state.test.js perdait son
// plan quand la reprise tombait dans cette milliseconde).
test('reprise dans la milliseconde des derniers ajouts : heures et plan Timefold inchangés', () => {
  const e = evening({ tableRotation: true });
  try {
    const { s, song } = e;
    const people = ['Léa', 'Max', 'Zoé', 'Inès'].map((name, k) => s.join({ tableId: `T${k}`, name, headcount: 1 }));
    for (const p of people) s.chooseSong(p, song()); // même milliseconde
    assert.ok(people.at(-1).readySince > Date.now(), 'les derniers ajouts prennent les millisecondes suivantes');
    const local = s.readyView().map(row => row.entryId);
    const desired = [local[2], local[0], local[3], local[1]];
    s.solverPlan = { version: s.version, fingerprint: s.solverContextFingerprint(), source: 'timefold',
      ranks: new Map(desired.map((entryId, index) => [entryId, index])) };
    const { back, warnings, view } = restart(s, save(s));
    assert.deepEqual(warnings, []);
    assert.deepEqual([...back.people.values()].map(p => p.readySince), people.map(p => p.readySince));
    assert.deepEqual(back.readyView().map(row => row.entryId), desired, `plan repris : ${view().join(' ')}`);
  } finally { e.done(); }
});
