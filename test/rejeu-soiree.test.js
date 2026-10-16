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

test('bilan avant/après : un seul côté sans Timefold, note pour le même code, alerte sinon', async () => {
  const cmp = await rejeu.runCompare(ev, { before: { code: path.join(__dirname, '..') } });
  const oneSide = (side, sameCode) => rejeu.compareReport({ ...cmp, sameCode,
    [side]: { ...cmp[side], solver: true } }, { short: true });
  assert.equal(cmp.sameCode, true);
  assert.match(oneSide('after', true), /\n {2}NOTE avant sans Timefold : ce bilan mesure l'apport de Timefold/);
  assert.match(oneSide('before', true), /\n {2}NOTE après sans Timefold/);
  assert.match(oneSide('after', false), /\n {2}ATTENTION avant sans Timefold et version différente/);
  for (const text of [oneSide('after', true), oneSide('after', false)]) assert.doesNotMatch(text, /ATTENTION rejeu sans Timefold/);
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
  const raw = { people: [{ key: 'S01', table: 'T1', name: 'Zo\u001b[2Jé' }, { key: 'S02', table: 'T2', name: 'S02' }],
    tables: [{ key: 'T1' }, { key: 'T2' }], events };
  const ev2 = rejeu.loadEvening(raw);
  const [w] = rejeu.computeWaits(ev2.realPassages, ev2);
  assert.equal(w.waitSec, (30 - 1 - 14) * 60, 'les 14 min sans titre ne comptent pas');
  assert.equal(w.readyAt, T(1), 'fenêtre des anomalies depuis le début réel de l’attente');
  // Caractères de contrôle d'un prénom neutralisés à l'affichage, prénom absent avec --cles.
  const res = await rejeu.runForced(ev2);
  assert.doesNotMatch(rejeu.report(res), /\u001b/);
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
  // « Je suis là » rendu obligatoire en cours de soirée par le bar.
  at(first.t + 1800000, 'settings.changed', { setting: 'requirePresence', from: false, to: true });
  const res = await rejeu.runFree(rejeu.loadEvening(raw), { options: { requirePresence: true } });
  const duo = res.passages.find(p => p.entryId === target.e.entryId);
  assert.deepEqual(duo?.ids, [target.e.personId, target.mate], 'duo rejoint rejoué');
  assert.equal(res.passages.length, 56, 'fermeture retirée et « Je suis là » obligatoire : tout est chanté');
  assert.equal(res.warnings.filter(w => /« Je suis là » obligatoire non rejoué/.test(w)).length, 1, 'avertissement une seule fois');
  assert.equal(res.notReplayed['staff.queueCleared'], 1);
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
  assert.match(rejeu.report(res, { short: true }), /^REJEU FORCÉ \[Timefold\]\nATTENTION Timefold n'a rendu aucun plan/);
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
