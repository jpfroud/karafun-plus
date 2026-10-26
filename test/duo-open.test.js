'use strict';
// Duo ouvert, « Qui veut chanter en duo avec moi ? » (spec du 26 octobre
// 2026, F1) : un titre cherche un partenaire dans toute la salle. Comme une
// invitation sans réponse, il passe comme un solo et, sans volontaire à son
// tour, part en solo à l'accusé de KaraFun ; en « Duos uniquement », il
// attend. Le premier volontaire devient l'invité, quelle que soit sa table ;
// les suivants sont refusés.
// server.js est chargé dans un bac à sable `vm` (--demo), sans port ouvert,
// sauf le faux KaraFun (fake-karafun.js) sur un port libre.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { Scheduler } = require('../scheduler');
const { TableAccess } = require('../table-access');
const { snapshotNight, restoreNight } = require('../night-state');
const { computeStats } = require('../evening-stats');
const { startFakeKaraFun } = require('../fake-karafun');

const root = path.join(__dirname, '..');
const song = (songId, title) => ({ songId, title, artist: 'Artiste' });
const plain = value => JSON.parse(JSON.stringify(value));
const inbox = p => (p.inbox || []).map(n => [n.kind, n.params]);
const names = (s, ids) => ids.map(pid => s.people.get(pid).name).join(' & ');

// Léa (table 1), Max (table 3) avec son propre titre, Zoé seule (« En solo »).
function night() {
  const s = new Scheduler();
  const events = [];
  s._event = (type, fields) => events.push([type, fields]);
  const lea = s.join({ tableId: '1', name: 'Léa', headcount: 2 });
  const max = s.join({ tableId: '3', name: 'Max', headcount: 2 });
  const zoe = s.join({ tableId: 'Comptoir', name: 'Zoé' });
  s.chooseSong(max, song(5, 'Cinq'));
  return { s, events, lea, max, zoe };
}
const of = (events, type) => events.filter(([kind]) => kind === type).map(([, fields]) => fields);

// ---------------------------------------------------------------- ordonnanceur
test('ouvrir : titre du catalogue ou de la liste, un seul à la fois, jamais sans prénom', () => {
  const { s, events, lea, max, zoe } = night();
  const open = s.openDuet(lea, { song: song(1, 'Titre') });
  assert.equal(lea.song, open, 'ajouté à la liste de Léa');
  assert.deepEqual(Object.keys(open.duet).sort(), ['openedAt', 'state']);
  assert.equal(open.duet.state, 'open');
  assert.ok(Number.isFinite(open.duet.openedAt));
  assert.equal(open.duet.partnerId, undefined, 'pas de partenaire');
  assert.deepEqual(of(events, 'duo.openRequested'), [{ personId: lea.id, entryId: open.entryId, fromCatalog: true }]);
  assert.ok(s.log.some(line => line.msg === 'Léa (Table 1) cherche un partenaire pour chanter « Titre » en duo'));
  assert.deepEqual(s.openDuets().map(row => [row.owner.id, row.entryId]), [[lea.id, open.entryId]]);
  // Critère 5 : un second duo ouvert de Léa est refusé tant que le premier est ouvert.
  const message = 'Un seul duo ouvert à la fois : ferme d’abord ta demande en cours.';
  assert.throws(() => s.openDuet(lea, { song: song(2, 'Deux') }), { message });
  s.chooseSong(lea, song(3, 'Trois'), 'append');
  assert.throws(() => s.openDuet(lea, { entryId: lea.backlog[0].entryId }), { message });
  assert.deepEqual(s.songsOf(lea).map(item => item.title), ['Titre', 'Trois'], 'rien d’ajouté par le refus');
  // Titre déjà dans la liste : Max.
  const listed = s.openDuet(max, { entryId: max.song.entryId });
  assert.equal(listed, max.song);
  assert.equal(listed.duet.state, 'open');
  assert.equal(of(events, 'duo.openRequested')[1].fromCatalog, false);
  // Place sans prénom : refusée, ni titre ni volontaire.
  const placeholder = s.join({ tableId: 'Comptoir', name: 'Solo 1', nameRequired: true });
  assert.throws(() => s.openDuet(placeholder, { song: song(4, 'Quatre') }), { message: 'Indique d’abord ton prénom.' });
  assert.deepEqual(s.songsOf(placeholder), []);
  assert.throws(() => s.acceptOpenDuet(placeholder, lea.id, open.entryId), { message: 'Indique d’abord ton prénom.' });
  assert.equal(open.duet.state, 'open');
  // Un titre déjà en duo, ou que d'autres demandent à chanter, ne s'ouvre pas.
  const invite = s.inviteDuet(zoe, max.id, song(6, 'Six'));
  assert.throws(() => s.openDuet(zoe, { entryId: invite.entryId }), { message: 'Ce titre est déjà prévu en duo.' });
  s.chooseSong(zoe, song(7, 'Sept'), 'append');
  const asked = zoe.backlog[0];
  s.requestDuetJoin(lea, zoe.id, asked.entryId);
  assert.throws(() => s.openDuet(zoe, { entryId: asked.entryId }),
    { message: 'Des personnes demandent déjà à chanter ce titre avec toi : réponds-leur d’abord.' });
  // « Duo ? » sur un duo ouvert : renvoyé vers « Je chante avec ».
  assert.throws(() => s.requestDuetJoin(zoe, lea.id, open.entryId),
    { message: 'Ce titre cherche déjà un partenaire : appuie sur « Je chante avec » pour le rejoindre.' });
});

