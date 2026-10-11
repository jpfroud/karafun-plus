'use strict';
// Prénom seul pour les solistes (lot K, décisions D10 et D11). Un soliste
// n'est nommé que par son prénom (« Léa »), une personne de table par son
// prénom et sa table (« Max · Table 4 »), partout : écran de KaraFun,
// téléphones, page du bar. Première partie : Scheduler#passageLabel et les
// notes du journal. Seconde partie : server.js dans un bac à sable `vm`, avec
// un faux pont KaraFun (aucun port, aucun KaraFun) : affichage recalculé,
// soirée enregistrée à l'ancien format, ligne KaraFun non suivie, « Relancer »,
// prénom réservé, duo noté par le bar.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { Scheduler } = require('../scheduler');

const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const song = (songId, title = `Titre ${songId}`) => ({ songId, title, artist: 'Artiste' });

// ------------------------------------------------------------------ planificateur
function world() {
  const s = new Scheduler({ solverEnabled: false });
  s.table('Comptoir').name = 'En solo';
  s.setHeadcount('4', 6, 'staff');
  s.setHeadcount('2', 6, 'staff');
  const lea = s.join({ tableId: 'Comptoir', name: 'Léa' });
  const sam = s.join({ tableId: 'Comptoir', name: 'Sam' });
  const max = s.join({ tableId: '4', name: 'Max' });
  const zoe = s.join({ tableId: '2', name: 'Zoé' });
  const noa = s.join({ tableId: '4', name: 'Noa' });
  return { s, lea, sam, max, zoe, noa };
}

test('passageLabel : solo, deux solistes, mixte, tables, sans doublon', () => {
  const { s, lea, sam, max, zoe, noa } = world();
  assert.equal(s.passageLabel([lea.id]), 'Léa');
  assert.equal(s.passageLabel([lea.id, sam.id]), 'Léa & Sam', 'deux solistes : jamais « En solo »');
  assert.equal(s.passageLabel([lea.id, max.id]), 'Léa & Max · Table 4', 'soliste et table : seule la table');
  assert.equal(s.passageLabel([max.id, lea.id]), 'Max & Léa · Table 4');
  assert.equal(s.passageLabel([max.id, zoe.id]), 'Max & Zoé · Table 4 + Table 2', 'tables dans l’ordre des personnes');
  assert.equal(s.passageLabel([max.id, noa.id]), 'Max & Noa · Table 4', 'même table une seule fois');
  assert.equal(s.passageLabel([max.id]), 'Max · Table 4', 'une personne de table ne change pas');
  assert.deepEqual(s.passageTables([lea.id, max.id, zoe.id]), ['Table 4', 'Table 2']);
  assert.equal(s.passageLabel([lea.id, 'inconnu']), 'Léa', 'personne inconnue ignorée');
  // Règle tenue par le groupe individuel, pas par son nom.
  s.table('Comptoir').name = 'Solistes';
  assert.equal(s.passageLabel([lea.id]), 'Léa');
  s.table('Comptoir-2', true);
  const ines = s.join({ tableId: 'Comptoir-2', name: 'Inès' });
  assert.equal(s.table('Comptoir-2').individual, true);
  assert.equal(s.passageLabel([ines.id, max.id]), 'Inès & Max · Table 4');
});

test('select() : le nom envoyé à KaraFun est le prénom seul d’un soliste', () => {
  const { s, lea } = world();
  s.chooseSong(lea, song(11));
  const sel = s.select();
  assert.deepEqual(sel.ids, [lea.id]);
  assert.equal(sel.label, 'Léa');
  const view = s.readyView().find(v => v.ids[0] === lea.id);
  assert.equal(view.label, 'Léa', 'passage prévu : même nom');
  assert.equal(view.table, '', 'page du bar : pas d’étiquette de groupe');
});

