'use strict';
/*
 * Dossier d'essai des procédures du §18 de DEPLOIEMENT-SERVEUR.md
 * (réparation des soirées, plan du 8 novembre, A6, « Tests de cette
 * documentation ») : ce que trouvent les commandes node de « Revenir à
 * l'original d'une soirée découpée » et de « Refaire une réparation en
 * échec », et la recherche d'« Envoyer une soirée au développeur ».
 *
 * - data/soirees : une soirée de deux nuits, close par le bar, découpée en
 *   deux morceaux par la vraie réparation (EveningJournal.repair), avec sa
 *   copie close dans data/soirees-originales/<id>/1/ ; une soirée d'une
 *   nuit, notée ok ; une soirée au meta.json mal formé, notée failed
 *   (BAD_META) ; un dossier « notes », qui n'est pas une soirée et dont le
 *   meta.json nomme pourtant la soirée découpée ;
 * - data/soirees-originales/<id>/1/meta.json sans endedAt : la copie d'une
 *   soirée coupée pendant qu'elle était en cours ;
 * - journal/serveur-2026-11-07.log : les lignes « Réparation » de cette
 *   réparation, entre une ligne « Clé du bar », une ligne « Fin de soirée : »
 *   et une ligne où « Réparation » vient plus loin ; attendu-envoi.txt : les
 *   lignes qu'« Envoyer une soirée au développeur » en garde, dans l'ordre.
 *
 * documentation.test.js l'importe (preparerDossier). Sous Windows,
 * test/verify-portable-kit.ps1 le lance dans le kit extrait, puis y tape les
 * commandes PowerShell du §18 : le même journal et le même index d'essai.
 *   node test/dossier-reparation.js <dossier>
 * écrit le dossier, puis ses identifiants en JSON sur une ligne. Codes de
 * sortie de main() comme test/rejeu-soiree.js : aide 0, option fausse 2,
 * erreur trouvée en route 1 (une ligne, sans pile), erreur imprévue 1 (pile).
 * Prénoms d'essai seulement (« Prénom a1 »).
 */
const fs = require('node:fs');
const path = require('node:path');
const { EveningJournal } = require('../evening-journal');
const { citedIds, computeStats } = require('../evening-stats');

const PARIS = 'Europe/Paris';
const MIN = 60000;
const DAY = 24 * 60 * MIN;
// Jeudi 5 novembre 2026, 20 h à Paris : première nuit de la soirée découpée.
const NUIT = Date.parse('2026-11-05T20:00:00+01:00');
// Démarrage qui répare : samedi 7 novembre, 8 h à Paris.
const REPARATION = Date.parse('2026-11-07T07:00:00Z');
const IDS = Object.freeze({
  decoupee: '2026-11-05_1930_ab12', autre: '2026-10-29_1930_cd34', enEchec: '2026-10-22_1930_ef56',
  sansFin: '2026-11-12_1930_0a1b', nonSoiree: 'notes',
});
const JOURNAL = 'serveur-2026-11-07.log';
const ATTENDU = 'attendu-envoi.txt';
const USAGE = `Usage : node test/dossier-reparation.js <dossier>

Écrit dans <dossier>, qui n'a pas encore de data/soirees, le dossier d'essai
des procédures du §18 de DEPLOIEMENT-SERVEUR.md, puis ses identifiants en
JSON sur une ligne :
  data/soirees, data/soirees-originales,
  journal/${JOURNAL}, ${ATTENDU}.`;

class UsageError extends Error {}

