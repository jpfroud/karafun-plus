'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { Scheduler } = require('../scheduler');
const { TimefoldBridge } = require('../solver/bridge');

const JAR = path.join(__dirname, '..', 'solver', 'target', 'karafun-solver.jar');

test('un plan Timefold admissible décide réellement avant le repli historique', () => {
  const s = new Scheduler();
  const a = s.join({ tableId: '1', name: 'A', headcount: 1 });
  const b = s.join({ tableId: '2', name: 'B', headcount: 1 });
  s.chooseSong(a, { songId: 1001, title: 'Titre A', artist: 'Test' });
  s.chooseSong(b, { songId: 1002, title: 'Titre B', artist: 'Test' });
  const baseline = s.presenceView();
  assert.equal(baseline.length, 2);
  const other = baseline[1];
  s.solverPlan = { version: s.version, ranks: new Map([
    [other.entryId, 0], [baseline[0].entryId, 1],
  ]) };
  assert.equal(s.readyView()[0].entryId, other.entryId,
    'le solveur change le premier passage si ses contraintes préfèrent l’autre titre');
  assert.equal(s.select().song.entryId, other.entryId);
  s.reservedNext = { personId: baseline[0].ids[0], reservedAt: Date.now() };
  assert.equal(s.select().song.entryId, baseline[0].entryId,
    'le prochain annoncé garde sa garantie malgré le plan');
});

test('échec du solveur : repli disponible et erreur visible au bar', async () => {
  const s = new Scheduler();
  const a = s.join({ tableId: '1', name: 'A', headcount: 1 });
  const b = s.join({ tableId: '2', name: 'B', headcount: 1 });
  s.chooseSong(a, { songId: 1001, title: 'Titre A', artist: 'Test' });
  s.chooseSong(b, { songId: 1002, title: 'Titre B', artist: 'Test' });
  s.solverBridge = { available: true, lastError: null,
    solve: async () => { throw new Error('JVM indisponible'); } };
  assert.equal(await s.whenPlanReady(), false);
  assert.equal(s.solverStatus().fallbackLastError, 'JVM indisponible');
  assert.equal(s.solverStatus().pending, false);
  assert.ok(s.select(), 'le repli hors Java continue la soirée');
});

test('la présence du prochain est annoncée tout de suite et le plan Timefold ne la change plus', async () => {
  const s = new Scheduler({ requirePresence: true });
  const a = s.join({ tableId: '1', name: 'A', headcount: 1 });
  const b = s.join({ tableId: '2', name: 'B', headcount: 1 });
  s.chooseSong(a, { songId: 1001, title: 'Titre A', artist: 'Test' });
  s.chooseSong(b, { songId: 1002, title: 'Titre B', artist: 'Test' });
  const baseline = s.presenceView();
  let finish;
  s.solverBridge = { available: true, lastError: null,
    solve: request => new Promise(resolve => {
      finish = () => resolve({ requestId: request.requestId,
        order: baseline.map(item => item.entryId).reverse() });
    }) };
  const announced = s.reservePresenceNext();
  assert.ok(announced, 'aucune attente de Java pour annoncer le prochain');
  assert.equal(announced.ids[0], baseline[0].ids[0]);
  assert.equal(s.solverStatus().pending, true, 'Timefold continue en arrière-plan');
  finish();
  await s.solverPromise;
  assert.equal(s.reservePresenceNext().ids[0], announced.ids[0],
    'le résultat de Timefold ne retire pas l’annonce faite à la personne');
});

test('une note pendant le calcul ne relance pas Timefold et son résultat est publié une seule fois', async () => {
  const s = new Scheduler();
  const a = s.join({ tableId: '1', name: 'A', headcount: 1 });
  const b = s.join({ tableId: '2', name: 'B', headcount: 1 });
  s.chooseSong(a, { songId: 1011, title: 'A', artist: 'Test' });
  s.chooseSong(b, { songId: 1012, title: 'B', artist: 'Test' });
  const original = s.readyView().map(item => item.entryId);
  let finish, calls = 0;
  s.solverBridge = { available: true, lastError: null, solve: request => {
    calls++;
    assert.equal(request.budgetMs, 3000, 'une petite file obtient trois secondes');
    return new Promise(resolve => {
      finish = () => resolve({ requestId: request.requestId, order: [...original].reverse() });
    });
  } };
  assert.equal(s.select()?.song.entryId, original[0], 'l’ordre local répond sans attendre Java');
  assert.equal(s.solverStatus().pending, true, 'le calcul Timefold est signalé en cours');
  s.note('Une information du bar sans effet sur la file');
  s.select();
  assert.equal(calls, 1, 'une note ne lance pas une seconde optimisation');
  // Mesure de qualité simulée : l'ordre de Timefold est ici meilleur.
  s._planMetric = slots => slots[0]?.entryId === original[1] ? 0 : 1000;
  finish();
  assert.equal(await s.solverPromise, true, 'la réponse reste valable malgré le journal');
  assert.equal(s.solverStatus().plan, 'timefold');
  assert.equal(s.solverStatus().lastRun.improved, true);
  assert.deepEqual(s.readyView().map(item => item.entryId), [...original].reverse());
  s.note('Autre information sans effet sur la file');
  assert.deepEqual(s.readyView().map(item => item.entryId), [...original].reverse(),
    'un rafraîchissement de version ne déplace pas la file publiée');
  assert.equal(calls, 1, 'un état de file inchangé n’est pas recalculé en boucle');
});

test('à qualité égale, Timefold confirme l’ordre affiché sans le bouleverser', async () => {
  const s = new Scheduler();
  const a = s.join({ tableId: '1', name: 'A', headcount: 1 });
  const b = s.join({ tableId: '2', name: 'B', headcount: 1 });
  s.chooseSong(a, { songId: 1021, title: 'A', artist: 'Test' });
  s.chooseSong(b, { songId: 1022, title: 'B', artist: 'Test' });
  const original = s.readyView().map(item => item.entryId);
  let finish;
  s.solverBridge = { available: true, lastError: null, solve: request => new Promise(resolve => {
    finish = () => resolve({ requestId: request.requestId, order: [...original].reverse() });
  }) };
  s.select();
  finish();
  assert.equal(await s.solverPromise, true);
  assert.equal(s.solverStatus().plan, 'confirmed');
  assert.equal(s.solverStatus().lastRun.improved, false);
  assert.deepEqual(s.readyView().map(item => item.entryId), original);
});

test('une modification réelle annule l’ancien plan ; 90 titres disposent de 15 secondes', async () => {
  const s = new Scheduler();
  const people = [];
  for (let i = 0; i < 60; i++) {
    const p = s.join({ tableId: `T${Math.floor(i / 10)}`, name: `P${i}`, headcount: 10 });
    people.push(p);
    s.chooseSong(p, { songId: 2000 + i, title: `Titre ${i}`, artist: 'Test' });
  }
  const finishes = [];
  const requests = [];
  s.solverBridge = { available: true, lastError: null, solve: request => {
    requests.push(request);
    return new Promise(resolve => finishes.push(order =>
      resolve({ requestId: request.requestId, order })));
  } };
  const old = s.whenPlanReady();
  assert.equal(requests[0].budgetMs, 15000);
  for (let i = 0; i < 30; i++) s.chooseSong(people[i], {
    songId: 3000 + i, title: `Reprise ${i}`, artist: 'Test',
  }, 'append');
  const current = s.whenPlanReady();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].budgetMs, 15000);
  finishes[0](requests[0].performances.map(row => row.id).reverse());
  assert.equal(await old, false, 'un ancien résultat ne déplace jamais le nouvel état');
  assert.equal(s.solverPlan, null);
  finishes[1](requests[1].performances.map(row => row.id));
  assert.equal(await current, true);
  assert.equal(s.readyView().length, 90);
});