test('sans volontaire, il passe comme un solo : place, présence de l’auteur seul, ni Timefold ni ordre du bar relancés', () => {
  const { s, lea, max } = night();
  s.chooseSong(lea, song(1, 'Titre'));
  const fingerprints = () => [s.solverContextFingerprint(), s.manualContextFingerprint()];
  const before = fingerprints();
  const open = s.openDuet(lea, { entryId: lea.song.entryId });
  assert.deepEqual(fingerprints(), before, 'il passe comme avant : le plan et l’ordre du bar restent');
  const lines = s.readyView();
  assert.deepEqual(lines.map(line => [names(s, line.ids), line.song.title]).sort(), [['Léa', 'Titre'], ['Max', 'Cinq']]);
  const mine = lines.find(line => line.ids[0] === lea.id);
  assert.equal(mine.kind, undefined, 'pas un duo');
  assert.equal(mine.song.duet.state, 'open', 'la ligne garde la demande pour l’affichage');
  if (s.select().ids[0] !== lea.id) s.commit(s.select()); // Max d'abord, s'il passe avant
  const sel = s.select();
  assert.deepEqual(sel.ids, [lea.id]);
  assert.equal(sel.label, 'Léa · Table 1', 'KaraFun reçoit le nom de Léa seule');
  assert.equal(open.duet.state, 'open', 'rien n’expire avant l’envoi');
  assert.equal(max.duetGuestCount || 0, 0);
});

test('premier volontaire : duo accepté quelle que soit sa table, le second est refusé, jamais deux places', () => {
  const { s, events, lea, max, zoe } = night();
  const open = s.openDuet(lea, { song: song(1, 'Titre') });
  assert.throws(() => s.acceptOpenDuet(lea, lea.id, open.entryId), { message: 'C’est déjà ton titre.' });
  const accepted = s.acceptOpenDuet(max, lea.id, open.entryId);
  assert.equal(accepted, open);
  assert.deepEqual(open.duet, { partnerId: max.id, state: 'accepted' });
  assert.deepEqual(s.openDuets(), [], 'plus aucun bandeau');
  // Critère 2 : un second « Je chante » reçoit le refus prévu.
  assert.throws(() => s.acceptOpenDuet(zoe, lea.id, open.entryId), { message: 'Quelqu’un a déjà rejoint ce duo.' });
  assert.deepEqual(open.duet, { partnerId: max.id, state: 'accepted' }, 'Max reste l’invité');
  assert.deepEqual(inbox(lea), [['openAccepted', { name: 'Max', title: 'Titre' }]], 'Léa est prévenue');
  assert.deepEqual(inbox(zoe), []);
  assert.deepEqual(of(events, 'duo.openAccepted'), [{ personId: max.id, ownerId: lea.id, partnerId: max.id, entryId: open.entryId }]);
  assert.ok(s.log.some(line => line.msg === 'Max (Table 3) rejoint Léa en duo sur « Titre » : seul Léa dépense son tour'));
  // L'invité garde son titre et son tour : un seul ticket chacun.
  assert.equal(max.song.title, 'Cinq');
  assert.deepEqual(s.guestDuetsOf(max).map(row => row.entryId), [open.entryId]);
  const view = s.readyView();
  assert.deepEqual(view.map(line => [names(s, line.ids), line.song.title, line.kind || 'solo']),
    [['Léa & Max', 'Titre', 'duo'], ['Max', 'Cinq', 'solo']]);
  // Hors événement privé, une personne n'a jamais deux places dans la rotation.
  const zoeDuet = s.openDuet(max, { entryId: max.song.entryId });
  s.acceptOpenDuet(zoe, max.id, zoeDuet.entryId);
  assert.ok(!s.Q.includes(zoe.id), 'Zoé, sans titre, n’entre pas dans la file en rejoignant un duo');
  assert.equal(new Set(s.Q).size, s.Q.length, 'aucun ticket en double');
  assert.deepEqual(s.Q.filter(pid => pid === max.id), [max.id], 'Max : un seul ticket, invité ou pas');
  // Demande fermée par son auteur : plus ouverte.
  const later = s.openDuet(zoe, { song: song(9, 'Neuf') });
  s.closeOpenDuet(zoe, later.entryId);
  assert.throws(() => s.acceptOpenDuet(lea, zoe.id, later.entryId), { message: 'Cette demande de duo n’est plus ouverte.' });
});