test('readyView : un duo soliste + table ne montre que la table', () => {
  const { s, lea, max } = world();
  s.chooseSong(max, song(12));
  const view = s.readyView().find(v => v.ids[0] === max.id);
  assert.equal(view.label, 'Max · Table 4');
  assert.equal(view.table, 'Table 4');
  // Duo noté sur un passage prévu : label recalculé à partir des personnes.
  assert.equal(s.passageLabel([lea.id, max.id]), 'Léa & Max · Table 4');
});

test('départ de l’invitée d’un duo déjà envoyé : prénom seul de l’auteur soliste ; envoi sans accusé gardé', () => {
  const { s, lea, sam, max } = world();
  const sel = { ids: [lea.id, sam.id], names: ['Léa', 'Sam'], kind: 'duo', label: 'Léa & Sam · En solo', song: { ...song(13), entryId: 'e13' } };
  s.leaveSentDuet(sel, sam.id);
  assert.equal(sel.label, 'Léa', 'reste « Léa », jamais « Léa · En solo »');
  const table = { ids: [max.id, lea.id], names: ['Max', 'Léa'], kind: 'duo', label: 'Max & Léa · Table 4', song: { ...song(14), entryId: 'e14' } };
  s.leaveSentDuet(table, lea.id);
  assert.equal(table.label, 'Max · Table 4');
  const unacked = { ids: [lea.id, max.id], names: ['Léa', 'Max'], kind: 'duo', label: 'Léa & Max · Table 4', song: { ...song(15), entryId: 'e15' } };
  s.leaveSentDuet(unacked, max.id, { keepLabel: true });
  assert.equal(unacked.label, 'Léa & Max · Table 4', 'envoi sans accusé : KaraFun le reconnaît sous son ancien nom');
});

test('journal du bar : un soliste sans son groupe, une personne de table avec sa table', () => {
  const { s, lea, max } = world();
  const notes = () => s.log.map(entry => entry.msg);
  assert.ok(notes().includes('Léa s\'est inscrit'), notes().join('\n'));
  assert.ok(notes().includes('Max (Table 4) s\'est inscrit'));
  s.chooseSong(lea, song(16));
  assert.ok(notes().some(msg => /^Léa entre dans la file en \d/.test(msg)));
  s.chooseSong(max, song(17));
  assert.ok(notes().some(msg => /^Max \(Table 4\) entre dans la file/.test(msg)));
  s.rename(lea, 'Lucie');
  assert.ok(notes().includes('Léa s\'appelle maintenant Lucie'));
  s.rename(max, 'Maxime');
  assert.ok(notes().includes('Max (Table 4) s\'appelle maintenant Maxime'));
  // QR ouvert : le prénom donné ensuite inscrit la personne, sans son groupe.
  const solo = s.join({ tableId: 'Comptoir', name: 'Solo 3', nameRequired: true });
  s.rename(solo, 'Ana');
  assert.ok(notes().includes('Ana s\'est inscrit'));
  assert.ok(!notes().some(msg => /\(En solo\)/.test(msg)), 'jamais « (En solo) » à côté d’un prénom');
});

test('prénom « Battle collective » refusé (inscription et changement de prénom)', () => {
  const { s, lea } = world();
  for (const name of ['Battle collective', '  battle   COLLECTIVE ']) {
    assert.throws(() => s.join({ tableId: 'Comptoir', name }), error => error.code === 'NAME_RESERVED' &&
      error.message === 'Ce prénom est réservé à la Battle. Choisis un autre prénom.');
  }
  assert.throws(() => s.rename(lea, 'Battle Collective'), /réservé à la Battle/);
  assert.equal(s.join({ tableId: '4', name: 'Battle' }).name, 'Battle', 'un autre prénom proche reste possible');
});

