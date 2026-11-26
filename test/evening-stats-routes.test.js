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
const { disqueMemoire } = require('./disque-memoire');
// Copie de withoutKaraoke (fuseau.test.js:21, qui n'exporte rien : l'importer
// lancerait ses essais).
const withoutKaraoke = env => Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('KARAOKE_')));

// Disque du harnais (plan du 8 novembre, A7, « Disque ») : data/ et journal/
// en mémoire (test/disque-memoire.js), avec les onze méthodes de la
// réparation ; toute autre méthode de fs y lève « méthode non simulée : … »
// au lieu d'atteindre le vrai disque ; les autres chemins (pages,
// package.json) vont au vrai disque. `read`, `files` et `disk` gardent la
// forme d'avant (chemins absolus pour `disk`) ; `depuis` : relevé d'un disque.
function memoryDisk(depuis = null) {
  const d = disqueMemoire({ racine: root, enMemoire: ['data', 'journal'], depuis });
  const rel = file => path.relative(root, file).split(path.sep).join('/');
  return Object.assign(d, { memFs: d.fs, read: d.lire, files: () => d.fichiers(),
    disk: { get: file => d.lire(rel(file)), set: (file, data) => d.ecrire(rel(file), data), has: file => d.existe(rel(file)) } });
}

// `memory` : disque d'un serveur précédent, pour simuler un redémarrage, et
// `loaded` : la sauvegarde de soirée que NightStateStore.load() rend alors
// (sa dernière sauvegarde, `saves.at(-1)`). `env` : variables que l'essai pose
// lui-même (KARAOKE_REPAIR), sur un environnement sans KARAOKE_* (A7,
// « Environnement et fuseau »). Le journal du serveur est capté (`logged`) ;
// process.exit est noté (`exits`), jamais appelé.
function harness({ persistent = false, memory = memoryDisk(), loaded = null, env = {} } = {}) {
  const entry = source.lastIndexOf('main().catch(');
  const saves = [];
  const night = { fail: null };
  const overrides = persistent ? {
    './night-state': { ...fromServer('./night-state'), NightStateStore: class {
      load() { return loaded ? JSON.parse(JSON.stringify(loaded)) : null; }
      save(snapshot) { if (night.fail) throw new Error(night.fail); saves.push(JSON.parse(JSON.stringify(snapshot))); return true; }
    } },
    './scheduler': (() => {
      const real = fromServer('./scheduler');
      return { ...real, Scheduler: class extends real.Scheduler { constructor(o) { super({ ...o, solverEnabled: false }); } } };
    })(),
    './spotify': (() => {
      const real = fromServer('./spotify');
      return { ...real, SpotifyLink: class extends real.SpotifyLink { constructor(o) { super({ ...o, file: null }); } } };
    })(),
    // Comme chaque essai du disque en mémoire : platform linux, car le job
    // Windows de la CI lance toute la suite (A7, réparation sous Windows).
    './evening-journal': (() => {
      const real = fromServer('./evening-journal');
      return { ...real, EveningJournal: class extends real.EveningJournal { constructor(o) { super({ ...o, platform: 'linux' }); } } };
    })(),
  } : {};
  const logged = [];
  const exits = [];
  const fixtureProcess = Object.create(process);
  fixtureProcess.env = { ...withoutKaraoke(process.env), ...env };
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), ...(persistent ? [] : ['--demo'])];
  fixtureProcess.exit = code => { exits.push(code); };
  const context = { require: name => name === 'fs' ? memory.memFs : overrides[name] || fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log(line) { logged.push(String(line)); } }, Buffer, URL, setTimeout, clearTimeout,
    setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, journal, settings, access, battleVote, spotify, spotifyAutomation, sync, staffState, clearEvening,
      journalEvent, journalRoster, journalSample, noteSeen, spotifyTick, serverUpdate, STAFF_KEY, PORT, PUBLIC_PORT,
      startNight: typeof startNight === 'function' ? startNight : undefined,
      repairClosedEvenings: typeof repairClosedEvenings === 'function' ? repairClosedEvenings : undefined,
      startupRepair: () => (typeof startupRepair === 'undefined' ? undefined : startupRepair),
      handle: server.listeners('request')[0], getTracked: () => tracked, getPending: () => pending,
      setBridge: b => { bridge = b; }, setPending: p => { pending = p; } };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  return Object.assign(f, { memory, saves, night, logged, exits });
}

function call(f, method, url, { body, port = f.PORT, headers = {} } = {}) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers, socket: { remoteAddress: '127.0.0.1', localPort: port }, destroy() {} });
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
  // Nom tiré de l'ouverture de la soirée (A5) : sa date et son heure, puis
  // la fin de son identifiant.
  assert.match(exported.headers['content-disposition'], new RegExp(`^attachment; filename="soiree-\\d{4}-\\d{2}-\\d{2}_\\d{4}_${f.journal.id.slice(-4)}\\.json"$`));
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
  // Heure à venir quelle que soit l'heure du lancement : passée (« 23:30 »
  // lancé à 23:36), la fermeture décalée repartirait de maintenant.
  const soon = new Date(Date.now() + 2 * 3600000);
  await ok('/api/staff/closing', { time: `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}` });
  await ok('/api/staff/closing', { extendMin: 10 });
  assert.ok(has('closing.set', e => e.deltaMin === 10));
  await ok('/api/staff/closing', { clear: true });
  assert.ok(has('closing.cleared', e => e.reason === undefined), 'retrait par le bar : sans motif');
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
  // Ajout après l'heure de fermeture : accepté, plus aucun refus noté.
  f.settings.closingAt = Date.now() - 60000;
  const late = await call(f, 'POST', '/api/table/song', { body: { ...alice, token: claim.body.token, song: { songId: 403, title: 'Tard' } } });
  assert.equal(late.status, 200, late.text);
  assert.ok(!has('closing.refused'));
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
  // « Options par défaut » : retrait de l'heure noté comme tel (les statistiques gardent l'heure).
  await ok('/api/staff/closing', { time: `${String(soon.getHours()).padStart(2, '0')}:${String(soon.getMinutes()).padStart(2, '0')}` });
  await ok('/api/staff/settings-reset', { confirmation: 'OPTIONS PAR DÉFAUT' });
  assert.equal(f.settings.closingAt, null);
  assert.ok(has('closing.cleared', e => e.reason === 'settings-reset'));
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
  // Soirée du 10 octobre : des pages restées ouvertes en arrière-plan ont
  // noté des signes de vie jusqu'au lendemain midi. Page cachée : rien.
  const hidden = { headers: { 'x-page-visible': '0' } };
  assert.equal((await call(f, 'GET', `/api/state?token=${other.token}`, hidden)).status, 200);
  assert.ok(!evs().some(e => e.ev === 'person.seen' && e.personId === other.personId), 'page cachée : pas de signe de vie');
  const dan = await joinWithSong(f, '1', 'Dan', 704);
  assert.equal((await call(f, 'GET', `/api/state?table=1&access=${alice.access}&token=${dan.token}`, hidden)).status, 200);
  assert.ok(!evs().some(e => e.ev === 'person.seen' && e.personId === dan.personId), 'page de table cachée : pas de signe de vie');
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