test('rejoint pendant une annonce ou un « Pas prêt » : comme une invitation acceptée', () => {
  const { s, lea, max, zoe } = night();
  s.commit(s.select()); // Max vient de chanter
  const open = s.openDuet(lea, { song: song(1, 'Titre') });
  s.chooseSong(zoe, song(2, 'Deux'));
  assert.deepEqual(s.reserveNext().ids, [lea.id], 'Léa annoncée, seule');
  s.acceptOpenDuet(max, lea.id, open.entryId);
  assert.equal(s.reservedNext, null, 'l’annonce faite pour un solo est libérée');
  assert.deepEqual(s.select().ids, [zoe.id], 'Max vient de chanter : Zoé, jamais montée sur scène, passe avant le duo');
  // « Pas prêt » en cours : le passage repoussé attend aussi l'invité.
  const other = night();
  other.s.chooseSong(other.zoe, song(2, 'Deux'));
  const titre = other.s.openDuet(other.lea, { song: song(1, 'Titre') });
  const first = other.s.presenceView().find(line => line.ids[0] === other.lea.id);
  other.s.deferPassage(other.lea.id, first, 1);
  assert.deepEqual(other.lea.deferral.ids, [other.lea.id]);
  other.s.acceptOpenDuet(other.zoe, other.lea.id, titre.entryId);
  assert.deepEqual(other.lea.deferral.ids, [other.lea.id, other.zoe.id]);
  assert.equal(other.s.deferralFor(other.zoe.id)?.ownerId, other.lea.id);
});

test('critère 3 : sans volontaire, le titre part en solo à l’accusé, Léa est prévenue, la demande se ferme partout', () => {
  for (const saved of [false, true]) {
    const { s, events, lea, max } = night();
    const open = s.openDuet(lea, { song: song(1, 'Titre') });
    if (s.select().ids[0] !== lea.id) s.commit(s.select()); // Max d'abord, s'il passe avant
    const selected = s.select();
    assert.deepEqual(selected.ids, [lea.id]);
    const sel = saved ? plain(selected) : selected;
    s.commit(sel);
    assert.equal(open.duet, undefined, 'demande close');
    assert.equal(sel.song.duet, undefined, 'le passage envoyé reste un solo');
    assert.deepEqual(s.openDuets(), []);
    assert.deepEqual(inbox(lea), [['openUnanswered', { title: 'Titre' }]]);
    assert.deepEqual(inbox(max), []);
    assert.deepEqual(of(events, 'duo.openExpired'), [{ ownerId: lea.id, entryId: open.entryId }], 'une seule expiration');
    assert.ok(s.log.some(line => line.kind === 'staff' &&
      line.msg === 'Personne n’a rejoint le duo ouvert de Léa : « Titre » est parti dans KaraFun, Léa le chante en solo'));
    assert.throws(() => s.acceptOpenDuet(max, lea.id, open.entryId),
      { message: 'Ce titre n’est plus en attente : il est peut-être déjà dans KaraFun.' });
    // Retiré de KaraFun sans être chanté : il revient en solo, sans demande.
    s.requeueUnplayed(selected);
    assert.equal(lea.song.entryId, open.entryId);
    assert.equal(lea.song.duet, undefined);
  }
});