test('file créée à partir du vide : choix immédiat, le calcul approfondi ne déplace pas le prochain', async () => {
  const s = new Scheduler();
  const a = s.join({ tableId: '1', name: 'A', headcount: 1 });
  s.chooseSong(a, { songId: 4001, title: 'A', artist: 'Test' });
  let calls = 0;
  const finishes = [];
  s.solverBridge = { available: true, lastError: null, solve: request => {
    calls++;
    return new Promise(resolve => finishes.push(order =>
      resolve({ requestId: request.requestId, order })));
  } };
  assert.equal(s.select()?.ids[0], a.id, 'un seul titre part sans attendre Timefold');
  assert.equal(calls, 0);
  const b = s.join({ tableId: '2', name: 'B', headcount: 1 });
  s.chooseSong(b, { songId: 4002, title: 'B', artist: 'Test' });
  assert.ok(s.select(), 'deux titres : l’ordre local répond immédiatement');
  assert.equal(s.solverStatus().blockingNext, false, 'plus aucune fenêtre d’attente');
  const next = s.reserveNext();
  assert.ok(next, 'un départ reste possible même si le deep solve continue');
  assert.equal(s.reservedNext.personId, next.ids[0]);
  assert.equal(calls, 1, 'la réservation du prochain réalise le plan : pas de nouveau calcul');
  const other = next.ids[0] === a.id ? b : a;
  s._planMetric = slots => slots[0]?.ids[0] === other.id ? 0 : 1000;
  finishes[0]([other.song.entryId, next.song.entryId]);
  await s.solverPromise;
  assert.equal(s.select().ids[0], next.ids[0], 'Timefold ne déplace pas le prochain annoncé');
});

test('la confirmation de présence réserve le prochain sans attendre Timefold', async () => {
  const s = new Scheduler({ requirePresence: true });
  const a = s.join({ tableId: '1', name: 'A', headcount: 1 });
  const b = s.join({ tableId: '2', name: 'B', headcount: 1 });
  s.chooseSong(a, { songId: 4101, title: 'A', artist: 'Test' });
  s.chooseSong(b, { songId: 4102, title: 'B', artist: 'Test' });
  s.solverBridge = { available: true, lastError: null,
    solve: () => new Promise(() => {}) };
  const announced = s.reservePresenceNext();
  assert.ok(announced);
  assert.equal(s.reservedNext.personId, announced.ids[0]);
  assert.equal(s.reservePresenceNext().ids[0], announced.ids[0],
    'la même personne reçoit la notification malgré le calcul approfondi');
});

test('les arrivées répétées ne bloquent jamais la première chanson', () => {
  const s = new Scheduler();
  const a = s.join({ tableId: '1', name: 'A', headcount: 1 });
  const b = s.join({ tableId: '2', name: 'B', headcount: 1 });
  s.chooseSong(a, { songId: 4201, title: 'A', artist: 'Test' });
  s.chooseSong(b, { songId: 4202, title: 'B', artist: 'Test' });
  const requests = [];
  s.solverBridge = { available: true, lastError: null, solve: request => {
    requests.push(request);
    return new Promise(() => {});
  } };
  assert.ok(s.select());
  for (let i = 0; i < 5; i++) {
    const p = s.join({ tableId: `N${i}`, name: `N${i}`, headcount: 1 });
    if (i % 2 === 0) s.chooseSong(p, {
      songId: 4300 + i, title: `N${i}`, artist: 'Test',
    });
    s.whenPlanReady();
    assert.ok(s.select(), 'le bar peut toujours envoyer un titre pendant le calcul');
  }
  assert.equal(requests.length, 4,
    'les inscriptions sans chanson ne lancent pas une optimisation inutile');
});

test('un invité sans ticket reste dans l’empreinte physique du plan', async () => {
  const s = new Scheduler();
  const a = s.join({ tableId: '1', name: 'A', headcount: 2 });
  const guest = s.join({ tableId: '1', name: 'Invité', headcount: 2 });
  const b = s.join({ tableId: '2', name: 'B', headcount: 1 });
  s.inviteDuet(a, guest.id, { songId: 4401, title: 'Duo', artist: 'Test' });
  s.chooseSong(b, { songId: 4402, title: 'Solo', artist: 'Test' });
  const requests = [];
  s.solverBridge = { available: true, lastError: null, solve: request => {
    requests.push(request);
    return new Promise(() => {});
  } };
  s.whenPlanReady();
  assert.equal(requests.length, 1);
  const unrelated = s.join({ tableId: '3', name: 'Sans chanson', headcount: 1 });
  assert.ok(unrelated);
  s.whenPlanReady();
  assert.equal(requests.length, 1, 'inscription sans titre : même problème de planification');
  guest.duetGuestCount = (guest.duetGuestCount || 0) + 1;
  s.version++;
  s.whenPlanReady();
  assert.equal(requests.length, 2, 'l’historique physique de l’invité change bien le score');
});

test('état A→B→A : aucune ancienne réponse ne remplace ni n’efface le nouveau calcul A', async () => {
  const s = new Scheduler();
  const a = s.join({ tableId: '1', name: 'A', headcount: 1 });
  const b = s.join({ tableId: '2', name: 'B', headcount: 1 });
  s.chooseSong(a, { songId: 4501, title: 'A', artist: 'Test' });
  s.chooseSong(b, { songId: 4502, title: 'B', artist: 'Test' });
  const jobs = [];
  s.solverBridge = { available: true, lastError: null, solve: request =>
    new Promise((resolve, reject) => jobs.push({ request, resolve, reject })) };
  const oldA = s.whenPlanReady();
  s.opts.tableRotation = true;
  const oldB = s.whenPlanReady();
  s.opts.tableRotation = false;
  const currentA = s.whenPlanReady();
  assert.equal(jobs.length, 3);
  jobs[0].resolve({ requestId: jobs[0].request.requestId,
    order: jobs[0].request.performances.map(row => row.id).reverse() });
  jobs[1].reject(new Error('Ancien plan remplacé'));
  assert.equal(await oldA, false);
  assert.equal(await oldB, false);
  assert.equal(s.solverPlan, null);
  assert.equal(s.solverStatus().pending, true,
    'la résolution et le rejet périmés conservent le nouveau calcul en cours');
  jobs[2].resolve({ requestId: jobs[2].request.requestId,
    order: jobs[2].request.performances.map(row => row.id) });
  assert.equal(await currentA, true);
  assert.equal(s.solverStatus().pending, false);
  assert.equal(s.solverStatus().fallbackLastError, null);
});

