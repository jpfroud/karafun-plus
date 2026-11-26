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

// ---------------------------------------------------------------------------
// Réparation des journaux fusionnés (plan du 8 novembre, A4) et ses essais
// (A7, « Réparation ») : EveningJournal.repair, splitAt, l'index
// data/soirees/.bornage.json, la copie data/soirees-originales/<id>/<g>/ et
// ses écritures. Le disque en mémoire (test/disque-memoire.js) note les
// synchronisations, fait échouer un appel donné (crochet) et simule un arrêt
// brutal ; chaque essai y fixe `platform` ('linux', sauf l'essai de Windows),
// car le job Windows de la CI lance toute la suite. Les essais du vrai disque
// prennent le système de l'essai. process.env.TZ est changé par un essai,
// puis toujours rendu (comme dans fuseau.test.js).
const { spawn } = require('node:child_process');
const { disqueMemoire } = require('./disque-memoire');
const tires = require('./journaux-tires');
const { citedIds, computeStats, exportEvening } = require('../evening-stats');
const { eveningBreaks, isActivity } = require('../evening-bounds');
const { pieceJournal, splitFingerprint } = require('../evening-split');
const soirees = require('../evening-journal');

const ORIGIN = '2026-10-15_1900_ab12';
const PARIS = 'Europe/Paris';
const MIN = 60000, H = 60 * MIN, DAY = 24 * H;
// Heure figée du démarrage qui répare : le mardi 20 octobre 2026.
const REPAIR_AT = Date.parse('2026-10-20T10:00:00Z');
const REFAIRE = '(DEPLOIEMENT-SERVEUR §18, « Refaire une réparation en échec »)';
const ENVOYER = '(DEPLOIEMENT-SERVEUR §18, « Envoyer une soirée au développeur »)';
const resumer = ({ meta, events }) => computeStats({ meta, events,
  now: Number.isFinite(meta.endedAt) ? meta.endedAt : (events.at(-1)?.t ?? REPAIR_AT) });
const texte = events => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const cle = e => JSON.stringify(e);
// Valeur telle que relue d'un fichier JSON (les champs indéfinis partent).
const plain = value => JSON.parse(JSON.stringify(value));

const ORIGINAL_TZ_R = process.env.TZ;
const ORIGINAL_ZONE_R = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Exécute `run` sous le fuseau `zone`, puis rend la valeur d'origine de TZ
// (copie d'inZone de fuseau.test.js, qui n'exporte rien).
function inZone(zone, run) {
  process.env.TZ = zone;
  try {
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, zone, `fuseau ${zone} pris en compte`);
    return run();
  } finally {
    if (ORIGINAL_TZ_R === undefined) { process.env.TZ = ORIGINAL_ZONE_R; delete process.env.TZ; }
    else process.env.TZ = ORIGINAL_TZ_R;
  }
}

// La soirée du 15 octobre recopiée `fois` fois à +24 h (journaux-tires.js),
// close par le bar 5 min après sa dernière ligne si `close`.
function fixture24({ close = true, fois = 2, id = ORIGIN } = {}) {
  const { events, meta } = tires.recopierFixture({ fois, eveningId: id });
  if (close) {
    const t = events.at(-1).t + 5 * MIN;
    events.push({ by: 'staff-reset', v: 1, seq: events.length + 1, t, ev: 'evening.closed', boot: `nuit-${fois}` });
    meta.endedAt = t;
  }
  return { events, meta };
}

// `n` nuits de karaoké à Paris, du jeudi 15 octobre 2026 (avant l'heure
// d'hiver) : chaque nuit une table, deux personnes et trois titres, de 20 h à
// 22 h 30, et un téléphone revu à 23 h. Les coupures tombent à 8 h.
const NUIT = Date.parse('2026-10-15T20:00:00+02:00');
function nuits(n) {
  const events = [];
  const add = (t, ev, fields, boot) => events.push({ ...fields, v: 1, seq: events.length + 1, t, ev, boot });
  add(NUIT - 30 * MIN, 'evening.started', { rules: { auto: true, autoPlay: false } }, 'boot-1');
  for (let k = 1; k <= n; k++) {
    const t0 = NUIT + (k - 1) * DAY, boot = `boot-${k}`;
    add(t0, 'table.opened', { tableId: `T${k}`, individual: false }, boot);
    add(t0 + MIN, 'person.joined', { personId: `a${k}`, tableId: `T${k}` }, boot);
    add(t0 + 2 * MIN, 'person.joined', { personId: `b${k}`, tableId: `T${k}` }, boot);
    for (let s = 0; s < 3; s++) {
      const ts = t0 + (10 + 40 * s) * MIN, who = s % 2 ? `b${k}` : `a${k}`, entryId = `e${k}-${s}`;
      add(ts - 5 * MIN, 'song.requested', { personId: who, entryId, songId: 100 + s, title: `Titre ${s}` }, boot);
      add(ts, 'stage.started', { queueId: k * 10 + s, ids: [who], ownerId: who, entryId, durationSec: 200 }, boot);
      add(ts + 4 * MIN, 'stage.ended', { queueId: k * 10 + s, playedSec: 240 }, boot);
    }
    add(t0 + 3 * H, 'person.seen', { personId: `a${k}` }, boot);
  }
  return events;
}
function metaNuits(n, { id = ORIGIN, endedAt = null } = {}) {
  const roster = [], tables = [];
  for (let k = 1; k <= n; k++) {
    for (const p of ['a', 'b']) roster.push([`${p}${k}`, { name: `Prénom ${p}${k}`, tableId: `T${k}` }]);
    tables.push([`T${k}`, { name: `Table ${k}`, individual: false }]);
  }
  return { format: 'karaoke-evening-meta', version: 1, eveningId: id, startedAt: NUIT - 30 * MIN, endedAt,
    app: { version: 'v3.5.0', commit: null }, timezone: PARIS, roster: Object.fromEntries(roster), tables: Object.fromEntries(tables) };
}
const cutsOf = (events, meta) => eveningBreaks({ events, timeZone: meta.timezone, startedAt: meta.startedAt, split: meta.split }).cuts;
// Soirée close de deux nuits fusionnées, à découper : nuits(2), close par le
// bar 5 min après sa dernière ligne, à l'identifiant `id`.
function fusionnee(id) {
  const events = nuits(2);
  const t = events.at(-1).t + 5 * MIN;
  events.push({ by: 'staff-reset', v: 1, seq: events.length + 1, t, ev: 'evening.closed', boot: 'boot-2' });
  return { meta: metaNuits(2, { id, endedAt: t }), events };
}

// Banc de la réparation sur le disque en mémoire : journal, lignes du journal
// du serveur et attentes de `sleep` (jamais réelles).
function banc({ platform = 'linux', depuis = null, app = { version: 'v3.5.0', commit: null }, now = () => REPAIR_AT, ...options } = {}) {
  const disk = disqueMemoire({ depuis });
  const lignes = [], attentes = [];
  const journal = new EveningJournal({ dir: disk.absolu('data/soirees'), fs: disk.fs, now, app, boot: 'b-repar', platform,
    sleep: ms => attentes.push(ms), citedIds, ...options });
  const repair = (id, extra = {}) => journal.repair({ id, summarize: resumer, citedIds, log: line => lignes.push(line), ...extra });
  return { disk, journal, lignes, attentes, repair };
}
function poser(disk, id, { meta, events, text, summary } = {}) {
  disk.ecrire(`data/soirees/${id}/meta.json`, JSON.stringify(meta, null, 1));
  disk.ecrire(`data/soirees/${id}/journal.jsonl`, text ?? texte(events));
  if (summary !== undefined) disk.ecrire(`data/soirees/${id}/summary.json`, JSON.stringify(summary));
}
const lireJson = (disk, rel) => JSON.parse(disk.lire(rel));
const lignesDe = (disk, id) => parseLines(disk.lire(`data/soirees/${id}/journal.jsonl`)).events;
const bornage = disk => lireJson(disk, 'data/soirees/.bornage.json');
const sansTmp = contenus => new Map([...contenus].filter(([rel]) => !rel.endsWith('.tmp')));
// Lignes des morceaux d'une soirée, lignes reportées exclues, en texte.
const propres = (disk, ids) => ids.flatMap(id => lignesDe(disk, id)).filter(e => e.carried !== true);
// Identifiant du morceau k au j-ième essai, d'après son début.
const idAt = (start, k, j, from = ORIGIN) => newEveningId(start, splitFingerprint(from, k, j), PARIS);

test('A7 : disque en mémoire des essais : onze méthodes seulement (statSync sur data/ lève ce texte), openSync en wx refusé sur un fichier qui existe (EEXIST), fichier écrit par un descripteur puis renommé, synchronisations notées, crochet d’erreur', () => {
  const disk = disqueMemoire();
  const { fs: mem } = disk;
  const data = disk.absolu('data');
  assert.throws(() => mem.statSync(data), { message: 'méthode non simulée : fs.statSync("data"). Le disque en mémoire n\'a que existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, mkdirSync, readdirSync, openSync, fsyncSync et closeSync (A4, « Trace et contraintes ») : réécris l\'appel avec elles.' });
  for (const name of ['copyFileSync', 'rmSync', 'cpSync']) assert.throws(() => mem[name](data), /^Error: méthode non simulée/);
  assert.throws(() => mem.readdirSync(data, { withFileTypes: true }), /méthode non simulée : fs\.readdirSync\("data"\)/);
  assert.equal(mem.mkdirSync(path.join(data, 'soirees', 'x'), { recursive: true }), data, 'premier dossier créé, comme Node');
  assert.equal(mem.mkdirSync(path.join(data, 'soirees', 'x'), { recursive: true }), undefined);
  const file = path.join(data, 'soirees', 'x', 'meta.json');
  const tmp = `${file}.1.abcd1234.tmp`;
  const fd = mem.openSync(tmp, 'wx');
  assert.throws(() => mem.openSync(tmp, 'wx'), { code: 'EEXIST' });
  assert.equal(mem.readFileSync(tmp, 'utf8'), '', 'créé vide');
  mem.writeFileSync(fd, Buffer.from('{"a":1}'));
  mem.fsyncSync(fd);
  mem.closeSync(fd);
  mem.renameSync(tmp, file);
  assert.equal(mem.readFileSync(file, 'utf8'), '{"a":1}', 'le contenu suit le renommage');
  assert.equal(mem.existsSync(tmp), false);
  const dirFd = mem.openSync(path.dirname(file), 'r');
  mem.fsyncSync(dirFd);
  mem.closeSync(dirFd);
  assert.deepEqual(disk.syncs, [{ chemin: 'data/soirees/x/meta.json.1.abcd1234.tmp', dossier: false }, { chemin: 'data/soirees/x', dossier: true }]);
  assert.deepEqual(mem.readdirSync(path.join(data, 'soirees')), ['x']);
  assert.throws(() => mem.readFileSync(path.dirname(file)), { code: 'EISDIR' });
  assert.throws(() => mem.writeFileSync(path.join(data, 'absent', 'f'), 'x'), { code: 'ENOENT' }, 'jamais sans son dossier');
  disk.crochet = op => (op === 'sync' ? 'EIO' : null);
  const again = mem.openSync(file, 'r');
  assert.throws(() => mem.fsyncSync(again), { code: 'EIO' });
});

test('A4 : errorTrace : nom, code et cinq lignes « at » de la pile, jamais une ligne du message ; un fichier du dossier de l’application par son chemin depuis ce dossier, un autre par son seul nom, node:internal tel quel', () => {
  const root = path.join(__dirname, '..');
  const error = new TypeError('Léa\nMax');
  error.stack = ['TypeError: Léa', 'Max', '    at fake (C:\\Users\\Léa\\karaoke-bar\\evening-bounds.js:42:11)',
    `    at planSplit (${path.join(root, 'lib', 'scheduler', 'duets.js')}:329:7)`,
    '    at Module._compile (node:internal/modules/cjs/loader:1554:14)',
    '    at async Promise.all (index 0)',
    `    at ${path.join(os.tmpdir(), 'Léa Dupont', 'outil.js')}:3:9`,
    '    at sixieme (/ailleurs/six.js:1:1)'].join('\n');
  const trace = soirees.errorTrace(error);
  assert.equal(trace.name, 'TypeError');
  assert.equal(trace.code, null);
  assert.equal(trace.stack, 'at fake (evening-bounds.js:42:11) · at planSplit (lib/scheduler/duets.js:329:7) · ' +
    'at Module._compile (node:internal/modules/cjs/loader:1554:14) · at async Promise.all (index 0) · at outil.js:3:9');
  for (const word of ['Léa', 'Max', 'Users', 'Dupont', 'six']) assert.ok(!trace.stack.includes(word), word);
  const coded = Object.assign(new TypeError('Léa'), { code: 'ERR_INVALID_ARG_TYPE' });
  assert.deepEqual([soirees.errorTrace(coded).name, soirees.errorTrace(coded).code], ['TypeError', 'ERR_INVALID_ARG_TYPE']);
  assert.match(soirees.errorTrace(coded).stack, /^at /);
  assert.ok(!soirees.errorTrace(coded).stack.includes('Léa'));
  for (const odd of [null, undefined, 'texte', 42, { name: 'Léa Dupont', stack: 5 }]) assert.doesNotThrow(() => soirees.errorTrace(odd));
  assert.equal(soirees.errorTrace({ name: 'Léa Dupont' }).name, 'Error', 'un nom qui n’en est pas un n’est pas écrit');
  assert.equal(soirees.errorTrace({ code: 'Léa' }).code, null);
  // Une ligne du message qui ressemble à une ligne de pile n'en est pas une.
  const forged = new Error('Léa\n    at Max (C:\\Users\\Léa\\x.js:1:1)');
  forged.stack = ['Error: Léa', '    at Max (C:\\Users\\Léa\\x.js:1:1)', `    at vrai (${path.join(root, 'evening-journal.js')}:1:1)`].join('\n');
  assert.equal(soirees.errorTrace(forged).stack, 'at vrai (evening-journal.js:1:1)');
});

test('A4 : evening-journal.js n’exporte ni INDEX_FILE ni COPY_MARK, que rien ne lit : les essais et les guides écrivent « .bornage.json » et « copie-complete » en entier', () => {
  for (const name of ['INDEX_FILE', 'COPY_MARK']) assert.equal(Object.hasOwn(soirees, name), false, name);
});

test('A4 : _load lit meta.json et journal.jsonl par parseLines, rend null sans meta.json et lève avec son code (BAD_JSON, EISDIR) ; read() la reprend et rend null pour toute erreur ; une archive dont startedAt est un texte se lit et s’exporte encore, et la réparation la note failed (BAD_META), ses fichiers tels quels', () => {
  const b = banc();
  const { events, meta } = fixture24({ fois: 1 });
  poser(b.disk, ORIGIN, { meta, events });
  assert.equal(b.journal._load(ORIGIN).events.length, events.length);
  assert.deepEqual(b.journal._load(ORIGIN).meta, meta);
  assert.equal(b.journal._load('2026-10-15_1900_ffff'), null, 'sans meta.json');
  b.disk.ecrire('data/soirees/2026-10-14_1900_aaaa/meta.json', '{"roster":{"S01":{"name":"Léa"}');
  assert.throws(() => b.journal._load('2026-10-14_1900_aaaa'), { code: 'BAD_JSON' });
  assert.equal(b.journal.read('2026-10-14_1900_aaaa'), null);
  b.disk.ecrire('data/soirees/2026-10-13_1900_bbbb/meta.json', JSON.stringify(meta));
  b.disk.dossier('data/soirees/2026-10-13_1900_bbbb/journal.jsonl');
  assert.throws(() => b.journal._load('2026-10-13_1900_bbbb'), { code: 'EISDIR' });
  assert.equal(b.journal.read('2026-10-13_1900_bbbb'), null);
  b.disk.ecrire('data/soirees/2026-10-12_1900_cccc/meta.json', JSON.stringify(meta));
  assert.deepEqual(b.journal._load('2026-10-12_1900_cccc').events, [], 'journal absent lu comme vide');
  const odd = '2026-10-16_1900_dddd';
  poser(b.disk, odd, { meta: { ...meta, eveningId: odd, startedAt: 'hier' }, events });
  const saved = b.journal.read(odd);
  assert.equal(saved.meta.startedAt, 'hier');
  assert.equal(computeStats({ meta: saved.meta, events: saved.events, now: REPAIR_AT }).format, 'karaoke-evening-stats');
  assert.equal(exportEvening({ meta: saved.meta, events: saved.events, now: REPAIR_AT }).events.length, events.length);
  const before = b.disk.contenus(`data/soirees/${odd}`);
  const result = b.repair(odd);
  assert.deepEqual([result.status, result.code, result.step, result.attempts], ['failed', 'BAD_META', 'lecture', 1]);
  assert.deepEqual(bornage(b.disk).checked[odd], { status: 'failed', attempts: 1, code: 'BAD_META', version: 'v3.5.0' });
  assert.deepEqual(b.disk.contenus(`data/soirees/${odd}`), before, 'ses fichiers restent tels quels');
  assert.deepEqual(b.lignes, [`Réparation : ${odd} en échec à l'étape « lecture » (BAD_META, meta.json) : notée failed, ses fichiers restent tels quels. Répare ou remets le fichier, puis refais-la ${REFAIRE}.`]);
});

test('A7 : la fixture du 15 octobre recopiée à +24 h, close, réparée sous TZ=UTC : deux soirées, identifiants valides à la date et à l’heure de Paris, meta et résumés de chaque morceau, lignes reportées et clôture, rien de perdu, copie octet pour octet avec copie-complete, index, ligne « Réparation : »', () => inZone('UTC', () => {
  const b = banc();
  const { events, meta } = fixture24();
  const ancien = { ancien: true };
  poser(b.disk, ORIGIN, { meta, events, summary: ancien });
  const original = new Map(['meta.json', 'journal.jsonl', 'summary.json'].map(name => [name, b.disk.octets(`data/soirees/${ORIGIN}/${name}`)]));
  const [cut] = cutsOf(events, meta);
  const result = b.repair(ORIGIN);
  assert.deepEqual([result.status, result.split, result.current, result.generation], ['split', true, false, 1]);
  assert.deepEqual(result.pieces.map(p => [p.k, p.start, p.end]), [[1, meta.startedAt, cut], [2, cut, meta.endedAt]]);
  const [first, last] = result.pieces;
  assert.equal(last.id, ORIGIN, 'le dernier morceau garde l’identifiant d’origine');
  assert.ok(validEveningId(first.id));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: PARIS, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(meta.startedAt).map(p => [p.type, p.value]));
  assert.equal(first.id, `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}_${splitFingerprint(ORIGIN, 1, 1)}`,
    'date et heure du début du morceau à Paris, sous TZ=UTC');
  assert.equal(first.id, idAt(meta.startedAt, 1, 1));
  const m1 = lireJson(b.disk, `data/soirees/${first.id}/meta.json`), m2 = lireJson(b.disk, `data/soirees/${ORIGIN}/meta.json`);
  assert.deepEqual(m1.split, { from: ORIGIN, part: 1, generation: 1, rule: 'v1' });
  assert.deepEqual(m2.split, { from: ORIGIN, part: 2, generation: 1, rule: 'v1' });
  assert.deepEqual([m1.eveningId, m1.startedAt, m1.endedAt, m1.closedBy], [first.id, meta.startedAt, cut, 'auto']);
  assert.deepEqual([m2.eveningId, m2.startedAt, m2.endedAt, m2.closedBy], [ORIGIN, cut, meta.endedAt, 'staff-reset']);
  const j1 = lignesDe(b.disk, first.id), j2 = lignesDe(b.disk, ORIGIN);
  const s1 = lireJson(b.disk, `data/soirees/${first.id}/summary.json`), s2 = lireJson(b.disk, `data/soirees/${ORIGIN}/summary.json`);
  assert.deepEqual(s1, plain(resumer({ meta: m1, events: j1 })), 'résumé recalculé du morceau');
  assert.deepEqual(s2, plain(resumer({ meta: m2, events: j2 })));
  for (const [m, s, lines] of [[m1, s1, j1], [m2, s2, j2]]) {
    assert.deepEqual(m.karaoke, soirees.karaokeOf(s, lines));
    const firstActivity = Math.min(...lines.filter(isActivity).map(e => e.t));
    assert.ok(m.karaoke.openedAt >= firstActivity, 'karaoke jamais ouvert avant la première activité');
    assert.ok(Number.isFinite(m.karaoke.closedAt));
  }
  assert.deepEqual(Object.keys(m2.roster).sort(), Object.keys(meta.roster).filter(id => id.endsWith('-2')).sort(), 'prénoms de la seconde soirée');
  assert.ok(j1.every(e => e.carried !== true));
  assert.deepEqual(j1.at(-1), { by: 'auto', reason: 'morning', split: true, at: REPAIR_AT, v: 1,
    seq: Math.max(...j1.slice(0, -1).map(e => e.seq)) + 1, t: cut, ev: 'evening.closed', boot: 'split-g1-k1' });
  const carried = j2.filter(e => e.carried === true);
  assert.ok(carried.length > 0 && j2.slice(0, carried.length).every(e => e.carried === true && e.t === cut && e.boot === 'split-g1-k2'));
  // Rien de perdu : l'union des morceaux, lignes reportées et clôture exclues, redonne l'original.
  const union = [...j1.slice(0, -1), ...j2.filter(e => e.carried !== true)].map(cle).sort();
  assert.deepEqual(union, events.map(cle).sort());
  for (const [name, bytes] of original) assert.ok(b.disk.octets(`data/soirees-originales/${ORIGIN}/1/${name}`).equals(bytes), `copie de ${name}`);
  assert.ok(b.disk.existe(`data/soirees-originales/${ORIGIN}/1/copie-complete`));
  assert.deepEqual(bornage(b.disk), { rule: 'v1', checked: { [first.id]: 'ok', [ORIGIN]: 'split' } });
  assert.equal(b.lignes.length, 1);
  const iso = t => new Date(t).toISOString();
  assert.match(b.lignes[0], new RegExp(`^Réparation : ${ORIGIN} découpée en 2 morceaux \\(génération 1\\) : ` +
    `${first.id} \\(${iso(meta.startedAt)} → ${iso(cut)}, ${j1.length - 1} lignes\\), ` +
    `${ORIGIN} \\(${iso(cut)} → ${iso(meta.endedAt)}, ${j2.length - carried.length} lignes\\) ; ` +
    `${carried.length} lignes reportées ; aucune ligne illisible ; en \\d+ ms\\.$`));
  for (const word of ['Prénom', 'S01-2']) assert.ok(!b.lignes[0].includes(word));
  // La liste des soirées montre les deux morceaux, une fois chacun.
  assert.deepEqual(b.journal.list().map(row => row.id).sort(), [first.id, ORIGIN].sort());
}));

test('A4 : soirée en cours réparée au démarrage : morceau archivé, soirée ouverte réécrite sous le même identifiant (meta.split avec cut et previous, sans résumé ni karaoke), copie-complete retirée, jamais notée ok ni split ; le journal la reprend, et un second démarrage ne réécrit rien', () => {
  const b = banc();
  const { events, meta } = fixture24({ close: false });
  poser(b.disk, ORIGIN, { meta, events });
  const [cut] = cutsOf(events, meta);
  const result = b.repair(ORIGIN, { current: true });
  assert.deepEqual([result.status, result.current, result.split], ['split', true, true]);
  const [first] = result.pieces;
  assert.equal(result.previous.id, first.id);
  assert.equal(result.previous.cut, cut);
  assert.deepEqual(plain(result.previous.summary), lireJson(b.disk, `data/soirees/${first.id}/summary.json`));
  const m2 = lireJson(b.disk, `data/soirees/${ORIGIN}/meta.json`);
  assert.deepEqual(m2.split, { from: ORIGIN, part: 2, generation: 1, rule: 'v1', cut, previous: first.id });
  assert.deepEqual([m2.startedAt, m2.endedAt, 'karaoke' in m2, 'closedBy' in m2], [cut, null, false, false]);
  assert.equal(b.disk.existe(`data/soirees/${ORIGIN}/summary.json`), false);
  assert.equal(b.disk.existe(`data/soirees-originales/${ORIGIN}/1/copie-complete`), false, 'copie-complete retirée : la soirée continue');
  assert.ok(b.disk.octets(`data/soirees-originales/${ORIGIN}/1/journal.jsonl`).equals(Buffer.from(texte(events))));
  assert.deepEqual(bornage(b.disk).checked, { [first.id]: 'ok' }, 'la soirée en cours n’est pas notée');
  // Second démarrage : revue, rien à couper, rien d'écrit, aucune ligne.
  const avant = b.disk.contenus();
  const second = banc({ depuis: b.disk.instantane() });
  const again = second.repair(ORIGIN, { current: true });
  assert.deepEqual([again.status, again.current, again.split], ['ok', true, false]);
  assert.deepEqual(second.disk.contenus(), avant);
  assert.deepEqual(second.lignes, []);
  // Le journal reprend la soirée en cours : même identifiant, seq qui continue.
  const reopened = new EveningJournal({ dir: second.disk.absolu('data/soirees'), fs: second.disk.fs, now: () => REPAIR_AT, boot: 'b2', platform: 'linux' });
  assert.equal(reopened.open({ resume: { id: ORIGIN } }), true);
  assert.equal(reopened.startedAt, cut);
  assert.equal(reopened.current.meta.split.previous, first.id);
  assert.equal(reopened.append('person.seen', { personId: 'S01-2' }).seq, Math.max(...events.map(e => e.seq)) + 2);
});

