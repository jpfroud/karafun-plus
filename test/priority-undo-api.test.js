'use strict';
// Chaque intervention du bar se défait en ordre inverse, tant que la file prévue
// et les titres KaraFun restent les mêmes.
// Démo isolée : aucune commande n'est envoyée au KaraFun réel.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { staffRoute } = require('./staff-auth');

const root = path.join(__dirname, '..');
const port = 3240;
const base = `http://127.0.0.1:${port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function call(route, body, admin = route.startsWith('/api/staff/')) {
  const target = admin ? await staffRoute(base, route) : route;
  const response = await fetch(base + target, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  const data = await response.json();
  return { status: response.status, data };
}
async function ok(route, body, admin) {
  const result = await call(route, body, admin);
  assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.data)}`);
  return result.data;
}
function planned(state) {
  return state.queue.filter(row => row.source === 'helper' && !row.future).map(row => row.id);
}

(async () => {
  const demo = spawn(process.execPath, ['server.js', '--demo', '--port', String(port),
    '--public-port', String(port + 1), '--song-seconds', '60', '--no-open'],
  { cwd: root, windowsHide: true, stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (demo.exitCode !== null) throw new Error('Démo quittée prématurément');
      try { if ((await ok('/api/staff/state')).kf?.ready) { ready = true; break; } } catch (_) {}
      await sleep(100);
    }
    assert.ok(ready, 'Démo non prête');
    await ok('/api/staff/settings', { auto: false, autoPlay: false });
    const people = [];
    for (let i = 1; i <= 3; i++) {
      await ok('/api/staff/table', { id: String(i), headcount: 1 });
      const table = (await ok('/api/staff/state')).tables.find(t => t.id === String(i));
      const access = new URL(table.url).pathname.split('/').pop();
      const person = await ok('/api/table/person', { table: String(i), access, name: `Chanteur ${i}` }, false);
      await ok('/api/table/song', { table: String(i), access, personId: person.id,
        token: person.token, song: { songId: 800 + i, title: `Titre ${i}`, artist: 'Démo' } }, false);
      people.push({ ...person, table: String(i), access });
    }
    let state = await ok('/api/staff/state');
    const before = planned(state);
    assert.equal(before.length, 3);
    const advanced = before[2];
    await ok('/api/staff/move', { personId: advanced, toIndex: 0, priority: true });
    state = await ok('/api/staff/state');
    assert.equal(planned(state)[0], advanced, 'Priorité doit avancer le titre choisi');
    assert.ok(state.priorityUndo?.available, 'L’annulation immédiate doit être proposée');
    assert.equal(state.manualChanges.length, 1);
    assert.equal(state.manualChanges[0].kind, 'priority');
    assert.equal(state.manualChanges[0].canUndo, true);
    await ok('/api/staff/manual-change-undo', { id: state.manualChanges[0].id });
    state = await ok('/api/staff/state');
    assert.deepEqual(planned(state), before, 'Annuler doit restaurer la file précédente');
    assert.ok(!state.priorityUndo?.available);
    assert.deepEqual(state.manualChanges, []);
    console.log('ok - priorité puis annulation : ordre initial rétabli');

    await ok('/api/staff/move', { personId: advanced, toIndex: 0, priority: true });
    await ok('/api/staff/table', { id: '4', headcount: 1 });
    state = await ok('/api/staff/state');
    assert.equal(state.manualChanges[0].canUndo, true,
      'Créer une table vide ne change pas la file et ne doit pas empêcher l’annulation');
    await ok('/api/staff/manual-change-undo', { id: state.manualChanges[0].id });
    assert.deepEqual(planned(await ok('/api/staff/state')), before);
    console.log('ok - table vide créée entre priorité et annulation');

    // Deux priorités restent toutes deux visibles et annulables en remontant
    // l'historique. Une demande portant sur l'ancienne est refusée.
    await ok('/api/staff/move', { personId: before[1], toIndex: 0, priority: true });
    const afterFirstPriority = planned(await ok('/api/staff/state'));
    await ok('/api/staff/move', { personId: advanced, toIndex: 0, priority: true });
    state = await ok('/api/staff/state');
    assert.equal(planned(state)[0], advanced);
    assert.equal(state.manualChanges.length, 2);
    assert.equal(state.manualChanges[0].canUndo, true);
    assert.equal(state.manualChanges[1].canUndo, false);
    assert.equal((await call('/api/staff/manual-change-undo', { id: state.manualChanges[1].id })).status, 400,
      'Une intervention ancienne ne peut pas écraser la plus récente');
    await ok('/api/staff/manual-change-undo', { id: state.manualChanges[0].id });
    assert.deepEqual(planned(await ok('/api/staff/state')), afterFirstPriority);
    state = await ok('/api/staff/state');
    assert.equal(state.manualChanges.length, 1);
    assert.equal(state.manualChanges[0].canUndo, true);
    await ok('/api/staff/priority-undo', {});
    state = await ok('/api/staff/state');
    assert.deepEqual(planned(state), before, 'Deux priorités successives s’annulent chacune');
    console.log('ok - deux priorités annulées en ordre inverse');

    await ok('/api/staff/move', { personId: advanced, toIndex: 1 });
    const afterMove = planned(await ok('/api/staff/state'));
    await ok('/api/staff/move', { personId: before[1], toIndex: 0, priority: true });
    state = await ok('/api/staff/state');
    assert.deepEqual(state.manualChanges.map(x => x.kind), ['priority', 'move']);
    await ok('/api/staff/manual-change-undo', { id: state.manualChanges[0].id });
    assert.deepEqual(planned(await ok('/api/staff/state')), afterMove);
    state = await ok('/api/staff/state');
    await ok('/api/staff/manual-change-undo', { id: state.manualChanges[0].id });
    assert.deepEqual(planned(await ok('/api/staff/state')), before,
      'Le déplacement se défait lui aussi après la priorité');
    console.log('ok - déplacement et priorité annulés un par un');

    await ok('/api/staff/move', { personId: advanced, toIndex: 0, priority: true });
    await ok('/api/staff/move', { personId: before[1], toIndex: 0, priority: true });
    await ok('/api/staff/move', { personId: advanced, toIndex: 1 });
    state = await ok('/api/staff/state');
    assert.equal(state.manualChanges.length, 3);
    assert.equal((await ok('/api/staff/queue-recalculate', {})).undone, 3);
    assert.deepEqual(planned(await ok('/api/staff/state')), before,
      'Annuler tous restaure la situation précédant la première intervention');
    console.log('ok - annulation globale de trois interventions sans recalcul');

    await ok('/api/staff/move', { personId: advanced, toIndex: 0, priority: true });
    assert.ok((await ok('/api/staff/state')).priorityUndo?.available);
    const nativeBefore = (await ok('/api/staff/state')).kf.queue.length;
    await ok('/api/staff/kf', { action: 'test-add', songId: 899 });
    let nativeChanged = false;
    for (let i = 0; i < 40; i++) {
      if ((await ok('/api/staff/state')).kf.queue.length > nativeBefore) { nativeChanged = true; break; }
      await sleep(100);
    }
    assert.ok(nativeChanged, 'La file native simulée devait accepter un titre externe');
    state = await ok('/api/staff/state');
    assert.equal(state.manualChanges[0].canUndo, false);
    assert.match(state.manualChanges[0].unavailableReason, /file a changé/);
    assert.equal((await call('/api/staff/priority-undo', {})).status, 400,
      'La file KaraFun modifiée interdit de rétablir un ancien ordre');
    console.log('ok - changement dans KaraFun invalide l’annulation');
    await ok('/api/staff/kf', { action: 'test-add', songId: 898 });
    for (let i = 0; i < 40; i++) {
      if ((await ok('/api/staff/state')).queue.some(q => q.source === 'karafun')) break;
      await sleep(100);
    }
    const nativeQueue = (await ok('/api/staff/state')).kf.queue;
    assert.equal((await call('/api/staff/queue-recalculate', {})).status, 400,
      'Une ancienne annulation globale ne doit pas écraser une file devenue différente');
    state = await ok('/api/staff/state');
    const firstHelper = planned(state)[0];
    assert.equal(state.queue.filter(q => q.source === 'karafun').length, 1,
      'Le titre natif déjà chargé occupe la place protégée devant le helper');
    const noChange = await call('/api/staff/move', { personId: firstHelper, toIndex: 0, priority: true });
    assert.equal(noChange.status, 400, 'Priorité déjà au premier créneau ne doit pas afficher un faux succès');
    assert.match(noChange.data.error, /déjà le prochain passage libre/);
    assert.match(noChange.data.error, /KaraFun/);
    const nextHelper = planned(state).at(-1);
    const advancedAfterNative = await ok('/api/staff/move', { personId: nextHelper, toIndex: 0, priority: true });
    assert.equal(advancedAfterNative.firstFreePosition, 2);
    assert.match(advancedAfterNative.message, /première place libre/);
    assert.equal(planned(await ok('/api/staff/state'))[0], nextHelper,
      'La priorité dépasse les autres titres helper, après KaraFun');
    await ok('/api/staff/queue-recalculate', {});
    assert.deepEqual((await ok('/api/staff/state')).kf.queue, nativeQueue,
      'L’annulation globale ne doit pas déplacer les titres déjà chargés dans KaraFun');
    console.log('ok - priorité au premier créneau libre et KaraFun inchangé');

    // La ligne d'un duo porte les deux ids. Priorité sur l'invité doit viser
    // son solo, dont il est le propriétaire, pas le duo placé devant lui.
    const owner = people[0], guest = people[1];
    await ok('/api/staff/remove', { personId: owner.id });
    await ok('/api/table/duet', { table: owner.table, access: owner.access,
      personId: owner.id, token: owner.token, partnerId: guest.id,
      song: { songId: 970, title: 'Duo Alice Bob', artist: 'Démo' } }, false);
    await ok('/api/table/duet/answer', { table: guest.table, access: guest.access,
      personId: guest.id, token: guest.token, accept: true }, false);
    await ok('/api/table/song', { table: guest.table, access: guest.access,
      personId: guest.id, token: guest.token, mode: 'append',
      song: { songId: 971, title: 'Encore Bob', artist: 'Démo' } }, false);
    state = await ok('/api/staff/state');
    assert.ok(state.queue.some(q => q.source === 'helper' && q.id === owner.id && q.ids.includes(guest.id)));
    await ok('/api/staff/move', { personId: owner.id, toIndex: 1 });
    await ok('/api/staff/move', { personId: owner.id, toIndex: 0, priority: true });
    state = await ok('/api/staff/state');
    assert.deepEqual(planned(state)[0], owner.id);
    assert.equal(state.manualChanges[0].name, 'Chanteur 1 & Chanteur 2',
      'l’historique identifie le duo complet');
    const guestSolo = state.queue.find(q => q.source === 'helper' && q.id === guest.id);
    assert.ok(guestSolo && guestSolo.pos > state.queue.find(q => q.source === 'helper' && q.id === owner.id).pos);
    await ok('/api/staff/move', { personId: guest.id, toIndex: 0, priority: true });
    state = await ok('/api/staff/state');
    assert.equal(planned(state)[0], guest.id, 'Priorité sur Bob déplace son solo devant le duo d’Alice & Bob');
    assert.equal(state.queue.find(q => q.source === 'helper' && q.id === guest.id).song.songId, 802);
    console.log('ok - priorité du solo d’un invité devant son duo');

    const historyLength = state.manualChanges.length;
    const beforeRetirement = planned(state);
    const noOp = await ok('/api/staff/move', { personId: guest.id, toIndex: 0 });
    assert.equal(noOp.changed, false, 'déplacer un titre sur sa place est sans effet');
    assert.equal((await ok('/api/staff/state')).manualChanges.length, historyLength,
      'un déplacement sans effet ne pollue pas l’historique');
    await ok('/api/staff/remove', { personId: guest.id });
    state = await ok('/api/staff/state');
    assert.deepEqual(planned(state), beforeRetirement,
      'retirer le titre courant garde exactement les places si un titre suit dans la liste');
    assert.equal(state.manualChanges.length, historyLength,
      'le retrait garde les déplacements précédents dans l’historique');
    assert.equal(state.manualChanges[0].canUndo, true,
      'les interventions précédentes restent annulables après le retrait du titre');
    const replacement = state.queue.find(q => q.source === 'helper' && q.id === guest.id && !q.future);
    assert.equal(replacement?.song.songId, 971);
    assert.equal(replacement?.guaranteed, true,
      'la réservation du chanteur reste valable pour son titre suivant');
    await ok('/api/staff/manual-change-undo', { id: state.manualChanges[0].id });
    state = await ok('/api/staff/state');
    assert.equal(state.manualChanges.length, historyLength - 1);
    assert.equal(state.manualChanges[0].canUndo, true,
      'la priorité précédente peut encore être annulée après le retrait');
    const nativeAfterRemoval = state.kf.queue;
    await ok('/api/staff/queue-recalculate', {});
    state = await ok('/api/staff/state');
    assert.deepEqual(state.manualChanges, []);
    assert.equal(state.queue.find(q => q.source === 'helper' && q.id === guest.id && !q.future)?.song.songId, 971,
      'annuler les interventions ne restaure pas le titre retiré');
    assert.deepEqual(state.kf.queue, nativeAfterRemoval,
      'annuler les interventions après un retrait ne touche pas KaraFun');
    await ok('/api/staff/move', { personId: owner.id, toIndex: 1 });
    await ok('/api/staff/move', { personId: owner.id, toIndex: 0, priority: true });
    const beforeNoBacklog = planned(await ok('/api/staff/state'));
    await ok('/api/staff/remove', { personId: owner.id });
    state = await ok('/api/staff/state');
    assert.deepEqual(planned(state), beforeNoBacklog.filter(id => id !== owner.id),
      'retirer un titre sans remplaçant ne réordonne pas les autres chanteurs');
    assert.equal(state.manualChanges[0].canUndo, true,
      'le déplacement restant peut encore être annulé');
    console.log('ok - retrait sans rechange : les autres rangs restent stables');
    console.log('ok - retrait du titre prioritaire : remplaçant à la même place et historique conservé');
    assert.equal((await fetch(base + '/api/staff/priority-undo', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403,
    'Annulation réservée au bar');
    assert.equal((await fetch(base + '/api/staff/queue-recalculate', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403,
    'Recalcul réservé au bar');
    assert.equal((await fetch(base + '/api/staff/manual-change-undo', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403,
    'Annulation ciblée réservée au bar');
  } finally {
    if (demo.exitCode === null) {
      demo.kill();
      await new Promise(resolve => demo.once('exit', resolve));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