// Regression: relecture du lot K — un soliste nommé par son seul prénom ne
// doit pas pouvoir prendre le nom d'une personne de table ni d'un autre soliste.
test('prénoms : « · » refusé, deux solistes de groupes individuels différents jamais homonymes', () => {
  const { s, lea, max } = world();
  for (const name of ['Max · Table 4', 'Max·4', 'Max ∙ Table 4', 'Max • Table 4', 'Max ⋅ Table 4', 'Max ・ Table 4']) {
    assert.throws(() => s.join({ tableId: 'Comptoir', name }), error => error.code === 'NAME_INVALID' &&
      error.message === 'Le prénom ne peut pas contenir « · ».');
  }
  assert.throws(() => s.join({ tableId: '2', name: 'Zoé · Table 2' }), /ne peut pas contenir « · »/);
  assert.throws(() => s.rename(max, 'Max · Table 2'), /ne peut pas contenir « · »/);
  const other = s.table('Comptoir-2');
  assert.equal(other.individual, true);
  assert.throws(() => s.join({ tableId: 'Comptoir-2', name: ' léa ' }), error => error.code === 'NAME_TAKEN' &&
    error.message === 'Ce prénom est déjà inscrit ce soir. Ajoute l’initiale de ton nom (ex. Marie L.).');
  assert.throws(() => s.join({ tableId: 'Comptoir', name: 'Léa' }), /déjà inscrit ce soir/, 'même groupe aussi');
  const lou = s.join({ tableId: 'Comptoir-2', name: 'Lou' });
  assert.throws(() => s.rename(lou, 'LÉA'), error => error.code === 'NAME_TAKEN');
  assert.equal(s.rename(lea, 'Léa').name, 'Léa', 'son propre prénom reste possible');
  assert.equal(s.join({ tableId: '2', name: 'Léa' }).name, 'Léa', 'une personne de table « Léa · Table 2 » se distingue');
  assert.throws(() => s.join({ tableId: '4', name: 'Max' }), /déjà inscrit à cette table/);
  assert.deepEqual(s.nameRivals('Comptoir-2').map(p => p.name).sort(), ['Lou', 'Léa', 'Sam']);
});

test('« À suivre » dans le journal : nom recalculé, jamais le texte reçu par KaraFun à l’ancien format', () => {
  const { s, lea, max } = world();
  s.chooseSong(lea, song(18));
  const sel = s.select();
  sel.label = 'Léa · En solo';
  s.commit(sel);
  assert.equal(s.log.at(-1).msg, 'À suivre : Léa — « Titre 18 »');
  assert.equal(sel.label, 'Léa · En solo', 'le nom reconnu dans KaraFun ne change pas');
  s.chooseSong(max, song(19));
  const gone = s.select();
  gone.label = 'Max · Table 4';
  gone.ids = [max.id, 'parti'];
  s.commit(gone);
  assert.equal(s.log.at(-1).msg, 'À suivre : Max · Table 4 — « Titre 19 »', 'personne sortie de la soirée : texte enregistré');
});

test('duo noté par le bar : une personne sans prénom (« Solo N ») est refusée', () => {
  const { s, lea } = world();
  const solo = s.join({ tableId: 'Comptoir', name: 'Solo 4', nameRequired: true });
  assert.throws(() => s.staffCountPartner(lea.id, solo.id), /n’a pas encore saisi son prénom/);
});