// Liste des soirées et export (plan du 8 novembre, A5) : l'ouverture de
// chaque soirée (meta.karaoke.openedAt, sinon celle de son summary.json pour
// une archive encore sans karaoke, sinon startedAt ; la soirée en cours : sa
// première activité), triée, avec l'état de data/soirees/.bornage.json et la
// marque d'une soirée découpée ; le nom des fichiers exportés prend la même
// ouverture, au fuseau de la soirée.
test('A5 : /api/staff/stats/evenings : ouverture (meta.karaoke, summary.json, startedAt), tri, état de .bornage.json (retry, failed) et soirée découpée ; « Supprimer toutes les tables » écrit karaoke et closedBy (staff-reset) ; nom d’export à l’ouverture, au fuseau de la soirée, -prenoms gardé, « Ce soir » à sa première activité et non à la création de son journal ; /api/staff/stats donne closedBy ; une archive dont un champ de meta.json est mal formé s’ouvre et s’exporte encore', async () => {
  const { exportFileName } = require('../evening-journal');
  const f = harness({ persistent: true });
  // « Ce soir » : journal créé à la remise à zéro du matin, douze heures avant
  // sa première activité (KaraFun resté connecté). Son ouverture, et le nom de
  // son export, sont à cette activité, jamais à la création du journal (A7).
  const clock = f.journal.now;
  f.journal.now = () => clock() - 12 * 3600000;
  f.journal.open({ rules: {} });
  f.journal.now = clock;
  const P = text => Date.parse(`${text}:00+01:00`);
  const put = (id, name, data) => f.memory.disk.set(path.join(root, 'data', 'soirees', id, name), typeof data === 'string' ? data : JSON.stringify(data));
  const evening = (id, startedAt, extra = {}) => ({ format: 'karaoke-evening-meta', version: 1, eveningId: id, startedAt, endedAt: startedAt + 20 * 3600000,
    timezone: 'Europe/Paris', roster: { p1: { name: 'Léa', tableId: '1' } }, tables: { 1: { name: 'Table 1', individual: false } }, ...extra });
  const ids = { auto: '2026-11-06_0800_aaaa', old: '2026-11-01_1900_bbbb', failed: '2026-10-30_1900_cccc', retry: '2026-10-29_1900_dddd',
    piece: '2026-10-28_1900_eeee', bad: '2026-10-27_1900_ffff' };
  const closedLine = (t, fields) => JSON.stringify({ v: 1, seq: 2, t, ev: 'evening.closed', boot: 'b', ...fields }) + '\n';
  const started = t => JSON.stringify({ v: 1, seq: 1, t, ev: 'evening.started', boot: 'b', rules: {} }) + '\n';
  // Close d'office le 7 novembre à 8 h, karaoké le 6 de 20:40 à 01:55.
  put(ids.auto, 'meta.json', evening(ids.auto, P('2026-11-06T08:00'), { endedAt: P('2026-11-07T08:00'),
    karaoke: { openedAt: P('2026-11-06T20:40'), closedAt: P('2026-11-07T01:55') }, closedBy: 'auto' }));
  put(ids.auto, 'journal.jsonl', started(P('2026-11-06T08:00')) + closedLine(P('2026-11-07T08:00'), { by: 'auto', reason: 'morning', closedAt: P('2026-11-07T08:00') }));
  // Ancienne archive, sans karaoke : l'ouverture de son résumé.
  put(ids.old, 'meta.json', evening(ids.old, P('2026-11-01T19:00')));
  put(ids.old, 'journal.jsonl', started(P('2026-11-01T19:00')) + closedLine(P('2026-11-02T15:00'), { by: 'staff-reset' }));
  put(ids.old, 'summary.json', { format: 'karaoke-evening-stats', evening: { openedAt: P('2026-11-01T21:10'), closedAt: null } });
  for (const id of [ids.failed, ids.retry]) {
    put(id, 'meta.json', evening(id, P(`2026-10-${id.slice(8, 10)}T19:00`)));
    put(id, 'journal.jsonl', started(P(`2026-10-${id.slice(8, 10)}T19:00`)));
  }
  put(ids.piece, 'meta.json', evening(ids.piece, P('2026-10-28T19:00'), { karaoke: { openedAt: P('2026-10-28T21:00'), closedAt: null }, closedBy: 'auto',
    split: { from: '2026-10-20_1900_9999', part: 1, generation: 1, rule: 'v1' } }));
  put(ids.piece, 'journal.jsonl', started(P('2026-10-28T19:00')));
  // Champ mal formé (startedAt en texte, que computeStats tolère).
  put(ids.bad, 'meta.json', { ...evening(ids.bad, 0), startedAt: 'pas une heure' });
  put(ids.bad, 'journal.jsonl', started(P('2026-10-27T19:00')));
  put('', '.bornage.json', { rule: 'v1', checked: { [ids.auto]: 'ok', [ids.old]: 'ok', [ids.piece]: 'ok',
    [ids.failed]: { status: 'failed', attempts: 1, code: 'BAD_JSON', version: 'v3.5.0' }, [ids.retry]: { status: 'retry', attempts: 1, code: 'EBUSY', version: 'v3.5.0' } } });
  const alice = await joinWithSong(f, '1', 'Alice', 801);
  const firstActivity = f.journal.read(f.journal.id).events.find(e => e.ev === 'person.joined' || e.ev === 'song.requested' || e.ev === 'table.opened').t;

  const list = await call(f, 'GET', staff(f, '/api/staff/stats/evenings'));
  assert.equal(list.status, 200);
  const rows = list.body.evenings;
  assert.deepEqual(rows.map(row => row.id), [f.journal.id, ids.auto, ids.old, ids.failed, ids.retry, ids.piece, ids.bad], 'tri par ouverture');
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.deepEqual([byId.get(f.journal.id).openedAt, byId.get(ids.auto).openedAt, byId.get(ids.old).openedAt, byId.get(ids.failed).openedAt],
    [firstActivity, P('2026-11-06T20:40'), P('2026-11-01T21:10'), P('2026-10-30T19:00')]);
  assert.equal(byId.get(ids.bad).openedAt, null);
  assert.deepEqual(rows.map(row => [row.repair, row.split]), [[null, false], ['ok', false], ['ok', false], ['failed', false], ['retry', false],
    ['ok', true], [null, false]]);
  // Le nom du fichier exporté prend l'ouverture, au fuseau de la soirée.
  const name = async (id, names = false) => (await call(f, 'GET', staff(f, `/api/staff/stats/export?evening=${id}${names ? '&names=1' : ''}`))).headers['content-disposition'];
  assert.equal(await name(ids.auto), 'attachment; filename="soiree-2026-11-06_2040_aaaa.json"');
  assert.equal(await name(ids.auto, true), 'attachment; filename="soiree-2026-11-06_2040_aaaa-prenoms.json"');
  assert.equal(await name(ids.old), 'attachment; filename="soiree-2026-11-01_2110_bbbb.json"');
  const tonight = await name('current');
  assert.equal(tonight, `attachment; filename="${exportFileName({ id: f.journal.id, openedAt: firstActivity, timeZone: f.journal.current.meta.timezone })}"`);
  assert.notEqual(tonight, `attachment; filename="soiree-${f.journal.id}.json"`, '« Ce soir » : pas l’heure de création du journal');
  // Archive au champ mal formé : elle s'ouvre et s'exporte encore, au nom de
  // son identifiant.
  const bad = await call(f, 'GET', staff(f, `/api/staff/stats?evening=${ids.bad}`));
  assert.equal(bad.status, 200);
  const badExport = await call(f, 'GET', staff(f, `/api/staff/stats/export?evening=${ids.bad}`));
  assert.equal(badExport.status, 200);
  assert.equal(badExport.headers['content-disposition'], `attachment; filename="soiree-${ids.bad}.json"`);
  // closedBy de la soirée choisie : meta.closedBy, sinon le by de sa ligne
  // evening.closed ; la fin de la soirée, C.
  const auto = await call(f, 'GET', staff(f, `/api/staff/stats?evening=${ids.auto}`));
  assert.deepEqual([auto.body.evening.closedBy, auto.body.evening.endedAt], ['auto', P('2026-11-07T08:00')]);
  assert.equal((await call(f, 'GET', staff(f, `/api/staff/stats?evening=${ids.old}`))).body.evening.closedBy, 'staff-reset');
  assert.equal((await call(f, 'GET', staff(f, '/api/staff/stats'))).body.evening.closedBy, null, 'soirée en cours');
  // « Supprimer toutes les tables » : karaoke et closedBy dans meta.json.
  const oldId = f.journal.id;
  const reset = await call(f, 'POST', staff(f, '/api/staff/tables-clear'), { body: { confirmation: 'SUPPRIMER TOUTES LES TABLES' } });
  assert.equal(reset.status, 200, reset.text);
  const meta = JSON.parse(f.memory.read(`data/soirees/${oldId}/meta.json`));
  const summary = JSON.parse(f.memory.read(`data/soirees/${oldId}/summary.json`));
  assert.equal(meta.closedBy, 'staff-reset');
  assert.deepEqual(meta.karaoke, { openedAt: Math.max(summary.evening.openedAt, firstActivity), closedAt: summary.evening.closedAt ?? null });
  assert.ok(alice.personId);
});