test('A7 : soirée en cours découpée deux fois (deux générations) : une copie par génération, revue quel que soit l’index, rien de perdu ni de doublé', () => {
  const all = nuits(3);
  const night3 = all.filter(e => e.boot === 'boot-3');
  const first = all.filter(e => e.boot !== 'boot-3');
  const b = banc();
  poser(b.disk, ORIGIN, { meta: metaNuits(3), events: first });
  const r1 = b.repair(ORIGIN, { current: true });
  assert.equal(r1.generation, 1);
  const [a] = r1.pieces;
  // La soirée continue : la troisième nuit s'ajoute au journal du dossier.
  b.disk.ecrire(`data/soirees/${ORIGIN}/journal.jsonl`, b.disk.lire(`data/soirees/${ORIGIN}/journal.jsonl`) + texte(night3));
  const index = bornage(b.disk);
  index.checked[ORIGIN] = 'ok';
  b.disk.ecrire('data/soirees/.bornage.json', JSON.stringify(index));
  const r2 = b.repair(ORIGIN, { current: true });
  assert.deepEqual([r2.status, r2.generation, r2.pieces.length], ['split', 2, 2], 'revue malgré son entrée ok');
  const [middle] = r2.pieces;
  const [c1, c2] = cutsOf(all, metaNuits(3));
  assert.deepEqual([a.start, a.end, middle.start, middle.end], [metaNuits(3).startedAt, c1, c1, c2]);
  assert.deepEqual(lireJson(b.disk, `data/soirees/${middle.id}/meta.json`).split, { from: ORIGIN, part: 1, generation: 2, rule: 'v1' });
  assert.deepEqual(lireJson(b.disk, `data/soirees/${ORIGIN}/meta.json`).split, { from: ORIGIN, part: 2, generation: 2, rule: 'v1', cut: c2, previous: middle.id });
  for (const g of [1, 2]) assert.ok(b.disk.existe(`data/soirees-originales/${ORIGIN}/${g}/journal.jsonl`), `copie ${g}`);
  assert.deepEqual(propres(b.disk, [a.id, middle.id, ORIGIN]).filter(e => !(e.ev === 'evening.closed' && e.split)).map(cle).sort(), all.map(cle).sort());
  assert.deepEqual(bornage(b.disk).checked, { [a.id]: 'ok', [middle.id]: 'ok' }, 'entrée de la soirée en cours retirée');
  assert.deepEqual(b.journal.list().map(row => row.id).sort(), [a.id, middle.id, ORIGIN].sort());
});

test('A7 : identifiant d’un morceau déjà pris par une autre soirée : essai suivant (j = 2), dossier étranger intact ; le même identifiant après un arrêt simulé', () => {
  const prepare = () => {
    const b = banc();
    const { events, meta } = fixture24();
    poser(b.disk, ORIGIN, { meta, events });
    const taken = idAt(meta.startedAt, 1, 1);
    poser(b.disk, taken, { meta: { ...metaNuits(1, { id: taken }) }, events: nuits(1) });
    return { b, meta, taken, foreign: b.disk.contenus(`data/soirees/${taken}`) };
  };
  const { b, meta, taken, foreign } = prepare();
  const result = b.repair(ORIGIN);
  const second = idAt(meta.startedAt, 1, 2);
  assert.notEqual(second, taken);
  assert.equal(result.pieces[0].id, second);
  assert.deepEqual(b.disk.contenus(`data/soirees/${taken}`), foreign, 'jamais écrasé');
  // Arrêt brutal juste après le meta.json du morceau, puis redémarrage.
  const run = prepare();
  run.b.disk.crochet = (op, chemin, info) => {
    if (op === 'rename' && info.vers === `data/soirees/${second}/meta.json`) run.b.disk.arretApres(1);
  };
  run.b.repair(ORIGIN);
  assert.ok(run.b.disk.releve, 'arrêt simulé');
  const restart = banc({ depuis: run.b.disk.releve });
  assert.deepEqual(lireJson(restart.disk, `data/soirees/${second}/meta.json`).split, { from: ORIGIN, part: 1, generation: 1, rule: 'v1' });
  const again = restart.repair(ORIGIN);
  assert.equal(again.status, 'split');
  assert.equal(again.pieces[0].id, second, 'même identifiant');
  assert.deepEqual(sansTmp(restart.disk.contenus()), sansTmp(b.disk.contenus()));
  // Un morceau d'une autre génération (même origine, même rang) n'est pas le
  // nôtre : jamais écrasé.
  const all = nuits(3);
  const g = banc();
  poser(g.disk, ORIGIN, { meta: metaNuits(3), events: all.filter(e => e.boot !== 'boot-3') });
  g.repair(ORIGIN, { current: true });
  g.disk.ecrire(`data/soirees/${ORIGIN}/journal.jsonl`, g.disk.lire(`data/soirees/${ORIGIN}/journal.jsonl`) + texte(all.filter(e => e.boot === 'boot-3')));
  const [c1] = cutsOf(all, metaNuits(3));
  const old = idAt(c1, 1, 1);
  poser(g.disk, old, { meta: { ...metaNuits(1, { id: old }), split: { from: ORIGIN, part: 1, generation: 1, rule: 'v1' } }, events: nuits(1) });
  const kept = g.disk.contenus(`data/soirees/${old}`);
  const gen2 = g.repair(ORIGIN, { current: true });
  assert.equal(gen2.generation, 2);
  assert.equal(gen2.pieces[0].id, idAt(c1, 1, 2), 'essai suivant');
  assert.deepEqual(g.disk.contenus(`data/soirees/${old}`), kept, 'morceau de la génération 1 intact');
});

test('A7 : idempotence et index : une seconde réparation ne relit que l’index, ne réécrit rien et n’écrit aucune ligne ; repairQueue ne la propose plus', () => {
  const b = banc();
  const { events, meta } = fixture24();
  poser(b.disk, ORIGIN, { meta, events });
  b.repair(ORIGIN);
  const avant = b.disk.contenus();
  const lus = b.disk.ops.length;
  const again = banc({ depuis: b.disk.instantane() });
  assert.deepEqual(again.journal.repairQueue(), []);
  for (const id of b.disk.fichiers('data/soirees').filter(rel => rel.endsWith('/meta.json')).map(rel => rel.split('/')[2])) {
    assert.equal(again.repair(id).status, 'skipped');
  }
  assert.deepEqual(again.disk.contenus(), avant);
  assert.deepEqual(again.lignes, []);
  assert.equal(again.disk.ops.filter(o => o.op === 'read' && !o.chemin.endsWith('.bornage.json')).length, 0, 'seul l’index est relu');
  assert.ok(lus > 0);
});

test('A7 : ordre des synchronisations : la copie et son dossier, copie-complete, chaque morceau, chaque dossier créé dans son parent, puis l’origine ; fsyncSync en échec sur la copie (EIO) : origine intacte, aucun morceau, retry noté avec EIO', () => {
  const b = banc();
  const { events, meta } = fixture24();
  poser(b.disk, ORIGIN, { meta, events });
  const result = b.repair(ORIGIN);
  const piece = result.pieces[0].id;
  const s = b.disk.syncs;
  const at = test => s.findIndex(test), lastAt = test => s.findLastIndex(test);
  const copy = `data/soirees-originales/${ORIGIN}/1`;
  const mark = at(x => !x.dossier && x.chemin.startsWith(`${copy}/copie-complete.`));
  const originFirst = at(x => x.chemin.startsWith(`data/soirees/${ORIGIN}/`));
  assert.ok(mark > 0 && originFirst > mark);
  for (const name of ['meta.json', 'journal.jsonl']) {
    const i = at(x => !x.dossier && x.chemin.startsWith(`${copy}/${name}.`));
    assert.ok(i >= 0 && i < mark, name);
  }
  const copyDir = at(x => x.dossier && x.chemin === copy);
  assert.ok(copyDir >= 0 && copyDir < mark, 'dossier de la copie avant copie-complete');
  // Chaque fichier de la copie, copie-complete compris, puis son entrée dans
  // le dossier de la copie, avant le fichier suivant ; la dernière avant la
  // première synchronisation de data/soirees (le dossier du premier morceau).
  const firstPiece = at(x => x.chemin === 'data/soirees' || x.chemin.startsWith('data/soirees/'));
  const copied = ['meta.json', 'journal.jsonl', 'copie-complete'];
  const copySyncs = copied.map(name => at(x => !x.dossier && x.chemin.startsWith(`${copy}/${name}.`)));
  copySyncs.forEach((i, n) => {
    const next = n + 1 < copySyncs.length ? copySyncs[n + 1] : firstPiece;
    const entry = s.findIndex((x, j) => j > i && x.dossier && x.chemin === copy);
    assert.ok(i >= 0 && entry > i && entry < next, `${copied[n]} de la copie, puis le dossier de la copie, avant ${copied[n + 1] ?? 'le premier morceau'}`);
  });
  const lastCopyDir = lastAt(x => x.dossier && x.chemin === copy);
  assert.ok(lastCopyDir > mark && lastCopyDir < firstPiece, 'copie-complete et son entrée synchronisés avant le premier morceau');
  const pieceSyncs = s.map((x, i) => [x, i]).filter(([x]) => x.chemin.startsWith(`data/soirees/${piece}`)).map(([, i]) => i);
  assert.ok(pieceSyncs.length >= 4 && Math.min(...pieceSyncs) > mark && Math.max(...pieceSyncs) < originFirst, 'le morceau entre copie-complete et l’origine');
  const pieceMetaSync = at(x => x.chemin.startsWith(`data/soirees/${piece}/meta.json.`));
  assert.ok(pieceMetaSync >= 0 && pieceMetaSync < at(x => x.chemin.startsWith(`data/soirees/${piece}/journal.jsonl.`)), 'meta.json du morceau d’abord');
  for (const parent of ['data', 'data/soirees-originales', `data/soirees-originales/${ORIGIN}`, 'data/soirees']) {
    const i = at(x => x.dossier && x.chemin === parent);
    assert.ok(i >= 0 && i < originFirst, `dossier créé synchronisé dans ${parent}`);
  }
  const originJournal = at(x => x.chemin.startsWith(`data/soirees/${ORIGIN}/journal.jsonl.`));
  assert.ok(originJournal >= 0 && originJournal < lastAt(x => x.chemin.startsWith(`data/soirees/${ORIGIN}/meta.json.`)), 'journal.jsonl, puis meta.json');
  // fsyncSync en échec sur la copie.
  const k = banc();
  poser(k.disk, ORIGIN, { meta, events });
  const before = k.disk.contenus(`data/soirees/${ORIGIN}`);
  k.disk.crochet = (op, chemin) => (op === 'sync' && chemin.startsWith('data/soirees-originales/') ? 'EIO' : null);
  const failed = k.repair(ORIGIN);
  assert.deepEqual([failed.status, failed.code, failed.step, failed.attempts], ['retry', 'EIO', 'copie', 1]);
  assert.deepEqual(k.disk.contenus(`data/soirees/${ORIGIN}`), before, 'origine intacte');
  assert.deepEqual(k.disk.fichiers('data/soirees').filter(rel => !rel.startsWith(`data/soirees/${ORIGIN}/`) && !rel.endsWith('.bornage.json')), [], 'aucun morceau');
  assert.deepEqual(bornage(k.disk).checked[ORIGIN], { status: 'retry', attempts: 1, code: 'EIO', version: 'v3.5.0' });
});