// ------------------------------------------------------------------ serveur
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const overrides = { './scheduler': (() => {
    const real = fromServer('./scheduler');
    return { ...real, Scheduler: class extends real.Scheduler { constructor(o) { super({ ...o, solverEnabled: false }); } } };
  })() };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), '--demo'];
  const context = { require: name => name === 'fs' ? quietFs : overrides[name] || fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL,
    setTimeout: () => ({ unref() {} }), clearTimeout() {}, setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, access, settings, handlers, sync, staffState, publicState, ensureSoloGroup, resendWithoutOptions,
      STAFF_KEY, PORT, handle: server.listeners('request')[0],
      tracked: () => tracked, pending: () => pending, restart: () => restartOp, setBridge: b => { bridge = b; },
      setPending: p => { pending = p; },
      snapshot: () => snapshotNight({ scheduler: sched, access, settings, pending, tracked }),
      restore: snap => {
        const r = restoreNight(snap, { scheduler: sched, access, settings });
        pending = r.pending; tracked = r.tracked; recoveredPending = r.recoveredPending;
        return r;
      } };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  f.ensureSoloGroup();
  f.sched.setHeadcount('4', 8, 'staff');
  f.access.issue('4');
  const bridge = {
    ready: true, connected: true, queue: [], status: { state: 'idle' }, adds: [], removed: [],
    // Réglages du titre dans l'ajout : renvoyés comme le vrai pont.
    add(songId, singer, position, settings) { this.adds.push({ songId, singer, position }); return settings ? { ...settings } : null; },
    play() {}, next() {}, remove(queueId) { this.removed.push(queueId); }, snapshot() { return {}; },
  };
  f.setBridge(bridge);
  return Object.assign(f, { bridge,
    person(tableId, name, extra = {}) { return f.sched.join({ tableId, name, ...extra }); },
    // Titre envoyé et suivi sous `queueId`, avec le nom que KaraFun a reçu.
    sent(queueId, ids, songId, label = null) {
      const people = ids.map(pid => f.sched.people.get(pid));
      f.sched.chooseSong(people[0], song(songId));
      const sel = f.sched.select();
      sel.song.settings = { pitch: 2 };
      assert.deepEqual(sel.ids, [ids[0]]);
      f.sched.commit(sel);
      if (ids.length > 1) { sel.ids = [...ids]; sel.names = people.map(p => p.name); sel.kind = 'duo'; }
      if (label) sel.label = label;
      const tr = { queueId, sel, addedAt: Date.now(), startedAt: null };
      f.tracked().push(tr);
      return { tr, item: { queueId, songId, title: sel.song.title, artist: 'Artiste', singer: sel.label } };
    },
    play(item, rest = []) {
      bridge.queue = [item, ...rest];
      bridge.status = { state: 'playing', songPlaying: item };
      f.sync();
    },
  });
}

function call(f, url, body, method = 'POST') {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers: {}, socket: { remoteAddress: '127.0.0.1', localPort: f.PORT }, destroy() {} });
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
    setImmediate(() => { if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); });
  });
}

test('serveur : soliste « Léa » sur scène, dans la file et en préparation ; table « Max · Table 4 »', () => {
  const f = harness();
  assert.equal(f.sched.table('Comptoir').name, 'En solo');
  assert.equal(f.sched.table('Comptoir').individual, true);
  const lea = f.person('Comptoir', 'Léa'), max = f.person('4', 'Max');
  const { item } = f.sent('q-1', [lea.id], 21);
  assert.equal(item.singer, 'Léa', 'nom reçu par KaraFun');
  f.play(item);
  f.sched.chooseSong(max, song(22));
  f.sched.chooseSong(f.person('Comptoir', 'Sam'), song(23));
  const state = plain(f.publicState());
  assert.equal(state.stage.singer, 'Léa');
  const helpers = state.queue.filter(line => line.source === 'helper');
  assert.deepEqual(helpers.map(line => line.singer).sort(), ['Max · Table 4', 'Sam']);
  assert.deepEqual(helpers.map(line => line.table).sort(), ['', 'Table 4'], 'bar : pas d’étiquette « En solo »');
  assert.doesNotMatch(JSON.stringify(state.queue.map(line => line.singer)), /En solo/);
});

