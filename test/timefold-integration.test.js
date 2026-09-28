'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
        assert.ok(Date.now() - start < 3000, `${mode}: réponse dans le délai du pont`);
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
      const s = new Scheduler({ solverEnabled: true, ...options });
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
