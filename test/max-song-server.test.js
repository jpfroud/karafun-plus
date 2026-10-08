'use strict';
// Durée maximale des titres (lot J, décision D9), côté serveur. server.js
// tourne dans un bac à sable `vm` sans port ni KaraFun : chaque requête passe
// par son gestionnaire HTTP avec une fausse requête et une fausse réponse.
// Disque en mémoire, faux magasin de la soirée, journal relevé en mémoire.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { restoreNight } = require('../night-state');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const disk = new Map();
  const inMemory = file => String(file).startsWith(path.join(root, 'data')) || String(file).startsWith(path.join(root, 'journal'));
  const memFs = { ...fs,
    existsSync: file => inMemory(file) ? disk.has(file) : fs.existsSync(file),
    readFileSync(file, ...rest) {
      if (!inMemory(file)) return fs.readFileSync(file, ...rest);
      if (!disk.has(file)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return disk.get(file);
    },
    writeFileSync(file, data) { disk.set(file, String(data)); },
    appendFileSync(file, data) { disk.set(file, (disk.get(file) || '') + data); },
    renameSync(from, to) { disk.set(to, disk.get(from)); disk.delete(from); },
    unlinkSync(file) { disk.delete(file); }, mkdirSync() {}, readdirSync() { return []; } };
  const saves = [];
  const overrides = {
    './night-state': { ...fromServer('./night-state'), NightStateStore: class {
      load() { return null; }
      save(snapshot) { saves.push(plain(snapshot)); return true; }
    } },
    './scheduler': (() => {
      const real = fromServer('./scheduler');
      return { ...real, Scheduler: class extends real.Scheduler { constructor(o) { super({ ...o, solverEnabled: false }); } } };
    })(),
    './spotify': (() => {
      const real = fromServer('./spotify');
      return { ...real, SpotifyLink: class extends real.SpotifyLink { constructor(o) { super({ ...o, file: null }); } } };
    })(),
  };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js')];
  const context = { require: name => name === 'fs' ? memFs : overrides[name] || fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL, setTimeout, clearTimeout,
    setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, access, journal, staffState, publicState, rememberBattleSongs, battleVote,
      STAFF_KEY, PORT, handle: server.listeners('request')[0], setPending: p => { pending = p; } };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  const events = [];
  f.journal.append = (type, fields) => { events.push([type, plain(fields)]); return null; };
  return Object.assign(f, { saves, events });
}

function call(f, url, body) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method: 'POST', url, headers: {}, socket: { remoteAddress: '127.0.0.1', localPort: f.PORT }, destroy() {} });
    const out = { status: null, headers: {} };
    const res = {
      setHeader(name, value) { out.headers[name.toLowerCase()] = value; },
      getHeader(name) { return out.headers[name.toLowerCase()]; },
      hasHeader(name) { return name.toLowerCase() in out.headers; },
      removeHeader(name) { delete out.headers[name.toLowerCase()]; },
      writeHead(status, headers = {}) {
        out.status = status;
        for (const [name, value] of Object.entries(headers)) out.headers[name.toLowerCase()] = value;
      },
      end(data = '') {
        out.text = String(data);
        out.body = out.text && /json/.test(out.headers['content-type'] || '') ? JSON.parse(out.text) : out.text;
        resolve(out);
      },
    };
    f.handle(req, res);
    setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
}
const staff = (f, route, body = {}) => call(f, `${route}?key=${f.STAFF_KEY}`, body);

// Table 1 et ses chanteurs inscrits par leur téléphone.
async function table(f, ...names) {
  f.sched.table('1').headcount = 10;
  const tb = { table: '1', access: f.access.issue('1') };
  const people = [];
  for (const name of names) {
    const r = await call(f, '/api/table/person', { ...tb, name });
    assert.equal(r.status, 200, r.text);
    people.push({ ...tb, personId: r.body.id, token: r.body.token });
  }
  return people;
}
const limit = (f, maxSongSec) => staff(f, '/api/staff/settings', { maxSongSec });
const titles = (f, who) => f.sched.songsOf(f.sched.people.get(who.personId)).map(song => song.title);
// Le catalogue relayé par le serveur : durées fiables.
const CATALOG = [{ songId: 1, title: 'Court', artist: 'A', duration: 200 }, { songId: 2, title: 'Épopée', artist: 'B', duration: 372 },
  { songId: 3, title: 'Limite', artist: 'C', duration: 300 }];