// Relecture finale, quatrième passe (K6) : le nom d'un passage envoyé est
// recalculé à partir de ses personnes. Un prénom changé après l'envoi se
// voit sur scène, dans la file et sur la carte Scène du bar ; KaraFun garde
// le nom reçu, sous lequel le titre est reconnu.
test('serveur : prénom changé après l’envoi, nouveau nom sur scène, dans la file et sur la carte Scène du bar', () => {
  const f = harness();
  const lea = f.person('Comptoir', 'Léa'), max = f.person('4', 'Max');
  const solo = f.sent('q-1', [lea.id], 71);
  const table = f.sent('q-2', [max.id], 72);
  assert.deepEqual([solo.item.singer, table.item.singer], ['Léa', 'Max · Table 4'], 'noms reçus par KaraFun');
  f.sched.rename(lea, 'Lucie');
  f.sched.rename(max, 'Maxime');
  f.play(solo.item, [table.item]);
  let state = plain(f.publicState());
  assert.equal(state.stage.singer, 'Lucie');
  assert.equal(state.queue.find(line => line.queueId === 'q-2').singer, 'Maxime · Table 4');
  // Regression: seconde passe de la relecture du correctif CI Windows — le
  // prénom d'une ligne envoyée (`name`, lu par la file du bar et les avis des
  // téléphones) restait celui noté à l'envoi, même après la reprise qui
  // numérote un soliste homonyme.
  assert.equal(state.queue.find(line => line.queueId === 'q-2').name, 'Maxime');
  assert.equal(plain(f.staffState()).queue.find(line => line.queueId === 'q-2').name, 'Maxime', 'file du bar');
  assert.equal(plain(f.staffState()).stage.singer, 'Lucie', 'carte Scène du bar');
  // Le titre de Maxime sur scène : nom de table recalculé lui aussi.
  f.play(table.item);
  state = plain(f.publicState());
  assert.equal(state.stage.singer, 'Maxime · Table 4');
  assert.equal(plain(f.staffState()).stage.singer, 'Maxime · Table 4');
  assert.deepEqual([solo.tr.sel.label, table.tr.sel.label], ['Léa', 'Max · Table 4'], 'noms reçus par KaraFun inchangés');
});

test('serveur : soirée enregistrée à l’ancien format, affichée au nouveau ; KaraFun reconnu sous le nom enregistré', () => {
  const old = harness();
  const lea = old.person('Comptoir', 'Léa'), max = old.person('4', 'Max');
  const { item } = old.sent('q-1', [lea.id], 31, 'Léa · En solo');
  // Envoi interrompu (duo soliste + table) au nom de l'ancienne version.
  old.sched.chooseSong(lea, song(32));
  const next = old.sched.select();
  next.ids = [lea.id, max.id]; next.names = ['Léa', 'Max']; next.kind = 'duo';
  next.label = 'Léa & Max · En solo + Table 4';
  old.setPending({ sel: next, before: new Set(['q-1']), at: Date.now(), attempts: 1, retryAt: null });
  const snap = plain(old.snapshot());
  assert.equal(snap.tracked[0].sel.label, 'Léa · En solo');

  const f = harness();
  f.restore(snap);
  f.play(item);
  const state = plain(f.publicState());
  assert.equal(state.stage.singer, 'Léa', 'scène : nouveau format tout de suite');
  const sending = state.queue.find(line => line.source === 'envoi');
  assert.equal(sending.singer, 'Léa & Max · Table 4', 'envoi en cours : recalculé');
  assert.equal(sending.table, 'Table 4');
  assert.equal(plain(f.staffState()).pending.label, 'Léa & Max · Table 4', 'bar : « Envoi en cours à KaraFun »');
  assert.equal(f.tracked()[0].sel.label, 'Léa · En solo', 'le texte enregistré ne change pas');
  // KaraFun montre le nom qu'il a reçu : l'envoi y est reconnu sous ce nom-là.
  f.play(item, [{ queueId: 'q-9', songId: 32, title: 'Titre 32', singer: 'Léa & Max · Table 4' }]);
  assert.ok(f.pending(), 'un autre nom ne vaut pas accusé');
  f.play(item, [{ queueId: 'q-2', songId: 32, title: 'Titre 32', singer: 'Léa & Max · En solo + Table 4' }]);
  assert.equal(f.pending(), null, 'accusé reçu sous le nom enregistré');
  const sent = f.tracked().find(tr => tr.queueId === 'q-2');
  assert.equal(sent.sel.label, 'Léa & Max · En solo + Table 4');
  const line = plain(f.publicState()).queue.find(row => row.queueId === 'q-2');
  assert.equal(line.singer, 'Léa & Max · Table 4', 'file des téléphones : nouveau format');
  assert.equal(line.table, 'Table 4');
  // Regression: relecture du lot K — l'accusé écrit « À suivre » au nouveau format.
  const notes = f.sched.log.map(entry => entry.msg);
  assert.ok(notes.includes('À suivre : Léa & Max · Table 4 — « Titre 32 »'), notes.join('\n'));
  assert.ok(!notes.some(msg => /En solo/.test(msg)), 'journal du bar sans « En solo »');
});

