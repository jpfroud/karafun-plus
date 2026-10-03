'use strict';
// Journal de soirée (evening-journal.js) : ajout, reprise après redémarrage,
// dernière ligne coupée, écriture au mieux, et événements de l'ordonnanceur
// (identifiants seulement, jamais de prénom ni de secret).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EveningJournal, newEveningId, validEveningId, parseLines, cleanFields } = require('../evening-journal');
const { Scheduler } = require('../scheduler');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'soirees-'));
const lines = (dir, id) => fs.readFileSync(path.join(dir, id, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const clock = (start = Date.UTC(2026, 9, 3, 19, 0)) => { let t = start; const now = () => t; now.add = ms => { t += ms; }; return now; };

test('journal : une ligne par événement, identifiants seulement, prénoms dans meta.json', () => {
  const dir = tmp(), now = clock();
  const journal = new EveningJournal({ dir, now, app: { version: 'v1.4.0', commit: 'abc1234' }, boot: 'b1' });
  journal.open({ rules: { tableRotation: false } });
  assert.ok(validEveningId(journal.id), journal.id);
  journal.person('p1', { name: 'Alice', tableId: '4' });
  journal.table('4', { name: 'Table 4', individual: false });
  now.add(1000);
  const event = journal.append('song.requested', { personId: 'p1', entryId: 'e1', title: 'Soulmate',
    name: 'Alice', token: 'secret-token', code: '123456', privateNote: 'pull rouge', photo: 'data:...',
    nested: { key: 'cle', ok: 1 }, list: [{ secret: 'x', y: 2 }], bad: () => 1, missing: undefined, nan: NaN });
  assert.equal(event.seq, 3);
  const rows = lines(dir, journal.id);
  assert.deepEqual(rows.map(r => r.ev), ['evening.started', 'app.started', 'song.requested']);
  const row = rows[2];
  assert.deepEqual({ ...row }, { personId: 'p1', entryId: 'e1', title: 'Soulmate', nested: { ok: 1 }, list: [{ y: 2 }],
    nan: null, v: 1, seq: 3, t: now(), ev: 'song.requested', boot: 'b1' });
  const raw = fs.readFileSync(path.join(dir, journal.id, 'journal.jsonl'), 'utf8');
  for (const secret of ['Alice', 'secret-token', '123456', 'pull rouge']) assert.ok(!raw.includes(secret), secret);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, journal.id, 'meta.json'), 'utf8'));
  assert.deepEqual(meta.roster, { p1: { name: 'Alice', tableId: '4' } });
  assert.deepEqual(meta.tables, { 4: { name: 'Table 4', individual: false } });
  assert.deepEqual(meta.app, { version: 'v1.4.0', commit: 'abc1234' });
  assert.equal(rows[0].rules.tableRotation, false);
  // Un nom inchangé ne réécrit pas meta.json ; un nom d'événement invalide est ignoré.
  journal.person('p1', { name: 'Alice', tableId: '4' });
  journal.table('4', { name: 'Table 4', individual: false });
  assert.equal(journal.append('Pas un nom', {}), null);
  assert.equal(journal.append('a.b.c.d.e', {}), null);
  assert.equal(journal.append(42), null);
});

test('journal : reprise de la même soirée après un redémarrage, durée d’arrêt notée', () => {
  const dir = tmp(), now = clock();
  const first = new EveningJournal({ dir, now, boot: 'b1' });
  first.open();
  first.append('person.joined', { personId: 'p1', tableId: '1' });
  const saved = first.snapshot();
  assert.deepEqual(saved, { id: first.id, startedAt: now() });
  now.add(90000);
  const second = new EveningJournal({ dir, now, boot: 'b2', app: { version: 'v1.4.0' } });
  assert.equal(second.open({ resume: saved }), true);
  assert.equal(second.id, first.id);
  const event = second.append('person.left', { personId: 'p1' });
  assert.equal(event.seq, 5, 'la numérotation continue');
  const rows = lines(dir, first.id);
  const restart = rows.find(r => r.ev === 'app.started' && r.restored);
  assert.equal(restart.offlineMs, 90000);
  assert.equal(restart.boot, 'b2');
  assert.equal(restart.version, 'v1.4.0');
  // Identifiant inconnu ou invalide : nouvelle soirée.
  const third = new EveningJournal({ dir, now });
  assert.equal(third.open({ resume: { id: '2026-01-01_2000_ffff' } }), false);
  assert.notEqual(third.id, first.id);
  const fourth = new EveningJournal({ dir, now });
  assert.equal(fourth.open({ resume: { id: '../../etc' } }), false);
  assert.equal(new EveningJournal({ dir: null, now }).open({ resume: saved }), false, 'en mémoire, rien à reprendre');
});