test('critère 4 : en « Duos uniquement », sans partenaire, le titre ne part pas ; rejoint, il repasse dans la file', () => {
  const { s, lea, max, zoe } = night();
  let duoOnly = false;
  s.duoOnlyRule = () => duoOnly;
  s.chooseSong(lea, song(1, 'Titre'));
  s.Q = [lea.id, max.id];
  const open = s.openDuet(lea, { entryId: lea.song.entryId });
  assert.deepEqual(s.reserveNext().ids, [lea.id], 'annoncée avant que le bar passe en « Duos uniquement »');
  const before = s.solverContextFingerprint();
  duoOnly = true;
  assert.notEqual(s.solverContextFingerprint(), before, 'l’optimiseur reprend la file sans ce titre');
  assert.deepEqual(s.readyView().map(line => names(s, line.ids)), ['Max'], 'le titre de Léa attend hors de la file affichée');
  assert.deepEqual(s.select().ids, [max.id], 'il ne part pas : Max chante');
  assert.equal(s.reservedNext, null, 'l’annonce de Léa est libérée');
  assert.deepEqual(s._forecast(false, [], null, true).map(line => line.entryId), [max.song.entryId], 'ni dans la graine de Timefold');
  s.commit(s.select());
  assert.equal(open.duet.state, 'open', 'rien n’expire : il n’est pas parti');
  assert.equal(s.Q.indexOf(lea.id), 0, 'Léa garde sa place');
  assert.equal(s.select(), null, 'rien d’autre à envoyer');
  s.acceptOpenDuet(zoe, lea.id, open.entryId);
  assert.deepEqual(s.readyView().map(line => names(s, line.ids)), ['Léa & Zoé'], 'rejoint : il repasse dans la file');
  assert.deepEqual(s.select().ids, [lea.id, zoe.id]);
});

test('fermer, retirer, partir : la demande se ferme, le titre reste ou disparaît, tout est noté', () => {
  const { s, events, lea, max, zoe } = night();
  const open = s.openDuet(lea, { song: song(1, 'Titre') });
  s.cancelDuet(lea, open.entryId); // « Annuler duo » sur un duo ouvert : la demande se ferme
  assert.equal(lea.song, open, 'le titre reste dans la liste');
  assert.equal(open.duet, undefined, 'en solo');
  s.openDuet(lea, { entryId: open.entryId });
  s.closeOpenDuet(lea, open.entryId);
  assert.throws(() => s.closeOpenDuet(lea, open.entryId), { message: 'Cette demande de duo n’est plus ouverte.' });
  s.openDuet(lea, { entryId: open.entryId });
  s.removeSong(lea, open.entryId);
  const fromZoe = s.openDuet(zoe, { song: song(2, 'Deux') });
  s.leave(zoe);
  const fromMax = s.openDuet(max, { entryId: max.song.entryId });
  s.tableLeft('3');
  assert.deepEqual(of(events, 'duo.openClosed'), [
    { personId: lea.id, ownerId: lea.id, entryId: open.entryId, reason: 'self' },
    { personId: lea.id, ownerId: lea.id, entryId: open.entryId, reason: 'self' },
    { ownerId: lea.id, entryId: open.entryId, reason: 'removed' },
    { ownerId: zoe.id, entryId: fromZoe.entryId, reason: 'left' },
    { ownerId: max.id, entryId: fromMax.entryId, reason: 'left' }]);
  assert.deepEqual(s.openDuets(), []);
  assert.ok(!s.log.some(line => /duo annulé/i.test(line.msg)), 'pas de « duo annulé » : personne n’y chantait');
});

