'use strict';
// Journal et statistiques côté serveur : « Nouvelle soirée » clôt et résume
// la soirée avant de tout effacer (sans fuite de l'historique de scène ni du
// partage entre tables), routes réservées au bar, export pseudonymisé, et
// événements notés pendant la synchronisation avec KaraFun.
//
// Le serveur est chargé dans un bac à sable `vm`, sans écouter de port (voir
// server-table-routes.test.js) ; data/ et journal/ sont en mémoire.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

function memoryDisk() {
  const disk = new Map();
  const inMemory = file => [path.join(root, 'data'), path.join(root, 'journal')]
    .some(dir => file === dir || String(file).startsWith(dir + path.sep));
  const missing = file => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  const memFs = { ...fs,
    existsSync: file => inMemory(file) ? disk.has(file) : fs.existsSync(file),
    readFileSync(file, ...rest) {
      if (!inMemory(file)) return fs.readFileSync(file, ...rest);
      if (!disk.has(file)) throw missing(file);
      return disk.get(file);
    },
    writeFileSync(file, data) { disk.set(file, String(data)); },
    appendFileSync(file, data) { disk.set(file, (disk.get(file) || '') + data); },
    renameSync(from, to) { if (!disk.has(from)) throw missing(from); disk.set(to, disk.get(from)); disk.delete(from); },
    unlinkSync(file) { disk.delete(file); },
    mkdirSync() {},
    // Dossiers déduits des fichiers écrits.
    readdirSync(dir) {
      const prefix = dir + path.sep;
      return [...new Set([...disk.keys()].filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length).split(path.sep)[0]))];
    } };
  return { disk, memFs, read: rel => disk.get(path.join(root, rel)), files: () => [...disk.keys()].map(file => path.relative(root, file)) };
}

// `memory` : disque d'un serveur précédent, pour simuler un redémarrage.
function harness({ persistent = false, memory = memoryDisk() } = {}) {
  const entry = source.lastIndexOf('main().catch(');
  const saves = [];
  const overrides = persistent ? {
    './night-state': { ...fromServer('./night-state'), NightStateStore: class { load() { return null; } save(snapshot) { saves.push(JSON.parse(JSON.stringify(snapshot))); return true; } } },
    './scheduler': (() => {
      const real = fromServer('./scheduler');
      return { ...real, Scheduler: class extends real.Scheduler { constructor(o) { super({ ...o, solverEnabled: false }); } } };
    })(),
    './spotify': (() => {
      const real = fromServer('./spotify');
      return { ...real, SpotifyLink: class extends real.SpotifyLink { constructor(o) { super({ ...o, file: null }); } } };
    })(),
  } : {};
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), ...(persistent ? [] : ['--demo'])];
  const context = { require: name => name === 'fs' ? memory.memFs : overrides[name] || fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL, setTimeout, clearTimeout,
    setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, journal, settings, access, battleVote, spotify, spotifyAutomation, sync, staffState, clearEvening,
      journalEvent, journalRoster, journalSample, noteSeen, spotifyTick, STAFF_KEY, PORT, PUBLIC_PORT,
      handle: server.listeners('request')[0], getTracked: () => tracked, getPending: () => pending,
      setBridge: b => { bridge = b; }, setPending: p => { pending = p; } };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  return Object.assign(f, { memory, saves });
}

function call(f, method, url, { body, port = f.PORT } = {}) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1', localPort: port }, destroy() {} });
    const out = { status: null, headers: {} };
    const res = {
      setHeader(name, value) { out.headers[name.toLowerCase()] = value; },
      getHeader(name) { return out.headers[name.toLowerCase()]; },
      hasHeader(name) { return name.toLowerCase() in out.headers; },
      removeHeader(name) { delete out.headers[name.toLowerCase()]; },
      writeHead(status, headers = {}) { out.status = status; for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = v; },
      end(data = '') {
        out.text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        out.body = /json/.test(out.headers['content-type'] || '') ? JSON.parse(out.text) : out.text;
        resolve(out);
      },
    };
    f.handle(req, res);
    setImmediate(() => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
}
const staff = (f, route) => `${route}${route.includes('?') ? '&' : '?'}key=${encodeURIComponent(f.STAFF_KEY)}`;
const lines = text => text.trim().split('\n').map(line => JSON.parse(line));
const plain = value => JSON.parse(JSON.stringify(value));