test('journal : une soirée close n’est jamais reprise (arrêt entre la clôture et l’instantané suivant)', () => {
  const dir = tmp(), now = clock();
  const first = new EveningJournal({ dir, now, boot: 'b1' });
  first.open();
  first.append('person.joined', { personId: 'p1', tableId: '1' });
  // Dernier instantané de soirée réussi : il cite encore cette soirée.
  const saved = first.snapshot();
  now.add(120000);
  first.close({ by: 'staff-reset', summarize: () => ({ ok: 1 }) });
  // Arrêt ici : ni nouvelle soirée, ni nouvel instantané.
  const metaFile = path.join(dir, saved.id, 'meta.json');
  const summaryFile = path.join(dir, saved.id, 'summary.json');
  const journalFile = path.join(dir, saved.id, 'journal.jsonl');
  const before = { meta: fs.readFileSync(metaFile, 'utf8'), summary: fs.readFileSync(summaryFile, 'utf8'),
    journal: fs.readFileSync(journalFile, 'utf8') };
  const endedAt = JSON.parse(before.meta).endedAt;
  assert.ok(Number.isFinite(endedAt));
  now.add(60000);
  const second = new EveningJournal({ dir, now, boot: 'b2' });
  assert.equal(second.open({ resume: saved }), false, 'la soirée close reste archivée');
  assert.notEqual(second.id, saved.id);
  second.person('p2', { name: 'Bruno', tableId: '2' });
  second.append('person.joined', { personId: 'p2', tableId: '2' });
  assert.equal(fs.readFileSync(journalFile, 'utf8'), before.journal, 'archive inchangée');
  assert.equal(lines(dir, saved.id).at(-1).ev, 'evening.closed');
  assert.equal(fs.readFileSync(metaFile, 'utf8'), before.meta, 'heure de fin gardée');
  assert.equal(fs.readFileSync(summaryFile, 'utf8'), before.summary);
  const archived = second.list().find(row => row.id === saved.id);
  assert.equal(archived.endedAt, endedAt);
  assert.equal(archived.current, false);
  // Arrêt au milieu de la clôture : evening.closed écrit, heure de fin pas encore.
  const meta = JSON.parse(before.meta);
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, endedAt: null }));
  const third = new EveningJournal({ dir, now, boot: 'b3' });
  assert.equal(third.open({ resume: saved }), false, 'evening.closed suffit');
  assert.notEqual(third.id, saved.id);
  assert.equal(fs.readFileSync(journalFile, 'utf8'), before.journal);
});

test('journal : une dernière ligne coupée est ignorée, une ligne abîmée au milieu est comptée', () => {
  const ok = JSON.stringify({ ev: 'a', t: 1, seq: 1 });
  assert.deepEqual(parseLines(`${ok}\n{"ev":"b","t":2`), { events: [{ ev: 'a', t: 1, seq: 1 }], truncated: true, corrupt: 0 });
  assert.deepEqual(parseLines(`${ok}\n{"ev":"b","t":2\n`), { events: [{ ev: 'a', t: 1, seq: 1 }], truncated: true, corrupt: 0 });
  const middle = parseLines(`${ok}\n{abîmé\n${ok}\n{"pas":"un événement"}\n`);
  assert.equal(middle.events.length, 2);
  assert.equal(middle.corrupt, 2);
  assert.equal(middle.truncated, false);
  assert.deepEqual(parseLines(''), { events: [], truncated: false, corrupt: 0 });

  const dir = tmp(), now = clock();
  const journal = new EveningJournal({ dir, now });
  journal.open();
  journal.append('person.joined', { personId: 'p1' });
  const saved = journal.snapshot();
  fs.appendFileSync(path.join(dir, saved.id, 'journal.jsonl'), '{"v":1,"seq":9,"t":');
  const again = new EveningJournal({ dir, now });
  again.open({ resume: saved });
  const restart = again.read(saved.id).events.find(e => e.ev === 'app.started' && e.restored);
  assert.equal(restart.truncated, true);
  assert.equal(again.append('x.y').seq, 5, 'la ligne coupée ne compte pas');
});