test('serveur : ligne KaraFun non suivie, le groupe des solistes retiré à l’affichage', () => {
  const f = harness();
  f.sched.table('Comptoir').name = 'Solistes';
  const lines = [
    { queueId: 'k1', songId: 41, title: 'A', singer: 'Zoé · En solo' },
    { queueId: 'k2', songId: 42, title: 'B', singer: 'Zoé & Paul · En solo + Table 2' },
    { queueId: 'k3', songId: 43, title: 'C', singer: 'Paul & Zoé · Table 2 + Solistes' },
    { queueId: 'k4', songId: 44, title: 'D', singer: 'Inès · Solistes' },
    { queueId: 'k5', songId: 45, title: 'E', singer: 'Bob · Table 9' },
    { queueId: 'k6', songId: 46, title: 'F', singer: 'Chorale' },
  ];
  f.play({ queueId: 'k0', songId: 40, title: 'Scène', singer: 'Léa · En solo' }, lines);
  const state = plain(f.publicState());
  assert.equal(state.stage.singer, 'Léa');
  assert.equal(state.stage.ours, false);
  assert.deepEqual(state.queue.map(line => line.singer), ['Zoé', 'Zoé & Paul · Table 2', 'Paul & Zoé · Table 2', 'Inès', 'Bob · Table 9', 'Chorale']);
  assert.deepEqual(state.queue.map(line => line.name), ['Zoé', 'Zoé & Paul · Table 2', 'Paul & Zoé · Table 2', 'Inès', 'Bob · Table 9', 'Chorale'],
    'nom des avis de doublon');
  assert.equal(plain(f.staffState()).stage.singer, 'Léa', 'carte Scène du bar');
});

test('serveur : « Relancer » renvoie le nom recalculé et reconnaît la copie sous ce nom, réglages refusés compris', async () => {
  const f = harness();
  const lea = f.person('Comptoir', 'Léa');
  const { tr, item } = f.sent('q-1', [lea.id], 51, 'Léa · En solo');
  f.play(item);
  await f.handlers['POST /api/staff/kf']({}, {}, { action: 'restart' });
  assert.equal(f.bridge.adds.length, 1);
  assert.equal(f.bridge.adds[0].singer, 'Léa', 'copie ajoutée sous le nom recalculé');
  assert.equal(f.restart().singer, 'Léa');
  assert.ok(f.restart().sentSettings, 'copie envoyée avec ses réglages');
  // KaraFun refuse les réglages de la copie : elle repart sans eux, même nom.
  f.resendWithoutOptions({ songId: 51, singer: 'Léa' });
  assert.equal(f.bridge.adds.length, 2, 'nouvel envoi sans réglages');
  assert.deepEqual(f.bridge.adds[1], { songId: 51, singer: 'Léa', position: 1 });
  // Une copie sous l'ancien nom n'est pas la nôtre ; celle sous le nouveau l'est.
  f.play(item, [{ ...item, queueId: 'q-old', singer: 'Léa · En solo' }]);
  assert.equal(tr.queueId, 'q-1');
  f.play(item, [{ ...item, queueId: 'q-2', singer: 'Léa' }]);
  assert.equal(tr.queueId, 'q-2', 'la copie reprend le suivi du titre');
});