test('pont Timefold : A puis B puis C remplacés, la JVM reste chaude et seul C répond', async () => {
  const workers = [];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.inputs = [];
    child.stdin.write = line => { child.inputs.push(JSON.parse(line)); };
    child.kill = () => { child.killed = true; };
    workers.push(child);
    return child;
  };
  const bridge = new TimefoldBridge({ jar: 'faux.jar', java: 'faux',
    spawn: fakeSpawn, settleMs: 0 });
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  try {
    const a = bridge.solve({ requestId: 'A' });
    await tick();
    assert.equal(workers.length, 1);
    const b = bridge.solve({ requestId: 'B' });
    await assert.rejects(a, /remplacé/);
    await tick();
    const c = bridge.solve({ requestId: 'C' });
    await assert.rejects(b, /remplacé/);
    await tick();
    assert.equal(workers.length, 1, 'un seul processus Java pour toute la soirée');
    assert.notEqual(workers[0].killed, true, 'la JVM n’est pas redémarrée à chaque changement');
    assert.deepEqual(workers[0].inputs.map(input => input.requestId), ['A', 'B', 'C'],
      'chaque nouvelle ligne interrompt la recherche précédente côté Java');
    workers[0].stdout.emit('data', '{"requestId":"A","order":["ancien"]}\n');
    workers[0].stdout.emit('data', '{"requestId":"B","order":["ancien"]}\n');
    workers[0].stdout.emit('data', '{"requestId":"C","order":["dernier"]}\n');
    assert.deepEqual((await c).order, ['dernier']);
    assert.equal(bridge.lastError, null);
    assert.equal(bridge.available, true);
  } finally { bridge.close(); }
});

test('pont Timefold : un calcul forcé part sans fenêtre de regroupement', async () => {
  const workers = [];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.write = line => { child.input = JSON.parse(line); };
    child.kill = () => {};
    workers.push(child);
    return child;
  };
  const bridge = new TimefoldBridge({ jar: 'faux.jar', java: 'faux', spawn: fakeSpawn, settleMs: 60000 });
  try {
    const forced = bridge.solve({ requestId: 'F', budgetMs: 30000 }, { immediate: true });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(workers[0]?.input?.requestId, 'F');
    workers[0].stdout.emit('data', '{"requestId":"F","order":[]}\n');
    assert.deepEqual((await forced).order, []);
  } finally { bridge.close(); }
});

test('pont Timefold : une écriture stdin qui échoue libère le job sans attendre le watchdog', async () => {
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = () => { throw new Error('EPIPE immédiat'); };
    child.kill = () => { child.killed = true; };
    return child;
  };
  const bridge = new TimefoldBridge({ jar: 'faux.jar', java: 'faux',
    spawn: fakeSpawn, settleMs: 0 });
  try {
    await assert.rejects(bridge.solve({ requestId: 'write-fails' }), /EPIPE immédiat/);
    assert.equal(bridge.active, null);
    assert.equal(bridge.child, null);
    assert.equal(bridge.queued, null);
    assert.equal(bridge.available, false, 'un worker défectueux déclenche le repli');
  } finally { bridge.close(); }
});

test('Timefold calcule une file réelle sans titre perdu et garde le prochain titre figé',
  { skip: !fs.existsSync(JAR) && !fs.existsSync(path.join(__dirname, '..', 'solver', 'karafun-solver.jar')) },
  async () => {
    const s = new Scheduler();
    const people = {};
    for (const [tableId, count, names] of [
      ['JP', 2, ['Marine', 'JP']],
      ['Leila', 4, ['Leila', 'Dam', 'Yannick', 'Kenny']],
      ['Sebastiano', 1, ['Sebastiano']],
      ['Comptoir', 40, ['Osark', 'Johnny']],
    ]) for (const name of names) people[name] = s.join({ tableId, name, headcount: count });
    let id = 1;
    const song = () => ({ songId: id++, title: `Titre ${id}`, artist: 'Test' });
    const duo = (owner, guest) => {
      const item = s.inviteDuet(people[owner], people[guest].id, song());
      if (item.duet.state === 'pending') s.answerDuet(people[guest], true, item.entryId);
    };
    duo('Marine', 'JP'); duo('Leila', 'Dam');
    s.chooseSong(people.Johnny, song()); s.chooseSong(people.Sebastiano, song());
    duo('Osark', 'Johnny'); duo('Yannick', 'Marine'); duo('Kenny', 'JP');
    duo('Dam', 'Yannick'); duo('JP', 'Marine');
    s.Q = ['Marine', 'Leila', 'Johnny', 'Sebastiano', 'Osark',
      'Yannick', 'Kenny', 'Dam', 'JP'].map(name => people[name].id);
    for (const name of ['Marine', 'Leila', 'Johnny', 'Sebastiano']) {
      s.reservedNext = { personId: people[name].id, reservedAt: Date.now() };
      const selected = s.select();
      assert.equal(selected.ids[0], people[name].id);
      s.commit(selected); s.songEnded(selected.ids);
    }
    s.opts.solverEnabled = true;
    s.solverBridge = new TimefoldBridge();
    try {
      assert.equal(await s.whenPlanReady(), true, 'un vrai résultat Timefold doit être appliqué');
      assert.equal(s.solverPlan.version, s.version);
      assert.ok(s.solverPlan.ranks.get(people.Yannick.song.entryId) <
        s.solverPlan.ranks.get(people.Osark.song.entryId),
      'le classement Timefold lui-même espace le retour de Johnny');
      const ready = s.readyView();
      assert.equal(ready.length, 5);
      assert.equal(ready[0].ids[0], people.Yannick.id,
        'Yannick & Marine précèdent Osark & Johnny');
      const entryIds = ready.map(item => item.entryId);
      assert.equal(new Set(entryIds).size, entryIds.length, 'aucune chanson dupliquée');
      s.reserveNext();
      const locked = s.select();
      assert.equal(locked.song.entryId, ready[0].entryId, 'le prochain annoncé reste garanti');
    } finally { s.closeSolver(); }
  });

test('Timefold supporte 60 clients, 90 titres et les deux modes de rotation',
  { skip: !fs.existsSync(JAR) && !fs.existsSync(path.join(__dirname, '..', 'solver', 'karafun-solver.jar')) },
  async () => {
    const bridge = new TimefoldBridge();
    const performances = [];
    for (let i = 0; i < 60; i++) {
      const singer = `P${i}`;
      const group = `T${Math.floor(i / 10)}`;
      for (let k = 0; k < (i % 2 ? 1 : 2); k++) performances.push({
        id: `${singer}-${k}`, owner: singer, ownerSongIndex: k,
        singers: [singer], groups: [group], previousIndex: performances.length,
      });
    }
    try {
      for (const [mode, weightedTables] of [
        ['libre', false], ['rotation', false], ['pondérée', true],
      ]) {
        const start = Date.now();
        const response = await bridge.solve({
          requestId: mode, performances, pastAppearance: {}, physicalCount: {},
          pinnedUntil: 0, roundPeople: [], lastGroups: [],
          tableRotation: mode !== 'libre', weightedTables,
        });
        assert.ok(Date.now() - start < 8000, `${mode}: réponse dans le délai du pont`);
        assert.equal(response.order.length, 90, `${mode}: aucun titre perdu`);
        assert.equal(new Set(response.order).size, 90, `${mode}: aucun titre doublé`);
        assert.equal(new Set(response.order.slice(0, 60).map(id => id.split('-')[0])).size, 60,
          `${mode}: les 60 premiers passages physiques précèdent les reprises`);
        for (let i = 0; i < 60; i++) {
          assert.ok(response.order.indexOf(`P${i}-0`) >= 0);
          if (i % 2 === 0) assert.ok(response.order.indexOf(`P${i}-0`) <
            response.order.indexOf(`P${i}-1`), `${mode}: liste personnelle préservée`);
        }
      }
    } finally { bridge.close(); }
  });