test('journal : une erreur de disque est signalée une fois et ne lève jamais d’exception', () => {
  const errors = [];
  let failing = true;
  const brokenFs = { ...fs,
    mkdirSync: () => {},
    appendFileSync() { if (failing) throw new Error('disque plein'); },
    writeFileSync() { throw new Error('disque plein'); },
    renameSync() {}, existsSync: () => false, readdirSync() { throw new Error('illisible'); } };
  const journal = new EveningJournal({ dir: '/nulle/part', fs: brokenFs, onError: error => { errors.push(error.message); throw new Error('alerte cassée'); } });
  journal.open();
  for (let i = 0; i < 5; i++) assert.ok(journal.append('turn.sent', { entryId: `e${i}` }));
  assert.deepEqual(errors, ['disque plein'], 'une seule alerte');
  assert.equal(journal.lastError, 'disque plein');
  failing = false;
  journal.append('turn.sent', {});
  assert.equal(journal.lastError, null, 'l’écriture revenue efface l’alerte');
  assert.equal(journal.read(journal.id).events.length, 8, 'les événements restent lisibles en mémoire');
  assert.deepEqual(journal.list().map(row => row.current), [true], 'liste sans dossier lisible');
  const closed = journal.close({ summarize: () => { throw new Error('calcul impossible'); } });
  assert.equal(closed.summary, null);
  // Champs bizarres : jamais d'exception.
  assert.equal(new EveningJournal().append('a.b', null), null, 'avant ouverture : gardé pour plus tard');
  assert.equal(cleanFields({ a: { b: { c: { d: { e: 1 } } } } }).a.b.c.d, null, 'profondeur bornée');
  assert.equal(cleanFields(Symbol('x')), null);
});

test('journal : événements reçus avant l’ouverture, clôture avec résumé, liste des soirées', () => {
  const dir = tmp(), now = clock();
  const journal = new EveningJournal({ dir, now });
  journal.append('table.opened', { tableId: '1' });
  assert.equal(journal.id, null);
  journal.open();
  const firstId = journal.id;
  assert.ok(journal.read(firstId).events.some(e => e.ev === 'table.opened'));
  now.add(3600000);
  const closed = journal.close({ by: 'staff-reset', fields: { unsungSongs: 2 }, summarize: ({ events }) => ({ count: events.length }) });
  assert.equal(closed.id, firstId);
  assert.deepEqual(closed.summary, { count: 4 });
  assert.equal(journal.close(), null, 'rien à fermer');
  const archived = journal.read(firstId);
  assert.equal(archived.current, false);
  assert.equal(archived.events.at(-1).ev, 'evening.closed');
  assert.equal(archived.events.at(-1).unsungSongs, 2);
  assert.equal(archived.meta.endedAt, now());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, firstId, 'summary.json'), 'utf8')), { count: 4 });
  now.add(60000);
  journal.start();
  assert.notEqual(journal.id, firstId);
  fs.mkdirSync(path.join(dir, 'pas-une-soiree'));
  fs.mkdirSync(path.join(dir, '2020-01-01_2000_abcd')); // sans meta.json
  const list = journal.list();
  assert.deepEqual(list.map(row => row.id), [journal.id, firstId]);
  assert.deepEqual(list.map(row => row.current), [true, false]);
  assert.equal(journal.read('2020-01-01_2000_abcd'), null);
  assert.equal(journal.read('../x'), null);
  // Fichier de journal absent : soirée vide mais lisible.
  fs.unlinkSync(path.join(dir, firstId, 'journal.jsonl'));
  assert.deepEqual(journal.read(firstId).events, []);
  fs.writeFileSync(path.join(dir, firstId, 'meta.json'), '{abîmé');
  assert.equal(journal.read(firstId), null);
});

