'use strict';
// Rejeu d'une vraie soirée (export anonymisé du 15 octobre 2026, clés S01… et
// T1… à la place des prénoms et des tables) avec test/rejeu-soiree.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const rejeu = require('./rejeu-soiree');

const FIXTURE = path.join(__dirname, 'fixtures', 'soiree-2026-10-15-anonyme.json');
const JAR = path.join(__dirname, '..', 'solver', 'target', 'karafun-solver.jar');
const ev = rejeu.loadEvening(FIXTURE);
let forced = null;
const forcedRun = async () => forced ||= await rejeu.runForced(ev);
const ids = d => d?.ids.join('+');
// Configurations Timefold écrites par les rejeux (limite de mouvements) :
// chacune est effacée en fin de rejeu. Dossier temporaire propre à ce fichier
// de tests : un rejeu lancé à côté n'y écrit pas.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-tests-'));
for (const k of ['TMPDIR', 'TMP', 'TEMP']) process.env[k] = TMP;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const solverDirs = () => fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('rejeu-timefold-')).sort();
const dirsBefore = solverDirs();
// Événement ajouté à son heure dans une copie de l'export : numéro d'ordre
// juste après le dernier événement de la soirée qui le précède.
function adder(events) {
  let extra = 0;
  return (t, ev, fields) => {
    const seq = Math.max(...events.filter(e => e.t <= t).map(e => e.seq)) + 0.5 + (extra += 0.001);
    events.push({ v: 1, t, seq, ev, ...fields });
  };
}

test('export anonymisé : 56 passages réels, mêmes attentes et même équilibre que l’export complet (instantané)', () => {
  assert.equal(ev.realPassages.filter(p => p.source === 'queue').length, 56);
  const real = rejeu.computeWaits(ev.realPassages, ev);
  assert.equal(real.length, 56);
  const compared = real.filter(w => ev.exportWaits.has(w.entryId));
  assert.equal(compared.length, 56);
  assert.deepEqual(compared.filter(w => ev.exportWaits.get(w.entryId) !== w.waitSec).map(w => w.entryId), []);
  // Sans monter sur scène : S13, seulement invité, a attendu 59 min son duo.
  const stage = rejeu.stageWaitsOf(ev.events);
  for (const { id, stageWaits } of ev.raw.stats.singers) assert.equal(stage[id]?.maxSec, stageWaits.maxSec, id);
  assert.equal(Math.round(stage.S13.maxSec / 60), 59);
  // Valeur relevée à la main sur la soirée : « L'aventurier » de S05, prête
  // depuis la fin de son passage de 21:39 (31 min avec l'ancienne définition,
  // qui repartait de son passage en invitée de 22:24).
  const aventurier = real.find(w => w.title === 'L\'aventurier');
  assert.equal(aventurier.owner, 'S05');
  assert.equal(Math.round(aventurier.waitSec / 60), 81);
  assert.equal(stage.S13.guestN, 1);
  // Présences gardées : même équilibre des passages que l'export complet.
  const balance = rejeu.balanceOf(require('../evening-stats').computeStats({ events: ev.raw.events,
    now: ev.raw.events.reduce((m, e) => Math.max(m, e.t), 0) }));
  for (const [k, v] of Object.entries(ev.raw.stats.fairness)) {
    if (k in balance) assert.equal(balance[k], v, k);
  }
  assert.equal(balance.jain, 0.784);
});

test('rejeu libre : le journal rejoué garde les demandes réelles et remplace les passages', async () => {
  const passages = ev.realPassages;
  const journal = rejeu.replayJournal(ev, passages);
  // Rejouer les passages réels redonne les attentes de la soirée.
  assert.deepEqual(rejeu.computeWaits(passages, ev, journal).map(w => [w.entryId, w.waitSec]),
    rejeu.computeWaits(passages, ev).map(w => [w.entryId, w.waitSec]));
  assert.equal(journal.filter(e => e.ev === 'turn.sent').length, 0);
  assert.equal(journal.filter(e => e.ev === 'song.requested').length, ev.events.filter(e => e.ev === 'song.requested').length);
  // Passages rejoués avec leur envoi : un turn.sent à cette heure (la rotation
  // compte un passage à l'envoi), au rang des passages de la file seulement.
  const sent = passages.map(p => p.source === 'queue' ? { ...p, sentAt: p.start - 60000 } : p);
  const withSends = rejeu.replayJournal(ev, sent).filter(e => e.ev === 'turn.sent');
  assert.equal(withSends.length, sent.filter(p => p.source === 'queue').length);
  assert.deepEqual(withSends.map(e => [e.entryId, e.t]), sent.filter(p => p.source === 'queue').map(p => [p.entryId, p.sentAt]));
});

test('rejeu forcé sans Timefold : chaque envoi réel jusqu’au nouveau tour de 21:49:51, sauf l’égalité de 21:06:30', async () => {
  const res = await forcedRun();
  const sends = res.decisions.filter(d => d.kind === 'send');
  assert.equal(sends.length, 56);
  const reset = sends.findIndex(d => d.time === '21:49:51');
  assert.ok(reset > 0, 'envoi de 21:49:51 retrouvé');
  assert.equal(sends[reset].real.newRound, true);
  const misses = sends.slice(0, reset + 1).filter(d => !d.match).map(d => d.time);
  // 21:06:30 : égalité entre S05 et S07 départagée par le plan Timefold en réel.
  assert.deepEqual(misses, ['21:06:30']);
  // L'état suit la soirée : le nouveau tour tombe aux mêmes envois.
  assert.equal(sends.filter(d => d.committed.newRound === d.real.newRound).length, 56);
});

test('rejeu forcé : le duo S07+S05 passe dans son tour, avant 22:10 (réel : 22:29:39, 72 min d’attente)', async () => {
  const res = await forcedRun();
  const sends = res.decisions.filter(d => d.kind === 'send');
  const real = sends.find(d => ids(d.real) === 'S07+S05');
  assert.equal(real.time, '22:29:39');
  // La dette de l'invitée S05 (passage emprunté à 21:39:50) ne range plus le
  // duo de S07, qui ne doit rien, derrière tout le tour.
  const early = sends.filter(d => d.time >= '21:52' && d.time < '22:10' &&
    (ids(d.pick) === 'S07+S05' || ids(d.reservation?.pick) === 'S07+S05'));
  assert.ok(early.length > 0, 'duo choisi entre 21:52 et 22:10 : ' + sends.map(d => `${d.time} ${ids(d.pick)}`).join(', '));
  // Explication tirée de l'état : S05 compte dans le tour par sa dette seule
  // (aucune montée sur scène dans ce tour), que la rotation n'oppose plus au duo.
  const guest = early[0].state.candidates.find(c => c.owner === 'S07').singers.find(p => p.key === 'S05');
  assert.equal(guest.roundMember, true);
  assert.equal(guest.roundApps, 0);
  assert.equal(guest.debt, true);
  assert.ok(res.analysis.debts.some(x => x.borrowedIds.includes('S05')), 'dette de S05 notée');
});

test('rejeu libre sans Timefold : une attente pour chacun des 56 titres chantés', async () => {
  const res = await rejeu.runFree(ev);
  assert.equal(res.passages.length, 56);
  for (const p of res.passages) assert.ok(Number.isInteger(p.waitSec) && p.waitSec >= 0, `${p.entryId} ${p.waitSec}`);
  assert.deepEqual(res.fidelity.notSungInReplay, []);
  assert.equal(new Set(res.passages.map(p => p.entryId)).size, 56);
  assert.ok(res.waits.replay.n === 56 && res.waits.replay.maxMin > 0);
});