test('A7 : sous Windows (platform win32, sleep noté) : aucun dossier synchronisé ; renommage du journal d’origine refusé deux fois par EPERM : soirée découpée après 10 puis 50 ms, « 2 renommages refaits » ; refusé quatre fois par EBUSY : 10, 50 et 200 ms, puis retry avec EBUSY, origine intacte, et « 3 renommages refaits » dans sa ligne d’échec ; sous Linux, un seul EPERM donne retry sans attente', () => {
  const { events, meta } = fixture24();
  const refus = (b, code, times) => {
    let left = times;
    b.disk.crochet = (op, chemin, info) => (op === 'rename' && info.vers === `data/soirees/${ORIGIN}/journal.jsonl` && left-- > 0 ? code : null);
  };
  const w = banc({ platform: 'win32' });
  poser(w.disk, ORIGIN, { meta, events });
  refus(w, 'EPERM', 2);
  assert.equal(w.repair(ORIGIN).status, 'split');
  assert.deepEqual(w.attentes, [10, 50]);
  assert.ok(w.disk.syncs.length > 0 && w.disk.syncs.every(x => !x.dossier), 'aucun dossier synchronisé sous Windows');
  assert.match(w.lignes[0], / ; 2 renommages refaits ; en \d+ ms\.$/);
  const busy = banc({ platform: 'win32' });
  poser(busy.disk, ORIGIN, { meta, events });
  const before = busy.disk.contenus(`data/soirees/${ORIGIN}`);
  refus(busy, 'EBUSY', 4);
  const r = busy.repair(ORIGIN);
  assert.deepEqual([r.status, r.code, r.step, r.renames], ['retry', 'EBUSY', 'journal', 3]);
  assert.deepEqual(busy.attentes, [10, 50, 200]);
  assert.deepEqual(sansTmp(busy.disk.contenus(`data/soirees/${ORIGIN}`)), before, 'origine intacte');
  assert.deepEqual(busy.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « journal » (EBUSY, essai 1 sur 3 ; 3 renommages refaits) : reprise au prochain démarrage.`]);
  const linux = banc({ platform: 'linux' });
  poser(linux.disk, ORIGIN, { meta, events });
  refus(linux, 'EPERM', 1);
  const l = linux.repair(ORIGIN);
  assert.deepEqual([l.status, l.code], ['retry', 'EPERM']);
  assert.deepEqual(linux.attentes, []);
});

test('A7 : arrêt simulé après chaque écriture : le démarrage suivant donne le même résultat ; à chaque étape, list() montre une seule fois chaque karaoké, et les morceaux apparaissent quand le dossier d’origine est réécrit ; EBUSY au renommage du journal d’origine, puis EBUSY en lecture : retry (essais, code), puis la soirée finie avec le même identifiant de morceau', () => {
  const started = performance.now();
  const { events, meta } = fixture24();
  const nights = [...new Set(events.filter(isActivity).map(e => e.boot))].map(boot => Math.min(...events.filter(e => e.boot === boot && isActivity(e)).map(e => e.t)));
  assert.equal(nights.length, 2);
  const reference = banc();
  poser(reference.disk, ORIGIN, { meta, events });
  const done = reference.repair(ORIGIN);
  const final = sansTmp(reference.disk.contenus());
  const once = journal => {
    const rows = journal.list();
    for (const t of nights) {
      const covering = rows.filter(row => row.startedAt <= t && (row.endedAt == null || t <= row.endedAt));
      assert.equal(covering.length, 1, `karaoké de ${new Date(t).toISOString()} : ${covering.map(r => r.id)}`);
    }
    return rows;
  };
  let stops = 0;
  for (let n = 1; ; n++) {
    const b = banc();
    poser(b.disk, ORIGIN, { meta, events });
    b.disk.arretApres(n);
    b.repair(ORIGIN);
    if (!b.disk.releve) break;
    stops++;
    const restart = banc({ depuis: b.disk.releve });
    const rows = once(restart.journal);
    const originMeta = lireJson(restart.disk, `data/soirees/${ORIGIN}/meta.json`);
    assert.equal(rows.some(row => row.id === done.pieces[0].id), originMeta.split?.generation === 1, `arrêt ${n} : morceau montré seulement une fois l’origine réécrite`);
    const again = restart.repair(ORIGIN);
    assert.ok(['split', 'ok', 'skipped'].includes(again.status), `arrêt ${n} : ${again.status} ${again.code}`);
    const got = sansTmp(restart.disk.contenus());
    got.delete('data/soirees/.bornage.json');
    const want = new Map(final);
    want.delete('data/soirees/.bornage.json');
    assert.deepEqual([...got.keys()], [...want.keys()], `arrêt ${n} : mêmes fichiers`);
    for (const [rel, data] of want) assert.equal(got.get(rel), data, `arrêt ${n} : ${rel}`);
    once(restart.journal);
  }
  assert.ok(stops > 20, `${stops} arrêts simulés`);
  console.log(`# Arrêt simulé après chacune des ${stops} écritures de la réparation : ${Math.round(performance.now() - started)} ms`);
  // EBUSY au renommage du journal d'origine, puis en lecture.
  const b = banc();
  poser(b.disk, ORIGIN, { meta, events });
  let left = 1;
  b.disk.crochet = (op, chemin, info) => (op === 'rename' && info.vers === `data/soirees/${ORIGIN}/journal.jsonl` && left-- > 0 ? 'EBUSY' : null);
  assert.deepEqual([b.repair(ORIGIN).status, bornage(b.disk).checked[ORIGIN]], ['retry', { status: 'retry', attempts: 1, code: 'EBUSY', version: 'v3.5.0' }]);
  once(b.journal);
  const second = banc({ depuis: b.disk.instantane() });
  let reads = 1;
  second.disk.crochet = (op, chemin) => (op === 'read' && chemin === `data/soirees/${ORIGIN}/meta.json` && reads-- > 0 ? 'EBUSY' : null);
  const r2 = second.repair(ORIGIN);
  assert.deepEqual([r2.status, r2.step, r2.attempts], ['retry', 'lecture', 2]);
  assert.deepEqual(second.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « lecture » (EBUSY, essai 2 sur 3) : reprise au prochain démarrage.`]);
  const third = banc({ depuis: second.disk.instantane() });
  // La passe des soirées closes voit aussi le morceau déjà écrit : réparation
  // inachevée, il est laissé à son origine (ignored), sans entrée à l'index.
  assert.deepEqual(third.journal.repairQueue(), [done.pieces[0].id, ORIGIN].sort());
  assert.equal(third.repair(done.pieces[0].id).status, 'ignored');
  assert.equal(bornage(third.disk).checked[done.pieces[0].id], undefined);
  const r3 = third.repair(ORIGIN);
  assert.equal(r3.status, 'split');
  assert.equal(r3.pieces[0].id, done.pieces[0].id, 'même identifiant de morceau');
  assert.match(third.lignes[0], /\(génération 1, reprise de la copie\)/);
  assert.equal(bornage(third.disk).checked[ORIGIN], 'split');
  once(third.journal);
});

test('A7 : soirée en cours en échec ou arrêtée en route (étape « journal », étape « morceau 2 » sur trois nuits, arrêt simulé après chaque écriture), puis rouverte par journal.open : list() montre une seule fois chaque karaoké, et un morceau écrit reste caché tant que le meta.json de la soirée en cours n’a pas sa génération', () => {
  // Première activité de chaque nuit : list() la couvre une seule fois.
  const nightsOf = events => [...new Set(events.filter(isActivity).map(e => e.boot))]
    .map(boot => Math.min(...events.filter(e => e.boot === boot && isActivity(e)).map(e => e.t)));
  const once = (journal, nights, label) => {
    const rows = journal.list();
    for (const t of nights) {
      const covering = rows.filter(row => row.startedAt <= t && (row.endedAt == null || t <= row.endedAt));
      assert.equal(covering.length, 1, `${label} : karaoké de ${new Date(t).toISOString()} : ${covering.map(r => r.id)}`);
    }
    return rows.map(row => row.id);
  };
  // Réparation du démarrage en échec (ENOSPC au renommage vers la cible), puis
  // la soirée en cours ouverte telle quelle par le même journal.
  for (const [step, fois, cible] of [['journal', 2, () => `data/soirees/${ORIGIN}/journal.jsonl`],
    ['morceau 2', 3, pieces => `data/soirees/${pieces[1].id}/meta.json`]]) {
    const { events, meta } = fixture24({ fois, close: false });
    const nights = nightsOf(events);
    assert.equal(nights.length, fois);
    const reference = banc();
    poser(reference.disk, ORIGIN, { meta, events });
    const pieces = reference.repair(ORIGIN, { current: true }).pieces;
    assert.equal(pieces.length, fois);
    const b = banc();
    poser(b.disk, ORIGIN, { meta, events });
    const vers = cible(pieces);
    b.disk.crochet = (op, chemin, info) => (op === 'rename' && info.vers === vers ? 'ENOSPC' : null);
    const r = b.repair(ORIGIN, { current: true });
    b.disk.crochet = null;
    assert.deepEqual([r.status, r.code, r.step, r.current], ['retry', 'ENOSPC', step, true], step);
    const written = pieces.slice(0, -1).map(p => p.id).filter(id => b.disk.existe(`data/soirees/${id}/meta.json`));
    assert.ok(written.length >= 1, `${step} : un morceau déjà écrit`);
    assert.equal(b.journal.open({ resume: { id: ORIGIN } }), true, step);
    const ids = once(b.journal, nights, step);
    for (const id of written) assert.ok(!ids.includes(id), `${step} : morceau ${id} caché tant que la soirée en cours n’est pas réécrite`);
  }
  // Arrêt simulé après chaque écriture de la réparation de la soirée en cours,
  // puis démarrage suivant sans réparation (KARAOKE_REPAIR=off) : journal.open.
  const started = performance.now();
  const { events, meta } = fixture24({ close: false });
  const nights = nightsOf(events);
  const reference = banc();
  poser(reference.disk, ORIGIN, { meta, events });
  const [piece] = reference.repair(ORIGIN, { current: true }).pieces;
  let stops = 0, shown = 0;
  for (let n = 1; ; n++) {
    const b = banc();
    poser(b.disk, ORIGIN, { meta, events });
    b.disk.arretApres(n);
    b.repair(ORIGIN, { current: true });
    if (!b.disk.releve) break;
    stops++;
    const restart = banc({ depuis: b.disk.releve, repairEnabled: false });
    const generation = lireJson(restart.disk, `data/soirees/${ORIGIN}/meta.json`).split?.generation;
    assert.equal(restart.journal.open({ resume: { id: ORIGIN } }), true, `arrêt ${n}`);
    const ids = once(restart.journal, nights, `arrêt ${n}`);
    assert.equal(ids.includes(piece.id), generation === 1, `arrêt ${n} : morceau montré seulement une fois la soirée en cours réécrite`);
    if (ids.includes(piece.id)) shown++;
  }
  assert.ok(stops > 20 && shown > 0 && shown < stops, `${stops} arrêts simulés, morceau montré après ${shown}`);
  console.log(`# Soirée en cours, arrêt simulé après chacune des ${stops} écritures de la réparation, puis journal.open : ${Math.round(performance.now() - started)} ms`);
});

test('A4 : soirée en cours, arrêt simulé après chaque écriture de sa réparation du démarrage, puis démarrage suivant avec la réparation (KARAOKE_REPAIR absent) : mêmes fichiers qu’une réparation sans arrêt (mêmes morceaux, la copie sans copie-complete), et la soirée en cours jamais notée à l’index', () => {
  const { events, meta } = fixture24({ close: false });
  const reference = banc();
  poser(reference.disk, ORIGIN, { meta, events });
  assert.equal(reference.repair(ORIGIN, { current: true }).status, 'split');
  const want = sansTmp(reference.disk.contenus());
  want.delete('data/soirees/.bornage.json');
  assert.ok(![...want.keys()].some(rel => rel.endsWith('/copie-complete')), 'référence : copie-complete retiré');
  let stops = 0;
  for (let n = 1; ; n++) {
    const b = banc();
    poser(b.disk, ORIGIN, { meta, events });
    b.disk.arretApres(n);
    b.repair(ORIGIN, { current: true });
    if (!b.disk.releve) break;
    stops++;
    const restart = banc({ depuis: b.disk.releve });
    const again = restart.repair(ORIGIN, { current: true });
    assert.ok(['split', 'ok'].includes(again.status) && again.current === true, `arrêt ${n} : ${again.status} ${again.code}`);
    const got = sansTmp(restart.disk.contenus());
    const index = got.has('data/soirees/.bornage.json') ? JSON.parse(got.get('data/soirees/.bornage.json')).checked : {};
    assert.equal(index[ORIGIN], undefined, `arrêt ${n} : la soirée en cours n’est pas notée`);
    got.delete('data/soirees/.bornage.json');
    assert.deepEqual([...got.keys()], [...want.keys()], `arrêt ${n} : mêmes fichiers`);
    for (const [rel, data] of want) assert.equal(got.get(rel), data, `arrêt ${n} : ${rel}`);
  }
  assert.ok(stops > 20, `${stops} arrêts simulés`);
});

test('A7 : index tronqué ou mal formé : la réparation continue, une ligne au journal du serveur, index réécrit ; index impossible à écrire : rien n’est bloqué, une ligne, revue au démarrage suivant', () => {
  const { events, meta } = fixture24();
  for (const [text, code] of [['{"rule":"v1","checked":{"2026-10-01_2000_aaaa":"ok",', 'BAD_JSON'], ['{"rule":"v1","checked":[]}', 'BAD_META'],
    ['{"rule":"v1","checked":{"../x":"ok"}}', 'BAD_META'], ['{"rule":"v1","checked":{"2026-10-01_2000_aaaa":{"status":"failed"}}}', 'BAD_META']]) {
    const b = banc();
    poser(b.disk, ORIGIN, { meta, events });
    b.disk.ecrire('data/soirees/.bornage.json', text);
    const result = b.repair(ORIGIN);
    assert.equal(result.status, 'split', code);
    assert.equal(b.lignes[0], `Réparation : index data/soirees/.bornage.json illisible (${code}) : lu comme vide, les soirées closes sont revues. Une soirée remise à l'original (DEPLOIEMENT-SERVEUR §18, « Revenir à l'original d'une soirée découpée ») peut être recoupée : refais son retour à l'original, entrée 'ok' comprise.`);
    assert.deepEqual(bornage(b.disk), { rule: 'v1', checked: { [result.pieces[0].id]: 'ok', [ORIGIN]: 'split' } }, 'index réécrit');
    b.repair(ORIGIN);
    assert.equal(b.lignes.filter(line => line.includes('illisible (')).length, 1, 'une seule ligne');
  }
  const w = banc();
  poser(w.disk, ORIGIN, { meta, events });
  w.disk.crochet = (op, chemin, info) => (op === 'rename' && info.vers === 'data/soirees/.bornage.json' ? 'EROFS' : null);
  assert.equal(w.repair(ORIGIN).status, 'split', 'rien n’est bloqué');
  assert.ok(w.lignes.includes('Réparation : index data/soirees/.bornage.json impossible à écrire (EROFS) : rien n\'est bloqué, la vérification est refaite au prochain démarrage.'));
  assert.equal(w.disk.existe('data/soirees/.bornage.json'), false);
  const next = banc({ depuis: w.disk.instantane() });
  assert.ok(next.journal.repairQueue().includes(ORIGIN), 'revue au démarrage suivant');
  assert.equal(next.repair(ORIGIN).status, 'ok', 'déjà découpée : vérifiée sans coupure');
});

test('A4 : index .bornage.json impossible à lire un instant (EBUSY, EIO : erreur passagère, « Échecs ») : jamais lu comme vide ni réécrit, une ligne, une fois ; la soirée en cours est revue sans lui (rien à couper, ou découpée) ; une soirée close attend, rien n’est lu ni écrit de son dossier ; une soirée remise à l’original (entrée ok) n’est jamais recoupée, ni une entrée failed de cette version refaite', () => {
  const RESTORED = '2026-10-01_1900_aaaa', FAILED = '2026-10-09_1900_cccc';
  const entries = { [RESTORED]: 'ok', '2026-10-08_1900_bbbb': 'split',
    [FAILED]: { status: 'failed', attempts: 1, code: 'BAD_JSON', version: 'v3.5.0' } };
  const text = `${JSON.stringify({ rule: 'v1', checked: entries })}\n`;
  const ligne = code => `Réparation : index data/soirees/.bornage.json impossible à lire (${code}) : laissé tel quel, aucune soirée close n'est revue sans lui (reprise au prochain démarrage). Si cette ligne revient à chaque démarrage, vérifie le disque et le dossier data (droits, antivirus, dossier synchronisé).`;
  const closes = disk => {
    // Soirée remise à l'original (DEPLOIEMENT-SERVEUR §18) : deux nuits fusionnées, close, notée ok.
    poser(disk, RESTORED, fusionnee(RESTORED));
    disk.ecrire(`data/soirees/${FAILED}/meta.json`, '{abîmé');
    disk.ecrire('data/soirees/.bornage.json', text);
  };
  // EBUSY une fois, à la réparation de la soirée en cours au démarrage.
  for (const nights of [1, 2]) {
    const b = banc();
    poser(b.disk, ORIGIN, { meta: metaNuits(nights), events: nuits(nights) });
    closes(b.disk);
    let busy = true;
    b.disk.crochet = (op, chemin) => (op === 'read' && chemin === 'data/soirees/.bornage.json' && busy ? (busy = false, 'EBUSY') : null);
    const r = b.repair(ORIGIN, { current: true });
    assert.deepEqual([r.status, r.current], [nights === 1 ? 'ok' : 'split', true], `${nights} nuit(s)`);
    assert.equal(b.disk.lire('data/soirees/.bornage.json'), text, `${nights} nuit(s) : index laissé tel quel, jamais réécrit vide`);
    assert.equal(b.lignes[0], ligne('EBUSY'));
    // Passe des soirées closes, l'index de nouveau lisible.
    b.journal.open({ resume: { id: ORIGIN } });
    const pieces = r.pieces.slice(0, -1).map(piece => piece.id);
    assert.deepEqual(b.journal.repairQueue(), pieces, `${nights} nuit(s) : ni la soirée remise à l’original ni l’entrée failed`);
    for (const id of pieces) assert.equal(b.repair(id).status, 'ok');
    assert.equal(lireJson(b.disk, `data/soirees/${RESTORED}/meta.json`).split, undefined, 'jamais recoupée');
    assert.deepEqual(bornage(b.disk), { rule: 'v1', checked: { ...entries, ...Object.fromEntries(pieces.map(id => [id, 'ok'])) } }, 'entrées gardées');
    assert.equal(b.lignes.filter(line => line.includes('.bornage.json')).length, 1, 'une ligne, une fois');
  }
  // EIO à chaque lecture de l'index, pendant la passe : chaque soirée close
  // attend, sans que son dossier soit lu.
  const c = banc();
  closes(c.disk);
  const before = c.disk.contenus();
  c.disk.crochet = (op, chemin) => (op === 'read' && chemin === 'data/soirees/.bornage.json' ? 'EIO' : null);
  const queue = c.journal.repairQueue();
  assert.deepEqual(queue, [RESTORED, FAILED], 'index illisible : chaque soirée proposée, repair relit l’index');
  const from = c.disk.ops.length;
  for (const id of queue) {
    const w = c.repair(id);
    assert.deepEqual([w.status, w.code, w.step], ['skipped', 'EIO', 'index'], id);
  }
  assert.deepEqual(c.disk.ops.slice(from).map(o => `${o.op} ${o.chemin}`), queue.map(() => 'read data/soirees/.bornage.json'), 'seul l’index est lu');
  const asCurrent = c.repair(RESTORED, { current: true });
  assert.deepEqual([asCurrent.status, asCurrent.code, asCurrent.step], ['skipped', 'EIO', 'index'], 'soirée close donnée comme en cours : elle suit l’index');
  assert.deepEqual(c.disk.contenus(), before, 'rien d’écrit');
  assert.deepEqual(c.lignes, [ligne('EIO')], 'une ligne, une fois');
  // L'index de nouveau lisible : la soirée remise à l'original n'est pas revue.
  c.disk.crochet = null;
  assert.equal(c.repair(RESTORED).status, 'skipped');
  assert.deepEqual(c.disk.contenus(), before);
});

test('A4 : lignes d’échec au texte exact (ENOSPC aux essais 1 et 3, EROFS au troisième essai, meta.json illisible, exception avec sa pile), sans prénom ni message : ENOSPC trois fois de suite donne failed (attempts: 3), meta.json illisible failed au premier essai, une TypeError ERR_INVALID_ARG_TYPE de writeFileSync failed aussitôt (EXCEPTION) ; une entrée failed d’une version précédente est refaite, celle de cette version non', () => {
  const { events, meta } = fixture24();
  const startups = (code, times = 3) => {
    let disk = null;
    const out = [];
    for (let i = 0; i < times; i++) {
      const b = banc(disk ? { depuis: disk.instantane() } : {});
      if (!disk) poser(b.disk, ORIGIN, { meta, events });
      b.disk.crochet = (op, chemin) => (op === 'open' && chemin.startsWith(`data/soirees-originales/${ORIGIN}/1/meta.json.`) ? code : null);
      const result = b.repair(ORIGIN);
      out.push({ result, lignes: b.lignes, entry: bornage(b.disk).checked[ORIGIN], queue: b.journal.repairQueue() });
      disk = b.disk;
    }
    return out;
  };
  const enospc = startups('ENOSPC');
  assert.deepEqual(enospc.map(s => [s.result.status, s.result.attempts]), [['retry', 1], ['retry', 2], ['failed', 3]]);
  assert.deepEqual(enospc[2].entry, { status: 'failed', attempts: 3, code: 'ENOSPC', version: 'v3.5.0' });
  assert.deepEqual(enospc[0].lignes, [`Réparation : ${ORIGIN} en échec à l'étape « copie » (ENOSPC, essai 1 sur 3) : reprise au prochain démarrage.`]);
  assert.deepEqual(enospc[2].lignes, [`Réparation : ${ORIGIN} en échec à l'étape « copie » (ENOSPC, essai 3 sur 3) : notée failed. Libère le disque, puis refais-la ${REFAIRE}.`]);
  assert.deepEqual(enospc[2].queue, [], 'failed : plus revue à cette version');
  const erofs = startups('EROFS');
  assert.deepEqual(erofs.map(s => s.entry), [1, 2, 3].map(attempts => ({ status: attempts < 3 ? 'retry' : 'failed', attempts, code: 'EROFS', version: 'v3.5.0' })));
  assert.deepEqual(erofs[2].lignes, [`Réparation : ${ORIGIN} en échec à l'étape « copie » (EROFS, essai 3 sur 3) : notée failed. Vérifie le disque et le dossier data (droits, antivirus, dossier synchronisé), puis refais-la ${REFAIRE}.`]);
  // meta.json illisible, avec un prénom dedans.
  const bad = banc();
  bad.disk.ecrire(`data/soirees/${ORIGIN}/meta.json`, '{"roster":{"S01":{"name":"Léa"}},"startedAt":');
  bad.disk.ecrire(`data/soirees/${ORIGIN}/journal.jsonl`, texte(events));
  const before = bad.disk.contenus(`data/soirees/${ORIGIN}`);
  const r = bad.repair(ORIGIN);
  assert.deepEqual([r.status, r.code, r.attempts], ['failed', 'BAD_JSON', 1]);
  assert.deepEqual(bornage(bad.disk).checked[ORIGIN], { status: 'failed', attempts: 1, code: 'BAD_JSON', version: 'v3.5.0' });
  assert.deepEqual(bad.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « lecture » (BAD_JSON, meta.json) : notée failed, ses fichiers restent tels quels. Répare ou remets le fichier, puis refais-la ${REFAIRE}.`]);
  assert.deepEqual(bad.disk.contenus(`data/soirees/${ORIGIN}`), before, 'meta.json illisible jamais réécrit');
  // TypeError au code ERR_INVALID_ARG_TYPE levée par writeFileSync.
  const x = banc();
  poser(x.disk, ORIGIN, { meta, events });
  x.disk.crochet = (op, chemin) => (op === 'write' && /^data\/soirees\/\d{4}-[^/]+\/meta\.json\./.test(chemin) && !chemin.includes(ORIGIN)
    ? Object.assign(new TypeError('Léa : argument invalide'), { code: 'ERR_INVALID_ARG_TYPE' }) : null);
  const e = x.repair(ORIGIN);
  assert.deepEqual([e.status, e.code, e.step, e.attempts], ['failed', 'EXCEPTION', 'morceau 1', 1]);
  assert.equal(x.lignes[0], `Réparation : ${ORIGIN} en échec à l'étape « morceau 1 » (EXCEPTION, TypeError) : notée failed, refaite à la prochaine version. Envoie cette ligne et la suivante au développeur ${ENVOYER}.`);
  assert.match(x.lignes[1], new RegExp(`^Réparation : pile de ${ORIGIN} : at .+`));
  assert.equal(x.lignes.length, 2);
  for (const line of [...x.lignes, ...bad.lignes]) assert.ok(!line.includes('Léa') && !line.includes('argument invalide'), line);
  // Entrée failed d'une version précédente : refaite ; de cette version : non.
  const old = banc();
  poser(old.disk, ORIGIN, { meta, events });
  old.disk.ecrire('data/soirees/.bornage.json', JSON.stringify({ rule: 'v1', checked: { [ORIGIN]: { status: 'failed', attempts: 1, code: 'BAD_JSON', version: 'v3.4.0' } } }));
  assert.deepEqual(old.journal.repairQueue(), [ORIGIN]);
  assert.equal(old.repair(ORIGIN).status, 'split');
  const same = banc();
  poser(same.disk, ORIGIN, { meta, events });
  same.disk.ecrire('data/soirees/.bornage.json', JSON.stringify({ rule: 'v1', checked: { [ORIGIN]: { status: 'failed', attempts: 1, code: 'BAD_JSON', version: 'v3.5.0' } } }));
  assert.deepEqual(same.journal.repairQueue(), []);
  assert.equal(same.repair(ORIGIN).status, 'skipped');
  const rule = banc();
  poser(rule.disk, ORIGIN, { meta, events });
  rule.disk.ecrire('data/soirees/.bornage.json', JSON.stringify({ rule: 'v0', checked: { [ORIGIN]: { status: 'failed', attempts: 1, code: 'BAD_JSON', version: 'v3.5.0' } } }));
  assert.equal(rule.repair(ORIGIN).status, 'split', 'refaite quand la règle change');
});

test('A4 : entrées failed d’une règle précédente (index à la règle v0, même version de l’application) : chacune refaite par la passe, même quand une autre soirée, la soirée en cours au démarrage (découpée ou non) ou splitAt réécrit l’index avant elle ; ses essais repartent de 1, et l’index réécrit à la règle v1 n’en garde aucune', () => {
  const A = '2026-10-01_1900_aaaa', B = '2026-10-08_1900_bbbb', D = '2026-10-09_1900_dddd';
  const old = { status: 'failed', attempts: 1, code: 'EXCEPTION', version: 'v3.5.0' };
  const v0 = checked => `${JSON.stringify({ rule: 'v0', checked })}\n`;
  const failures = index => Object.keys(index.checked).filter(id => index.checked[id] !== 'ok' && index.checked[id] !== 'split');
  // Passe des soirées closes : A, découpée, réécrit l'index avant B et D.
  const p = banc();
  for (const id of [A, B]) poser(p.disk, id, fusionnee(id));
  p.disk.ecrire(`data/soirees/${D}/meta.json`, '{abîmé');
  p.disk.ecrire('data/soirees/.bornage.json', v0({ [A]: old, [B]: old, [D]: { status: 'failed', attempts: 3, code: 'ENOSPC', version: 'v3.5.0' } }));
  const queue = p.journal.repairQueue();
  assert.deepEqual(queue, [A, B, D]);
  assert.deepEqual(queue.map(id => p.repair(id)).map(r => [r.status, r.attempts]), [['split', null], ['split', null], ['failed', 1]]);
  const index = bornage(p.disk);
  assert.equal(index.rule, 'v1');
  assert.deepEqual(index.checked[D], { status: 'failed', attempts: 1, code: 'BAD_JSON', version: 'v3.5.0' }, 'refaite, essais repartis de 1');
  assert.deepEqual(failures(index), [D], 'aucun échec de la règle v0 gardé sous la règle v1');
  assert.deepEqual(banc({ depuis: p.disk.instantane() }).journal.repairQueue(), [], 'rien à refaire au démarrage suivant');
  // La soirée en cours revue au démarrage (découpée, ou rien à couper), ou
  // splitAt en direct : chacun réécrit l'index à la règle v1 avant la passe.
  const events = nuits(2).filter(e => e.t < NUIT + DAY + 90 * MIN);
  const meta = metaNuits(2);
  for (const how of ['démarrage', 'démarrage sans coupure', 'splitAt']) {
    const b = banc();
    if (how === 'démarrage sans coupure') poser(b.disk, ORIGIN, { meta: metaNuits(1), events: nuits(1) });
    else poser(b.disk, ORIGIN, { meta, events });
    poser(b.disk, A, fusionnee(A));
    b.disk.ecrire('data/soirees/.bornage.json', v0({ [A]: old }));
    if (how === 'splitAt') {
      const loaded = b.journal._load(ORIGIN);
      b.journal.current = { id: ORIGIN, meta: loaded.meta, events: loaded.events, seq: events.length };
      assert.equal(b.journal.splitAt(cutsOf(events, meta)[0], { summarize: resumer, citedIds }).error, null);
    } else {
      assert.equal(b.repair(ORIGIN, { current: true }).status, how === 'démarrage' ? 'split' : 'ok', how);
      b.journal.open({ resume: { id: ORIGIN } });
    }
    assert.deepEqual([bornage(b.disk).rule, failures(bornage(b.disk))], ['v1', []], `${how} : index réécrit sans l’échec de la règle v0`);
    assert.deepEqual(b.journal.repairQueue(), [A], how);
    assert.equal(b.repair(A).status, 'split', how);
  }
});

// Machine d'état de l'index (A4, « Index » et « Échecs ») : chaque sorte
// d'entrée, à la passe des soirées closes et à la réparation du démarrage
// d'une sauvegarde qui désigne une soirée déjà close (arrêt entre la clôture
// et la sauvegarde suivante). closeNotee : la soirée close de deux nuits
// fusionnées (fusionnee), posée avec l'index `checked` à la règle `rule`.
function closeNotee(checked, rule = 'v1') {
  const b = banc();
  poser(b.disk, ORIGIN, fusionnee(ORIGIN));
  b.disk.ecrire('data/soirees/.bornage.json', `${JSON.stringify({ rule, checked })}\n`);
  return b;
}
// Copie de la génération 1 refusée dès son premier fichier (EIO) : un échec
// passager à l'étape « copie », avant toute écriture du dossier.
const copieRefusee = b => { b.disk.crochet = (op, chemin) => (op === 'open' && chemin.startsWith(`data/soirees-originales/${ORIGIN}/`) ? 'EIO' : null); };
// meta.json de la soirée refusé une fois à la lecture (`echec` : un code, ou une erreur).
const lectureRefusee = (b, echec) => {
  let fois = 1;
  b.disk.crochet = (op, chemin) => (op === 'read' && chemin === `data/soirees/${ORIGIN}/meta.json` && fois-- > 0 ? echec : null);
};
const FAILED_ICI = { status: 'failed', attempts: 3, code: 'ENOSPC', version: 'v3.5.0' };
const FAILED_AVANT = { status: 'failed', attempts: 3, code: 'ENOSPC', version: 'v3.4.0' };

test('A4 : entrée failed d’une version précédente, passe des soirées closes : proposée par repairQueue, refaite comme une soirée neuve ; un échec passager repart de l’essai 1 (« essai 1 sur 3 ») et remplace l’entrée périmée, une réussite la remplace par split (morceaux notés ok), et la passe suivante ne la propose plus', () => {
  const echec = closeNotee({ [ORIGIN]: FAILED_AVANT });
  assert.deepEqual(echec.journal.repairQueue(), [ORIGIN]);
  copieRefusee(echec);
  const r = echec.repair(ORIGIN);
  assert.deepEqual([r.status, r.current, r.code, r.step, r.attempts], ['retry', false, 'EIO', 'copie', 1]);
  assert.deepEqual(bornage(echec.disk), { rule: 'v1', checked: { [ORIGIN]: { status: 'retry', attempts: 1, code: 'EIO', version: 'v3.5.0' } } });
  assert.deepEqual(echec.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « copie » (EIO, essai 1 sur 3) : reprise au prochain démarrage.`]);
  const ok = closeNotee({ [ORIGIN]: FAILED_AVANT });
  const done = ok.repair(ORIGIN);
  assert.deepEqual([done.status, done.pieces.length], ['split', 2]);
  assert.deepEqual(bornage(ok.disk), { rule: 'v1', checked: { [done.pieces[0].id]: 'ok', [ORIGIN]: 'split' } }, 'entrée périmée remplacée');
  assert.deepEqual(banc({ depuis: ok.disk.instantane() }).journal.repairQueue(), [], 'plus proposée');
});

// Soirée de la sauvegarde déjà close, dont l'entrée `entry` dispense de la
// revoir : la réparation du démarrage la lit, la sait close, puis la laisse
// (skipped) sans rien écrire ni noter, sans ligne ; la passe ne la propose pas.
function dejaVue(entry) {
  const b = closeNotee({ [ORIGIN]: entry });
  const before = b.disk.contenus();
  const r = b.repair(ORIGIN, { current: true });
  assert.deepEqual([r.status, r.current, r.split, r.code, r.attempts], ['skipped', false, false, null, null]);
  assert.deepEqual(b.disk.contenus(), before, 'index et fichiers tels quels, jamais recoupée');
  assert.equal(b.disk.ops.filter(o => ['write', 'append', 'rename', 'open', 'mkdir', 'unlink'].includes(o.op)).length, 0, 'aucune écriture');
  assert.deepEqual(b.lignes, []);
  assert.deepEqual(b.journal.repairQueue(), [], 'la passe ne la propose pas');
}

test('A4 : soirée de la sauvegarde déjà close, notée ok (vérifiée, ou remise à l’original par DEPLOIEMENT-SERVEUR §18), revue au démarrage : skipped, son entrée gardée, rien d’écrit ni recoupé, aucune ligne ; la passe des soirées closes ne la propose pas', () => dejaVue('ok'));

test('A4 : soirée de la sauvegarde déjà close, notée split, revue au démarrage : skipped, son entrée gardée, rien d’écrit, aucune ligne ; la passe des soirées closes ne la propose pas', () => dejaVue('split'));

test('A4 : soirée de la sauvegarde déjà close, notée retry, revue au démarrage comme une soirée close : réussie, notée split et ses morceaux ok ; un nouvel échec passager continue ses essais (essai 3 sur 3 : failed, ligne au texte du plan), et la passe ne la propose plus', () => {
  const ok = closeNotee({ [ORIGIN]: { status: 'retry', attempts: 1, code: 'EBUSY', version: 'v3.5.0' } });
  const done = ok.repair(ORIGIN, { current: true });
  assert.deepEqual([done.status, done.current, done.attempts], ['split', false, null]);
  assert.deepEqual(bornage(ok.disk), { rule: 'v1', checked: { [done.pieces[0].id]: 'ok', [ORIGIN]: 'split' } });
  const b = closeNotee({ [ORIGIN]: { status: 'retry', attempts: 2, code: 'EBUSY', version: 'v3.5.0' } });
  copieRefusee(b);
  const r = b.repair(ORIGIN, { current: true });
  assert.deepEqual([r.status, r.current, r.code, r.step, r.attempts], ['failed', false, 'EIO', 'copie', 3]);
  assert.deepEqual(bornage(b.disk), { rule: 'v1', checked: { [ORIGIN]: { status: 'failed', attempts: 3, code: 'EIO', version: 'v3.5.0' } } });
  assert.deepEqual(b.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « copie » (EIO, essai 3 sur 3) : notée failed. Vérifie le disque et le dossier data (droits, antivirus, dossier synchronisé), puis refais-la ${REFAIRE}.`]);
  b.disk.crochet = null;
  assert.deepEqual(b.journal.repairQueue(), []);
});

test('A4 : soirée de la sauvegarde déjà close, notée failed à cette version, revue au démarrage : skipped, son entrée et ses fichiers tels quels, aucune ligne ; la passe des soirées closes ne la propose pas (refaite à une version nouvelle, ou par DEPLOIEMENT-SERVEUR §18)', () => dejaVue(FAILED_ICI));

test('A4 : soirée de la sauvegarde déjà close, notée failed par une version précédente, revue au démarrage : refaite comme une soirée neuve ; un échec passager repart de l’essai 1 et remplace l’entrée périmée, une réussite la note split', () => {
  const b = closeNotee({ [ORIGIN]: FAILED_AVANT });
  copieRefusee(b);
  const r = b.repair(ORIGIN, { current: true });
  assert.deepEqual([r.status, r.current, r.code, r.attempts], ['retry', false, 'EIO', 1]);
  assert.deepEqual(bornage(b.disk), { rule: 'v1', checked: { [ORIGIN]: { status: 'retry', attempts: 1, code: 'EIO', version: 'v3.5.0' } } });
  assert.deepEqual(b.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « copie » (EIO, essai 1 sur 3) : reprise au prochain démarrage.`]);
  const ok = closeNotee({ [ORIGIN]: FAILED_AVANT });
  const done = ok.repair(ORIGIN, { current: true });
  assert.deepEqual([done.status, done.current], ['split', false]);
  assert.deepEqual(bornage(ok.disk), { rule: 'v1', checked: { [done.pieces[0].id]: 'ok', [ORIGIN]: 'split' } });
});

test('A4 : soirée de la sauvegarde déjà close, notée failed sous une règle précédente (index à la règle v0, même version de l’application), revue au démarrage : l’entrée retirée à la lecture, la soirée refaite (split, ou un échec passager qui repart de l’essai 1), l’index réécrit à la règle v1 sans l’échec de la règle v0', () => {
  const ok = closeNotee({ [ORIGIN]: FAILED_ICI }, 'v0');
  const done = ok.repair(ORIGIN, { current: true });
  assert.deepEqual([done.status, done.current], ['split', false]);
  assert.deepEqual(bornage(ok.disk), { rule: 'v1', checked: { [done.pieces[0].id]: 'ok', [ORIGIN]: 'split' } });
  const b = closeNotee({ [ORIGIN]: FAILED_ICI }, 'v0');
  copieRefusee(b);
  const r = b.repair(ORIGIN, { current: true });
  assert.deepEqual([r.status, r.code, r.attempts], ['retry', 'EIO', 1]);
  assert.deepEqual(bornage(b.disk), { rule: 'v1', checked: { [ORIGIN]: { status: 'retry', attempts: 1, code: 'EIO', version: 'v3.5.0' } } });
});

test('A4 : soirée de la sauvegarde notée ok, split ou failed à cette version, son meta.json illisible un instant à la réparation du démarrage (EBUSY, avant de savoir si elle est ouverte) : son entrée gardée, index et fichiers intacts, retry rendu au démarrage sans essai compté, une ligne qui ne dit rien noter ; ni la passe de ce démarrage ni celle du suivant ne la revoient, jamais recoupée ; meta.json au JSON abîmé ou exception de sa lecture : de même, failed rendu ; une entrée retry, ou failed d’une version précédente, compte l’essai, ligne au texte du plan', () => {
  for (const [label, entry] of [['ok', 'ok'], ['split', 'split'], ['failed', FAILED_ICI]]) {
    const b = closeNotee({ [ORIGIN]: entry });
    const before = b.disk.contenus();
    lectureRefusee(b, 'EBUSY');
    const r = b.repair(ORIGIN, { current: true });
    assert.deepEqual([r.status, r.current, r.code, r.step, r.attempts], ['retry', false, 'EBUSY', 'lecture', null], label);
    assert.deepEqual(b.disk.contenus(), before, `${label} : index et fichiers tels quels`);
    assert.deepEqual(b.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « lecture » (EBUSY) : entrée ${label} de l'index gardée ; reprise au prochain démarrage si elle est encore en cours.`], label);
    b.disk.crochet = null;
    for (const pass of [b, banc({ depuis: b.disk.instantane() })]) {
      assert.deepEqual(pass.journal.repairQueue(), [], `${label} : jamais proposée`);
      assert.equal(pass.repair(ORIGIN).status, 'skipped', label);
      assert.deepEqual(pass.disk.contenus(), before, `${label} : jamais recoupée`);
    }
  }
  // meta.json au JSON abîmé (avec un prénom), ou exception de sa lecture : entrée ok gardée, failed rendu.
  const abime = closeNotee({ [ORIGIN]: 'ok' });
  abime.disk.ecrire(`data/soirees/${ORIGIN}/meta.json`, '{"roster":{"S01":{"name":"Léa"}');
  const avant = abime.disk.contenus();
  const ra = abime.repair(ORIGIN, { current: true });
  assert.deepEqual([ra.status, ra.current, ra.code, ra.step, ra.attempts], ['failed', false, 'BAD_JSON', 'lecture', null]);
  assert.deepEqual(abime.disk.contenus(), avant, 'meta.json abîmé : index et fichiers tels quels');
  assert.deepEqual(abime.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « lecture » (BAD_JSON, meta.json) : entrée ok de l'index gardée, ses fichiers restent tels quels. Répare ou remets le fichier.`]);
  const x = closeNotee({ [ORIGIN]: 'ok' });
  const avantX = x.disk.contenus();
  lectureRefusee(x, new TypeError('Léa : lecture impossible'));
  const rx = x.repair(ORIGIN, { current: true });
  assert.deepEqual([rx.status, rx.code, rx.step, rx.attempts], ['failed', 'EXCEPTION', 'lecture', null]);
  assert.deepEqual(x.disk.contenus(), avantX, 'exception : index et fichiers tels quels');
  assert.equal(x.lignes[0], `Réparation : ${ORIGIN} en échec à l'étape « lecture » (EXCEPTION, TypeError) : entrée ok de l'index gardée. Envoie cette ligne et la suivante au développeur ${ENVOYER}.`);
  assert.match(x.lignes[1], new RegExp(`^Réparation : pile de ${ORIGIN} : at `));
  assert.equal(x.lignes.length, 2);
  for (const line of [...abime.lignes, ...x.lignes]) assert.ok(!line.includes('Léa') && !line.includes('lecture impossible'), line);
  // Entrée retry (essai suivant) ou failed d'une version précédente (essai 1) : l'essai compte, au texte du plan.
  for (const [entry, essai] of [[{ status: 'retry', attempts: 1, code: 'EIO', version: 'v3.5.0' }, 2], [FAILED_AVANT, 1]]) {
    const b = closeNotee({ [ORIGIN]: entry });
    lectureRefusee(b, 'EBUSY');
    const r = b.repair(ORIGIN, { current: true });
    assert.deepEqual([r.status, r.current, r.attempts], ['retry', false, essai]);
    assert.deepEqual(bornage(b.disk).checked[ORIGIN], { status: 'retry', attempts: essai, code: 'EBUSY', version: 'v3.5.0' });
    assert.deepEqual(b.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « lecture » (EBUSY, essai ${essai} sur 3) : reprise au prochain démarrage.`]);
  }
});

test('A4 : soirée de la sauvegarde notée failed sous une règle précédente (index v0, même version), son meta.json illisible un instant (EBUSY) à la réparation du démarrage : entrée retirée à la lecture, échec compté de l’essai 1, index réécrit à la règle v1', () => {
  const b = closeNotee({ [ORIGIN]: FAILED_ICI }, 'v0');
  lectureRefusee(b, 'EBUSY');
  const r = b.repair(ORIGIN, { current: true });
  assert.deepEqual([r.status, r.current, r.code, r.step, r.attempts], ['retry', false, 'EBUSY', 'lecture', 1]);
  assert.deepEqual(bornage(b.disk), { rule: 'v1', checked: { [ORIGIN]: { status: 'retry', attempts: 1, code: 'EBUSY', version: 'v3.5.0' } } });
});

test('A4 : lecture du démarrage en échec qui garde l’entrée de l’index : le résultat la donne (kept : ok, split ou failed), erreur passagère comme erreur de données, pour que le démarrage juge la note au bar d’une soirée close (server.js) ; sans entrée gardée (retry, failed d’une version précédente, soirée absente de l’index), pas de kept', () => {
  for (const [entry, kept] of [['ok', 'ok'], ['split', 'split'], [FAILED_ICI, 'failed']]) {
    const b = closeNotee({ [ORIGIN]: entry });
    lectureRefusee(b, 'EBUSY');
    const r = b.repair(ORIGIN, { current: true });
    assert.deepEqual([r.status, r.current, r.attempts, r.kept], ['retry', false, null, kept], kept);
    const abime = closeNotee({ [ORIGIN]: entry });
    abime.disk.ecrire(`data/soirees/${ORIGIN}/meta.json`, '{"roster":');
    const ra = abime.repair(ORIGIN, { current: true });
    assert.deepEqual([ra.status, ra.code, ra.attempts, ra.kept], ['failed', 'BAD_JSON', null, kept], `${kept} : JSON abîmé`);
  }
  for (const [label, checked] of [['retry', { [ORIGIN]: { status: 'retry', attempts: 1, code: 'EIO', version: 'v3.5.0' } }],
    ['failed d’une version précédente', { [ORIGIN]: FAILED_AVANT }], ['absente de l’index', {}]]) {
    const b = closeNotee(checked);
    lectureRefusee(b, 'EBUSY');
    const r = b.repair(ORIGIN, { current: true });
    assert.deepEqual([r.status, Object.hasOwn(r, 'kept')], ['retry', false], label);
  }
});

test('A4 : soirée de la sauvegarde notée failed à cette version, son meta.json au JSON abîmé (avec un prénom) à la réparation du démarrage : entrée failed gardée, index et fichiers intacts, failed rendu ; la ligne dit de réparer ou remettre le fichier, puis de la refaire (DEPLOIEMENT-SERVEUR §18), comme pour une soirée notée failed, sans le prénom', () => {
  const b = closeNotee({ [ORIGIN]: FAILED_ICI });
  b.disk.ecrire(`data/soirees/${ORIGIN}/meta.json`, '{"roster":{"S01":{"name":"Léa"}');
  const before = b.disk.contenus();
  const r = b.repair(ORIGIN, { current: true });
  assert.deepEqual(b.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « lecture » (BAD_JSON, meta.json) : entrée failed de l'index gardée, ses fichiers restent tels quels. Répare ou remets le fichier, puis refais-la ${REFAIRE}.`]);
  assert.ok(!b.lignes[0].includes('Léa'));
  assert.deepEqual([r.status, r.current, r.code, r.step, r.attempts, r.kept], ['failed', false, 'BAD_JSON', 'lecture', null, 'failed']);
  assert.deepEqual(b.disk.contenus(), before, 'index et fichiers tels quels');
});

test('A4 : exception du calcul d’un morceau dans planSplit (citedIds qui lève sur une ligne du morceau 2) : ligne d’échec à l’étape « morceau 2 » (EXCEPTION, TypeError) au texte exact, puis sa pile, qui passe par planSplit, sans le message ; failed, rien d’écrit hors de l’index ; une exception des coupures (breaksOf) reste à l’étape « lecture »', () => {
  const { events, meta } = fixture24();
  const [cut] = cutsOf(events, meta);
  assert.ok(events.some(e => e.boot === 'nuit-2' && e.ev === 'song.requested' && e.t > cut), 'une demande de la seconde nuit, après la coupure');
  const lance = e => {
    if (e.boot === 'nuit-2' && e.ev === 'song.requested') throw new TypeError('Léa : citée deux fois');
    return citedIds(e);
  };
  const b = banc();
  poser(b.disk, ORIGIN, { meta, events });
  const before = b.disk.contenus();
  const r = b.repair(ORIGIN, { citedIds: lance });
  assert.deepEqual([r.status, r.code, r.step, r.attempts], ['failed', 'EXCEPTION', 'morceau 2', 1]);
  assert.equal(b.lignes[0], `Réparation : ${ORIGIN} en échec à l'étape « morceau 2 » (EXCEPTION, TypeError) : notée failed, refaite à la prochaine version. Envoie cette ligne et la suivante au développeur ${ENVOYER}.`);
  assert.match(b.lignes[1], new RegExp(`^Réparation : pile de ${ORIGIN} : at lance \\(test/evening-journal\\.test\\.js:\\d+:\\d+\\) · at citedOf \\(evening-split\\.js:\\d+:\\d+\\) · at planSplit \\(evening-split\\.js:\\d+:\\d+\\) · at `));
  assert.equal(b.lignes[1].split(' · ').length, 5, 'cinq lignes « at »');
  assert.equal(b.lignes.length, 2);
  for (const line of b.lignes) assert.ok(!line.includes('Léa') && !line.includes('citée deux fois'), line);
  assert.deepEqual(bornage(b.disk).checked[ORIGIN], { status: 'failed', attempts: 1, code: 'EXCEPTION', version: 'v3.5.0' });
  const after = b.disk.contenus();
  after.delete('data/soirees/.bornage.json');
  assert.deepEqual(after, before, 'rien d’écrit hors de l’index');
  // Une exception des coupures précède le calcul des morceaux : « lecture ».
  const c = banc();
  poser(c.disk, ORIGIN, { meta, events });
  const rc = c.repair(ORIGIN, { breaksOf: () => { throw new TypeError('Léa'); } });
  assert.deepEqual([rc.status, rc.code, rc.step], ['failed', 'EXCEPTION', 'lecture']);
});

test('A7 : génération lue dans meta.json qui n’est pas un entier ≥ 1, ou identifiant invalide : failed (BAD_PATH), rien d’écrit', () => {
  const { events, meta } = fixture24();
  for (const generation of [0, 1.5, '2', -1, null]) {
    const b = banc();
    poser(b.disk, ORIGIN, { meta: { ...meta, split: { from: ORIGIN, part: 2, generation, rule: 'v1' } }, events });
    const before = b.disk.contenus();
    const r = b.repair(ORIGIN);
    assert.deepEqual([r.status, r.code], ['failed', 'BAD_PATH'], String(generation));
    const after = b.disk.contenus();
    after.delete('data/soirees/.bornage.json');
    assert.deepEqual(after, before, 'rien d’écrit hors de l’index');
    assert.deepEqual(bornage(b.disk).checked[ORIGIN], { status: 'failed', attempts: 1, code: 'BAD_PATH', version: 'v3.5.0' });
    assert.deepEqual(b.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « lecture » (BAD_PATH, meta.json) : notée failed, ses fichiers restent tels quels. Répare ou remets le fichier, puis refais-la ${REFAIRE}.`]);
  }
  const b = banc();
  poser(b.disk, ORIGIN, { meta, events });
  const before = b.disk.contenus();
  for (const id of ['../x', '', null, `${ORIGIN}/..`]) {
    const r = b.repair(id);
    assert.deepEqual([r.status, r.code], ['failed', 'BAD_PATH']);
  }
  assert.deepEqual(b.disk.contenus(), before, 'rien d’écrit, pas même l’index');
  assert.equal(b.lignes[0], `Réparation : identifiant de soirée invalide, rien n'est lu ni écrit. Envoie cette ligne au développeur ${ENVOYER}.`);
});

test('A7 : la fixture recopiée à +24 h avec une ligne coupée au milieu : deux soirées, la ligne comptée dans la trace et dans aucun morceau, la copie d’origine identique octet pour octet', () => {
  const { events, meta } = fixture24();
  const lines = events.map(e => JSON.stringify(e));
  const middle = Math.floor(lines.length / 3);
  lines[middle] = lines[middle].slice(0, 25);
  const text = lines.join('\n') + '\n';
  const b = banc();
  poser(b.disk, ORIGIN, { meta, events, text });
  const result = b.repair(ORIGIN);
  assert.equal(result.pieces.length, 2);
  assert.match(b.lignes[0], / ; 1 ligne illisible laissée à la copie ; en \d+ ms\.$/);
  assert.equal(b.disk.lire(`data/soirees-originales/${ORIGIN}/1/journal.jsonl`), text, 'copie octet pour octet');
  const kept = events.filter((e, i) => i !== middle).map(cle).sort();
  const pieces = propres(b.disk, result.pieces.map(p => p.id)).filter(e => !(e.ev === 'evening.closed' && e.split));
  assert.deepEqual(pieces.map(cle).sort(), kept, 'l’union des morceaux redonne les lignes lisibles');
});

test('A4 : champ ajouté : une ancienne soirée close par « Supprimer toutes les tables », vue sans coupure, reçoit karaoke et closedBy, champs seulement, une seule fois ; une soirée close d’office à C avec 3 h de lignes d’attente (Retard de 3 h) est notée ok sans réécrire aucun fichier de son dossier', () => {
  const b = banc();
  const { events, meta } = fixture24({ fois: 1 });
  poser(b.disk, ORIGIN, { meta, events, summary: { ancien: true } });
  const before = b.disk.contenus(`data/soirees/${ORIGIN}`);
  const r = b.repair(ORIGIN);
  assert.equal(r.status, 'ok');
  const after = lireJson(b.disk, `data/soirees/${ORIGIN}/meta.json`);
  assert.deepEqual(Object.keys(after), [...Object.keys(meta), 'karaoke', 'closedBy']);
  assert.deepEqual({ ...after, karaoke: undefined, closedBy: undefined }, { ...meta, karaoke: undefined, closedBy: undefined });
  assert.equal(after.closedBy, 'staff-reset');
  assert.deepEqual(after.karaoke, soirees.karaokeOf(resumer({ meta, events }), events));
  for (const name of ['journal.jsonl', 'summary.json']) assert.equal(b.disk.lire(`data/soirees/${ORIGIN}/${name}`), before.get(`data/soirees/${ORIGIN}/${name}`), name);
  assert.deepEqual(bornage(b.disk).checked, { [ORIGIN]: 'ok' });
  assert.match(b.lignes[0], new RegExp(`^Réparation : ${ORIGIN} vérifiée sans coupure : ${events.length} lignes, karaoke et closedBy ajoutés à meta\\.json ; en \\d+ ms\\.$`));
  assert.equal(b.repair(ORIGIN).status, 'skipped');
  assert.equal(b.lignes.length, 1, 'une ligne seulement à la première vérification');
  // Close d'office à C, remise à zéro 3 h plus tard : lignes d'attente, aucune activité.
  const c = banc();
  const solo = fixture24({ fois: 1, close: false });
  const C = Date.parse('2026-10-16T09:00:00+02:00');
  assert.ok(Math.max(...solo.events.map(e => e.t)) < C);
  let seq = solo.events.length;
  const wait = (t, ev, fields) => solo.events.push({ ...fields, v: 1, seq: ++seq, t, ev, boot: 'attente' });
  wait(C + 5 * MIN, 'karaoke.phase', { phase: 'silent', blocker: 'evening-end' });
  for (const [i, id] of ['S01', 'S02', 'S03', 'S04', 'S05', 'S06'].entries()) wait(C + (10 + i) * MIN, 'person.seen', { personId: id });
  wait(C + 20 * MIN, 'notice.sent', { personId: 'S01', kind: 'turnSoon' });
  wait(C + 21 * MIN, 'presence.asked', { personIds: ['S02'], entryId: null, source: 'auto' });
  wait(C + 22 * MIN, 'song.removed', { personId: 'S03', entryId: 'e1', by: 'staff' });
  wait(C + 23 * MIN, 'turn.sent', { entryId: 'e2', ids: ['S04'], ownerId: 'S04', kind: 'solo', sentAt: C + 23 * MIN });
  wait(C + 24 * MIN, 'stage.ended', { queueId: 1, playedSec: 200 });
  wait(C + 25 * MIN, 'queue.sample', { ready: 1 });
  wait(C + 26 * MIN, 'person.left', { personId: 'S05', by: 'staff', songsDropped: 0 });
  wait(C + 170 * MIN, 'app.started', { restored: true, offlineMs: 40 * MIN });
  wait(C + 3 * H, 'evening.closed', { by: 'auto', reason: 'morning', closedAt: C });
  const auto = { ...solo.meta, endedAt: C, karaoke: { openedAt: solo.events[0].t, closedAt: C - H }, closedBy: 'auto' };
  poser(c.disk, ORIGIN, { meta: auto, events: solo.events, summary: { resume: true } });
  assert.deepEqual(cutsOf(solo.events, auto), [], 'eveningBreaks n’y coupe rien');
  const files = c.disk.contenus(`data/soirees/${ORIGIN}`);
  assert.equal(c.repair(ORIGIN).status, 'ok');
  assert.deepEqual(c.disk.contenus(`data/soirees/${ORIGIN}`), files, 'aucun fichier de son dossier réécrit');
  assert.equal(c.disk.ops.filter(o => ['write', 'rename', 'open'].includes(o.op) && o.chemin.startsWith(`data/soirees/${ORIGIN}`)).length, 0);
  assert.deepEqual(bornage(c.disk).checked, { [ORIGIN]: 'ok' });
});

test('A7 : pendant la passe des soirées closes, list() appelée entre deux soirées ne compte jamais une soirée deux fois ; après la passe, list() ne lit aucun summary.json ni journal.jsonl, et repairQueue ne propose plus rien', () => {
  const b = banc();
  const ids = ['2026-10-15_1900_aaaa', '2026-10-25_1900_bbbb', '2026-11-05_1900_cccc'];
  const firsts = [];
  for (const [i, id] of ids.entries()) {
    const shift = i * 10 * DAY;
    const { events, meta } = i === 1 ? fixture24({ fois: 1, id }) : fixture24({ id });
    const moved = events.map(e => ({ ...e, t: e.t + shift }));
    poser(b.disk, id, { meta: { ...meta, startedAt: meta.startedAt + shift, endedAt: meta.endedAt + shift }, events: moved, summary: { ancien: id } });
    for (const boot of new Set(moved.filter(isActivity).map(e => e.boot))) firsts.push(Math.min(...moved.filter(e => e.boot === boot && isActivity(e)).map(e => e.t)));
  }
  const once = () => {
    const rows = b.journal.list();
    for (const t of firsts) assert.equal(rows.filter(row => row.startedAt <= t && (row.endedAt == null || t <= row.endedAt)).length, 1);
  };
  const queue = b.journal.repairQueue();
  assert.deepEqual(queue, ids);
  once();
  const statuses = [];
  for (const id of queue) { statuses.push(b.repair(id).status); once(); }
  assert.deepEqual(statuses, ['split', 'ok', 'split']);
  const reads = b.disk.ops.length;
  const rows = b.journal.list();
  assert.equal(rows.length, 5);
  const listed = b.disk.ops.slice(reads).filter(o => o.op === 'read');
  assert.ok(listed.length > 0 && listed.every(o => o.chemin.endsWith('/meta.json') || o.chemin === 'data/soirees/.bornage.json'),
    'list() ne lit que les meta.json et l’index (A5 : état de la réparation)');
  assert.deepEqual(b.journal.repairQueue(), []);
});

// Ligne « Réparation : » d'un meta.json fini sans recouper : celle de la
// réparation sans arrêt du même journal, sa génération suivie de « meta.json
// fini sans recouper » ; durées ramenées à N.
const sansDuree = line => line.replace(/ en \d+ ms\.$/, ' en N ms.');
const ligneFinie = line => sansDuree(line).replace(/ \(génération (\d+)\) : /, ' (génération $1, meta.json fini sans recouper) : ');

test('A4 : dossier arrêté entre son journal et son meta.json, sans copie qui serve : la réparation finit meta.json (début à l’heure des lignes reportées, prénoms et tables filtrés, split), sans recouper ; pour la soirée en cours, son dernier morceau archivé est retrouvé', () => {
  for (const close of [true, false]) {
    const { events, meta } = fixture24({ close });
    const reference = banc();
    poser(reference.disk, ORIGIN, { meta, events });
    const done = reference.repair(ORIGIN, { current: !close });
    const b = banc();
    poser(b.disk, ORIGIN, { meta, events });
    b.disk.crochet = (op, chemin, info) => {
      if (op === 'rename' && info.vers === `data/soirees/${ORIGIN}/journal.jsonl`) b.disk.arretApres(1);
    };
    b.repair(ORIGIN, { current: !close });
    const restart = banc({ depuis: b.disk.releve });
    assert.ok(lignesDe(restart.disk, ORIGIN)[0].carried, 'journal du dossier réécrit');
    assert.equal(lireJson(restart.disk, `data/soirees/${ORIGIN}/meta.json`).split, undefined, 'meta.json pas encore');
    // La copie ne sert pas : son copie-complete est parti.
    restart.disk.fs.unlinkSync(restart.disk.absolu(`data/soirees-originales/${ORIGIN}/1/copie-complete`));
    const pieceFiles = restart.disk.contenus(`data/soirees/${done.pieces[0].id}`);
    const result = restart.repair(ORIGIN, { current: !close });
    assert.deepEqual([result.status, result.split, result.generation], ['split', true, 1]);
    assert.deepEqual(result.pieces, done.pieces, 'les morceaux écrits, comme sans arrêt');
    assert.deepEqual(restart.lignes.map(sansDuree), [ligneFinie(reference.lignes[0])], 'la ligne d’une soirée découpée');
    assert.deepEqual(lireJson(restart.disk, `data/soirees/${ORIGIN}/meta.json`), lireJson(reference.disk, `data/soirees/${ORIGIN}/meta.json`), close ? 'close' : 'en cours');
    assert.deepEqual(restart.disk.contenus(`data/soirees/${done.pieces[0].id}`), pieceFiles, 'rien de recoupé');
    if (!close) assert.deepEqual(plain(result.previous), plain(done.previous));
    else assert.deepEqual(lireJson(restart.disk, `data/soirees/${ORIGIN}/summary.json`), lireJson(reference.disk, `data/soirees/${ORIGIN}/summary.json`));
  }
});

test('A4 : trace d’un meta.json fini sans recouper : soirée en cours réparée au démarrage, renommage de son meta.json refusé (ENOSPC, retry), puis démarrage suivant : sa ligne « Réparation : » donne chaque morceau (identifiant, début et fin, nombre de lignes), les lignes reportées et la ligne coupée laissée à la copie, comme la réparation sans échec, et repair rend ses morceaux ; un morceau introuvable, le journal illisible d’un morceau et une copie illisible y sont nommés', () => {
  // Deux nuits de la fixture, une ligne coupée au milieu du journal.
  const { events, meta } = fixture24({ close: false });
  const rows = events.map(e => JSON.stringify(e));
  const middle = Math.floor(rows.length / 3);
  rows[middle] = rows[middle].slice(0, 25);
  const text = rows.join('\n') + '\n';
  const reference = banc();
  poser(reference.disk, ORIGIN, { meta, events, text });
  const done = reference.repair(ORIGIN, { current: true });
  assert.deepEqual([done.status, done.pieces.length], ['split', 2]);
  assert.match(reference.lignes[0], / ; 1 ligne illisible laissée à la copie ; en \d+ ms\.$/);
  // Premier démarrage : le meta.json de la soirée ne s'écrit pas, copie-complete est retiré.
  const first = banc();
  poser(first.disk, ORIGIN, { meta, events, text });
  first.disk.crochet = (op, chemin, info) => (op === 'rename' && info.vers === `data/soirees/${ORIGIN}/meta.json` ? 'ENOSPC' : null);
  const failed = first.repair(ORIGIN, { current: true });
  assert.deepEqual([failed.status, failed.code, failed.step], ['retry', 'ENOSPC', 'meta.json']);
  assert.deepEqual(first.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « meta.json » (ENOSPC, essai 1 sur 3) : reprise au prochain démarrage.`]);
  assert.equal(first.disk.existe(`data/soirees-originales/${ORIGIN}/1/copie-complete`), false);
  // Démarrage suivant : meta.json fini sans recouper, et la ligne d'une soirée découpée.
  const restart = banc({ depuis: first.disk.instantane() });
  const result = restart.repair(ORIGIN, { current: true });
  assert.deepEqual([result.status, result.current, result.split, result.generation], ['split', true, true, 1]);
  assert.deepEqual(result.pieces, done.pieces);
  assert.deepEqual(plain(result.previous), plain(done.previous));
  assert.deepEqual(restart.lignes.map(sansDuree), [ligneFinie(reference.lignes[0])]);
  const soireesDe = disk => new Map([...sansTmp(disk.contenus('data/soirees'))].filter(([rel]) => !rel.endsWith('/.bornage.json')));
  assert.deepEqual(soireesDe(restart.disk), soireesDe(reference.disk), 'mêmes soirées que la réparation sans échec');
  // Trois nuits, close, arrêtée entre son journal et son meta.json ; puis le
  // meta.json du morceau 1 retiré, le journal du morceau 2 et celui de la
  // copie remplacés par un dossier.
  const three = fixture24({ fois: 3 });
  const ref3 = banc();
  poser(ref3.disk, ORIGIN, three);
  const [p1, p2, p3] = ref3.repair(ORIGIN).pieces;
  assert.ok(p1 && p2 && p3 && p3.id === ORIGIN);
  const stop = banc();
  poser(stop.disk, ORIGIN, three);
  stop.disk.crochet = (op, chemin, info) => { if (op === 'rename' && info.vers === `data/soirees/${ORIGIN}/journal.jsonl`) stop.disk.arretApres(1); };
  stop.repair(ORIGIN);
  const again = banc({ depuis: stop.disk.releve });
  again.disk.fs.unlinkSync(again.disk.absolu(`data/soirees/${p1.id}/meta.json`));
  for (const rel of [`data/soirees/${p2.id}/journal.jsonl`, `data/soirees-originales/${ORIGIN}/1/journal.jsonl`]) {
    again.disk.fs.unlinkSync(again.disk.absolu(rel));
    again.disk.dossier(rel);
  }
  const r3 = again.repair(ORIGIN);
  assert.deepEqual([r3.status, r3.generation], ['split', 1]);
  assert.deepEqual(r3.pieces, [{ ...p2, lines: null }, p3], 'sans le morceau introuvable ; sans nombre de lignes pour un journal illisible');
  const carried = lignesDe(again.disk, ORIGIN).filter(e => e.carried === true).length;
  const reportees = carried > 1 ? `${carried} lignes reportées` : `${carried} ligne reportée`;
  const iso = t => new Date(t).toISOString();
  assert.deepEqual(again.lignes.map(sansDuree), [`Réparation : ${ORIGIN} découpée en 3 morceaux (génération 1, meta.json fini sans recouper) : ` +
    `morceau 1 introuvable, ${p2.id} (${iso(p2.start)} → ${iso(p2.end)}, journal illisible), ${ORIGIN} (${iso(p3.start)} → ${iso(p3.end)}, ${p3.lines} lignes) ; ` +
    `au moins ${reportees} ; copie illisible, lignes illisibles non comptées ; en N ms.`]);
});

test('A4 : meta.json fini sans recouper, rang lu dans la première ligne reportée (jusqu’à neuf chiffres) : la ligne « Réparation : » nomme les morceaux introuvables par plages (« morceaux 1 à 6 introuvables », « morceaux 1 et 2 introuvables »), entre les morceaux trouvés, jamais un par rang ; soirée en cours et soirée close, rang 999999999 compris, une ligne courte', () => {
  const iso = t => new Date(t).toISOString();
  // Soirée d'une nuit dont le journal commence par une ligne reportée du rang
  // K (génération 1), son meta.json sans split.
  const posee = (b, K, close) => {
    const events = nuits(1);
    events.unshift({ rules: { auto: true, autoPlay: false }, carried: true, v: 1, seq: 0, t: events[0].t - MIN, ev: 'evening.started', boot: `split-g1-k${K}` });
    let endedAt = null;
    if (close) {
      endedAt = events.at(-1).t + 5 * MIN;
      events.push({ by: 'staff-reset', v: 1, seq: events.length, t: endedAt, ev: 'evening.closed', boot: 'boot-1' });
    }
    poser(b.disk, ORIGIN, { meta: metaNuits(1, { endedAt }), events });
    return { events, endedAt };
  };
  // Soirée en cours, rang 200000, et un morceau écrit de sa génération au rang 7.
  const a = banc();
  const { events } = posee(a, 200000, false);
  const P7 = '2026-10-10_2000_7777';
  const p7 = { ...metaNuits(1, { id: P7, endedAt: NUIT - 20 * H }), startedAt: NUIT - 23 * H, split: { from: ORIGIN, part: 7, generation: 1, rule: 'v1' } };
  poser(a.disk, P7, { meta: p7, events: nuits(1) });
  const ra = a.repair(ORIGIN, { current: true });
  assert.equal(a.lignes.length, 1);
  assert.ok(a.lignes[0].length < 600, `ligne de ${a.lignes[0].length} caractères`);
  const start = events[0].t, n = nuits(1).length;
  assert.deepEqual([ra.status, ra.current, ra.generation, ra.previous], ['split', true, 1, null]);
  assert.deepEqual(ra.pieces, [{ id: P7, k: 7, start: p7.startedAt, end: p7.endedAt, lines: n }, { id: ORIGIN, k: 200000, start, end: null, lines: n }]);
  assert.deepEqual(a.lignes.map(sansDuree), [`Réparation : ${ORIGIN} découpée en 200000 morceaux (génération 1, meta.json fini sans recouper) : ` +
    `morceaux 1 à 6 introuvables, ${P7} (${iso(p7.startedAt)} → ${iso(p7.endedAt)}, ${n} lignes), morceaux 8 à 199999 introuvables, ` +
    `${ORIGIN} (${iso(start)} → en cours, ${n} lignes) ; au moins 1 ligne reportée ; copie illisible, lignes illisibles non comptées ; en N ms.`]);
  assert.deepEqual(lireJson(a.disk, `data/soirees/${ORIGIN}/meta.json`).split, { from: ORIGIN, part: 200000, generation: 1, rule: 'v1', cut: start, previous: null });
  // Soirée close au plus grand rang que lit la réparation.
  const c = banc();
  const closed = posee(c, 999999999, true);
  const rc = c.repair(ORIGIN);
  assert.deepEqual([rc.status, rc.current, rc.pieces.map(p => p.id)], ['split', false, [ORIGIN]]);
  assert.deepEqual(c.lignes.map(sansDuree), [`Réparation : ${ORIGIN} découpée en 999999999 morceaux (génération 1, meta.json fini sans recouper) : ` +
    `morceaux 1 à 999999998 introuvables, ${ORIGIN} (${iso(closed.events[0].t)} → ${iso(closed.endedAt)}, ${closed.events.length - 1} lignes) ; ` +
    'au moins 1 ligne reportée ; copie illisible, lignes illisibles non comptées ; en N ms.']);
  assert.equal(bornage(c.disk).checked[ORIGIN], 'split');
  // Deux rangs manquants.
  const t = banc();
  posee(t, 3, false);
  assert.equal(t.repair(ORIGIN, { current: true }).status, 'split');
  assert.match(t.lignes[0], / \(génération 1, meta\.json fini sans recouper\) : morceaux 1 et 2 introuvables, /);
});

test('A4 : meta.json fini sans recouper, lecture en échec passager pendant la recherche des morceaux déjà écrits (readdirSync de data/soirees en EIO, meta.json du morceau archivé en EBUSY) : retry noté (« Échecs »), rien d’écrit hors de l’index, et le démarrage suivant retrouve le morceau archivé (previous, meta.split.previous)', () => {
  const { events, meta } = fixture24({ close: false });
  const reference = banc();
  poser(reference.disk, ORIGIN, { meta, events });
  const done = reference.repair(ORIGIN, { current: true });
  const pid = done.pieces[0].id;
  // Premier démarrage : le meta.json de la soirée en cours ne s'écrit pas
  // (journal déjà réécrit, copie-complete retiré).
  const first = banc();
  poser(first.disk, ORIGIN, { meta, events });
  first.disk.crochet = (op, chemin, info) => (op === 'rename' && info.vers === `data/soirees/${ORIGIN}/meta.json` ? 'ENOSPC' : null);
  const failed = first.repair(ORIGIN, { current: true });
  assert.deepEqual([failed.status, failed.code, failed.step], ['retry', 'ENOSPC', 'meta.json']);
  for (const [what, code, failing] of [['readdirSync de data/soirees', 'EIO', (op, chemin) => op === 'readdir' && chemin === 'data/soirees'],
    ['meta.json du morceau archivé', 'EBUSY', (op, chemin) => op === 'read' && chemin === `data/soirees/${pid}/meta.json`]]) {
    const second = banc({ depuis: first.disk.instantane() });
    const before = second.disk.contenus();
    let fois = 1;
    second.disk.crochet = (op, chemin) => (failing(op, chemin) && fois-- > 0 ? code : null);
    const r = second.repair(ORIGIN, { current: true });
    assert.deepEqual([r.status, r.code, r.step, r.attempts], ['retry', code, 'meta.json', 2], what);
    assert.deepEqual(second.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « meta.json » (${code}, essai 2 sur 3) : reprise au prochain démarrage.`], what);
    const after = second.disk.contenus();
    for (const files of [before, after]) files.delete('data/soirees/.bornage.json');
    assert.deepEqual(after, before, `${what} : rien d’écrit hors de l’index`);
    // Démarrage suivant : le morceau archivé retrouvé.
    const third = banc({ depuis: second.disk.instantane() });
    const r3 = third.repair(ORIGIN, { current: true });
    assert.deepEqual([r3.status, r3.previous?.id], ['split', pid], what);
    assert.deepEqual(plain(r3.previous), plain(done.previous), what);
    assert.equal(lireJson(third.disk, `data/soirees/${ORIGIN}/meta.json`).split.previous, pid, what);
  }
});

test('A4 : meta.json fini sans recouper pour la soirée en cours, son écriture refusée (ENOSPC) : retry à l’étape « meta.json », essai 2, et previous null comme pour tout échec (aucun morceau rendu tant que meta.json n’est pas écrit) ; au démarrage suivant, split et le morceau archivé (previous)', () => {
  const { events, meta } = fixture24({ close: false });
  const reference = banc();
  poser(reference.disk, ORIGIN, { meta, events });
  const done = reference.repair(ORIGIN, { current: true });
  const refuse = b => { b.disk.crochet = (op, chemin, info) => (op === 'rename' && info.vers === `data/soirees/${ORIGIN}/meta.json` ? 'ENOSPC' : null); };
  const first = banc();
  poser(first.disk, ORIGIN, { meta, events });
  refuse(first);
  const r1 = first.repair(ORIGIN, { current: true });
  assert.deepEqual([r1.status, r1.step, r1.previous], ['retry', 'meta.json', null], 'découpage en échec : previous null');
  const second = banc({ depuis: first.disk.instantane() });
  refuse(second);
  const r2 = second.repair(ORIGIN, { current: true });
  assert.deepEqual([r2.status, r2.code, r2.step, r2.attempts, r2.current, r2.previous], ['retry', 'ENOSPC', 'meta.json', 2, true, null], 'meta.json fini en échec : previous null');
  const third = banc({ depuis: second.disk.instantane() });
  const r3 = third.repair(ORIGIN, { current: true });
  assert.deepEqual([r3.status, r3.current], ['split', true]);
  assert.deepEqual(plain(r3.previous), plain(done.previous));
});

test('A4 : soirée en cours en échec à l’étape « meta.json » au démarrage (son journal déjà réécrit, copie-complete retiré), rouverte, puis une nuit de plus avant « Supprimer toutes les tables » : la passe des soirées closes du démarrage suivant finit son meta.json sans recouper, mais ne la note pas split tant qu’une coupure reste (son entrée retirée, la soirée toujours à revoir ; la ligne le dit) ; la passe d’après la recoupe à la génération 2 : une soirée par nuit, rien de perdu ni compté deux fois, plus aucune coupure ni rien à revoir', () => {
  const { events, meta } = fixture24({ close: false });
  let t = REPAIR_AT;
  const b = banc({ now: () => t });
  poser(b.disk, ORIGIN, { meta, events });
  b.disk.crochet = (op, chemin, info) => (op === 'rename' && info.vers === `data/soirees/${ORIGIN}/meta.json` ? 'ENOSPC' : null);
  const failed = b.repair(ORIGIN, { current: true });
  assert.deepEqual([failed.status, failed.code, failed.step], ['retry', 'ENOSPC', 'meta.json']);
  b.disk.crochet = null;
  assert.equal(b.journal.open({ resume: { id: ORIGIN } }), true, 'rouverte telle quelle');
  // Le mardi 20 octobre au soir, après 8 h : une table, une personne, un titre ; puis « Supprimer toutes les tables ».
  const soir = Date.parse('2026-10-20T20:00:00+02:00');
  const at = (minutes, ev, fields) => { t = soir + minutes * MIN; return b.journal.append(ev, fields); };
  at(0, 'table.opened', { tableId: 'T9', individual: false });
  b.journal.table('T9', { name: 'Table 9', individual: false });
  at(1, 'person.joined', { personId: 'p9', tableId: 'T9' });
  b.journal.person('p9', { name: 'Prénom p9', tableId: 'T9' });
  at(5, 'song.requested', { personId: 'p9', entryId: 'e9', songId: 900, title: 'Titre 9' });
  at(10, 'stage.started', { queueId: 900, ids: ['p9'], ownerId: 'p9', entryId: 'e9', durationSec: 200 });
  at(14, 'stage.ended', { queueId: 900, playedSec: 240 });
  t = soir + 3 * H;
  b.journal.close({ by: 'staff-reset', summarize: resumer });
  const originals = new Set(events.map(cle));
  const added = lignesDe(b.disk, ORIGIN).filter(e => e.carried !== true && !originals.has(cle(e)));
  assert.ok(added.some(e => e.ev === 'stage.started') && added.at(-1).ev === 'evening.closed', 'la nuit de plus et la clôture');
  // Démarrage suivant : la passe des soirées closes.
  const passe = disk => {
    const s = banc({ depuis: disk.instantane(), now: () => Date.parse('2026-10-21T10:00:00Z') });
    const queue = s.journal.repairQueue();
    assert.ok(queue.includes(ORIGIN), 'proposée par repairQueue');
    const results = new Map(queue.map(id => [id, s.repair(id)]));
    return { s, result: results.get(ORIGIN), meta: lireJson(s.disk, `data/soirees/${ORIGIN}/meta.json`) };
  };
  const one = passe(b.disk);
  assert.deepEqual([one.result.status, one.result.generation, one.meta.split.generation], ['split', 1, 1], 'meta.json fini sans recouper');
  assert.equal(cutsOf(lignesDe(one.s.disk, ORIGIN), one.meta).length, 1, 'une coupure reste : la nuit de plus');
  assert.equal(bornage(one.s.disk).checked[ORIGIN], undefined, 'pas notée split : son entrée retirée, toujours à revoir');
  assert.match(one.s.lignes.find(line => line.startsWith(`Réparation : ${ORIGIN} découpée`)),
    / \(génération 1, meta\.json fini sans recouper\) : .+ ; 1 coupure restée : revue au prochain démarrage ; en \d+ ms\.$/);
  // Démarrage d'après : recoupée à la génération 2.
  const two = passe(one.s.disk);
  assert.deepEqual([two.result.status, two.result.generation, two.meta.split.generation], ['split', 2, 2]);
  assert.deepEqual(cutsOf(lignesDe(two.s.disk, ORIGIN), two.meta), [], 'plus aucune coupure');
  assert.equal(bornage(two.s.disk).checked[ORIGIN], 'split');
  assert.deepEqual(banc({ depuis: two.s.disk.instantane() }).journal.repairQueue(), [], 'plus rien à revoir');
  const ids = two.s.disk.fichiers('data/soirees').filter(rel => rel.endsWith('/meta.json')).map(rel => rel.split('/')[2]);
  assert.equal(ids.length, 3, 'une soirée par nuit');
  const kept = propres(two.s.disk, ids).filter(e => !(e.ev === 'evening.closed' && e.split));
  assert.deepEqual(kept.map(cle).sort(), [...events, ...added].map(cle).sort(), 'rien de perdu ni compté deux fois');
});

test('A4 : soirée en cours dont le renommage de meta.json est refusé (EBUSY) à deux démarrages de suite (retry, essai 2), rouverte telle quelle, une nuit de plus, puis close : la passe des soirées closes finit son meta.json, une coupure restée, et retire son entrée (le progrès remet ses essais à zéro) ; à la passe suivante, un EBUSY à l’étape « copie » donne retry à l’essai 1, jamais failed', () => {
  const { events, meta } = fixture24({ close: false });
  let t = REPAIR_AT;
  const refuse = b => { b.disk.crochet = (op, chemin, info) => (op === 'rename' && info.vers === `data/soirees/${ORIGIN}/meta.json` ? 'EBUSY' : null); };
  const first = banc({ now: () => t });
  poser(first.disk, ORIGIN, { meta, events });
  refuse(first);
  const r1 = first.repair(ORIGIN, { current: true });
  assert.deepEqual([r1.status, r1.code, r1.step, r1.attempts], ['retry', 'EBUSY', 'meta.json', 1]);
  const b = banc({ depuis: first.disk.instantane(), now: () => t });
  refuse(b);
  const r2 = b.repair(ORIGIN, { current: true });
  assert.deepEqual([r2.status, r2.code, r2.step, r2.attempts], ['retry', 'EBUSY', 'meta.json', 2], 'meta.json fini en échec, essai 2');
  b.disk.crochet = null;
  assert.equal(b.journal.open({ resume: { id: ORIGIN } }), true, 'rouverte telle quelle');
  // Le mardi 20 octobre au soir, après 8 h : une table, une personne, un titre ; puis « Supprimer toutes les tables ».
  const soir = Date.parse('2026-10-20T20:00:00+02:00');
  const at = (minutes, ev, fields) => { t = soir + minutes * MIN; return b.journal.append(ev, fields); };
  at(0, 'table.opened', { tableId: 'T9', individual: false });
  b.journal.table('T9', { name: 'Table 9', individual: false });
  at(1, 'person.joined', { personId: 'p9', tableId: 'T9' });
  b.journal.person('p9', { name: 'Prénom p9', tableId: 'T9' });
  at(5, 'song.requested', { personId: 'p9', entryId: 'e9', songId: 900, title: 'Titre 9' });
  at(10, 'stage.started', { queueId: 900, ids: ['p9'], ownerId: 'p9', entryId: 'e9', durationSec: 200 });
  at(14, 'stage.ended', { queueId: 900, playedSec: 240 });
  t = soir + 3 * H;
  b.journal.close({ by: 'staff-reset', summarize: resumer });
  assert.deepEqual(bornage(b.disk).checked[ORIGIN], { status: 'retry', attempts: 2, code: 'EBUSY', version: 'v3.5.0' });
  // Démarrage suivant : la passe des soirées closes finit meta.json sans recouper, une coupure reste.
  const s = banc({ depuis: b.disk.instantane(), now: () => Date.parse('2026-10-21T10:00:00Z') });
  assert.ok(s.journal.repairQueue().includes(ORIGIN), 'proposée par repairQueue');
  const one = s.repair(ORIGIN);
  assert.deepEqual([one.status, one.generation], ['split', 1], 'meta.json fini sans recouper');
  assert.match(s.lignes.find(line => line.startsWith(`Réparation : ${ORIGIN} découpée`)),
    / \(génération 1, meta\.json fini sans recouper\) : .+ ; 1 coupure restée : revue au prochain démarrage ; en \d+ ms\.$/);
  assert.equal(bornage(s.disk).checked[ORIGIN], undefined, 'entrée retirée : l’essai 2 ne compte plus');
  assert.ok(banc({ depuis: s.disk.instantane() }).journal.repairQueue().includes(ORIGIN), 'toujours à revoir');
  // Passe suivante : la copie de la génération 2 refusée une fois (EBUSY).
  const next = banc({ depuis: s.disk.instantane(), now: () => Date.parse('2026-10-22T10:00:00Z') });
  let fois = 1;
  next.disk.crochet = (op, chemin) => (op === 'open' && chemin.startsWith(`data/soirees-originales/${ORIGIN}/`) && fois-- > 0 ? 'EBUSY' : null);
  const r = next.repair(ORIGIN);
  assert.deepEqual([r.status, r.code, r.step, r.attempts], ['retry', 'EBUSY', 'copie', 1], 'essai 1, jamais failed');
  assert.deepEqual(bornage(next.disk).checked[ORIGIN], { status: 'retry', attempts: 1, code: 'EBUSY', version: 'v3.5.0' });
  assert.deepEqual(next.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « copie » (EBUSY, essai 1 sur 3) : reprise au prochain démarrage.`]);
});

test('A4 : startedAt ou endedAt de meta.json hors des dates possibles (au-delà de ±8,64e15 ms, que Date refuse) : champ mal formé, failed (BAD_META) avant toute écriture, fichiers tels quels ; l’heure d’un morceau déjà écrit hors de ces dates ne fait jamais échouer la trace d’un meta.json fini sans recouper (« ? »)', () => {
  for (const [field, value] of [['endedAt', 9e15], ['startedAt', -9e15], ['endedAt', 8.64e15 + 1]]) {
    const b = banc();
    const { meta, events } = fusionnee(ORIGIN);
    poser(b.disk, ORIGIN, { meta: { ...meta, [field]: value }, events });
    const before = b.disk.contenus();
    const r = b.repair(ORIGIN);
    assert.deepEqual([r.status, r.code, r.step], ['failed', 'BAD_META', 'lecture'], `${field} ${value}`);
    assert.deepEqual(b.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « lecture » (BAD_META, meta.json) : notée failed, ses fichiers restent tels quels. Répare ou remets le fichier, puis refais-la ${REFAIRE}.`]);
    const after = b.disk.contenus();
    after.delete('data/soirees/.bornage.json');
    assert.deepEqual(after, before, `${field} ${value} : ses fichiers restent tels quels`);
    assert.deepEqual(bornage(b.disk).checked[ORIGIN], { status: 'failed', attempts: 1, code: 'BAD_META', version: 'v3.5.0' });
  }
  // Morceau déjà écrit dont le meta.json a un startedAt hors des dates, et le
  // dossier arrêté entre son journal et son meta.json (copie sans copie-complete).
  const { events, meta } = fixture24();
  const reference = banc();
  poser(reference.disk, ORIGIN, { meta, events });
  const pid = reference.repair(ORIGIN).pieces[0].id;
  const stop = banc();
  poser(stop.disk, ORIGIN, { meta, events });
  stop.disk.crochet = (op, chemin, info) => { if (op === 'rename' && info.vers === `data/soirees/${ORIGIN}/journal.jsonl`) stop.disk.arretApres(1); };
  stop.repair(ORIGIN);
  const again = banc({ depuis: stop.disk.releve });
  again.disk.fs.unlinkSync(again.disk.absolu(`data/soirees-originales/${ORIGIN}/1/copie-complete`));
  again.disk.ecrire(`data/soirees/${pid}/meta.json`, JSON.stringify({ ...lireJson(again.disk, `data/soirees/${pid}/meta.json`), startedAt: 9e15 }, null, 1));
  const r = again.repair(ORIGIN);
  assert.deepEqual([r.status, r.generation, r.pieces[0]?.start], ['split', 1, 9e15], `${r.status} ${r.code} ${r.step}`);
  const iso = t => new Date(t).toISOString();
  assert.deepEqual(again.lignes.map(sansDuree), [ligneFinie(reference.lignes[0]).replace(`${pid} (${iso(meta.startedAt)} → `, `${pid} (? → `)]);
  assert.equal(bornage(again.disk).checked[ORIGIN], 'split');
});