// ------------------------------------------------------------------ démarrage et réparation (A3, A4)
// Soirées du disque en mémoire. Journal mêlé de plusieurs nuits de karaoké à
// Paris (A4) : la nuit k commence `debut` + k jours, à sa table ; ses
// `inscrits` s'inscrivent, puis chacun de ses `chanteurs` demande et chante
// un titre ; un matin calme sépare deux nuits (coupure à 8 h). `close` : close
// par le bar 5 min après sa dernière ligne.
const MIN = 60000, DAY = 24 * 60 * MIN;
const PARIS = 'Europe/Paris';
const NUIT_1 = Date.parse('2026-10-20T20:00:00+02:00');
function soireeMelee({ id, nuits, debut = NUIT_1, close = false, noms = {} }) {
  const events = [];
  const add = (t, ev, fields, boot) => events.push({ ...fields, v: 1, seq: events.length + 1, t, ev, boot });
  add(debut - 30 * MIN, 'evening.started', { rules: {} }, 'nuit-1');
  nuits.forEach((nuit, k) => {
    const t0 = debut + k * DAY, boot = `nuit-${k + 1}`;
    if (nuit.ouverte !== true) add(t0, 'table.opened', { tableId: nuit.table, individual: false }, boot);
    (nuit.inscrits || []).forEach((pid, i) => add(t0 + (i + 1) * MIN, 'person.joined', { personId: pid, tableId: nuit.table }, boot));
    (nuit.chanteurs || []).forEach((pid, s) => {
      const ts = t0 + (10 + 30 * s) * MIN, entryId = `e${k}-${s}`;
      add(ts - 5 * MIN, 'song.requested', { personId: pid, entryId, songId: 100 + s, title: `Titre ${s}` }, boot);
      add(ts, 'stage.started', { queueId: k * 10 + s + 1, ids: [pid], ownerId: pid, entryId, durationSec: 200 }, boot);
      add(ts + 4 * MIN, 'stage.ended', { queueId: k * 10 + s + 1, playedSec: 240 }, boot);
    });
  });
  let endedAt = null;
  if (close) { endedAt = events.at(-1).t + 5 * MIN; add(endedAt, 'evening.closed', { by: 'staff-reset' }, `nuit-${nuits.length}`); }
  const roster = {}, tables = {};
  for (const nuit of nuits) {
    tables[nuit.table] = { name: `Table ${nuit.table}`, individual: false };
    for (const pid of [...(nuit.inscrits || []), ...(nuit.chanteurs || [])]) roster[pid] = { name: noms[pid] || `Prénom ${pid}`, tableId: nuit.table };
  }
  return { meta: { format: 'karaoke-evening-meta', version: 1, eveningId: id, startedAt: debut - 30 * MIN, endedAt,
    app: { version: 'v3.5.0', commit: null }, timezone: PARIS, roster, tables }, events };
}
const texte = events => events.map(e => JSON.stringify(e)).join('\n') + '\n';
function poser(memory, id, { meta, events }) {
  memory.ecrire(`data/soirees/${id}/meta.json`, JSON.stringify(meta, null, 1));
  memory.ecrire(`data/soirees/${id}/journal.jsonl`, texte(events));
}
const archiveMelee = (memory, id) => poser(memory, id, soireeMelee({ id, close: true,
  nuits: [{ table: '1', inscrits: ['a1', 'b1'], chanteurs: ['a1', 'b1'] }, { table: '2', inscrits: ['a2'], chanteurs: ['a2'] }] }));
const lireJson = (memory, rel) => JSON.parse(memory.lire(rel));
const eveningLines = (memory, id) => lines(memory.lire(`data/soirees/${id}/journal.jsonl`));
// Lignes du journal du serveur écrites par appLog, sans leur heure.
const serverLog = f => [...f.memory.contenus('journal')].filter(([rel]) => /^journal\/serveur-.*\.log$/.test(rel))
  .flatMap(([, text]) => text.split('\n').filter(Boolean).map(line => line.slice(line.indexOf(' ') + 1)));
const ACTIVE = 'Réparation des soirées : active.';
const COUPEE = 'Réparation des soirées : coupée (KARAOKE_REPAIR=off). La remise à zéro du matin reste. Pour la rallumer, retire KARAOKE_REPAIR (DEPLOIEMENT-SERVEUR §18, « Couper la réparation »).';
const prudence = value => `Réparation des soirées : coupée par prudence, KARAOKE_REPAIR="${value}" non reconnue (attendu : off). Corrige la valeur, ou retire-la pour rallumer la réparation (DEPLOIEMENT-SERVEUR §18, « Couper la réparation »).`;
const FIN = /^Réparation des soirées closes terminée : (\d+) vérifiées, (\d+) découpées, (\d+) en échec, (\d+) à refaire ; en \d+ ms\.$/;
const notesOf = f => f.sched.log.map(entry => entry.msg);
const REPAIR_NOTE = 'Au démarrage, la soirée précédente n’a pas pu être séparée de celle-ci : elle est peut-être encore là. ' +
  'Envoi automatique coupé : vérifie la file, puis « Supprimer toutes les tables » si la soirée précédente est encore là. Préviens le mainteneur.';