// ---------------------------------------------------------------- sauvegarde
test('critère 6 : redémarrage, la demande ouverte est reprise et visible ; une heure abîmée est réparée', () => {
  const { s, lea, max } = night();
  const access = new TableAccess();
  for (const t of s.tables.keys()) access.issue(t);
  const open = s.openDuet(lea, { song: song(1, 'Titre') });
  const settings = { auto: false, autoPlay: false, pushDelaySec: 0, playDelaySec: 0 };
  const snapshot = plain(snapshotNight({ scheduler: s, access, settings }));
  const restore = data => {
    const target = new Scheduler();
    restoreNight(plain(data), { scheduler: target, access: new TableAccess(), settings: { ...settings } });
    return target;
  };
  const back = restore(snapshot);
  const owner = back.people.get(lea.id);
  assert.deepEqual(owner.song.duet, { state: 'open', openedAt: open.duet.openedAt });
  assert.deepEqual(back.openDuets().map(row => [row.owner.id, row.entryId]), [[lea.id, open.entryId]]);
  assert.deepEqual(back.readyView().map(line => names(back, line.ids)), s.readyView().map(line => names(s, line.ids)),
    'même file qu’avant le redémarrage, Léa en solo');
  assert.equal(back.readyView().find(line => line.ids[0] === lea.id).ids.length, 1);
  back.acceptOpenDuet(back.people.get(max.id), lea.id, open.entryId);
  assert.deepEqual(owner.song.duet, { partnerId: max.id, state: 'accepted' });
  // Heure abîmée, champ en trop : l'état ouvert reste, seul l'abîmé disparaît.
  const broken = plain(snapshot);
  broken.scheduler.people.find(p => p.id === lea.id).song.duet = { state: 'open', openedAt: 'hier', partnerId: max.id };
  const repaired = restore(broken).people.get(lea.id).song.duet;
  assert.deepEqual(Object.keys(repaired).sort(), ['openedAt', 'state']);
  assert.ok(Number.isFinite(repaired.openedAt));
});

// ---------------------------------------------------------------- statistiques
test('statistiques : duos ouverts comptés, le volontaire attend le duo dès qu’il le rejoint (comme un duo accepté)', () => {
  const T0 = Date.UTC(2026, 9, 24, 20, 0);
  const T = minutes => T0 + minutes * 60000;
  const evening = joinEvents => {
    const events = [];
    const e = (minutes, ev, fields = {}) => events.push({ v: 1, seq: 0, t: T(minutes), ev, ...fields });
    e(0, 'app.started', { restored: false, offlineMs: 0 });
    for (const pid of ['p', 'q', 'g']) e(0, 'person.joined', { personId: pid, tableId: pid });
    e(0, 'song.requested', { personId: 'p', entryId: 'a1', title: 'a1' });
    joinEvents(e);
    e(10, 'stage.started', { queueId: 1, entryId: 'a1', ids: ['p', 'g'], ownerId: 'p', source: 'queue', title: 'a1' });
    e(14, 'stage.ended', { queueId: 1, playedSec: 240 });
    e(15, 'song.requested', { personId: 'q', entryId: 'b1', title: 'b1' });
    e(15, 'duo.openRequested', { personId: 'q', entryId: 'b1', fromCatalog: true });
    e(20, 'duo.openExpired', { ownerId: 'q', entryId: 'b1' });
    e(20, 'stage.started', { queueId: 2, entryId: 'b1', ids: ['q'], ownerId: 'q', source: 'queue', title: 'b1' });
    e(24, 'stage.ended', { queueId: 2, playedSec: 240 });
    e(25, 'song.requested', { personId: 'q', entryId: 'b2', title: 'b2' });
    e(25, 'duo.openRequested', { personId: 'q', entryId: 'b2', fromCatalog: true });
    e(26, 'duo.openClosed', { personId: 'q', ownerId: 'q', entryId: 'b2', reason: 'self' });
    events.sort((a, b) => a.t - b.t).forEach((x, i) => { x.seq = i + 1; });
    return computeStats({ meta: {}, events, now: T(60) });
  };
  const open = evening(e => {
    e(0, 'duo.openRequested', { personId: 'p', entryId: 'a1', fromCatalog: true });
    e(4, 'duo.openAccepted', { personId: 'g', ownerId: 'p', partnerId: 'g', entryId: 'a1' });
  });
  const joined = evening(e => {
    e(2, 'duo.joinRequested', { requesterId: 'g', ownerId: 'p', entryId: 'a1', direct: false });
    e(4, 'duo.joinAnswered', { personId: 'p', ownerId: 'p', requesterId: 'g', entryId: 'a1', accepted: true });
  });
  const d = open.global.duos;
  assert.deepEqual([d.openRequests, d.openAccepted, d.openExpired, d.openClosed], [3, 1, 1, 1]);
  assert.deepEqual([d.invites, d.accepted, d.joinRequests, d.joinAccepted], [0, 0, 0, 0], 'comptés à part');
  const guest = stats => stats.singers.find(row => row.id === 'g');
  assert.deepEqual(guest(open).stageWaits, { n: 1, guestN: 1, avgSec: 6 * 60, medianSec: 6 * 60, maxSec: 6 * 60 },
    'g attend son duo depuis qu’il l’a rejoint (4 → 10)');
  assert.deepEqual(guest(open).stageWaits, guest(joined).stageWaits, 'comme un duo accepté par son auteur');
  assert.equal(guest(open).guestTurns, guest(joined).guestTurns);
  assert.deepEqual(open.timeline.stages.map(st => [st.ids, st.kind]), joined.timeline.stages.map(st => [st.ids, st.kind]));
});

