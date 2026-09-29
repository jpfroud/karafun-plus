'use strict';
// Optimisation continue : tant que la file ne change pas, la recherche
// reprend du meilleur ordre connu avec plus de temps et une autre graine.
// Un nouvel ordre n'est affiché que s'il est meilleur ; un vrai changement
// interrompt la passe en cours ; l'ordre manuel du bar n'est jamais touché.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const { TimefoldBridge } = require('../solver/bridge');

const JAR = path.join(__dirname, '..', 'solver', 'target', 'karafun-solver.jar');
const hasJar = fs.existsSync(JAR) || fs.existsSync(path.join(__dirname, '..', 'solver', 'karafun-solver.jar'));
const song = n => ({ songId: n, title: `Titre ${n}`, artist: 'Essai' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Délai dépassé : ${label}`);
    await sleep(5);
  }
}

function fakeSolver(s) {
  const requests = [];
  s.solverBridge = { available: true, lastError: null, close() {},
    solve: (request, options = {}) => new Promise((resolve, reject) => {
      requests.push({ request, options, resolve, reject });
    }) };
  const answer = (index, { order, seedScore = '0hard/-100medium/0soft', score = seedScore } = {}) => {
    const { request, resolve } = requests[index];
    resolve({ requestId: request.requestId, order: order || request.performances.map(row => row.id),
      seedScore, score, elapsedMs: 5 });
  };
  return { requests, answer };
}

function smallEvening(options = {}) {
  const s = new Scheduler({ solverEnabled: true, solverBudgetMs: 100, solverRefinePauseMs: 10, ...options });
  const people = [];
  for (const [tableId, names] of [['1', ['A1', 'A2', 'A3']], ['2', ['B1', 'B2']], ['3', ['C1']]]) {
    s.setHeadcount(tableId, names.length);
    for (const name of names) people.push(s.join({ tableId, name }));
  }
  people.forEach((p, index) => s.chooseSong(p, song(index + 1), 'append'));
  return { s, people };
}

test('file inchangée : passes successives depuis le meilleur ordre, plus longues et avec une autre graine', async () => {
  const { s } = smallEvening();
  const solver = fakeSolver(s);
  try {
    s.solverStatus();
    assert.equal(solver.requests.length, 1, 'premier calcul après un changement');
    assert.equal(solver.requests[0].request.randomSeed, undefined, 'premier calcul reproductible');
    solver.answer(0);
    assert.equal(await s.solverPromise, true);
    assert.equal(s.solverStatus().plan, 'confirmed');

    await until(() => solver.requests.length === 2, 'première passe continue');
    const first = solver.requests[1];
    assert.equal(first.request.randomSeed, 1);
    assert.equal(first.request.budgetMs, 100);
    assert.equal(first.options.immediate, true, 'pas de fenêtre de regroupement pour une passe continue');
    assert.deepEqual(first.request.performances.map(row => row.id), s.readyView().map(item => item.entryId),
      'la passe part de l’ordre affiché');
    let status = s.solverStatus();
    assert.equal(status.refining, true);
    assert.equal(status.pending, false, 'la file affichée reste considérée comme prête');
    assert.equal(status.continuous, true);

    // Gain vu par la mesure complète, même ordre reproduit par la règle locale.
    const before = s.readyView().map(item => item.entryId);
    const version = s.version;
    solver.answer(1, { seedScore: '0hard/-300medium/0soft', score: '0hard/-200medium/-4soft' });
    assert.equal(await s.solverRefinePromise, true);
    status = s.solverStatus();
    assert.equal(status.plan, 'timefold');
    assert.equal(status.refineRuns, 1);
    assert.equal(status.refineImprovements, 1);
    assert.equal(status.lastRun.refine, true);
    assert.ok(s.version > version, 'les téléphones sont prévenus d’un ordre amélioré');
    assert.deepEqual(s.readyView().map(item => item.entryId), before);

    await until(() => solver.requests.length === 3, 'deuxième passe continue');
    assert.equal(solver.requests[2].request.randomSeed, 2);
    assert.equal(solver.requests[2].request.budgetMs, 200, 'chaque passe dispose de plus de temps');
    const quiet = s.version;
    solver.answer(2); // rien de mieux
    assert.equal(await s.solverRefinePromise, false);
    status = s.solverStatus();
    assert.equal(status.plan, 'timefold', 'le meilleur ordre connu est conservé');
    assert.equal(status.refineRuns, 2);
    assert.equal(s.version, quiet, 'une passe sans gain ne fait pas clignoter les pages');

    await until(() => solver.requests.length === 4, 'troisième passe continue');
    assert.equal(solver.requests[3].request.budgetMs, 300);
    assert.equal(solver.requests[3].request.randomSeed, 3);
  } finally { s.closeSolver(); }
});

test('un gain qui dégrade la rotation affichée est refusé', async () => {
  const { s } = smallEvening();
  const solver = fakeSolver(s);
  try {
    s.solverStatus();
    solver.answer(0);
    await s.solverPromise;
    await until(() => solver.requests.length === 2, 'passe continue');
    const before = s.readyView().map(item => item.entryId);
    // Même table deux fois de suite en tête : pire pour la mesure locale,
    // même si le score renvoyé prétend avoir progressé.
    const ids = solver.requests[1].request.performances;
    const tableOne = ids.filter(row => row.groups.includes('1')).map(row => row.id);
    const others = ids.filter(row => !row.groups.includes('1')).map(row => row.id);
    solver.answer(1, { order: [...tableOne, ...others], seedScore: '0hard/-900medium/0soft',
      score: '0hard/-100medium/0soft' });
    assert.equal(await s.solverRefinePromise, false);
    assert.deepEqual(s.readyView().map(item => item.entryId), before);
    assert.equal(s.solverStatus().refineImprovements, 0);
  } finally { s.closeSolver(); }
});

test('un vrai changement interrompt la passe continue ; sa réponse tardive est ignorée', async () => {
  const { s, people } = smallEvening();
  const solver = fakeSolver(s);
  try {
    s.solverStatus();
    solver.answer(0);
    await s.solverPromise;
    await until(() => solver.requests.length === 2, 'passe continue');
    s.chooseSong(people[5], song(99), 'append');
    let status = s.solverStatus();
    assert.equal(solver.requests.length, 3, 'nouveau calcul pour la nouvelle file');
    assert.equal(solver.requests[2].request.randomSeed, undefined);
    assert.equal(status.refining, false);
    assert.equal(status.pending, true);
    const reversed = solver.requests[1].request.performances.map(row => row.id).reverse();
    solver.answer(1, { order: reversed, seedScore: '0hard/-900medium/0soft', score: '0hard/0medium/0soft' });
    assert.equal(await s.solverRefinePromise, false, 'réponse d’une file périmée');
    solver.answer(2);
    assert.equal(await s.solverPromise, true);
    status = s.solverStatus();
    assert.equal(status.plan, 'confirmed');
    assert.equal(status.refineRuns, 0, 'compteurs remis à zéro pour la nouvelle file');
    await until(() => solver.requests.length === 4, 'la recherche reprend sur la nouvelle file');
    assert.equal(solver.requests[3].request.randomSeed, 1);
    assert.equal(solver.requests[3].request.budgetMs, 100, 'budget de départ pour une nouvelle file');
  } finally { s.closeSolver(); }
});

test('le passage des chansons ne relance pas la recherche depuis le début', async () => {
  const { s } = smallEvening();
  const solver = fakeSolver(s);
  try {
    s.solverStatus();
    solver.answer(0);
    await s.solverPromise;
    await until(() => solver.requests.length === 2, 'passe continue');
    const next = s.reserveNext();
    assert.ok(next);
    const selected = s.select();
    s.commit(selected);
    s.songEnded(selected.ids);
    assert.equal(s.solverStatus().pending, false, 'le plan reste valable après la chanson');
    assert.equal(solver.requests.length, 2);
    solver.answer(1);
    assert.equal(await s.solverRefinePromise, false);
    assert.equal(s.solverStatus().refineRuns, 1, 'la passe en cours reste comptée');
    await until(() => solver.requests.length === 3, 'passe suivante');
    assert.equal(solver.requests[2].request.budgetMs, 200);
    assert.ok(!solver.requests[2].request.performances.some(row => row.id === selected.song.entryId),
      'le titre chanté ne fait plus partie du problème');
  } finally { s.closeSolver(); }
});

test('ordre manuel du bar, option désactivée ou mode démonstration : aucune passe continue', async () => {
  {
    const { s, people } = smallEvening();
    const solver = fakeSolver(s);
    try {
      s.solverStatus();
      solver.answer(0);
      await s.solverPromise;
      await until(() => solver.requests.length === 2, 'passe continue');
      s.staffMove(people[4].id, 0);
      assert.equal(s.solverStatus().plan, 'manual');
      solver.answer(1, { seedScore: '0hard/-900medium/0soft', score: '0hard/0medium/0soft' });
      assert.equal(await s.solverRefinePromise, false, 'une passe ne remplace jamais l’ordre du bar');
      await sleep(60);
      assert.equal(solver.requests.length, 2);
      assert.equal(s.solverStatus().plan, 'manual');
      assert.equal(s.solverStatus().nextRefineAt, null);
    } finally { s.closeSolver(); }
  }
  {
    const { s } = smallEvening({ continuousSolver: false });
    const solver = fakeSolver(s);
    try {
      s.solverStatus();
      solver.answer(0);
      await s.solverPromise;
      await sleep(60);
      s.solverStatus();
      assert.equal(solver.requests.length, 1);
      assert.equal(s.solverStatus().continuous, false);
    } finally { s.closeSolver(); }
  }
  {
    const { s } = smallEvening({ solverEnabled: false });
    const solver = fakeSolver(s);
    s.solverStatus();
    solver.answer(0);
    await s.solverPromise;
    await sleep(60);
    assert.equal(solver.requests.length, 1, 'les simulations sans solveur réel restent déterministes');
  }
});

test('sans gain, les pauses s’allongent jusqu’à deux minutes', async () => {
  const { s } = smallEvening({ solverRefinePauseMs: 2000 });
  const solver = fakeSolver(s);
  try {
    s.solverStatus();
    solver.answer(0);
    await s.solverPromise;
    const pause = () => s.solverStatus().nextRefineAt - Date.now();
    assert.ok(pause() > 1500 && pause() <= 2000);
    s.solverRefineStats.fruitless = 4;
    s._scheduleRefine();
    assert.ok(pause() > 7000 && pause() <= 8000, `pause ${pause()}`);
    s.solverRefineStats.fruitless = 12;
    s._scheduleRefine();
    assert.ok(pause() > 110_000 && pause() <= 120_000, `pause ${pause()}`);
  } finally { s.closeSolver(); }
});

test('les erreurs affichées au bar ne citent pas la bibliothèque de calcul', () => {
  const s = new Scheduler();
  s.solverBridge = { available: false, lastError: 'IllegalStateException: Solveur Timefold indisponible.' };
  assert.equal(s.solverStatus().fallbackLastError, 'Solveur d’optimisation indisponible.');
});

test('vrai solveur : les passes continues améliorent ou gardent l’ordre, sans perte de titre',
  { skip: !hasJar }, async () => {
    const s = new Scheduler({ solverEnabled: true, solverBudgetMs: 300, solverRefinePauseMs: 10 });
    const people = [];
    for (const [tableId, count] of [['A', 10], ['B', 4], ['C', 5]]) {
      s.setHeadcount(tableId, count);
      for (let i = 0; i < count; i++) people.push(s.join({ tableId, name: `${tableId}${i + 1}` }));
    }
    people.push(s.join({ tableId: 'Comptoir', name: 'S1', headcount: 40 }));
    people.forEach((p, index) => s.chooseSong(p, song(index + 1), 'append'));
    for (const [a, b] of [[0, 11], [3, 15], [12, 13]]) {
      const duo = s.inviteDuet(people[a], people[b].id, song(100 + a));
      if (duo.duet.state === 'pending') s.answerDuet(people[b], true, duo.entryId);
    }
    s.solverBridge = new TimefoldBridge({ settleMs: 0 });
    try {
      const greedy = s._planMetric(s._forecast(false, [], null, true, { ranks: null }));
      assert.equal(await s.whenPlanReady(), true);
      await until(() => s.solverStatus().refineRuns >= 3, 'trois passes réelles', 30_000);
      const status = s.solverStatus();
      assert.equal(status.fallbackLastError, null, 'la graine de recherche est acceptée par le solveur');
      assert.ok(['timefold', 'confirmed'].includes(status.plan));
      const shown = s.readyView();
      assert.ok(s._planMetric(s._forecast(false, [], null, true)) <= greedy,
        'l’ordre affiché n’est jamais moins bon que la règle locale');
      const ids = shown.map(item => item.entryId);
      assert.equal(new Set(ids).size, ids.length, 'aucun titre dupliqué');
      assert.equal(ids.length, s._forecast(false, [], null, true, { ranks: null }).length, 'aucun titre perdu');
    } finally { s.closeSolver(); }
  });