test('budget de production : 60 chanteurs et 90 titres sont réellement optimisés 15 secondes',
  { skip: !fs.existsSync(JAR) && !fs.existsSync(path.join(__dirname, '..', 'solver', 'karafun-solver.jar')) },
  async () => {
    const s = new Scheduler({ solverEnabled: true, tableRotation: true });
    const people = [];
    for (let i = 0; i < 60; i++) {
      const p = s.join({ tableId: `T${Math.floor(i / 10)}`, name: `P${i}`, headcount: 10 });
      people.push(p);
      s.chooseSong(p, { songId: 6000 + i, title: `Premier ${i}`, artist: 'Test' });
    }
    for (let i = 0; i < 30; i++) s.chooseSong(people[i], {
      songId: 7000 + i, title: `Second ${i}`, artist: 'Test',
    }, 'append');
    const bridge = s.solverBridge;
    const actualSolve = bridge.solve.bind(bridge);
    bridge.solve = request => {
      assert.equal(request.budgetMs, 15000);
      assert.equal(request.performances.length, 90);
      return actualSolve(request);
    };
    try {
      assert.equal(await s.whenPlanReady(), true);
      const view = s.readyView();
      assert.equal(view.length, 90);
      assert.equal(new Set(view.map(turn => turn.entryId)).size, 90);
      assert.equal(new Set(view.slice(0, 60).map(turn => turn.ids[0])).size, 60,
        'aucune deuxième chanson avant les 60 premiers passages');
      assert.equal(s.solverStatus().fallbackLastError, null);
    } finally { s.closeSolver(); }
  });

test('la variante pondérée privilégie la grande table à crédit égal',
  { skip: !fs.existsSync(JAR) && !fs.existsSync(path.join(__dirname, '..', 'solver', 'karafun-solver.jar')) },
  async () => {
    const bridge = new TimefoldBridge();
    const performances = [
      { id: 'small', owner: 'small', ownerSongIndex: 0, singers: ['small'],
        groups: ['small'], previousIndex: 0 },
      ...Array.from({ length: 3 }, (_, i) => ({ id: `middle-${i}`, owner: `middle-${i}`,
        ownerSongIndex: 0, singers: [`middle-${i}`], groups: ['middle'], previousIndex: i + 1 })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `large-${i}`, owner: `large-${i}`,
        ownerSongIndex: 0, singers: [`large-${i}`], groups: ['large'], previousIndex: i + 4 })),
    ];
    try {
      const response = await bridge.solve({ requestId: 'weighted-test', performances,
        pastAppearance: {}, physicalCount: {}, pinnedUntil: 1, roundPeople: [],
        roundGroups: [], lastGroups: [], tableServeCounts: {},
        groupReadyCounts: { small: 1, middle: 3, large: 10 },
        tableRotation: true, weightedTables: true });
      assert.equal(response.order[0], 'small');
      assert.match(response.order[1], /^large-/,
        'après la petite table, une grande table obtient le crédit à égalité');
    } finally { bridge.close(); }
  });

test('avec Timefold actif, JP attend bien Table 2 puis Table 3 avant de revenir',
  { skip: !fs.existsSync(JAR) && !fs.existsSync(path.join(__dirname, '..', 'solver', 'karafun-solver.jar')) },
  async () => {
    const s = new Scheduler({ solverEnabled: true });
    const jp = s.join({ tableId: '1', name: 'JP', headcount: 2 });
    s.chooseSong(jp, { songId: 201, title: 'JP 1', artist: 'Test' });
    const send = async () => {
      await s.whenPlanReady();
      const selected = s.select();
      assert.ok(selected);
      s.commit(selected); s.songEnded(selected.ids);
      return selected.names[0];
    };
    try {
      assert.equal(await send(), 'JP');
      const marine = s.join({ tableId: '1', name: 'Marine' });
      const t2 = s.join({ tableId: '2', name: 'Table 2', headcount: 1 });
      const t3 = s.join({ tableId: '3', name: 'Table 3', headcount: 1 });
      s.chooseSong(marine, { songId: 202, title: 'Marine 1', artist: 'Test' });
      s.chooseSong(t2, { songId: 203, title: 'T2 1', artist: 'Test' });
      s.chooseSong(t3, { songId: 204, title: 'T3 1', artist: 'Test' });
      await s.whenPlanReady();
      assert.deepEqual(s.readyView().map(x => x.name), ['Table 2', 'Table 3', 'Marine']);
      assert.deepEqual([await send(), await send(), await send()], ['Table 2', 'Table 3', 'Marine']);
      s.chooseSong(marine, { songId: 205, title: 'Marine 2', artist: 'Test' });
      assert.equal(await send(), 'Marine');
      s.chooseSong(jp, { songId: 206, title: 'JP 2', artist: 'Test' });
      s.chooseSong(t2, { songId: 207, title: 'T2 2', artist: 'Test' });
      s.chooseSong(t3, { songId: 208, title: 'T3 2', artist: 'Test' });
      await s.whenPlanReady();
      assert.deepEqual(s.readyView().map(x => x.name), ['Table 2', 'Table 3', 'JP']);
    } finally { s.closeSolver(); }
  });