// ---------------------------------------------------------------- serveur
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const quietFs = { ...fs, mkdirSync() {}, appendFileSync() {}, writeFileSync() {}, renameSync() {},
    readdirSync() { return []; }, unlinkSync() {} };
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [...process.argv, '--demo'];
  const context = { require: name => name === 'fs' ? quietFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL, setTimeout, clearTimeout,
    setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, handlers, access, staffState, publicState, sync, connectKaraFun,
      tracked: () => tracked, setBridge: b => { bridge = b; }, getBridge: () => bridge, setFake: x => { fake = x; },
      setPending: p => { pending = p; }, getPending: () => pending };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  f.call = (route, body = {}) => f.handlers[route]({}, {}, body);
  f.view = (tableId, ids) => f.publicState(null, tableId, new Set(ids));
  return f;
}

function person(f, table, name, extra = {}) {
  if (!f.sched.table(table).individual) f.sched.table(table).headcount = 4;
  const p = f.sched.join({ tableId: table, name, ...extra });
  return { p, body: { table, access: f.access.get(table) || f.access.issue(table), personId: p.id, token: p.token } };
}

function serverNight() {
  const f = harness();
  const lea = person(f, '1', 'Léa'), max = person(f, '3', 'Max'), zoe = person(f, 'Comptoir', 'Zoé');
  return { f, lea, max, zoe };
}

test('critère 1 : Léa propose un titre en duo ouvert ; Max et Zoé voient le bandeau, Léa non, ni un téléphone sans prénom', async () => {
  const { f, lea, max, zoe } = serverNight();
  const result = plain(await f.call('POST /api/table/duet/open', { ...lea.body, song: song(1, 'Titre') }));
  assert.equal(result.ok, true);
  const entryId = lea.p.song.entryId;
  assert.equal(result.entryId, entryId);
  const banner = { ownerId: lea.p.id, ownerName: 'Léa', ownerLabel: 'Léa · Table 1', entryId, openedAt: lea.p.song.duet.openedAt,
    song: { songId: 1, title: 'Titre', artist: 'Artiste', img: null, duration: null } };
  assert.deepEqual(plain(f.view('3', [max.p.id]).openDuets), [{ ...banner, volunteerIds: [max.p.id] }], 'Max (table 3)');
  assert.deepEqual(plain(f.view('Comptoir', [zoe.p.id]).openDuets), [{ ...banner, volunteerIds: [zoe.p.id] }], 'Zoé (en solo)');
  assert.deepEqual(plain(f.publicState(zoe.p, zoe.p.tableId, new Set([zoe.p.id])).openDuets.map(row => row.entryId)), [entryId],
    'lecture par la clé personnelle');
  assert.deepEqual(plain(f.view('1', [lea.p.id]).openDuets), [], 'Léa ne voit pas son propre bandeau');
  assert.equal(f.view('3', []).openDuets, undefined, 'téléphone qui ne gère personne : rien n’est envoyé');
  const placeholder = person(f, 'Comptoir', 'Solo 2', { nameRequired: true });
  assert.equal(f.view('Comptoir', [placeholder.p.id]).openDuets, undefined, 'place sans prénom : rien');
  f.sched.leave(max.p);
  assert.equal(f.view('3', [max.p.id]).openDuets, undefined, 'personne partie : rien');
  // Téléphone de la table de Léa qui gère aussi Bob : Bob seul peut se proposer.
  const bob = person(f, '1', 'Bob');
  assert.deepEqual(plain(f.view('1', [lea.p.id, bob.p.id]).openDuets.map(row => row.volunteerIds)), [[bob.p.id]]);
  // Chez Léa : le titre porte la demande, sans partenaire.
  const own = f.view('1', [lea.p.id]).tablePeople.find(row => row.id === lea.p.id);
  assert.deepEqual(plain(own.songs[0].duet), { state: 'open', kind: 'duo' });
  assert.deepEqual(plain(own.duet), { state: 'open' });
  const line = f.view('Comptoir', [zoe.p.id]).queue.find(item => item.song?.entryId === entryId);
  assert.deepEqual(plain(line.song.duet), { state: 'open', kind: 'duo' }, 'file : repère du duo ouvert');
  // Bar : la ligne et la liste des demandes.
  const staff = f.staffState();
  assert.equal(staff.queue.find(item => item.song?.entryId === entryId).song.duet.state, 'open');
  assert.deepEqual(plain(staff.openDuets), [{ ownerId: lea.p.id, ownerName: 'Léa', table: 'Table 1', entryId,
    title: 'Titre', openedAt: banner.openedAt, held: false }]);
  // Refus clairs : second duo ouvert, place sans prénom.
  await assert.rejects(f.call('POST /api/table/duet/open', { ...lea.body, song: song(2, 'Deux') }),
    { message: 'Un seul duo ouvert à la fois : ferme d’abord ta demande en cours.' });
  await assert.rejects(f.call('POST /api/table/duet/open', { ...placeholder.body, song: song(3, 'Trois') }), { code: 'NAME_REQUIRED' });
  await assert.rejects(f.call('POST /api/table/duet/open/accept', { ...placeholder.body, ownerId: lea.p.id, entryId }), { code: 'NAME_REQUIRED' });
});