// `n` nuits d'une table, deux personnes et trois titres, de 20 h à 22 h 30
// à Paris, puis la clôture par le bar 5 min après la dernière ligne.
function nuits(n, debut) {
  const events = [];
  const add = (t, ev, fields, boot) => events.push({ ...fields, v: 1, seq: events.length + 1, t, ev, boot });
  add(debut - 30 * MIN, 'evening.started', { rules: { auto: true, autoPlay: false } }, 'boot-1');
  for (let k = 1; k <= n; k++) {
    const t0 = debut + (k - 1) * DAY, boot = `boot-${k}`;
    add(t0, 'table.opened', { tableId: `T${k}`, individual: false }, boot);
    add(t0 + MIN, 'person.joined', { personId: `a${k}`, tableId: `T${k}` }, boot);
    add(t0 + 2 * MIN, 'person.joined', { personId: `b${k}`, tableId: `T${k}` }, boot);
    for (let s = 0; s < 3; s++) {
      const ts = t0 + (10 + 40 * s) * MIN, who = s % 2 ? `b${k}` : `a${k}`, entryId = `e${k}-${s}`;
      add(ts - 5 * MIN, 'song.requested', { personId: who, entryId, songId: 100 + s, title: `Titre ${s}` }, boot);
      add(ts, 'stage.started', { queueId: k * 10 + s, ids: [who], ownerId: who, entryId, durationSec: 200 }, boot);
      add(ts + 4 * MIN, 'stage.ended', { queueId: k * 10 + s, playedSec: 240 }, boot);
    }
  }
  add(events.at(-1).t + 5 * MIN, 'evening.closed', { by: 'staff-reset' }, `boot-${n}`);
  return events;
}
function metaDe(id, n, debut, endedAt) {
  const roster = [], tables = [];
  for (let k = 1; k <= n; k++) {
    for (const p of ['a', 'b']) roster.push([`${p}${k}`, { name: `Prénom ${p}${k}`, tableId: `T${k}` }]);
    tables.push([`T${k}`, { name: `Table ${k}`, individual: false }]);
  }
  return { format: 'karaoke-evening-meta', version: 1, eveningId: id, startedAt: debut - 30 * MIN, endedAt,
    app: { version: 'v3.5.0', commit: null }, timezone: PARIS, roster: Object.fromEntries(roster), tables: Object.fromEntries(tables) };
}
const resumer = ({ meta, events }) => computeStats({ meta, events, now: Number.isFinite(meta.endedAt) ? meta.endedAt : REPARATION });