test('A4 : heure d’une ligne hors des dates possibles (±1e16, au-delà de ±8,64e15 ms), meta.startedAt null : lue comme absente, comme dans evening-bounds.js, la ligne reste avec celle qui la précède ; la soirée close est découpée sans EXCEPTION, son premier morceau commence à la plus ancienne heure valide, à son identifiant habituel ; newEveningId d’une heure hors des dates prend l’heure actuelle, comme une heure non numérique, sans lever', () => {
  for (const bad of [-1e16, 1e16]) {
    const { meta, events } = fusionnee(ORIGIN);
    const joined = events.findIndex(e => e.ev === 'person.joined');
    const odd = { personId: 'a1', v: 1, seq: events.length + 1, t: bad, ev: 'person.seen', boot: 'boot-1' };
    const lines = [...events.slice(0, joined + 1), odd, ...events.slice(joined + 1)];
    const b = banc();
    poser(b.disk, ORIGIN, { meta: { ...meta, startedAt: null }, events: lines });
    const r = b.repair(ORIGIN);
    assert.deepEqual([r.status, r.code, r.step, r.pieces.length], ['split', null, null, 2], `${bad} :\n${b.lignes.join('\n')}`);
    const [first] = r.pieces;
    assert.equal(first.start, events[0].t, `${bad} : début à la plus ancienne heure valide`);
    assert.equal(first.id, idAt(events[0].t, 1, 1), `${bad} : identifiant habituel`);
    const piece = lignesDe(b.disk, first.id);
    const i = piece.findIndex(e => e.t === bad);
    assert.ok(i > 0 && cle(piece[i - 1]) === cle(events[joined]), `${bad} : avec la ligne qui la précède`);
    assert.ok(!lignesDe(b.disk, ORIGIN).some(e => e.t === bad), `${bad} : pas au dernier morceau`);
  }
  for (const bad of [1e16, -1e16, 8.64e15 + 1]) assert.ok(validEveningId(newEveningId(bad, 'beef', PARIS)), String(bad));
});