test('soirée réaliste six tables : arrivées, duos, listes, départs et prochain garanti dans les trois modes',
  { skip: !fs.existsSync(JAR) && !fs.existsSync(path.join(__dirname, '..', 'solver', 'karafun-solver.jar')) },
  async () => {
    for (const [mode, options] of [
      ['personnes', {}],
      ['tables', { tableRotation: true }],
      ['grandes tables', { tableRotation: true, weightedTables: true }],
    ]) {
      const s = new Scheduler({ solverEnabled: true, solverBudgetMs: 200, ...options });
      const members = new Map();
      let songId = 5000;
      const add = (tableId, headcount, name) => {
        const p = s.join({ tableId, headcount, name });
        if (!members.has(tableId)) members.set(tableId, []);
        members.get(tableId).push(p);
        return p;
      };
      const choose = (p, count = 1) => {
        for (let i = 0; i < count; i++) s.chooseSong(p, {
          songId: songId++, title: `${p.name} - ${songId}`, artist: 'Test',
        }, 'append');
      };
      const addTable = (tableId, headcount, singers) => {
        const people = Array.from({ length: singers }, (_, i) => add(tableId, headcount, `${tableId}-${i + 1}`));
        people.forEach(p => choose(p));
        return people;
      };
      const check = async stage => {
        assert.equal(await s.whenPlanReady(), true, `${mode}/${stage}: vrai plan Java`);
        assert.equal(s.solverPlan.version, s.version, `${mode}/${stage}: version courante`);
        assert.equal(s.solverStatus().fallbackLastError, null, `${mode}/${stage}: pas de repli`);
        const view = s.readyView();
        const expected = [...s.people.values()].filter(p => !p.withdrawnAt)
          .flatMap(p => s.songsOf(p).map(song => song.entryId));
        assert.equal(view.length, expected.length, `${mode}/${stage}: tous les titres prêts`);
        assert.deepEqual(new Set(view.map(item => item.entryId)), new Set(expected),
          `${mode}/${stage}: aucun titre perdu ni doublonné`);
        const seen = new Set([...s.people.values()]
          .filter(p => (p.sung || 0) + (p.duetGuestCount || 0) > 0).map(p => p.id));
        for (let i = 0; i < view.length; i++) {
          const current = view[i];
          const futureOwners = new Set();
          const futureFresh = view.slice(i + 1).some(item => {
            if (futureOwners.has(item.ids[0])) return false;
            futureOwners.add(item.ids[0]);
            return item.ids.every(pid => !seen.has(pid) && !current.ids.includes(pid));
          });
          const barPinned = i === 0 && s.reservedNext?.personId === current.ids[0];
          if (!barPinned && futureFresh) assert.ok(current.ids.every(pid => !seen.has(pid)),
            `${mode}/${stage}: retour physique avant un premier passage à la place ${i + 1}`);
          current.ids.forEach(pid => seen.add(pid));
        }
        return view;
      };
      const play = async () => {
        await s.whenPlanReady();
        const selected = s.select();
        assert.ok(selected, `${mode}: un titre prêt doit être sélectionnable`);
        s.commit(selected); s.songEnded(selected.ids);
        return selected;
      };
      try {
        // 10 chanteurs arrivent, puis trois autres tables complètent les six
        // groupes usuels du bar : 8/5, 4/4, 2/1, 4/2, 3/3, 2/1.
        const t1 = addTable('T1', 8, 5);
        const t2 = addTable('T2', 4, 4);
        addTable('T3', 2, 1);
        choose(t1[0]); choose(t2[0]);
        await check('première vague');
        const firstLocked = s.reserveNext();
        assert.ok(firstLocked);
        const t4 = addTable('T4', 4, 2);
        const t5 = addTable('T5', 3, 3);
        addTable('T6', 2, 1);
        const full = await check('six tables et listes personnelles');
        assert.equal(full.length, 18);
        assert.equal(full[0].entryId, firstLocked.song.entryId,
          `${mode}: arrivée de trois tables sans déplacer le prochain annoncé`);

        const cross = s.inviteDuet(t2[1], t4[0].id, {
          songId: songId++, title: 'Duo entre tables', artist: 'Test',
        });
        assert.equal(cross.duet.state, 'pending');
        s.answerDuet(t4[0], true, cross.entryId);
        const same = s.inviteDuet(t5[0], t5[1].id, {
          songId: songId++, title: 'Duo à la table', artist: 'Test',
        });
        assert.equal(same.duet.state, 'accepted');
        await check('duos confirmés');
        assert.equal((await play()).song.entryId, firstLocked.song.entryId);
        for (let i = 0; i < 4; i++) await play();

        // Une nouvelle chanteuse arrive à la table de huit ; quatre des cinq
        // inscrits initiaux s'en vont, laissant deux personnes présentes.
        const lateT1 = add('T1', 8, 'T1-arrivée-tardive'); choose(lateT1, 2);
        await check('arrivée tardive');
        for (const departed of t1.slice(1)) s.leave(departed);
        assert.equal(s.tableSingers('T1').filter(p => !p.withdrawnAt).length, 2);
        await check('départs de la table de huit');
        const lockedAfterDepartures = s.reserveNext();
        assert.ok(lockedAfterDepartures);
        const lateT4 = add('T4', 4, 'T4-arrivée-tardive'); choose(lateT4);
        const finalView = await check('nouvelle arrivée après départs');
        assert.equal(finalView[0].entryId, lockedAfterDepartures.song.entryId);
        assert.equal((await play()).song.entryId, lockedAfterDepartures.song.entryId);
        await check('après reprise');
      } finally { s.closeSolver(); }
    }
  });

// Soirée du 12 octobre avec Timefold actif : Timefold « améliorait » le 2e
// tour en faisant repasser la personne seule devant une table qui avait
// chanté avant elle, et ce plan était adopté. La règle de patience de _pick
// passe avant le plan : l'ordre du 1er tour reste, quel que soit le solveur.
test('avec Timefold actif, deux tables de 4 et une personne seule gardent l’ordre du 1er tour',
  { skip: !fs.existsSync(JAR) && !fs.existsSync(path.join(__dirname, '..', 'solver', 'karafun-solver.jar')) },
  async () => {
    const s = new Scheduler({ solverEnabled: true });
    s.setHeadcount('A', 6);
    s.setHeadcount('B', 6);
    const names = ['A1', 'B1', 'A2', 'B2', 'S', 'A3', 'B3', 'A4', 'B4'];
    const people = new Map(names.map(name =>
      [name, s.join({ tableId: name === 'S' ? 'Comptoir' : name[0], name })]));
    let songId = 9100;
    for (const name of names) for (let k = 0; k < 2; k++) {
      s.chooseSong(people.get(name), { songId: songId++, title: `${name} ${k + 1}`, artist: 'Test' }, 'append');
    }
    try {
      await s.whenPlanReady();
      const first = s.select();
      s.commit(first); s.songEnded(first.ids);
      assert.equal(await s.whenPlanReady(), true, 'un plan Timefold est confirmé ou adopté');
      const planned = [first.names[0], ...s.readyView().map(v => v.name)];
      assert.deepEqual(planned.slice(9), planned.slice(0, 9), 'le 2e tour reprend l’ordre du 1er');
    } finally { s.closeSolver(); }
  });

// Relecture : le score Java applique la règle de patience. Un ordre qui fait
// voir à quelqu'un un passage en double coûte au moins 4 000 en « medium »,
// moins que sortir des choix équitables (5 000).
test('QueueScore : un ordre qui fait voir un double coûte au moins 4 000 en medium', { skip: !fs.existsSync(JAR) }, async () => {
  const s = new Scheduler();
  s.setHeadcount('A', 6); s.setHeadcount('B', 6);
  const names = ['A1', 'B1', 'A2', 'B2', 'S', 'A3', 'B3', 'A4', 'B4'];
  const people = new Map(names.map(name => [name, s.join({ tableId: name === 'S' ? 'Comptoir' : name[0], name })]));
  let n = 9300;
  for (const name of names) for (let k = 0; k < 2; k++) s.chooseSong(people.get(name), { songId: n++, title: `${name} ${k}`, artist: 'x' }, 'append');
  const first = s.select(); s.commit(first); s.songEnded(first.ids);
  let request;
  s.solverBridge = { available: true, solve: req => { request = req; return new Promise(() => {}); } };
  s._requestSolver(s.solverContextFingerprint(), { budgetMs: 100 });
  const nameOf = row => s.people.get(row.owner).name;
  const node = request.performances;
  const i = node.findIndex((row, k) => k > 8 && nameOf(row) === 'B2');
  const broken = node.slice(); [broken[i], broken[i + 1]] = [broken[i + 1], broken[i]];
  assert.equal(nameOf(broken[i]), 'S');
  const medium = score => Number(/(-?\d+)medium/.exec(score)[1]);
  const bridge = new TimefoldBridge();
  try {
    const seed = async (rows, id) => (await bridge.solve({ ...request, requestId: id, budgetMs: 100,
      performances: rows.map((row, previousIndex) => ({ ...row, previousIndex })) }, { immediate: true })).seedScore;
    const kept = medium(await seed(node, 'patience-kept')), doubled = medium(await seed(broken, 'patience-broken'));
    assert.ok(doubled <= kept - 4000, `${doubled} contre ${kept}`);
    assert.ok(doubled > kept - 5000 - 2000, `pénalité plafonnée : ${doubled} contre ${kept}`);
  } finally { bridge.close(); }
});