test('CLI : rejeu libre, résumé, trace et JSON', async t => {
  const lines = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const json = path.join(dir, 'rejeu.json');
  const code = await rejeu.main([FIXTURE, '--libre', '--court', '--trace', '21:39', '--json', json,
    '--option', 'spacingSongs=2'], l => lines.push(l));
  assert.equal(code, 0);
  const text = lines.join('\n');
  assert.match(text, /^REJEU LIBRE \[sans Timefold\] options spacingSongs=2/);
  assert.match(text, /Attentes anormales/);
  assert.match(text, /── à l'envoi/);
  assert.equal(JSON.parse(fs.readFileSync(json, 'utf8')).passages.length, 56);
  const usage = [];
  assert.equal(await rejeu.main(['--option', 'sans-egal'], l => usage.push(l)), 2);
  assert.match(usage.join('\n'), /--libre/);
});

test('CLI : rejeu forcé en processus séparé', () => {
  const out = require('node:child_process').execFileSync(process.execPath,
    [path.join(__dirname, 'rejeu-soiree.js'), FIXTURE, '--court'], { encoding: 'utf8' });
  assert.match(out, /^REJEU FORCÉ \[sans Timefold\]\nFidélité : \d+\/56 envois/);
});

test('CLI : erreur d’utilisation en une ligne, sans trace', async t => {
  const run = async argv => {
    const out = [], err = [];
    const code = await rejeu.main(argv, l => out.push(l), l => err.push(l));
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const missing = await run([path.join(os.tmpdir(), 'pas-de-soiree.json'), '--court']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /^Export de soirée introuvable ou illisible : .*pas-de-soiree\.json \(ENOENT\)$/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'vide.json'), '{}');
  fs.writeFileSync(path.join(dir, 'casse.json'), '{"events": [');
  assert.match((await run([path.join(dir, 'vide.json')])).err, /^Export de soirée illisible : pas de liste « events »\.$/);
  assert.match((await run([path.join(dir, 'casse.json')])).err, /^Export de soirée illisible : .*casse\.json n'est pas du JSON/);
  const jar = await run([FIXTURE, '--solveur', path.join(dir, 'absent.jar')]);
  assert.equal(jar.code, 1);
  assert.match(jar.err, /^Jar Timefold introuvable : .*absent\.jar$/);
  const ref = await run([FIXTURE, '--avant', 'pas-une-revision-0000']);
  assert.equal(ref.code, 1);
  assert.match(ref.err, /^--avant : « pas-une-revision-0000 » n'est ni un dossier ni une révision git de ce dépôt\.$/);
  for (const r of [missing, jar, ref]) assert.doesNotMatch(r.err, /\n\s+at /);
  // Options mal assorties : aide et code 2.
  assert.equal((await run([FIXTURE, '--solveur-avant', 'x.jar'])).code, 2);
  assert.equal((await run([FIXTURE, '--avant', '.', '--solveur-avant', 'x.jar'])).code, 2);
  assert.equal((await run([FIXTURE, '--avant', '.', '--trace', '21:39'])).code, 2);
  assert.equal((await run([FIXTURE, '--avant'])).code, 2);
  // --json sans nom de fichier : l'option suivante n'est pas prise pour lui.
  assert.throws(() => rejeu.parseArgs([FIXTURE, '--json', '--cles']), /--json attend une valeur/);
  assert.throws(() => rejeu.parseArgs([FIXTURE, '--trace', '--court']), /--trace attend une valeur/);
  // Extrait d'un JSON abîmé cité dans l'erreur : sans séquence d'échappement.
  fs.writeFileSync(path.join(dir, 'echap.json'), '{"events": [\u001b[2J\u202e');
  assert.doesNotMatch((await run([path.join(dir, 'echap.json')])).err, /[\u001b\u202e]/);
  // Ce qu'apporte Timefold : même code, sans puis avec.
  const o = rejeu.parseArgs([FIXTURE, '--avant', '.', '--solveur', '--solveur-avant', 'sans']);
  assert.deepEqual([o.before, o.solver, o.solverBefore], ['.', true, 'sans']);
  // Effort de Timefold : mouvements (0 = temps seul), plafond de temps borné.
  assert.deepEqual([o.moves, o.budget], [null, null]);
  assert.deepEqual(['moves', 'budget'].map(k => rejeu.parseArgs([FIXTURE, '--mouvements', '0', '--budget', '3000'])[k]), [0, 3000]);
  assert.throws(() => rejeu.parseArgs([FIXTURE, '--mouvements', '1.5']), /--mouvements attend un nombre entier/);
  assert.throws(() => rejeu.parseArgs([FIXTURE, '--mouvements', '--court']), /--mouvements attend une valeur/);
  assert.throws(() => rejeu.parseArgs([FIXTURE, '--budget', '60000']), /--budget attend un nombre de millisecondes de 100 à 30000/);
  // Valeur vide (variable du shell vide), décimale ou trop grande : refusée.
  for (const v of ['', ' ', '2500.5', '1e4']) assert.throws(() => rejeu.parseArgs([FIXTURE, '--budget', v]), /--budget attend/, v);
  for (const v of ['', '1e19', '1000000001', '-1']) assert.throws(() => rejeu.parseArgs([FIXTURE, '--mouvements', v]), /--mouvements attend/, v);
});

test('bilan avant/après : même code des deux côtés, tout est égal', async () => {
  const cmp = await rejeu.runCompare(ev, { before: { code: path.join(__dirname, '..') } });
  const free = await rejeu.runFree(ev);
  assert.deepEqual(cmp.after.passages.map(p => [p.entryId, p.waitSec]), free.passages.map(p => [p.entryId, p.waitSec]));
  assert.deepEqual(cmp.before.passages.map(p => [p.entryId, p.waitSec]), free.passages.map(p => [p.entryId, p.waitSec]));
  const text = rejeu.compareReport(cmp);
  assert.match(text, /^BILAN AVANT \/ APRÈS/);
  assert.match(text, /indice de Jain \(1 = même rythme pour tous\)\s+0,784\s+\S+\s+\S+\s+=/);
  assert.doesNotMatch(text, /MOINS BIEN|  mieux/);
  assert.match(text, /Personnes qui y perdent .* : personne\nPersonnes qui y gagnent : personne/);
  assert.match(text, /Verdict : 0 indicateur mieux, 0 moins bien, 18 égaux/);
  assert.match(text, /Titres dont l'attente change de 5 min ou plus \(avant → après\) : aucun/);
});

test('bilan avant/après : une personne qui perd un passage ou attend plus est signalée', async () => {
  const cmp = await rejeu.runCompare(ev, { before: { code: path.join(__dirname, '..') } });
  // Version « après » abîmée à la main : S05 perd un de ses titres (mais gagne
  // un passage en invité), S09 attend 20 min de plus, l'équilibre baisse.
  const after = structuredClone(cmp.after);
  const people = after.balance.replay.people;
  people.S05.turns -= 1;
  people.S05.guestTurns += 1;
  people.S09.waitMaxSec += 1200;
  after.balance.replay.jain = Math.round((cmp.after.balance.replay.jain - 0.05) * 1000) / 1000;
  const p = after.passages.find(x => x.owner === 'S09');
  p.waitSec += 1200;
  // Un titre chanté seulement « avant » (le plus grave, en tête de liste) et
  // une personne qui y gagne.
  const lost = after.passages.pop();
  people.S01.waitMaxSec -= 1200;
  const text = rejeu.compareReport({ ...cmp, after });
  const titles = text.split('Titres dont l\'attente change')[1].split('\n');
  assert.match(titles[1], new RegExp(`→ pas chanté  .*«${lost.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}»`));
  assert.match(text.split('Personnes qui y gagnent')[1], /^ : \n {2}S01 : /);
  assert.match(text, /indice de Jain \(1 = même rythme pour tous\)\s+0,784\s+\S+\s+\S+\s+MOINS BIEN/);
  const losers = text.split('Personnes qui y perdent')[1].split('Personnes qui y gagnent')[0];
  assert.match(losers, /\n {2}S05 : titres (\d+) → (?!\1)\d+ \(invité (\d+) → (?!\2)\d+\)/);
  assert.match(losers, /\n {2}S09 : .*plus longue attente d'un titre \d+ → \d+ min/);
  assert.match(text, /Verdict : .*1 moins bien.*2 personnes y perdent, 1 y gagne\./);
  assert.match(text, new RegExp(`→ +${Math.round(p.waitSec / 60)} min  S09`));
  // Note d'un seul côté : marquée avant ou après ; commune aux deux : une fois.
  const noted = rejeu.compareReport({ ...cmp, before: { ...cmp.before, notes: ['21:00:00 commune', '21:01:00 seulement avant'] },
    after: { ...cmp.after, notes: ['21:00:00 commune', '21:02:00 seulement après'] } });
  assert.deepEqual(noted.split('\n').filter(l => l.startsWith('note : ')),
    ['note : 21:00:00 commune', 'note : (avant) 21:01:00 seulement avant', 'note : (après) 21:02:00 seulement après']);
  // Jamais passé « avant », un titre « après » (avec son attente) : y gagne.
  const before = structuredClone(cmp.before);
  Object.assign(before.balance.replay.people.S02, { appearances: 0, turns: 0, waitMaxSec: null, stageMaxSec: null, fairRatio: 0 });
  const gained = rejeu.compareReport({ ...cmp, before });
  assert.match(gained.split('Personnes qui y gagnent')[1], /\n {2}S02 : titres 0 → \d+/);
  assert.doesNotMatch(gained.split('Personnes qui y perdent')[1].split('Personnes qui y gagnent')[0], /S02/);
  // Un titre de plus, mais 40 min de plus sans monter sur scène : y perd quand même.
  const longer = structuredClone(cmp.after);
  longer.balance.replay.people.S03.turns += 1;
  longer.balance.replay.people.S03.stageMaxSec += 2400;
  const mixed = rejeu.compareReport({ ...cmp, after: longer });
  assert.match(mixed.split('Personnes qui y perdent')[1].split('Personnes qui y gagnent')[0], /\n {2}S03 : titres (\d+) → (?!\1)\d+/);
  // S13, seulement invitée, ne monte plus du tout sur scène : y perd.
  const noStage = structuredClone(cmp.after);
  assert.equal(cmp.after.balance.replay.people.S13.turns, 0);
  delete noStage.balance.replay.people.S13;
  const gone = rejeu.compareReport({ ...cmp, after: noStage });
  assert.match(gone.split('Personnes qui y perdent')[1].split('Personnes qui y gagnent')[0], /\n {2}S13 : titres 0 → 0 \(invité 1 → 0\)/);
  // Et l'inverse : monter enfin sur scène, même seulement en invitée, y gagne.
  const noStageBefore = structuredClone(cmp.before);
  delete noStageBefore.balance.replay.people.S13;
  const back = rejeu.compareReport({ ...cmp, before: noStageBefore });
  assert.match(back.split('Personnes qui y gagnent')[1], /\n {2}S13 : titres 0 → 0 \(invité 0 → 1\)/);
});

test('rejeu libre : « remplacer » ne retire que les titres que la soirée a remplacés', async () => {
  const base = await rejeu.runFree(ev);
  // Titre chanté plus tard dans le rejeu que dans la soirée : juste après son
  // passage réel, sa chanteuse choisit un titre en « remplacer », sa liste réelle
  // étant vide (rien de remplacé). Le rejeu doit garder le titre pas encore chanté.
  const replayed = new Map(base.passages.map(p => [p.entryId, p]));
  const a = ev.realPassages.find(p => p.source === 'queue' && p.ids.length === 1 && replayed.get(p.entryId)?.start > p.end + 300000);
  assert.ok(a, 'titre chanté plus tard dans le rejeu');
  const raw = structuredClone(ev.raw);
  adder(raw.events)(a.start + 60000, 'song.requested',
    { personId: a.ids[0], entryId: 'remplacant', songId: 999999, title: 'Remplaçant', durationSec: 200, mode: 'replace', replacedEntryIds: [] });
  const res = await rejeu.runFree(rejeu.loadEvening(raw));
  assert.ok(res.passages.some(p => p.entryId === a.entryId), 'titre gardé et chanté');
  assert.ok(res.passages.some(p => p.entryId === 'remplacant'));
  assert.ok(res.notes.some(n => /remplacement de .* : \d+ titre\(s\) pas encore chanté\(s\) dans le rejeu gardé\(s\)/.test(n)));
});

test('rejeu libre : « remplacer » garde un duo à sa place ; même chanson redemandée chantée une fois ; lignes illisibles ou en double', async () => {
  // En réel : duo a1 de S01 avec S03 (même table) chanté d'abord ; pendant ce
  // passage, S01 remplace b1 par c1. Le rejeu fait passer S02 d'abord : a1
  // reste à chanter au moment du « remplacer ».
  const T0 = Date.UTC(2026, 9, 15, 19, 0);
  const evening = second => {
    const events = [];
    const e = (sec, ev, fields = {}) => events.push({ v: 1, seq: events.length + 1, t: T0 + sec * 1000, ev, ...fields });
    e(0, 'evening.started', { rules: {} });
    e(0, 'table.opened', { tableId: 'T1' }); e(0, 'table.opened', { tableId: 'T2' });
    e(0, 'person.joined', { personId: 'S01', tableId: 'T1' });
    e(0, 'person.joined', { personId: 'S02', tableId: 'T2' });
    e(0, 'person.joined', { personId: 'S03', tableId: 'T1' });
    e(1, 'song.requested', { personId: 'S02', entryId: 'x1', songId: 3, title: 'x1', mode: 'append' });
    e(2, 'song.requested', { personId: 'S01', entryId: 'a1', songId: 1, title: 'a1', mode: 'append' });
    e(2, 'duo.invited', { personId: 'S01', ownerId: 'S01', partnerId: 'S03', entryId: 'a1', sameGroup: true });
    e(3, 'song.requested', { personId: 'S01', entryId: 'b1', songId: 2, title: 'b1', mode: 'append' });
    e(5, 'turn.sent', { entryId: 'a1', ownerId: 'S01', ids: ['S01', 'S03'], queueId: 'q1' });
    e(10, 'stage.started', { entryId: 'a1', ids: ['S01', 'S03'], queueId: 'q1', source: 'queue', title: 'a1' });
    e(50, 'song.requested', { personId: 'S01', entryId: 'c1', songId: second, title: 'c1', mode: 'replace', replacedEntryIds: ['b1'] });
    e(190, 'stage.ended', { queueId: 'q1', playedSec: 180 });
    e(195, 'turn.sent', { entryId: 'x1', ownerId: 'S02', ids: ['S02'], queueId: 'q2' });
    e(200, 'stage.started', { entryId: 'x1', ids: ['S02'], queueId: 'q2', source: 'queue', title: 'x1' });
    e(380, 'stage.ended', { queueId: 'q2', playedSec: 180 });
    e(385, 'turn.sent', { entryId: 'c1', ownerId: 'S01', ids: ['S01'], queueId: 'q3' });
    e(390, 'stage.started', { entryId: 'c1', ids: ['S01'], queueId: 'q3', source: 'queue', title: 'c1' });
    e(570, 'stage.ended', { queueId: 'q3', playedSec: 180 });
    return { people: ['S01', 'S02', 'S03'].map((key, i) => ({ key, table: i === 1 ? 'T2' : 'T1' })),
      tables: [{ key: 'T1' }, { key: 'T2' }], events };
  };
  const res = await rejeu.runFree(rejeu.loadEvening(evening(4)));
  assert.deepEqual(res.passages.map(p => [p.entryId, p.ids.join('+')]), [['x1', 'S02'], ['a1', 'S01+S03'], ['c1', 'S01']]);
  assert.equal(res.balance.replay.people.S03.guestTurns, 1);
  assert.deepEqual(res.warnings, []);
  // c1 est la chanson de a1 : le nouveau titre en est la suite, chantée une
  // fois ; le passage revient à a1 (pas de « demande non rejouée »).
  const same = await rejeu.runFree(rejeu.loadEvening(evening(1)));
  assert.deepEqual(same.passages.map(p => p.entryId), ['x1', 'a1']);
  // a1 était un duo : c1, la même chanson, le reprend (l'invitée a chanté en réel).
  const sung = same.passages.find(p => p.entryId === 'a1');
  assert.deepEqual(sung.ids, ['S01', 'S03']);
  assert.equal(same.balance.replay.people.S03?.guestTurns, 1);
  // Le journal rejoué le sait aussi : l'invitée attend depuis qu'elle a
  // accepté le duo (2 s), pas depuis le « remplacer » (50 s).
  assert.ok(same.balance.replay.people.S03.stageMaxSec >= Math.round((sung.start - T0) / 1000) - 3,
    JSON.stringify({ start: (sung.start - T0) / 1000, S03: same.balance.replay.people.S03 }));
  assert.ok(sung.waitSec > 0);
  assert.ok(same.notes.some(n => /remplacement de S01 : « a1 » redemandé avant d'être chanté dans le rejeu, chanté une fois/.test(n)));
  assert.deepEqual(same.warnings, ['le rejeu chante 2 titres de la file, la soirée 3']);
  // Le journal rejoué retire aussi a1 : plus aucun titre en attente pour S01
  // (sinon evening-stats.js le compterait prêt jusqu'à la fin).
  const es = require('../evening-stats');
  const computed = [];
  const original = es.computeStats;
  es.computeStats = (...a) => { const r = original(...a); if (a[0].events[0]?.boot === 'rejeu') computed.push(r); return r; };
  try { await rejeu.runFree(rejeu.loadEvening(evening(1))); } finally { es.computeStats = original; }
  assert.ok(computed.length);
  assert.equal(computed.at(-1).singers.find(x => x.id === 'S01').waiting, 0);
  // c1 retiré ensuite par S01 (52 s), avant son envoi dans le rejeu : rien n'est
  // chanté pour S01, et le journal rejoué retire a1, le titre que le rejeu
  // gardait (geste redirigé), pas c1.
  const removed = evening(1);
  removed.events.push({ v: 1, seq: 99, t: T0 + 52000, ev: 'song.removed', personId: 'S01', entryId: 'c1', by: 'self' });
  removed.events.sort((a, b) => a.t - b.t || a.seq - b.seq).forEach((x, i) => { x.seq = i + 1; });
  let journal = [];
  es.computeStats = (...a) => { if (a[0].events[0]?.boot === 'rejeu') journal = a[0].events; return original(...a); };
  let gone;
  try { gone = await rejeu.runFree(rejeu.loadEvening(removed)); } finally { es.computeStats = original; }
  assert.deepEqual(gone.passages.map(p => p.entryId), ['x1']);
  assert.deepEqual(journal.filter(x => x.ev === 'song.removed').map(x => x.entryId), ['c1', 'a1']);
  // c1 reprend la chanson de b1, le titre remplacé (le « remplacer » du bar
  // l'accepte) : b1 part, c1 est chanté, a1 gardé, sans avertissement.
  const sameReplaced = await rejeu.runFree(rejeu.loadEvening(evening(2)));
  assert.deepEqual(sameReplaced.passages.map(p => p.entryId), ['x1', 'a1', 'c1']);
  assert.deepEqual(sameReplaced.warnings, []);
  // Demande invalide : rien n'est retiré, b1 reste chanté ; demande hors du journal.
  const invalid = await rejeu.runFree(rejeu.loadEvening(evening(0)));
  assert.deepEqual(invalid.passages.map(p => p.entryId), ['x1', 'a1', 'b1']);
  assert.deepEqual(invalid.warnings, ['1 demande de titre non rejouée (voir les notes)']);
  // Rejeu arrêté par la limite d'étapes : dit.
  const cut = await rejeu.runFree(rejeu.loadEvening(evening(4)), { maxSteps: 3 });
  assert.ok(cut.warnings.some(w => /^rejeu arrêté à \S+ après 3 étapes : la fin de la soirée manque$/.test(w)), cut.warnings.join(' | '));
  // Ligne d'une autre version et ligne en double (arrêt brutal) : la première
  // est signalée dans le bilan, la seconde ignorée comme dans evening-stats.js.
  const raw = evening(4);
  raw.events.push({ v: 2, seq: 99, t: T0 + 600000, ev: 'futur.geste' }, { ...raw.events.find(x => x.ev === 'person.joined') });
  assert.equal(rejeu.loadEvening(raw).events.length, evening(4).events.length);
  const cmp = await rejeu.runCompare(rejeu.loadEvening(raw), { before: { code: path.join(__dirname, '..') } });
  assert.deepEqual(cmp.after.passages.map(p => p.entryId), ['x1', 'a1', 'c1']);
  assert.match(rejeu.compareReport(cmp), /\névénements illisibles ou d’une autre version : futur\.geste×1/);
});

test('rejeu libre : invitée qui quitte un duo déjà chanté dans le rejeu, geste hors du journal', async () => {
  // En réel : x1 (S02), puis pendant y1 (S04) S03 quitte le duo a1 de S01 (même
  // table), chanté ensuite en solo. Le rejeu chante a1 en duo juste après x1 :
  // au départ réel, a1 est sur scène, le geste ne peut pas être refait et ne
  // doit pas retirer S03 du passage rejoué (ni de la scène dans le bilan).
  const T0 = Date.UTC(2026, 9, 15, 19, 0);
  const events = [];
  const e = (sec, ev, fields = {}) => events.push({ v: 1, seq: events.length + 1, t: T0 + sec * 1000, ev, ...fields });
  e(0, 'evening.started', { rules: {} });
  e(0, 'table.opened', { tableId: 'T1' }); e(0, 'table.opened', { tableId: 'T2' });
  for (const [key, tableId] of [['S01', 'T1'], ['S02', 'T2'], ['S03', 'T1'], ['S04', 'T2']]) e(0, 'person.joined', { personId: key, tableId });
  e(1, 'song.requested', { personId: 'S02', entryId: 'x1', songId: 3, title: 'x1', mode: 'append' });
  e(2, 'song.requested', { personId: 'S01', entryId: 'a1', songId: 1, title: 'a1', mode: 'append' });
  e(2, 'duo.invited', { personId: 'S01', ownerId: 'S01', partnerId: 'S03', entryId: 'a1', sameGroup: true });
  e(3, 'song.requested', { personId: 'S04', entryId: 'y1', songId: 2, title: 'y1', mode: 'append' });
  // Demande d'une personne jamais inscrite : la note la nomme.
  e(4, 'song.requested', { personId: 'S99', entryId: 'z9', songId: 9, title: 'z9', mode: 'append' });
  const stage = (sec, id, ids, q) => {
    e(sec - 5, 'turn.sent', { entryId: id, ownerId: ids[0], ids, queueId: q });
    e(sec, 'stage.started', { entryId: id, ids, queueId: q, source: 'queue', title: id });
    e(sec + 180, 'stage.ended', { queueId: q, playedSec: 180 });
  };
  stage(10, 'x1', ['S02'], 'q1');
  stage(200, 'y1', ['S04'], 'q2');
  e(250, 'duo.left', { guestId: 'S03', ownerId: 'S01', entryId: 'a1', sent: false });
  stage(400, 'a1', ['S01'], 'q3');
  events.sort((a, b) => a.t - b.t || a.seq - b.seq).forEach((x, i) => { x.seq = i + 1; });
  const raw = { people: ['S01', 'S02', 'S03', 'S04'].map(key => ({ key, table: ['S02', 'S04'].includes(key) ? 'T2' : 'T1' })),
    tables: [{ key: 'T1' }, { key: 'T2' }], events };
  const res = await rejeu.runFree(rejeu.loadEvening(raw));
  const a1 = res.passages.find(p => p.entryId === 'a1');
  assert.deepEqual(a1.ids, ['S01', 'S03']);
  assert.ok(a1.start < T0 + 250000 && a1.end > T0 + 250000, 'duo sur scène au départ réel de S03');
  assert.ok(res.notes.some(n => /duo\.left non rejoué : Duo introuvable\. S03 a1$/.test(n)), res.notes.join(' | '));
  assert.ok(res.notes.some(n => /song\.requested non rejoué : personne inconnue S99 z9$/.test(n)), res.notes.join(' | '));
  assert.equal(res.balance.replay.people.S03.guestTurns, 1);
  assert.equal(res.balance.real.people.S03?.guestTurns ?? 0, 0);
});

test('rejeu libre : départ ou duo quitté pendant qu’un titre est envoyé dans le rejeu, comme le serveur', async () => {
  // Le rejeu envoie y1 (S02) pendant x1 ; en réel, S02 part pendant x1, y1
  // n'ayant jamais été envoyé. Départ noté par le bar (personne ou table) :
  // le serveur retire le titre envoyé et rend le passage. « Je pars » tapé
  // par la personne : le serveur ne touche pas aux titres envoyés.
  const T0 = Date.UTC(2026, 9, 15, 19, 0);
  const evening = (sec, ev, fields) => {
    const events = [];
    const e = (t, name, f = {}) => events.push({ v: 1, seq: events.length + 1, t: T0 + t * 1000, ev: name, ...f });
    e(0, 'evening.started', { rules: {} });
    e(0, 'table.opened', { tableId: 'T1' }); e(0, 'table.opened', { tableId: 'T2' });
    for (const [key, tableId] of [['S01', 'T1'], ['S02', 'T2'], ['S03', 'T1'], ['S04', 'T2']]) e(0, 'person.joined', { personId: key, tableId });
    const stage = (t, id, ids, q) => {
      e(t - 5, 'turn.sent', { entryId: id, ownerId: ids[0], ids, queueId: q });
      e(t, 'stage.started', { entryId: id, ids, queueId: q, source: 'queue', title: id });
      e(t + 180, 'stage.ended', { queueId: q, playedSec: 180 });
    };
    return { e, stage, done: () => {
      e(sec, ev, fields);
      events.sort((a, b) => a.t - b.t || a.seq - b.seq).forEach((x, i) => { x.seq = i + 1; });
      return { people: ['S01', 'S02', 'S03', 'S04'].map(key => ({ key, table: ['S02', 'S04'].includes(key) ? 'T2' : 'T1' })),
        tables: [{ key: 'T1' }, { key: 'T2' }], events };
    } };
  };
  const ownerLeaves = (ev, fields) => {
    const b = evening(120, ev, fields);
    b.e(1, 'song.requested', { personId: 'S01', entryId: 'x1', songId: 1, title: 'x1', mode: 'append' });
    b.e(2, 'song.requested', { personId: 'S02', entryId: 'y1', songId: 2, title: 'y1', mode: 'append' });
    b.stage(10, 'x1', ['S01'], 'q1');
    b.e(200, 'song.requested', { personId: 'S01', entryId: 'x2', songId: 3, title: 'x2', mode: 'append' });
    b.stage(210, 'x2', ['S01'], 'q2');
    return rejeu.runFree(rejeu.loadEvening(b.done()));
  };
  const self = await ownerLeaves('person.left', { personId: 'S02', by: 'self', songsDropped: 1 });
  assert.deepEqual(self.passages.map(p => p.entryId), ['x1', 'y1', 'x2']);
  for (const left of [await ownerLeaves('person.left', { personId: 'S02', by: 'staff', songsDropped: 1 }),
    await ownerLeaves('table.left', { tableId: 'T2' })]) {
    assert.deepEqual(left.passages.map(p => p.entryId), ['x1', 'x2']);
    assert.ok(!left.balance.replay.people.S02?.turns);
    assert.ok(left.notes.some(n => /titre envoyé retiré au départ de S02 : « y1 »/.test(n)), left.notes.join(' | '));
  }
  // Duo a1 de S01 avec S03 envoyé dans le rejeu pendant x1 ; en réel, S03
  // quitte le duo (pas encore envoyé) ou est marquée partie par le bar.
  const guestLeaves = (ev, fields) => {
    const b = evening(120, ev, fields);
    b.e(1, 'song.requested', { personId: 'S02', entryId: 'x1', songId: 3, title: 'x1', mode: 'append' });
    b.e(2, 'song.requested', { personId: 'S01', entryId: 'a1', songId: 1, title: 'a1', mode: 'append' });
    b.e(2, 'duo.invited', { personId: 'S01', ownerId: 'S01', partnerId: 'S03', entryId: 'a1', sameGroup: true });
    b.e(3, 'song.requested', { personId: 'S04', entryId: 'y1', songId: 2, title: 'y1', mode: 'append' });
    b.stage(10, 'x1', ['S02'], 'q1');
    b.stage(200, 'y1', ['S04'], 'q2');
    b.stage(400, 'a1', ['S01'], 'q3');
    return rejeu.runFree(rejeu.loadEvening(b.done()));
  };
  // « Chanter seul » ou « Annuler duo » de l'auteur sur un duo encore en
  // liste en réel (duo.cancelled) : le duo envoyé dans le rejeu part en solo.
  for (const res of [await guestLeaves('duo.left', { guestId: 'S03', ownerId: 'S01', entryId: 'a1', sent: false }),
    await guestLeaves('person.left', { personId: 'S03', by: 'staff', songsDropped: 0 }),
    await guestLeaves('duo.cancelled', { personId: 'S01', ownerId: 'S01', partnerId: 'S03', entryId: 'a1' })]) {
    const a1 = res.passages.find(p => p.entryId === 'a1');
    assert.ok(a1.sentAt < T0 + 120000 && a1.start > T0 + 120000, 'duo envoyé dans le rejeu avant le geste réel');
    assert.deepEqual(a1.ids, ['S01']);
    assert.ok(!res.balance.replay.people.S03?.guestTurns);
    assert.ok(!res.notes.some(n => /non rejoué/.test(n)), res.notes.join(' | '));
  }
});

test('rejeu forcé : invitée qui quitte un duo déjà dans KaraFun ; export lu dans l’ordre des heures', async () => {
  // Duo a1 de S01 avec S03 (autre table, accepté), envoyé à 21:03:15 ; S03 se
  // retire à 21:03:17 (sent: true), a1 chanté en solo, puis z1 de S03. Comme
  // au serveur (leaveSentDuo), S03 ne compte pas dans le tour : z1 est le choix
  // de l'ordonnanceur, sans passage forcé.
  const T0 = Date.UTC(2026, 9, 15, 19, 0);
  const events = [];
  const e = (t, name, f = {}) => events.push({ v: 1, seq: events.length + 1, t: T0 + t * 1000, ev: name, ...f });
  e(0, 'evening.started', { rules: {} });
  for (const t of ['T1', 'T2', 'T3']) e(0, 'table.opened', { tableId: t });
  for (const [k, t] of [['S01', 'T1'], ['S02', 'T2'], ['S03', 'T3'], ['S04', 'T2']]) e(0, 'person.joined', { personId: k, tableId: t });
  e(1, 'song.requested', { personId: 'S02', entryId: 'x1', songId: 3, title: 'x1', mode: 'append' });
  e(2, 'song.requested', { personId: 'S01', entryId: 'a1', songId: 1, title: 'a1', mode: 'append' });
  e(2, 'duo.invited', { personId: 'S01', ownerId: 'S01', partnerId: 'S03', entryId: 'a1', sameGroup: false });
  e(2.5, 'duo.answered', { personId: 'S03', partnerId: 'S03', ownerId: 'S01', entryId: 'a1', accepted: true });
  e(3, 'song.requested', { personId: 'S02', entryId: 'x2', songId: 2, title: 'x2', mode: 'append' });
  e(3, 'song.requested', { personId: 'S01', entryId: 'a2', songId: 5, title: 'a2', mode: 'append' });
  e(4, 'song.requested', { personId: 'S03', entryId: 'z1', songId: 4, title: 'z1', mode: 'append' });
  const stage = (t, id, ids, q) => {
    e(t - 5, 'turn.sent', { entryId: id, ownerId: ids[0], ids, queueId: q });
    e(t, 'stage.started', { entryId: id, ids, queueId: q, source: 'queue', title: id });
    e(t + 180, 'stage.ended', { queueId: q, playedSec: 180 });
  };
  stage(10, 'x1', ['S02'], 'q1');
  e(195, 'turn.sent', { entryId: 'a1', ownerId: 'S01', ids: ['S01', 'S03'], queueId: 'q2' });
  e(197, 'duo.left', { ownerId: 'S01', guestId: 'S03', entryId: 'a1', sent: true, by: 'guest' });
  e(200, 'stage.started', { entryId: 'a1', ids: ['S01'], queueId: 'q2', source: 'queue', title: 'a1' });
  e(380, 'stage.ended', { queueId: 'q2', playedSec: 180 });
  stage(400, 'z1', ['S03'], 'q3');
  stage(600, 'x2', ['S02'], 'q4');
  stage(800, 'a2', ['S01'], 'q5');
  const raw = { people: ['S01', 'S02', 'S03', 'S04'].map(key => ({ key })), tables: [{ key: 'T1' }, { key: 'T2' }, { key: 'T3' }], events };
  const res = await rejeu.runForced(rejeu.loadEvening(raw));
  assert.ok(!res.notes.some(n => /non rejoué/.test(n)), res.notes.join(' | '));
  const z1 = res.decisions.find(d => d.real.entryId === 'z1');
  assert.equal(z1.match, true, JSON.stringify(z1.pick));
  // Horloge du PC qui recule : les numéros d'ordre ne suivent plus les heures.
  // L'export est lu dans l'ordre des heures, comme evening-stats.js.
  const jumped = structuredClone(raw);
  const late = jumped.events.find(x => x.ev === 'song.requested' && x.entryId === 'z1');
  late.seq = 1000;
  const order = rejeu.loadEvening(jumped).events.map(x => x.t);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('rejeu forcé : départ noté par le bar pendant qu’un titre est envoyé', async () => {
  // a1 de S01 (duo avec S03 d'une autre table, accepté) envoyé à 21:03:15 ; à
  // 21:03:17 le bar note le départ de l'auteur ou de l'invitée. Comme au
  // serveur : titre retiré et passage rendu, ou duo chanté en solo.
  const T0 = Date.UTC(2026, 9, 15, 19, 0);
  const run = async (who, ids) => {
    const events = [];
    const e = (t, name, f = {}) => events.push({ v: 1, seq: events.length + 1, t: T0 + t * 1000, ev: name, ...f });
    e(0, 'evening.started', { rules: {} });
    for (const t of ['T1', 'T2', 'T3']) e(0, 'table.opened', { tableId: t });
    for (const [k, t] of [['S01', 'T1'], ['S02', 'T2'], ['S03', 'T3']]) e(0, 'person.joined', { personId: k, tableId: t });
    e(1, 'song.requested', { personId: 'S02', entryId: 'x1', songId: 3, title: 'x1', mode: 'append' });
    e(2, 'song.requested', { personId: 'S01', entryId: 'a1', songId: 1, title: 'a1', mode: 'append' });
    e(2, 'duo.invited', { personId: 'S01', ownerId: 'S01', partnerId: 'S03', entryId: 'a1', sameGroup: false });
    e(2.5, 'duo.answered', { personId: 'S03', partnerId: 'S03', ownerId: 'S01', entryId: 'a1', accepted: true });
    e(4, 'song.requested', { personId: 'S02', entryId: 'x2', songId: 2, title: 'x2', mode: 'append' });
    const stage = (t, id, sids, q) => {
      e(t - 5, 'turn.sent', { entryId: id, ownerId: sids[0], ids: sids, queueId: q });
      e(t, 'stage.started', { entryId: id, ids: sids, queueId: q, source: 'queue', title: id });
      e(t + 180, 'stage.ended', { queueId: q, playedSec: 180 });
    };
    stage(10, 'x1', ['S02'], 'q1');
    e(195, 'turn.sent', { entryId: 'a1', ownerId: 'S01', ids: ['S01', 'S03'], queueId: 'q2' });
    e(197, 'person.left', { personId: who, by: 'staff', songsDropped: 0 });
    if (ids) {
      e(200, 'stage.started', { entryId: 'a1', ids, queueId: 'q2', source: 'queue', title: 'a1' });
      e(380, 'stage.ended', { queueId: 'q2', playedSec: 180 });
    }
    stage(600, 'x2', ['S02'], 'q3');
    return rejeu.runForced(rejeu.loadEvening({ people: ['S01', 'S02', 'S03'].map(key => ({ key })),
      tables: ['T1', 'T2', 'T3'].map(key => ({ key })), events }));
  };
  const owner = await run('S01', null);
  assert.ok(owner.notes.some(n => /titre envoyé retiré au départ de S01 : « a1 »/.test(n)), owner.notes.join(' | '));
  assert.ok(!owner.passages.some(p => p.entryId === 'a1'));
  assert.equal(owner.decisions.find(d => d.real.entryId === 'x2')?.match, true);
  const guest = await run('S03', ['S01']);
  assert.deepEqual(guest.passages.find(p => p.entryId === 'a1')?.ids, ['S01']);
  assert.ok(!guest.notes.some(n => /non rejoué|titre envoyé retiré/.test(n)), guest.notes.join(' | '));
  assert.equal(guest.decisions.find(d => d.real.entryId === 'x2')?.match, true);
});

test('rejeu libre : heure de fermeture comme le serveur ; chanson redemandée en « ajouter » avant d’être chantée dans le rejeu', async () => {
  const T0 = Date.UTC(2026, 9, 15, 19, 0);
  const build = (fill, sort = true) => {
    const events = [];
    const e = (t, name, f = {}) => events.push({ v: 1, seq: events.length + 1, t: T0 + t * 1000, ev: name, ...f });
    e(0, 'evening.started', { rules: {} });
    e(0, 'table.opened', { tableId: 'T1' }); e(0, 'table.opened', { tableId: 'T2' });
    e(0, 'person.joined', { personId: 'S01', tableId: 'T1' });
    e(0, 'person.joined', { personId: 'S02', tableId: 'T2' });
    const stage = (t, id, ids, q) => {
      e(t - 5, 'turn.sent', { entryId: id, ownerId: ids[0], ids, queueId: q });
      e(t, 'stage.started', { entryId: id, ids, queueId: q, source: 'queue', title: id });
      e(t + 180, 'stage.ended', { queueId: q, playedSec: 180 });
    };
    fill(e, stage);
    if (sort) events.sort((a, b) => a.t - b.t || a.seq - b.seq).forEach((x, i) => { x.seq = i + 1; });
    return { people: [{ key: 'S01', table: 'T1' }, { key: 'S02', table: 'T2' }], tables: [{ key: 'T1' }, { key: 'T2' }], events };
  };
  // x1 puis y1 chantés ; x2 demandé, jamais chanté : la fermeture (à 400 s)
  // tombe avant la moitié de x2. Le serveur ne l'envoie pas.
  const closing = (setAt, closingAt) => build((e, stage) => {
    e(1, 'song.requested', { personId: 'S01', entryId: 'x1', songId: 1, title: 'x1', mode: 'append' });
    e(2, 'song.requested', { personId: 'S02', entryId: 'y1', songId: 2, title: 'y1', mode: 'append' });
    e(3, 'song.requested', { personId: 'S01', entryId: 'x2', songId: 3, title: 'x2', mode: 'append' });
    e(setAt, 'closing.set', { closingAt: T0 + closingAt * 1000 });
    stage(10, 'x1', ['S01'], 'q1');
    stage(200, 'y1', ['S02'], 'q2');
  });
  const held = await rejeu.runFree(rejeu.loadEvening(closing(5, 400)));
  assert.deepEqual(held.passages.map(p => p.entryId), ['x1', 'y1']);
  // Fermeture notée après l'envoi de x2 dans le rejeu : retiré de KaraFun,
  // il revient dans la liste de son auteur et n'est pas chanté.
  const pulled = await rejeu.runFree(rejeu.loadEvening(closing(250, 420)));
  assert.deepEqual(pulled.passages.map(p => p.entryId), ['x1', 'y1']);
  assert.ok(pulled.notes.some(n => /titre envoyé retiré à la fermeture, rendu à S01 : « x2 »/.test(n)), pulled.notes.join(' | '));
  // En réel, a1 de S01 passe en premier ; pendant a1, S01 redemande la même
  // chanson en « ajouter » (a2). Le rejeu fait passer y1 d'abord : à cette
  // heure, a1 est encore dans la liste. La demande attend que a1 parte.
  const again = build((e, stage) => {
    e(1, 'song.requested', { personId: 'S02', entryId: 'y1', songId: 2, title: 'y1', mode: 'append' });
    e(2, 'song.requested', { personId: 'S01', entryId: 'a1', songId: 1, title: 'a1', mode: 'append' });
    stage(10, 'a1', ['S01'], 'q1');
    e(30, 'song.requested', { personId: 'S01', entryId: 'a2', songId: 1, title: 'a1', mode: 'append' });
    stage(200, 'y1', ['S02'], 'q2');
    stage(400, 'a2', ['S01'], 'q3');
  });
  const res = await rejeu.runFree(rejeu.loadEvening(again));
  assert.deepEqual(res.passages.map(p => p.entryId).sort(), ['a1', 'a2', 'y1']);
  assert.deepEqual(res.warnings, []);
  assert.ok(res.notes.some(n => /demande de S01 « a1 » différée/.test(n)), res.notes.join(' | '));
  // Demande différée puis retirée, ou auteur parti, avant que a1 parte (envoyé
  // à 55 s dans le rejeu) : jamais faite dans le rejeu, ni chantée, et hors du
  // journal avec ses gestes.
  const dropped = gesture => build((e, stage) => {
    e(1, 'song.requested', { personId: 'S02', entryId: 'y1', songId: 2, title: 'y1', mode: 'append' });
    e(2, 'song.requested', { personId: 'S01', entryId: 'a1', songId: 1, title: 'a1', mode: 'append' });
    stage(10, 'a1', ['S01'], 'q1');
    e(30, 'song.requested', { personId: 'S01', entryId: 'a2', songId: 1, title: 'a1', mode: 'append' });
    e(40, 'song.settings', { personId: 'S01', entryId: 'a2', settings: { key: 1 } });
    gesture(e);
    stage(200, 'y1', ['S02'], 'q2');
  });
  const removed = await rejeu.runFree(rejeu.loadEvening(dropped(e => e(45, 'song.removed', { personId: 'S01', entryId: 'a2' }))));
  assert.deepEqual(removed.passages.map(p => p.entryId).sort(), ['a1', 'y1']);
  assert.ok(removed.notes.some(n => /song\.requested non rejoué : titre retiré avant que la même chanson quitte la liste S01 a2/.test(n)),
    removed.notes.join(' | '));
  assert.ok(!removed.notes.some(n => /song\.(settings|removed) non rejoué/.test(n)), removed.notes.join(' | '));
  // « Pas prêt » (non rejoué) sur la demande différée, puis retrait : compté
  // tout de suite parmi les gestes non rejoués, il n'attend pas la demande
  // (abandonnée ensuite).
  const deferred = await rejeu.runFree(rejeu.loadEvening(dropped(e => {
    e(42, 'defer.requested', { ownerId: 'S01', personIds: ['S01'], entryId: 'a2', songs: 1 });
    e(45, 'song.removed', { personId: 'S01', entryId: 'a2' });
  })));
  assert.equal(deferred.notReplayed['defer.requested'], 1);
  const gone = await rejeu.runFree(rejeu.loadEvening(dropped(e => e(45, 'person.left', { personId: 'S01', by: 'self', songsDropped: 2 }))));
  assert.deepEqual(gone.passages.map(p => p.entryId), ['y1']);
  assert.ok(gone.notes.some(n => /song\.requested non rejoué : personne partie avant que la même chanson quitte sa liste S01 a2/.test(n)),
    gone.notes.join(' | '));
  // « Remplacer » réel de la demande différée par b1 : b1 chanté, jamais a2.
  const replaced = await rejeu.runFree(rejeu.loadEvening(dropped(e => {
    e(45, 'song.requested', { personId: 'S01', entryId: 'b1', songId: 7, title: 'b1', mode: 'replace', replacedEntryIds: ['a2'] });
    e(400, 'turn.sent', { entryId: 'b1', ownerId: 'S01', ids: ['S01'], queueId: 'q3' });
  })));
  assert.deepEqual(replaced.passages.map(p => p.entryId).sort(), ['a1', 'b1', 'y1']);
  assert.ok(replaced.notes.some(n => /song\.requested non rejoué : titre remplacé avant que la même chanson quitte la liste S01 a2/.test(n)),
    replaced.notes.join(' | '));
  // Duo différé (autre table) : l'invitation et la réponse réelles attendent
  // la demande, puis le duo est chanté à deux.
  const duet = await rejeu.runFree(rejeu.loadEvening(build((e, stage) => {
    e(1, 'song.requested', { personId: 'S02', entryId: 'y1', songId: 2, title: 'y1', mode: 'append' });
    e(2, 'song.requested', { personId: 'S01', entryId: 'a1', songId: 1, title: 'a1', mode: 'append' });
    stage(10, 'a1', ['S01'], 'q1');
    e(30, 'song.requested', { personId: 'S01', entryId: 'a2', songId: 1, title: 'a1', mode: 'append' });
    e(30, 'duo.invited', { personId: 'S01', ownerId: 'S01', partnerId: 'S02', entryId: 'a2', sameGroup: false });
    e(35, 'duo.answered', { personId: 'S02', partnerId: 'S02', ownerId: 'S01', entryId: 'a2', accepted: true });
    stage(200, 'y1', ['S02'], 'q2');
    stage(400, 'a2', ['S01', 'S02'], 'q3');
  })));
  assert.deepEqual(duet.passages.find(p => p.entryId === 'a2')?.ids, ['S01', 'S02']);
  assert.ok(!duet.notes.some(n => /non rejoué/.test(n)), duet.notes.join(' | '));
  // Fermeture qui retient a1 jusqu'à la fin : a2 n'est jamais fait.
  const stuck = await rejeu.runFree(rejeu.loadEvening(dropped(e => e(20, 'closing.set', { closingAt: T0 + 150000 }))));
  assert.deepEqual(stuck.passages.map(p => p.entryId), ['y1']);
  assert.ok(stuck.notes.some(n => /song\.requested non rejoué : même chanson restée à chanter jusqu'à la fin S01 a2/.test(n)),
    stuck.notes.join(' | '));
});

test('rejeu libre : coupure de l’application, passage repris, plusieurs Battles, demande différée à sa place', async () => {
  const T0 = Date.UTC(2026, 9, 15, 19, 0);
  const build = fill => {
    const events = [];
    const e = (t, name, f = {}) => events.push({ v: 1, seq: events.length + 1, t: T0 + t * 1000, ev: name, ...f });
    e(0, 'evening.started', { rules: {} });
    e(0, 'app.started', { restored: false, offlineMs: 0 });
    for (const t of ['T1', 'T2']) e(0, 'table.opened', { tableId: t });
    for (const [k, t] of [['S01', 'T1'], ['S02', 'T2'], ['S03', 'T1']]) e(0, 'person.joined', { personId: k, tableId: t });
    const stage = (t, id, ids, q, sec = 180) => {
      if (id) e(t - 5, 'turn.sent', { entryId: id, ownerId: ids[0], ids, queueId: q });
      e(t, 'stage.started', id ? { entryId: id, ids, queueId: q, source: 'queue', title: id } : { queueId: q, source: 'battle', ids: [] });
      e(t + sec, 'stage.ended', { queueId: q, playedSec: sec });
    };
    const ask = (t, personId, entryId, songId) => e(t, 'song.requested', { personId, entryId, songId, title: entryId, mode: 'append' });
    fill(e, stage, ask);
    events.sort((a, b) => a.t - b.t || a.seq - b.seq).forEach((x, i) => { x.seq = i + 1; });
    return { people: [['S01', 'T1'], ['S02', 'T2'], ['S03', 'T1']].map(([key, table]) => ({ key, table })),
      tables: [{ key: 'T1' }, { key: 'T2' }], events };
  };
  // Coupure de l'application (PC éteint) de 20 s à 400 s, notée seulement par
  // la durée d'arrêt du redémarrage : rien ne part pendant ce temps.
  const crash = await rejeu.runFree(rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(400, 'app.started', { restored: true, offlineMs: 380000 });
    stage(410, 'y1', ['S02'], 'q2');
  })));
  assert.ok(crash.passages.find(p => p.entryId === 'y1').sentAt >= T0 + 400000, JSON.stringify(crash.passages));
  // Arrêt final de l'application, sans redémarrage : plus rien ne part.
  const stopped = await rejeu.runFree(rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(30, 'app.stopped', { reason: 'stop' });
  })));
  assert.deepEqual(stopped.passages.map(p => p.entryId), ['x1']);
  // Fermeture passée, puis heure retirée par « Options par défaut » : la
  // soirée réelle s'est arrêtée à l'heure (evening-stats.js), x2 n'est
  // jamais chanté.
  const reset = await rejeu.runFree(rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2); ask(3, 'S01', 'x2', 3);
    e(5, 'closing.set', { closingAt: T0 + 400000 });
    stage(10, 'x1', ['S01'], 'q1'); stage(200, 'y1', ['S02'], 'q2');
    e(410, 'closing.cleared', { reason: 'settings-reset' });
  })));
  assert.deepEqual(reset.passages.map(p => p.entryId), ['x1', 'y1']);
  // Ancien export : arrêt et redémarrage notés sans durée d'arrêt.
  const pair = await rejeu.runFree(rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(30, 'app.stopped', { reason: 'stop' });
    e(400, 'app.started', { restored: true });
    stage(410, 'y1', ['S02'], 'q2');
  })));
  assert.ok(pair.passages.find(p => p.entryId === 'y1').sentAt >= T0 + 400000, JSON.stringify(pair.passages));
  // « Relancer depuis le début » par le bar : la copie prolonge le passage,
  // comme dans evening-stats.js (30 s puis 180 s).
  const restarted = build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    e(5, 'turn.sent', { entryId: 'x1', ownerId: 'S01', ids: ['S01'], queueId: 'q1' });
    e(10, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
    e(40, 'stage.ended', { queueId: 'q1', playedSec: 30 });
    e(40, 'stage.restarted', { queueId: 'q1b', entryId: 'x1' });
    ask(100, 'S02', 'y1', 2);
    e(220, 'stage.ended', { queueId: 'q1b', playedSec: 180 });
    stage(230, 'y1', ['S02'], 'q2');
  });
  const restartedEv = rejeu.loadEvening(restarted);
  assert.equal(restartedEv.played.get('x1'), 210);
  assert.equal(restartedEv.startGaps.length, 2);
  // Rejeu forcé : pendant la copie, le titre est toujours sur scène (y1,
  // demandé alors, se réserve comme pendant un titre).
  // Le passage ne finit qu'avec la copie (220 s), mesuré depuis la relance
  // (180 s), comme server.js ; repris sous la même file après un redémarrage,
  // il n'est ni recommencé ni raccourci.
  const { Scheduler } = require('../scheduler');
  const calls = [];
  const spied = async raw => {
    calls.length = 0;
    const undo = ['recordStage', 'recordSlot', 'songEnded'].map(k => {
      let P = Scheduler.prototype;
      while (P && !Object.prototype.hasOwnProperty.call(P, k)) P = Object.getPrototypeOf(P);
      const orig = P[k];
      P[k] = function (...a) { calls.push([k, (Date.now() - T0) / 1000, ...(k === 'recordSlot' ? [a[0]] : [])]); return orig.apply(this, a); };
      return () => { P[k] = orig; };
    });
    try { return await rejeu.runForced(rejeu.loadEvening(raw)); } finally { undo.forEach(f => f()); }
  };
  const forcedRestart = await spied(restarted);
  assert.equal(forcedRestart.decisions.find(d => d.real.entryId === 'y1')?.reservation?.at, T0 + 100000);
  assert.deepEqual(calls.filter(c => c[1] <= 220), [['recordStage', 10], ['recordSlot', 220, 180], ['songEnded', 220]]);
  await spied(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    e(5, 'turn.sent', { entryId: 'x1', ownerId: 'S01', ids: ['S01'], queueId: 'q1' });
    e(10, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
    e(100, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
    e(220, 'stage.ended', { queueId: 'q1', playedSec: 120 });
  }));
  assert.deepEqual(calls, [['recordStage', 10], ['recordSlot', 220, 210], ['songEnded', 220]]);
  // Relance notée 1 ms ou 20 s après la fin (deux écritures du journal, copie
  // lancée plus tard) : même passage, mesuré depuis la relance.
  for (const dt of [0.001, 20]) {
    const late = await spied(build((e, stage, ask) => {
      ask(1, 'S01', 'x1', 1);
      e(5, 'turn.sent', { entryId: 'x1', ownerId: 'S01', ids: ['S01'], queueId: 'q1' });
      e(10, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
      e(40, 'stage.ended', { queueId: 'q1', playedSec: 30 });
      e(40 + dt, 'stage.restarted', { queueId: 'q1b', entryId: 'x1' });
      ask(100, 'S02', 'y1', 2);
      e(220, 'stage.ended', { queueId: 'q1b', playedSec: 180 - dt });
      stage(230, 'y1', ['S02'], 'q2');
    }));
    assert.deepEqual(calls.filter(c => c[1] <= 220).map(c => c.map(x => typeof x === 'number' ? Math.round(x * 1000) / 1000 : x)),
      [['recordStage', 10], ['recordSlot', 220, 180 - dt], ['songEnded', 220]], `relance à +${dt} s`);
    assert.equal(late.decisions.find(d => d.real.entryId === 'y1')?.reservation?.at, T0 + 100000);
  }
  // Entre la fin et la relance, la scène est libre pour le serveur : y1,
  // demandé alors, n'est réservé qu'au départ de la copie (60 s).
  const gap = await spied(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    e(5, 'turn.sent', { entryId: 'x1', ownerId: 'S01', ids: ['S01'], queueId: 'q1' });
    e(10, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
    e(40, 'stage.ended', { queueId: 'q1', playedSec: 30 });
    ask(50, 'S02', 'y1', 2);
    e(60, 'stage.restarted', { queueId: 'q1b', entryId: 'x1' });
    e(240, 'stage.ended', { queueId: 'q1b', playedSec: 180 });
    stage(250, 'y1', ['S02'], 'q2');
  }));
  assert.equal(gap.decisions.find(d => d.real.entryId === 'y1')?.reservation?.at, T0 + 60000);
  // Même titre revenu sous sa file après une fin notée (pause, reconnexion) :
  // un seul passage, comme evening-stats.js.
  await spied(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    e(5, 'turn.sent', { entryId: 'x1', ownerId: 'S01', ids: ['S01'], queueId: 'q1' });
    e(10, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
    e(60, 'stage.ended', { queueId: 'q1', playedSec: 50 });
    e(70, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
    e(220, 'stage.ended', { queueId: 'q1', playedSec: 150 });
  }));
  assert.deepEqual(calls, [['recordStage', 10], ['recordSlot', 220, 210], ['songEnded', 220]]);
  // Battle décidée : la file est retenue dès la décision, sans passage déjà
  // réservé (server.js, battleHoldsQueue) ; y1, demandé pendant l'attente,
  // n'est pas réservé avant la fin de la Battle.
  const forcedBattle = await rejeu.runForced(rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    stage(10, 'x1', ['S01'], 'q1');
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    ask(30, 'S02', 'y1', 2);
    e(40, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(200, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(200, null, null, 'b1', 100);
    e(300, 'battle.automation', { ballotId: 'v1', status: 'resuming' });
    e(302, 'battle.automation', { ballotId: 'v1', status: 'released' });
    stage(310, 'y1', ['S02'], 'q2');
  })));
  assert.equal(forcedBattle.decisions.find(d => d.real.entryId === 'y1')?.reservation ?? null, null);
  // Envoi de la Battle en échec, puis Battle écartée par le bar (journal :
  // battle.resolved seul, battle-vote.js passe l'automatisation à
  // « released ») : la file est relâchée, y1 est réservé pendant x1.
  const failedDismissed = await rejeu.runForced(rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    stage(10, 'x1', ['S01'], 'q1');
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(25, 'battle.automation', { ballotId: 'v1', status: 'failed' });
    e(28, 'battle.resolved', { ballotId: 'v1', outcome: 'dismissed' });
    ask(30, 'S02', 'y1', 2);
    stage(200, 'y1', ['S02'], 'q2');
  })));
  const freed = failedDismissed.decisions.find(d => d.real.entryId === 'y1')?.reservation;
  assert.ok(freed && freed.at < T0 + 190000, JSON.stringify(failedDismissed.decisions.map(d => d.reservation?.time ?? null)));
  // Envoi en échec puis Battle faite à la main (« done ») : retenue jusqu'à
  // la reprise, y1 n'est pas réservé pendant x1.
  const failedDone = await rejeu.runForced(rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    stage(10, 'x1', ['S01'], 'q1');
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(25, 'battle.automation', { ballotId: 'v1', status: 'failed' });
    e(28, 'battle.resolved', { ballotId: 'v1', outcome: 'done' });
    ask(30, 'S02', 'y1', 2);
    stage(200, null, null, 'b1', 90);
    e(292, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(310, 'battle.automation', { ballotId: 'v1', status: 'released' });
    stage(320, 'y1', ['S02'], 'q2');
  })));
  assert.equal(failedDone.decisions.find(d => d.real.entryId === 'y1')?.reservation ?? null, null);
  // Battle ajoutée par le bar dans KaraFun (battle.external, 100 s) : file
  // retenue dès cet instant ; y1, demandé pendant x1, n'est pas réservé.
  const external = await rejeu.runForced(rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    stage(10, 'x1', ['S01'], 'q1');
    e(100, 'battle.external', { ballotId: 'k1', songId: 9 });
    ask(150, 'S02', 'y1', 2);
    e(200, 'battle.automation', { ballotId: 'k1', status: 'playing' });
    stage(200, null, null, 'b1', 90);
    e(292, 'battle.automation', { ballotId: 'k1', status: 'after' });
    e(420, 'battle.automation', { ballotId: 'k1', status: 'resuming' });
    stage(440, 'y1', ['S02'], 'q2');
  })));
  assert.equal(external.decisions.find(d => d.real.entryId === 'y1')?.reservation ?? null, null);
  // File vidée par le bar pendant « after » : le suivi de la Battle est
  // effacé (battleVote.reset), y1 est réservé pendant x1.
  const clearedForced = await rejeu.runForced(rejeu.loadEvening(build((e, stage, ask) => {
    e(5, 'battle.staffLaunch', { ballotId: 'v1' });
    e(6, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(20, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(20, null, null, 'b1', 90);
    e(112, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(120, 'staff.queueCleared', { songs: 0, pendingCancelled: false });
    ask(121, 'S01', 'x1', 1);
    stage(130, 'x1', ['S01'], 'q1');
    ask(140, 'S02', 'y1', 2);
    stage(320, 'y1', ['S02'], 'q2');
  })));
  const reserved = clearedForced.decisions.find(d => d.real.entryId === 'y1')?.reservation;
  assert.ok(reserved && reserved.at < T0 + 310000, JSON.stringify(clearedForced.decisions.map(d => d.reservation?.time ?? null)));
  // Titre repris après un redémarrage (même file KaraFun, sans fin notée) : un
  // seul passage, de son début à la fin de la reprise, et un seul délai de
  // lancement compté.
  const resumed = rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    e(5, 'turn.sent', { entryId: 'x1', ownerId: 'S01', ids: ['S01'], queueId: 'q1' });
    e(10, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
    e(100, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
    e(200, 'stage.ended', { queueId: 'q1', playedSec: 100 });
    stage(220, 'y1', ['S02'], 'q2');
  }));
  assert.equal(resumed.startGaps.length, 2);
  assert.equal(resumed.played.get('x1'), 190);
  // Battles du journal rejoué (lu par evening-stats.js) : durée de chacune.
  const battlesOf = async raw => {
    const es = require('../evening-stats');
    const original = es.computeStats;
    let journal = [];
    es.computeStats = (...a) => { if (a[0].events[0]?.boot === 'rejeu') journal = a[0].events; return original(...a); };
    try { await rejeu.runFree(rejeu.loadEvening(raw)); } finally { es.computeStats = original; }
    return journal.filter(x => x.ev === 'stage.started' && x.source === 'battle')
      .map(x => ({ at: (x.t - T0) / 1000, sec: journal.find(y => y.ev === 'stage.ended' && y.queueId === x.queueId).playedSec }));
  };
  // Scènes du journal rejoué, dans l'ordre : source et début (s).
  // (avec les notes et alertes du rejeu : runOf)
  const runOf = async raw => {
    const es = require('../evening-stats');
    const original = es.computeStats;
    let journal = [], res;
    es.computeStats = (...a) => { if (a[0].events[0]?.boot === 'rejeu') journal = a[0].events; return original(...a); };
    try { res = await rejeu.runFree(rejeu.loadEvening(raw)); } finally { es.computeStats = original; }
    return { scenes: journal.filter(x => x.ev === 'stage.started').map(x => [x.source, Math.round((x.t - T0) / 1000)]),
      notes: res.notes, warnings: res.warnings };
  };
  const scenesOf = async raw => (await runOf(raw)).scenes;
  // Deux Battles approuvées (export sans suivi de l'envoi) : chacune jouée,
  // avec sa durée réelle.
  const many = await battlesOf(build((e, stage, ask) => {
    for (let k = 1; k <= 4; k++) { ask(k, 'S01', `x${k}`, k); ask(k, 'S02', `y${k}`, 10 + k); }
    e(20, 'battle.decided', { outcome: 'approved' });
    stage(10, 'x1', ['S01'], 'q1'); stage(200, 'y1', ['S02'], 'q2');
    stage(400, null, null, 'b1', 200);
    e(700, 'battle.decided', { outcome: 'approved' });
    stage(610, 'x2', ['S01'], 'q3'); stage(800, 'y2', ['S02'], 'q4');
    stage(1000, null, null, 'b2', 150);
    stage(1160, 'x3', ['S01'], 'q5'); stage(1350, 'y3', ['S02'], 'q6');
  }));
  assert.deepEqual(many.map(b => b.sec), [200, 150]);
  // Début réel de chacune, celui de sa scène (ordre face aux titres hors file).
  assert.deepEqual(rejeu.loadEvening(build((e, stage) => {
    e(20, 'battle.decided', { outcome: 'approved' });
    stage(400, null, null, 'b1', 200);
  })).battles.map(b => (b.realStart - T0) / 1000), [400]);
  // Suivies par leur scrutin : une Battle votée, une approuvée puis écartée
  // par le bar (jamais jouée), une lancée « sans vote » par le bar.
  const ballotsRaw = build((e, stage, ask) => {
    for (let k = 1; k <= 4; k++) { ask(k, 'S01', `x${k}`, k); ask(k, 'S02', `y${k}`, 10 + k); }
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    stage(10, 'x1', ['S01'], 'q1'); stage(200, 'y1', ['S02'], 'q2');
    e(150, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(400, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(400, null, null, 'b1', 200);
    e(650, 'battle.decided', { ballotId: 'v2', outcome: 'approved' });
    e(660, 'battle.resolved', { ballotId: 'v2', outcome: 'dismissed' });
    e(660, 'battle.automation', { ballotId: 'v2', status: 'released' });
    stage(610, 'x2', ['S01'], 'q3'); stage(800, 'y2', ['S02'], 'q4');
    e(900, 'battle.staffLaunch', { ballotId: 'v3' });
    e(905, 'battle.automation', { ballotId: 'v3', status: 'sending' });
    e(1000, 'battle.automation', { ballotId: 'v3', status: 'playing' });
    stage(1000, null, null, 'b3', 150);
    stage(1160, 'x3', ['S01'], 'q5'); stage(1350, 'y3', ['S02'], 'q6');
  });
  const ballots = await battlesOf(ballotsRaw);
  assert.deepEqual(ballots.map(b => b.sec), [200, 150]);
  // Délais : de la fin du titre en cours à l'envoi jusqu'au début (y1 380 →
  // 400 s, y2 980 → 1000 s), pas depuis l'envoi (150 s, 905 s).
  assert.deepEqual(rejeu.loadEvening(ballotsRaw).battles.map(b => b.preGapMs), [20000, 20000]);
  // Battle décidée scène libre : son délai réel part de l'envoi, pas de la
  // fin du dernier titre (190 s).
  const idle = await battlesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    stage(10, 'x1', ['S01'], 'q1');
    e(400, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(401, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(530, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(530, null, null, 'b1', 100);
  }));
  assert.deepEqual(idle.map(b => b.at >= 528), [true], JSON.stringify(idle));
  // Scène d'une Battle notée « native » par KaraFun : c'est la sienne ; une
  // Battle faite plus tard dans KaraFun reste hors file.
  const labelled = rejeu.loadEvening(build((e, stage) => {
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(30, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(120, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    e(121, 'stage.started', { queueId: 'b1', source: 'native', ids: [] });
    e(321, 'stage.ended', { queueId: 'b1', playedSec: 200 });
    stage(1000, null, null, 'k1', 100);
  }));
  assert.deepEqual(labelled.battles.map(b => b.sec), [200]);
  assert.deepEqual(labelled.outside.map(o => [o.source, o.sec]), [['battle', 100]]);
  // Battle de l'application en file (dès 200 s) et titre lancé dans KaraFun
  // (300 s), joué avant elle en réel (550 s) : l'ordre des débuts réels.
  const es = require('../evening-stats');
  const original = es.computeStats;
  let journal = [];
  es.computeStats = (...a) => { if (a[0].events[0]?.boot === 'rejeu') journal = a[0].events; return original(...a); };
  try {
    await rejeu.runFree(rejeu.loadEvening(build((e, stage, ask) => {
      ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
      e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
      stage(10, 'x1', ['S01'], 'q1'); stage(200, 'y1', ['S02'], 'q2', 90);
      e(195, 'battle.automation', { ballotId: 'v1', status: 'sending' });
      e(300, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
      e(540, 'stage.ended', { queueId: 'n1', playedSec: 240 });
      e(550, 'battle.automation', { ballotId: 'v1', status: 'playing' });
      stage(550, null, null, 'b1', 100);
    })));
  } finally { es.computeStats = original; }
  assert.deepEqual(journal.filter(x => x.ev === 'stage.started').map(x => x.source), ['queue', 'queue', 'native', 'battle']);
  // Envoi automatique en échec, Battle faite à la main par le bar : c'est la
  // Battle du scrutin, et la file est retenue dès la décision (server.js) :
  // y1, demandé ensuite, passe après elle.
  const manualRaw = build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(40, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(25, 'battle.automation', { ballotId: 'v1', status: 'failed' });
    e(30, 'battle.automation', { ballotId: 'v1', status: 'manual' });
    e(300, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(300, null, null, 'b1', 200);
    stage(510, 'y1', ['S02'], 'q2');
  });
  assert.deepEqual(rejeu.loadEvening(manualRaw).battles.map(b => [b.preGapMs, b.sec]), [[110000, 200]]);
  const manual = await rejeu.runFree(rejeu.loadEvening(manualRaw));
  assert.ok(manual.passages.find(p => p.entryId === 'y1').sentAt >= T0 + 490000, JSON.stringify(manual.passages));
  // Battle finie à 300 s : la file reste retenue (« after ») jusqu'au titre
  // suivant lancé par le bar à 420 s (« resuming »), comme server.js.
  const afterRaw = build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(30, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(185, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(210, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(210, null, null, 'b1', 90);
    e(302, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(420, 'battle.automation', { ballotId: 'v1', status: 'resuming' });
    stage(440, 'y1', ['S02'], 'q2');
    e(441, 'battle.automation', { ballotId: 'v1', status: 'released' });
  });
  assert.deepEqual(rejeu.loadEvening(afterRaw).battles.map(b => [b.preGapMs, b.afterGapMs]), [[20000, 120000]]);
  const held = await rejeu.runFree(rejeu.loadEvening(afterRaw));
  assert.ok(held.passages.find(p => p.entryId === 'y1').sentAt >= T0 + 420000, JSON.stringify(held.passages));
  // Sans reprise notée, un titre lancé directement dans KaraFun (400 s)
  // relâche la file (server.js) : y1 est chanté ensuite.
  const nativeRaw = build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(30, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(185, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(210, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(210, null, null, 'b1', 90);
    e(302, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(400, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
    e(500, 'stage.ended', { queueId: 'n1', playedSec: 100 });
    stage(520, 'y1', ['S02'], 'q2');
  });
  assert.deepEqual(rejeu.loadEvening(nativeRaw).battles.map(b => b.afterGapMs), [Infinity]);
  const native = await rejeu.runFree(rejeu.loadEvening(nativeRaw));
  assert.ok(native.passages.find(p => p.entryId === 'y1')?.sentAt >= T0 + 400000, JSON.stringify(native.passages));
  // Battle « sans vote » lancée par le bar pendant « after » : elle remplace
  // le suivi de la première, qui n'aura jamais de reprise notée ; la file
  // n'est pas retenue jusqu'au bout.
  const relaunchRaw = build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(30, 'S02', 'y1', 2); ask(31, 'S01', 'x2', 3);
    stage(10, 'x1', ['S01'], 'q1');
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(185, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(210, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(210, null, null, 'b1', 90);
    e(302, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(320, 'battle.staffLaunch', { ballotId: 'v2' });
    e(321, 'battle.automation', { ballotId: 'v2', status: 'sending' });
    e(330, 'battle.automation', { ballotId: 'v2', status: 'playing' });
    stage(330, null, null, 'b2', 90);
    e(422, 'battle.automation', { ballotId: 'v2', status: 'after' });
    e(440, 'battle.automation', { ballotId: 'v2', status: 'resuming' });
    stage(460, 'y1', ['S02'], 'q2');
    e(461, 'battle.automation', { ballotId: 'v2', status: 'released' });
    stage(650, 'x2', ['S01'], 'q3');
  });
  assert.deepEqual(rejeu.loadEvening(relaunchRaw).battles.map(b => b.afterGapMs), [20000, 20000]);
  const relaunch = await rejeu.runFree(rejeu.loadEvening(relaunchRaw));
  assert.deepEqual(relaunch.passages.map(p => p.entryId), ['x1', 'y1', 'x2']);
  // Rejouée plus tard qu'en réel (y1, réservé avant la décision, passe
  // d'abord), la première Battle finit à 520 s ; la seconde, déjà lancée par
  // le bar, remplace aussitôt son suivi : pas d'attente du délai mesuré.
  const later = await battlesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(185, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(210, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(210, null, null, 'b1', 90);
    e(302, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(320, 'battle.staffLaunch', { ballotId: 'v2' });
    e(321, 'battle.automation', { ballotId: 'v2', status: 'sending' });
    e(330, 'battle.automation', { ballotId: 'v2', status: 'playing' });
    stage(330, null, null, 'b2', 90);
    e(422, 'battle.automation', { ballotId: 'v2', status: 'after' });
    e(440, 'battle.automation', { ballotId: 'v2', status: 'resuming' });
    stage(460, 'y1', ['S02'], 'q2');
  }));
  assert.deepEqual(later.map(b => b.at), [430, 529]);
  // Une Battle ajoutée dans KaraFun, elle, n'est suivie qu'après « after »
  // (syncBattle) : rejouée pendant le « after » de la première, elle attend
  // la reprise mesurée (28 s après la fin de la première, à 510 s).
  const externalLater = await battlesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(185, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(210, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(210, null, null, 'b1', 90);
    e(302, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(330, 'battle.automation', { ballotId: 'v1', status: 'resuming' });
    e(335, 'battle.external', { ballotId: 'k2', songId: 9 });
    e(340, 'battle.automation', { ballotId: 'k2', status: 'playing' });
    stage(340, null, null, 'b2', 90);
    e(432, 'battle.automation', { ballotId: 'k2', status: 'after' });
    e(440, 'battle.automation', { ballotId: 'k2', status: 'resuming' });
    stage(460, 'y1', ['S02'], 'q2');
  }));
  assert.deepEqual(externalLater.map(b => b.at), [420, 545]);
  // Battle en attente derrière ce « after » : un titre lancé dans KaraFun
  // après elle en réel (440 s) ne la devance pas et ne lève pas la retenue.
  const behindAfter = await scenesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(185, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(210, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(210, null, null, 'b1', 90);
    e(302, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(330, 'battle.automation', { ballotId: 'v1', status: 'resuming' });
    e(335, 'battle.external', { ballotId: 'k2', songId: 9 });
    e(340, 'battle.automation', { ballotId: 'k2', status: 'playing' });
    stage(340, null, null, 'b2', 90);
    e(432, 'battle.automation', { ballotId: 'k2', status: 'after' });
    e(440, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
    e(441, 'battle.automation', { ballotId: 'k2', status: 'released' });
    e(500, 'stage.ended', { queueId: 'n1', playedSec: 60 });
    stage(510, 'y1', ['S02'], 'q2');
  }));
  assert.deepEqual(behindAfter, [['queue', 10], ['queue', 200], ['battle', 400], ['battle', 525], ['native', 625]]);
  // Un vote (propose exige « released ») attend aussi la reprise mesurée de
  // la première Battle (10 s après sa fin rejouée, à 520 s).
  const voteLater = await battlesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(185, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(210, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(210, null, null, 'b1', 90);
    e(302, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(310, 'battle.automation', { ballotId: 'v1', status: 'resuming' });
    e(320, 'battle.decided', { ballotId: 'v2', outcome: 'approved' });
    e(321, 'battle.automation', { ballotId: 'v2', status: 'sending' });
    e(330, 'battle.automation', { ballotId: 'v2', status: 'playing' });
    stage(330, null, null, 'b2', 90);
    e(422, 'battle.automation', { ballotId: 'v2', status: 'after' });
    e(440, 'battle.automation', { ballotId: 'v2', status: 'resuming' });
    stage(460, 'y1', ['S02'], 'q2');
  }));
  assert.deepEqual(voteLater.map(b => b.at), [430, 539]);
  // File vidée par le bar pendant « after » (battleVote.reset, sans reprise
  // notée) : fin de la retenue.
  const clearedRaw = build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(30, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(185, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(210, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(210, null, null, 'b1', 90);
    e(302, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(330, 'staff.queueCleared', { songs: 1, pendingCancelled: false });
    ask(340, 'S02', 'y2', 3);
    stage(400, 'y2', ['S02'], 'q2');
  });
  assert.deepEqual(rejeu.loadEvening(clearedRaw).battles.map(b => b.afterGapMs), [30000]);
  const cleared = await rejeu.runFree(rejeu.loadEvening(clearedRaw));
  assert.ok(cleared.passages.length >= 2, JSON.stringify(cleared.passages));
  // Battle ajoutée par le bar dans KaraFun et suivie par l'application
  // (battle.external à 100 s, jouée à 200 s, reprise à 420 s) : en file dès
  // son arrivée, elle retient la file jusqu'à la reprise, comme server.js.
  const externalRaw = build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(150, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(100, 'battle.external', { ballotId: 'k1', songId: 9 });
    e(200, 'battle.automation', { ballotId: 'k1', status: 'playing' });
    stage(200, null, null, 'b1', 90);
    e(292, 'battle.automation', { ballotId: 'k1', status: 'after' });
    e(420, 'battle.automation', { ballotId: 'k1', status: 'resuming' });
    stage(440, 'y1', ['S02'], 'q2');
    e(441, 'battle.automation', { ballotId: 'k1', status: 'released' });
  });
  const externalEv = rejeu.loadEvening(externalRaw);
  assert.deepEqual([externalEv.battles.map(b => [b.external, b.preGapMs, b.afterGapMs]), externalEv.outside.length], [[[true, 10000, 130000]], 0]);
  const externalRun = await rejeu.runFree(externalEv);
  assert.ok(externalRun.passages.find(p => p.entryId === 'y1').sentAt >= T0 + 420000, JSON.stringify(externalRun.passages));
  // Déjà dans KaraFun, elle est jouée même quand l'heure de fermeture
  // retiendrait l'envoi d'une Battle de l'application.
  const nearClosing = await battlesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    e(5, 'closing.set', { closingAt: T0 + 250000 });
    stage(10, 'x1', ['S01'], 'q1');
    e(100, 'battle.external', { ballotId: 'k1', songId: 9 });
    e(200, 'battle.automation', { ballotId: 'k1', status: 'playing' });
    stage(200, null, null, 'b1', 90);
    e(292, 'battle.automation', { ballotId: 'k1', status: 'after' });
  }));
  assert.deepEqual(nearClosing.map(b => b.at), [200]);
  // Ordre des débuts réels : le titre lancé dans KaraFun (320 s) passe avant
  // la Battle ajoutée ensuite (330 s), jouée après lui en réel (385 s).
  const arrival = await scenesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(5, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1', 300);
    e(320, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
    e(330, 'battle.external', { ballotId: 'k1', songId: 9 });
    e(380, 'stage.ended', { queueId: 'n1', playedSec: 60 });
    e(385, 'battle.automation', { ballotId: 'k1', status: 'playing' });
    stage(385, null, null, 'b1', 90);
    e(477, 'battle.automation', { ballotId: 'k1', status: 'after' });
    e(600, 'battle.automation', { ballotId: 'k1', status: 'resuming' });
    stage(610, 'y1', ['S02'], 'q2');
  }));
  // (délai de la Battle, 5 s, plus court que celui d'un titre hors file)
  assert.deepEqual(arrival.map(x => x[0]).slice(-2), ['native', 'battle'], JSON.stringify(arrival));
  // Battle vue dans KaraFun (150 s) avant que le bar lance un titre
  // directement (200 s), jouée après lui en réel (450 s) : l'ordre des débuts
  // réels, pas celui des arrivées, et sa retenue « after » jusqu'à 700 s.
  const seenFirst = await scenesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(160, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(150, 'battle.external', { ballotId: 'k1', songId: 9 });
    e(200, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
    e(440, 'stage.ended', { queueId: 'n1', playedSec: 240 });
    e(450, 'battle.automation', { ballotId: 'k1', status: 'playing' });
    stage(450, null, null, 'b1', 100);
    e(552, 'battle.automation', { ballotId: 'k1', status: 'after' });
    e(700, 'battle.automation', { ballotId: 'k1', status: 'resuming' });
    stage(710, 'y1', ['S02'], 'q2');
  }));
  assert.deepEqual(seenFirst, [['queue', 10], ['native', 200], ['battle', 450], ['queue', 710]]);
  // Dans l'autre sens : Battle jouée en réel (80 s) avant le titre lancé dans
  // KaraFun (180 s) ; le rejeu, qui fait passer x1 d'abord, la garde devant.
  const battleFirst = await scenesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'y1', ['S02'], 'q1', 60);
    e(20, 'battle.external', { ballotId: 'k1', songId: 9 });
    e(80, 'battle.automation', { ballotId: 'k1', status: 'playing' });
    stage(80, null, null, 'b1', 90);
    e(172, 'battle.automation', { ballotId: 'k1', status: 'after' });
    e(175, 'battle.automation', { ballotId: 'k1', status: 'resuming' });
    e(180, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
    e(240, 'stage.ended', { queueId: 'n1', playedSec: 60 });
    stage(250, 'x1', ['S01'], 'q2', 300);
  }));
  assert.deepEqual(battleFirst, [['queue', 10], ['battle', 320], ['native', 420], ['queue', 490]]);
  // Même ordre quand la Battle (un vote) attend encore son envoi, retenue par
  // y1 réservé : le titre lancé dans KaraFun après elle en réel (220 s), qui
  // a mis fin à son « after », ne la devance pas.
  const waitingFirst = await scenesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'y1', ['S02'], 'q1', 60);
    e(30, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(71, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(100, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(100, null, null, 'b1', 100);
    e(202, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(220, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
    e(221, 'battle.automation', { ballotId: 'v1', status: 'released' });
    e(320, 'stage.ended', { queueId: 'n1', playedSec: 100 });
    stage(330, 'x1', ['S01'], 'q2', 400);
  }));
  assert.deepEqual(waitingFirst.map(x => x[0]), ['queue', 'queue', 'battle', 'native'], JSON.stringify(waitingFirst));
  // Vote en attente d'envoi derrière z1, réservé, et titre lancé dans KaraFun
  // après la Battle en réel (O2, 270 s) déjà dû : z1 part, puis la Battle,
  // puis O2 (server.js), au lieu de tout bloquer jusqu'au bout.
  const behindReserved = await scenesOf(build((e, stage, ask) => {
    ask(1, 'S02', 'y1', 2); ask(2, 'S03', 'z1', 3); ask(3, 'S01', 'x1', 1);
    stage(10, 'z1', ['S03'], 'q1', 95);
    e(90, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(110, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
    e(170, 'stage.ended', { queueId: 'n1', playedSec: 60 });
    e(171, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(175, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(175, null, null, 'b1', 90);
    e(267, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(270, 'stage.started', { queueId: 'n2', source: 'native', ids: [] });
    e(271, 'battle.automation', { ballotId: 'v1', status: 'released' });
    e(330, 'stage.ended', { queueId: 'n2', playedSec: 60 });
    stage(340, 'y1', ['S02'], 'q2', 60);
    stage(410, 'x1', ['S01'], 'q3', 300);
  }));
  assert.deepEqual(behindReserved, [['queue', 10], ['queue', 80], ['native', 390], ['queue', 460], ['battle', 559], ['native', 658]]);
  // Battle qui ne peut plus partir (heure de fermeture) : elle ne retient pas
  // le titre lancé dans KaraFun après elle en réel.
  const closingVote = extra => build((e, stage, ask) => {
    e(5, 'closing.set', { closingAt: T0 + 450000 });
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'y1', ['S02'], 'q1', 60);
    e(30, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(71, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(100, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(100, null, null, 'b1', 100);
    e(202, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(220, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
    e(221, 'battle.automation', { ballotId: 'v1', status: 'released' });
    e(320, 'stage.ended', { queueId: 'n1', playedSec: 100 });
    stage(330, 'x1', ['S01'], 'q2', 400);
    if (extra) extra(e, stage);
  });
  assert.deepEqual(await scenesOf(closingVote()), [['queue', 10], ['native', 420]]);
  // Même vote, Battle ajoutée ensuite dans KaraFun (735 s) : son suivi
  // remplace le vote retenu (syncBattle), elle est jouée.
  const takeover = await scenesOf(closingVote((e, stage) => {
    e(735, 'battle.external', { ballotId: 'k2', songId: 9 });
    e(740, 'battle.automation', { ballotId: 'k2', status: 'playing' });
    stage(740, null, null, 'b2', 80);
    e(822, 'battle.automation', { ballotId: 'k2', status: 'after' });
  }));
  assert.deepEqual(takeover, [['queue', 10], ['native', 420], ['battle', 740]]);
  // Vote seulement retardé par le rejeu (x1, déjà envoyé, passe avant lui)
  // quand le bar ajoute une Battle dans KaraFun (300 s) : le serveur la suit à
  // la place du vote (syncBattle), une seule Battle passe, la note le dit.
  const replaced = await runOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'y1', ['S02'], 'q1', 60);
    e(30, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(71, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(100, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(100, null, null, 'b1', 100);
    e(202, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(205, 'battle.automation', { ballotId: 'v1', status: 'resuming' });
    stage(210, 'x1', ['S01'], 'q2', 400);
    e(300, 'battle.external', { ballotId: 'k2', songId: 9 });
    e(615, 'battle.automation', { ballotId: 'k2', status: 'playing' });
    stage(615, null, null, 'b2', 80);
    e(697, 'battle.automation', { ballotId: 'k2', status: 'after' });
    e(700, 'battle.automation', { ballotId: 'k2', status: 'resuming' });
  }));
  assert.deepEqual([replaced.scenes, replaced.warnings], [[['queue', 10], ['queue', 420], ['battle', 485]],
    ['1 scène réelle jamais démarrée dans le rejeu (voir les notes)']]);
  assert.ok(replaced.notes.some(n => /Battle décidée à 21:00:30 remplacée par la Battle ajoutée dans KaraFun à 21:05:00/.test(n)),
    replaced.notes.join(' | '));
  // Même cas avec une Battle « sans vote » du bar (210 s) en file derrière le
  // vote : la Battle de KaraFun (300 s) remplace le vote, puis celle du bar.
  const behind = await runOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'y1', ['S02'], 'q1', 60);
    e(30, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(71, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(100, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(100, null, null, 'b1', 100);
    e(202, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(205, 'battle.automation', { ballotId: 'v1', status: 'released' });
    e(210, 'battle.staffLaunch', { ballotId: 'v2' });
    e(212, 'battle.automation', { ballotId: 'v2', status: 'sending' });
    e(215, 'battle.automation', { ballotId: 'v2', status: 'playing' });
    stage(215, null, null, 'b2', 60);
    e(277, 'battle.automation', { ballotId: 'v2', status: 'after' });
    e(280, 'battle.automation', { ballotId: 'v2', status: 'released' });
    e(300, 'battle.external', { ballotId: 'k3', songId: 9 });
    e(305, 'battle.automation', { ballotId: 'k3', status: 'playing' });
    stage(305, null, null, 'b3', 70);
    e(377, 'battle.automation', { ballotId: 'k3', status: 'after' });
    e(380, 'battle.automation', { ballotId: 'k3', status: 'resuming' });
    stage(390, 'x1', ['S01'], 'q2', 400);
  }));
  assert.deepEqual([behind.scenes, behind.warnings], [[['queue', 10], ['queue', 425], ['battle', 490], ['battle', 563]],
    ['1 scène réelle jamais démarrée dans le rejeu (voir les notes)']]);
  // Vote v1 et Battle de KaraFun k2, joués en réel l'un après l'autre, tous
  // deux en attente derrière une Battle v0 que le rejeu a retardée : à sa
  // libération, le serveur suit d'abord la Battle déjà dans KaraFun (70 s),
  // puis le vote (80 s) ; aucune n'est perdue.
  const pending = await battlesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    e(3, 'battle.decided', { ballotId: 'v0', outcome: 'approved' });
    stage(10, 'y1', ['S02'], 'q1', 60);
    e(75, 'battle.automation', { ballotId: 'v0', status: 'sending' });
    e(80, 'battle.automation', { ballotId: 'v0', status: 'playing' });
    stage(80, null, null, 'b1', 100);
    e(182, 'battle.automation', { ballotId: 'v0', status: 'after' });
    e(185, 'battle.automation', { ballotId: 'v0', status: 'released' });
    e(190, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(192, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(195, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(195, null, null, 'b2', 80);
    e(277, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(280, 'battle.automation', { ballotId: 'v1', status: 'released' });
    e(290, 'battle.external', { ballotId: 'k2', songId: 9 });
    e(295, 'battle.automation', { ballotId: 'k2', status: 'playing' });
    stage(295, null, null, 'b3', 70);
    e(367, 'battle.automation', { ballotId: 'k2', status: 'after' });
    e(380, 'battle.automation', { ballotId: 'k2', status: 'resuming' });
    stage(390, 'x1', ['S01'], 'q2', 400);
  }));
  assert.deepEqual(pending.map(b => [b.at, b.sec]), [[415, 100], [525, 70], [613, 80]]);
  // Même cas avec une Battle « sans vote » du bar à la place du vote : elle
  // part d'abord (c'est elle qui lève « after »), et la Battle déjà dans
  // KaraFun la remplace aussitôt, comme syncBattle ; la reprise réelle de k2
  // (235 s) retient x1, et l'alerte compte la Battle remplacée.
  const barFirst = await runOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    e(3, 'battle.decided', { ballotId: 'v0', outcome: 'approved' });
    stage(10, 'y1', ['S02'], 'q1', 60);
    e(75, 'battle.automation', { ballotId: 'v0', status: 'sending' });
    e(80, 'battle.automation', { ballotId: 'v0', status: 'playing' });
    stage(80, null, null, 'b1', 100);
    e(182, 'battle.automation', { ballotId: 'v0', status: 'after' });
    e(185, 'battle.automation', { ballotId: 'v0', status: 'released' });
    e(190, 'battle.staffLaunch', { ballotId: 'v1' });
    e(192, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(195, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(195, null, null, 'b2', 80);
    e(277, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(280, 'battle.automation', { ballotId: 'v1', status: 'released' });
    e(290, 'battle.external', { ballotId: 'k2', songId: 9 });
    e(295, 'battle.automation', { ballotId: 'k2', status: 'playing' });
    stage(295, null, null, 'b3', 70);
    e(367, 'battle.automation', { ballotId: 'k2', status: 'after' });
    e(600, 'battle.automation', { ballotId: 'k2', status: 'resuming' });
    stage(610, 'x1', ['S01'], 'q2', 400);
  }));
  assert.deepEqual([barFirst.scenes, barFirst.warnings], [[['queue', 10], ['battle', 415], ['battle', 520], ['queue', 835]],
    ['1 scène réelle jamais démarrée dans le rejeu (voir les notes)']]);
  // Vote jamais envoyé avant l'arrêt de l'application (200 s), y1 étant déjà
  // dans KaraFun : KaraFun joue sans elle le titre lancé par le bar (690 s),
  // la Battle part au redémarrage ; arrêt final : seul le titre passe, et
  // l'alerte dit qu'une scène réelle manque.
  const stop = restart => build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1', 60);
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(71, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(75, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(75, null, null, 'b1', 90);
    e(167, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(170, 'battle.automation', { ballotId: 'v1', status: 'released' });
    e(200, 'app.stopped', { reason: 'stop' });
    stage(400, 'y1', ['S02'], 'q2', 280);
    e(690, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
    e(780, 'stage.ended', { queueId: 'n1', playedSec: 90 });
    if (restart) e(1500, 'app.started', { restored: true, offlineMs: 1300000 });
  });
  const tempStop = await runOf(stop(true));
  assert.deepEqual([tempStop.scenes, tempStop.warnings], [[['queue', 10], ['queue', 305], ['native', 690], ['battle', 1504]], []]);
  const finalStop = await runOf(stop(false));
  assert.deepEqual([finalStop.scenes, finalStop.warnings], [[['queue', 10], ['queue', 305], ['native', 690]],
    ['1 scène réelle jamais démarrée dans le rejeu (voir les notes)']]);
  assert.ok(finalStop.notes.some(n => /scènes réelles jamais démarrées dans le rejeu : Battle jouée à 21:01:15$/.test(n)), finalStop.notes.join(' | '));
  // Deux votes jamais envoyés avant l'arrêt final : les deux comptés.
  const twoLeft = await runOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1', 60);
    for (const [v, t, at, sec] of [['v1', 20, 75, 90], ['v2', 175, 178, 15]]) {
      e(t, 'battle.decided', { ballotId: v, outcome: 'approved' });
      e(at - 2, 'battle.automation', { ballotId: v, status: 'sending' });
      e(at, 'battle.automation', { ballotId: v, status: 'playing' });
      stage(at, null, null, `b-${v}`, sec);
      e(at + sec + 1, 'battle.automation', { ballotId: v, status: 'after' });
      e(at + sec + 3, 'battle.automation', { ballotId: v, status: 'released' });
    }
    e(200, 'app.stopped', { reason: 'stop' });
    stage(400, 'y1', ['S02'], 'q2', 280);
  }));
  assert.deepEqual(twoLeft.warnings, ['2 scènes réelles jamais démarrées dans le rejeu (voir les notes)']);
  assert.ok(twoLeft.notes.some(n => /jamais démarrées dans le rejeu : Battle jouée à 21:01:15, Battle jouée à 21:02:58$/.test(n)), twoLeft.notes.join(' | '));
  // Battle de KaraFun jouée avant le premier titre de la soirée (après lui en
  // réel) : ce titre démarre juste après elle et sa reprise, jamais avant son
  // heure réelle.
  const firstAfter = at => build((e, stage, ask) => {
    e(1, 'battle.external', { ballotId: 'k1', songId: 9 });
    ask(3, 'S01', 'x1', 1);
    stage(at, 'x1', ['S01'], 'q1', 60);
    e(at + 70, 'battle.automation', { ballotId: 'k1', status: 'playing' });
    stage(at + 70, null, null, 'b1', 90);
    e(at + 162, 'battle.automation', { ballotId: 'k1', status: 'after' });
    e(at + 170, 'battle.automation', { ballotId: 'k1', status: 'resuming' });
  });
  assert.deepEqual(await scenesOf(firstAfter(10)), [['battle', 11], ['queue', 116]]);
  assert.deepEqual(await scenesOf(firstAfter(400)), [['battle', 11], ['queue', 400]]);
  // Titre lancé par le bar dans KaraFun avant le premier titre de la file
  // (100 à 340 s, x1 envoyé à 3 s et chanté à 360 s) : x1 ne part pas avant
  // son heure réelle, et la scène libre d'ici là reçoit le titre du bar.
  const opening = await scenesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    e(3, 'turn.sent', { entryId: 'x1', ownerId: 'S01', ids: ['S01'], queueId: 'q1' });
    e(100, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
    e(340, 'stage.ended', { queueId: 'n1', playedSec: 240 });
    e(360, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
    e(540, 'stage.ended', { queueId: 'q1', playedSec: 180 });
  }));
  assert.deepEqual(opening, [['native', 100], ['queue', 360]]);
  // Deux titres du bar à l'ouverture, demandes déjà là (le rejeu envoie x1
  // aussitôt) : les deux passent avant x1, la scène n'attend pas.
  const warmup = await scenesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    e(100, 'stage.started', { queueId: 'n1', source: 'native', ids: [] }); e(340, 'stage.ended', { queueId: 'n1', playedSec: 240 });
    e(345, 'stage.started', { queueId: 'n2', source: 'native', ids: [] }); e(585, 'stage.ended', { queueId: 'n2', playedSec: 240 });
    stage(600, 'x1', ['S01'], 'q1'); stage(790, 'y1', ['S02'], 'q2');
  }));
  assert.deepEqual(warmup, [['native', 100], ['native', 350], ['queue', 605], ['queue', 795]]);
  // De même pour une Battle ajoutée dans KaraFun et suivie (jouée à 100 s,
  // avant x1 à 360 s) : elle ne reste pas derrière x1.
  const openingBattle = await scenesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    e(3, 'turn.sent', { entryId: 'x1', ownerId: 'S01', ids: ['S01'], queueId: 'q1' });
    e(90, 'battle.external', { ballotId: 'k1', songId: 9 });
    e(100, 'battle.automation', { ballotId: 'k1', status: 'playing' });
    stage(100, null, null, 'b1', 90);
    e(191, 'battle.automation', { ballotId: 'k1', status: 'after' });
    e(200, 'battle.automation', { ballotId: 'k1', status: 'resuming' });
    e(360, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
    e(540, 'stage.ended', { queueId: 'q1', playedSec: 180 });
  }));
  assert.deepEqual(openingBattle, [['battle', 100], ['queue', 360]]);
  // Mais une Battle de KaraFun jouée après x1 en réel (500 s) reste derrière.
  const laterBattle = await scenesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    e(3, 'turn.sent', { entryId: 'x1', ownerId: 'S01', ids: ['S01'], queueId: 'q1' });
    e(90, 'battle.external', { ballotId: 'k1', songId: 9 });
    e(360, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
    e(480, 'stage.ended', { queueId: 'q1', playedSec: 120 });
    e(500, 'battle.automation', { ballotId: 'k1', status: 'playing' });
    stage(500, null, null, 'b1', 90);
  }));
  assert.deepEqual(laterBattle.map(x => x[0]), ['queue', 'battle'], JSON.stringify(laterBattle));
  // Envoi impossible pendant la soirée, alors que KaraFun joue encore ce
  // qu'il a (y1, envoyé à 55 s, chanté de 200 à 380 s : phase « singing »
  // sans cause) : z1 n'est envoyé qu'au retour de l'envoi (600 s), comme le
  // serveur, que l'envoi automatique soit coupé (règle de la soirée, réglage
  // du bar ou coupure silencieuse vue par la phase « auto-off »), KaraFun
  // déconnecté, sans droit d'ajout, ou un envoi interrompu à vérifier.
  const blockedUntil600 = (rules, fill, { sent = true, singing = true } = {}) => {
    const raw = build((e, stage, ask) => {
      ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2); ask(3, 'S03', 'z1', 3);
      if (sent) { e(5, 'turn.sent', { entryId: 'x1', ownerId: 'S01', ids: ['S01'], queueId: 'q1' });
        e(55, 'turn.sent', { entryId: 'y1', ownerId: 'S02', ids: ['S02'], queueId: 'q2' }); }
      e(10, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
      e(190, 'stage.ended', { queueId: 'q1', playedSec: 180 });
      e(200, 'stage.started', { entryId: 'y1', ids: ['S02'], queueId: 'q2', source: 'queue', title: 'y1' });
      // (KaraFun déconnecté : sync() s'arrête, aucune autre phase notée)
      if (singing) e(200, 'karaoke.phase', { phase: 'singing', blocker: null });
      e(380, 'stage.ended', { queueId: 'q2', playedSec: 180 });
      fill(e);
      stage(620, 'z1', ['S03'], 'q3');
    });
    Object.assign(raw.events[0].rules, rules);
    return rejeu.loadEvening(raw);
  };
  const phases = blocker => e => {
    e(191, 'karaoke.phase', { phase: 'between', blocker });
    e(381, 'karaoke.phase', { phase: 'between', blocker });
  };
  const blockedCases = {
    réglage: blockedUntil600({}, e => {
      e(100, 'settings.changed', { setting: 'auto', from: true, to: false });
      e(600, 'settings.changed', { setting: 'auto', from: false, to: true });
    }),
    règle: blockedUntil600({ auto: false }, e => e(600, 'settings.changed', { setting: 'auto', from: false, to: true }), { sent: false }),
    silencieux: blockedUntil600({}, e => {
      phases('auto-off')(e);
      e(600, 'settings.changed', { setting: 'auto', from: false, to: true });
    }),
    déconnecté: blockedUntil600({}, e => {
      e(100, 'karaoke.phase', { phase: 'unknown', blocker: 'offline' });
      e(600, 'karaoke.phase', { phase: 'between', blocker: 'sending' });
    }, { singing: false }),
    droits: blockedUntil600({}, e => {
      phases('permission')(e);
      e(600, 'karaoke.phase', { phase: 'between', blocker: 'sending' });
    }),
    interrompu: blockedUntil600({}, e => {
      e(100, 'send.unconfirmed', { entryId: 'y1', ids: ['S02'] });
      phases('recovered-pending')(e);
      e(600, 'karaoke.phase', { phase: 'between', blocker: 'push-delay' });
    }),
    // (une cause plus prioritaire, ici la relance d'un titre, la masque)
    masqué: blockedUntil600({}, e => {
      e(100, 'send.unconfirmed', { entryId: 'y1', ids: ['S02'] });
      e(191, 'karaoke.phase', { phase: 'between', blocker: 'recovered-pending' });
      e(381, 'karaoke.phase', { phase: 'between', blocker: 'restart' });
      e(600, 'karaoke.phase', { phase: 'between', blocker: 'push-delay' });
    }),
  };
  for (const [kind, evening] of Object.entries(blockedCases)) {
    const res = await rejeu.runFree(evening);
    assert.ok(res.passages.find(p => p.entryId === 'z1')?.sentAt >= T0 + 600000, `${kind} : ${JSON.stringify(res.passages)}`);
  }
  // Soirée ouverte envoi automatique coupé (règle), remis sans réglage noté
  // (droits retrouvés) : le premier envoi réel prouve l'envoi, rien n'est
  // perdu.
  // Envoi interrompu sans phase notée (scène jamais libre) : send.unconfirmed
  // suffit.
  const unconfirmed = await rejeu.runFree(blockedUntil600({}, e => {
    e(100, 'send.unconfirmed', { entryId: 'y1', ids: ['S02'] });
    e(600, 'karaoke.phase', { phase: 'between', blocker: 'push-delay' });
  }));
  assert.ok(unconfirmed.passages.find(p => p.entryId === 'z1')?.sentAt >= T0 + 600000, JSON.stringify(unconfirmed.passages));
  const silentBack = await rejeu.runFree(blockedUntil600({ auto: false }, () => {}));
  assert.deepEqual(silentBack.passages.map(p => p.entryId), ['x1', 'y1', 'z1']);
  // Envoi automatique coupé (6 à 400 s) dès l'envoi de x1, vote décidé à
  // 50 s : le serveur réserve quand même y1 au début de x1, qui part au
  // retour de l'envoi, avant la Battle (passage réservé d'abord).
  const reservedDuringOff = await scenesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2);
    stage(10, 'x1', ['S01'], 'q1');
    e(6, 'settings.changed', { setting: 'auto', from: true, to: false });
    e(50, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(400, 'settings.changed', { setting: 'auto', from: false, to: true });
    stage(410, 'y1', ['S02'], 'q2', 180);
    e(598, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(600, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(600, null, null, 'b1', 90);
    e(691, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(693, 'battle.automation', { ballotId: 'v1', status: 'released' });
  }));
  assert.deepEqual(reservedDuringOff.map(x => x[0]), ['queue', 'queue', 'battle'], JSON.stringify(reservedDuringOff));
  // Fin du karaoké (fermeture à 300 s, dernier titre fini à 350 s) : le
  // titre lancé par le bar, retardé par le rejeu (z1, 400 s), ne démarre plus,
  // et l'alerte le dit.
  const endedWith = scene => build((e, stage, ask) => {
    e(1, 'song.requested', { personId: 'S03', entryId: 'z1', songId: 3, title: 'z1', mode: 'append', durationSec: 400 });
    ask(2, 'S01', 'x1', 1);
    e(5, 'closing.set', { closingAt: T0 + 300000 });
    stage(10, 'x1', ['S01'], 'q1');
    scene(e, stage);
  });
  const ended = await runOf(endedWith(e => {
    e(290, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
    e(350, 'stage.ended', { queueId: 'n1', playedSec: 60 });
  }));
  assert.deepEqual([ended.scenes, ended.warnings], [[['queue', 10]], ['1 scène réelle jamais démarrée dans le rejeu (voir les notes)']]);
  assert.ok(ended.notes.some(n => /scènes réelles jamais démarrées dans le rejeu : titre lancé dans KaraFun à 21:04:50$/.test(n)), ended.notes.join(' | '));
  // Vote joué en réel (260 s) avant ce titre : la note suit l'ordre des
  // heures réelles, et n'est pas datée par l'horloge du rejeu.
  const endedBoth = await runOf(endedWith((e, stage) => {
    e(240, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(255, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(260, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(260, null, null, 'b1', 20);
    e(282, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(285, 'battle.automation', { ballotId: 'v1', status: 'released' });
    e(290, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
    e(350, 'stage.ended', { queueId: 'n1', playedSec: 60 });
  }));
  assert.deepEqual([endedBoth.notes, endedBoth.warnings], [['à la fin, scènes réelles jamais démarrées dans le rejeu : ' +
    'Battle jouée à 21:04:20, titre lancé dans KaraFun à 21:04:50'], ['2 scènes réelles jamais démarrées dans le rejeu (voir les notes)']]);
  // Une Battle faite dans KaraFun sans suivi de l'application : nommée Battle.
  const endedBattle = await runOf(endedWith((e, stage) => stage(290, null, null, 'k1', 60)));
  assert.ok(endedBattle.notes.some(n => /scènes réelles jamais démarrées dans le rejeu : Battle faite dans KaraFun à 21:04:50$/.test(n)),
    endedBattle.notes.join(' | '));
  // Vote approuvé encore en attente d'envoi, remplacé par la Battle ajoutée
  // dans KaraFun (observeExternalBattle) : une seule Battle, la sienne.
  const superseded = rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    stage(10, 'x1', ['S01'], 'q1');
    e(50, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(100, 'battle.external', { ballotId: 'k1', songId: 9 });
    e(200, 'battle.automation', { ballotId: 'k1', status: 'playing' });
    stage(200, null, null, 'b1', 90);
    e(292, 'battle.automation', { ballotId: 'k1', status: 'after' });
    e(300, 'battle.automation', { ballotId: 'k1', status: 'resuming' });
  }));
  assert.deepEqual(superseded.battles.map(b => [b.decision.ev, b.sec]), [['battle.external', 90]]);
  // Envoi de la Battle retenu par l'heure de fermeture : la file est retenue
  // aussi (battleHoldsQueue, « waiting » sans passage réservé) ; une fois
  // l'heure retirée, la Battle passe avant y1, demandé pendant l'attente.
  const waiting = await scenesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    e(5, 'closing.set', { closingAt: T0 + 280000 });
    stage(10, 'x1', ['S01'], 'q1');
    e(100, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    ask(120, 'S02', 'y1', 2);
    e(200, 'closing.cleared', {});
    e(200, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(230, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(230, null, null, 'b1', 90);
    e(322, 'battle.automation', { ballotId: 'v1', status: 'after' });
    e(330, 'battle.automation', { ballotId: 'v1', status: 'resuming' });
    stage(340, 'y1', ['S02'], 'q2');
  }));
  assert.deepEqual(waiting.map(x => x[0]), ['queue', 'battle', 'queue'], JSON.stringify(waiting));
  // Battle approuvée puis écartée, export sans suivi de l'envoi : la Battle
  // faite ensuite dans KaraFun n'est pas la sienne.
  const dismissed = rejeu.loadEvening(build((e, stage) => {
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(30, 'battle.resolved', { ballotId: 'v1', outcome: 'dismissed' });
    stage(300, null, null, 'k1', 100);
  }));
  assert.deepEqual([dismissed.battles.length, dismissed.outside.length], [0, 1]);
  // Battle reprise sous la même file (reconnexion) : une seule durée, de son
  // début à la fin de la reprise ; envoyée scène libre : délai depuis l'envoi.
  const resumedBattle = rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    e(20, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(30, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(120, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    e(120, 'stage.started', { queueId: 'b1', source: 'battle', ids: [] });
    e(160, 'stage.ended', { queueId: 'b1', playedSec: 40 });
    e(170, 'stage.started', { queueId: 'b1', source: 'battle', ids: [] });
    e(330, 'stage.ended', { queueId: 'b1', playedSec: 160 });
    stage(340, 'x1', ['S01'], 'q1');
  }));
  assert.deepEqual(resumedBattle.battles.map(b => [b.preGapMs, b.sec]), [[90000, 210]]);
  // Battle décidée pendant un arrêt de l'application : envoyée au retour.
  const down = await battlesOf(build((e, stage) => {
    e(25, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
    e(400, 'app.started', { restored: true, offlineMs: 390000 });
    e(410, 'battle.automation', { ballotId: 'v1', status: 'sending' });
    e(420, 'battle.automation', { ballotId: 'v1', status: 'playing' });
    stage(420, null, null, 'b1', 100);
  }));
  assert.deepEqual(down.map(b => b.at >= 400), [true]);
  // Battle envoyée pendant x1 alors que la fermeture laisse la place : jouée
  // même si elle démarre plus près de l'heure (server.js ne la retire pas).
  const late = await battlesOf(build((e, stage, ask) => {
    ask(1, 'S01', 'x1', 1);
    e(5, 'closing.set', { closingAt: T0 + 400000 });
    e(20, 'battle.decided', { outcome: 'approved' });
    stage(10, 'x1', ['S01'], 'q1');
    stage(330, null, null, 'b1', 200);
  }));
  assert.deepEqual(late.map(b => b.sec), [200]);
  // a2 (même chanson que a1, encore à chanter dans le rejeu) attend ; c1,
  // demandé après lui, est fait tout de suite. Une fois fait, a2 reprend sa
  // place réelle, devant c1.
  const order = await rejeu.runFree(rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S02', 'y1', 2); ask(2, 'S01', 'a1', 1);
    stage(10, 'a1', ['S01'], 'q1');
    ask(30, 'S01', 'a2', 1); ask(35, 'S01', 'c1', 3); ask(36, 'S02', 'y2', 4); ask(37, 'S02', 'y3', 5);
    stage(200, 'y1', ['S02'], 'q2'); stage(400, 'a2', ['S01'], 'q3'); stage(600, 'y2', ['S02'], 'q4');
    stage(800, 'c1', ['S01'], 'q5'); stage(1000, 'y3', ['S02'], 'q6');
  })));
  const ids = order.passages.map(p => p.entryId);
  assert.ok(ids.indexOf('a2') >= 0 && ids.indexOf('a2') < ids.indexOf('c1'), ids.join(' '));
  // Table fermée pendant que la demande attend : notée comme un départ.
  const closed = await rejeu.runFree(rejeu.loadEvening(build((e, stage, ask) => {
    ask(1, 'S02', 'y1', 2); ask(2, 'S01', 'a1', 1);
    stage(10, 'a1', ['S01'], 'q1');
    ask(30, 'S01', 'a2', 1);
    e(45, 'table.left', { tableId: 'T1' });
    stage(200, 'y1', ['S02'], 'q2');
  })));
  assert.ok(closed.notes.some(n => /song\.requested non rejoué : personne partie avant que la même chanson quitte sa liste S01 a2/.test(n)),
    closed.notes.join(' | '));
});

test('rejeu libre : titre ou Battle joués directement dans KaraFun, scène occupée', async () => {
  const T0 = Date.UTC(2026, 9, 15, 19, 0);
  const events = [];
  const e = (t, name, f = {}) => events.push({ v: 1, seq: events.length + 1, t: T0 + t * 1000, ev: name, ...f });
  e(0, 'evening.started', { rules: {} });
  for (const t of ['T1', 'T2']) e(0, 'table.opened', { tableId: t });
  for (const [k, t] of [['S01', 'T1'], ['S02', 'T2']]) e(0, 'person.joined', { personId: k, tableId: t });
  const ask = (t, personId, entryId, songId) => e(t, 'song.requested', { personId, entryId, songId, title: entryId, mode: 'append' });
  const stage = (t, id, ids, q) => {
    e(t - 5, 'turn.sent', { entryId: id, ownerId: ids[0], ids, queueId: q });
    e(t, 'stage.started', { entryId: id, ids, queueId: q, source: 'queue', title: id });
    e(t + 180, 'stage.ended', { queueId: q, playedSec: 180 });
  };
  ask(1, 'S01', 'x1', 1); ask(2, 'S02', 'y1', 2); ask(3, 'S01', 'x2', 3);
  stage(10, 'x1', ['S01'], 'q1');
  // Titre ajouté par le bar dans KaraFun (240 s), puis Battle faite dans
  // KaraFun (sans vote ni lancement par l'application, 100 s).
  e(200, 'stage.started', { queueId: 'n1', source: 'native', ids: [], title: 'hors file' });
  e(440, 'stage.ended', { queueId: 'n1', playedSec: 240 });
  e(445, 'battle.external', { ballotId: null });
  e(450, 'stage.started', { queueId: 'k1', source: 'battle', ids: [] });
  e(550, 'stage.ended', { queueId: 'k1', playedSec: 100 });
  stage(560, 'y1', ['S02'], 'q2'); stage(750, 'x2', ['S01'], 'q3');
  const es = require('../evening-stats');
  const original = es.computeStats;
  let journal = [];
  es.computeStats = (...a) => { if (a[0].events[0]?.boot === 'rejeu') journal = a[0].events; return original(...a); };
  let res;
  try { res = await rejeu.runFree(rejeu.loadEvening({ people: [{ key: 'S01', table: 'T1' }, { key: 'S02', table: 'T2' }],
    tables: [{ key: 'T1' }, { key: 'T2' }], events })); } finally { es.computeStats = original; }
  const stages = journal.filter(x => x.ev === 'stage.started').map(x => {
    const end = journal.find(y => y.ev === 'stage.ended' && y.queueId === x.queueId);
    return { source: x.source, start: x.t, end: end.t };
  });
  // Les deux passages hors file sont rejoués, avec leur durée réelle…
  assert.deepEqual(stages.filter(x => x.source !== 'queue').map(x => [x.source, (x.end - x.start) / 1000]), [['native', 240], ['battle', 100]]);
  // … et aucun titre de la file ne démarre pendant eux. Le titre hors file,
  // entré dans KaraFun pendant y1, retient l'envoi de x2 jusqu'à son passage ;
  // x2, envoyé pendant lui, passe avant la Battle entrée ensuite.
  for (let k = 1; k < stages.length; k++) assert.ok(stages[k].start >= stages[k - 1].end, JSON.stringify(stages));
  assert.deepEqual(stages.map(x => x.source), ['queue', 'queue', 'native', 'queue', 'battle']);
  // Comme au serveur : le suivant se réserve pendant le titre hors file ;
  // rien ne part pendant la Battle faite dans KaraFun, qui retient la file.
  const native = stages[2], external = stages[4];
  assert.ok(res.decisions.some(d => d.kind === 'reserve' && d.at >= native.start && d.at < native.start + 45000),
    JSON.stringify(res.decisions.map(d => [d.kind, (d.at - T0) / 1000])));
  assert.ok(!res.decisions.some(d => ['reserve', 'send'].includes(d.kind) && d.at >= external.start && d.at < external.end));
  // Titre demandé pendant une Battle faite dans KaraFun : il attend sa fin.
  const during = [];
  const d = (t, name, f = {}) => during.push({ v: 1, seq: during.length + 1, t: T0 + t * 1000, ev: name, ...f });
  d(0, 'evening.started', { rules: {} });
  for (const t of ['T1', 'T2']) d(0, 'table.opened', { tableId: t });
  for (const [k, t] of [['S01', 'T1'], ['S02', 'T2']]) d(0, 'person.joined', { personId: k, tableId: t });
  d(1, 'song.requested', { personId: 'S01', entryId: 'x1', songId: 1, title: 'x1', mode: 'append' });
  d(5, 'turn.sent', { entryId: 'x1', ownerId: 'S01', ids: ['S01'], queueId: 'q1' });
  d(10, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
  d(190, 'stage.ended', { queueId: 'q1', playedSec: 180 });
  d(200, 'stage.started', { queueId: 'k1', source: 'battle', ids: [] });
  d(250, 'song.requested', { personId: 'S02', entryId: 'y1', songId: 2, title: 'y1', mode: 'append' });
  d(400, 'stage.ended', { queueId: 'k1', playedSec: 200 });
  d(405, 'turn.sent', { entryId: 'y1', ownerId: 'S02', ids: ['S02'], queueId: 'q2' });
  d(410, 'stage.started', { entryId: 'y1', ids: ['S02'], queueId: 'q2', source: 'queue', title: 'y1' });
  d(590, 'stage.ended', { queueId: 'q2', playedSec: 180 });
  const held = await rejeu.runFree(rejeu.loadEvening({ people: [{ key: 'S01', table: 'T1' }, { key: 'S02', table: 'T2' }],
    tables: [{ key: 'T1' }, { key: 'T2' }], events: during }));
  assert.ok(held.passages.find(p => p.entryId === 'y1').sentAt >= T0 + 400000, JSON.stringify(held.passages));
  // Passage réservé pendant un titre hors file de 30 s, Battle décidée
  // ensuite : comme au serveur, le titre réservé part avant la Battle.
  const reserved = [];
  const r = (t, name, f = {}) => reserved.push({ v: 1, seq: reserved.length + 1, t: T0 + t * 1000, ev: name, ...f });
  r(0, 'evening.started', { rules: {} });
  for (const t of ['T1', 'T2']) r(0, 'table.opened', { tableId: t });
  for (const [k, t] of [['S01', 'T1'], ['S02', 'T2']]) r(0, 'person.joined', { personId: k, tableId: t });
  r(1, 'song.requested', { personId: 'S01', entryId: 'x1', songId: 1, title: 'x1', mode: 'append' });
  r(5, 'turn.sent', { entryId: 'x1', ownerId: 'S01', ids: ['S01'], queueId: 'q1' });
  r(10, 'stage.started', { entryId: 'x1', ids: ['S01'], queueId: 'q1', source: 'queue', title: 'x1' });
  r(190, 'stage.ended', { queueId: 'q1', playedSec: 180 });
  r(200, 'stage.started', { queueId: 'n1', source: 'native', ids: [] });
  r(205, 'song.requested', { personId: 'S02', entryId: 'y1', songId: 2, title: 'y1', mode: 'append' });
  r(210, 'battle.decided', { ballotId: 'v1', outcome: 'approved' });
  r(230, 'stage.ended', { queueId: 'n1', playedSec: 30 });
  r(235, 'turn.sent', { entryId: 'y1', ownerId: 'S02', ids: ['S02'], queueId: 'q2' });
  r(236, 'battle.automation', { ballotId: 'v1', status: 'sending' });
  r(240, 'stage.started', { entryId: 'y1', ids: ['S02'], queueId: 'q2', source: 'queue', title: 'y1' });
  r(420, 'stage.ended', { queueId: 'q2', playedSec: 180 });
  r(430, 'battle.automation', { ballotId: 'v1', status: 'playing' });
  r(430, 'stage.started', { queueId: 'b1', source: 'battle', ids: [] });
  r(530, 'stage.ended', { queueId: 'b1', playedSec: 100 });
  const beforeBattle = await rejeu.runFree(rejeu.loadEvening({ people: [{ key: 'S01', table: 'T1' }, { key: 'S02', table: 'T2' }],
    tables: [{ key: 'T1' }, { key: 'T2' }], events: reserved }));
  assert.ok(beforeBattle.passages.find(p => p.entryId === 'y1').sentAt < T0 + 300000, JSON.stringify(beforeBattle.passages));
  assert.equal(res.notReplayed['battle.external'], undefined);
});

test('bilan avant/après : un seul côté sans Timefold, note pour le même code, alerte sinon', async () => {
  const cmp = await rejeu.runCompare(ev, { before: { code: path.join(__dirname, '..') } });
  const oneSide = (side, sameCode) => rejeu.compareReport({ ...cmp, sameCode,
    [side]: { ...cmp[side], solver: true } }, { short: true });
  assert.equal(cmp.sameCode, true);
  assert.match(oneSide('after', true), /\n {2}NOTE avant sans Timefold : ce bilan mesure l'apport de Timefold/);
  assert.match(oneSide('before', true), /\n {2}NOTE après sans Timefold/);
  assert.match(oneSide('after', false), /\n {2}ATTENTION avant sans Timefold et version différente/);
  for (const text of [oneSide('after', true), oneSide('after', false)]) assert.doesNotMatch(text, /ATTENTION rejeu sans Timefold/);
  // Indice de Jain : toute baisse est « moins bien » (AGENTS.md), même de 0,002.
  const lower = { ...cmp.after, balance: { ...cmp.after.balance,
    replay: { ...cmp.after.balance.replay, jain: cmp.before.balance.replay.jain - 0.002 } } };
  const jainText = rejeu.compareReport({ ...cmp, after: lower }, { short: true });
  assert.match(jainText, /indice de Jain[^\n]*MOINS BIEN/);
  assert.match(jainText, /équilibre \(Jain\) [\d,]+ → [\d,]+ \(MOINS BIEN\)/);
  // Timefold lancé mais sans aucun plan : à réparer, ni « relancer avec
  // --solveur » ni « apport de Timefold ».
  const noPlan = r => ({ ...r, solver: false, jar: '/x/solver/target/karafun-solver.jar', timefold: { asked: 5, ok: 0, failed: 5, lastError: 'x' } });
  const broken = rejeu.compareReport({ ...cmp, before: noPlan(cmp.before), after: { ...cmp.after, solver: true } }, { short: true });
  assert.match(broken, /\n {2}avant : .* \[Timefold sans plan, 0\/5\] ;/);
  assert.match(broken, /\n {2}ATTENTION Timefold lancé sans plan \(avant : \/x\/solver\/target\/karafun-solver\.jar\) : vérifier ce jar et Java.*--solveur-avant/);
  assert.match(broken, /\n {2}ATTENTION avant sans plan Timefold : l'écart vient de la panne du solveur/);
  assert.doesNotMatch(broken, /NOTE|apport de Timefold/);
  const both = rejeu.compareReport({ ...cmp, before: noPlan(cmp.before), after: noPlan(cmp.after) }, { short: true });
  assert.match(both, /ATTENTION Timefold lancé sans plan \(avant : \S+ ; après : \S+\).*les deux côtés sont rejoués/);
  assert.doesNotMatch(both, /relancer avec --solveur/);
});

test('rejeu : attente avec un temps sans titre, fenêtre des anomalies depuis readySince ; sortie --cles et caractères de contrôle', async () => {
  // Soirée minimale : p retire son seul titre à 6 min, en redemande un à 20
  // (aucun envoi entre les deux), chanté à 30.
  const T0 = Date.UTC(2026, 9, 15, 19, 0);
  const T = m => T0 + m * 60000;
  const events = [];
  const e = (m, ev, fields = {}) => events.push({ v: 1, seq: events.length + 1, t: T(m), ev, ...fields });
  e(0, 'app.started', { restored: false, offlineMs: 0 });
  e(0, 'person.joined', { personId: 'S01', tableId: 'T1' });
  e(0, 'person.joined', { personId: 'S02', tableId: 'T2' });
  e(1, 'song.requested', { personId: 'S01', entryId: 'a1', songId: 1, title: 'a1', mode: 'append' });
  e(6, 'song.removed', { personId: 'S01', entryId: 'a1', by: 'self' });
  e(20, 'song.requested', { personId: 'S01', entryId: 'a2', songId: 2, title: 'a2', mode: 'append' });
  e(29, 'turn.sent', { entryId: 'a2', ids: ['S01'], ownerId: 'S01', queueId: 'q1' });
  e(30, 'stage.started', { queueId: 'q1', entryId: 'a2', ids: ['S01'], ownerId: 'S01', source: 'queue', title: 'a2' });
  e(34, 'stage.ended', { queueId: 'q1', playedSec: 240 });
  const raw = { people: [{ key: 'S01', table: 'T1', name: 'Zo\u001b[2Jé\u202e' }, { key: 'S02', table: 'T2', name: 'S02' }],
    tables: [{ key: 'T1' }, { key: 'T2' }], events };
  const ev2 = rejeu.loadEvening(raw);
  const [w] = rejeu.computeWaits(ev2.realPassages, ev2);
  assert.equal(w.waitSec, (30 - 1 - 14) * 60, 'les 14 min sans titre ne comptent pas');
  assert.equal(w.readyAt, T(1), 'fenêtre des anomalies depuis le début réel de l’attente');
  // Caractères de contrôle d'un prénom neutralisés à l'affichage, prénom absent avec --cles.
  const res = await rejeu.runForced(ev2);
  assert.doesNotMatch(rejeu.report(res), /[\u001b\u202e]/);
  const out = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-cles-'));
  try {
    const file = path.join(dir, 'soiree.json');
    fs.writeFileSync(file, JSON.stringify(raw));
    assert.equal(await rejeu.main([file, '--cles', '--json', path.join(dir, 'r.json')], l => out.push(l)), 0);
    assert.doesNotMatch(out.join('\n') + fs.readFileSync(path.join(dir, 'r.json'), 'utf8'), /Zo/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache des versions extraites : dossier ou parent modifiable par d’autres refusé', { skip: process.platform === 'win32' && 'droits POSIX' }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-cache-sur-'));
  const saved = process.env.KARAFUN_REJEU_CACHE;
  t.after(() => {
    if (saved === undefined) delete process.env.KARAFUN_REJEU_CACHE; else process.env.KARAFUN_REJEU_CACHE = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const open = path.join(tmp, 'ouvert'); fs.mkdirSync(open); fs.chmodSync(open, 0o777);
  const group = path.join(tmp, 'groupe'); fs.mkdirSync(group); fs.chmodSync(group, 0o770);
  const target = path.join(tmp, 'cible'); fs.mkdirSync(target, { mode: 0o700 });
  const link = path.join(tmp, 'lien'); fs.symlinkSync(target, link);
  const shared = path.join(tmp, 'partage'); fs.mkdirSync(shared); fs.chmodSync(shared, 0o777);
  const under = path.join(shared, 'cache');
  for (const [dir, empty] of [[open, open], [group, group], [link, target], [under, null]]) {
    process.env.KARAFUN_REJEU_CACHE = dir;
    const err = [];
    assert.equal(await rejeu.main([FIXTURE, '--avant', 'HEAD', '--court'], () => {}, l => err.push(l)), 1, dir);
    assert.match(err.join('\n'), /^Cache des versions extraites non sûr/);
    if (empty) assert.deepEqual(fs.readdirSync(empty), [], 'rien extrait');
    else assert.ok(!fs.existsSync(dir), 'cache pas créé sous un parent non sûr');
  }
});

test('bilan avant/après : révision git extraite à part, dépôt intact', async t => {
  const repo = path.join(__dirname, '..');
  const git = args => require('node:child_process').execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  let sha;
  try { sha = git(['rev-parse', 'HEAD']).trim(); } catch (_) { t.skip('pas de dépôt git'); return; }
  // Cache propre au test : l'extraction a lieu à chaque fois, puis disparaît.
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-cache-'));
  const saved = process.env.KARAFUN_REJEU_CACHE;
  process.env.KARAFUN_REJEU_CACHE = cache;
  t.after(() => {
    if (saved === undefined) delete process.env.KARAFUN_REJEU_CACHE; else process.env.KARAFUN_REJEU_CACHE = saved;
    fs.rmSync(cache, { recursive: true, force: true });
  });
  const status = git(['status', '--porcelain']);
  const lines = [];
  assert.equal(await rejeu.main([FIXTURE, '--avant', 'HEAD', '--court'], l => lines.push(l), l => lines.push(l)), 0);
  const text = lines.join('\n');
  assert.match(text, new RegExp(`avant : HEAD \\(${sha.slice(0, 7)}\\) \\[sans Timefold\\]`));
  assert.match(text, /après : version de travail \[sans Timefold\]/);
  assert.match(text, /ATTENTION rejeu sans Timefold/);
  assert.ok(fs.existsSync(path.join(cache, sha, 'scheduler.js')));
  assert.deepEqual(fs.readdirSync(cache), [sha], 'aucun dossier temporaire laissé');
  assert.equal(git(['status', '--porcelain']), status, 'index et copie de travail intacts');
  // Copie de travail propre : la version extraite rejoue comme la version de travail.
  if (!status.trim()) assert.match(text, /Verdict : 0 indicateur mieux, 0 moins bien/);
  // Ménage : 6 anciennes extractions (marquées), un dossier étranger, une copie
  // interrompue vieille de 2 h. Restent les 5 plus récentes et le dossier étranger.
  const old = new Date(Date.now() - 2 * 3600_000);
  const fakes = Array.from({ length: 6 }, (_, k) => String(k + 1).repeat(40));
  fakes.forEach((name, k) => {
    fs.mkdirSync(path.join(cache, name));
    fs.writeFileSync(path.join(cache, name, '.rejeu-ok'), `${name}\n`);
    const t = new Date(Date.now() - (10 - k) * 60_000);
    fs.utimesSync(path.join(cache, name), t, t);
  });
  const foreign = 'f'.repeat(40);
  fs.mkdirSync(path.join(cache, foreign));
  fs.utimesSync(path.join(cache, foreign), old, old);
  const stale = path.join(cache, `${sha}.tmp-abcdef`);
  fs.mkdirSync(stale);
  fs.utimesSync(stale, old, old);
  fs.rmSync(path.join(cache, sha), { recursive: true }); // nouvelle extraction de HEAD
  assert.equal(await rejeu.main([FIXTURE, '--avant', sha, '--court'], () => {}, () => {}), 0);
  assert.deepEqual(fs.readdirSync(cache).sort(), [sha, ...fakes.slice(2), foreign].sort());
});

test('rejeu : un seul à la fois, et version « avant » inutilisable dite en une ligne', async t => {
  const real = Date.now;
  const [a, b] = await Promise.allSettled([rejeu.runFree(ev), rejeu.runFree(ev)]);
  assert.equal(a.status, 'fulfilled');
  assert.match(String(b.reason?.message), /déjà en cours/);
  assert.equal(Date.now, real, 'horloge rendue');
  const dirs = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-avant-'));
  t.after(() => fs.rmSync(dirs, { recursive: true, force: true }));
  const version = (name, source) => {
    const dir = path.join(dirs, name);
    fs.mkdirSync(dir);
    if (source) fs.writeFileSync(path.join(dir, 'scheduler.js'), source);
    return dir;
  };
  const run = async dir => {
    const err = [];
    const code = await rejeu.main([FIXTURE, '--avant', dir, '--court'], () => {}, l => err.push(l));
    return { code, err: err.join('\n') };
  };
  const link = path.join(dirs, 'lien-qui-plante');
  const cases = [
    [version('vide'), /pas de scheduler\.js/],
    [version('sans-methodes', 'class Scheduler {}\nmodule.exports = { Scheduler };\n'),
      /pas de méthode _maybeRequestSolver, version trop éloignée de l'outil de rejeu/],
    [version('qui-plante', 'class Scheduler { constructor() { throw new TypeError(\'boum\'); } }\nmodule.exports = { Scheduler };\n'),
      /^Rejeu impossible avec .*qui-plante : boum \(at .*\) ; version trop éloignée de l'outil de rejeu \?$/],
  ];
  if (process.platform !== 'win32') {
    fs.symlinkSync(cases[2][0], link);
    cases.push([link, /^Rejeu impossible avec .*lien-qui-plante : boum \(at .*\) ; version trop éloignée de l'outil de rejeu \?$/]);
  }
  for (const [dir, message] of cases) {
    const r = await run(dir);
    assert.equal(r.code, 1, dir);
    assert.match(r.err, message);
    assert.doesNotMatch(r.err, /\n\s+at /);
  }
});

test('rejeu libre : demande pour rejoindre, fermeture retirée, « Je suis là » et gestes signalés', async () => {
  const raw = structuredClone(ev.raw);
  const events = raw.events;
  // Premier titre solo resté au moins 20 min en attente, demandé alors qu'une
  // autre personne de la table était inscrite.
  const startOf = new Map(events.filter(e => e.ev === 'stage.started' && e.entryId).map(e => [e.entryId, e.t]));
  const tableOf = new Map();
  let target = null;
  for (const e of events) {
    if (e.ev === 'person.joined') tableOf.set(e.personId, e.tableId);
    if (e.ev !== 'song.requested' || target || !(startOf.get(e.entryId) > e.t + 20 * 60000)) continue;
    const mate = [...tableOf].find(([pid, tid]) => pid !== e.personId && tid === tableOf.get(e.personId))?.[0];
    if (mate && !events.some(x => x.entryId === e.entryId && /^duo\./.test(x.ev))) target = { e, mate };
  }
  assert.ok(target, 'titre solo avec une personne de la même table');
  const at = adder(events);
  at(target.e.t + 1000, 'duo.joinRequested',
    { requesterId: target.mate, ownerId: target.e.personId, entryId: target.e.entryId, direct: true });
  // Heure de fermeture posée puis retirée par le bar, vidage de la file à la fin.
  const first = events.find(e => e.ev === 'stage.started');
  at(first.t + 3600000, 'closing.set', { closingAt: first.t + 4200000 });
  at(first.t + 3601000, 'closing.cleared', {});
  const last = events.filter(e => e.ev === 'stage.started').at(-1);
  at(last.t - 1000, 'staff.queueCleared', {});
  // « Pas prêt » d'un titre, non rejoué.
  at(first.t + 600000, 'defer.requested', { entryId: target.e.entryId, ownerId: target.e.personId, songs: 1 });
  at(first.t + 660000, 'defer.ended', { entryId: target.e.entryId });
  // « Je suis là » rendu obligatoire en cours de soirée par le bar.
  at(first.t + 1800000, 'settings.changed', { setting: 'requirePresence', from: false, to: true });
  const res = await rejeu.runFree(rejeu.loadEvening(raw), { options: { requirePresence: true } });
  const duo = res.passages.find(p => p.entryId === target.e.entryId);
  assert.deepEqual(duo?.ids, [target.e.personId, target.mate], 'duo rejoint rejoué');
  assert.equal(res.passages.length, 56, 'fermeture retirée et « Je suis là » obligatoire : tout est chanté');
  assert.equal(res.warnings.filter(w => /« Je suis là » obligatoire non rejoué/.test(w)).length, 1, 'avertissement une seule fois');
  assert.equal(res.notReplayed['staff.queueCleared'], 1);
  // Vidage non rejoué : signalé, et hors du journal rejoué (il couperait les attentes des titres gardés).
  assert.ok(res.warnings.some(w => /^« Vider toutes les chansons » du bar non rejoué/.test(w)), res.warnings.join(' | '));
  assert.deepEqual(rejeu.replayJournal(rejeu.loadEvening(raw), []).filter(e => /^(staff\.queueCleared|defer\.)/.test(e.ev)), []);
  assert.match(rejeu.report(res, { short: true }), /gestes non rejoués : .*staff\.queueCleared×1/);
  // Sans l'option, le réglage pris en cours de soirée est aussi rejoué sans.
  const raw2 = structuredClone(ev.raw);
  adder(raw2.events)(first.t + 1800000, 'settings.changed', { setting: 'requirePresence', from: false, to: true });
  const res2 = await rejeu.runFree(rejeu.loadEvening(raw2));
  assert.equal(res2.passages.length, 56);
  assert.equal(res2.warnings.filter(w => /« Je suis là » obligatoire non rejoué/.test(w)).length, 1);
});

test('rejeu libre : demande acceptée d’une autre table, demande annulée, place cédée', async () => {
  const raw = structuredClone(ev.raw);
  const events = raw.events;
  const at = adder(events);
  const startOf = new Map(events.filter(e => e.ev === 'stage.started' && e.entryId).map(e => [e.entryId, e.t]));
  const tableOf = new Map(events.filter(e => e.ev === 'person.joined').map(e => [e.personId, e.tableId]));
  const joinedAt = new Map(events.filter(e => e.ev === 'person.joined').map(e => [e.personId, e.t]));
  const solos = events.filter(e => e.ev === 'song.requested' && startOf.get(e.entryId) > e.t + 20 * 60000 &&
    !events.some(x => x.entryId === e.entryId && /^duo\./.test(x.ev)));
  // Demande d'une personne d'une autre table, acceptée deux minutes après.
  const a = solos.find(e => [...tableOf].some(([pid, tid]) => tid !== tableOf.get(e.personId) && joinedAt.get(pid) < e.t));
  const other = [...tableOf].find(([pid, tid]) => tid !== tableOf.get(a.personId) && joinedAt.get(pid) < a.t)[0];
  at(a.t + 1000, 'duo.joinRequested', { requesterId: other, ownerId: a.personId, entryId: a.entryId, direct: false });
  at(a.t + 120000, 'duo.joinAnswered', { personId: a.personId, ownerId: a.personId, requesterId: other, entryId: a.entryId, accepted: true });
  // Autre demande, annulée par son auteur avant toute réponse.
  const b = solos.find(e => e !== a && e.personId !== a.personId && [...tableOf].some(([pid, tid]) => tid !== tableOf.get(e.personId) && joinedAt.get(pid) < e.t && pid !== other));
  const third = [...tableOf].find(([pid, tid]) => tid !== tableOf.get(b.personId) && joinedAt.get(pid) < b.t && pid !== other)[0];
  at(b.t + 1000, 'duo.joinRequested', { requesterId: third, ownerId: b.personId, entryId: b.entryId, direct: false });
  at(b.t + 60000, 'duo.joinCancelled', { requesterId: third, ownerId: b.personId, entryId: b.entryId });
  // Place cédée à une personne de la même table.
  const c = solos.find(e => [...tableOf].some(([pid, tid]) => pid !== e.personId && tid === tableOf.get(e.personId) && joinedAt.get(pid) < e.t));
  const mate = [...tableOf].find(([pid, tid]) => pid !== c.personId && tid === tableOf.get(c.personId) && joinedAt.get(pid) < c.t)[0];
  at(c.t + 2000, 'person.gaveSpot', { personId: c.personId, toId: mate });
  const res = await rejeu.runFree(rejeu.loadEvening(raw));
  assert.deepEqual(res.passages.find(p => p.entryId === a.entryId)?.ids, [a.personId, other], 'demande acceptée : duo');
  assert.deepEqual(res.passages.find(p => p.entryId === b.entryId)?.ids, [b.personId], 'demande annulée : solo');
  assert.deepEqual(res.notes.filter(n => /joinRequested|joinAnswered|joinCancelled|gaveSpot/.test(n)), [], 'tout rejoué sans erreur');
});

test('rejeu libre : retrait réel d’un titre déjà chanté dans le rejeu, et demandes refusées, hors du journal', async () => {
  const base = await rejeu.runFree(ev);
  const raw = structuredClone(ev.raw);
  // Titre chanté dans le rejeu, retiré « faute de Je suis là » une minute après :
  // ce retrait ne doit pas couper l'attente des titres suivants de la personne.
  const p = base.passages.find((x, k) => base.passages.slice(k + 1).some(q => q.owner === x.owner));
  adder(raw.events)(p.end + 60000, 'song.removed', { personId: p.owner, entryId: p.entryId, by: 'presence-max' });
  const res = await rejeu.runFree(rejeu.loadEvening(raw));
  const next = r => r.passages.filter(q => q.owner === p.owner && q.start > p.end).map(q => q.waitSec);
  assert.deepEqual(next(res), next(base));
  // Personne inconnue : demande non rejouée, signalée en avertissement.
  const raw2 = structuredClone(ev.raw);
  adder(raw2.events)(p.end, 'song.requested', { personId: 'S99', entryId: 'fantome', songId: 1, title: 'Fantôme', durationSec: 200 });
  const res2 = await rejeu.runFree(rejeu.loadEvening(raw2));
  assert.ok(res2.warnings.includes('1 demande de titre non rejouée (voir les notes)'), res2.warnings.join(' | '));
});

test('rejeu libre : heure de fermeture avancée, titres perdus signalés', async () => {
  const raw = structuredClone(ev.raw);
  const first = raw.events.find(e => e.ev === 'stage.started');
  adder(raw.events)(first.t + 60000, 'closing.set', { closingAt: first.t + 3600000 });
  const res = await rejeu.runFree(rejeu.loadEvening(raw));
  assert.ok(res.passages.length < 56);
  assert.ok(res.warnings.includes(`le rejeu chante ${res.passages.length} titres de la file, la soirée 56`), res.warnings.join(' | '));
});

test('bilan avant/après : evening-stats.js différent dans la version « avant », signalé', async t => {
  const repo = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-stats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of ['scheduler.js', 'song-repeats.js', 'lib', path.join('solver', 'bridge.js')]) {
    fs.cpSync(path.join(repo, f), path.join(dir, f), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'evening-stats.js'), fs.readFileSync(path.join(repo, 'evening-stats.js'), 'utf8') + '\n// autre version\n');
  const cmp = await rejeu.runCompare(ev, { before: { code: dir } });
  assert.equal(cmp.statsDiffer, true);
  assert.match(rejeu.compareReport(cmp, { short: true }), /ATTENTION evening-stats\.js diffère entre les deux versions/);
  const same = await rejeu.runCompare(ev, { before: { code: repo } });
  assert.equal(same.statsDiffer, false);
});

test('rejeu avec un jar Timefold inutilisable : avertissement, pas de faux « [Timefold] » muet', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-jar-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jar = path.join(dir, 'faux.jar');
  fs.writeFileSync(jar, 'pas un jar');
  const until = ev.events.find(e => e.ev === 'turn.sent' && rejeu.timeOf(e.t) === '21:06:30').t;
  const res = await rejeu.runForced(ev, { solver: jar, budget: 200, until });
  assert.equal(res.timefold.ok, 0);
  assert.ok(res.timefold.asked > 0);
  assert.ok(res.warnings.some(w => /^Timefold n'a rendu aucun plan sur \d+ demandes/.test(w)), res.warnings.join(' | '));
  // Aucun plan : compté sans Timefold (étiquette et bilan avant/après).
  assert.equal(res.solver, false);
  assert.match(rejeu.report(res, { short: true }), /^REJEU FORCÉ \[Timefold sans plan\]\nATTENTION Timefold n'a rendu aucun plan/);
  // Limite de mouvements par défaut, le budget donné reste son plafond ; la
  // configuration du solveur écrite pour ce rejeu est effacée ensuite.
  assert.deepEqual([res.timefold.moves, res.timefold.budgetMs], [20000, 200]);
  assert.deepEqual(solverDirs(), dirsBefore);
  // Dossier laissé par un rejeu interrompu : effacé au rejeu suivant après un
  // jour, pas avant.
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-timefold-'));
  const recent = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-timefold-'));
  fs.utimesSync(stale, new Date(Date.now() - 25 * 3600_000), new Date(Date.now() - 25 * 3600_000));
  await rejeu.runForced(ev, { solver: jar, budget: 200, until });
  assert.deepEqual([fs.existsSync(stale), fs.existsSync(recent)], [false, true]);
  fs.rmSync(recent, { recursive: true });
  const timeOnly = await rejeu.runForced(ev, { solver: jar, budget: 200, moves: 0, until });
  assert.deepEqual([timeOnly.timefold.moves, timeOnly.timefold.budgetMs], [0, 200]);
  // Version sans configuration du solveur dans ses sources : limite non
  // appliquée, dite (le temps décide alors du résultat).
  const copy = path.join(dir, 'version');
  for (const f of ['scheduler.js', 'song-repeats.js', 'evening-stats.js', 'lib', path.join('solver', 'bridge.js')]) {
    fs.cpSync(path.join(__dirname, '..', f), path.join(copy, f), { recursive: true });
  }
  const cmp = await rejeu.runCompare(ev, { before: { code: copy, solver: jar }, after: { solver: false }, budget: 200 });
  assert.equal(cmp.before.timefold.moves, 0);
  assert.ok(cmp.before.warnings.some(w => /^limite de 20 000 mouvements non appliquée \(configuration du solveur introuvable dans .*version\) : Timefold limité au temps/.test(w)),
    cmp.before.warnings.join(' | '));
  assert.deepEqual(solverDirs(), dirsBefore);
});

test('rejeu libre avec Timefold : une file de moins de deux titres n’est pas un échec',
  { skip: !fs.existsSync(JAR) && 'jar Timefold absent' }, async () => {
    const res = await rejeu.runFree(ev, { solver: JAR, moves: 1000 });
    assert.ok(res.timefold.ok > 0);
    assert.equal(res.timefold.failed, 0, JSON.stringify(res.timefold));
    assert.deepEqual(res.warnings.filter(w => /Timefold/.test(w)), []);
  });

test('jar d’une révision extraite : verrou Maven abandonné repris, jar construit gardé',
  { skip: process.platform === 'win32' && 'faux mvn en script shell' }, async t => {
    const repo = path.join(__dirname, '..');
    let sha;
    try { sha = require('node:child_process').execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch (_) {
      t.skip('pas de dépôt git'); return;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-mvn-'));
    const saved = { cache: process.env.KARAFUN_REJEU_CACHE, path: process.env.PATH };
    process.env.KARAFUN_REJEU_CACHE = path.join(tmp, 'cache');
    t.after(() => {
      if (saved.cache === undefined) delete process.env.KARAFUN_REJEU_CACHE; else process.env.KARAFUN_REJEU_CACHE = saved.cache;
      process.env.PATH = saved.path;
      fs.rmSync(tmp, { recursive: true, force: true });
    });
    // Extraction d'abord, puis verrou laissé il y a 3 h par une construction interrompue.
    assert.equal(await rejeu.main([FIXTURE, '--avant', sha, '--court'], () => {}, () => {}), 0);
    const solver = path.join(tmp, 'cache', sha, 'solver');
    const lock = path.join(solver, '.rejeu-mvn.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 3 * 3600_000);
    fs.utimesSync(lock, old, old);
    // Faux mvn : écrit un jar (inutilisable) à côté du pom donné par -f.
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'mvn'), '#!/bin/sh\nwhile [ "$1" != "-f" ]; do shift; done\nd=$(dirname "$2")/target\nmkdir -p "$d" && echo faux > "$d/karafun-solver.jar"\n');
    fs.chmodSync(path.join(bin, 'mvn'), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    const fake = path.join(tmp, 'faux.jar');
    fs.writeFileSync(fake, 'faux');
    // Un autre rejeu reprend ce même verrou à l'instant : pas de seconde construction.
    const claim = `${lock}.reprise`;
    fs.writeFileSync(claim, '');
    const busy = [];
    assert.equal(await rejeu.main([FIXTURE, '--avant', sha, '--solveur', fake, '--budget', '200', '--court'], l => busy.push(l), l => busy.push(l)), 1);
    assert.match(busy.join('\n'), /construction déjà en cours/);
    assert.ok(!fs.existsSync(path.join(solver, 'target', 'karafun-solver.jar')), 'aucune construction pendant la reprise');
    fs.rmSync(claim);
    const out = [];
    assert.equal(await rejeu.main([FIXTURE, '--avant', sha, '--solveur', fake, '--budget', '200', '--court'], l => out.push(l), l => out.push(l)), 0);
    assert.ok(fs.existsSync(path.join(solver, 'target', 'karafun-solver.jar')), 'faux mvn lancé malgré le vieux verrou');
    assert.ok(fs.existsSync(path.join(solver, '.rejeu-jar-ok')));
    assert.ok(!fs.existsSync(lock), 'verrou rendu');
    assert.match(out.join('\n'), /ATTENTION avant : Timefold n'a rendu aucun plan/);
  });

test('rejeu forcé avec Timefold : l’égalité de 21:06:30 est départagée comme en réel',
  { skip: !fs.existsSync(JAR) && 'jar Timefold absent' }, async () => {
    // Jusqu'au nouveau tour de 21:49:51 seulement : un calcul court par décision.
    const until = ev.events.find(e => e.ev === 'turn.sent' && rejeu.timeOf(e.t) === '21:49:51').t;
    const res = await rejeu.runForced(ev, { solver: JAR, moves: 1000, until });
    const sends = res.decisions.filter(d => d.kind === 'send');
    assert.equal(sends.at(-1).time, '21:49:51');
    const tie = sends.find(d => d.time === '21:06:30');
    assert.equal(tie.match, true, `rejeu : ${ids(tie.pick)}`);
    assert.deepEqual(sends.filter(d => !d.match).map(d => d.time), []);
  });

test('rejeu avec Timefold : effort compté en mouvements, plafond de temps atteint signalé',
  { skip: !fs.existsSync(JAR) && 'jar Timefold absent' }, async () => {
    const until = ev.events.find(e => e.ev === 'turn.sent' && rejeu.timeOf(e.t) === '21:49:51').t;
    // 1 000 mouvements sous un plafond de 5 s : chaque décision s'arrête bien
    // avant le plafond (une limite ignorée prendrait 5 s à chaque fois).
    const started = Date.now();
    const res = await rejeu.runForced(ev, { solver: JAR, moves: 1000, budget: 5000, until });
    assert.ok(res.timefold.asked > 5 && res.timefold.ok === res.timefold.asked, JSON.stringify(res.timefold));
    assert.equal(res.timefold.ceiling, 0);
    // gstack-timing-ok: 1 000 mouvements prennent moins de 0,2 s par décision ; une limite ignorée en prend 5.
    assert.ok(Date.now() - started < res.timefold.asked * 2000, `${Date.now() - started} ms pour ${res.timefold.asked} décisions`);
    assert.match(rejeu.report(res, { short: true }), /^REJEU FORCÉ \[Timefold, 1 000 mouvements par décision\]\n(?!ATTENTION)/);
    assert.deepEqual(solverDirs(), dirsBefore);
    // Plafond plus court que la limite : le résultat dépend de la machine, dit.
    const short = await rejeu.runForced(ev, { solver: JAR, moves: 50_000_000, budget: 300, until });
    assert.equal(short.timefold.ceiling, short.timefold.asked);
    assert.ok(short.warnings.some(w => w.startsWith(`Timefold arrêté au plafond de 0,3 s avant 50 000 000 mouvements pour ${short.timefold.asked} décisions`)),
      short.warnings.join(' | '));
  });

test('Timefold : chaque calcul fait deux fois pour un solveur qui pouvait couper sa recherche, meilleure réponse gardée ; configuration non reconnue dite', async t => {
  const repo = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejeu-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jar = path.join(dir, 'faux.jar');
  fs.writeFileSync(jar, '');
  const main = fs.readFileSync(path.join(repo, 'solver/src/main/java/fr/karafun/plus/solver/Main.java'), 'utf8');
  // Ancien fil de lecture : la ligne déposée avant de lire la recherche en cours.
  const racy = main.replace(/Solver<QueuePlan> running = active\.get\(\);\n(\s*)inbox\.put\(line\);/,
    'inbox.put(line);\n$1Solver<QueuePlan> running = active.get();');
  assert.notEqual(racy, main);
  const xml = fs.readFileSync(path.join(repo, 'solver/src/main/resources/solverConfig.xml'), 'utf8');
  const version = (name, mainSource, config) => {
    const v = path.join(dir, name);
    for (const f of ['scheduler.js', 'song-repeats.js', 'evening-stats.js', 'lib']) fs.cpSync(path.join(repo, f), path.join(v, f), { recursive: true });
    const java = path.join(v, 'solver/src/main/java/fr/karafun/plus/solver');
    fs.mkdirSync(java, { recursive: true });
    fs.mkdirSync(path.join(v, 'solver/src/main/resources'), { recursive: true });
    fs.writeFileSync(path.join(java, 'Main.java'), mainSource);
    fs.writeFileSync(path.join(v, 'solver/src/main/resources/solverConfig.xml'), config);
    // Faux pont : rend l'ordre reçu et compte les demandes ; la réponse du
    // n-ième calcul d'une même demande vient de global.rejeuFakeAnswers[n].
    fs.writeFileSync(path.join(v, 'solver/bridge.js'), `'use strict';
class TimefoldBridge {
  constructor() { this.available = true; this.lastError = null; this.seen = new Map(); }
  solve(request) {
    global.rejeuFakeSolves = (global.rejeuFakeSolves || 0) + 1;
    const n = this.seen.get(request.requestId) || 0;
    this.seen.set(request.requestId, n + 1);
    const answer = (global.rejeuFakeAnswers || [])[n] || { score: '0hard/0medium/0soft', elapsedMs: 1 };
    if (answer.fail) return Promise.reject(new Error('calcul perdu'));
    return Promise.resolve({ requestId: request.requestId, order: request.performances.map(p => p.id),
      seedScore: '0hard/0medium/0soft', improved: false, ...answer });
  }
  close() {}
}
module.exports = { TimefoldBridge };
`);
    return v;
  };
  const until = ev.events.find(e => e.ev === 'turn.sent' && rejeu.timeOf(e.t) === '21:06:30').t;
  const solves = async (code, answers = []) => {
    global.rejeuFakeSolves = 0;
    global.rejeuFakeAnswers = answers;
    const res = await rejeu.runForced(ev, { code, solver: jar, until, budget: 1000 });
    return { res, calls: global.rejeuFakeSolves };
  };
  const oldVersion = version('ancienne', racy, xml);
  const old = await solves(oldVersion);
  assert.ok(old.res.timefold.asked > 3);
  assert.deepEqual([old.calls, old.res.timefold.retried], [2 * old.res.timefold.asked, old.res.timefold.asked]);
  assert.match(rejeu.report(old.res, { short: true }), /^REJEU FORCÉ \[Timefold, 20 000 mouvements par décision, chaque calcul fait deux fois/);
  // La meilleure des deux réponses est gardée (repérée ici par son temps :
  // au plafond, elle est comptée comme telle), même améliorée la première
  // fois ; un second calcul perdu laisse la première.
  const cut = { score: '0hard/-5medium/0soft', elapsedMs: 1, improved: true };
  const full = { score: '0hard/0medium/0soft', elapsedMs: 1000, improved: true };
  assert.equal((await solves(oldVersion, [cut, full])).res.timefold.ceiling, old.res.timefold.asked);
  assert.equal((await solves(oldVersion, [full, cut])).res.timefold.ceiling, old.res.timefold.asked);
  const lost = (await solves(oldVersion, [full, { fail: true }])).res.timefold;
  assert.deepEqual([lost.ok, lost.failed, lost.ceiling], [lost.asked, 0, lost.asked]);
  const fixed = await solves(version('corrigee', main, xml));
  assert.deepEqual([fixed.calls, fixed.res.timefold.retried, fixed.res.timefold.moves], [fixed.res.timefold.asked, 0, 20000]);
  // Configuration avec une seconde terminaison (de phase) : limite non appliquée.
  const phases = await solves(version('phases', main, xml.replace('</solver>', '  <localSearch><termination><stepCountLimit>9</stepCountLimit></termination></localSearch>\n</solver>')));
  assert.equal(phases.res.timefold.moves, 0);
  assert.ok(phases.res.warnings.some(w => /^limite de 20 000 mouvements non appliquée \(configuration du solveur non reconnue dans /.test(w)), phases.res.warnings.join(' | '));
  assert.deepEqual(solverDirs(), dirsBefore);
});
