'use strict';
// Gestes du bar par l'API, avec le faux KaraFun (démo isolée, aucune
// commande au KaraFun réel) : une ligne placée garde sa place quand les
// clients ajoutent des titres ou arrivent, l'annulation marche encore après
// un changement de la file ou de KaraFun, « Recalculer la file » les annule
// tous. Retours de la soirée du 23 octobre.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { staffRoute } = require('./staff-auth');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let base = null;

async function portFree(port) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}
async function freePort() {
  for (let port = 3270; port <= 3280; port += 2) {
    if (await portFree(port) && await portFree(port + 1)) return port;
  }
  throw new Error('Aucune paire de ports libres entre 3270 et 3281.');
}

async function call(route, body, admin = route.startsWith('/api/staff/')) {
  const target = admin ? await staffRoute(base, route) : route;
  const response = await fetch(base + target, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  return { status: response.status, data: await response.json() };
}
async function ok(route, body, admin) {
  const result = await call(route, body, admin);
  assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.data)}`);
  return result.data;
}
const planned = state => state.queue.filter(row => row.source === 'helper' && !row.future).map(row => row.id);

(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
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
    const addPerson = async n => {
      await ok('/api/staff/table', { id: String(n), headcount: 1 });
      const table = (await ok('/api/staff/state')).tables.find(t => t.id === String(n));
      const access = new URL(table.url).pathname.split('/').pop();
      const person = await ok('/api/table/person', { table: String(n), access, name: `Chanteur ${n}` }, false);
      const sing = (songId, mode = 'replace') => ok('/api/table/song', { table: String(n), access, personId: person.id,
        token: person.token, mode, song: { songId, title: `Titre ${songId}`, artist: 'Démo' } }, false);
      await sing(700 + n);
      return { ...person, sing };
    };
    for (let n = 1; n <= 6; n++) people.push(await addPerson(n));
    let state = await ok('/api/staff/state');
    const before = planned(state);
    assert.equal(before.length, 6);
    const elsa = before[5];
    const elsaName = state.queue.find(row => row.id === elsa && !row.future).name;

    // Annulé tout de suite, sans autre changement : l'ordre d'avant revient,
    // et le message le dit.
    await ok('/api/staff/move', { personId: elsa, toIndex: 2 });
    state = await ok('/api/staff/state');
    const exact = await ok('/api/staff/manual-change-undo', { id: state.manualChanges[0].id });
    assert.equal(exact.exact, true);
    assert.equal(exact.message, 'Dernier changement annulé ; ordre précédent retrouvé');
    assert.deepEqual(planned(await ok('/api/staff/state')), before);
    console.log('ok - annulation sans autre changement : ordre d’avant, message exact');

    // Déplacé de la 6e à la 3e place, comme Elsa de 7 à 4 le 23 octobre.
    await ok('/api/staff/move', { personId: elsa, toIndex: 2 });
    assert.equal(planned(await ok('/api/staff/state'))[2], elsa);
    await people[0].sing(760, 'append'); // un autre client ajoute un titre à sa liste
    state = await ok('/api/staff/state');
    assert.equal(planned(state)[2], elsa, 'un titre ajouté par un autre ne déplace pas la ligne placée');
    assert.equal(state.queue.find(row => row.source === 'helper' && row.id === elsa && !row.future).placed, true,
      'la page du bar marque la ligne placée');
    assert.equal(state.manualChanges.length, 1);
    assert.equal(state.manualChanges[0].canUndo, true, 'le geste reste annulable après l’ajout');
    const newcomer = await addPerson(7);
    state = await ok('/api/staff/state');
    assert.equal(planned(state)[2], elsa, 'une arrivée ne passe pas devant la ligne placée');
    assert.ok(planned(state).indexOf(newcomer.id) > 2);
    console.log('ok - ligne placée : un ajout et une arrivée ne la déplacent pas');

    // Un titre ajouté dans KaraFun hors de l'application : l'annulation marche
    // encore et ne touche pas à KaraFun.
    const nativeBefore = state.kf.queue.length;
    await ok('/api/staff/kf', { action: 'test-add', songId: 899 });
    let native = null;
    for (let i = 0; i < 40; i++) {
      native = (await ok('/api/staff/state')).kf.queue;
      if (native.length > nativeBefore) break;
      await sleep(100);
    }
    assert.ok(native.length > nativeBefore, 'la file native simulée devait accepter un titre externe');
    state = await ok('/api/staff/state');
    assert.equal(state.manualChanges[0].canUndo, true, 'un changement dans KaraFun n’empêche plus l’annulation');
    const undone = await ok('/api/staff/manual-change-undo', { id: state.manualChanges[0].id });
    assert.equal(undone.exact, false);
    assert.equal(undone.message, `Dernier changement annulé : la file a changé depuis, ${elsaName} retrouve sa place calculée`,
      'le message ne promet plus l’ordre d’avant');
    state = await ok('/api/staff/state');
    assert.deepEqual(state.manualChanges, []);
    assert.ok(planned(state).indexOf(elsa) > 2, 'annulée, la ligne retrouve sa place calculée');
    assert.deepEqual(state.kf.queue, native, 'l’annulation ne touche pas à KaraFun');
    console.log('ok - annulation après un ajout et un titre KaraFun externe');

    // Priorité, puis un ajout : elle reste la prochaine. « Recalculer la file »
    // l'annule avec les autres gestes.
    const urgent = planned(state).at(-1);
    await ok('/api/staff/move', { personId: urgent, toIndex: 0, priority: true });
    await ok('/api/staff/move', { personId: people[1].id, toIndex: 3 });
    await people[2].sing(762, 'append');
    await addPerson(8);
    state = await ok('/api/staff/state');
    assert.equal(planned(state)[0], urgent, 'la priorité reste la prochaine après un ajout et une arrivée');
    assert.equal(planned(state)[3], people[1].id);
    assert.equal(state.manualChanges.length, 2);
    const recalculated = await ok('/api/staff/queue-optimize', {});
    assert.equal(recalculated.ok, true);
    state = await ok('/api/staff/state');
    assert.deepEqual(state.manualChanges, [], '« Recalculer la file » annule tous les gestes');
    assert.ok(!state.queue.some(row => row.placed), 'plus aucune ligne placée');
    assert.match(state.log.find(line => /relance le calcul/.test(line.msg)).msg, /déplacements manuels sont abandonnés/);
    console.log('ok - priorité tenue après un ajout ; « Recalculer la file » annule les gestes');
  } finally {
    if (demo.exitCode === null) {
      demo.kill();
      await new Promise(resolve => demo.once('exit', resolve));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