test('au plus trois bandeaux, les plus récents ; un titre de la liste s’ouvre aussi', async () => {
  const { f, lea, max, zoe } = serverNight();
  const others = ['Ana', 'Ben', 'Cléo'].map((name, i) => person(f, String(10 + i), name));
  for (const [index, singer] of [lea, ...others].entries()) {
    f.sched.chooseSong(singer.p, song(20 + index, `Titre ${singer.p.name}`));
    await f.call('POST /api/table/duet/open', { ...singer.body, entryId: singer.p.song.entryId });
    singer.p.song.duet.openedAt = 1000 + index;
  }
  assert.deepEqual(plain(f.view('3', [max.p.id]).openDuets.map(row => row.ownerName)), ['Cléo', 'Ben', 'Ana']);
  assert.equal(f.view('Comptoir', [zoe.p.id]).openDuets.length, 3);
});

test('critère 2 et la course : deux « Je chante » en même temps, un seul gagne, l’autre reçoit le refus', async () => {
  const { f, lea, max, zoe } = serverNight();
  await f.call('POST /api/table/duet/open', { ...lea.body, song: song(1, 'Titre') });
  const entryId = lea.p.song.entryId;
  const [first, second] = await Promise.allSettled([
    f.call('POST /api/table/duet/open/accept', { ...max.body, ownerId: lea.p.id, entryId }),
    f.call('POST /api/table/duet/open/accept', { ...zoe.body, ownerId: lea.p.id, entryId })]);
  assert.equal(first.status, 'fulfilled');
  assert.deepEqual(plain(first.value), { ok: true });
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.message, 'Quelqu’un a déjà rejoint ce duo.');
  assert.deepEqual(plain(lea.p.song.duet), { partnerId: max.p.id, state: 'accepted' }, 'Léa & Max');
  assert.deepEqual(plain(f.view('Comptoir', [zoe.p.id]).openDuets), [], 'Zoé ne voit plus le bandeau');
  const pub = f.view('3', [max.p.id]);
  assert.deepEqual(plain(pub.tablePeople[0].guestDuos.map(duo => duo.fromName)), ['Léa'], 'Max voit son duo');
  assert.deepEqual(plain(pub.queue.filter(item => item.source === 'helper').map(item => item.name)), ['Léa & Max']);
  assert.deepEqual(plain(f.view('1', [lea.p.id]).tablePeople[0].inbox.map(n => [n.kind, n.params])),
    [['openAccepted', { name: 'Max', title: 'Titre' }]]);
});