async function joinWithSong(f, tableId, name, songId) {
  f.sched.table(tableId).headcount = 4;
  const access = f.access.get(tableId) || f.access.issue(tableId);
  const joined = await call(f, 'POST', '/api/table/person', { body: { table: tableId, access, name } });
  assert.equal(joined.status, 200, joined.text);
  const person = { table: tableId, access, personId: joined.body.id, token: joined.body.token };
  const chosen = await call(f, 'POST', '/api/table/song', { body: { ...person, song: { songId, title: `Titre ${songId}`, artist: 'Artiste' } } });
  assert.equal(chosen.status, 200, chosen.text);
  return person;
}

test('« Nouvelle soirée » : la soirée est close et résumée, puis rien d’elle ne reste dans la suivante', async () => {
  const f = harness({ persistent: true });
  f.journal.open({ rules: {} });
  const oldId = f.journal.id;
  const alice = await joinWithSong(f, '1', 'Alice', 101);
  await joinWithSong(f, '2', 'Bruno', 102);
  // Un passage complet : envoyé, sur scène, terminé.
  const sel = f.sched.select();
  f.sched.commit(sel);
  f.sched.recordStage(sel);
  f.sched.endStage(sel);
  f.sched.recordPlayed({ queueId: 1, songId: sel.song.songId, title: sel.song.title });
  f.sched.roundUse.set(alice.personId, 0.5);
  assert.equal(f.sched.stageHistory.length, 1);
  assert.ok(f.sched.recentGroups.length && f.sched.appearanceSerial);

  const reset = await call(f, 'POST', staff(f, '/api/staff/tables-clear'), { body: { confirmation: 'SUPPRIMER TOUTES LES TABLES' } });
  assert.equal(reset.status, 200, reset.text);
  // Fuite corrigée : l'historique de scène (avec les prénoms), le partage
  // entre tables, les crédits de tour et le compteur de passages repartent de zéro.
  assert.deepEqual(plain(f.sched.stageHistory), []);
  assert.deepEqual(plain(f.sched.recentGroups), []);
  assert.equal(f.sched.roundUse.size, 0);
  assert.equal(f.sched.appearanceSerial, 0);
  assert.equal(f.sched.people.size, 0);

  // Ancienne soirée archivée : clôture, résumé et heure de fin.
  const old = lines(f.memory.read(`data/soirees/${oldId}/journal.jsonl`));
  assert.equal(old.at(-1).ev, 'evening.closed');
  assert.equal(old.at(-1).by, 'staff-reset');
  assert.equal(old.at(-1).unsungSongs, 1);
  assert.equal(old.at(-1).people, 2);
  assert.ok(old.some(e => e.ev === 'turn.sent' || e.ev === 'song.requested'));
  const summary = JSON.parse(f.memory.read(`data/soirees/${oldId}/summary.json`));
  assert.equal(summary.format, 'karaoke-evening-stats');
  assert.equal(summary.global.requests, 2);
  const meta = JSON.parse(f.memory.read(`data/soirees/${oldId}/meta.json`));
  assert.ok(meta.endedAt);
  assert.equal(meta.roster[alice.personId].name, 'Alice');
  for (const line of old) assert.ok(!JSON.stringify(line).includes('Alice'), 'aucun prénom dans le journal');

  // Nouvelle soirée : nouveau journal, sauvegardé dans l'instantané.
  assert.notEqual(f.journal.id, oldId);
  const fresh = lines(f.memory.read(`data/soirees/${f.journal.id}/journal.jsonl`));
  assert.equal(fresh[0].ev, 'evening.started');
  assert.ok(fresh.some(e => e.ev === 'table.opened' && e.tableId === 'Comptoir'), 'le groupe « En solo » ouvre la nouvelle soirée');
  assert.equal(f.saves.at(-1).evening.id, f.journal.id);
  const newMeta = JSON.parse(f.memory.read(`data/soirees/${f.journal.id}/meta.json`));
  assert.equal(newMeta.tables.Comptoir.name, 'En solo');

  // Les deux soirées sont consultables.
  const list = await call(f, 'GET', staff(f, '/api/staff/stats/evenings'));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.evenings.map(e => e.id).sort(), [oldId, f.journal.id].sort());
  const archived = await call(f, 'GET', staff(f, `/api/staff/stats?evening=${oldId}`));
  assert.equal(archived.status, 200);
  assert.equal(archived.body.evening.current, false);
  assert.equal(archived.body.names.people[alice.personId], 'Alice');
  assert.equal(archived.body.stats.global.requests, 2);
});

