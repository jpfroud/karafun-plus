'use strict';
// Intégration HTTP de la sauvegarde réelle, dans une copie temporaire sans code KaraFun.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { NightStateStore } = require('../night-state');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-api-restart-'));
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
  for (let port = 3210; port <= 3220; port++) {
    if (await portFree(port) && await portFree(port + 1)) return port;
  }
  throw new Error('Aucune paire de ports libres entre 3210 et 3221.');
}

async function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Serveur temporaire encore actif.')), 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function main() {
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.js'))) {
    fs.copyFileSync(path.join(root, name), path.join(sandbox, name));
  }
  // La copie de crash teste le repli sans JAR, tout en chargeant le même
  // module que le serveur du bar.
  fs.mkdirSync(path.join(sandbox, 'solver'));
  fs.copyFileSync(path.join(root, 'solver', 'bridge.js'), path.join(sandbox, 'solver', 'bridge.js'));
  // Injection limitée à cette copie : le prochain instantané demandé après
  // création du marqueur échoue comme lors d'un disque plein.
  const failMarker = path.join(sandbox, 'fail-next-save');
  fs.appendFileSync(path.join(sandbox, 'night-state.js'), `
const _realSaveForTest = NightStateStore.prototype.save;
NightStateStore.prototype.save = function(snapshot, options) {
  if (fs.existsSync(${JSON.stringify(failMarker)})) {
    fs.unlinkSync(${JSON.stringify(failMarker)});
    throw new Error('Panne d’écriture simulée');
  }
  return _realSaveForTest.call(this, snapshot, options);
};
`);
  fs.cpSync(path.join(root, 'public'), path.join(sandbox, 'public'), { recursive: true });
  const port = await choosePort();
  const base = `http://127.0.0.1:${port}`;
  const children = [];
  const launch = async () => {
    const child = spawn(process.execPath, ['server.js', '--port', String(port),
      '--public-port', String(port + 1), '--no-open'], {
      cwd: sandbox, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, NODE_PATH: [path.join(root, 'node_modules'),
        process.env.NODE_PATH].filter(Boolean).join(path.delimiter) },
    });
    children.push(child);
    let key;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Le serveur temporaire a quitté (${child.exitCode ?? child.signalCode}).`);
      }
      try {
        const response = await fetch(base + '/', {
          redirect: 'manual', signal: AbortSignal.timeout(1000),
        });
        if (response.status === 302) {
          key = new URL(response.headers.get('location'), base).searchParams.get('key');
          if (key) break;
        }
      } catch (_) { /* Démarrage en cours. */ }
      await sleep(100);
    }
    assert.ok(key, 'Le serveur temporaire n’a pas démarré.');
    const request = async (route, body, cookie = '') => {
      const staffRoute = route.startsWith('/api/staff/') || route.startsWith('/qr/') ?
        route + (route.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key) : route;
      const response = await fetch(base + staffRoute, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        signal: AbortSignal.timeout(body?.photo ? 15000 : 3000),
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] || '',
        data: response.headers.get('content-type')?.includes('json') ? JSON.parse(raw) : raw };
    };
    const ok = async (route, body, cookie = '') => {
      const result = await request(route, body, cookie);
      assert.equal(result.status, 200, `${route} : HTTP ${result.status} ${JSON.stringify(result.data)}`);
      return result.data;
    };
    return { child, request, ok, staff: () => ok('/api/staff/state') };
  };
  const stop = async (session, crash = false) => {
    if (session.child.exitCode !== null || session.child.signalCode !== null) return;
    if (crash) session.child.kill();
    else {
      const runtime = JSON.parse(fs.readFileSync(path.join(sandbox, 'data', `runtime-${port}.json`), 'utf8'));
      assert.equal(runtime.pid, session.child.pid, 'Le fichier d’arrêt doit désigner notre serveur.');
      const response = await fetch(base + '/internal/shutdown', {
        method: 'POST', headers: { 'x-helper-stop': runtime.secret },
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 200);
    }
    await exited(session.child);
    for (let i = 0; i < 30 && !(await portFree(port)); i++) await sleep(100);
    assert.ok(await portFree(port), 'Le port temporaire doit être libéré avant le redémarrage.');
  };

  try {
    const first = await launch();
    let state = await first.staff();
    assert.equal(state.karafun.demo, false);
    assert.equal(state.karafun.connected, false);
    assert.equal(state.code, '', 'La copie temporaire ne doit jamais rejoindre une session KaraFun.');
    await first.ok('/api/staff/settings', { auto: false, requirePresence: true,
      battleCooldownMin: 4 });
    await first.ok('/api/staff/table', { id: 'R1', headcount: 1 });
    await first.ok('/api/staff/table', { id: 'R2', headcount: 1 });
    state = await first.staff();
    const oldUrl = state.tables.find(table => table.id === 'R1').url;
    const access1 = new URL(oldUrl).pathname.split('/').pop();
    const access2 = new URL(state.tables.find(table => table.id === 'R2').url).pathname.split('/').pop();
    const alice = await first.ok('/api/table/person', { table: 'R1', access: access1, name: 'Alice' });
    const bob = await first.ok('/api/table/person', { table: 'R2', access: access2, name: 'Bob' });
    await first.ok('/api/table/song', { table: 'R1', access: access1, personId: alice.id,
      token: alice.token, song: { songId: 801, title: 'Solo', artist: 'Démo' } });
    await first.ok('/api/table/duet', { table: 'R1', access: access1, personId: alice.id,
      token: alice.token, partnerId: bob.id,
      song: { songId: 802, title: 'Duo', artist: 'Démo' } });
    await first.ok('/api/table/duet/answer', { table: 'R2', access: access2,
      personId: bob.id, token: bob.token, accept: true });
    await first.ok('/api/table/confirm', { table: 'R1', access: access1,
      personId: alice.id, token: alice.token });
    await first.ok('/api/staff/table', { id: 'Photos', headcount: 40 });
    const photoAccess = new URL((await first.staff()).tables.find(table =>
      table.id === 'Photos').url).pathname.split('/').pop();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/WZcAAAAASUVORK5CYII=', 'base64');
    const photoHashes = new Map();
    const photoBytes = 400 * 1024;
    for (let i = 1; i <= 39; i++) {
      const photo = Buffer.alloc(photoBytes);
      png.copy(photo);
      photo.writeUInt16BE(i, photo.length - 2); // 39 fichiers distincts, tous à la limite autorisée.
      const joined = await first.ok('/api/join', { table: 'Photos', access: photoAccess,
        name: `Photo ${i}`, photo: `data:image/png;base64,${photo.toString('base64')}` });
      photoHashes.set(joined.id, crypto.createHash('sha256').update(photo).digest('hex'));
    }
    state = await first.staff();
    assert.ok(state.queue.some(row => row.ids?.includes(alice.id)));
    assert.equal(state.people.length, 41);
    assert.equal(state.persistenceError, null, 'Les 39 photos ne saturent pas la sauvegarde.');
    const photoDir = path.join(sandbox, 'data', 'photos');
    const photoFiles = fs.readdirSync(photoDir);
    assert.equal(photoFiles.length, 39, 'Chaque photo a été écrite à part.');
    for (const digest of photoHashes.values()) {
      assert.equal(fs.statSync(path.join(photoDir, `${digest}.bin`)).size, photoBytes);
    }
    const snapshots = ['soiree-a.json', 'soiree-b.json'].map(name =>
      path.join(sandbox, 'data', name));
    assert.ok(snapshots.every(file => fs.statSync(file).size < 1024 * 1024),
      'Les instantanés JSON ne contiennent pas le contenu des 39 photos.');
    const latest = snapshots.map(file => JSON.parse(fs.readFileSync(file, 'utf8')))
      .sort((a, b) => b.sequence - a.sequence)[0];
    assert.equal(latest.payload.scheduler.people.filter(person => person.photo?.file).length, 39);
    const pendingSolo = await first.ok('/api/staff/solo-invite', { tableId: 'Comptoir' });
    const pendingSoloToken = new URL(pendingSolo.url).searchParams.get('invitation');
    assert.ok(pendingSoloToken);
    await stop(first, true); // Coupure abrupte après sauvegarde, sans routine d’arrêt.

    let second = await launch();
    state = await second.staff();
    assert.equal(state.tables.find(table => table.id === 'R1').url, oldUrl,
      'Le QR reste identique après un crash.');
    assert.equal(state.settings.requirePresence, true);
    assert.equal(state.settings.battleCooldownMin, 4);
    assert.equal(state.people.length, 41);
    assert.ok(state.soloInvitations.some(invitation => invitation.id === pendingSolo.id),
      'une invitation non consommée survit à un crash');
    assert.ok(state.queue.some(row => row.ids?.includes(alice.id)), 'La file est restaurée.');
    for (const [id, digest] of photoHashes) {
      assert.equal(state.people.find(person => person.id === id).photoUrl, `/photo/${id}`);
      const response = await fetch(base + `/photo/${id}`, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200, `Photo ${id} perdue après crash.`);
      assert.match(response.headers.get('content-type'), /^image\/png/);
      const restoredPhoto = Buffer.from(await response.arrayBuffer());
      assert.equal(restoredPhoto.length, photoBytes);
      assert.equal(crypto.createHash('sha256').update(restoredPhoto).digest('hex'), digest);
    }
    const client = await second.ok('/api/state?' + new URLSearchParams({
      table: 'R1', access: access1, token: alice.token,
    }));
    assert.deepEqual(client.managedIds, [alice.id]);
    const restored = client.tablePeople.find(person => person.id === alice.id);
    assert.equal(restored.songs.length, 2);
    assert.equal(restored.songs.find(song => song.songId === 802).duet.state, 'accepted');
    assert.equal(restored.confirmed, true, 'La confirmation de présence survit au crash.');
    console.log('ok - crash : file, duo, présence, téléphone, QR et 39 photos de 400 Kio restaurés');

    await second.ok('/api/staff/table', { id: 'Comptoir', headcount: 2, individual: true });
    const soloAccess = new URL((await second.staff()).tables.find(table =>
      table.id === 'Comptoir').url).pathname.split('/').pop();
    const soloBody = extra => ({ table: 'Comptoir', access: soloAccess, ...extra });
    fs.writeFileSync(failMarker, 'fail once');
    const failedSoloJoin = await second.request('/api/table/person', soloBody({
      name: 'Soliste', invitation: pendingSoloToken,
    }));
    assert.equal(failedSoloJoin.status, 400, 'une inscription solo sans sauvegarde échoue proprement');
    assert.equal(failedSoloJoin.cookie, '', 'aucun cookie n’est remis après la panne');
    assert.ok(!(await second.staff()).people.some(person => person.name === 'Soliste'),
      'la personne n’occupe pas de place fantôme après la panne');
    assert.ok((await second.staff()).soloInvitations.some(invitation => invitation.id === pendingSolo.id),
      'le QR individuel reste utilisable après la panne');
    const soloJoin = await second.request('/api/table/person', soloBody({
      name: 'Soliste', invitation: pendingSoloToken,
    }));
    assert.equal(soloJoin.status, 200);
    assert.equal((await second.request('/api/table/person', soloBody({
      name: 'Rejeu', invitation: pendingSoloToken,
    }))).status, 403, 'le code déjà utilisé reste consommé après restauration');
    const solo = soloJoin.data;
    assert.ok(soloJoin.cookie, 'le premier téléphone possède un cookie');
    const secondInvite = await second.ok('/api/staff/solo-invite', { tableId: 'Comptoir' });
    const secondToken = new URL(secondInvite.url).searchParams.get('invitation');
    fs.writeFileSync(failMarker, 'fail once');
    const failedLegacyJoin = await second.request('/api/join', soloBody({
      name: 'Autre soliste', invitation: secondToken,
    }));
    assert.equal(failedLegacyJoin.status, 400, 'l’autre route d’inscription suit la même transaction');
    assert.equal(failedLegacyJoin.cookie, '');
    assert.ok(!(await second.staff()).people.some(person => person.name === 'Autre soliste'));
    const secondJoin = await second.request('/api/join', soloBody({
      name: 'Autre soliste', invitation: secondToken,
    }));
    assert.equal(secondJoin.status, 200, 'le même QR fonctionne après retour du disque');
    const code = await second.ok('/api/table/person/share', soloBody({
      personId: solo.id, token: solo.token,
    }), soloJoin.cookie);
    const wrongCodes = ['0000', '1111', '2222', '3333', '4444'].filter(value => value !== code.code);
    for (const wrong of wrongCodes.slice(0, 4)) {
      const attempt = await second.request('/api/table/person/claim', soloBody({
        personId: solo.id, code: wrong,
      }));
      assert.equal(attempt.status, 400, 'une mauvaise tentative compte avant la panne');
    }
    fs.writeFileSync(failMarker, 'fail once');
    const interrupted = await second.request('/api/table/person/claim', soloBody({
      personId: solo.id, code: code.code,
    }));
    assert.equal(interrupted.status, 400, 'la reprise n’est pas annoncée comme réussie sans sauvegarde');
    assert.equal(interrupted.cookie, '', 'aucun nouveau cookie n’est remis après l’échec');
    const soloState = (token, cookie) => second.ok('/api/state?' + new URLSearchParams({
      table: 'Comptoir', access: soloAccess, token,
    }), undefined, cookie);
    assert.deepEqual((await soloState(solo.token, soloJoin.cookie)).managedIds, [solo.id],
      'le téléphone initial conserve son droit après l’échec');
    const claimed = await second.request('/api/table/person/claim', soloBody({
      personId: solo.id, code: code.code,
    }));
    assert.equal(claimed.status, 200, 'le même code reste valable après la panne');
    assert.ok(claimed.cookie && claimed.data.token !== solo.token);
    assert.deepEqual((await soloState(solo.token, soloJoin.cookie)).managedIds, []);
    assert.deepEqual((await soloState(claimed.data.token, claimed.cookie)).managedIds, [solo.id]);
    console.log('ok - transfert transactionnel : panne d’écriture, ancien accès gardé, code réutilisable');

    // Un lien de transfert déjà envoyé survit à une coupure de l'application.
    const link = await second.ok('/api/table/person/share', soloBody({
      personId: solo.id, token: claimed.data.token,
    }), claimed.cookie);
    const reprise = new URL(link.url).searchParams.get('reprise');
    // Sauvegarde de soirée et journal des soirées (dossier data/soirees).
    const readAll = file => fs.statSync(file).isDirectory() ?
      fs.readdirSync(file).map(name => readAll(path.join(file, name))).join('') : fs.readFileSync(file, 'utf8');
    const saved = fs.readdirSync(path.join(sandbox, 'data')).filter(name => name.startsWith('soiree'))
      .map(name => readAll(path.join(sandbox, 'data', name))).join('');
    assert.ok(fs.existsSync(path.join(sandbox, 'data', 'soirees')), 'le journal de la soirée est bien relu');
    assert.ok(!saved.includes(reprise) && !saved.includes(`"${link.code}"`), 'ni le lien ni le code ne sont écrits en clair');
    // Événement privé allumé, une entrée par son QR avant la coupure.
    const eventView = await second.ok('/api/staff/private-event', { enabled: true });
    assert.equal(eventView.enabled, true);
    const eventSecret = new URL(eventView.url).searchParams.get('evenement');
    assert.ok(eventSecret, 'QR de l’événement avec son secret');
    const entered = await second.request('/api/table/enter', soloBody({ event: eventSecret }));
    assert.equal(entered.status, 200, JSON.stringify(entered.data));
    assert.ok(entered.cookie, 'le navigateur entré garde son chanteur');
    const eventBefore = (await second.staff()).privateEvent;
    await stop(second, true);
    // Coupure pendant un titre : la copie n'a pas de KaraFun, l'horloge de la
    // scène est écrite dans la dernière sauvegarde comme le serveur l'aurait fait.
    const store = new NightStateStore(path.join(sandbox, 'data', 'soiree'));
    const beforeCrash = store.load();
    assert.equal(beforeCrash.stageClock, null, 'aucun titre sur scène sans KaraFun');
    const playing = { key: '9001', segAt: Date.now() - 42000, mediaMs: 15000, rate: 1.1, paused: false, position: 15 };
    // Chœurs par défaut relevés sur un KaraFun lors de cette soirée (empreinte du code).
    const kfDefaults = { code: 'a1b2c3d4e5f60718', backing: 80 };
    store.save({ ...beforeCrash, stageClock: playing, settings: { ...beforeCrash.settings, karafunDefaults: kfDefaults } });
    second = await launch();
    state = await second.staff();
    assert.deepEqual(state.privateEvent, eventBefore, 'événement privé : même état et même QR après le crash');
    const back = await second.request('/api/table/enter', soloBody({ event: eventSecret }), entered.cookie);
    assert.equal(back.status, 200, 'le même QR d’événement est encore accepté');
    assert.equal(back.data.id, entered.data.id, 'le même navigateur retrouve son chanteur');
    assert.equal(back.data.resumed, true);
    const newcomer = await second.request('/api/table/enter', soloBody({ event: eventSecret }));
    assert.equal(newcomer.status, 200, 'un autre navigateur entre encore par ce QR');
    assert.notEqual(newcomer.data.id, entered.data.id);
    // L'entrée a écrit une nouvelle sauvegarde : l'horloge restaurée y est reprise telle quelle.
    const afterRestart = new NightStateStore(path.join(sandbox, 'data', 'soiree')).load();
    assert.ok(afterRestart.scheduler.people.some(person => person.id === newcomer.data.id),
      'sauvegarde écrite après le redémarrage');
    assert.deepEqual(afterRestart.stageClock, playing, 'l’horloge du titre sur scène survit au redémarrage');
    assert.deepEqual(afterRestart.settings.karafunDefaults, kfDefaults, 'chœurs par défaut gardés après un crash');
    console.log('ok - crash : événement privé, son QR et l’horloge de la scène restaurés');
    assert.equal((await second.ok('/api/state?' + new URLSearchParams({
      table: 'Comptoir', access: soloAccess, reprise,
    }))).transferOffer.personId, solo.id, 'le lien est reconnu après le redémarrage');
    const viaLink = await second.request('/api/table/person/claim', soloBody({ link: reprise }));
    assert.equal(viaLink.status, 200, 'le lien reçu avant la coupure fonctionne encore');
    assert.equal((await second.request('/api/table/person/claim', soloBody({ link: reprise }))).status, 400,
      'il reste à usage unique');
    assert.deepEqual((await soloState(viaLink.data.token, viaLink.cookie)).managedIds, [solo.id]);
    console.log('ok - lien de transfert conservé après un crash, sans secret en clair');

    await second.ok('/api/staff/tables-clear', { confirmation: 'SUPPRIMER TOUTES LES TABLES' });
    const renewedSolo = (await second.staff()).tables;
    assert.equal(renewedSolo.length, 1);
    assert.equal(renewedSolo[0].id, 'Comptoir');
    assert.equal(renewedSolo[0].name, 'En solo');
    assert.equal(renewedSolo[0].individual, true);
    assert.deepEqual(fs.readdirSync(photoDir), [], 'Le reset retire aussi les fichiers photo.');
    // Regression: troisième relecture finale R4(b) — les chœurs par défaut
    // sauvegardés passaient à toutes les soirées : « Nouvelle soirée » oublie
    // une valeur provisoire. Quatrième passe (K1) : une valeur confirmée par
    // une remise de KaraFun au chargement reste dans la sauvegarde.
    assert.deepEqual(new NightStateStore(path.join(sandbox, 'data', 'soiree')).load().settings.karafunDefaults, kfDefaults,
      'nouvelle soirée : valeur confirmée gardée dans la sauvegarde');
    await stop(second, true); // Le reset doit survivre lui aussi à une coupure.
    // Valeur provisoire sauvegardée avant la relance : oubliée au prochain reset.
    const afterReset = store.load();
    store.save({ ...afterReset, settings: { ...afterReset.settings, karafunDefaults: { ...kfDefaults, provisional: true } } });

    const third = await launch();
    state = await third.staff();
    assert.equal(state.tables.length, 1, 'Le QR En solo reste prêt après un crash et un reset.');
    assert.equal(state.tables[0].url, renewedSolo[0].url);
    assert.deepEqual(state.people, []);
    assert.deepEqual(state.queue, []);
    assert.equal((await third.request(new URL(oldUrl).pathname)).status, 403);
    await third.ok('/api/staff/table', { id: 'R1', headcount: 1 });
    assert.notEqual((await third.staff()).tables.find(table => table.id === 'R1').url, oldUrl);
    await third.ok('/api/staff/tables-clear', { confirmation: 'SUPPRIMER TOUTES LES TABLES' });
    assert.equal('karafunDefaults' in new NightStateStore(path.join(sandbox, 'data', 'soiree')).load().settings, false,
      'nouvelle soirée : valeur provisoire oubliée dans la sauvegarde');
    await stop(third);
    console.log(`ok - reset persistant après crash, anciens QR révoqués sur les ports ${port}/${port + 1}`);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited(child); }
    }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const target = fs.realpathSync(sandbox);
  const tempRoot = fs.realpathSync(os.tmpdir());
  if (!target.startsWith(tempRoot + path.sep)) throw new Error('Nettoyage hors du dossier temporaire refusé.');
  fs.rmSync(target, { recursive: true, force: true });
});