// Soirée du 15 octobre : la dette de l'invitée d'un duo (passage pris en
// avance) ne vaut que pour son propre titre. Le score Java suit la règle
// locale : le duo de l'autrice, qui ne doit rien, garde sa place dans le tour
// au lieu de passer derrière tout le monde.
test('QueueScore : la dette de l’invitée d’un duo ne retarde pas le duo de l’autrice', { skip: !fs.existsSync(JAR) }, async () => {
  const s = new Scheduler();
  let n = 9400;
  const song = () => ({ songId: n++, title: `T${n}`, artist: 'x' });
  const join = (tableId, name) => s.join({ tableId, name, headcount: 4 });
  const ana = join('T4', 'Ana'), bea = join('T4', 'Bea');
  const others = [['T1', 'Chris'], ['T2', 'Dina'], ['T3', 'Eli'], ['T5', 'Fred'], ['T6', 'Gus']]
    .map(([tableId, name]) => join(tableId, name));
  for (const p of [ana, bea, ...others]) s.chooseSong(p, song(), 'append');
  for (let i = 0; i < 7; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
  s.inviteDuet(ana, bea.id, song());
  for (const p of others) s.chooseSong(p, song(), 'append');
  s.roundUse.set(bea.id, 2); // passage de Bea pris sur le tour suivant
  let request;
  s.solverBridge = { available: true, solve: req => { request = req; return new Promise(() => {}); } };
  s._requestSolver(s.solverContextFingerprint(), { budgetMs: 100 });
  const nameOf = row => row.singers.map(pid => s.people.get(pid).name).join(' & ');
  const local = request.performances;
  const duo = local.findIndex(row => row.singers.length === 2);
  assert.ok(duo >= 0 && duo < local.length - 2, `duo avant la fin du tour : ${local.map(nameOf).join(', ')}`);
  const medium = score => Number(/(-?\d+)medium/.exec(score)[1]);
  const bridge = new TimefoldBridge();
  try {
    const { seedScore } = await bridge.solve({ ...request, requestId: 'guest-debt', budgetMs: 100,
      performances: local.map((row, previousIndex) => ({ ...row, previousIndex })) }, { immediate: true });
    // Avant la correction, le score Java comptait Bea comme déjà passée et
    // sanctionnait ce duo comme hors des choix équitables (-5 000).
    assert.equal(medium(seedScore), 0, `ordre de la règle locale : ${local.map(nameOf).join(', ')}`);
  } finally { bridge.close(); }
});

// Même règle, auteur déjà compté dans le tour (passage réel ou dette) : la
// dette de son invitée compte encore, son duo ne devient pas un passage neuf.
// Y & Z, qui présente Z, doit passer d'abord, avec ou sans le repli de
// l'espacement (Y vient de chanter).
test('QueueScore : auteur déjà compté dans le tour, la dette de son invitée compte encore', { skip: !fs.existsSync(JAR) }, async () => {
  const medium = score => Number(/(-?\d+)medium/.exec(score)[1]);
  const bridge = new TimefoldBridge();
  try {
    for (const ownerDebt of [false, true]) for (const yJustSang of [false, true]) {
      let n = 9450;
      const song = () => ({ songId: n++, title: `T${n}`, artist: 'x' });
      const s = new Scheduler();
      s._maybeRequestSolver = () => {};
      const join = (tableId, name) => s.join({ tableId, name, headcount: 2 });
      const X = join('TX', 'X'), G = join('TG', 'G'), Y = join('TY', 'Y'), Z = join('TZ', 'Z'), W = join('TW', 'W');
      for (const p of [X, G, Y, Z, W]) s.chooseSong(p, song(), 'append');
      for (let i = 0; i < 5; i++) { const sel = s.select(); s.commit(sel); s.songEnded(sel.ids); }
      s.inviteDuet(X, G.id, song()); s.answerDuet(G, true);
      s.inviteDuet(Y, Z.id, song()); s.answerDuet(Z, true);
      s.roundPeople = new Set([X.id, G.id, Y.id, W.id]);
      s.roundApps = new Map(ownerDebt ? [[Y.id, 1], [W.id, 1]] : [[X.id, 1], [Y.id, 1], [W.id, 1]]);
      s.roundUse = new Map(ownerDebt ? [[X.id, 1], [G.id, 1]] : [[G.id, 1]]);
      s.roundOwed = new Set();
      s.appearanceSerial = 40;
      for (const p of [X, G, Y, Z]) p.lastAppearanceTurn = 10;
      W.lastAppearanceTurn = 40;
      if (yJustSang) Y.lastAppearanceTurn = 39;
      s.lastGroup = W.group;
      s.recentGroups = [];
      let request;
      s.solverBridge = { available: true, solve: req => { request = req; return new Promise(() => {}); } };
      s._requestSolver(s.solverContextFingerprint(), { budgetMs: 100 });
      const nameOf = row => row.singers.map(pid => s.people.get(pid).name).join(' & ');
      const local = request.performances;
      const label = JSON.stringify({ ownerDebt, yJustSang });
      assert.deepEqual(local.map(nameOf), ['Y & Z', 'X & G'], label);
      const seed = async (rows, id) => medium((await bridge.solve({ ...request, requestId: id, budgetMs: 100,
        performances: rows.map((row, previousIndex) => ({ ...row, previousIndex })) }, { immediate: true })).seedScore);
      const kept = await seed(local, `owner-counted-${label}`), swapped = await seed([local[1], local[0]], `owner-counted-swap-${label}`);
      assert.ok(kept > swapped, `${label} : Y & Z d'abord ${kept}, X & G d'abord ${swapped}`);
    }
  } finally { bridge.close(); }
});

// « Compromis » : la taille d'une table envoyée à Timefold (groupSizes) compte
// ses chanteurs inscrits, titre prêt ou non, et change bien le score.
function compromiseRequest() {
  const s = new Scheduler({ tableRotation: true, weightedTables: true });
  s.setHeadcount('B', 4); s.setHeadcount('A', 6);
  const b = ['B1', 'B2'].map(name => s.join({ tableId: 'B', name }));
  const a = ['A1', 'A2', 'A3', 'A4'].map(name => s.join({ tableId: 'A', name }));
  let n = 9500;
  for (const p of [...b, a[0], a[1]]) for (let k = 0; k < 2; k++) s.chooseSong(p, { songId: n++, title: `T${n}`, artist: 'x' }, 'append');
  // A3 et A4 ont déjà chanté ce soir et n'ont plus de titre : seule la
  // taille envoyée les compte. Un prénom de B n'a rien choisi.
  for (const p of [a[2], a[3]]) p.sung = 1;
  s.join({ tableId: 'B', name: 'B3' });
  let request;
  s.solverBridge = { available: true, solve: req => { request = req; return new Promise(() => {}); } };
  s._requestSolver(s.solverContextFingerprint(), { budgetMs: 100 });
  return { request, a, b };
}

test('compromis : Timefold reçoit la taille des tables (inscrits)', () => {
  const { request, a, b } = compromiseRequest();
  assert.deepEqual(request.groupSizes, { [a[0].group]: 4, [b[0].group]: 2 });
});

test('compromis : Timefold utilise la taille des tables (inscrits)',
  { skip: !fs.existsSync(JAR) && !fs.existsSync(path.join(__dirname, '..', 'solver', 'karafun-solver.jar')) }, async () => {
  const { request } = compromiseRequest();
  const medium = score => Number(/(-?\d+)medium/.exec(score)[1]);
  const bridge = new TimefoldBridge();
  try {
    const seed = async (req, id) => medium((await bridge.solve({ ...req, requestId: id, budgetMs: 100,
      performances: req.performances.map((row, previousIndex) => ({ ...row, previousIndex })) }, { immediate: true })).seedScore);
    const bFirst = { ...request, performances: [request.performances[1], request.performances[0], ...request.performances.slice(2)] };
    const withSizes = await seed(bFirst, 'sizes-with'), withoutSizes = await seed({ ...bFirst, groupSizes: {} }, 'sizes-without');
    assert.ok(withSizes < withoutSizes, `${withSizes} contre ${withoutSizes}`);
  } finally { bridge.close(); }
});

test('Timefold : une demande arrivée pendant la préparation de la précédente ne l’attend pas',
  { skip: !fs.existsSync(JAR) && 'jar Timefold absent' }, async () => {
    const bridge = new TimefoldBridge({ jar: JAR, settleMs: 0 });
    const performances = [];
    for (let i = 0; i < 60; i++) {
      for (let k = 0; k < (i % 2 ? 1 : 2); k++) performances.push({
        id: `P${i}-${k}`, owner: `P${i}`, ownerSongIndex: k,
        singers: [`P${i}`], groups: [`T${Math.floor(i / 10)}`], previousIndex: performances.length,
      });
    }
    const request = (requestId, budgetMs) => ({ requestId, budgetMs, performances, pastAppearance: {}, physicalCount: {},
      pinnedUntil: 0, roundPeople: [], lastGroups: [], tableRotation: true, weightedTables: false });
    try {
      await bridge.solve(request('chauffe', 100));
      // La seconde ligne arrive pendant que Java prépare la première (90
      // titres) : la première ne doit pas chercher ses 5 s avant elle.
      for (let k = 0; k < 5; k++) {
        const stale = bridge.solve(request(`ancienne-${k}`, 5000)).catch(() => null);
        await new Promise(resolve => setTimeout(resolve, 2));
        const start = Date.now();
        const fresh = await bridge.solve(request(`nouvelle-${k}`, 200));
        assert.equal(fresh.requestId, `nouvelle-${k}`);
        // gstack-timing-ok: réponse en 0,2 à 0,7 s ; une recherche périmée non coupée la retarde de 5 s.
        assert.ok(Date.now() - start < 3000, `réponse en ${Date.now() - start} ms (essai ${k + 1})`);
        await stale;
      }
    } finally { bridge.close(); }
  });

// Classe Java lancée sur le jar (java en mode fichier source, JDK 11 et plus) :
// appelle Main.solve avec une « demande plus récente » qui n'apparaît qu'après
// le début de la recherche, sans arrêt du fil de lecture. Seule la veille de
// Main peut alors couper la recherche (Timefold efface au démarrage de solve()
// un arrêt reçu juste avant).
const WATCH_PROBE = `import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.Method;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

public class WatchProbe {
    public static void main(String[] args) throws Exception {
        ObjectMapper json = new ObjectMapper();
        JsonNode request = json.readTree(System.in);
        Method solve = Class.forName("fr.karafun.plus.solver.Main")
            .getDeclaredMethod("solve", JsonNode.class, AtomicReference.class, BooleanSupplier.class);
        solve.setAccessible(true);
        // Faux au contrôle qui précède la recherche, vrai 50 ms plus tard.
        AtomicLong first = new AtomicLong();
        BooleanSupplier later = () -> {
            long now = System.nanoTime();
            first.compareAndSet(0, now);
            return now - first.get() > 50_000_000L;
        };
        Object response = solve.invoke(null, request, new AtomicReference<>(), later);
        System.out.println(json.writeValueAsString(response));
        // Durée de la recherche seule, depuis le contrôle qui la précède
        // (sans la préparation de la demande, longue sur une JVM froide).
        System.out.println((System.nanoTime() - first.get()) / 1_000_000);
    }
}
`;

test('Timefold : une demande plus récente arrête la recherche même après son démarrage',
  { skip: !fs.existsSync(JAR) && 'jar Timefold absent' }, t => {
    const { spawnSync } = require('node:child_process');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-watch-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'WatchProbe.java'), WATCH_PROBE);
    const performances = [];
    for (let i = 0; i < 60; i++) {
      for (let k = 0; k < (i % 2 ? 1 : 2); k++) performances.push({
        id: `P${i}-${k}`, owner: `P${i}`, ownerSongIndex: k,
        singers: [`P${i}`], groups: [`T${Math.floor(i / 10)}`], previousIndex: performances.length,
      });
    }
    const request = { requestId: 'veille', budgetMs: 5000, performances, pastAppearance: {}, physicalCount: {},
      pinnedUntil: 0, roundPeople: [], lastGroups: [], tableRotation: true, weightedTables: false };
    const run = spawnSync('java', ['-cp', JAR, path.join(dir, 'WatchProbe.java')], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 60000,
      env: { ...process.env, JAVA_TOOL_OPTIONS: '-Dorg.slf4j.simpleLogger.defaultLogLevel=warn' },
    });
    if (run.error?.code === 'ENOENT') return t.skip('java absent du PATH');
    assert.equal(run.status, 0, run.stderr || String(run.error));
    const [line, searchMs] = run.stdout.trim().split('\n').slice(-2);
    assert.equal(JSON.parse(line).requestId, 'veille');
    // gstack-timing-ok: arrêt redemandé toutes les 5 ms dès 50 ms ; sans veille, la recherche court son budget de 5 s.
    assert.ok(Number(searchMs) < 2500, `recherche arrêtée après ${searchMs} ms`);
  });

