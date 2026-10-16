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
  // Version « après » abîmée à la main : S05 perd un passage, S09 attend 20 min
  // de plus, l'équilibre baisse.
  const after = structuredClone(cmp.after);
  const people = after.balance.replay.people;
  people.S05.appearances -= 1;
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
  assert.match(losers, /\n {2}S05 : passages (\d+) → (?!\1)\d+/);
  assert.match(losers, /\n {2}S09 : .*plus longue attente d'un titre \d+ → \d+ min/);
  assert.match(text, /Verdict : .*1 moins bien.*2 personnes y perdent, 1 y gagne\./);
  assert.match(text, new RegExp(`→ +${Math.round(p.waitSec / 60)} min  S09`));
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
  const cases = [
    [version('vide'), /pas de scheduler\.js/],
    [version('sans-methodes', 'class Scheduler {}\nmodule.exports = { Scheduler };\n'),
      /pas de méthode _maybeRequestSolver, version trop éloignée de l'outil de rejeu/],
    [version('qui-plante', 'class Scheduler { constructor() { throw new TypeError(\'boum\'); } }\nmodule.exports = { Scheduler };\n'),
      /^Rejeu impossible avec .*qui-plante : boum \(at .*\) ; version trop éloignée de l'outil de rejeu \?$/],
  ];
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
  // Événement ajouté à son heure : numéro d'ordre juste après le dernier
  // événement de la soirée qui le précède.
  let extra = 0;
  const at = (t, ev, fields) => {
    const seq = Math.max(...events.filter(e => e.t <= t).map(e => e.seq)) + 0.5 + (extra += 0.001);
    events.push({ v: 1, t, seq, ev, ...fields });
  };
  at(target.e.t + 1000, 'duo.joinRequested',
    { requesterId: target.mate, ownerId: target.e.personId, entryId: target.e.entryId, direct: true });
  // Heure de fermeture posée puis retirée par le bar, vidage de la file à la fin.
  const first = events.find(e => e.ev === 'stage.started');
  at(first.t + 3600000, 'closing.set', { closingAt: first.t + 4200000 });
  at(first.t + 3601000, 'closing.cleared', {});
  const last = events.filter(e => e.ev === 'stage.started').at(-1);
  at(last.t - 1000, 'staff.queueCleared', {});
  const res = await rejeu.runFree(rejeu.loadEvening(raw), { options: { requirePresence: true } });
  const duo = res.passages.find(p => p.entryId === target.e.entryId);
  assert.deepEqual(duo?.ids, [target.e.personId, target.mate], 'duo rejoint rejoué');
  assert.equal(res.passages.length, 56, 'fermeture retirée et « Je suis là » obligatoire : tout est chanté');
  assert.ok(res.warnings.some(w => /« Je suis là » obligatoire non rejoué/.test(w)));
  assert.equal(res.notReplayed['staff.queueCleared'], 1);
  assert.match(rejeu.report(res, { short: true }), /gestes non rejoués : .*staff\.queueCleared×1/);
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