const turn = () => new Promise(resolve => setImmediate(resolve));
// Attend `ready()`, en cédant la main entre deux essais ; jamais un délai fixe.
async function until(ready, label, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`${label} : rien après ${ms} ms`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// Premier démarrage d'une copie neuve : soirée ouverte, puis « Alice » et
// « Bruno » inscrits à la table 1 ; rend le harnais et leurs identifiants.
async function firstNight(options = {}) {
  const f = harness({ persistent: true, ...options });
  f.startNight();
  const alice = await joinWithSong(f, '1', 'Alice', 101);
  const bruno = await joinWithSong(f, '1', 'Bruno', 102);
  return { f, pA: alice.personId, pB: bruno.personId };
}

test('A3 : startNight() répare la soirée en cours avant journal.open : soirée de deux nuits sauvegardée, premier morceau archivé, la soirée reprise à son dernier morceau, un seul app.started, résultat gardé pour la vérification de démarrage', async () => {
  const { f, pA, pB } = await firstNight();
  const id = f.journal.id;
  assert.equal(f.saves.at(-1).evening.id, id, 'la sauvegarde désigne la soirée en cours');
  poser(f.memory, id, soireeMelee({ id, nuits: [{ table: '1', inscrits: [pA, pB], chanteurs: [pA, pB] },
    { table: '1', ouverte: true, chanteurs: [pB] }], noms: { [pA]: 'Alice', [pB]: 'Bruno' } }));
  const loaded = f.saves.at(-1);
  loaded.settings.auto = true;
  const g = harness({ persistent: true, memory: f.memory, loaded });
  // Le journal du serveur est celui de f (même disque) : seules les lignes
  // de ce démarrage jugent l'ordre.
  const start = serverLog(f).length;
  g.startNight();
  assert.equal(g.journal.id, id, 'dernier morceau : l’identifiant d’origine, pointé par la sauvegarde');
  const meta = g.journal.current.meta;
  assert.equal(meta.split?.part, 2);
  const previous = meta.split.previous;
  assert.ok(previous && previous !== id, 'morceau archivé nommé');
  const archived = lireJson(g.memory, `data/soirees/${previous}/meta.json`);
  assert.equal(archived.split.part, 1);
  assert.equal(eveningLines(g.memory, previous).at(-1).ev, 'evening.closed');
  // journal.open après la réparation : un seul app.started de ce démarrage,
  // après les lignes reportées du morceau en cours.
  const events = g.journal.current.events;
  const started = events.filter(e => e.ev === 'app.started' && e.boot === g.journal.boot);
  assert.equal(started.length, 1);
  assert.equal(started[0].restored, true);
  assert.ok(events.indexOf(started[0]) > events.findLastIndex(e => e.carried === true), 'reprise notée après les lignes reportées');
  const r = g.startupRepair();
  assert.equal(r.status, 'split');
  assert.equal(r.current, true);
  assert.equal(r.previous.id, previous);
  assert.equal(r.previous.cut, meta.split.cut);
  assert.equal(g.settings.auto, true, 'découpage réussi : l’envoi n’est pas coupé par la réparation');
  const log = serverLog(g).slice(start);
  const at = text => log.findIndex(line => line.startsWith(text));
  assert.ok(at(ACTIVE) >= 0 && at(ACTIVE) < at(`Réparation : ${id} découpée en 2 morceaux`), log.join('\n'));
  assert.ok(at(`Réparation : ${id} découpée en 2 morceaux`) < at('Soirée restaurée :'), log.join('\n'));
  // Sans sauvegarde (installation neuve) : rien à réparer.
  const fresh = harness({ persistent: true });
  fresh.startNight();
  assert.equal(fresh.startupRepair(), null);
  assert.ok(serverLog(fresh).includes(ACTIVE));
});

test('A4 : soirée en cours en échec au démarrage (journal d’origine impossible à réécrire, EIO) : ouverte telle quelle, envoi automatique coupé, une note au bar, retry noté, la file démarre', async () => {
  const { f, pA, pB } = await firstNight();
  const id = f.journal.id;
  poser(f.memory, id, soireeMelee({ id, nuits: [{ table: '1', inscrits: [pA, pB], chanteurs: [pA, pB] },
    { table: '1', ouverte: true, chanteurs: [pB] }] }));
  const before = f.memory.lire(`data/soirees/${id}/journal.jsonl`);
  const loaded = f.saves.at(-1);
  loaded.settings.auto = true;
  const g = harness({ persistent: true, memory: f.memory, loaded });
  g.memory.crochet = (op, chemin, info) => (op === 'rename' && info.vers === `data/soirees/${id}/journal.jsonl` ? 'EIO' : null);
  g.startNight();
  g.memory.crochet = null;
  assert.equal(g.startupRepair().status, 'retry');
  assert.equal(g.journal.id, id);
  assert.equal(g.journal.current.meta.split, undefined, 'soirée ouverte telle quelle, sans découpage');
  assert.ok(g.memory.lire(`data/soirees/${id}/journal.jsonl`).startsWith(before), 'journal d’origine intact');
  assert.equal(g.settings.auto, false, 'envoi automatique coupé');
  const notes = notesOf(g).filter(msg => msg.includes('n’a pas pu être séparée'));
  assert.equal(notes.length, 1, notesOf(g).join('\n'));
  assert.equal(notes[0], REPAIR_NOTE);
  const failures = serverLog(g).filter(line => line.startsWith(`Réparation : ${id} en échec`));
  assert.deepEqual(failures, [`Réparation : ${id} en échec à l'étape « journal » (EIO, essai 1 sur 3) : reprise au prochain démarrage.`]);
  assert.deepEqual(lireJson(g.memory, 'data/soirees/.bornage.json').checked[id], { status: 'retry', attempts: 1, code: 'EIO', version: g.journal.app.version });
  assert.equal(g.saves.length, 1, 'première sauvegarde obligatoire écrite');
  assert.equal(g.saves[0].settings.auto, false);
  assert.equal((await call(g, 'GET', '/healthz')).status, 200);
  // Réparation qui lève (appel mal formé) : comptée comme un échec, une ligne
  // sans le message de l'erreur, la soirée ouverte telle quelle.
  const h = harness({ persistent: true, memory: g.memory, loaded });
  h.journal.repair = () => { throw new TypeError('message de Léa'); };
  h.startNight();
  assert.equal(h.startupRepair().status, 'failed');
  assert.equal(h.journal.id, id);
  assert.equal(h.settings.auto, false);
  assert.ok(notesOf(h).includes(REPAIR_NOTE));
  const thrown = serverLog(h).filter(line => line.startsWith(`Réparation : ${id} en échec au démarrage`));
  assert.equal(thrown.length, 1);
  assert.match(thrown[0], /^Réparation : \S+ en échec au démarrage \(TypeError\) : soirée ouverte telle quelle\. Pile : at /);
  assert.ok(!thrown[0].includes('Léa'), 'jamais le message de l’erreur');
});

// Notes au bar de la réparation (soirée en cours en échec, ou soirée close)
// écrites par ce démarrage, après le journal du bar repris de `save`.
const repairNotes = (f, save) => notesOf(f).slice(save.scheduler.log.length)
  .filter(msg => msg.includes('n’a pas pu être séparée') || msg.includes('réparation impossible'));
const CLOSED_RETRY_NOTE = /^Soirée du \S+ \d+ \S+ · \d\d:\d\d : réparation impossible pour l’instant, réessayée au prochain démarrage\.$/;

test('A4 : sauvegarde qui désigne une soirée déjà close et fusionnée (arrêt entre la clôture et la sauvegarde), sa copie impossible à écrire (EIO) : un seul essai à ce démarrage, que la passe des soirées closes ne refait pas ; au bar, la seule note d’une soirée close ; envoi automatique inchangé', async () => {
  const { f } = await firstNight();
  const id = f.journal.id;
  poser(f.memory, id, soireeMelee({ id, close: true, nuits: [{ table: '1', inscrits: ['a1'], chanteurs: ['a1'] },
    { table: '2', inscrits: ['a2'], chanteurs: ['a2'] }] }));
  const loaded = f.saves.at(-1);
  loaded.settings.auto = true;
  const g = harness({ persistent: true, memory: f.memory, loaded });
  const start = serverLog(g).length;
  g.memory.crochet = (op, chemin) => (op === 'write' || op === 'open') && chemin.startsWith(`data/soirees-originales/${id}/`) ? 'EIO' : null;
  g.startNight();
  const r = g.startupRepair();
  assert.deepEqual([r.id, r.status, r.current, r.attempts], [id, 'retry', false, 1], 'soirée close : pas la soirée en cours');
  assert.notEqual(g.journal.id, id, 'journal.open ne rouvre pas une soirée close');
  assert.equal(g.settings.auto, true, 'envoi automatique inchangé');
  assert.equal(g.saves[0].settings.auto, true);
  const counts = await g.repairClosedEvenings();
  g.memory.crochet = null;
  assert.deepEqual(plain(counts), { verified: 0, cut: 0, failed: 0, retry: 0 }, 'la passe ne la refait pas');
  assert.deepEqual(lireJson(g.memory, 'data/soirees/.bornage.json').checked[id], { status: 'retry', attempts: 1, code: 'EIO', version: g.journal.app.version },
    'un seul essai à ce démarrage');
  const failures = serverLog(g).slice(start).filter(line => line.startsWith(`Réparation : ${id} en échec`));
  assert.deepEqual(failures, [`Réparation : ${id} en échec à l'étape « copie » (EIO, essai 1 sur 3) : reprise au prochain démarrage.`]);
  const notes = repairNotes(g, loaded);
  assert.equal(notes.length, 1, notes.join('\n'));
  assert.match(notes[0], CLOSED_RETRY_NOTE);
});

const CLOSED_FAILED_NOTE = /^Soirée du \S+ \d+ \S+ · \d\d:\d\d : réparation impossible, à vérifier : préviens le mainteneur\.$/;

test('A4 : sauvegarde d’une soirée close notée ok, split ou failed à cette version, son meta.json illisible une fois au démarrage (EBUSY, avant de savoir si elle est ouverte) : entrée gardée ; ok ou split, aucune note au bar, rien ne la réessaierait ; failed, la note d’une soirée close notée failed, jamais « réessayée » ; envoi automatique inchangé ; la passe des soirées closes n’y change rien', async () => {
  for (const [kept, expected] of [['ok', []], ['split', []], ['failed', [CLOSED_FAILED_NOTE]]]) {
    const { f } = await firstNight();
    const id = f.journal.id;
    poser(f.memory, id, soireeMelee({ id, close: true, nuits: [{ table: '1', inscrits: ['a1'], chanteurs: ['a1'] },
      { table: '2', inscrits: ['a2'], chanteurs: ['a2'] }] }));
    const entry = kept === 'failed' ? { status: 'failed', attempts: 3, code: 'ENOSPC', version: f.journal.app.version } : kept;
    f.memory.ecrire('data/soirees/.bornage.json', JSON.stringify({ rule: 'v1', checked: { [id]: entry } }) + '\n');
    const loaded = f.saves.at(-1);
    loaded.settings.auto = true;
    const g = harness({ persistent: true, memory: f.memory, loaded });
    let fois = 1;
    g.memory.crochet = (op, chemin) => (op === 'read' && chemin === `data/soirees/${id}/meta.json` && fois-- > 0 ? 'EBUSY' : null);
    g.startNight();
    g.memory.crochet = null;
    const notes = repairNotes(g, loaded);
    assert.equal(notes.length, expected.length, `${kept} :\n${notes.join('\n')}`);
    expected.forEach((note, i) => assert.match(notes[i], note, kept));
    const r = g.startupRepair();
    assert.deepEqual([r.id, r.status, r.current, r.attempts, r.kept], [id, 'retry', false, null, kept], kept);
    assert.notEqual(g.journal.id, id, `${kept} : soirée close, une nouvelle ouverte`);
    assert.equal(g.settings.auto, true, `${kept} : envoi automatique inchangé`);
    assert.deepEqual(lireJson(g.memory, 'data/soirees/.bornage.json').checked[id], entry, `${kept} : entrée gardée`);
    // La passe des soirées closes ne la revoit pas : rien ne change.
    const files = g.memory.contenus(`data/soirees/${id}`);
    const index = g.memory.lire('data/soirees/.bornage.json');
    const counts = await g.repairClosedEvenings();
    assert.deepEqual(plain(counts), { verified: 0, cut: 0, failed: 0, retry: 0 }, kept);
    assert.deepEqual(g.memory.contenus(`data/soirees/${id}`), files, `${kept} : fichiers tels quels`);
    assert.equal(g.memory.lire('data/soirees/.bornage.json'), index, `${kept} : index tel quel`);
    assert.deepEqual(repairNotes(g, loaded), notes, `${kept} : aucune note de plus`);
  }
});

test('A4 : soirée en cours dont meta.json ne se lit pas (EACCES durable), trois démarrages de suite : un essai par démarrage, retry 1 puis 2, puis failed (attempts: 3), jamais refaite par la passe du démarrage qui vient de l’essayer ; au premier, soirée en cours en échec (envoi automatique coupé, une seule note), puis les notes d’une soirée close', async () => {
  const { f, pA, pB } = await firstNight();
  const id = f.journal.id;
  poser(f.memory, id, soireeMelee({ id, nuits: [{ table: '1', inscrits: [pA, pB], chanteurs: [pA, pB] },
    { table: '1', ouverte: true, chanteurs: [pB] }] }));
  const memory = f.memory;
  const loaded = f.saves.at(-1);
  loaded.settings.auto = true;
  memory.crochet = (op, chemin) => (op === 'read' && chemin === `data/soirees/${id}/meta.json` ? 'EACCES' : null);
  const attempts = () => lireJson(memory, 'data/soirees/.bornage.json').checked[id];
  const entry = (status, n) => ({ status, attempts: n, code: 'EACCES', version: f.journal.app.version });
  try {
    // Premier démarrage : la soirée de la sauvegarde, illisible, compte comme
    // la soirée en cours ; journal.open en commence une nouvelle.
    let start = serverLog(f).length;
    const g = harness({ persistent: true, memory, loaded });
    g.startNight();
    assert.notEqual(g.journal.id, id);
    await g.repairClosedEvenings();
    assert.deepEqual(attempts(), entry('retry', 1), 'premier démarrage : un seul essai');
    let failures = serverLog(g).slice(start).filter(line => line.startsWith(`Réparation : ${id} en échec`));
    assert.equal(failures.length, 1, failures.join('\n'));
    assert.match(failures[0], /\(EACCES, essai 1 sur 3\) : reprise au prochain démarrage\.$/);
    assert.deepEqual(repairNotes(g, loaded), [REPAIR_NOTE]);
    assert.equal(g.settings.auto, false, 'soirée en cours en échec : envoi automatique coupé');
    // Résultat gardé pour le second commit (repairFailed, A2) : l'échec est
    // celui de la soirée en cours.
    const r = g.startupRepair();
    assert.deepEqual([r.id, r.status, r.current, r.attempts], [id, 'retry', true, 1]);
    // Démarrages suivants : la sauvegarde désigne la soirée nouvelle, la
    // passe des soirées closes reprend l'ancienne, une fois par démarrage.
    let previous = g;
    // Sans meta.json lisible, la note la nomme par son identifiant.
    for (const [n, status, note] of [[2, 'retry', `Soirée ${id} : réparation impossible pour l’instant, réessayée au prochain démarrage.`],
      [3, 'failed', `Soirée ${id} : réparation impossible, à vérifier : préviens le mainteneur.`]]) {
      start = serverLog(previous).length;
      const save = previous.saves.at(-1);
      const h = harness({ persistent: true, memory, loaded: save });
      h.startNight();
      await h.repairClosedEvenings();
      assert.deepEqual(attempts(), entry(status, n), `démarrage ${n}`);
      failures = serverLog(h).slice(start).filter(line => line.startsWith(`Réparation : ${id} en échec`));
      assert.equal(failures.length, 1, `démarrage ${n} :\n${failures.join('\n')}`);
      assert.ok(failures[0].includes(`(EACCES, essai ${n} sur 3)`), failures[0]);
      assert.deepEqual(repairNotes(h, save), [note], `démarrage ${n}`);
      previous = h;
    }
  } finally { memory.crochet = null; }
});

test('A3 : sauvegarde dont l’identifiant de soirée est mal formé (« ../x », 42, null, une date en lettres) : rien à réparer (startupRepair() null), aucune ligne « Réparation : », envoi automatique inchangé, aucune note de la réparation au bar, une soirée nouvelle ouverte', async () => {
  const { f } = await firstNight();
  const id = f.journal.id;
  for (const bad of ['../x', 42, null, '2026-13-45_9999_zzzz']) {
    const label = JSON.stringify(bad);
    const loaded = plain(f.saves.at(-1));
    loaded.evening.id = bad;
    loaded.settings.auto = true;
    const g = harness({ persistent: true, memory: f.memory, loaded });
    const start = serverLog(f).length;
    g.startNight();
    assert.equal(g.startupRepair(), null, label);
    assert.deepEqual(serverLog(g).slice(start).filter(line => line.startsWith('Réparation :')), [], label);
    assert.equal(g.settings.auto, true, label);
    assert.equal(g.saves[0].settings.auto, true, label);
    assert.deepEqual(repairNotes(g, loaded), [], label);
    assert.notEqual(g.journal.id, id, `${label} : soirée nouvelle`);
  }
});

test('A3 : meta.roster de la soirée en cours au démarrage qui suit sa réparation : les personnes de la veille ni reportées ni citées n’y reviennent pas (journalRoster, puis journalNames à chaque ligne) ; soirée jamais découpée dont la ligne person.joined et meta.json ont échoué : le prénom revient au redémarrage', async () => {
  const { f, pA, pB } = await firstNight();
  const id = f.journal.id;
  poser(f.memory, id, soireeMelee({ id, nuits: [{ table: '1', inscrits: [pA, pB], chanteurs: [pA, pB] },
    { table: '1', ouverte: true, chanteurs: [pB] }], noms: { [pA]: 'Alice', [pB]: 'Bruno' } }));
  const g = harness({ persistent: true, memory: f.memory, loaded: f.saves.at(-1) });
  g.startNight();
  assert.ok(g.journal.current.meta.split, 'morceau découpé par la réparation');
  assert.ok(g.sched.people.has(pA) && g.sched.people.has(pB), 'la veille reste en mémoire');
  const roster = () => g.journal.current.meta.roster;
  assert.deepEqual(Object.keys(roster()), [pB], 'Alice, ni reportée ni citée, ne revient pas');
  assert.equal(roster()[pB].name, 'Bruno');
  // Une ligne qui ne la cite pas (signe de vie du téléphone) ne la fait pas
  // entrer ; une ligne qui la cite, oui ; un prénom présent suit la mémoire.
  g.journalEvent('person.seen', { personId: pA });
  assert.equal(Object.hasOwn(roster(), pA), false, 'person.seen ne cite pas');
  g.sched.people.get(pB).name = 'Bruno B.';
  g.journalEvent('person.seen', { personId: pB });
  assert.equal(roster()[pB].name, 'Bruno B.', 'prénom d’une personne déjà présente mis à jour');
  g.journalEvent('song.requested', { personId: pA, entryId: 'x1', songId: 7, title: 'Titre' });
  assert.equal(roster()[pA]?.name, 'Alice', 'citée par sa demande : elle entre');
  // Inscrite dans le morceau (person.joined, noté par l'ordonnanceur) : elle
  // entre aussi.
  const zoe = g.sched.join({ tableId: '1', name: 'Zoé' });
  assert.equal(roster()[zoe.id]?.name, 'Zoé');
  // Démarrage suivant : ces lignes, écrites à l'heure réelle, sont une
  // activité après le C du morceau (le matin du 22 octobre), que la
  // réparation recoupe (génération 2). Alice (sa demande) et Zoé (son
  // inscription) sont dans le nouveau morceau ; Bruno, qui n'y a qu'un signe
  // de vie de son téléphone, ni reporté ni cité, n'y revient pas, bien qu'il
  // reste en mémoire.
  const h = harness({ persistent: true, memory: g.memory, loaded: g.saves.at(-1) });
  h.startNight();
  assert.equal(h.journal.current.meta.split?.generation, 2);
  assert.ok(h.sched.people.has(pB));
  assert.deepEqual(Object.keys(h.journal.current.meta.roster).sort(), [pA, zoe.id].sort());

  // Soirée jamais découpée : la ligne person.joined de Zoé et meta.json en
  // échec, puis redémarrage simulé : son prénom revient dans meta.roster.
  const k = harness({ persistent: true });
  k.startNight();
  const kid = k.journal.id;
  k.sched.table('1').headcount = 4;
  const access = k.access.get('1') || k.access.issue('1');
  k.memory.crochet = (op, chemin) => ((op === 'append' && chemin === `data/soirees/${kid}/journal.jsonl`) ||
    (op === 'write' && chemin.startsWith(`data/soirees/${kid}/meta.json`)) ? 'EIO' : null);
  const joined = await call(k, 'POST', '/api/table/person', { body: { table: '1', access, name: 'Zoé' } });
  k.memory.crochet = null;
  assert.equal(joined.status, 200, joined.text);
  const zid = joined.body.id;
  assert.equal(Object.hasOwn(lireJson(k.memory, `data/soirees/${kid}/meta.json`).roster, zid), false, 'meta.json sans Zoé sur le disque');
  assert.ok(!eveningLines(k.memory, kid).some(e => e.ev === 'person.joined' && e.personId === zid), 'ligne person.joined perdue');
  const m = harness({ persistent: true, memory: k.memory, loaded: k.saves.at(-1) });
  m.startNight();
  assert.equal(m.journal.current.meta.split, undefined);
  assert.equal(m.journal.current.meta.roster[zid]?.name, 'Zoé', 'prénom revenu dans meta.roster');
});

test('A4 : KARAOKE_REPAIR : off, OFF et « off » avec une espace finale coupent (deuxième ligne), 0 coupe par prudence (troisième ligne, valeur coupée à 20 caractères), vide ou absente : active ; .bornage.json écrit seulement avec la réparation active', async () => {
  const ARCHIVE = '2026-10-20_1930_a0a0';
  for (const [value, line, active] of [[undefined, ACTIVE, true], ['', ACTIVE, true], ['off', COUPEE, false], ['OFF', COUPEE, false],
    ['off ', COUPEE, false], ['0', prudence('0'), false], ['valeur-beaucoup-trop-longue', prudence('valeur-beaucoup-trop'), false]]) {
    const label = JSON.stringify(value);
    const memory = memoryDisk();
    archiveMelee(memory, ARCHIVE);
    const before = memory.contenus('data/soirees');
    const f = harness({ persistent: true, memory, env: value === undefined ? {} : { KARAOKE_REPAIR: value } });
    f.startNight();
    const counts = await f.repairClosedEvenings();
    const status = serverLog(f).filter(text => text.startsWith('Réparation des soirées :'));
    assert.deepEqual(status, [line], label);
    assert.equal(f.journal.repairEnabled, active, label);
    assert.equal(memory.existe('data/soirees/.bornage.json'), active, `${label} : .bornage.json`);
    if (active) {
      assert.deepEqual(plain(counts), { verified: 1, cut: 1, failed: 0, retry: 0 }, label);
      assert.equal(lireJson(memory, 'data/soirees/.bornage.json').checked[ARCHIVE], 'split', label);
    } else {
      assert.equal(counts, null, label);
      for (const [rel, text] of before) assert.equal(memory.lire(rel), text, `${label} : ${rel} inchangé`);
      assert.equal(memory.fichiers('data/soirees-originales').length, 0, label);
      assert.ok(!serverLog(f).some(text => text.startsWith('Réparation des soirées closes')), `${label} : aucune passe`);
    }
  }
});

test('A7 : environnement du harnais sans KARAOKE_* : avec KARAOKE_REPAIR=off posé dans l’environnement de l’essai, puis rendu, un harnais neuf répare quand même la soirée fusionnée ; disque du harnais : statSync sur data/ lève « méthode non simulée »', async () => {
  const ARCHIVE = '2026-10-20_1930_b1b1';
  const had = Object.hasOwn(process.env, 'KARAOKE_REPAIR');
  const saved = process.env.KARAOKE_REPAIR;
  process.env.KARAOKE_REPAIR = 'off';
  let f;
  try {
    const memory = memoryDisk();
    archiveMelee(memory, ARCHIVE);
    f = harness({ persistent: true, memory });
    f.startNight();
  } finally {
    if (had) process.env.KARAOKE_REPAIR = saved; else delete process.env.KARAOKE_REPAIR;
  }
  assert.ok(serverLog(f).includes(ACTIVE));
  const counts = await f.repairClosedEvenings();
  assert.deepEqual(plain(counts), { verified: 1, cut: 1, failed: 0, retry: 0 });
  assert.equal(lireJson(f.memory, 'data/soirees/.bornage.json').checked[ARCHIVE], 'split');
  assert.throws(() => f.memory.memFs.statSync(path.join(root, 'data')), { message: 'méthode non simulée : fs.statSync("data"). ' +
    'Le disque en mémoire n\'a que existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, mkdirSync, readdirSync, ' +
    'openSync, fsyncSync et closeSync (A4, « Trace et contraintes ») : réécris l\'appel avec elles.' });
});

test('A4 : liste de data/soirees qui lève EIO (crochet d’erreur), deux démarrages de suite : la ligne « interrompue » avec sa pile sans le message, les routes répondent, aucune exception ne sort du bac à sable, .bornage.json pas réécrit', async () => {
  const ARCHIVE = '2026-10-20_1930_c2c2';
  const memory = memoryDisk();
  archiveMelee(memory, ARCHIVE);
  memory.ecrire('data/soirees/.bornage.json', JSON.stringify({ rule: 'v1', checked: { '2026-10-01_1900_dddd': 'ok' } }) + '\n');
  const index = memory.octets('data/soirees/.bornage.json');
  const escaped = [];
  const catcher = error => escaped.push(error);
  process.on('uncaughtException', catcher);
  try {
    let loaded = null;
    for (const start of [1, 2]) {
      const f = harness({ persistent: true, memory, loaded });
      f.startNight();
      memory.crochet = (op, chemin) => (op === 'readdir' && chemin === 'data/soirees' ? 'EIO' : null);
      // Une mise à jour au premier tour : la liste se lit dans une minuterie,
      // hors de la promesse, d'où une exception sortirait du rappel.
      let polls = 0;
      f.serverUpdate.isBusy = () => polls++ === 0;
      const counts = await f.repairClosedEvenings();
      assert.equal(counts, null, `démarrage ${start}`);
      const stopped = serverLog(f).filter(line => line.startsWith('Réparation des soirées closes'));
      assert.equal(stopped.length, start, `démarrage ${start} : une ligne par démarrage\n${stopped.join('\n')}`);
      assert.match(stopped.at(-1), /^Réparation des soirées closes interrompue \(Error, code EIO\) : reprise au prochain démarrage\. Pile : at .+$/);
      // Le message de l'erreur (« EIO: readdir '<chemin>' ») n'y est pas.
      assert.ok(!stopped.at(-1).includes('EIO:') && !stopped.at(-1).includes('soirees\''), `pile sans le message de l’erreur : ${stopped.at(-1)}`);
      assert.ok(!stopped.at(-1).includes(root), 'aucun chemin absolu dans la pile');
      for (const route of ['/healthz', staff(f, '/api/staff/state'), staff(f, '/api/staff/stats/evenings')]) {
        assert.equal((await call(f, 'GET', route)).status, 200, `${route.split('?')[0]} au démarrage ${start}`);
      }
      memory.crochet = null;
      assert.ok(memory.octets('data/soirees/.bornage.json').equals(index), `démarrage ${start} : .bornage.json pas réécrit`);
      loaded = f.saves.at(-1);
    }
    await turn();
  } finally { process.off('uncaughtException', catcher); }
  assert.deepEqual(escaped, [], 'aucune exception sortie d’un rappel');
});

test('A3 : réparation des soirées closes (A4) : une à une après la mise en écoute (setImmediate), arrêtée pendant une mise à jour (isBusy) puis reprise ; notes au bar d’un échec (retry, failed) ; ligne de fin ; une archive notée failed n’est pas refaite au démarrage suivant, et l’est si la version ou la règle change', async () => {
  const A = '2026-10-20_1930_a1a1', B = '2026-10-21_1930_b2b2', C = '2026-10-22_1930_c3c3', D = '2026-10-23_1930_d4d4';
  const memory = memoryDisk();
  archiveMelee(memory, A);
  archiveMelee(memory, B);
  // C : un champ de meta.json mal formé (failed, BAD_META) ; D : la copie
  // impossible à écrire (retry, EIO).
  const bad = soireeMelee({ id: C, close: true, nuits: [{ table: '1', inscrits: ['c1'], chanteurs: ['c1'] }] });
  poser(memory, C, { meta: { ...bad.meta, startedAt: 'pas une heure' }, events: bad.events });
  archiveMelee(memory, D);
  const f = harness({ persistent: true, memory });
  f.startNight();
  assert.equal(memory.existe('data/soirees/.bornage.json'), false, 'aucune soirée close réparée pendant startNight()');
  const calls = [];
  const probes = [];
  const repair = f.journal.repair.bind(f.journal);
  let busy = false, busyCalls = 0;
  f.serverUpdate.isBusy = () => { if (busy) busyCalls++; return busy; };
  f.journal.repair = options => {
    const r = repair(options);
    calls.push([options.id, r.status]);
    // Relevé au tour de boucle suivant : une passe qui enchaînerait les
    // soirées sans rendre la main relèverait 4, 4, 4, 4.
    setImmediate(() => probes.push(calls.length));
    if (calls.length === 1) busy = true;
    return r;
  };
  memory.crochet = (op, chemin) => (op === 'write' || op === 'open') && chemin.startsWith(`data/soirees-originales/${D}/`) ? 'EIO' : null;
  const done = f.repairClosedEvenings();
  assert.ok(calls.length <= 1, 'au plus une soirée avant de rendre la main');
  await until(() => busyCalls >= 2, 'attente de la fin de la mise à jour');
  assert.equal(calls.length, 1, 'aucune soirée pendant la mise à jour');
  busy = false;
  const counts = await done;
  memory.crochet = null;
  assert.deepEqual(calls, [[A, 'split'], [B, 'split'], [C, 'failed'], [D, 'retry']]);
  assert.deepEqual(probes.slice(0, 4), [1, 2, 3, 4], 'une soirée par tour de boucle');
  assert.deepEqual(plain(counts), { verified: 2, cut: 2, failed: 1, retry: 1 });
  const end = serverLog(f).filter(line => line.startsWith('Réparation des soirées closes'));
  assert.equal(end.length, 1, end.join('\n'));
  assert.deepEqual(FIN.exec(end[0])?.slice(1), ['2', '2', '1', '1'], end[0]);
  const notes = notesOf(f);
  assert.equal(notes.filter(msg => msg.endsWith('à vérifier : préviens le mainteneur.')).length, 1, notes.join('\n'));
  assert.equal(notes.filter(msg => msg.endsWith('réessayée au prochain démarrage.')).length, 1, notes.join('\n'));
  assert.ok(notes.includes(`Soirée ${C} : réparation impossible, à vérifier : préviens le mainteneur.`), notes.join('\n'));
  assert.ok(notes.some(msg => /^Soirée du \S+ \d+ \S+ · \d\d:\d\d : réparation impossible pour l’instant, réessayée au prochain démarrage\.$/.test(msg)), notes.join('\n'));
  const index = lireJson(memory, 'data/soirees/.bornage.json').checked;
  assert.equal(index[C].status, 'failed');
  assert.equal(index[D].status, 'retry');

  // Démarrage suivant, même version : C n'est pas refaite ; D l'est.
  const g = harness({ persistent: true, memory, loaded: f.saves.at(-1) });
  g.startNight();
  const again = [];
  const repairG = g.journal.repair.bind(g.journal);
  g.journal.repair = options => { again.push(options.id); return repairG(options); };
  assert.deepEqual(plain(await g.repairClosedEvenings()), { verified: 1, cut: 1, failed: 0, retry: 0 });
  assert.deepEqual(again, [D], 'failed de cette version : pas refaite');
  // Autre version : C est refaite.
  const h = harness({ persistent: true, memory, loaded: g.saves.at(-1) });
  h.startNight();
  h.journal.app = { ...h.journal.app, version: 'v9.9.9' };
  const redone = [];
  const repairH = h.journal.repair.bind(h.journal);
  h.journal.repair = options => { redone.push(options.id); return repairH(options); };
  assert.deepEqual(plain(await h.repairClosedEvenings()), { verified: 0, cut: 0, failed: 1, retry: 0 });
  assert.deepEqual(redone, [C]);
  // Autre règle : l'entrée failed d'une autre règle est retirée, C est refaite.
  const rewritten = lireJson(memory, 'data/soirees/.bornage.json');
  memory.ecrire('data/soirees/.bornage.json', JSON.stringify({ ...rewritten, rule: 'v0' }) + '\n');
  const k = harness({ persistent: true, memory, loaded: h.saves.at(-1) });
  k.startNight();
  const ruled = [];
  const repairK = k.journal.repair.bind(k.journal);
  k.journal.repair = options => { ruled.push(options.id); return repairK(options); };
  await k.repairClosedEvenings();
  assert.deepEqual(ruled, [C], 'règle changée : C refaite');
});

test('A3 : première sauvegarde obligatoire en panne (NightStateStore qui lève à chaque écriture), trois démarrages de suite d’une soirée de l’avant-veille : startNight() lève à chacun, avant toute clôture, et aucun dossier nouveau dans data/soirees', async () => {
  const { f } = await firstNight();
  const id = f.journal.id;
  poser(f.memory, id, soireeMelee({ id, nuits: [{ table: '1', inscrits: ['x1'], chanteurs: ['x1'] }] }));
  const folders = () => f.memory.fichiers('data/soirees').map(rel => rel.split('/')[2]).filter((name, i, all) => all.indexOf(name) === i);
  const before = folders();
  const loaded = f.saves.at(-1);
  for (const start of [1, 2, 3]) {
    const g = harness({ persistent: true, memory: f.memory, loaded });
    g.night.fail = 'Disque plein';
    assert.throws(() => g.startNight(), /^Error: Disque plein$/, `démarrage ${start} : le démarrage échoue`);
    assert.equal(g.saves.length, 0, `démarrage ${start}`);
    assert.ok(!eveningLines(g.memory, id).some(e => e.ev === 'evening.closed'), `démarrage ${start} : aucune clôture`);
    assert.deepEqual(folders(), before, `démarrage ${start} : aucun dossier nouveau dans data/soirees`);
  }
});

test('A4 : index .bornage.json impossible à lire (EIO) pendant la passe des soirées closes : la soirée close attend, comptée « à refaire » dans la ligne de fin, une seule ligne pour l’index, aucune note au bar, rien de réécrit', async () => {
  const ARCHIVE = '2026-10-20_1930_e5e5';
  const memory = memoryDisk();
  archiveMelee(memory, ARCHIVE);
  memory.ecrire('data/soirees/.bornage.json', JSON.stringify({ rule: 'v1', checked: {} }) + '\n');
  const before = memory.contenus('data/soirees');
  const f = harness({ persistent: true, memory });
  f.startNight();
  const notes = notesOf(f).length;
  memory.crochet = (op, chemin) => (op === 'read' && chemin === 'data/soirees/.bornage.json' ? 'EIO' : null);
  const counts = await f.repairClosedEvenings();
  memory.crochet = null;
  assert.deepEqual(plain(counts), { verified: 0, cut: 0, failed: 0, retry: 1 });
  const log = serverLog(f);
  assert.equal(log.filter(line => line.startsWith('Réparation : index data/soirees/.bornage.json impossible à lire (EIO)')).length, 1, log.join('\n'));
  assert.deepEqual(FIN.exec(log.find(line => line.startsWith('Réparation des soirées closes terminée')))?.slice(1), ['0', '0', '0', '1']);
  assert.equal(notesOf(f).length, notes, 'aucune note au bar pour une attente');
  for (const [rel, text] of before) if (rel.startsWith(`data/soirees/${ARCHIVE}/`) || rel.endsWith('.bornage.json')) assert.equal(memory.lire(rel), text, rel);
});