// ---------------------------------------------------------------- options JVM
// Issue #26 (deux modes) : KARAOKE_SOLVER_JVM_ARGS avant -jar, JAVA_TOOL_OPTIONS
// complétée et non écrasée, environnement pris dans l'option `env` du pont.
const { jvmArgsFrom, javaToolOptions } = require('../solver/bridge');
const LOG_OPTION = '-Dorg.slf4j.simpleLogger.defaultLogLevel=warn';

// Lance le faux processus Java d'un pont réglé par `env` et rend son appel.
async function spawnedWith(env) {
  const calls = [];
  const fakeSpawn = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.write = () => {};
    child.kill = () => {};
    return child;
  };
  const bridge = new TimefoldBridge({ jar: 'faux.jar', java: 'faux', spawn: fakeSpawn, settleMs: 0, env });
  const pending = bridge.solve({ requestId: 'J' }, { immediate: true }).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 5));
  bridge.close();
  assert.match((await pending).message, /Solveur fermé/);
  assert.equal(calls.length, 1);
  return calls[0];
}

test('B1 pont Timefold : KARAOKE_SOLVER_JVM_ARGS passe avant -jar, dans l’ordre, sans jeton vide', async () => {
  const call = await spawnedWith({ KARAOKE_SOLVER_JVM_ARGS: '  -Xmx256m   -XX:+UseSerialGC ' });
  assert.equal(call.file, 'faux');
  assert.deepEqual(call.args, ['-Xmx256m', '-XX:+UseSerialGC', '-jar', 'faux.jar']);
  assert.deepEqual(jvmArgsFrom('  -Xmx256m   -XX:+UseSerialGC '), ['-Xmx256m', '-XX:+UseSerialGC']);
});

test('B2 pont Timefold : sans réglage, exactement -jar et le jar (forme du rejeu)', async () => {
  for (const env of [{}, { KARAOKE_SOLVER_JVM_ARGS: '' }, { KARAOKE_SOLVER_JVM_ARGS: '   ' }]) {
    assert.deepEqual((await spawnedWith(env)).args, ['-jar', 'faux.jar'], JSON.stringify(env));
  }
  for (const value of [undefined, null, '', '   ']) assert.deepEqual(jvmArgsFrom(value), [], String(value));
});