test('journal en mémoire (démo) : soirées closes gardées pour la page des statistiques', () => {
  const now = clock();
  const journal = new EveningJournal({ now });
  journal.open();
  const first = journal.id;
  journal.person('p1', { name: 'Alice', tableId: '1' });
  journal.close({ summarize: ({ meta }) => ({ people: Object.keys(meta.roster).length }) });
  journal.start();
  assert.equal(journal.read(first).summary.people, 1);
  assert.equal(journal.read(first).meta.roster.p1.name, 'Alice');
  assert.deepEqual(journal.list().map(row => row.id).sort(), [first, journal.id].sort());
  assert.equal(journal.read('2026-01-01_2000_aaaa'), null);
  journal.person(null, {});
  journal.table(null, {});
  assert.match(newEveningId(Date.UTC(2026, 0, 2, 3, 4), 'beef'), /^2026-01-0[12]_\d{4}_beef$/);
});

test('ordonnanceur : chaque action notée par identifiants, sans prénom ; un journal en panne ne bloque rien', () => {
  const events = [];
  const sched = new Scheduler();
  sched.onEvent = (type, fields) => events.push([type, JSON.parse(JSON.stringify(fields))]);
  sched.table('1').headcount = 3;
  sched.setHeadcount('2', 2);
  const alice = sched.join({ tableId: '1', name: 'Alice' });
  const bob = sched.join({ tableId: '1', name: 'Bob' });
  const chloe = sched.join({ tableId: '2', name: 'Chloé' });
  sched.renameTable('2', 'Terrasse');
  sched.rename(bob, 'Bobby');
  sched.chooseSong(alice, { songId: 1, title: 'Soulmate', artist: 'X', duration: 200 });
  sched.chooseSong(alice, { songId: 2, title: 'Is This Love?' }, 'append');
  sched.reorderSongs(alice, sched.songsOf(alice)[1].entryId, 0);
  sched.removeSong(alice, sched.songsOf(alice)[1].entryId);
  sched.chooseSong(alice, { songId: 3, title: 'Remplacé' }, 'replace');
  const duet = sched.inviteDuet(chloe, alice.id, { songId: 4, title: 'Duo' });
  sched.answerDuet(alice, true, duet.entryId);
  sched.cancelDuet(chloe, duet.entryId);
  sched.chooseSong(bob, { songId: 5, title: 'Chanson de B' });
  sched.requestDuetJoin(chloe, bob.id, bob.song.entryId);
  sched.answerDuetJoin(bob, bob.song.entryId, chloe.id, false);
  sched.requestDuetJoin(chloe, bob.id, bob.song.entryId);
  sched.cancelDuetJoin(chloe, bob.id, bob.song.entryId);
  sched.requestDuetJoin(alice, bob.id, bob.song.entryId); // même table : direct
  sched.setTableBonus('1', 2);
  sched.setPersonBonus(bob.id, -1);
  sched.confirm(alice);
  sched.dismissMaybeGone(alice);
  alice.maybeGone = { at: 1 };
  sched.dismissMaybeGone(alice);
  sched.skipUnconfirmed(alice.id, 2);
  sched.skipUnconfirmed(alice.id, 2);
  sched.giveSpot(alice, bob.id);
  sched.leave(bob, 'staff');
  sched.tableLeft('2');
  const types = events.map(([type]) => type);
  for (const type of ['table.opened', 'table.headcount', 'person.joined', 'table.renamed', 'person.renamed', 'song.requested',
    'queue.entered', 'song.reordered', 'song.removed', 'duo.invited', 'duo.answered', 'duo.cancelled', 'duo.joinRequested',
    'duo.joinAnswered', 'duo.joinCancelled', 'table.bonus', 'person.bonus', 'presence.confirmed', 'presence.stillHere',
    'presence.skipped', 'person.gaveSpot', 'person.left', 'table.left']) assert.ok(types.includes(type), type);
  const text = JSON.stringify(events);
  for (const name of ['Alice', 'Bob', 'Chloé', 'Terrasse']) assert.ok(!text.includes(name), `aucun prénom : ${name}`);
  const replaced = events.filter(([type, f]) => type === 'song.requested' && f.mode === 'replace' && f.replacedEntryIds.length);
  assert.equal(replaced.length, 1);
  assert.equal(events.find(([type]) => type === 'song.requested')[1].durationSec, 200);
  assert.deepEqual(events.find(([type]) => type === 'person.left')[1], { personId: bob.id, by: 'staff', songsDropped: 1 });
  assert.equal(events.filter(([type, f]) => type === 'presence.skipped' && f.removed).length, 1);
  assert.ok(events.some(([type, f]) => type === 'song.removed' && f.by === 'presence-max'));
  assert.ok(events.some(([type, f]) => type === 'duo.joinRequested' && f.direct));
  const left = events.find(([type]) => type === 'table.left')[1];
  assert.deepEqual(left, { tableId: '2', personIds: [chloe.id], songsDropped: 1 });
  // Journal en panne : l'action réussit quand même.
  sched.onEvent = () => { throw new Error('journal cassé'); };
  const dan = sched.join({ tableId: '1', name: 'Dan' });
  assert.ok(sched.people.has(dan.id));
  sched.onEvent = null;
  sched._event('x.y', {});
});