// Soirée close posée dans data/soirees/<id>/, comme après « Supprimer toutes
// les tables » : meta.json, journal.jsonl et summary.json.
function poserSoiree(soirees, id, n, debut) {
  const events = nuits(n, debut);
  const meta = metaDe(id, n, debut, events.at(-1).t);
  const folder = path.join(soirees, id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(folder, 'journal.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify(resumer({ meta, events })));
}

// Écrit le dossier d'essai dans `dossier` ; rend ses identifiants, le premier
// morceau de la soirée découpée (`morceau`) et les lignes attendues d'envoi.txt.
function preparerDossier(dossier) {
  const soirees = path.join(dossier, 'data', 'soirees');
  if (fs.existsSync(soirees)) throw new UsageError(`${soirees} existe déjà : rien n'est écrit (dossier d'essai sans data/soirees attendu).`);
  poserSoiree(soirees, IDS.decoupee, 2, NUIT);
  poserSoiree(soirees, IDS.autre, 1, NUIT - 7 * DAY);
  const echec = path.join(soirees, IDS.enEchec);
  fs.mkdirSync(echec, { recursive: true });
  fs.writeFileSync(path.join(echec, 'meta.json'), JSON.stringify({ format: 'karaoke-evening-meta', version: 1, eveningId: IDS.enEchec,
    startedAt: 'hier', endedAt: null, timezone: PARIS, roster: {}, tables: {} }));
  fs.writeFileSync(path.join(echec, 'journal.jsonl'), '');
  const lignes = [];
  const journal = new EveningJournal({ dir: soirees, now: () => REPARATION, app: { version: 'v3.5.0', commit: null }, citedIds });
  const reparer = id => journal.repair({ id, summarize: resumer, citedIds, log: line => lignes.push(line) });
  const decoupee = reparer(IDS.decoupee);
  const autre = reparer(IDS.autre);
  const enEchec = reparer(IDS.enEchec);
  if (decoupee.status !== 'split' || decoupee.pieces.length !== 2 || autre.status !== 'ok' || enEchec.status !== 'failed') {
    throw new Error(`Réparation d'essai inattendue : ${[decoupee, autre, enEchec].map(r => `${r.id} ${r.status}`).join(', ')}.`);
  }
  const morceau = decoupee.pieces[0].id;
  // Pas une soirée : jamais listé, même si son meta.json nomme la soirée découpée.
  fs.mkdirSync(path.join(soirees, IDS.nonSoiree), { recursive: true });
  fs.writeFileSync(path.join(soirees, IDS.nonSoiree, 'meta.json'), JSON.stringify({ split: { from: IDS.decoupee, part: 1 } }));
  // Copie d'une soirée coupée pendant qu'elle était en cours : sans endedAt.
  const sansFin = path.join(dossier, 'data', 'soirees-originales', IDS.sansFin, '1');
  fs.mkdirSync(sansFin, { recursive: true });
  fs.writeFileSync(path.join(sansFin, 'meta.json'), JSON.stringify({ format: 'karaoke-evening-meta', version: 1, eveningId: IDS.sansFin,
    startedAt: NUIT + 7 * DAY - 30 * MIN, timezone: PARIS, roster: {}, tables: {} }));
  fs.writeFileSync(path.join(sansFin, 'copie-complete'), '');
  // Journal du serveur, à la forme d'appLog (heure ISO, puis le message).
  let t = REPARATION - 2000;
  const ligne = message => `${new Date(t += 100).toISOString()} ${message}`;
  const avant = [ligne('=== File karaoké v3.5.0 (abc1234) ==='),
    ligne('Clé du bar (autre appareil)    : cle-d-essai-sans-valeur  (ex. http://192.168.1.20:3000/staff?key=cle-d-essai-sans-valeur)')];
  const gardees = [ligne('Réparation des soirées : active.'), ...lignes.map(ligne),
    ligne('Réparation des soirées closes terminée : 2 vérifiées, 1 découpées, 1 en échec, 0 à refaire ; en 12 ms.')];
  const ecartee = ligne('Journal de soirée indisponible : Réparation impossible (EIO). La file continue.');
  const fin = ligne('Fin de soirée : vérification en échec (Error, code ENOENT, appel : minute) : rien n’est coupé (aucune fin possible avant 08:00).');
  fs.mkdirSync(path.join(dossier, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(dossier, 'journal', JOURNAL), [...avant, ...gardees, ecartee, fin].join('\n') + '\n');
  const attendu = [...gardees, fin];
  fs.writeFileSync(path.join(dossier, ATTENDU), attendu.join('\n') + '\n');
  return { ...IDS, morceau, attendu };
}

function parseArgs(argv) {
  const o = { help: false, dossier: null };
  for (const a of argv) {
    if (a === '-h' || a === '--help' || a === '--aide') o.help = true;
    else if (a.startsWith('-')) throw new Error(`Option inconnue : ${a}`);
    else if (o.dossier === null) o.dossier = a;
    else throw new Error(`Un seul dossier attendu : ${a} en trop`);
  }
  return o;
}

function main(argv = process.argv.slice(2), {
  out = line => process.stdout.write(`${line}\n`),
  err = line => process.stderr.write(`${line}\n`),
} = {}) {
  let o;
  try { o = parseArgs(argv); } catch (error) { err(`${error.message}\n\n${USAGE}`); return 2; }
  if (o.help) { out(USAGE); return 0; }
  if (o.dossier === null) { err(USAGE); return 2; }
  try {
    const { attendu, ...ids } = preparerDossier(o.dossier);
    out(JSON.stringify(ids));
    return 0;
  } catch (error) {
    err(error instanceof UsageError ? error.message : error?.stack || String(error));
    return 1;
  }
}

module.exports = { preparerDossier, main, IDS, JOURNAL, ATTENDU, USAGE };
if (require.main === module) process.exitCode = main();