test('B3 pont Timefold : JAVA_TOOL_OPTIONS complétée après l’option de journal, environnement de l’option env', async () => {
  const call = await spawnedWith({ JAVA_TOOL_OPTIONS: ' -Dessai=1 ', PATH: '/x' });
  assert.deepEqual(call.options.env, { JAVA_TOOL_OPTIONS: `${LOG_OPTION} -Dessai=1`, PATH: '/x' },
    'la valeur de l’exploitant suit l’option de journal ; rien d’autre que l’option env');
  assert.equal(call.options.cwd, path.join(__dirname, '..'));
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  for (const env of [{}, { JAVA_TOOL_OPTIONS: '  ' }]) {
    assert.equal((await spawnedWith(env)).options.env.JAVA_TOOL_OPTIONS, LOG_OPTION, JSON.stringify(env));
  }
  assert.equal(javaToolOptions(' -Dessai=1 '), `${LOG_OPTION} -Dessai=1`);
  for (const value of [undefined, '', '  ']) assert.equal(javaToolOptions(value), LOG_OPTION, String(value));
  // Sans option env : l'environnement du processus.
  const bridge = new TimefoldBridge({ jar: 'faux.jar', java: 'faux' });
  assert.equal(bridge.env, process.env);
  assert.deepEqual(bridge.jvmArgs, jvmArgsFrom(process.env.KARAOKE_SOLVER_JVM_ARGS));
  assert.equal(bridge.javaToolOptions, javaToolOptions(process.env.JAVA_TOOL_OPTIONS));
});

test('B4 vraie JVM : options de l’exploitant acceptées, 60 titres résolus',
  { skip: !fs.existsSync(JAR) && 'jar Timefold absent' }, async () => {
    const bridge = new TimefoldBridge({ jar: JAR, settleMs: 0, env: { ...process.env,
      KARAOKE_SOLVER_JVM_ARGS: '-Xmx256m -XX:+UseSerialGC', JAVA_TOOL_OPTIONS: '-Dkarafun.essai=1' } });
    const performances = [];
    for (let i = 0; i < 60; i++) {
      for (let k = 0; k < (i % 2 ? 1 : 2); k++) performances.push({
        id: `P${i}-${k}`, owner: `P${i}`, ownerSongIndex: k,
        singers: [`P${i}`], groups: [`T${Math.floor(i / 10)}`], previousIndex: performances.length,
      });
    }
    try {
      const response = await bridge.solve({ requestId: 'options-jvm', budgetMs: 200, performances, pastAppearance: {},
        physicalCount: {}, pinnedUntil: 0, roundPeople: [], lastGroups: [], tableRotation: true, weightedTables: false });
      assert.equal(response.requestId, 'options-jvm');
      assert.equal(bridge.lastError, null);
      assert.deepEqual(bridge.child.spawnargs.slice(1), ['-Xmx256m', '-XX:+UseSerialGC', '-jar', JAR]);
      assert.equal(bridge.javaToolOptions, `${LOG_OPTION} -Dkarafun.essai=1`);
    } finally { bridge.close(); }
  });

test('B5 vraie JVM : option refusée, repli local en quelques secondes, sans plantage',
  { skip: !fs.existsSync(JAR) && 'jar Timefold absent' }, async () => {
    const uncaught = [];
    const onUncaught = error => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    const bridge = new TimefoldBridge({ jar: JAR, settleMs: 0,
      env: { ...process.env, KARAOKE_SOLVER_JVM_ARGS: '-XX:+OptionInconnueKaraoke' } });
    try {
      const start = Date.now();
      const error = await bridge.solve({ requestId: 'refus', budgetMs: 200, performances: [] }).then(
        () => assert.fail('la JVM a accepté une option inconnue'), failure => failure);
      // gstack-timing-ok: la JVM refuse l'option en quelques dizaines de ms ; sans repli, le pont attendrait 30 s.
      assert.ok(Date.now() - start < 5000, `refus après ${Date.now() - start} ms`);
      assert.match(error.message, /s’est arrêté|EPIPE/);
      assert.equal(bridge.available, false, 'pause de 30 s : rotation locale de secours');
      // Erreurs tardives des flux (EPIPE) : ignorées par la garde d'identité.
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.deepEqual(uncaught, []);
    } finally {
      bridge.close();
      process.off('uncaughtException', onUncaught);
    }
  });

// Relecture de #26 : une option JVM qui journalise sur stdout (-Xlog:gc,
// -verbose:gc, -XX:+PrintCommandLineFlags) ne coupe pas Timefold ; une ligne
// qui commence comme un objet JSON et ne se lit pas reste refusée.
function talkingSpawn(noise) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.kill = () => {};
    child.stdin.write = line => {
      const { requestId } = JSON.parse(line);
      setImmediate(() => {
        child.stdout.emit('data', noise);
        child.stdout.emit('data', `${JSON.stringify({ requestId, order: ['A'] })}\n`);
      });
      return true;
    };
    return child;
  };
}

test('B6 pont Timefold : lignes de la JVM sur stdout ignorées, ligne JSON abîmée refusée', async () => {
  const bridge = new TimefoldBridge({ jar: 'faux.jar', java: 'faux', settleMs: 0,
    spawn: talkingSpawn('[0.004s][info][gc] Using Serial\n-XX:InitialHeapSize=16777216 -XX:+UseSerialGC\n') });
  try {
    const response = await bridge.solve({ requestId: 'journal-jvm' }, { immediate: true });
    assert.deepEqual(response.order, ['A']);
    assert.equal(bridge.lastError, null);
    assert.equal(bridge.available, true);
  } finally { bridge.close(); }
  const broken = new TimefoldBridge({ jar: 'faux.jar', java: 'faux', settleMs: 0, spawn: talkingSpawn('{"requestId":\n') });
  try {
    await assert.rejects(broken.solve({ requestId: 'abimee' }, { immediate: true }), /Réponse de l’optimiseur illisible\./);
    assert.equal(broken.available, false, 'pause de 30 s : rotation locale de secours');
  } finally { broken.close(); }
});

test('B7 vraie JVM : -Xlog:gc (journal sur stdout) laisse Timefold répondre',
  { skip: !fs.existsSync(JAR) && 'jar Timefold absent' }, async () => {
    const bridge = new TimefoldBridge({ jar: JAR, settleMs: 0,
      env: { ...process.env, KARAOKE_SOLVER_JVM_ARGS: '-Xmx256m -Xlog:gc' } });
    const performances = [];
    for (let i = 0; i < 60; i++) {
      for (let k = 0; k < (i % 2 ? 1 : 2); k++) performances.push({
        id: `P${i}-${k}`, owner: `P${i}`, ownerSongIndex: k,
        singers: [`P${i}`], groups: [`T${Math.floor(i / 10)}`], previousIndex: performances.length,
      });
    }
    try {
      const response = await bridge.solve({ requestId: 'xlog-gc', budgetMs: 200, performances, pastAppearance: {},
        physicalCount: {}, pinnedUntil: 0, roundPeople: [], lastGroups: [], tableRotation: true, weightedTables: false },
      { immediate: true });
      assert.equal(response.requestId, 'xlog-gc');
      assert.equal(bridge.lastError, null);
      assert.equal(bridge.available, true);
    } finally { bridge.close(); }
  });