test('serveur : titre en route vers KaraFun, ni ouverture ni « Je chante », bandeau retiré ; « Duos uniquement » garde la demande', async () => {
  const { f, lea, max } = serverNight();
  f.sched.chooseSong(lea.p, song(1, 'Titre'));
  await f.call('POST /api/table/duet/open', { ...lea.body, entryId: lea.p.song.entryId });
  const entryId = lea.p.song.entryId;
  f.setPending({ sel: f.sched.select(), before: new Set(), at: Date.now(), attempts: 1, retryAt: null });
  const message = 'Ce titre est en cours d’envoi à KaraFun : le duo n’est plus possible.';
  await assert.rejects(f.call('POST /api/table/duet/open/accept', { ...max.body, ownerId: lea.p.id, entryId }), { message });
  assert.deepEqual(plain(f.view('3', [max.p.id]).openDuets), [], 'il partira en solo : plus de bandeau');
  await f.call('POST /api/table/duet/open/close', { ...lea.body, entryId });
  await assert.rejects(f.call('POST /api/table/duet/open', { ...lea.body, entryId }), { message });
  f.setPending(null);
  // « Duos uniquement » : la demande ne se ferme pas en solo, le titre attend.
  await f.call('POST /api/table/duet/open', { ...lea.body, entryId });
  f.settings.duoOnly = true;
  f.sched.version++;
  await assert.rejects(f.call('POST /api/table/duet/open/close', { ...lea.body, entryId }), { code: 'DUO_ONLY' });
  await assert.rejects(f.call('POST /api/table/duet/cancel', { ...lea.body, entryId }), { code: 'DUO_ONLY' });
  assert.ok(!f.view('3', [max.p.id]).queue.some(item => item.song?.entryId === entryId), 'hors de la file');
  assert.equal(f.staffState().openDuets[0].held, true, 'le bar sait pourquoi');
  assert.equal(f.sched.select(), null, 'il ne part pas');
  await f.call('POST /api/table/duet/open/accept', { ...max.body, ownerId: lea.p.id, entryId });
  assert.deepEqual(plain(f.view('3', [max.p.id]).queue.map(item => item.name)), ['Léa & Max'], 'rejoint : de nouveau dans la file');
  // « Nouvelle soirée » coupe le mode : la règle suit le réglage du bar.
  f.settings.duoOnly = false;
  assert.equal(f.sched._duoOnly(), false);
});

const freePort = () => new Promise(resolve => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`attente trop longue : ${what}`);
}

test('faux KaraFun : sans volontaire, le titre part en solo dans KaraFun et la demande expire à l’accusé', async t => {
  const { f, lea, max } = serverNight();
  const fake = await startFakeKaraFun({ port: await freePort(), code: '123456', songSeconds: 60, autoplay: false });
  t.after(() => fake.close());
  f.setFake(fake);
  f.connectKaraFun('123456');
  t.after(() => { f.settings.auto = false; f.getBridge()?.disconnect(); });
  await until(() => f.getBridge()?.ready, 'connexion au faux KaraFun');
  const events = [];
  const journal = f.sched.onEvent;
  f.sched.onEvent = (type, fields) => { events.push([type, fields]); journal?.(type, fields); };
  await f.call('POST /api/table/duet/open', { ...lea.body, song: song(70000, 'Toxic') });
  const entryId = lea.p.song.entryId;
  assert.equal(f.view('3', [max.p.id]).openDuets.length, 1, 'Max voit le bandeau');
  f.settings.auto = true;
  f.sync();
  await until(() => !f.getPending() && f.tracked().some(tr => tr.sel.song.entryId === entryId), 'accusé de KaraFun');
  assert.deepEqual(fake.state().queue.map(item => [item.songId, item.singer]), [[70000, 'Léa · Table 1']],
    'KaraFun reçoit le titre au nom de Léa seule');
  assert.deepEqual(plain(inbox(lea.p)), [['openUnanswered', { title: 'Toxic' }]], 'Léa est prévenue');
  assert.deepEqual(plain(f.view('3', [max.p.id]).openDuets), [], 'le bandeau disparaît partout');
  assert.equal(f.tracked().find(tr => tr.sel.song.entryId === entryId).sel.ids.length, 1);
  assert.deepEqual(events.filter(([type]) => type === 'duo.openExpired').map(([, fields]) => plain(fields)), [{ ownerId: lea.p.id, entryId }]);
  await assert.rejects(f.call('POST /api/table/duet/open/accept', { ...max.body, ownerId: lea.p.id, entryId }),
    { message: 'Ce titre n’est plus en attente : il est peut-être déjà dans KaraFun.' });
});