test('A4 : splitAt : morceau archivé et soirée ouverte réécrits, journal.current remplacé (même identifiant, début à C, meta.split avec cut et previous, lignes reportées puis lignes d’après C), aucun app.started ajouté, seq qui continue ; coupure refusée si elle n’est pas après meta.startedAt ; même résultat en démo, le morceau dans journal.memory', () => {
  const events = nuits(2).filter(e => e.t < NUIT + DAY + 90 * MIN);
  const meta = metaNuits(2);
  const [cut] = cutsOf(events, meta);
  const now = () => NUIT + DAY + 2 * H;
  const b = banc({ now });
  poser(b.disk, ORIGIN, { meta, events });
  b.journal.current = { id: ORIGIN, meta: b.journal._load(ORIGIN).meta, events: b.journal._load(ORIGIN).events, seq: events.length };
  const result = b.journal.splitAt(cut, { summarize: resumer, citedIds });
  const pid = idAt(meta.startedAt, 1, 1);
  assert.deepEqual([result.id, result.cut, result.generation, result.current, result.error], [pid, cut, 1, ORIGIN, null]);
  assert.deepEqual(plain(result.summary), lireJson(b.disk, `data/soirees/${pid}/summary.json`));
  const cur = b.journal.current;
  assert.deepEqual([cur.id, cur.meta.startedAt, cur.meta.endedAt, cur.seq], [ORIGIN, cut, null, events.length]);
  assert.deepEqual(cur.meta.split, { from: ORIGIN, part: 2, generation: 1, rule: 'v1', cut, previous: pid });
  assert.deepEqual(cur.events.filter(e => e.carried !== true), events.filter(e => e.t > cut));
  const carried = cur.events.filter(e => e.carried === true);
  assert.ok(carried.length >= 1 && cur.events.slice(0, carried.length).every(e => e.carried === true && e.t === cut));
  assert.equal(carried[0].ev, 'evening.started');
  assert.equal(cur.events.filter(e => e.ev === 'app.started').length, 0, 'aucun app.started');
  assert.deepEqual(lignesDe(b.disk, ORIGIN), cur.events, 'soirée ouverte réécrite');
  assert.deepEqual(lireJson(b.disk, `data/soirees/${ORIGIN}/meta.json`), cur.meta);
  assert.equal(b.journal.append('person.seen', { personId: 'a2' }).seq, events.length + 1);
  assert.equal(lignesDe(b.disk, ORIGIN).at(-1).seq, events.length + 1);
  assert.deepEqual(bornage(b.disk).checked, { [pid]: 'ok' });
  assert.equal(b.disk.existe(`data/soirees-originales/${ORIGIN}/1/copie-complete`), false);
  assert.deepEqual(b.journal.splitAt(cut, { summarize: resumer, citedIds }), { refused: 'cut' }, 'jamais refait');
  assert.deepEqual(b.journal.splitAt(cut - 1, { summarize: resumer, citedIds }), { refused: 'cut' });
  // Démo : sans dossier, le morceau archivé va dans journal.memory.
  const demo = new EveningJournal({ now, boot: 'b-demo', citedIds });
  demo.current = { id: ORIGIN, meta: JSON.parse(JSON.stringify(meta)), events: events.map(e => ({ ...e })), seq: events.length };
  const d = demo.splitAt(cut, { summarize: resumer });
  assert.deepEqual([d.id, d.cut, d.error], [pid, cut, null]);
  assert.deepEqual(demo.read(pid).events, lignesDe(b.disk, pid));
  assert.deepEqual(demo.read(pid).meta, lireJson(b.disk, `data/soirees/${pid}/meta.json`));
  assert.deepEqual(demo.current.events, b.journal.read(ORIGIN).events.slice(0, -1));
  assert.deepEqual(demo.list().map(row => row.id).sort(), [ORIGIN, pid].sort());
  assert.equal(new EveningJournal({ now }).splitAt(cut, { summarize: resumer, citedIds }), null, 'aucune soirée ouverte');
});

