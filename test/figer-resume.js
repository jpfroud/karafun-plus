'use strict';
/*
 * Statistiques figées (plan du 8 novembre, règle « Rotation » → « Statistiques
 * figées », A7) : écrit test/fixtures/soiree-2026-10-15-resume.json, le
 * résultat de computeStats et d'exportEvening de 1c15d72 sur la soirée du
 * 15 octobre (test/fixtures/soiree-2026-10-15-anonyme.json). Le rejeu mesure
 * les deux côtés avec l'evening-stats.js de la branche : il ne voit pas un
 * changement de computeStats. Le test figé d'evening-stats.test.js compare la
 * version de travail à ce fichier, champ par champ, avec les mêmes `meta` et
 * `now` (metaOf et NOW, exportés ici).
 *
 *   node test/figer-resume.js --ecrire
 *
 * - evening-stats.js vient de `git show 1c15d72:evening-stats.js`, chargé
 *   comme un module sans dépendance (tout require y lève) ;
 * - TZ=Europe/Paris est réglé par le script, puis rendu : l'export lit
 *   l'heure locale ;
 * - meta tirée de l'export (evening.id, evening.timezone, roster et tables
 *   faits de people et de tables, nom égal à la clé) ; now à l'heure t de la
 *   dernière ligne de la fixture ; live faux ;
 * - un fichier qui existe est refusé avant toute lecture de 1c15d72 : effacer
 *   le fichier pour le refaire.
 *
 * Codes de sortie (ceux de main() dans test/rejeu-soiree.js) : -h, --help ou
 * --aide, l'usage et 0 ; une option fausse, l'usage et 2 ; une erreur trouvée
 * en route (fichier qui existe, 1c15d72 absent, git en échec, cité), une ligne
 * sans pile et 1 ; une erreur imprévue, sa pile et 1.
 *
 * Programmatique : main(argv, { out, err, gitShow, outFile }) rend le code de
 * sortie ; gitShow et outFile ne servent qu'aux essais (gitShowStats({ cwd,
 * env }) lit 1c15d72 dans un autre clone, avec l'environnement donné).
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const COMMIT = '1c15d72';
const ZONE = 'Europe/Paris';
const FIXTURE = path.join(__dirname, 'fixtures', 'soiree-2026-10-15-anonyme.json');
const RESUME = path.join(__dirname, 'fixtures', 'soiree-2026-10-15-resume.json');
const rel = file => path.relative(ROOT, file).split(path.sep).join('/');

const USAGE = [
  'Usage : node test/figer-resume.js --ecrire',
  `  Écrit ${rel(RESUME)} : computeStats et exportEvening de ${COMMIT}`,
  `  (git show ${COMMIT}:evening-stats.js) sur ${rel(FIXTURE)},`,
  `  sous TZ=${ZONE}, réglé par le script ; meta tirée de l'export, now à l'heure de sa dernière ligne.`,
  '  Un fichier qui existe déjà est refusé : efface-le d\'abord pour le refaire.',
  '  -h, --help, --aide   cette aide',
  'Codes de sortie : 0 fichier écrit (ou aide) ; 1 refus ou erreur ; 2 option fausse.',
].join('\n');

// Erreur trouvée en route : une ligne, sans pile.
class UsageError extends Error {}

const FIXTURE_DATA = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
// Heure t de la dernière ligne de la fixture : 1792103188419, le 16 octobre
// à 00:26:28 à Paris. Seul exportedAt en dépend.
const NOW = FIXTURE_DATA.events.at(-1).t;

// meta d'une soirée tirée de son export : prénom égal à la clé.
function metaOf(exported) {
  const people = Array.isArray(exported?.people) ? exported.people : [];
  const tables = Array.isArray(exported?.tables) ? exported.tables : [];
  return {
    eveningId: exported?.evening?.id ?? null,
    timezone: exported?.evening?.timezone ?? null,
    roster: Object.fromEntries(people.filter(p => typeof p?.key === 'string')
      .map(p => [p.key, { name: p.key, tableId: p.table ?? null }])),
    tables: Object.fromEntries(tables.filter(tb => typeof tb?.key === 'string')
      .map(tb => [tb.key, { name: tb.key, individual: !!tb.individual }])),
  };
}

// Exécute `run` sous le fuseau `zone`, puis rend TZ telle qu'elle était
// (comme inZone de test/fuseau.test.js).
function inZone(zone, run) {
  const originalTz = process.env.TZ;
  const originalZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = zone;
  try {
    const got = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (got !== zone) throw new UsageError(`Fuseau ${zone} non pris en compte par Node (${got}) : statistiques non figées.`);
    return run();
  } finally {
    // Sous Windows, Node ne suit TZ que quand elle reçoit une valeur : le
    // fuseau d'origine est redonné avant le retrait (sans effet ailleurs).
    if (originalTz === undefined) { process.env.TZ = originalZone; delete process.env.TZ; }
    else process.env.TZ = originalTz;
  }
}

// Ligne de git qui dit que 1c15d72 manque au dépôt (clone partiel). « path …
// does not exist in '1c15d72' » n'en est pas une : 1c15d72 y est, sans le
// fichier, et git fetch --unshallow n'y ferait rien.
const COMMIT_MISSING = /invalid object name|unknown revision/i;

// Source d'evening-stats.js à 1c15d72. `env` : celui du processus, sauf pour
// les essais, qui lisent un dépôt jetable sans le dépôt d'un crochet git en
// cours (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE). git parle anglais (LC_ALL=C)
// pour que sa sortie d'erreur se lise partout : 1c15d72 absent a son remède ;
// tout autre échec (copie sans dépôt, dépôt refusé par safe.directory, objet
// corrompu) cite la ligne fatale de git, après ses avertissements.
function gitShowStats({ cwd = ROOT, env = process.env } = {}) {
  try {
    return execFileSync('git', ['show', `${COMMIT}:evening-stats.js`],
      { cwd, env: { ...env, LC_ALL: 'C' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    if (error?.code === 'ENOENT') throw new UsageError('git introuvable : installe git, puis relance.');
    const lines = String(error?.stderr ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const cause = lines.find(line => line.startsWith('fatal:')) ?? lines[0] ?? String(error?.message ?? error).split('\n')[0];
    if (COMMIT_MISSING.test(cause)) throw new UsageError(`${COMMIT} introuvable : git fetch --unshallow, puis relance.`);
    throw new UsageError(`git show ${COMMIT}:evening-stats.js a échoué : ${cause}`);
  }
}

// Module sans dépendance : tout require y lève.
function loadModule(source, filename) {
  const wrapper = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname) {${source}\n})`,
    { filename });
  const mod = { exports: {} };
  const noRequire = name => { throw new UsageError(`${filename} : dépendance inattendue (${name}), le module doit être sans dépendance.`); };
  wrapper.call(mod.exports, mod.exports, noRequire, mod, filename, path.dirname(filename));
  const { computeStats, exportEvening } = mod.exports;
  if (typeof computeStats !== 'function' || typeof exportEvening !== 'function') {
    throw new UsageError(`${filename} : computeStats ou exportEvening absent.`);
  }
  return mod.exports;
}

// computeStats et exportEvening d'un module sur la fixture, sous TZ=Europe/Paris.
function frozenOf(stats) {
  const meta = metaOf(FIXTURE_DATA);
  return inZone(ZONE, () => ({
    stats: stats.computeStats({ meta, events: FIXTURE_DATA.events, now: NOW, live: false }),
    export: stats.exportEvening({ meta, events: FIXTURE_DATA.events, now: NOW, live: false }),
  }));
}

function parseArgs(argv) {
  const o = { write: false, help: false };
  for (const a of argv) {
    if (a === '--ecrire') o.write = true;
    else if (a === '-h' || a === '--help' || a === '--aide') o.help = true;
    else throw new Error(`Option inconnue : ${a}`);
  }
  return o;
}

function main(argv = process.argv.slice(2), {
  out = line => process.stdout.write(`${line}\n`),
  err = line => process.stderr.write(`${line}\n`),
  gitShow = () => gitShowStats(),
  outFile = RESUME,
} = {}) {
  let o;
  try { o = parseArgs(argv); } catch (error) { err(`${error.message}\n\n${USAGE}`); return 2; }
  if (o.help) { out(USAGE); return 0; }
  if (!o.write) { err(USAGE); return 2; }
  const name = path.basename(outFile);
  const refused = `${name} existe déjà : efface-le d'abord pour le refaire.`;
  try {
    // Avant toute lecture de 1c15d72 : même refus dans la CI, qui clone sans historique.
    if (fs.existsSync(outFile)) throw new UsageError(refused);
    const source = gitShow();
    const frozen = frozenOf(loadModule(source, `${COMMIT}:evening-stats.js`));
    const data = {
      format: 'karaoke-resume-fige', version: 1,
      source: { commit: COMMIT, module: 'evening-stats.js', fixture: rel(FIXTURE), timeZone: ZONE, now: NOW, live: false },
      ...frozen,
    };
    try { fs.writeFileSync(outFile, `${JSON.stringify(data, null, 1)}\n`, { flag: 'wx' }); }
    catch (error) { if (error?.code === 'EEXIST') throw new UsageError(refused); throw error; }
    out(`${rel(outFile)} écrit : computeStats et exportEvening de ${COMMIT} sur ${rel(FIXTURE)}, sous TZ=${ZONE}.`);
    return 0;
  } catch (error) {
    err(error instanceof UsageError ? error.message : error?.stack || String(error));
    return 1;
  }
}

module.exports = { main, metaOf, gitShowStats, NOW, COMMIT, ZONE, FIXTURE, RESUME, USAGE };
if (require.main === module) process.exitCode = main();