test('ordonnanceur : passages, reports « Pas prêt », retraits et annulations du bar notés', () => {
  const setup = () => {
    const events = [];
    const sched = new Scheduler();
    sched.onEvent = (type, fields) => events.push([type, fields]);
    for (const id of ['1', '2', '3', '4']) sched.table(id).headcount = 2;
    const people = ['A', 'B', 'C', 'D'].map((name, i) => sched.join({ tableId: String(i + 1), name }));
    people.forEach((p, i) => sched.chooseSong(p, { songId: 10 + i, title: `T${i}` }));
    return { sched, events, people, how: () => events.filter(([type]) => type === 'defer.ended').map(([, f]) => f.how) };
  };
  const passage = sel => ({ ids: sel.ids, entryId: sel.song.entryId });
  // « Je suis prêt », puis report arrivé au bout après un autre passage.
  let t = setup();
  let first = t.sched.select();
  t.sched.deferPassage(first.ids[0], passage(first), 1);
  assert.equal(t.events.at(-1)[0], 'defer.requested');
  assert.deepEqual(t.events.at(-1)[1].personIds, first.ids);
  t.sched.cancelDeferral(first.ids[0]);
  first = t.sched.select();
  t.sched.deferPassage(first.ids[0], passage(first), 1);
  t.sched.commit(t.sched.select());
  assert.deepEqual(t.how(), ['ready', 'released']);
  // Report effacé sans annonce, puis levé par un déplacement du bar.
  t = setup();
  first = t.sched.select();
  t.sched.deferPassage(first.ids[0], passage(first), 2);
  assert.equal(t.sched.dropDeferral(first.ids[0], first.song.entryId), true);
  first = t.sched.select();
  t.sched.deferPassage(first.ids[0], passage(first), 1);
  t.sched.staffMove(first.ids[0], 0);
  assert.deepEqual(t.how(), ['dropped', 'staff-move']);
  // Invitée d'un duo qui monte sur scène alors que son propre titre est reporté.
  t = setup();
  const [owner, guest] = t.people;
  t.sched.table('1').headcount = 3;
  guest.tableId = '1'; guest.group = '1';
  t.sched.deferPassage(guest.id, { ids: [guest.id], entryId: guest.song.entryId }, 1);
  const duet = t.sched.inviteDuet(owner, guest.id, { songId: 50, title: 'Ensemble' });
  t.sched.commit({ ids: [owner.id, guest.id], consumedIds: [owner.id], song: duet, kind: 'duo', group: '1', label: 'duo' });
  assert.deepEqual(t.how(), ['sent']);
  // Retraits du bar : titre courant et titre suivant.
  const [a, b] = t.people.filter(p => p.song);
  t.sched.chooseSong(a, { songId: 40, title: 'Encore' }, 'append');
  t.sched.staffRemoveEntry(a.id, a.backlog[0].entryId);
  t.sched.staffRemove(b.id);
  assert.equal(t.events.filter(([type, f]) => type === 'song.removed' && f.by === 'staff').length, 2);
  // Duo noté par le bar.
  t.sched.staffCountPartner(a.id, b.id, { song: a.song, ids: [a.id] });
  assert.deepEqual(t.events.at(-1)[1], { entryId: a.song.entryId, ownerId: a.id, partnerId: b.id });
});