test('A4 : splitAt en échec à chaque étape (copie, morceau archivé, journal, meta.json, retrait de copie-complete) : la soirée est découpée en mémoire, la file continue (nouvelles lignes, nouveau prénom, clôture du matin), et tant que le journal du dossier n’est pas réécrit, un second découpage est refusé (pending) sans rien changer ; au démarrage suivant, la réparation la découpe à C, sans événement perdu ni compté deux fois, ni prénom perdu', () => {
  const events = nuits(2).filter(e => e.t < NUIT + DAY + 90 * MIN);
  const meta = metaNuits(2);
  const [cut] = cutsOf(events, meta);
  const steps = {
    copie: (op, chemin) => op === 'open' && chemin.startsWith(`data/soirees-originales/${ORIGIN}/1/journal.jsonl.`),
    'morceau archivé': (op, chemin, info) => op === 'rename' && /^data\/soirees\/2026-10-15_1930_[0-9a-f]{4}\/journal\.jsonl$/.test(info.vers || '') && !info.vers.includes(ORIGIN),
    journal: (op, chemin, info) => op === 'rename' && info.vers === `data/soirees/${ORIGIN}/journal.jsonl`,
    'meta.json': (op, chemin, info) => op === 'rename' && info.vers === `data/soirees/${ORIGIN}/meta.json`,
    'copie-complete': (op, chemin) => op === 'unlink' && chemin === `data/soirees-originales/${ORIGIN}/1/copie-complete`,
  };
  for (const [step, failing] of Object.entries(steps)) {
    let t = NUIT + DAY + 2 * H;
    const b = banc({ now: () => t });
    poser(b.disk, ORIGIN, { meta, events });
    const errors = [];
    b.journal.onError = error => errors.push(error.code);
    b.journal.current = { id: ORIGIN, meta: b.journal._load(ORIGIN).meta, events: b.journal._load(ORIGIN).events, seq: events.length };
    b.disk.crochet = (op, chemin, info) => (failing(op, chemin, info) ? 'EIO' : null);
    const result = b.journal.splitAt(cut, { summarize: resumer, citedIds });
    assert.equal(result.error?.code, 'EIO', step);
    assert.deepEqual(errors, ['EIO'], `${step} : erreur signalée une fois`);
    b.disk.crochet = null;
    const pid = result.id;
    assert.equal(b.journal.current.meta.startedAt, cut, `${step} : découpée en mémoire`);
    assert.ok(b.journal.read(pid), `${step} : morceau archivé lisible`);
    const rows = b.journal.list();
    for (const night of [NUIT, NUIT + DAY]) assert.equal(rows.filter(row => row.startedAt <= night && (row.endedAt == null || night <= row.endedAt)).length, 1, `${step} : une fois`);
    // La file continue.
    t += 10 * MIN;
    const written = [];
    written.push(b.journal.append('person.joined', { personId: 'c2', tableId: 'T2' }));
    b.journal.person('c2', { name: 'Nouvelle', tableId: 'T2' });
    t += 5 * MIN;
    written.push(b.journal.append('song.requested', { personId: 'c2', entryId: 'e-c2', songId: 7, title: 'Tard' }));
    // Tant que le journal du dossier n'est pas réécrit (copie, morceau
    // archivé, journal), un second découpage, à la coupure suivante, est
    // refusé (pending) jusqu'à la réparation du démarrage, sans rien changer :
    // sinon la première nuit ne resterait que dans une copie sans
    // copie-complete.
    if (['copie', 'morceau archivé', 'journal'].includes(step)) {
      const files = b.disk.contenus(), current = structuredClone(b.journal.current);
      assert.deepEqual(b.journal.splitAt(Date.parse('2026-10-17T08:00:00+02:00'), { summarize: resumer, citedIds }), { refused: 'pending' }, step);
      assert.deepEqual(b.disk.contenus(), files, `${step} : aucun fichier changé`);
      assert.deepEqual(b.journal.current, current, `${step} : journal.current inchangé`);
    }
    t = Date.parse('2026-10-17T09:00:00+02:00');
    b.journal.close({ by: 'auto', fields: { reason: 'morning' }, summarize: resumer });
    written.push(b.journal.read(ORIGIN).events.at(-1));
    // Close avant le démarrage suivant : la liste et les statistiques la
    // montrent coupée jusqu'à la réparation.
    assert.equal(b.journal.read(ORIGIN).meta.startedAt, cut, `${step} : close, toujours coupée`);
    const closedRows = b.journal.list();
    for (const night of [NUIT, NUIT + DAY]) assert.equal(closedRows.filter(row => row.startedAt <= night && (row.endedAt == null || night <= row.endedAt)).length, 1, `${step} : close, une fois`);
    // Redémarrage : la réparation de la soirée close.
    const restart = banc({ depuis: b.disk.instantane() });
    const repaired = restart.repair(ORIGIN);
    assert.ok(['split', 'ok'].includes(repaired.status), `${step} : ${repaired.status} ${repaired.code}`);
    const ids = restart.disk.fichiers('data/soirees').filter(rel => rel.endsWith('/meta.json')).map(rel => rel.split('/')[2]);
    assert.deepEqual(ids.sort(), [pid, ORIGIN].sort(), `${step} : deux soirées, le morceau sous le même identifiant`);
    assert.equal(lireJson(restart.disk, `data/soirees/${pid}/meta.json`).endedAt, cut, `${step} : coupée à C`);
    const kept = propres(restart.disk, ids).filter(e => !(e.ev === 'evening.closed' && e.split));
    assert.deepEqual(kept.map(cle).sort(), [...events, ...written].map(cle).sort(), `${step} : aucun événement perdu ni compté deux fois`);
    const names = new Map(ids.flatMap(id => Object.entries(lireJson(restart.disk, `data/soirees/${id}/meta.json`).roster).map(([k, v]) => [k, v.name])));
    for (const id of ['a1', 'b1', 'a2', 'b2']) assert.equal(names.get(id), `Prénom ${id}`, `${step} : ${id}`);
    assert.equal(names.get('c2'), 'Nouvelle', `${step} : nouveau prénom gardé`);
    assert.equal(lireJson(restart.disk, `data/soirees/${ORIGIN}/meta.json`).roster.c2.name, 'Nouvelle');
  }
});

test('A4 : splitAt avec un index .bornage.json illisible (EBUSY à sa lecture, ou JSON abîmé) : index laissé tel quel, ses entrées gardées (ok, split, failed), le problème rendu (indexProblem) ; au démarrage suivant, une soirée remise à l’original (entrée ok) n’est pas revue, le morceau est vérifié puis noté ok, et un index encore abîmé y a sa ligne', () => {
  const events = nuits(2).filter(e => e.t < NUIT + DAY + 90 * MIN);
  const meta = metaNuits(2);
  const [cut] = cutsOf(events, meta);
  const pid = idAt(meta.startedAt, 1, 1);
  const RESTORED = '2026-10-01_1900_aaaa';
  const entries = { [RESTORED]: 'ok', '2026-10-08_1900_bbbb': 'split',
    '2026-10-09_1900_cccc': { status: 'failed', attempts: 1, code: 'BAD_JSON', version: 'v3.5.0' } };
  for (const [problem, text] of [['EBUSY', `${JSON.stringify({ rule: 'v1', checked: entries })}\n`], ['BAD_JSON', '{"rule":"v1","checked":{']]) {
    const b = banc({ now: () => NUIT + DAY + 2 * H });
    poser(b.disk, ORIGIN, { meta, events });
    // Soirée remise à l'original (DEPLOIEMENT-SERVEUR §18) : deux nuits fusionnées, close, notée ok.
    poser(b.disk, RESTORED, fixture24({ id: RESTORED }));
    b.disk.ecrire('data/soirees/.bornage.json', text);
    const loaded = b.journal._load(ORIGIN);
    b.journal.current = { id: ORIGIN, meta: loaded.meta, events: loaded.events, seq: events.length };
    let busy = problem === 'EBUSY';
    b.disk.crochet = (op, chemin) => (op === 'read' && chemin === 'data/soirees/.bornage.json' && busy ? (busy = false, 'EBUSY') : null);
    const r = b.journal.splitAt(cut, { summarize: resumer, citedIds });
    assert.equal(b.disk.lire('data/soirees/.bornage.json'), text, `${problem} : index laissé tel quel, jamais réécrit avec la seule entrée du morceau`);
    assert.deepEqual([r.id, r.error, r.indexProblem], [pid, null, problem], problem);
    assert.equal(lireJson(b.disk, `data/soirees/${ORIGIN}/meta.json`).split.previous, pid, `${problem} : découpage écrit`);
    // Démarrage suivant : la passe des soirées closes vérifie le morceau.
    const next = banc({ depuis: b.disk.instantane() });
    const pieceFiles = next.disk.contenus(`data/soirees/${pid}`);
    if (problem === 'EBUSY') {
      const queue = next.journal.repairQueue();
      assert.ok(queue.includes(pid) && !queue.includes(RESTORED), `soirée remise à l'original pas revue : ${queue}`);
    }
    assert.equal(next.repair(pid).status, 'ok', problem);
    assert.deepEqual(next.disk.contenus(`data/soirees/${pid}`), pieceFiles, `${problem} : morceau vérifié sans réécriture`);
    assert.match(next.lignes.at(-1), new RegExp(`^Réparation : ${pid} vérifiée sans coupure : `));
    if (problem === 'EBUSY') {
      assert.deepEqual(bornage(next.disk), { rule: 'v1', checked: { ...entries, [pid]: 'ok' } }, 'entrées gardées, morceau noté ok');
      assert.equal(next.lignes.length, 1);
    } else {
      assert.equal(next.lignes[0], 'Réparation : index data/soirees/.bornage.json illisible (BAD_JSON) : lu comme vide, les soirées closes sont revues. Une soirée remise à l\'original (DEPLOIEMENT-SERVEUR §18, « Revenir à l\'original d\'une soirée découpée ») peut être recoupée : refais son retour à l\'original, entrée \'ok\' comprise.');
    }
  }
});

test('A4 : splitAt, choix de l’identifiant du morceau archivé en échec (meta.json d’un dossier candidat illisible un instant, EBUSY) : rien d’écrit, et le morceau gardé en mémoire ne prend jamais l’identifiant d’une autre soirée, mais le premier libre ou le nôtre d’après une nouvelle lecture, un dossier encore illisible passé comme pris ; read() et list() montrent toujours l’autre soirée, et chaque karaoké une seule fois ; sans aucun identifiant sûr, splitAt lève sans rien changer', () => {
  const events = nuits(2).filter(e => e.t < NUIT + DAY + 90 * MIN);
  const meta = metaNuits(2);
  const [cut] = cutsOf(events, meta);
  const [j1, j2, j3] = [1, 2, 3].map(j => idAt(meta.startedAt, 1, j));
  assert.equal(new Set([j1, j2, j3, ORIGIN]).size, 4);
  const ZOE = { z: { name: 'Zoé', tableId: null } };
  // Une autre soirée à l'identifiant `id` : un vendredi de juin, avec Zoé.
  const autre = (disk, id) => poser(disk, id, { meta: { ...metaNuits(1, { id, endedAt: Date.parse('2026-06-05T23:00:00+02:00') }),
    startedAt: Date.parse('2026-06-05T20:00:00+02:00'), roster: ZOE }, events: [] });
  const ouverte = b => {
    poser(b.disk, ORIGIN, { meta, events });
    const loaded = b.journal._load(ORIGIN);
    b.journal.current = { id: ORIGIN, meta: loaded.meta, events: loaded.events, seq: events.length };
  };
  // splitAt à C, la lecture de `illisible(chemin)` refusée par EBUSY.
  const split = (setup, illisible) => {
    const b = banc({ now: () => NUIT + DAY + 2 * H });
    ouverte(b);
    setup(b.disk);
    const files = b.disk.contenus();
    b.disk.crochet = (op, chemin) => (op === 'read' && illisible(chemin) ? 'EBUSY' : null);
    const result = b.journal.splitAt(cut, { summarize: resumer, citedIds });
    b.disk.crochet = null;
    return { b, result, files };
  };
  const unePuis = rel => { let fois = 1; return chemin => chemin === rel && fois-- > 0; };
  const check = ({ b, result, files }, id, label) => {
    assert.deepEqual([result.id, result.error], [id, { step: 'morceau 1', code: 'EBUSY', name: 'Error' }], label);
    assert.deepEqual(b.disk.contenus(), files, `${label} : rien d’écrit`);
    assert.deepEqual(b.journal.read(id).meta.split, { from: ORIGIN, part: 1, generation: 1, rule: 'v1' }, `${label} : morceau lisible sous son identifiant`);
    assert.equal(b.journal.current.meta.startedAt, cut, `${label} : découpée en mémoire`);
    const rows = b.journal.list();
    for (const night of [NUIT, NUIT + DAY]) assert.equal(rows.filter(row => row.startedAt <= night && (row.endedAt == null || night <= row.endedAt)).length, 1, `${label} : une fois`);
    return rows.map(row => row.id).sort();
  };
  // Une autre soirée à j = 1, son meta.json illisible une fois : j = 2.
  const a = split(disk => autre(disk, j1), unePuis(`data/soirees/${j1}/meta.json`));
  assert.deepEqual(check(a, j2, 'j = 1 illisible une fois'), [ORIGIN, j1, j2].sort());
  assert.deepEqual(a.b.journal.read(j1).meta.roster, ZOE, 'l’autre soirée, jamais cachée par le morceau');
  // Une autre soirée lisible à j = 1, une autre à j = 2 illisible une fois : j = 3.
  const b = split(disk => { autre(disk, j1); autre(disk, j2); }, unePuis(`data/soirees/${j2}/meta.json`));
  assert.deepEqual(check(b, j3, 'j = 2 illisible une fois'), [ORIGIN, j1, j2, j3].sort());
  for (const id of [j1, j2]) assert.deepEqual(b.b.journal.read(id).meta.roster, ZOE, id);
  // Notre morceau laissé à j = 1 (même origine, rang et génération), illisible une fois : j = 1.
  const c = split(disk => poser(disk, j1, { meta: { ...metaNuits(1, { id: j1, endedAt: cut }), split: { from: ORIGIN, part: 1, generation: 1, rule: 'v1' } },
    events: nuits(1) }), unePuis(`data/soirees/${j1}/meta.json`));
  assert.deepEqual(check(c, j1, 'le nôtre à j = 1'), [ORIGIN, j1].sort());
  // L'autre soirée à j = 1 illisible pendant tout le découpage : passée comme prise, j = 2.
  const d = split(disk => autre(disk, j1), chemin => chemin === `data/soirees/${j1}/meta.json`);
  assert.deepEqual(check(d, j2, 'j = 1 toujours illisible'), [ORIGIN, j1, j2].sort());
  assert.deepEqual(d.b.journal.read(j1).meta.roster, ZOE);
  // Aucun identifiant sûr (les mille essais pris) : splitAt lève, sans rien changer.
  const e = banc({ now: () => NUIT + DAY + 2 * H });
  ouverte(e);
  for (let j = 1; j <= 1000; j++) e.disk.ecrire(`data/soirees/${idAt(meta.startedAt, 1, j)}/meta.json`, '{}');
  const current = structuredClone(e.journal.current), files = e.disk.contenus();
  const once = unePuis(`data/soirees/${j1}/meta.json`);
  e.disk.crochet = (op, chemin) => (op === 'read' && once(chemin) ? 'EBUSY' : null);
  assert.throws(() => e.journal.splitAt(cut, { summarize: resumer, citedIds }), { code: 'BAD_PATH' });
  assert.deepEqual(e.journal.current, current, 'journal.current inchangé');
  assert.deepEqual([e.journal.memory.size, e.journal.lastError], [0, null]);
  assert.deepEqual(e.disk.contenus(), files, 'rien d’écrit');
});

// ------------------------------------------------------------ vrai disque
const vraiDossier = () => fs.mkdtempSync(path.join(os.tmpdir(), 'reparation-'));
const ecrireSoiree = (dir, id, { meta, events, text }) => {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'meta.json'), JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(dir, id, 'journal.jsonl'), text ?? texte(events));
};
const arbre = root => {
  const out = new Map();
  const walk = rel => {
    for (const name of fs.readdirSync(path.join(root, rel))) {
      const child = rel ? `${rel}/${name}` : name;
      if (fs.statSync(path.join(root, child)).isDirectory()) walk(child); else out.set(child, fs.readFileSync(path.join(root, child)));
    }
  };
  walk('');
  return out;
};
const vraiJournal = (root, options = {}) => new EveningJournal({ dir: path.join(root, 'soirees'), now: () => REPAIR_AT, boot: 'b-vrai', citedIds, ...options });

