'use strict';
// Rejeu d'une vraie soirée (export anonymisé du 15 octobre 2026, clés S01… et
// T1… à la place des prénoms et des tables) avec test/rejeu-soiree.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const rejeu = require('./rejeu-soiree');

const FIXTURE = path.join(__dirname, 'fixtures', 'soiree-2026-10-15-anonyme.json');
const JAR = path.join(__dirname, '..', 'solver', 'target', 'karafun-solver.jar');
const ev = rejeu.loadEvening(FIXTURE);
let forced = null;
const forcedRun = async () => forced ||= await rejeu.runForced(ev);
const ids = d => d?.ids.join('+');
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
  // c1 est la chanson de a1 : le nouveau titre la remplace, chanté une fois,
  // et la demande reste dans le journal (pas de « demande non rejouée »).
  const same = await rejeu.runFree(rejeu.loadEvening(evening(1)));
  assert.deepEqual(same.passages.map(p => p.entryId), ['x1', 'c1']);
  assert.ok(same.passages.find(p => p.entryId === 'c1').waitSec > 0);
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
  e(250, 'duo.left', { personId: 'S03', guestId: 'S03', ownerId: 'S01', entryId: 'a1' });
  stage(400, 'a1', ['S01'], 'q3');
  events.sort((a, b) => a.t - b.t || a.seq - b.seq).forEach((x, i) => { x.seq = i + 1; });
  const raw = { people: ['S01', 'S02', 'S03', 'S04'].map(key => ({ key, table: ['S02', 'S04'].includes(key) ? 'T2' : 'T1' })),
    tables: [{ key: 'T1' }, { key: 'T2' }], events };
  const res = await rejeu.runFree(rejeu.loadEvening(raw));
  const a1 = res.passages.find(p => p.entryId === 'a1');
  assert.deepEqual(a1.ids, ['S01', 'S03']);
  assert.ok(a1.start < T0 + 250000 && a1.end > T0 + 250000, 'duo sur scène au départ réel de S03');
  assert.ok(res.notes.some(n => /duo\.left non rejoué/.test(n)), res.notes.join(' | '));
  assert.ok(res.notes.some(n => /song\.requested non rejoué : personne inconnue S99 z9$/.test(n)), res.notes.join(' | '));
  assert.equal(res.balance.replay.people.S03.guestTurns, 1);
  assert.equal(res.balance.real.people.S03?.guestTurns ?? 0, 0);
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
});

test('rejeu libre avec Timefold : une file de moins de deux titres n’est pas un échec',
  { skip: !fs.existsSync(JAR) && 'jar Timefold absent' }, async () => {
    const res = await rejeu.runFree(ev, { solver: JAR, budget: 200 });
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
    const res = await rejeu.runForced(ev, { solver: JAR, budget: 200, until });
    const sends = res.decisions.filter(d => d.kind === 'send');
    assert.equal(sends.at(-1).time, '21:49:51');
    const tie = sends.find(d => d.time === '21:06:30');
    assert.equal(tie.match, true, `rejeu : ${ids(tie.pick)}`);
    assert.deepEqual(sends.filter(d => !d.match).map(d => d.time), []);
  });