test('instantané de soirée : l’identifiant du journal est gardé et rendu à la reprise', () => {
  const { snapshotNight, restoreNight } = require('../night-state');
  const { TableAccess } = require('../table-access');
  const sched = new Scheduler(), access = new TableAccess();
  sched.table('1'); access.issue('1');
  const settings = { auto: true, autoPlay: false, pushDelaySec: 45, playDelaySec: 8 };
  const evening = { id: '2026-10-03_2000_abcd', startedAt: 1 };
  const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: sched, access, settings, evening })));
  assert.deepEqual(snapshot.evening, evening);
  const restore = snap => restoreNight(snap, { scheduler: new Scheduler(), access: new TableAccess(), settings: { ...settings } }).evening;
  assert.deepEqual(restore(snapshot), evening);
  assert.equal(restore({ ...snapshot, evening: { id: '../x' } }), null, 'identifiant invalide ignoré');
  assert.deepEqual(restore({ ...snapshot, evening: { id: evening.id } }), { id: evening.id, startedAt: null });
  const { evening: _ignored, ...old } = snapshot;
  assert.equal(restore(old), null, 'ancienne sauvegarde sans journal');
  assert.equal(snapshotNight({ scheduler: sched, access, settings }).evening, null);
});

// Regression: relecture PR #11 — la reprise après un arrêt brutal se collait
// à la ligne coupée : relue du disque, la soirée perdait son redémarrage.
test('journal : après une ligne coupée, la reprise commence sur une nouvelle ligne et survit à la relecture', () => {
  const { computeStats } = require('../evening-stats');
  const dir = tmp(), now = clock();
  const journal = new EveningJournal({ dir, now });
  journal.open();
  journal.append('person.joined', { personId: 'p1', tableId: '1' });
  journal.append('person.seen', { personId: 'p1' });
  const saved = journal.snapshot();
  fs.appendFileSync(path.join(dir, saved.id, 'journal.jsonl'), '{"personId":"p1","v":1,"seq":9');
  now.add(20 * 60000);
  const again = new EveningJournal({ dir, now });
  assert.equal(again.open({ resume: saved }), true);
  again.append('person.left', { personId: 'p1' });
  const fromDisk = new EveningJournal({ dir, now }).read(saved.id);
  const restart = fromDisk.events.find(e => e.ev === 'app.started' && e.restored);
  assert.ok(restart, 'l’événement de reprise est relu du disque');
  assert.equal(restart.offlineMs, 20 * 60000);
  assert.ok(fromDisk.events.some(e => e.ev === 'person.left'));
  assert.equal(fromDisk.corrupt, 1, 'seule la ligne coupée est perdue');
  const stats = computeStats({ meta: fromDisk.meta, events: fromDisk.events, now: now() });
  assert.equal(stats.evening.restarts, 1);
  assert.equal(stats.evening.offlineSec, 20 * 60);
  // Fichier déjà terminé par un saut de ligne : rien n'est ajouté.
  const before = fs.readFileSync(path.join(dir, saved.id, 'journal.jsonl'), 'utf8');
  const third = new EveningJournal({ dir, now });
  third._endCutLine(saved.id);
  assert.equal(fs.readFileSync(path.join(dir, saved.id, 'journal.jsonl'), 'utf8'), before);
  third._endCutLine('2026-10-03_0000_none');
});
