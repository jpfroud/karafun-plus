'use strict';
// Recette autonome : démarre uniquement un faux KaraFun sur des ports 3190+.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { staffRoute } = require('./staff-auth');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function portFree(port) {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    return true;
  } catch (error) {
    if (error.code === 'EADDRINUSE') return false;
    throw error;
  } finally {
    if (probe.listening) await new Promise(resolve => probe.close(resolve));
  }
}

async function choosePort() {
  for (let port = 3190; port <= 3200; port++) {
    if (await portFree(port) && await portFree(port + 1) && await portFree(port + 1001)) return port;
  }
  throw new Error('Aucun groupe de ports de démo libre entre 3190 et 3200.');
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill(), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function main() {
  const port = await choosePort();
  const base = `http://127.0.0.1:${port}`;
  const demo = spawn(process.execPath, ['server.js', '--demo', '--port', String(port),
    '--public-port', String(port + 1), '--song-seconds', '20', '--no-open'],
  { cwd: root, windowsHide: true, stdio: 'ignore' });
  let ready = false;
  try {
    async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
      const target = await staffRoute(base, route);
      const response = await fetch(base + target, {
        method, redirect: 'manual', signal: AbortSignal.timeout(3000),
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      const data = response.headers.get('content-type')?.includes('json') ? JSON.parse(raw) : raw;
      return { status: response.status, data, type: response.headers.get('content-type') || '' };
    }
    async function ok(route, body) {
      const result = await request(route, body);
      assert.equal(result.status, 200, `${route} : HTTP ${result.status} ${JSON.stringify(result.data)}`);
      return result.data;
    }
    const staff = () => ok('/api/staff/state');
    const accessFrom = table => new URL(table.url).pathname.split('/').pop();
    const body = (table, access, personId, token, extra = {}) =>
      ({ table, access, personId, token, ...extra });

    for (let i = 0; i < 100; i++) {
      if (demo.exitCode !== null || demo.signalCode !== null) {
        throw new Error(`La démo a quitté avant d’être prête (${demo.exitCode ?? demo.signalCode}).`);
      }
      try {
        const state = await staff();
        if (state.karafun.demo && state.kf?.ready) { ready = true; break; }
      } catch (_) { /* Le serveur démarre encore. */ }
      await sleep(100);
    }
    assert.ok(ready, 'La démo isolée n’a pas démarré.');
    let state = await staff();
    const soloBefore = state.tables.find(table => table.id === 'Comptoir');
    assert.ok(soloBefore?.individual && soloBefore.url && soloBefore.qrUrl,
      'Le groupe En solo et son QR doivent exister dès le démarrage.');
    assert.equal(soloBefore.name, 'En solo');
    const oldSoloPath = new URL(soloBefore.url).pathname;
    await ok('/api/staff/settings', { auto: false, autoPlay: false });
    await ok('/api/staff/table', { id: '1', headcount: 2 });
    await ok('/api/staff/table', { id: '2', headcount: 1 });
    state = await staff();
    const oldTable = state.tables.find(table => table.id === '1');
    const secondTable = state.tables.find(table => table.id === '2');
    assert.ok(oldTable?.url && oldTable.qrUrl && secondTable?.url);
    const oldAccess = accessFrom(oldTable);
    const secondAccess = accessFrom(secondTable);
    const oldPath = new URL(oldTable.url).pathname;
    const secondPath = new URL(secondTable.url).pathname;
    assert.equal((await request(oldPath)).status, 200, 'Le QR initial ouvre la table.');
    assert.equal((await request(secondPath)).status, 200);
    const oldQr = await request(oldTable.qrUrl);
    assert.equal(oldQr.status, 200);
    assert.match(oldQr.type, /^image\/svg\+xml/);
    assert.match(oldQr.data, /<svg\b[\s\S]*<path\b/);
    const staffQr = await request('/qr/staff.svg');
    assert.equal(staffQr.status, 200);
    assert.match(staffQr.type, /^image\/svg\+xml/);
    assert.match(staffQr.data, /<svg\b[\s\S]*<path\b/);
    assert.notEqual(staffQr.data, oldQr.data, 'Le QR du gérant porte une autre adresse.');
    assert.equal((await fetch(base + '/qr/staff.svg')).status, 403, 'Le QR gérant reste privé.');

    const alice = await ok('/api/table/person', { table: '1', access: oldAccess, name: 'Alice' });
    const bob = await ok('/api/table/person', { table: '2', access: secondAccess, name: 'Bob' });
    const song = { songId: 701, title: 'Titre conservé', artist: 'Démo' };
    await ok('/api/table/song', body('1', oldAccess, alice.id, alice.token, { song }));
    const share = await ok('/api/table/person/share', body('1', oldAccess, alice.id, alice.token));
    assert.match(share.code, /^[0-9]{4}$/, 'Le code remis au premier téléphone a quatre chiffres.');
    assert.ok(share.expiresAt > Date.now());
    const wrong = share.code === '0000' ? '1111' : '0000';
    assert.equal((await request('/api/table/person/claim', {
      table: '1', access: oldAccess, personId: alice.id, code: wrong,
    })).status, 400, 'Un mauvais code est refusé.');
    const resumed = await ok('/api/table/person/claim', {
      table: '1', access: oldAccess, personId: alice.id, code: share.code,
    });
    assert.notEqual(resumed.token, alice.token, 'Un autre téléphone reçoit un nouveau droit.');
    const tableState = token => ok('/api/state?' + new URLSearchParams({
      table: '1', access: oldAccess, token,
    }));
    assert.deepEqual((await tableState(alice.token)).managedIds, [], 'L’ancien téléphone perd son droit.');
    assert.deepEqual((await tableState(resumed.token)).managedIds, [alice.id]);
    assert.equal((await tableState(resumed.token)).tablePeople.find(p => p.id === alice.id).songs[0].songId,
      song.songId, 'Le titre suit le chanteur repris.');
    assert.equal((await request('/api/table/person/rename', body('1', oldAccess,
      alice.id, alice.token, { name: 'Usurpation' }))).status, 403);
    assert.equal((await request('/api/table/person/claim', {
      table: '1', access: oldAccess, personId: alice.id, code: share.code,
    })).status, 400, 'Un code consommé ne se réutilise pas.');
    const staffShare = await ok('/api/staff/person/share', { personId: bob.id });
    assert.match(staffShare.code, /^[0-9]{4}$/, 'Le code émis par le bar a aussi quatre chiffres.');
    const resumedBob = await ok('/api/table/person/claim', {
      table: '2', access: secondAccess, personId: bob.id, code: staffShare.code,
    });
    assert.notEqual(resumedBob.token, bob.token);
    console.log('ok - codes à 4 chiffres, reprise sur un autre téléphone et QR SVG du gérant');

    await ok('/api/staff/settings', { battleCooldownMin: 3 });
    state = await staff();
    assert.equal(state.settings.battleCooldownMin, 3);
    assert.equal(state.battle.cooldownMinutes, 3);
    for (const invalid of [0, 121, 1.5]) {
      assert.equal((await request('/api/staff/settings', { battleCooldownMin: invalid })).status, 400);
      assert.equal((await staff()).settings.battleCooldownMin, 3, 'Une valeur refusée ne change pas le délai.');
    }
    const beforeInvalid = (await staff()).settings;
    assert.equal((await request('/api/staff/settings', {
      auto: true, requirePresence: true, pushDelaySec: 181, battleCooldownMin: 4,
    })).status, 400);
    const afterInvalid = (await staff()).settings;
    for (const key of ['auto', 'requirePresence', 'pushDelaySec', 'battleCooldownMin']) {
      assert.equal(afterInvalid[key], beforeInvalid[key], `HTTP 400 a modifié ${key}.`);
    }
    const battleSong = (await ok('/api/search?q=Queen')).find(item => item.title === 'Bohemian Rhapsody');
    assert.ok(battleSong);
    await ok('/api/table/battle/propose', body('1', oldAccess, alice.id, resumed.token,
      { songs: [battleSong] }));
    state = await staff();
    assert.equal(state.battle.phase, 'voting');
    await ok('/api/table/battle/vote', body('2', secondAccess, bob.id, resumedBob.token,
      { choice: battleSong.songId }));
    assert.equal((await staff()).battle.phase, 'requested');
    await ok('/api/staff/battle/resolve', { outcome: 'done' });
    state = await staff();
    assert.equal(state.battle.phase, 'cooldown');
    assert.equal(state.battle.cooldownUntil, null, 'la pause attend la fin de la Battle manuelle');
    const endedAt = Date.now();
    await ok('/api/staff/battle/resolve', { outcome: 'finished' });
    state = await staff();
    assert.ok(state.battle.cooldownUntil >= endedAt + 3 * 60_000, 'pause comptée depuis la fin de la Battle');
    assert.ok(state.battle.cooldownUntil <= Date.now() + 3 * 60_000);
    await ok('/api/staff/settings', { battleCooldownMin: 5 });
    state = await staff();
    assert.equal(state.settings.battleCooldownMin, 5);
    assert.ok(state.battle.cooldownUntil >= endedAt + 5 * 60_000);
    assert.ok(state.battle.cooldownUntil <= Date.now() + 5 * 60_000);
    console.log('ok - délai Battle réglable, borné et compté depuis la fin de la Battle');

    await ok('/api/staff/settings', { auto: false });
    await ok('/api/table/song', body('2', secondAccess, bob.id, resumedBob.token,
      { song: { songId: 704, title: 'Titre de Bob', artist: 'Démo' } }));
    await ok('/api/table/song', body('2', secondAccess, bob.id, resumedBob.token,
      { song: { songId: 705, title: 'Autre titre de Bob', artist: 'Démo' }, mode: 'append' }));
    await ok('/api/staff/kf', { action: 'test-add', songId: 706 });
    await ok('/api/staff/kf', { action: 'test-add', songId: 707 });
    for (let i = 0; i < 30; i++) {
      state = await staff();
      if (state.kf.queue.length >= 2) break;
      await sleep(100);
    }
    assert.ok(state.kf.queue.length >= 2, 'La démo doit avoir au moins une chanson KaraFun à venir.');
    assert.equal((await request('/api/staff/queue-clear', { confirmation: 'NON' })).status, 400);
    assert.equal((await staff()).people.length, 2, 'Une confirmation incorrecte ne touche pas aux chanteurs.');
    assert.equal((await fetch(base + '/api/staff/queue-clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'VIDER TOUTES LES CHANSONS' }),
    })).status, 403, 'Un client ne peut pas vider la file.');
    const queueCleared = await ok('/api/staff/queue-clear', {
      confirmation: 'VIDER TOUTES LES CHANSONS',
    });
    assert.equal(queueCleared.ok, true);
    for (let i = 0; i < 80; i++) {
      state = await staff();
      if (!state.queueClearPending && state.queue.length === 0) break;
      await sleep(100);
    }
    assert.equal(state.queueClearPending, false, 'Le vidage reste bloqué malgré les confirmations KaraFun.');
    assert.equal(state.queue.length, 0, 'Des chansons restent visibles dans la file.');
    assert.equal(state.tables.length, 3);
    assert.equal(state.people.length, 2);
    assert.ok(state.people.some(person => person.id === alice.id));
    assert.ok(state.people.some(person => person.id === bob.id));
    assert.equal((await request(oldPath)).status, 200, 'Le QR de table reste valide.');
    assert.equal((await tableState(resumed.token)).tablePeople.find(p => p.id === alice.id).songs.length, 0);
    assert.equal((await ok('/api/state?' + new URLSearchParams({ table: '2', access: secondAccess,
      token: resumedBob.token }))).tablePeople.find(p => p.id === bob.id).songs.length, 0);
    await ok('/api/table/song', body('1', oldAccess, alice.id, resumed.token,
      { song: { songId: 708, title: 'Nouvelle liste', artist: 'Démo' } }));
    assert.equal((await tableState(resumed.token)).tablePeople.find(p => p.id === alice.id).songs[0].songId, 708,
      'Le même téléphone peut refaire sa liste après vidage.');
    console.log('ok - vidage complet de la file, confirmation bar, retrait KaraFun, QR et identités conservés');

    // Le morceau sur scène a été volontairement conservé pendant le vidage.
    // L'étape suivante de cette recette démarre avec une scène libre.
    if ((await staff()).stage) await ok('/api/staff/kf', { action: 'next' });

    assert.equal((await request('/api/staff/tables-clear', { confirmation: 'NON' })).status, 400);
    assert.equal((await staff()).tables.length, 3, 'Un reset non confirmé ne modifie rien.');
    const cleared = await ok('/api/staff/tables-clear', {
      confirmation: 'SUPPRIMER TOUTES LES TABLES',
    });
    assert.equal(cleared.ok, true);
    state = await staff();
    assert.equal(state.tables.length, 1, 'Seul le groupe En solo est prêt pour une nouvelle soirée.');
    const soloAfter = state.tables[0];
    assert.equal(soloAfter.id, 'Comptoir');
    assert.equal(soloAfter.name, 'En solo');
    assert.notEqual(soloAfter.url, soloBefore.url, 'Le QR En solo est renouvelé à la fin de la soirée.');
    assert.equal((await request(oldSoloPath)).status, 403, 'L’ancien QR En solo est révoqué.');
    assert.equal((await request(new URL(soloAfter.url).pathname)).status, 200);
    assert.deepEqual(state.people, []);
    assert.deepEqual(state.queue, []);
    assert.equal(state.battle.phase, 'idle');
    assert.equal((await request(oldPath)).status, 403, 'L’ancien QR client est révoqué.');
    assert.equal((await request(secondPath)).status, 403, 'Tous les anciens QR clients sont révoqués.');
    assert.equal((await request(oldTable.qrUrl)).status, 404, 'L’ancien QR SVG est retiré.');
    assert.equal((await request('/api/table/person', {
      table: '1', access: oldAccess, name: 'Ancienne cliente',
    })).status, 403);
    assert.equal((await request('/api/song', { token: resumed.token, song })).status, 401,
      'L’ancien téléphone ne contrôle plus la soirée.');
    await ok('/api/staff/table', { id: '1', headcount: 1 });
    const fresh = (await staff()).tables.find(table => table.id === '1');
    assert.ok(fresh?.url && fresh.qrUrl);
    assert.notEqual(accessFrom(fresh), oldAccess, 'Une table recréée a un nouveau secret.');
    assert.equal((await request(oldPath)).status, 403);
    assert.equal((await request(new URL(fresh.url).pathname)).status, 200);
    const newQr = await request(fresh.qrUrl);
    assert.equal(newQr.status, 200);
    assert.match(newQr.type, /^image\/svg\+xml/);
    assert.notEqual(newQr.data, oldQr.data);
    const newcomer = await ok('/api/table/person', {
      table: '1', access: accessFrom(fresh), name: 'Nouvelle cliente',
    });
    console.log('ok - reset confirmé, file vidée, anciens QR révoqués et nouvelle table utilisable');

    // Une chanson manuelle occupe la scène ; celle de la table reste donc à venir.
    await ok('/api/staff/kf', { action: 'test-add', songId: 702 });
    await ok('/api/staff/settings', { auto: true, autoPlay: false, pushDelaySec: 0 });
    await ok('/api/table/song', body('1', accessFrom(fresh), newcomer.id, newcomer.token,
      { song: { songId: 703, title: 'Titre à retirer', artist: 'Démo' } }));
    let upcoming = null;
    for (let i = 0; i < 80; i++) {
      state = await staff();
      upcoming = state.tracked.find(track => track.ids.includes(newcomer.id));
      if (upcoming && state.kf.queue.some(track => track.queueId === upcoming.queueId)) break;
      await sleep(100);
    }
    assert.ok(upcoming && state.kf.queue.some(track => track.queueId === upcoming.queueId),
      'La chanson à venir a été envoyée au faux KaraFun.');
    assert.notEqual(state.stage?.queueId, upcoming.queueId, 'La chanson testée est à venir, pas sur scène.');
    const left = await ok('/api/staff/table-left', { id: '1' });
    assert.equal(left.removedFromKaraFun, 1);
    let removed = false;
    for (let i = 0; i < 80; i++) {
      state = await staff();
      removed = !state.kf.queue.some(track => track.queueId === upcoming.queueId) &&
        !state.tracked.some(track => track.queueId === upcoming.queueId);
      if (removed) break;
      await sleep(100);
    }
    assert.ok(removed, 'Le départ de la table retire aussi sa chanson à venir de KaraFun.');
    assert.equal((await request(new URL(fresh.url).pathname)).status, 403);
    console.log('ok - réglages atomiques et piste à venir retirée quand la table part');
    console.log(`Recette API isolée réussie sur les ports ${port} et ${port + 1}.`);
  } finally {
    if (demo.exitCode === null && demo.signalCode === null) {
      try {
        if (ready) {
          const runtime = JSON.parse(fs.readFileSync(path.join(root, 'data', `runtime-${port}.json`), 'utf8'));
          if (runtime.pid === demo.pid) {
            await fetch(base + '/internal/shutdown', {
              method: 'POST', headers: { 'x-helper-stop': runtime.secret },
              signal: AbortSignal.timeout(3000),
            });
          }
        }
      } catch (_) { /* Une démo en panne doit quand même être arrêtée. */ }
      await waitForExit(demo);
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