test('option coupée par défaut : aucun titre refusé, rien dans l’état public', async () => {
  const f = harness();
  f.rememberBattleSongs(plain(CATALOG));
  assert.equal(f.settings.maxSongSec, null, 'coupée par défaut');
  assert.equal(f.publicState().rules.maxSongSec, null);
  const [alice] = await table(f, 'Alice');
  const r = await call(f, '/api/table/song', { ...alice, song: { songId: 2, title: 'Épopée', artist: 'B', duration: 372 } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(titles(f, alice), ['Épopée']);
  assert.deepEqual(plain(f.staffState().tooLong), { limitSec: null, count: 0 });
  assert.equal(f.staffState().queue[0].tooLongSec, undefined, 'pas de repère sans limite');
});

test('réglage du bar : bornes 2:00 à 15:00, requête refusée sans effet, journal et note', async () => {
  const f = harness();
  for (const bad of [60, 119, 901, 300.5, 'abc', '', true]) {
    const r = await limit(f, bad);
    assert.equal(r.status, 400, String(bad));
    assert.equal(r.body.error, 'La durée maximale des chansons doit être entre 2:00 et 15:00.');
  }
  assert.equal(f.settings.maxSongSec, null, 'valeur refusée : rien ne change');
  let r = await limit(f, 300);
  assert.equal(r.status, 200);
  assert.equal(f.settings.maxSongSec, 300);
  assert.equal(f.publicState().rules.maxSongSec, 300, 'limite envoyée aux téléphones');
  assert.deepEqual(f.events.filter(([type]) => type === 'settings.changed').map(([, e]) => e),
    [{ setting: 'maxSongSec', from: null, to: 300 }]);
  assert.match(f.sched.log.at(-1).msg ?? f.sched.log.at(-1).text ?? JSON.stringify(f.sched.log.at(-1)), /limitée à 5:00 pour les nouveaux ajouts/);
  // Un autre réglage sans maxSongSec garde la limite.
  r = await staff(f, '/api/staff/settings', { pushDelaySec: 20 });
  assert.equal(f.settings.maxSongSec, 300);
  r = await limit(f, '420');
  assert.equal(f.settings.maxSongSec, 420, 'nombre envoyé en texte accepté');
  r = await limit(f, false);
  assert.equal(f.settings.maxSongSec, null, 'false coupe la limite');
  r = await limit(f, 900);
  r = await limit(f, null);
  assert.equal(f.settings.maxSongSec, null);
  assert.match(JSON.stringify(f.sched.log.at(-1)), /plus de limite/);
  assert.deepEqual(f.events.filter(([type, e]) => type === 'settings.changed' && e.setting === 'maxSongSec').map(([, e]) => e.to),
    [300, 420, null, 900, null]);
});

test('titre, duo et Battle d’un client refusés au-delà de la limite ; message et journal', async () => {
  const f = harness();
  f.rememberBattleSongs(plain(CATALOG));
  const [alice, bob] = await table(f, 'Alice', 'Bob');
  await limit(f, 300);
  const refused = (r, message = 'Ce titre dure 6:12 : le bar limite les chansons à 5:00.') => {
    assert.equal(r.status, 400, r.text);
    assert.equal(r.body.error, message);
  };
  refused(await call(f, '/api/table/song', { ...alice, song: { songId: 2, title: 'Épopée', artist: 'B', duration: 372 } }));
  refused(await call(f, '/api/table/song', { ...alice, mode: 'replace', song: { songId: 2, title: 'Épopée', artist: 'B' } }));
  refused(await call(f, '/api/table/duet', { ...alice, partnerId: bob.personId, song: { songId: 2, title: 'Épopée', artist: 'B' } }));
  assert.deepEqual(titles(f, alice), [], 'rien n’est ajouté');
  // Exactement la limite : accepté.
  assert.equal((await call(f, '/api/table/song', { ...alice, song: { songId: 3, title: 'Limite', artist: 'C' } })).status, 200);
  // Battle : un des titres proposés est trop long.
  await staff(f, '/api/staff/settings', { battleMinVoters: 1 });
  refused(await call(f, '/api/table/battle/propose', { ...alice, songs: [{ songId: 1 }, { songId: 2 }], proposerChoice: 1 }));
  assert.equal(f.battleVote.view().phase, 'idle', 'pas de vote ouvert');
  const ok = await call(f, '/api/table/battle/propose', { ...alice, songs: [{ songId: 1 }, { songId: 3 }], proposerChoice: 1 });
  assert.equal(ok.status, 200, ok.text);
  const journaled = f.events.filter(([type]) => type === 'songLength.refused').map(([, e]) => [e.route, e.songId, e.durationSec, e.limitSec]);
  assert.deepEqual(journaled, [['song', 2, 372, 300], ['song', 2, 372, 300], ['duet', 2, 372, 300], ['battle', 2, 372, 300]]);
});

test('anciennes routes /api/song et /api/duet : même contrôle', async () => {
  const f = harness();
  f.rememberBattleSongs(plain(CATALOG));
  const [alice, bob] = await table(f, 'Alice', 'Bob');
  await limit(f, 300);
  let r = await call(f, '/api/song', { token: alice.token, song: { songId: 2, title: 'Épopée', artist: 'B' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Ce titre dure 6:12 : le bar limite les chansons à 5:00.');
  r = await call(f, '/api/duet', { token: alice.token, partnerId: bob.personId, song: { songId: 2, title: 'Épopée', artist: 'B' } });
  assert.equal(r.status, 400);
  r = await call(f, '/api/song', { token: alice.token, song: { songId: 1, title: 'Court', artist: 'A' } });
  assert.equal(r.status, 200, r.text);
});

test('durée : le catalogue fiable passe avant celle du téléphone ; téléphone bornée ; inconnue = acceptée', async () => {
  const f = harness();
  f.rememberBattleSongs(plain(CATALOG));
  const [alice] = await table(f, 'Alice');
  await limit(f, 300);
  // Téléphone qui prétend 2:00 pour un titre de 6:12 : refusé.
  let r = await call(f, '/api/table/song', { ...alice, song: { songId: 2, title: 'Épopée', artist: 'B', duration: 120 } });
  assert.equal(r.status, 400);
  // Téléphone qui prétend 9:00 pour un titre de 3:20 : accepté.
  r = await call(f, '/api/table/song', { ...alice, song: { songId: 1, title: 'Court', artist: 'A', duration: 540 } });
  assert.equal(r.status, 200);
  // Titre jamais vu dans le catalogue : durée du téléphone, bornée à 20:00.
  r = await call(f, '/api/table/song', { ...alice, song: { songId: 77, title: 'Hors catalogue', artist: 'X', duration: 99999 } });
  assert.equal(r.body.error, 'Ce titre dure 20:00 : le bar limite les chansons à 5:00.');
  r = await call(f, '/api/table/song', { ...alice, song: { songId: 78, title: 'Hors catalogue court', artist: 'X', duration: 10 } });
  assert.equal(r.status, 200, 'durée minuscule ramenée à 0:30');
  // Durée inconnue : accepté.
  for (const duration of [undefined, null, 'long', -5]) {
    r = await call(f, '/api/table/song', { ...alice, song: { songId: 80, title: 'Inconnu', artist: 'X', duration } });
    assert.equal(r.status, 200, `durée ${duration}`);
    await call(f, '/api/table/song/remove', { ...alice, entryId: f.sched.songsOf(f.sched.people.get(alice.personId)).at(-1).entryId });
  }
});

test('le bar n’est jamais limité : Battle lancée par le bar', async () => {
  const f = harness();
  f.rememberBattleSongs(plain(CATALOG));
  await limit(f, 120);
  const r = await staff(f, '/api/staff/battle/launch', { song: { songId: 2 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(f.events.filter(([type]) => type === 'songLength.refused').length, 0);
});

test('titres déjà dans la file à l’activation : gardés, signalés au bar, retrait groupé avec avis (D9)', async () => {
  const f = harness();
  f.rememberBattleSongs(plain(CATALOG));
  const [alice, bob, chloe] = await table(f, 'Alice', 'Bob', 'Chloé');
  const add = (who, song) => call(f, '/api/table/song', { ...who, song });
  await add(alice, { songId: 2, title: 'Épopée', artist: 'B' });
  await add(alice, { songId: 1, title: 'Court', artist: 'A' });
  await add(bob, { songId: 1, title: 'Court', artist: 'A' });
  await add(bob, { songId: 77, title: 'Long du téléphone', artist: 'X', duration: 500 });
  // Duo de Chloé avec Bob sur un titre trop long.
  assert.equal((await call(f, '/api/table/duet', { ...chloe, partnerId: bob.personId, song: { songId: 2, title: 'Épopée', artist: 'B' } })).status, 200);
  // Avant l'option : retrait groupé refusé.
  let r = await staff(f, '/api/staff/songs-too-long/remove');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Active d’abord « Limiter la durée des chansons ».');
  await limit(f, 300);
  assert.match(JSON.stringify(f.sched.log.at(-1)), /3 titres de la file dépassent/);
  assert.deepEqual(titles(f, alice), ['Épopée', 'Court'], 'rien n’est retiré à l’activation');
  const state = f.staffState();
  assert.deepEqual(plain(state.tooLong), { limitSec: 300, count: 3 });
  const flagged = state.queue.filter(line => line.tooLongSec).map(line => [line.song.title, line.tooLongSec]);
  assert.deepEqual(flagged.sort(), [['Long du téléphone', 500], ['Épopée', 372], ['Épopée', 372]].sort());
  assert.equal(f.publicState().queue.some(line => 'tooLongSec' in line), false, 'repère réservé au bar');
  // Un titre trop long en cours d'envoi à KaraFun reste.
  const sending = f.sched.people.get(chloe.personId).song;
  f.setPending({ sel: { ids: [chloe.personId, bob.personId], names: ['Chloé', 'Bob'], label: 'Chloé & Bob', kind: 'duo', song: sending },
    cancelled: false, before: new Set(), at: Date.now(), attempts: 1 });
  assert.equal(f.staffState().tooLong.count, 2, 'le titre en cours d’envoi n’est pas compté');
  r = await staff(f, '/api/staff/songs-too-long/remove');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.removed, 2);
  assert.equal(r.body.message, '2 titres trop longs retirés.');
  assert.deepEqual(titles(f, alice), ['Court']);
  assert.deepEqual(titles(f, bob), ['Court']);
  assert.deepEqual(titles(f, chloe), ['Épopée'], 'titre en cours d’envoi gardé');
  const notices = person => (f.sched.people.get(person.personId).inbox || []).map(n => [n.kind, plain(n.params)]);
  assert.deepEqual(notices(alice), [['tooLongRemoved', { title: 'Épopée', length: '6:12', limit: '5:00' }]]);
  assert.deepEqual(notices(bob).filter(([kind]) => kind === 'tooLongRemoved'),
    [['tooLongRemoved', { title: 'Long du téléphone', length: '8:20', limit: '5:00' }]]);
  assert.deepEqual(f.events.filter(([type]) => type === 'songLength.removed').map(([, e]) => e), [{ count: 2, limitSec: 300 }]);
  assert.match(JSON.stringify(f.sched.log.at(-1)), /Le bar a retiré 2 titres plus longs que 5:00/);
  f.setPending(null);
  // Un titre introuvable au moment du retrait est compté comme ignoré.
  const realRemove = f.sched.staffRemoveEntry;
  f.sched.staffRemoveEntry = () => { throw new Error('Titre introuvable dans la liste de ce chanteur.'); };
  r = await staff(f, '/api/staff/songs-too-long/remove');
  f.sched.staffRemoveEntry = realRemove;
  assert.equal(r.body.message, '0 titre trop long retiré ; 1 ignoré (Titre introuvable dans la liste de ce chanteur.).');
  r = await staff(f, '/api/staff/songs-too-long/remove');
  assert.equal(r.body.message, '1 titre trop long retiré.');
  // Le duo de Chloé : son invité Bob apprend que le bar l'a retiré pour sa
  // durée, et non que Chloé aurait annulé le duo (relecture gstack).
  assert.equal(notices(bob).some(([kind]) => kind === 'duoCancelled'), false, 'pas de « Chloé a annulé le duo »');
  assert.deepEqual(notices(bob).filter(([kind]) => kind === 'tooLongRemoved').at(-1),
    ['tooLongRemoved', { title: 'Épopée', length: '6:12', limit: '5:00', name: 'Chloé' }]);
  assert.deepEqual(notices(chloe).filter(([kind]) => kind === 'tooLongRemoved'),
    [['tooLongRemoved', { title: 'Épopée', length: '6:12', limit: '5:00' }]]);
  assert.equal((await call(f, '/api/staff/songs-too-long/remove', {})).status, 403, 'réservé au bar');
});

test('sauvegarde de la soirée : la limite revient après un redémarrage, une valeur invalide coupe l’option', async () => {
  const f = harness();
  await limit(f, 330);
  const snapshot = f.saves.at(-1);
  assert.equal(snapshot.settings.maxSongSec, 330);
  const restore = maxSongSec => {
    const copy = plain(snapshot);
    if (maxSongSec === undefined) delete copy.settings.maxSongSec; else copy.settings.maxSongSec = maxSongSec;
    const settings = { maxSongSec: null };
    restoreNight(copy, { scheduler: new Scheduler({ solverEnabled: false }), access: new TableAccess(), settings });
    return settings.maxSongSec;
  };
  assert.equal(restore(330), 330);
  for (const bad of [60, 1000, '300', 300.5, true, {}]) assert.equal(restore(bad), null, JSON.stringify(bad));
  assert.equal(restore(null), null);
  assert.equal(restore(undefined), null, 'ancienne sauvegarde sans le champ : option coupée');
});