test('statistiques : réservées au bar, prénoms au bar seulement, export pseudonymisé par défaut', async () => {
  const f = harness({ persistent: true });
  f.journal.open({ rules: {} });
  const alice = await joinWithSong(f, '4', 'Alice', 201);
  const page = await call(f, 'GET', '/stats');
  assert.equal(page.status, 403);
  const pageOk = await call(f, 'GET', staff(f, '/stats'));
  assert.equal(pageOk.status, 200);
  assert.match(pageOk.text, /Statistiques de la soirée/);
  const publicPort = await call(f, 'GET', staff(f, '/api/staff/stats'), { port: f.PUBLIC_PORT });
  assert.equal(publicPort.status, 403, 'jamais par le tunnel public, même avec la clé');
  assert.equal((await call(f, 'GET', '/api/staff/stats/export')).status, 403);
  assert.equal((await call(f, 'GET', '/api/staff/stats/evenings')).status, 403);

  const view = await call(f, 'GET', staff(f, '/api/staff/stats'));
  assert.equal(view.status, 200);
  assert.equal(view.body.evening.current, true);
  assert.equal(view.body.names.people[alice.personId], 'Alice');
  assert.equal(view.body.names.tables['4'], 'Table 4');
  assert.equal(view.body.stats.global.requests, 1);
  assert.ok(Array.isArray(view.body.insights));
  assert.equal(view.body.journalError, null);
  assert.equal((await call(f, 'GET', staff(f, '/api/staff/stats?evening=../../etc'))).status, 404);
  assert.equal((await call(f, 'GET', staff(f, '/api/staff/stats?evening=2020-01-01_2000_abcd'))).status, 404);

  const exported = await call(f, 'GET', staff(f, '/api/staff/stats/export?evening=current'));
  assert.equal(exported.status, 200);
  assert.match(exported.headers['content-disposition'], new RegExp(`^attachment; filename="soiree-${f.journal.id}\\.json"$`));
  const person = f.sched.people.get(alice.personId);
  for (const secret of ['Alice', f.STAFF_KEY, person.token, alice.access, alice.personId]) {
    assert.ok(!exported.text.includes(secret), `export sans ${secret === 'Alice' ? 'prénom' : 'secret'}`);
  }
  assert.equal(exported.body.privacy.names, 'pseudonymized');
  assert.equal(exported.body.people[0].key, 'S01');
  const named = await call(f, 'GET', staff(f, '/api/staff/stats/export?names=1'));
  assert.match(named.headers['content-disposition'], /-prenoms\.json"$/);
  assert.equal(named.body.people[0].name, 'Alice');
  assert.ok(!named.text.includes(f.STAFF_KEY) && !named.text.includes(person.token));
});

test('synchronisation : envoi, passage sur scène, fin, causes d’attente et relevés notés dans le journal', async () => {
  const f = harness();
  f.journal.open({ rules: {} });
  f.sched.opts.requirePresence = true;
  const queue = [];
  const bridge = { ready: true, connected: true, queue, permissions: {}, status: { state: 'idle' }, calls: [],
    snapshot: () => ({ ready: true }), add(songId, singer) { this.calls.push(['add', songId, singer]); },
    remove(id) { this.calls.push(['remove', id]); }, next() {}, play() { this.calls.push(['play']); } };
  f.setBridge(bridge);
  const alice = await joinWithSong(f, '1', 'Alice', 301);
  f.settings.auto = true;
  f.settings.pushDelaySec = 0;
  f.sync();
  const evs = () => f.journal.read(f.journal.id).events;
  const last = type => evs().filter(e => e.ev === type).at(-1);
  // « Je suis là » demandé : la file attend la présence.
  assert.deepEqual(plain(last('presence.asked').personIds), [alice.personId]);
  assert.equal(last('karaoke.phase').blocker, 'awaiting-presence');
  const confirmed = await call(f, 'POST', '/api/table/confirm', { body: alice });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.ok(f.getPending(), 'envoi parti après la confirmation');
  assert.equal(last('karaoke.phase').blocker, 'sending');
  // KaraFun confirme l'ajout : passage envoyé, relevé de la file.
  queue.push({ queueId: 77, songId: 301, singer: f.getPending().sel.label, title: 'Titre 301' });
  f.sync();
  const sent = last('turn.sent');
  assert.equal(sent.queueId, 77);
  assert.deepEqual(plain(sent.ids), [alice.personId]);
  assert.ok(last('queue.sample'));
  assert.equal(last('karaoke.phase').blocker, 'autoplay-off');
  // Sur scène puis fin du titre.
  bridge.status = { state: 'playing', songPlaying: { queueId: 77 } };
  f.sync();
  const started = last('stage.started');
  assert.equal(started.source, 'queue');
  assert.equal(started.queueId, 77);
  assert.deepEqual(plain(started.ids), [alice.personId]);
  assert.equal(last('karaoke.phase').phase, 'singing');
  queue.splice(0);
  bridge.status = { state: 'idle' };
  f.sync();
  assert.equal(last('stage.ended').queueId, 77);
  assert.equal(last('karaoke.phase').blocker, 'empty');
  // Titres hors file : Battle et titre natif.
  queue.push({ queueId: 90, songId: 5, title: 'Battle', options: { mod: 'battle' } }, { queueId: 91, songId: 6, title: 'Natif', singer: 'Zoé · Table 9' });
  bridge.status = { state: 'playing', songPlaying: { queueId: 91 } };
  f.sync();
  assert.equal(last('stage.started').source, 'native');
  assert.ok(!JSON.stringify(evs()).includes('Zoé'), 'le nom affiché par KaraFun n’est pas noté');
  // KaraFun déconnecté : cause notée une fois.
  bridge.ready = false;
  f.sync(); f.sync();
  assert.equal(evs().filter(e => e.ev === 'karaoke.phase' && e.blocker === 'offline').length, 1);
  // Vue du bar sur la soirée en cours.
  const view = await call(f, 'GET', staff(f, '/api/staff/stats'));
  assert.equal(view.body.stats.global.ours, 1);
  assert.equal(view.body.stats.timeline.stages.length, 2);
  // Signe de vie d'un téléphone : au plus un toutes les 5 minutes.
  const person = f.sched.people.get(alice.personId);
  f.noteSeen(person); f.noteSeen(person);
  assert.equal(evs().filter(e => e.ev === 'person.seen').length, 1);
});

test('actions du bar notées : réglages, fermeture, départs, retour, transfert, Battle et Spotify', async () => {
  const f = harness();
  f.journal.open({ rules: {} });
  const alice = await joinWithSong(f, '1', 'Alice', 401);
  const bruno = await joinWithSong(f, '1', 'Bruno', 402);
  const evs = () => f.journal.read(f.journal.id).events;
  const has = (type, test = () => true) => evs().some(e => e.ev === type && test(e));
  const ok = async (route, body) => {
    const r = await call(f, 'POST', staff(f, route), { body });
    assert.equal(r.status, 200, `${route} : ${r.text}`);
    return r.body;
  };
  await ok('/api/staff/settings', { tableRotation: true, presenceGraceSec: 40 });
  assert.ok(has('settings.changed', e => e.setting === 'tableRotation' && e.from === false && e.to === true));
  assert.ok(has('settings.changed', e => e.setting === 'presenceGraceSec' && e.to === 40));
  await ok('/api/staff/closing', { time: '23:30' });
  await ok('/api/staff/closing', { extendMin: 10 });
  assert.ok(has('closing.set', e => e.deltaMin === 10));
  await ok('/api/staff/closing', { clear: true });
  assert.ok(has('closing.cleared'));
  const order = f.sched.presenceView().filter(v => !v.future).map(v => v.ids[0]);
  await ok('/api/staff/move', { personId: order[1], toIndex: 0, priority: true });
  assert.ok(has('staff.move', e => e.kind === 'priority' && e.from === 2 && e.to === 1));
  await ok('/api/staff/queue-recalculate', {});
  assert.ok(has('staff.recalculate'));
  await ok('/api/staff/person/leave', { personId: bruno.personId });
  assert.ok(has('person.left', e => e.by === 'staff' && e.personId === bruno.personId));
  await ok('/api/staff/person/reactivate', { personId: bruno.personId });
  assert.ok(has('person.reactivated'));
  await ok('/api/staff/queue-clear', { confirmation: 'VIDER TOUTES LES CHANSONS' });
  assert.ok(has('staff.queueCleared', e => e.songs === 1));
  // Le titre vidé n'est plus « en attente » dans les statistiques.
  const cleared = (await call(f, 'GET', staff(f, '/api/staff/stats'))).body.stats.singers.find(s => s.id === alice.personId);
  assert.equal(cleared.waiting, 0);
  assert.deepEqual(cleared.songs.map(s => [s.status, s.removedBy]), [['removed', 'staff']]);
  // Transfert vers un autre téléphone.
  const share = await call(f, 'POST', '/api/table/person/share', { body: alice });
  const claim = await call(f, 'POST', '/api/table/person/claim', { body: { table: alice.table, access: alice.access, personId: alice.personId, code: share.body.code } });
  assert.equal(claim.status, 200, claim.text);
  assert.ok(has('person.transferred'));
  // Ajout refusé à la fermeture : noté sans prénom.
  f.settings.closingAt = Date.now() - 60000;
  const refused = await call(f, 'POST', '/api/table/song', { body: { ...alice, token: claim.body.token, song: { songId: 403, title: 'Trop tard' } } });
  assert.equal(refused.status, 400);
  assert.ok(has('closing.refused', e => e.personId === alice.personId));
  f.settings.closingAt = null;
  // Battle : proposition, votes et décision, une seule fois chacun.
  f.battleVote.minVoters = 1;
  f.battleVote.propose({ personId: alice.personId, personName: 'Alice', eligiblePersonIds: [alice.personId, bruno.personId],
    songs: [{ songId: 7, title: 'Battle', artist: 'X' }] });
  f.battleVote.vote({ personId: bruno.personId, choice: 7 });
  assert.equal(evs().filter(e => e.ev === 'battle.proposed').length, 1);
  assert.equal(evs().filter(e => e.ev === 'battle.vote').length, 2);
  assert.ok(has('battle.decided', e => e.outcome === 'approved' && e.voters === 2 && e.yes === 2));
  f.battleVote.resolve({ outcome: 'dismissed' });
  assert.ok(has('battle.resolved', e => e.outcome === 'dismissed'));
  f.battleVote.endCooldownNow();
  assert.ok(has('battle.cooldownLifted'));
  f.battleVote.staffLaunch({ song: { songId: 8, title: 'Bar' } });
  assert.ok(has('battle.staffLaunch', e => e.title === 'Bar'));
  f.battleVote.updateAutomation('failed', 'essai');
  assert.ok(has('battle.automation', e => e.status === 'failed'));
  // Spotify relancé par l'automate puis lecture automatique suspendue.
  Object.defineProperty(f.spotify, 'connected', { value: true, configurable: true });
  f.spotify.resume = async () => 'done';
  f.spotify.config.autoResume = true;
  f.settings.autoPlay = true;
  f.setBridge({ ready: true, queue: [], status: { state: 'idle' }, permissions: {}, add() {}, remove() {}, play() {} });
  f.spotifyAutomation.step = () => 'resume';
  f.spotifyAutomation.settle = () => {};
  await f.spotifyTick();
  assert.ok(has('spotify', e => e.action === 'resume' && e.trigger === 'auto' && e.result === 'done'));
  assert.ok(has('autoplay.held'));
  f.spotify.resume = async () => { throw new Error('Spotify injoignable'); };
  await f.spotifyTick();
  assert.ok(has('spotify', e => e.result === 'error'));
  const text = JSON.stringify(evs());
  for (const name of ['Alice', 'Bruno']) assert.ok(!text.includes(name), name);
});

test('Battle : après un redémarrage, ni la proposition ni les votes ne sont notés deux fois', async () => {
  const voters = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  const battleFile = path.join(root, 'data', 'battle-vote.json');
  // Premier serveur : vote ouvert puis arrêt brutal ; second serveur sur le
  // même disque, soirée reprise et scrutin rechargé depuis data/battle-vote.json.
  const restart = (before, after) => {
    const f = harness({ persistent: true });
    f.journal.open({ rules: {} });
    f.battleVote.propose({ personId: 'p1', personName: 'Alice', eligiblePersonIds: voters,
      songs: [{ songId: 9001, title: 'Battle Un' }, { songId: 9002, title: 'Battle Deux' }] });
    before(f);
    const ballotId = f.battleVote.ballot.id;
    const saved = f.journal.snapshot();
    const g = harness({ persistent: true, memory: f.memory });
    assert.equal(g.journal.open({ resume: saved }), true, 'même soirée');
    assert.equal(g.battleVote.ballot.id, ballotId, 'scrutin rechargé');
    after(g);
    const rows = lines(g.memory.read(`data/soirees/${saved.id}/journal.jsonl`)).filter(e => e.ballotId === ballotId);
    const count = ev => rows.filter(e => e.ev === ev).length;
    return { g, rows, count, votes: rows.filter(e => e.ev === 'battle.vote').map(e => e.voterId) };
  };
  // Vote après le redémarrage.
  let r = restart(f => f.battleVote.vote({ personId: 'p2', choice: 9001 }), g => g.battleVote.vote({ personId: 'p3', choice: 'none' }));
  assert.equal(r.count('battle.proposed'), 1);
  assert.deepEqual(r.votes, ['p1', 'p2', 'p3'], 'chaque votant une seule fois');
  const stats = (await call(r.g, 'GET', staff(r.g, '/api/staff/stats'))).body.stats;
  assert.equal(stats.global.battle.proposals, 1);
  assert.equal(stats.global.battle.votes, 3);
  assert.deepEqual(stats.singers.map(s => [s.id, s.battleProposals, s.battleVotes]),
    [['p1', 1, 1], ['p2', 0, 1], ['p3', 0, 1]]);
  // Vote arrivé à échéance pendant l'arrêt : décision au redémarrage.
  r = restart(f => {
    f.battleVote.vote({ personId: 'p2', choice: 9001 });
    const file = JSON.parse(f.memory.disk.get(battleFile));
    file.ballot.closesAt = Date.now() - 1000;
    f.memory.disk.set(battleFile, JSON.stringify(file));
  }, g => g.battleVote.tick());
  assert.equal(r.count('battle.proposed'), 1);
  assert.deepEqual(r.votes, ['p1', 'p2']);
  assert.deepEqual(r.rows.filter(e => e.ev === 'battle.decided').map(e => e.outcome), ['quorum']);
  // Battle déjà demandée avant l'arrêt, écartée par le bar après.
  r = restart(f => { for (const id of voters.slice(1)) f.battleVote.vote({ personId: id, choice: 9002 }); },
    g => g.battleVote.resolve({ outcome: 'dismissed' }));
  assert.equal(r.count('battle.proposed'), 1);
  assert.deepEqual(r.votes, voters);
  assert.equal(r.count('battle.decided'), 1);
  assert.equal(r.count('battle.resolved'), 1);
});

// Regression: retours du bar — une personne arrivée après l'ouverture du
// vote Battle vote aussi. Son admission n'ajoute rien au journal ; son vote
// y est noté une fois et la décision donne l'électorat final, même après
// un redémarrage.
test('Battle : électorat agrandi pendant le vote, au journal et après un redémarrage', async () => {
  const battleFile = path.join(root, 'data', 'battle-vote.json');
  const f = harness({ persistent: true });
  f.journal.open({ rules: {} });
  f.battleVote.propose({ personId: 'p1', personName: 'Alice', eligiblePersonIds: ['p1', 'p2', 'p3', 'p4', 'p5'],
    songs: [{ songId: 9101, title: 'Battle Un' }, { songId: 9102, title: 'Battle Deux' }] });
  const ballotId = f.battleVote.ballot.id;
  const count = () => f.journal.read(f.journal.id).events.filter(e => e.ballotId === ballotId).length;
  const before = count();
  assert.equal(f.battleVote.admit(['p1', 'p6']), true);
  assert.equal(count(), before, 'l’admission seule n’ajoute rien au journal');
  assert.deepEqual(JSON.parse(f.memory.disk.get(battleFile)).ballot.eligiblePersonIds, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'],
    'électorat agrandi enregistré sur le disque');
  f.battleVote.vote({ personId: 'p6', choice: 9102 });
  const saved = f.journal.snapshot();
  const g = harness({ persistent: true, memory: f.memory });
  assert.equal(g.journal.open({ resume: saved }), true);
  assert.equal(g.battleVote.view().eligible, 6, 'électorat agrandi rechargé');
  for (const id of ['p2', 'p3', 'p4', 'p5']) g.battleVote.vote({ personId: id, choice: 9102 });
  assert.equal(g.battleVote.view().phase, 'requested', 'tout l’électorat agrandi a voté : clôture');
  const rows = lines(g.memory.read(`data/soirees/${saved.id}/journal.jsonl`)).filter(e => e.ballotId === ballotId);
  assert.equal(rows.filter(e => e.ev === 'battle.proposed').length, 1);
  assert.deepEqual(rows.filter(e => e.ev === 'battle.proposed').map(e => e.eligible), [5], 'électorat à l’ouverture');
  assert.deepEqual(rows.filter(e => e.ev === 'battle.vote').map(e => e.voterId), ['p1', 'p6', 'p2', 'p3', 'p4', 'p5'],
    'chaque votant une fois, arrivée comprise');
  assert.deepEqual(rows.filter(e => e.ev === 'battle.decided').map(e => [e.outcome, e.voters, e.eligible, e.closedBy]),
    [['approved', 6, 6, 'all-voted']], 'la décision donne l’électorat final');
  const stats = (await call(g, 'GET', staff(g, '/api/staff/stats'))).body.stats;
  assert.equal(stats.global.battle.votes, 6);
  // Le déroulé de la page des statistiques garde les deux nombres : à
  // l'ouverture (5) et à la clôture (6), pour ne jamais montrer plus de voix
  // que de votants possibles.
  assert.deepEqual(stats.timeline.battles.filter(x => x.ballotId === ballotId).map(x => [x.kind, x.eligible, x.voters ?? null]),
    [['proposed', 5, null], ['decided', 6, 6]], 'électorat final dans le déroulé');
});

test('titre passé dans KaraFun avant d’être chanté, commandes du bar et fermeture atteinte', async () => {
  const f = harness();
  f.journal.open({ rules: {} });
  const queue = [];
  const bridge = { ready: true, connected: true, queue, permissions: {}, status: { state: 'idle' }, calls: [],
    snapshot: () => ({ ready: true }), add(songId, singer) { this.calls.push(['add', songId, singer]); },
    remove(id) { this.calls.push(['remove', id]); }, next() { this.calls.push(['next']); }, play() { this.calls.push(['play']); } };
  f.setBridge(bridge);
  const evs = () => f.journal.read(f.journal.id).events;
  const last = type => evs().filter(e => e.ev === type).at(-1);
  await joinWithSong(f, '1', 'Alice', 501);
  await joinWithSong(f, '2', 'Bruno', 502);
  f.settings.auto = true;
  f.settings.pushDelaySec = 0;
  f.sync();
  queue.push({ queueId: 61, songId: f.getPending().sel.song.songId, singer: f.getPending().sel.label });
  f.sync();
  const sent = last('turn.sent');
  // Le titre disparaît de KaraFun sans avoir été lancé.
  queue.splice(0);
  f.sync();
  assert.equal(last('turn.unsent').reason, 'skipped-in-karafun');
  assert.equal(last('turn.unsent').entryId, sent.entryId);
  // Ajout sans confirmation : signalé.
  const pending = { sel: f.sched.select(), before: new Set(), at: Date.now() - 20000, attempts: 1 };
  f.setPending(pending);
  f.sync();
  assert.equal(last('send.unconfirmed').entryId, pending.sel.song.entryId);
  // Commandes « Suivant » et « Lecture » du bar.
  const next = await call(f, 'POST', staff(f, '/api/staff/kf'), { body: { action: 'next' } });
  assert.equal(next.status, 200, next.text);
  assert.ok(last('staff.next'));
  const play = await call(f, 'POST', staff(f, '/api/staff/kf'), { body: { action: 'play' } });
  assert.equal(play.status, 200, play.text);
  assert.ok(last('staff.play'));
  // Spotify relancé par le bar.
  f.spotify.resume = async () => 'done';
  const spotify = await call(f, 'POST', staff(f, '/api/staff/spotify'), { body: { action: 'play' } });
  assert.equal(spotify.status, 200, spotify.text);
  assert.equal(last('spotify').trigger, 'staff');
  assert.equal(last('karaoke.phase').blocker, 'recovered-pending');
  // Journal pas encore ouvert : la page le dit au lieu d'échouer.
  const g = harness();
  assert.equal((await call(g, 'GET', staff(g, '/api/staff/stats'))).status, 404);
});

test('heure de fermeture atteinte avec des titres prêts : notée une seule fois', async () => {
  const f = harness();
  f.journal.open({ rules: {} });
  f.setBridge({ ready: true, connected: true, queue: [], permissions: {}, status: { state: 'idle' },
    snapshot: () => ({}), add() {}, remove() {}, next() {}, play() {} });
  await joinWithSong(f, '1', 'Alice', 601);
  f.settings.auto = true;
  f.settings.closingAt = Date.now() - 60000;
  f.sync(); f.sync();
  const events = f.journal.read(f.journal.id).events;
  assert.equal(events.filter(e => e.ev === 'closing.reached').length, 1);
  assert.equal(events.filter(e => e.ev === 'karaoke.phase').at(-1).blocker, 'closing');
});

test('signes de vie des téléphones, lecture automatique rétablie et absent à l’appel', async () => {
  const f = harness();
  f.journal.open({ rules: {} });
  const alice = await joinWithSong(f, '1', 'Alice', 701);
  const bruno = await joinWithSong(f, '1', 'Bruno', 702);
  const evs = () => f.journal.read(f.journal.id).events;
  // Un téléphone qui gère deux personnes : chacune donne signe de vie.
  const url = `/api/state?table=1&access=${alice.access}&token=${alice.token}&token=${bruno.token}`;
  assert.equal((await call(f, 'GET', url)).status, 200);
  assert.deepEqual(evs().filter(e => e.ev === 'person.seen').map(e => e.personId).sort(), [alice.personId, bruno.personId].sort());
  const other = await joinWithSong(f, '2', 'Chloé', 703);
  assert.equal((await call(f, 'GET', `/api/state?token=${other.token}`)).status, 200);
  assert.ok(evs().some(e => e.ev === 'person.seen' && e.personId === other.personId));
  // Un titre démarre pendant que la lecture automatique est suspendue.
  const queue = [{ queueId: 81, songId: 9, title: 'Natif' }];
  const bridge = { ready: true, connected: true, queue, permissions: {}, status: { state: 'playing', songPlaying: { queueId: 81 } },
    snapshot: () => ({}), add() {}, remove() {}, next() {}, play() {} };
  f.setBridge(bridge);
  f.settings.autoPlayHeld = true;
  f.sync();
  assert.ok(evs().some(e => e.ev === 'autoplay.released'));
  // Absent à l'appel : le bar retire le titre suivant.
  const sel = f.sched.select();
  f.sched.commit(sel);
  f.getTracked().push({ queueId: 82, sel, addedAt: Date.now(), startedAt: null });
  queue.push({ queueId: 82, songId: sel.song.songId, singer: sel.label });
  const absent = await call(f, 'POST', staff(f, '/api/staff/kf'), { body: { action: 'absent', queueId: 82 } });
  assert.equal(absent.status, 200, absent.text);
  assert.ok(evs().some(e => e.ev === 'staff.absent' && e.entryId === sel.song.entryId));
});

// Regression: relecture PR #11 — evening.started de la nouvelle soirée notait
// la lecture et l'envoi automatiques de la soirée précédente.
test('« Nouvelle soirée » : les règles notées au début sont celles qui s’appliquent', async () => {
  for (const [auto, sending] of [[true, true], [false, false]]) {
    const f = harness({ persistent: true });
    f.journal.open({ rules: {} });
    f.settings.auto = auto;
    f.settings.autoPlay = true;
    if (sending) f.setPending({ sel: { ids: [], song: { songId: 1, title: 'x', entryId: 'e' }, label: 'x' }, before: new Set(), at: Date.now(), attempts: 1 });
    const reset = await call(f, 'POST', staff(f, '/api/staff/tables-clear'), { body: { confirmation: 'SUPPRIMER TOUTES LES TABLES' } });
    assert.equal(reset.status, 200, reset.text);
    assert.equal(reset.body.autoStopped, sending);
    const started = f.journal.current.events.find(e => e.ev === 'evening.started');
    assert.deepEqual({ auto: started.rules.auto, autoPlay: started.rules.autoPlay }, { auto: f.settings.auto, autoPlay: false });
    assert.equal(f.settings.auto, auto && !sending);
  }
});