test('A7 : 20 journaux tirés, sur le vrai disque : splitAt à la coupure de la soirée en cours et la réparation du démarrage donnent les mêmes morceaux (identifiants, meta, lignes, résumés, copie, index) ; une seconde réparation ne change aucun fichier, octet pour octet', () => {
  const started = performance.now();
  const drawn = tires.tirerJournaux().map(d => ({ d, events: parseLines(d.texte).events }))
    .filter(({ d, events }) => eveningBreaks({ events, timeZone: d.timeZone }).cuts.length > 0).slice(0, 20);
  assert.equal(drawn.length, 20);
  for (const { d, events } of drawn) {
    const [cut] = eveningBreaks({ events, timeZone: d.timeZone }).cuts;
    const end = events.findIndex(e => isActivity(e) && e.t > cut);
    const prefix = events.slice(0, end + 1);
    const meta = { ...d.meta, endedAt: null };
    assert.deepEqual(eveningBreaks({ events: prefix, timeZone: d.timeZone, startedAt: meta.startedAt }).cuts, [cut], `journal ${d.numero}`);
    const now = () => prefix[end].t + MIN;
    const [rootA, rootB] = [vraiDossier(), vraiDossier()];
    try {
      for (const root of [rootA, rootB]) ecrireSoiree(path.join(root, 'soirees'), meta.eveningId, { meta, events: prefix });
      const a = vraiJournal(rootA, { now });
      const ra = a.repair({ id: meta.eveningId, current: true, summarize: resumer, citedIds });
      assert.equal(ra.status, 'split', `journal ${d.numero} : ${ra.status} ${ra.code}`);
      const bJ = vraiJournal(rootB, { now });
      const loaded = bJ._load(meta.eveningId);
      bJ.current = { id: meta.eveningId, meta: loaded.meta, events: loaded.events, seq: loaded.events.reduce((m, e) => Math.max(m, Number(e.seq) || 0), 0) };
      const rb = bJ.splitAt(cut, { summarize: resumer, citedIds });
      assert.deepEqual([rb.id, rb.error], [ra.previous.id, null], `journal ${d.numero}`);
      assert.deepEqual(rb.summary, ra.previous.summary);
      const [treeA, treeB] = [arbre(rootA), arbre(rootB)];
      assert.deepEqual([...treeA.keys()].sort(), [...treeB.keys()].sort(), `journal ${d.numero} : mêmes fichiers`);
      for (const [rel, data] of treeA) {
        if (rel.endsWith('.json')) assert.deepEqual(JSON.parse(String(treeB.get(rel))), JSON.parse(String(data)), `journal ${d.numero} : ${rel}`);
        else if (rel.endsWith('.jsonl')) assert.deepEqual(parseLines(String(treeB.get(rel))).events, parseLines(String(data)).events, `journal ${d.numero} : ${rel}`);
      }
      // Une seconde réparation ne change aucun fichier.
      const again = vraiJournal(rootA, { now });
      assert.equal(again.repair({ id: meta.eveningId, current: true, summarize: resumer, citedIds }).status, 'ok');
      // Puis journal.open (ici sans app.started) et la passe des soirées closes.
      const reopened = again._load(meta.eveningId);
      again.current = { id: meta.eveningId, meta: reopened.meta, events: reopened.events, seq: 0 };
      assert.deepEqual(again.repairQueue(), [], `journal ${d.numero} : morceaux déjà notés ok`);
      const after = arbre(rootA);
      assert.deepEqual([...after.keys()].sort(), [...treeA.keys()].sort());
      for (const [rel, data] of treeA) assert.ok(after.get(rel).equals(data), `journal ${d.numero} : ${rel} inchangé`);
    } finally {
      for (const root of [rootA, rootB]) fs.rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(`# 20 journaux tirés, vrai disque : ${Math.round(performance.now() - started)} ms`);
});

test('A4 : durée de la réparation (vrai disque) : soirée en cours de 60 nuits (47 760 lignes) en moins de 15 s, et soirée close de même taille (repère de 2 s) : 60 morceaux chacune, rien de perdu', () => {
  const root = vraiDossier();
  try {
    const { events, meta } = tires.recopierFixture({ fois: 60, eveningId: ORIGIN });
    assert.equal(events.length, 47760);
    const closedId = '2026-10-11_1254_cd34';
    const closedEvents = [...events, { by: 'staff-reset', v: 1, seq: events.length + 1, t: events.at(-1).t + 5 * MIN, ev: 'evening.closed', boot: 'nuit-60' }];
    ecrireSoiree(path.join(root, 'soirees'), ORIGIN, { meta, events });
    ecrireSoiree(path.join(root, 'soirees'), closedId, { meta: { ...meta, eveningId: closedId, endedAt: closedEvents.at(-1).t }, events: closedEvents });
    const size = fs.readFileSync(path.join(root, 'soirees', ORIGIN, 'journal.jsonl')).length;
    const journal = vraiJournal(root);
    const t0 = performance.now();
    const current = journal.repair({ id: ORIGIN, current: true, summarize: resumer, citedIds });
    const t1 = performance.now();
    const closed = journal.repair({ id: closedId, summarize: resumer, citedIds });
    const t2 = performance.now();
    console.log(`# Réparation de 60 nuits (${events.length} lignes, ${(size / 1e6).toFixed(1)} Mo) : soirée en cours ${Math.round(t1 - t0)} ms, soirée close ${Math.round(t2 - t1)} ms (repère 2 000 ms)`);
    for (const [result, id, all] of [[current, ORIGIN, events], [closed, closedId, closedEvents]]) {
      assert.deepEqual([result.status, result.pieces.length], ['split', 60], id);
      const pieces = result.pieces.map(p => parseLines(fs.readFileSync(path.join(root, 'soirees', p.id, 'journal.jsonl'), 'utf8')).events);
      const kept = pieces.flat().filter(e => e.carried !== true && !(e.ev === 'evening.closed' && e.split));
      assert.deepEqual(kept.map(cle).sort(), all.map(cle).sort(), `${id} : rien de perdu`);
    }
    // gstack-timing-ok: budget du plan (A4, « Durée de la réparation ») : 15 s pour la soirée en cours de 60 nuits, un filet loin des 257 s du contrôle de démarrage de l'agent ; mesurée sous 1 s ici.
    assert.ok(t1 - t0 < 15000, `soirée en cours réparée en ${Math.round(t1 - t0)} ms, budget 15 s`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Second processus qui garde `file` ouvert : sous Windows, Windows PowerShell
// sans partage de suppression ; ailleurs, node. Attend « ouvert » sur sa
// sortie, 10 s au plus, sinon échoue avec sa sortie d'erreur.
function garderOuvert(file) {
  const child = process.platform === 'win32'
    ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f = [System.IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); Write-Output 'ouvert'; Start-Sleep -Seconds 600`], { windowsHide: true })
    : spawn(process.execPath, ['-e', "require('fs').openSync(process.argv[1], 'r'); process.stdout.write('ouvert\\n'); setInterval(() => {}, 1000);", file]);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.on('exit', resolve));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`le second processus n'a pas écrit « ouvert » en 10 s ; sortie d'erreur : ${stderr || '(vide)'}`)), 10000);
    child.stdout.on('data', () => { if (/ouvert/.test(stdout)) { clearTimeout(timer); resolve(); } });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`le second processus est sorti (code ${code}) ; sortie d'erreur : ${stderr || '(vide)'}`)); });
  });
  return { ready, stop: async () => { child.kill(); await exited; } };
}

test('A7 : vrai disque (Linux et job Windows) : la fixture recopiée à +24 h réparée donne ses deux soirées, synchronisation des dossiers sans erreur ; la même réparation pendant qu’un second processus garde ouvert le journal.jsonl d’origine : sous Windows retry (EBUSY ou EPERM), origine intacte, puis finie au démarrage suivant avec le même identifiant ; sous Linux, split', async () => {
  const { events, meta } = fixture24();
  const first = vraiDossier();
  let pieceId;
  try {
    ecrireSoiree(path.join(first, 'soirees'), ORIGIN, { meta, events });
    const r = vraiJournal(first, { now: () => REPAIR_AT }).repair({ id: ORIGIN, summarize: resumer, citedIds });
    assert.deepEqual([r.status, r.pieces.length], ['split', 2]);
    pieceId = r.pieces[0].id;
    assert.deepEqual(vraiJournal(first).list().map(row => row.id).sort(), [pieceId, ORIGIN].sort());
  } finally { fs.rmSync(first, { recursive: true, force: true }); }
  const root = vraiDossier();
  try {
    ecrireSoiree(path.join(root, 'soirees'), ORIGIN, { meta, events });
    const file = path.join(root, 'soirees', ORIGIN, 'journal.jsonl');
    const original = fs.readFileSync(file);
    const holder = garderOuvert(file);
    let stopped = false;
    try {
      await holder.ready;
      const lignes = [];
      const r = vraiJournal(root).repair({ id: ORIGIN, summarize: resumer, citedIds, log: line => lignes.push(line) });
      if (process.platform === 'win32') {
        assert.equal(r.status, 'retry', lignes.join('\n'));
        assert.ok(['EBUSY', 'EPERM'].includes(r.code), r.code);
        // Après ses trois nouveaux essais (« Ordre d'écriture »), comptés dans la ligne d'échec.
        assert.ok(r.renames >= 3, `renommages refaits : ${r.renames}`);
        assert.match(lignes.join('\n'), / renommages refaits\) : reprise au prochain démarrage\./);
        assert.ok(fs.readFileSync(file).equals(original), 'origine intacte');
        await holder.stop();
        stopped = true;
        const again = vraiJournal(root).repair({ id: ORIGIN, summarize: resumer, citedIds });
        assert.equal(again.status, 'split');
        assert.equal(again.pieces[0].id, pieceId, 'même identifiant de morceau');
      } else {
        assert.equal(r.status, 'split', lignes.join('\n'));
        assert.equal(r.pieces[0].id, pieceId);
      }
    } finally { if (!stopped) await holder.stop(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('A4 : coupure (option repairEnabled: false, KARAOKE_REPAIR=off lue par server.js) : ni réparation ni splitAt, aucun fichier écrit, pas même .bornage.json ; repairQueue vide ; demo (sans dossier) : rien à réparer', () => {
  const b = banc({ repairEnabled: false });
  const { events, meta } = fixture24();
  poser(b.disk, ORIGIN, { meta, events });
  const before = b.disk.contenus();
  assert.equal(b.repair(ORIGIN).status, 'off');
  assert.equal(b.repair(ORIGIN, { current: true }).status, 'off');
  assert.deepEqual(b.journal.repairQueue(), []);
  b.journal.current = { id: ORIGIN, meta: b.journal._load(ORIGIN).meta, events: b.journal._load(ORIGIN).events, seq: events.length };
  assert.deepEqual(b.journal.splitAt(cutsOf(events, meta)[0], { summarize: resumer, citedIds }), { refused: 'off' });
  assert.deepEqual(b.disk.contenus(), before);
  assert.equal(b.disk.ops.filter(o => ['write', 'rename', 'open', 'mkdir', 'unlink'].includes(o.op)).length, 0);
  assert.deepEqual(b.lignes, []);
  assert.equal(new EveningJournal({ citedIds }).repair({ id: ORIGIN, summarize: resumer, citedIds }).status, 'skipped');
});

test('A4 : repairQueue : identifiants valides de data/soirees, hors soirée ouverte et hors index (ok, split, failed de cette version), triés ; readdirSync en échec (EIO) lève avec son code, pour la ligne « Réparation des soirées closes interrompue » de server.js', () => {
  const b = banc();
  const { events, meta } = fixture24({ fois: 1 });
  for (const id of ['2026-10-03_2000_cccc', '2026-10-01_2000_aaaa', '2026-10-02_2000_bbbb', '2026-10-04_2000_dddd', '2026-10-05_2000_eeee']) {
    poser(b.disk, id, { meta: { ...meta, eveningId: id }, events });
  }
  b.disk.dossier('data/soirees/pas-une-soiree');
  b.disk.ecrire('data/soirees/.bornage.json', JSON.stringify({ rule: 'v1', checked: { '2026-10-02_2000_bbbb': 'ok',
    '2026-10-04_2000_dddd': { status: 'retry', attempts: 1, code: 'EBUSY', version: 'v3.5.0' } } }));
  b.journal.current = { id: '2026-10-05_2000_eeee', meta: { ...meta, eveningId: '2026-10-05_2000_eeee' }, events: [], seq: 0 };
  assert.deepEqual(b.journal.repairQueue(), ['2026-10-01_2000_aaaa', '2026-10-03_2000_cccc', '2026-10-04_2000_dddd']);
  assert.equal(b.repair('2026-10-05_2000_eeee').status, 'skipped', 'la soirée ouverte n’entre jamais dans la passe');
  b.disk.crochet = (op, chemin) => (op === 'readdir' && chemin === 'data/soirees' ? 'EIO' : null);
  assert.throws(() => b.journal.repairQueue(), { code: 'EIO' });
});

test('A4 : une copie à laquelle manque une ligne non reportée du journal du dossier (même boot, même seq) ne sert jamais de reprise : le découpage repart du dossier tel qu’il est, lignes écrites depuis comprises', () => {
  const events = nuits(2);
  const meta = metaNuits(2);
  // Découpage arrêté juste après copie-complete, la soirée continue ensuite.
  const b = banc();
  poser(b.disk, ORIGIN, { meta, events });
  b.disk.crochet = (op, chemin, info) => {
    if (op === 'rename' && info.vers === `data/soirees-originales/${ORIGIN}/1/copie-complete`) b.disk.arretApres(1);
  };
  b.repair(ORIGIN, { current: true });
  const restart = banc({ depuis: b.disk.releve });
  assert.ok(restart.disk.existe(`data/soirees-originales/${ORIGIN}/1/copie-complete`));
  const later = { personId: 'a2', v: 1, seq: events.length + 1, t: NUIT + DAY + 3.5 * H, ev: 'person.seen', boot: 'boot-tard' };
  restart.disk.ecrire(`data/soirees/${ORIGIN}/journal.jsonl`, restart.disk.lire(`data/soirees/${ORIGIN}/journal.jsonl`) + texte([later]));
  const r = restart.repair(ORIGIN, { current: true });
  assert.equal(r.status, 'split');
  assert.doesNotMatch(restart.lignes[0], /reprise de la copie/);
  assert.ok(lignesDe(restart.disk, ORIGIN).some(e => cle(e) === cle(later)), 'la ligne écrite depuis est gardée');
  assert.ok(restart.disk.lire(`data/soirees-originales/${ORIGIN}/1/journal.jsonl`).includes('boot-tard'), 'nouvelle copie, prise du dossier tel qu’il est');
  assert.deepEqual(propres(restart.disk, r.pieces.map(p => p.id)).filter(e => !(e.ev === 'evening.closed' && e.split)).map(cle).sort(),
    [...events, later].map(cle).sort());
});

test('A4 : copie marquée complète mais abîmée (meta.json au JSON illisible, avec un prénom ; journal.jsonl qui est un dossier) : jamais une reprise, et jamais un échec mis au compte du meta.json de la soirée ; arrêtée avant la réécriture du journal, le découpage repart du dossier et remplace la copie octet pour octet ; arrêtée entre journal et meta.json, meta.json est fini sans recouper ; un dossier à la place d’un fichier est nommé dans la ligne d’échec (journal.jsonl de la copie, summary.json de la soirée)', () => {
  const { events, meta } = fixture24();
  const copy = `data/soirees-originales/${ORIGIN}/1`;
  const reference = banc();
  poser(reference.disk, ORIGIN, { meta, events });
  reference.repair(ORIGIN);
  const final = sansTmp(reference.disk.contenus());
  const soirees = contenus => new Map([...sansTmp(contenus)].filter(([rel]) => rel.startsWith('data/soirees/') && !rel.endsWith('/.bornage.json')));
  // Réparation arrêtée juste après le renommage vers `vers`, puis copie abîmée.
  const stopped = (vers, damage) => {
    const first = banc();
    poser(first.disk, ORIGIN, { meta, events });
    first.disk.crochet = (op, chemin, info) => { if (op === 'rename' && info.vers === vers) first.disk.arretApres(1); };
    first.repair(ORIGIN);
    assert.ok(first.disk.releve, `arrêt après ${vers}`);
    const restart = banc({ depuis: first.disk.releve });
    damage(restart.disk);
    return restart;
  };
  const truncated = disk => disk.ecrire(`${copy}/meta.json`, '{"roster":{"S01":{"name":"Léa"}');
  // Arrêtée après copie-complete : repart du dossier, copie remplacée.
  const a = stopped(`${copy}/copie-complete`, truncated);
  const ra = a.repair(ORIGIN);
  assert.equal(ra.status, 'split', `${ra.status} ${ra.code} ${ra.step}`);
  assert.doesNotMatch(a.lignes[0], /reprise de la copie/);
  assert.deepEqual(sansTmp(a.disk.contenus()), final, 'mêmes fichiers qu’une réparation sans arrêt, copie comprise');
  // Arrêtée entre le journal et le meta.json du dossier : meta.json fini, sans recouper.
  const b = stopped(`data/soirees/${ORIGIN}/journal.jsonl`, truncated);
  const rb = b.repair(ORIGIN);
  assert.equal(rb.status, 'split', `${rb.status} ${rb.code} ${rb.step}`);
  assert.deepEqual(b.lignes.map(sansDuree), [ligneFinie(reference.lignes[0])]);
  assert.deepEqual(soirees(b.disk.contenus()), soirees(final), 'mêmes soirées qu’une réparation sans arrêt');
  // journal.jsonl de la copie remplacé par un dossier : la copie ne peut pas
  // se refaire (failed), et la ligne nomme journal.jsonl.
  const c = stopped(`${copy}/copie-complete`, disk => {
    disk.fs.unlinkSync(disk.absolu(`${copy}/journal.jsonl`));
    disk.dossier(`${copy}/journal.jsonl`);
  });
  const origin = c.disk.contenus(`data/soirees/${ORIGIN}`);
  const rc = c.repair(ORIGIN);
  assert.deepEqual([rc.status, rc.code, rc.step], ['failed', 'EISDIR', 'copie']);
  assert.deepEqual(c.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « copie » (EISDIR, journal.jsonl) : notée failed, ses fichiers restent tels quels. Répare ou remets le fichier, puis refais-la ${REFAIRE}.`]);
  assert.deepEqual(c.disk.contenus(`data/soirees/${ORIGIN}`), origin, 'soirée intacte');
  // summary.json de la soirée remplacé par un dossier.
  const d = banc();
  poser(d.disk, ORIGIN, { meta, events });
  d.disk.dossier(`data/soirees/${ORIGIN}/summary.json`);
  const rd = d.repair(ORIGIN);
  assert.deepEqual([rd.status, rd.code, rd.step], ['failed', 'EISDIR', 'copie']);
  assert.deepEqual(d.lignes, [`Réparation : ${ORIGIN} en échec à l'étape « copie » (EISDIR, summary.json) : notée failed, ses fichiers restent tels quels. Répare ou remets le fichier, puis refais-la ${REFAIRE}.`]);
  for (const line of [...a.lignes, ...b.lignes, ...c.lignes]) assert.ok(!line.includes('Léa'), line);
});

test('A4 : fuseau de meta.json refusé (Bad/Zone) : une ligne au journal du serveur, une fois pour la soirée, et le fuseau du processus pour les coupures et les identifiants ; dossier sans meta.json ignoré, sans entrée à l’index', () => {
  const events = nuits(2);
  const meta = { ...metaNuits(2), timezone: 'Bad/Zone' };
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const b = banc();
  poser(b.disk, ORIGIN, { meta, events });
  const r = b.repair(ORIGIN);
  assert.equal(b.lignes.filter(line => line.includes('fuseau')).length, 1);
  assert.equal(b.lignes[0], `Réparation : ${ORIGIN} : fuseau de meta.json refusé, fuseau du processus pris (${zone}).`);
  assert.equal(r.pieces[0].id, newEveningId(meta.startedAt, splitFingerprint(ORIGIN, 1, 1), zone));
  assert.deepEqual(r.pieces.map(p => p.end).slice(0, -1), eveningBreaks({ events, timeZone: zone, startedAt: meta.startedAt }).cuts);
  b.disk.ecrire('data/soirees/2026-10-01_2000_aaaa/journal.jsonl', texte(events));
  assert.equal(b.repair('2026-10-01_2000_aaaa').status, 'ignored');
  assert.equal(bornage(b.disk).checked['2026-10-01_2000_aaaa'], undefined);
});

test('A7 : disque en mémoire, mode du harnais vm (enMemoire : data et journal, racine au dépôt) : les autres chemins vont au vrai disque, une méthode non simulée n’est refusée que sous data/ et journal/', () => {
  const root = path.join(__dirname, '..');
  const disk = disqueMemoire({ racine: root, enMemoire: ['data', 'journal'] });
  const { fs: mem } = disk;
  assert.equal(JSON.parse(mem.readFileSync(path.join(root, 'package.json'), 'utf8')).name, require('../package.json').name);
  assert.ok(mem.statSync(path.join(root, 'package.json')).isFile(), 'vrai disque hors de data/');
  assert.throws(() => mem.statSync(path.join(root, 'data')), { message: /^méthode non simulée : fs\.statSync\("data"\)\. Le disque en mémoire n'a que existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, mkdirSync, readdirSync, openSync, fsyncSync et closeSync/ });
  assert.throws(() => mem.statSync(path.join(root, 'journal', 'serveur-x.log')), /fs\.statSync\("journal\/serveur-x\.log"\)/);
  mem.mkdirSync(path.join(root, 'data', 'soirees'), { recursive: true });
  mem.writeFileSync(path.join(root, 'data', 'soirees', 'a.txt'), 'x');
  assert.equal(disk.lire('data/soirees/a.txt'), 'x');
  assert.equal(fs.existsSync(path.join(root, 'data', 'soirees', 'a.txt')), false, 'jamais sur le vrai disque');
  const fd = mem.openSync(path.join(root, 'package.json'), 'r');
  assert.ok(Number.isInteger(fd));
  mem.closeSync(fd);
});

test('A4 : cas rares de la réparation : copie-complete impossible à retirer pour la soirée en cours (une ligne, découpage gardé), dossier candidat dont meta.json est un dossier (pris, essai suivant), index qui est un dossier (lu comme vide), réparation sans résumé (aucun summary.json, l’ancien de la soirée d’origine retiré ; karaoke tiré de la première activité), splitAt d’une génération illisible refusé, ligne de pile sans numéro de ligne', () => {
  const events = nuits(2);
  const meta = metaNuits(2);
  // copie-complete impossible à retirer.
  const a = banc();
  poser(a.disk, ORIGIN, { meta, events });
  a.disk.crochet = (op, chemin) => (op === 'unlink' && chemin === `data/soirees-originales/${ORIGIN}/1/copie-complete` ? 'EIO' : null);
  const ra = a.repair(ORIGIN, { current: true });
  assert.equal(ra.status, 'split');
  assert.ok(a.lignes.includes(`Réparation : ${ORIGIN} : copie-complete de la génération 1 non retiré (EIO) : cette copie ne servira plus de reprise.`), a.lignes.join('\n'));
  // Dossier candidat dont meta.json est un dossier ; index qui est un dossier.
  const b = banc();
  poser(b.disk, ORIGIN, { meta, events });
  b.disk.dossier(`data/soirees/${idAt(meta.startedAt, 1, 1)}/meta.json`);
  b.disk.dossier('data/soirees/.bornage.json');
  const rb = b.repair(ORIGIN);
  assert.equal(rb.pieces[0].id, idAt(meta.startedAt, 1, 2));
  assert.ok(b.lignes[0].startsWith('Réparation : index data/soirees/.bornage.json illisible (EISDIR) : lu comme vide'));
  // Sans résumé : l'ancien summary.json, celui des deux nuits fusionnées, ne
  // reste sous aucun morceau.
  const c = banc();
  poser(c.disk, ORIGIN, { meta: { ...meta, endedAt: NUIT + DAY + 4 * H }, events, summary: { ancien: true } });
  const rc = c.journal.repair({ id: ORIGIN, citedIds });
  assert.equal(rc.status, 'split');
  for (const piece of rc.pieces) {
    assert.equal(c.disk.existe(`data/soirees/${piece.id}/summary.json`), false);
    const lines = lignesDe(c.disk, piece.id);
    assert.deepEqual(lireJson(c.disk, `data/soirees/${piece.id}/meta.json`).karaoke,
      { openedAt: Math.min(...lines.filter(isActivity).map(e => e.t)), closedAt: null });
  }
  // splitAt d'un morceau dont la génération est illisible.
  const d = banc();
  d.journal.current = { id: ORIGIN, meta: { ...meta, split: { from: ORIGIN, part: 2, generation: 'x' }, startedAt: NUIT }, events, seq: events.length };
  assert.deepEqual(d.journal.splitAt(NUIT + DAY - 12 * H, { summarize: resumer, citedIds }), { refused: 'generation' });
  // Ligne de pile sans numéro de ligne.
  const error = new Error('x');
  error.stack = 'Error: x\n    at f (C:\\Users\\Léa\\kit\\f.js)';
  assert.equal(soirees.errorTrace(error).stack, 'at f (f.js)');
});

// ---------------------------------------------------------------------------
// Statistiques et liste des soirées (plan du 8 novembre, A5) : karaoke et
// closedBy écrits à la clôture (journal.close), ouverture et marques de la
// liste des soirées (list(), état de .bornage.json), libellé du menu
// (openingLabel) et nom des fichiers exportés (exportFileName).
const { openingLabel, exportFileName } = soirees;
// Horloge réglée par l'essai.
const reglable = (start = 0) => { let t = start; const now = () => t; now.set = value => { t = value; }; return now; };
// Le 15 octobre 2026 à 8 h à Paris : la remise à zéro du matin.
const MATIN = Date.parse('2026-10-15T08:00:00+02:00');
const MATIN_ID = '2026-10-15_0800_ab12';
// Une soirée écrite par le journal lui-même, créée à 8 h par la remise à zéro
// du matin, KaraFun connecté dès 8 h : première activité à 20:40, trois titres
// de 21 h à 22 h 04.
function soireeDuJour(journal, now, day = MATIN) {
  const at = minutes => day + minutes * MIN;
  now.set(at(0));
  journal.open({ rules: { auto: true } });
  journal.append('karaoke.phase', { phase: 'silent', blocker: 'empty' });
  now.set(at(12 * 60 + 40));
  journal.table('T1', { name: 'Table 1', individual: false });
  journal.append('table.opened', { tableId: 'T1', individual: false });
  for (const [k, id] of ['a', 'b'].entries()) {
    now.set(at(12 * 60 + 41 + k));
    journal.person(id, { name: `Prénom ${id}`, tableId: 'T1' });
    journal.append('person.joined', { personId: id, tableId: 'T1' });
  }
  for (let s = 0; s < 3; s++) {
    const who = s % 2 ? 'b' : 'a', start = 13 * 60 + 30 * s;
    now.set(at(start - 5));
    journal.append('song.requested', { personId: who, entryId: `e${s}`, songId: 100 + s, title: `Titre ${s}` });
    now.set(at(start));
    journal.append('stage.started', { queueId: s + 1, ids: [who], ownerId: who, entryId: `e${s}`, durationSec: 240, source: 'queue' });
    now.set(at(start + 4));
    journal.append('stage.ended', { queueId: s + 1, playedSec: 240 });
  }
  return { first: at(12 * 60 + 40), lastEnd: at(14 * 60 + 4) };
}

test('A5 : clôture (journal.close) : meta.json reçoit karaoke { openedAt, closedAt } (karaokeOf du résumé) et closedBy ; « Supprimer toutes les tables » : by staff-reset, endedAt à l’heure du geste, ligne sans reason, closedAt ni firstActivityAt ; KaraFun resté connecté depuis la remise à zéro du matin : karaoke.openedAt à la première activité, ni 08:00 ni l’heure de création ; clôture d’office (by auto, reason, at = C) : endedAt à C, ligne datée de la remise à zéro avec reason et closedAt = C, karaoké fini à la fin du dernier titre, et la réparation suivante la note ok sans réécrire aucun fichier de son dossier (Retard de 3 h) ; en mémoire (démo) de même ; après un découpage en direct en échec, la soirée close reste en mémoire avec karaoke et closedBy, sans summary.json sur le dossier non réécrit', () => {
  // « Supprimer toutes les tables » à 23 h.
  const now = reglable();
  const b = banc({ now });
  const night = soireeDuJour(b.journal, now);
  const id = b.journal.id;
  now.set(MATIN + 15 * H);
  const closed = b.journal.close({ by: 'staff-reset', fields: { unsungSongs: 0 }, summarize: resumer });
  const meta = lireJson(b.disk, `data/soirees/${id}/meta.json`);
  const summary = lireJson(b.disk, `data/soirees/${id}/summary.json`);
  assert.deepEqual(plain(closed.summary), summary);
  assert.equal(summary.evening.openedAt, MATIN, 'computeStats date l’ouverture du début du journal (KaraFun connecté depuis 8 h)');
  assert.deepEqual(meta.karaoke, soirees.karaokeOf(summary, lignesDe(b.disk, id)));
  assert.deepEqual(meta.karaoke, { openedAt: night.first, closedAt: null }, 'ouverture à la première activité ; aucune fin du karaoké');
  assert.deepEqual([meta.endedAt, meta.closedBy], [MATIN + 15 * H, 'staff-reset']);
  assert.deepEqual(Object.keys(meta).slice(-2), ['karaoke', 'closedBy']);
  const line = lignesDe(b.disk, id).at(-1);
  assert.deepEqual([line.ev, line.by, line.t, line.unsungSongs], ['evening.closed', 'staff-reset', MATIN + 15 * H, 0]);
  for (const key of ['reason', 'closedAt', 'firstActivityAt']) assert.ok(!(key in line), `pas de ${key}`);
  // Close d'office à C (8 h le lendemain) par une remise à zéro faite 3 h
  // plus tard, après des lignes d'attente (téléphones revus, phase).
  const now2 = reglable();
  const c = banc({ now: now2 });
  const night2 = soireeDuJour(c.journal, now2);
  const id2 = c.journal.id;
  const C = MATIN + DAY;
  for (const [k, personId] of ['a', 'b'].entries()) { now2.set(C + (10 + k) * MIN); c.journal.append('person.seen', { personId }); }
  now2.set(C + 20 * MIN);
  c.journal.append('karaoke.phase', { phase: 'between', blocker: 'evening-end' });
  now2.set(C + 3 * H);
  c.journal.close({ by: 'auto', reason: 'morning', at: C, fields: { firstActivityAt: night2.first }, summarize: resumer });
  const meta2 = lireJson(c.disk, `data/soirees/${id2}/meta.json`);
  const summary2 = lireJson(c.disk, `data/soirees/${id2}/summary.json`);
  assert.deepEqual([meta2.endedAt, meta2.closedBy], [C, 'auto'], 'meta.endedAt à C, jamais l’heure de la remise à zéro');
  const line2 = lignesDe(c.disk, id2).at(-1);
  assert.deepEqual({ ev: line2.ev, t: line2.t, by: line2.by, reason: line2.reason, closedAt: line2.closedAt, firstActivityAt: line2.firstActivityAt },
    { ev: 'evening.closed', t: C + 3 * H, by: 'auto', reason: 'morning', closedAt: C, firstActivityAt: night2.first });
  assert.equal(summary2.evening.closedAt, night2.lastEnd, 'karaoké fini à la fin du dernier titre');
  assert.deepEqual(meta2.karaoke, { openedAt: night2.first, closedAt: night2.lastEnd });
  const files = c.disk.contenus(`data/soirees/${id2}`);
  const from = c.disk.ops.length;
  assert.equal(c.repair(id2).status, 'ok');
  assert.deepEqual(c.disk.contenus(`data/soirees/${id2}`), files, 'aucun fichier de son dossier réécrit');
  assert.equal(c.disk.ops.slice(from).filter(o => ['write', 'rename', 'open'].includes(o.op) && o.chemin.startsWith(`data/soirees/${id2}`)).length, 0);
  assert.equal(bornage(c.disk).checked[id2], 'ok');
  // En mémoire (démo, sans dossier).
  const now3 = reglable();
  const demo = new EveningJournal({ now: now3 });
  const night3 = soireeDuJour(demo, now3);
  const id3 = demo.id;
  now3.set(MATIN + 15 * H);
  demo.close({ summarize: resumer });
  const kept = demo.read(id3);
  assert.deepEqual([kept.meta.closedBy, kept.meta.karaoke], ['staff-reset', { openedAt: night3.first, closedAt: null }]);
  // Découpage en direct dont le journal du dossier n'a pas pu être réécrit :
  // la clôture garde la soirée close en mémoire (karaoke et closedBy), sans
  // summary.json sur le dossier non réécrit, dont meta.json reste celui
  // d'avant la coupure, avec sa fin.
  const events = nuits(2).filter(e => e.t < NUIT + DAY + 90 * MIN);
  const metaN = metaNuits(2);
  const [cut] = cutsOf(events, metaN);
  let t = NUIT + DAY + 2 * H;
  const d = banc({ now: () => t });
  poser(d.disk, ORIGIN, { meta: metaN, events });
  d.journal.current = { id: ORIGIN, meta: d.journal._load(ORIGIN).meta, events: d.journal._load(ORIGIN).events, seq: events.length };
  d.disk.crochet = (op, chemin, info) => (op === 'rename' && info.vers === `data/soirees/${ORIGIN}/journal.jsonl` ? 'EIO' : null);
  assert.equal(d.journal.splitAt(cut, { summarize: resumer, citedIds }).error?.code, 'EIO');
  d.disk.crochet = null;
  t = Date.parse('2026-10-17T09:00:00+02:00');
  d.journal.close({ by: 'auto', reason: 'morning', summarize: resumer });
  assert.equal(d.disk.existe(`data/soirees/${ORIGIN}/summary.json`), false, 'aucun summary.json sur le dossier non réécrit');
  const onDisk = lireJson(d.disk, `data/soirees/${ORIGIN}/meta.json`);
  assert.deepEqual([onDisk.startedAt, onDisk.endedAt, 'split' in onDisk, 'karaoke' in onDisk], [metaN.startedAt, t, false, false]);
  const inMemory = d.journal.read(ORIGIN);
  assert.equal(inMemory.meta.startedAt, cut);
  assert.deepEqual([inMemory.meta.closedBy, inMemory.meta.karaoke], ['auto', soirees.karaokeOf(inMemory.summary, inMemory.events)]);
});

test('A7 : list() avec une archive qui a meta.karaoke, une ancienne avec seulement summary.json, une sans résumé et une dont summary.json est illisible : ouverture lue dans cet ordre, aucune erreur, tri par ouverture ; état de .bornage.json joint à chaque ligne (ok, split, retry, failed, rien), soirée découpée marquée (meta.split) ; summary.json lu seulement pour une archive encore sans karaoke ; soirée en cours datée de sa première activité, sinon de son début', () => {
  const now = reglable(Date.parse('2026-10-07T18:00:00+02:00'));
  const b = banc({ now });
  const P = text => Date.parse(`2026-10-${text}:00+02:00`);
  const metaOf = (id, startedAt, extra = {}) => ({ format: 'karaoke-evening-meta', version: 1, eveningId: id, startedAt, endedAt: startedAt + 10 * H,
    timezone: PARIS, roster: { p: { name: 'Léa', tableId: '1' } }, tables: {}, ...extra });
  const ids = { karaoke: '2026-10-01_0800_aaaa', resume: '2026-10-05_1200_bbbb', sans: '2026-10-03_1900_cccc', illisible: '2026-10-05_1900_dddd',
    morceau: '2026-10-02_1900_eeee', origine: '2026-09-28_1900_ffff' };
  const summaryOf = openedAt => ({ format: 'karaoke-evening-stats', evening: { openedAt, closedAt: null } });
  // Soirée restée ouverte du 1er au 6 octobre, karaoké le 6 : meta.karaoke.
  poser(b.disk, ids.karaoke, { meta: metaOf(ids.karaoke, P('01T08:00'), { karaoke: { openedAt: P('06T21:00'), closedAt: P('06T23:30') }, closedBy: 'staff-reset' }),
    events: [], summary: summaryOf(P('01T09:00')) });
  poser(b.disk, ids.resume, { meta: metaOf(ids.resume, P('05T12:00')), events: [], summary: summaryOf(P('05T22:00')) });
  poser(b.disk, ids.sans, { meta: metaOf(ids.sans, P('03T19:00')), events: [] });
  poser(b.disk, ids.illisible, { meta: metaOf(ids.illisible, P('05T19:00')), events: [] });
  b.disk.ecrire(`data/soirees/${ids.illisible}/summary.json`, '{abîmé');
  // Un morceau découpé (son origine n'existe plus : il est montré) et une
  // origine découpée.
  poser(b.disk, ids.morceau, { meta: metaOf(ids.morceau, P('02T19:00'), { karaoke: { openedAt: P('02T20:00'), closedAt: null }, closedBy: 'auto',
    split: { from: '2026-09-20_1900_9999', part: 1, generation: 1, rule: 'v1' } }), events: [] });
  poser(b.disk, ids.origine, { meta: metaOf(ids.origine, P('01T08:00').valueOf() - 3 * DAY, { karaoke: { openedAt: P('01T08:00') - 2 * DAY, closedAt: null },
    closedBy: 'staff-reset', split: { from: ids.origine, part: 2, generation: 1, rule: 'v1' } }), events: [] });
  b.disk.ecrire('data/soirees/.bornage.json', JSON.stringify({ rule: 'v1', checked: {
    [ids.karaoke]: 'ok', [ids.resume]: { status: 'failed', attempts: 1, code: 'BAD_JSON', version: 'v3.5.0' },
    [ids.sans]: { status: 'retry', attempts: 2, code: 'EBUSY', version: 'v3.5.0' }, [ids.morceau]: 'ok', [ids.origine]: 'split' } }));
  // Soirée en cours : ouverte à 18 h, sans activité, puis une inscription à 20:15.
  b.journal.open();
  const current = b.journal.id;
  // Lectures des deux list() qui suivent : un summary.json n'est lu qu'au premier.
  const from = b.disk.ops.length;
  let rows = b.journal.list();
  assert.equal(rows.find(row => row.current).openedAt, P('07T18:00'), 'sans activité : son début');
  now.set(P('07T20:15'));
  b.journal.append('person.joined', { personId: 'q', tableId: '2' });
  rows = b.journal.list();
  const reads = b.disk.ops.slice(from).filter(o => o.op === 'read').map(o => o.chemin);
  assert.deepEqual(rows.map(row => row.id), [current, ids.karaoke, ids.resume, ids.illisible, ids.sans, ids.morceau, ids.origine], 'tri par ouverture, la plus récente d’abord');
  const byId = new Map(rows.map(row => [row.id, row]));
  assert.deepEqual([...byId].map(([key, row]) => [key, row.openedAt]), [
    [current, P('07T20:15')], [ids.karaoke, P('06T21:00')], [ids.resume, P('05T22:00')], [ids.illisible, P('05T19:00')], [ids.sans, P('03T19:00')],
    [ids.morceau, P('02T20:00')], [ids.origine, P('01T08:00') - 2 * DAY]]);
  assert.deepEqual([...byId].map(([key, row]) => [key, row.repair, row.split]), [
    [current, null, false], [ids.karaoke, 'ok', false], [ids.resume, 'failed', false], [ids.illisible, null, false], [ids.sans, 'retry', false],
    [ids.morceau, 'ok', true], [ids.origine, 'split', true]]);
  // summary.json : lu pour les archives sans karaoke seulement.
  assert.deepEqual(reads.filter(rel => rel.endsWith('/summary.json')).sort(),
    [`data/soirees/${ids.resume}/summary.json`, `data/soirees/${ids.illisible}/summary.json`]);
  assert.ok(reads.every(rel => rel.endsWith('/meta.json') || rel.endsWith('/summary.json') || rel === 'data/soirees/.bornage.json'), reads.join(', '));
  // Index illisible ou absent : aucune marque, aucune erreur.
  b.disk.ecrire('data/soirees/.bornage.json', '{tronqué');
  assert.ok(b.journal.list().every(row => row.repair === null));
  // Démo (sans dossier) : la soirée en cours et les soirées closes en mémoire.
  const demoNow = reglable(P('07T18:00'));
  const demo = new EveningJournal({ now: demoNow });
  demo.open();
  demoNow.set(P('07T19:00'));
  demo.close({ summarize: () => summaryOf(P('07T18:30')) });
  demoNow.set(P('07T19:05'));
  demo.start();
  assert.deepEqual(demo.list().map(row => [row.current, row.openedAt, row.repair, row.split]), [[true, P('07T19:05'), null, false], [false, P('07T18:30'), null, false]]);
});

test('A5 : list() sans la passe des soirées closes (KARAOKE_REPAIR=off), deux archives encore sans karaoke : chaque summary.json lu et analysé une fois par démarrage, son ouverture gardée d’après le texte de son meta.json ; un second list(), puis openedAt(id), n’en lisent aucun ; relu quand son meta.json change ou après une réparation de l’archive ; une lecture en échec passager (EBUSY) n’est pas gardée', () => {
  const P = text => Date.parse(`2026-10-${text}:00+02:00`);
  const ids = ['2026-10-01_1900_aaaa', '2026-10-08_1900_bbbb'];
  const metaOf = (id, day) => ({ ...metaNuits(1, { id, endedAt: P(`${day}T23:30`) }), startedAt: P(`${day}T19:00`) });
  const summaryOf = openedAt => ({ format: 'karaoke-evening-stats', evening: { openedAt, closedAt: null } });
  const b = banc({ repairEnabled: false });
  poser(b.disk, ids[0], { meta: metaOf(ids[0], '01'), events: [], summary: summaryOf(P('01T20:40')) });
  poser(b.disk, ids[1], { meta: metaOf(ids[1], '08'), events: [], summary: summaryOf(P('08T21:10')) });
  const lus = (disk, from) => disk.ops.slice(from).filter(o => o.op === 'read' && o.chemin.endsWith('/summary.json')).map(o => o.chemin.split('/')[2]).sort();
  let from = b.disk.ops.length;
  const first = b.journal.list();
  assert.deepEqual(first.map(row => [row.id, row.openedAt]), [[ids[1], P('08T21:10')], [ids[0], P('01T20:40')]]);
  assert.deepEqual(lus(b.disk, from), ids, 'premier list() : chaque summary.json lu une fois');
  from = b.disk.ops.length;
  assert.deepEqual(b.journal.list(), first, 'second list() : la même liste');
  assert.deepEqual(ids.map(id => b.journal.openedAt(id)), [P('01T20:40'), P('08T21:10')], 'openedAt(id) : la même ouverture');
  assert.deepEqual(lus(b.disk, from), [], 'second list() et openedAt(id) : aucun summary.json relu');
  // Son meta.json changé (ici un prénom de plus) : son summary.json relu, une fois.
  b.disk.ecrire(`data/soirees/${ids[0]}/meta.json`, JSON.stringify({ ...metaOf(ids[0], '01'), roster: { ...metaOf(ids[0], '01').roster, c1: { name: 'Prénom c1', tableId: 'T1' } } }, null, 1));
  b.disk.ecrire(`data/soirees/${ids[0]}/summary.json`, JSON.stringify(summaryOf(P('01T20:50'))));
  from = b.disk.ops.length;
  assert.equal(b.journal.list().find(row => row.id === ids[0]).openedAt, P('01T20:50'));
  assert.equal(b.journal.openedAt(ids[0]), P('01T20:50'));
  assert.deepEqual(lus(b.disk, from), [ids[0]], 'meta.json changé : relu une fois');
  // Lecture en échec passager (EBUSY) : l'ouverture de son meta.json, puis relu au list() suivant.
  const e = banc({ repairEnabled: false });
  poser(e.disk, ids[1], { meta: metaOf(ids[1], '08'), events: [], summary: summaryOf(P('08T21:10')) });
  let fois = 1;
  e.disk.crochet = (op, chemin) => (op === 'read' && chemin.endsWith('/summary.json') && fois-- > 0 ? 'EBUSY' : null);
  from = e.disk.ops.length;
  assert.equal(e.journal.list()[0].openedAt, P('08T19:00'), 'EBUSY : son début (meta.startedAt)');
  assert.equal(e.journal.list()[0].openedAt, P('08T21:10'), 'relu au list() suivant');
  assert.equal(e.journal.list()[0].openedAt, P('08T21:10'));
  assert.deepEqual(lus(e.disk, from), [ids[1], ids[1]], 'lu deux fois : l’échec, puis la lecture gardée');
  // Réparation de l'archive (réparation active), son meta.json refusé après le summary.json réécrit : relu.
  const r = banc();
  poser(r.disk, ORIGIN, { ...fusionnee(ORIGIN), summary: summaryOf(NUIT) });
  assert.equal(r.journal.list().find(row => row.id === ORIGIN).openedAt, NUIT);
  r.disk.crochet = (op, chemin, info) => (op === 'rename' && info.vers === `data/soirees/${ORIGIN}/meta.json` ? 'ENOSPC' : null);
  assert.equal(r.repair(ORIGIN).status, 'retry');
  r.disk.crochet = null;
  const rewritten = lireJson(r.disk, `data/soirees/${ORIGIN}/summary.json`).evening.openedAt;
  assert.ok(Number.isFinite(rewritten) && rewritten !== NUIT, 'summary.json réécrit pour le dernier morceau');
  from = r.disk.ops.length;
  assert.equal(r.journal.list().find(row => row.id === ORIGIN).openedAt, rewritten, 'après la réparation : relu');
  assert.deepEqual(lus(r.disk, from), [ORIGIN]);
});

test('A5 : soirée en cours découpée à 9 h 55 (splitAt), puis heure du PC reculée (activité datée de 7 h 50, puis de la veille à 20 h 10) : l’ouverture de sa ligne de list() et d’openedAt(id) (libellé du menu, nom d’export) reste à 9 h 55, jamais avant firstActivityAt (A1), et la soirée reste rangée avant le morceau archivé ; à la clôture, karaoke.openedAt vaut 9 h 55, résumé en échec, sans résumé ou par computeStats', () => inZone(PARIS, () => {
  const P = text => Date.parse(`2026-10-${text}:00+02:00`);
  const summaries = { 'résumé en échec': () => { throw new Error('résumé en échec'); }, 'sans résumé': null, computeStats: resumer };
  for (const [kind, summarize] of Object.entries(summaries)) {
    const now = reglable();
    const b = banc({ now });
    const at = (text, ev, fields) => { now.set(P(text)); return b.journal.append(ev, fields); };
    now.set(P('15T19:00'));
    b.journal.open({ rules: { auto: true } });
    at('15T20:40', 'table.opened', { tableId: 'T1', individual: false });
    at('15T20:41', 'person.joined', { personId: 'a', tableId: 'T1' });
    // Titres jusqu'à 8 h 55 le 16 : M = 8 h, C = 9 h 55 (A1) ; une
    // inscription à 20 h le 16 fait couper la soirée à C.
    for (const [s, start] of ['16T07:50', '16T08:10', '16T08:55'].entries()) {
      at(start, 'song.requested', { personId: 'a', entryId: `e${s}`, songId: 100 + s, title: `Titre ${s}` });
      at(start, 'stage.started', { queueId: s + 1, ids: ['a'], ownerId: 'a', entryId: `e${s}`, durationSec: 200, source: 'queue' });
      now.set(P(start) + 4 * MIN);
      b.journal.append('stage.ended', { queueId: s + 1, playedSec: 240 });
    }
    at('16T20:00', 'person.joined', { personId: 'b', tableId: 'T1' });
    const [cut] = cutsOf(b.journal.current.events, b.journal.current.meta);
    assert.equal(cut, P('16T09:55'));
    const split = b.journal.splitAt(cut, { summarize: resumer, citedIds });
    assert.equal(split.error, null);
    const id = b.journal.id;
    assert.deepEqual([b.journal.current.meta.startedAt, b.journal.current.meta.split.cut], [cut, cut]);
    // Heure du PC reculée : une inscription datée de 7 h 50 le 16, avant le
    // début du morceau en cours ; elle y compte à ce début (A1).
    at('16T07:50', 'person.joined', { personId: 'c', tableId: 'T1' });
    const currentRow = () => b.journal.list().find(row => row.current);
    assert.equal(currentRow().openedAt, cut, `${kind} : ouverture de la liste au début du morceau, pas à 7 h 50`);
    assert.equal(b.journal.openedAt(id), cut, 'la même pour le nom d’export');
    assert.equal(openingLabel(currentRow().openedAt, PARIS), 'ven. 16 oct. · 09:55');
    assert.equal(exportFileName({ id, openedAt: b.journal.openedAt(id), timeZone: PARIS }), `soiree-2026-10-16_0955_${id.slice(-4)}.json`);
    // Puis une table datée de la veille à 20 h 10, avant l'ouverture du
    // morceau archivé (20 h 40) : la soirée en cours reste la première.
    at('15T20:10', 'table.opened', { tableId: 'T2', individual: false });
    const order = [[id, cut], [split.id, P('15T20:40')]];
    assert.deepEqual(b.journal.list().map(row => [row.id, row.openedAt]), order);
    // Clôture par « Supprimer toutes les tables », le 17 à 1 h.
    now.set(P('17T01:00'));
    b.journal.close({ summarize });
    assert.equal(lireJson(b.disk, `data/soirees/${id}/meta.json`).karaoke.openedAt, cut, `${kind} : karaoke.openedAt au début du morceau`);
    assert.deepEqual(b.journal.list().map(row => [row.id, row.openedAt]), order, kind);
  }
}));

// Deux soirées dans un journal créé à 8 h par la remise à zéro du matin,
// KaraFun connecté dès 8 h et jamais coupé : première activité à 20:40 chaque
// soir ; b1, de la première, chante aussi la seconde (reportée). Close par le
// bar à 23 h le second soir.
function deuxSoireesDuMatin(id = MATIN_ID) {
  const events = [];
  const add = (t, ev, fields, boot = 'b-1') => events.push({ ...fields, v: 1, seq: events.length + 1, t, ev, boot });
  add(MATIN, 'evening.started', { rules: { auto: true } });
  add(MATIN, 'app.started', { restored: false, offlineMs: 0 });
  add(MATIN, 'karaoke.phase', { phase: 'silent', blocker: 'empty' });
  for (let k = 0; k < 2; k++) {
    const at = minutes => MATIN + k * DAY + minutes * MIN, T = `T${k + 1}`, a = `a${k + 1}`;
    add(at(12 * 60 + 40), 'table.opened', { tableId: T, individual: false });
    add(at(12 * 60 + 41), 'person.joined', { personId: a, tableId: T });
    if (k === 0) add(at(12 * 60 + 42), 'person.joined', { personId: 'b1', tableId: T });
    for (const [s, who] of [a, 'b1'].entries()) {
      const start = 13 * 60 + 30 * s;
      add(at(start - 10), 'song.requested', { personId: who, entryId: `e${k}-${s}`, songId: 200 + s, title: `Titre ${k}-${s}` });
      add(at(start), 'stage.started', { queueId: 10 * k + s + 1, ids: [who], ownerId: who, entryId: `e${k}-${s}`, durationSec: 240, source: 'queue' });
      add(at(start + 4), 'stage.ended', { queueId: 10 * k + s + 1, playedSec: 240 });
    }
  }
  const end = MATIN + DAY + 15 * H;
  add(end, 'evening.closed', { by: 'staff-reset' });
  const meta = { format: 'karaoke-evening-meta', version: 1, eveningId: id, startedAt: MATIN, endedAt: end, app: { version: 'v3.5.0', commit: null },
    timezone: PARIS, roster: { a1: { name: 'Prénom a1', tableId: 'T1' }, b1: { name: 'Prénom b1', tableId: 'T1' }, a2: { name: 'Prénom a2', tableId: 'T2' } },
    tables: { T1: { name: 'Table 1', individual: false }, T2: { name: 'Table 2', individual: false } } };
  return { events, meta };
}

test('A7 : libellé du menu et nom d’export de chaque morceau, KaraFun resté connecté depuis la remise à zéro du matin : heure de la première activité, ni 08:00 ni l’heure de la remise à zéro ; morceau réparé dont KaraFun est resté connecté de la coupure jusqu’au soir, avec des personnes reportées : libellé du menu à sa première activité ; soirée en cours créée à 8 h : nom d’export (openedAt) à sa première activité, ni 08:00 ; openingLabel et exportFileName (fuseau de la soirée, sous TZ=UTC)', () => inZone('UTC', () => {
  const b = banc();
  const { events, meta } = deuxSoireesDuMatin();
  poser(b.disk, MATIN_ID, { meta, events });
  const r = b.repair(MATIN_ID);
  assert.equal(r.status, 'split');
  const [firstId] = r.pieces.map(piece => piece.id);
  assert.equal(firstId.slice(0, 15), '2026-10-15_0800', 'le morceau commence à 8 h, à la remise à zéro du matin');
  // Personne reportée au second morceau, qui commence à la coupure (8 h).
  const second = lignesDe(b.disk, MATIN_ID);
  assert.ok(second.some(e => e.carried === true && e.ev === 'person.joined' && e.personId === 'b1'));
  assert.equal(second[0].t, MATIN + DAY);
  const rows = new Map(b.journal.list().map(row => [row.id, row]));
  const opening = [MATIN + 12 * H + 40 * MIN, MATIN + DAY + 12 * H + 40 * MIN];
  assert.deepEqual([rows.get(firstId).openedAt, rows.get(MATIN_ID).openedAt], opening, 'ouverture à la première activité de chaque morceau');
  assert.deepEqual([b.journal.openedAt(firstId), b.journal.openedAt(MATIN_ID)], opening, 'la même ouverture pour le nom d’export');
  assert.deepEqual(opening.map(t => openingLabel(t, PARIS)), ['jeu. 15 oct. · 20:40', 'ven. 16 oct. · 20:40']);
  const names = [firstId, MATIN_ID].map((id, i) => exportFileName({ id, openedAt: opening[i], timeZone: PARIS }));
  assert.deepEqual(names, [`soiree-2026-10-15_2040_${firstId.slice(-4)}.json`, 'soiree-2026-10-16_2040_ab12.json']);
  for (const name of names) assert.doesNotMatch(name, /_0800/);
  assert.equal(exportFileName({ id: MATIN_ID, openedAt: opening[1], timeZone: PARIS, names: true }), 'soiree-2026-10-16_2040_ab12-prenoms.json');
  // Sans ouverture lisible, ou un fuseau refusé : l'heure de l'identifiant, ou
  // le fuseau du processus ; jamais d'exception.
  assert.equal(exportFileName({ id: MATIN_ID, openedAt: null, timeZone: PARIS }), `soiree-${MATIN_ID}.json`);
  assert.equal(exportFileName({ id: MATIN_ID, openedAt: 9e15, timeZone: PARIS }), `soiree-${MATIN_ID}.json`);
  assert.equal(exportFileName({ id: MATIN_ID, openedAt: opening[1], timeZone: 'Bad/Zone' }), 'soiree-2026-10-16_1840_ab12.json');
  assert.equal(openingLabel(opening[1], 42), 'ven. 16 oct. · 18:40', 'fuseau du processus (UTC)');
  for (const bad of [null, undefined, NaN, 'hier', 9e15]) assert.equal(openingLabel(bad, PARIS), null, String(bad));
  // Identifiant fait d'un chemin : null, sans lire le meta.json où il mène,
  // qui daterait l'export : la copie d'origine que la réparation garde
  // (data/soirees-originales/<id>/<g>/, A4), ou un meta.json posé hors de
  // data/soirees, avec son ouverture.
  assert.ok(b.disk.existe(`data/soirees-originales/${MATIN_ID}/1/meta.json`), 'copie d’origine gardée par la réparation');
  b.disk.ecrire('data/etc/meta.json', JSON.stringify({ karaoke: { openedAt: opening[1], closedAt: null } }));
  for (const bad of ['../etc', `../soirees-originales/${MATIN_ID}/1`]) assert.equal(b.journal.openedAt(bad), null, bad);
  assert.equal(b.journal.openedAt('2026-01-01_2000_0000'), null, 'soirée inconnue');
  b.disk.ecrire('data/soirees/2026-01-02_2000_0000/meta.json', '{abîmé');
  assert.equal(b.journal.openedAt('2026-01-02_2000_0000'), null, 'meta.json illisible : sans erreur');
  // Identifiant invalide : un nom générique, jamais un texte venu d'ailleurs.
  assert.deepEqual([exportFileName({ id: '../x"' }), exportFileName({ id: null, names: true })], ['soiree.json', 'soiree-prenoms.json']);
  // Soirée en cours, créée à 8 h par la remise à zéro du matin, KaraFun
  // connecté dès 8 h : son nom d'export (openedAt(id)) prend sa première
  // activité, comme sa ligne de list(), jamais l'heure de création de son
  // journal, que son meta.json garde (startedAt).
  const nowC = reglable();
  const c = banc({ now: nowC });
  const night = soireeDuJour(c.journal, nowC);
  const currentId = c.journal.id;
  assert.equal(lireJson(c.disk, `data/soirees/${currentId}/meta.json`).startedAt, MATIN);
  assert.equal(c.journal.list().find(row => row.current).openedAt, night.first);
  assert.equal(c.journal.openedAt(currentId), night.first, 'soirée en cours : sa première activité');
  const currentName = exportFileName({ id: currentId, openedAt: c.journal.openedAt(currentId), timeZone: PARIS });
  assert.equal(currentName, `soiree-2026-10-15_2040_${currentId.slice(-4)}.json`);
  assert.doesNotMatch(currentName, /_0800_/);
  // En mémoire (démo) : la soirée close garde son ouverture.
  const now = reglable(MATIN);
  const demo = new EveningJournal({ now });
  demo.open();
  const closedId = demo.id;
  now.set(MATIN + 12 * H);
  demo.close({ summarize: () => ({ evening: { openedAt: MATIN + 11 * H, closedAt: null } }) });
  assert.equal(demo.openedAt(closedId), MATIN + 11 * H);
  assert.equal(demo.openedAt('2026-01-01_2000_0000'), null, 'démo : soirée inconnue');
}));

test('A7 : retard de 3 h (A5), journal fusionné de deux soirées, sans heure de fermeture ni coupure de KaraFun, PC éteint de 2 h à 20 h le lendemain (app.started daté de 20 h), réparé : le premier morceau finit son karaoké à la fin de son dernier titre, avant 2 h, et la ligne app.started reste au second morceau ; relu sans meta, comme par rejeu-soiree.js, son C est l’heure t de sa ligne evening.closed (sans closedAt) : même fin du karaoké, même indice de Jain, mêmes présences', () => {
  const b = banc();
  const reprise = NUIT + DAY;
  // Les lignes de la seconde nuit 5 min plus tard, après la reprise de 20 h.
  const events = nuits(2).map(e => (e.t >= reprise ? { ...e, t: e.t + 5 * MIN } : e));
  events.push({ v: 1, seq: 0, t: reprise, ev: 'app.started', boot: 'boot-2', restored: true, offlineMs: 18 * H, version: 'v3.5.0' });
  events.sort((x, y) => x.t - y.t || x.seq - y.seq).forEach((e, i) => { e.seq = i + 1; });
  const end = events.at(-1).t + 5 * MIN;
  events.push({ by: 'staff-reset', v: 1, seq: events.length + 1, t: end, ev: 'evening.closed', boot: 'boot-2' });
  poser(b.disk, ORIGIN, { meta: metaNuits(2, { endedAt: end }), events });
  const lastTitle = Math.max(...events.filter(e => e.ev === 'stage.ended' && e.t < reprise).map(e => e.t));
  const r = b.repair(ORIGIN);
  assert.equal(r.status, 'split');
  const firstId = r.pieces[0].id;
  const summary = lireJson(b.disk, `data/soirees/${firstId}/summary.json`);
  const meta = lireJson(b.disk, `data/soirees/${firstId}/meta.json`);
  assert.equal(meta.closedBy, 'auto');
  assert.equal(summary.evening.closedAt, lastTitle, 'karaoké fini à la fin du dernier titre');
  assert.ok(summary.evening.closedAt < Date.parse('2026-10-16T02:00:00+02:00'));
  assert.equal(meta.karaoke.closedAt, lastTitle);
  // Relu sans meta, comme test/rejeu-soiree.js relit un export : la ligne
  // evening.closed du morceau (by auto, datée de la coupure, sans closedAt)
  // donne seule son C, par son heure t (A5).
  const pieceLines = lignesDe(b.disk, firstId);
  const closing = pieceLines.findLast(e => e.ev === 'evening.closed');
  assert.deepEqual([closing.by, closing.t, 'closedAt' in closing], ['auto', meta.endedAt, false]);
  const bare = computeStats({ events: pieceLines, now: pieceLines.reduce((m, e) => Math.max(m, e.t), 0) });
  const presences = stats => stats.singers.map(s => [s.id, s.presenceSec]);
  assert.equal(bare.evening.closedAt, lastTitle, 'sans meta : karaoké fini à la fin du dernier titre');
  assert.deepEqual([bare.fairness.jain, presences(bare)], [summary.fairness.jain, presences(summary)], 'sans meta : même indice de Jain, mêmes présences');
  assert.ok(!lignesDe(b.disk, firstId).some(e => e.ev === 'app.started' && e.t === reprise), 'pas au premier morceau');
  assert.ok(lignesDe(b.disk, ORIGIN).some(e => e.ev === 'app.started' && e.t === reprise && e.offlineMs === 18 * H), 'au second morceau');
});

test('A7 : fin d’une soirée close d’office (A5), morceau réparé : journal fusionné de deux nuits, sans heure de fermeture ni arrêt de l’application, KaraFun coupé à C − 10 min et revenu à C + 5 min (C, la coupure de 8 h), la ligne du retour rangée au second morceau par son heure : coupure brève, jugée à C ; le premier morceau finit son karaoké à la fin de son dernier titre (summary.json et meta.karaoke.closedAt), avec les présences et l’indice de Jain du même journal réparé sans cette coupure, et relu sans meta de même', () => {
  const C = Date.parse('2026-10-16T08:00:00+02:00');
  const presences = stats => stats.singers.map(s => [s.id, s.presenceSec]);
  const reparer = coupure => {
    const b = banc();
    const { meta, events } = fusionnee(ORIGIN);
    if (coupure) {
      events.push({ v: 1, seq: 0, t: C - 10 * MIN, ev: 'karaoke.phase', boot: 'boot-1', phase: 'unknown', blocker: 'offline' },
        { v: 1, seq: 0, t: C + 5 * MIN, ev: 'karaoke.phase', boot: 'boot-1', phase: 'silent', blocker: 'empty' });
      events.sort((x, y) => x.t - y.t || x.seq - y.seq).forEach((e, i) => { e.seq = i + 1; });
    }
    assert.deepEqual(cutsOf(events, meta), [C], 'une coupure, à 8 h');
    poser(b.disk, ORIGIN, { meta, events });
    const r = b.repair(ORIGIN);
    assert.equal(r.status, 'split');
    const id = r.pieces[0].id, lines = lignesDe(b.disk, id);
    return { b, events, lines, meta: lireJson(b.disk, `data/soirees/${id}/meta.json`), summary: lireJson(b.disk, `data/soirees/${id}/summary.json`),
      bare: computeStats({ events: lines, now: lines.reduce((m, e) => Math.max(m, e.t), 0) }) };
  };
  const sans = reparer(false), avec = reparer(true);
  const lastTitle = Math.max(...avec.events.filter(e => e.ev === 'stage.ended' && e.t < C).map(e => e.t));
  assert.equal(sans.summary.evening.closedAt, lastTitle, 'sans la coupure : karaoké fini à la fin du dernier titre');
  assert.ok(avec.lines.some(e => e.ev === 'karaoke.phase' && e.blocker === 'offline' && e.t === C - 10 * MIN), 'coupure au premier morceau');
  assert.ok(!avec.lines.some(e => e.ev === 'karaoke.phase' && e.t === C + 5 * MIN), 'retour absent du premier morceau');
  assert.ok(lignesDe(avec.b.disk, ORIGIN).some(e => e.ev === 'karaoke.phase' && e.carried !== true && e.t === C + 5 * MIN), 'retour au second morceau');
  assert.deepEqual([avec.meta.closedBy, avec.meta.endedAt], ['auto', C]);
  assert.equal(avec.summary.evening.closedAt, lastTitle, 'karaoké fini à la fin du dernier titre, pas à la coupure de KaraFun');
  assert.equal(avec.meta.karaoke.closedAt, lastTitle);
  assert.deepEqual([avec.summary.fairness.jain, presences(avec.summary)], [sans.summary.fairness.jain, presences(sans.summary)],
    'mêmes présences et même indice de Jain que sans la coupure');
  assert.equal(avec.bare.evening.closedAt, lastTitle, 'relu sans meta : karaoké fini à la fin du dernier titre');
  assert.deepEqual([avec.bare.fairness.jain, presences(avec.bare)], [sans.summary.fairness.jain, presences(sans.summary)], 'relu sans meta : de même');
});