// Regression: relecture du lot K — une ligne de KaraFun non suivie, encore au
// nom de l'ancienne version, est relancée sous le nom que la carte Scène montre.
test('serveur : « Relancer » une ligne KaraFun non suivie retire le groupe des solistes du nom renvoyé', async () => {
  const f = harness();
  const line = { queueId: 'k0', songId: 80, title: 'Scène', singer: 'Léa & Bob · En solo + Table 9' };
  f.play(line);
  assert.equal(plain(f.staffState()).stage.singer, 'Léa & Bob · Table 9');
  await f.handlers['POST /api/staff/kf']({}, {}, { action: 'restart' });
  assert.deepEqual(f.bridge.adds.map(add => add.singer), ['Léa & Bob · Table 9'], 'même nom que la carte Scène');
  assert.equal(f.restart().singer, 'Léa & Bob · Table 9');
  // La copie arrive sous ce nom : reconnue (l'ancien nom ne l'est pas).
  f.play(line, [{ ...line, queueId: 'k-old', singer: 'Léa & Bob · En solo + Table 9' }]);
  assert.equal(f.restart().copyQueueId, undefined, 'l’ancien nom n’est pas la copie');
  f.play(line, [{ ...line, queueId: 'k1', singer: 'Léa & Bob · Table 9' }]);
  assert.equal(f.restart().copyQueueId, 'k1', 'copie reconnue sous le nom renvoyé');
  const other = harness();
  other.play({ queueId: 'm0', songId: 81, title: 'Scène', singer: 'Bob · Table 9' });
  await other.handlers['POST /api/staff/kf']({}, {}, { action: 'restart' });
  assert.equal(other.bridge.adds[0].singer, 'Bob · Table 9', 'nom sans groupe individuel : inchangé');
});

test('serveur : duo noté par le bar sur un soliste, partenaire sans prénom refusé', async () => {
  const f = harness();
  const lea = f.person('Comptoir', 'Léa'), max = f.person('4', 'Max');
  const solo = f.person('Comptoir', 'Solo 5', { nameRequired: true });
  const { tr, item } = f.sent('q-1', [lea.id], 61);
  f.play(item);
  await assert.rejects(f.handlers['POST /api/staff/duo-mark']({}, {}, { queueId: 'q-1', partnerId: solo.id }),
    /n’a pas encore saisi son prénom/);
  assert.equal(tr.sel.ids.length, 1, 'rien n’a changé');
  await f.handlers['POST /api/staff/duo-mark']({}, {}, { queueId: 'q-1', partnerId: max.id });
  assert.equal(tr.sel.label, 'Léa & Max · Table 4');
  assert.equal(tr.sel.staffDuo.labelBefore, 'Léa');
  assert.equal(plain(f.publicState()).stage.singer, 'Léa & Max · Table 4');
  // Remplacement par une personne sans prénom : refusé avant d'annuler le duo.
  await assert.rejects(f.handlers['POST /api/staff/duo-mark']({}, {}, { queueId: 'q-1', partnerId: solo.id, replace: true }),
    /n’a pas encore saisi son prénom/);
  assert.deepEqual(tr.sel.ids, [lea.id, max.id]);
});

test('serveur : partenaires de duo, alerte « n’a pas répondu », réactivation et prénom réservé', async () => {
  const f = harness();
  const lea = f.person('Comptoir', 'Léa');
  f.person('4', 'Max');
  f.person('Comptoir', 'Solo 6', { nameRequired: true });
  const partners = await call(f, `/api/duo/partners?table=4&access=${f.access.get('4')}`, undefined, 'GET');
  assert.equal(partners.status, 200, partners.text);
  assert.deepEqual(partners.body.map(p => [p.name, p.table, !!p.individual]), [['Léa', '', true], ['Max', 'Table 4', false]],
    'soliste sans nom de groupe ; prénom provisoire jamais proposé');
  lea.maybeGone = { title: 'Titre', skips: 2, at: Date.now() };
  assert.equal(plain(f.staffState()).maybeGone[0].table, '', 'alerte : « Léa n’a pas répondu », sans « (En solo) »');
  lea.withdrawnAt = Date.now();
  await f.handlers['POST /api/staff/person/reactivate']({}, {}, { personId: lea.id });
  assert.ok(f.sched.log.some(entry => entry.msg === 'Léa revient ; son historique de passages est conservé'));
  const reserved = await call(f, '/api/table/person', { table: '4', access: f.access.get('4'), name: 'Battle collective' });
  assert.equal(reserved.status, 400);
  assert.equal(reserved.body.error, 'Ce prénom est réservé à la Battle. Choisis un autre prénom.');
});
