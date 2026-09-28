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

test('la présence du prochain attend le plan pour ne pas annoncer la mauvaise personne', async () => {
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
  assert.equal(s.reservePresenceNext(), null);
  assert.equal(s.reservedNext, null, 'aucun nom annoncé pendant le calcul');
  finish();
  assert.equal(await s.solverPromise, true);
  assert.equal(s.reservePresenceNext().ids[0], baseline[1].ids[0]);
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
  assert.equal(s.select(), null, 'l’envoi attend la réponse asynchrone');
  s.note('Une information du bar sans effet sur la file');
  assert.equal(s.select(), null);
  assert.equal(calls, 1, 'une note ne lance pas une seconde optimisation');
  finish();
  assert.equal(await s.solverPromise, true, 'la réponse reste valable malgré le journal');
  assert.deepEqual(s.readyView().map(item => item.entryId), [...original].reverse());
  s.note('Autre information sans effet sur la file');
  assert.deepEqual(s.readyView().map(item => item.entryId), [...original].reverse(),
    'un rafraîchissement de version ne déplace pas la file publiée');
  assert.equal(calls, 1, 'un état de file inchangé n’est pas recalculé en boucle');
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

test('file créée à partir du vide : choix immédiat à un titre, repli borné à deux titres', async () => {
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
  assert.equal(s.select(), null, 'courte fenêtre initiale de calcul');
  assert.equal(s.solverStatus().blockingNext, true);
  s.solverNextStartedAt = Date.now() - 2501;
  assert.equal(s.solverStatus().blockingNext, false);
  const next = s.reserveNext();
  assert.ok(next, 'un départ reste possible même si le deep solve continue');
  assert.equal(s.reservedNext.personId, next.ids[0]);
  const oldRequest = s.solverPromise;
  const replanning = s.whenPlanReady();
  assert.equal(calls, 2, 'le deep solve repart avec le prochain verrouillé');
  assert.equal(s.solverBridge.available, true);
  finishes[0]([b.song.entryId, a.song.entryId]);
  assert.equal(await oldRequest, false, 'le plan sans réservation est désormais périmé');
  finishes[1]([next.song.entryId,
    next.ids[0] === a.id ? b.song.entryId : a.song.entryId]);
  assert.equal(await replanning, true);
  assert.equal(s.select().ids[0], next.ids[0], 'Timefold ne déplace pas le prochain annoncé');
});

test('la confirmation de présence réserve le prochain après la fenêtre courte', async () => {
  const s = new Scheduler({ requirePresence: true });
  const a = s.join({ tableId: '1', name: 'A', headcount: 1 });
  const b = s.join({ tableId: '2', name: 'B', headcount: 1 });
  s.chooseSong(a, { songId: 4101, title: 'A', artist: 'Test' });
  s.chooseSong(b, { songId: 4102, title: 'B', artist: 'Test' });
  s.solverBridge = { available: true, lastError: null,
    solve: () => new Promise(() => {}) };
  assert.equal(s.reservePresenceNext(), null);
  s.solverNextStartedAt = Date.now() - 2501;
  const announced = s.reservePresenceNext();
  assert.ok(announced);
  assert.equal(s.reservedNext.personId, announced.ids[0]);
  assert.equal(s.reservePresenceNext().ids[0], announced.ids[0],
    'la même personne reçoit la notification malgré le calcul approfondi');
});

test('les arrivées répétées ne repoussent pas indéfiniment la première chanson', () => {
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
  assert.equal(s.select(), null);
  const started = s.solverNextStartedAt;
  for (let i = 0; i < 5; i++) {
    const p = s.join({ tableId: `N${i}`, name: `N${i}`, headcount: 1 });
    if (i % 2 === 0) s.chooseSong(p, {
      songId: 4300 + i, title: `N${i}`, artist: 'Test',
    });
    s.whenPlanReady();
    assert.equal(s.solverNextStartedAt, started,
      'une arrivée ne remet jamais les 2,5 secondes à zéro');
  }
  assert.equal(requests.length, 4,
    'les inscriptions sans chanson ne lancent pas une optimisation inutile');
  s.solverNextStartedAt = Date.now() - 2501;
  assert.ok(s.select(), 'le bar peut envoyer un titre pendant le calcul approfondi');
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

test('pont Timefold : A puis B puis C remplacés, seul C répond sans délai de panne', async () => {
  const workers = [];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.write = line => { child.input = JSON.parse(line); };
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
    assert.equal(workers.length, 2);
    assert.equal(workers[0].killed, true);
    const c = bridge.solve({ requestId: 'C' });
    await assert.rejects(b, /remplacé/);
    await tick();
    assert.equal(workers.length, 3);
    workers[0].stdout.emit('data', '{"requestId":"A","order":["ancien"]}\n');
    workers[1].stdout.emit('data', '{"requestId":"B","order":["ancien"]}\n');
    workers[0].emit('error', new Error('Ancien processus fermé'));
    workers[1].stdin.emit('error', new Error('Ancien tuyau fermé'));
    workers[2].stdout.emit('data', '{"requestId":"C","order":["dernier"]}\n');
    assert.deepEqual((await c).order, ['dernier']);
    assert.equal(bridge.lastError, null);
    assert.equal(bridge.available, true);
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
