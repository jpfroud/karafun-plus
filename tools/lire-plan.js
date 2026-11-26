'use strict';
/*
 * Copie annotée du plan du 8 novembre (« Ordre de travail », « Copie annotée
 * du plan ») : copie docs/designs/retours-2026-11-08.md jusqu'à la ligne qui
 * précède « ## Review record », avec les mêmes lignes, dans
 * .gstack/tmp/plan-lu.md, que git ignore.
 *
 * Dans les blocs acceptés des relectures (<!-- autoplan-accepted:<phase> -->),
 * un item « Révise l'obligation <phase> « … » » ou « Précise l'obligation … »
 * cite mot pour mot l'obligation qu'il remplace, dans le bloc de la phase
 * qu'il nomme, où elle ne se trouve qu'une fois ; « … » y marque un passage
 * omis, et la citation abrégée tient alors sur une seule ligne de ce bloc
 * (« Comment lire ce plan »). Pour chaque citation, l'outil écrit juste
 * après elle, sur sa ligne, « [révisée par <phase de l'item>, l. <ligne de
 * l'item> : <reste de la ligne de l'item>] », ou « [précisée par … ] » ; les
 * marques d'une même obligation suivent l'ordre des items. Des citations qui
 * se chevauchent sur une ligne, de proche en proche, sont d'une même
 * obligation (une partie, le tout) : une citation abrégée par un « … » final
 * vaut pour le tout, et sa marque suit la plus lointaine de leurs fins ; une
 * marque qui viendrait avant celle d'un item plus ancien de l'obligation la
 * suit.
 *
 *   node tools/lire-plan.js [--plan <fichier>] [--sortie <fichier>]
 *
 * Codes de sortie (ceux des outils, règle « Fichiers nouveaux et outils
 * d'essai ») : 0, copie écrite et chaque citation trouvée une fois ; 1, une
 * citation introuvable ou trouvée plus d'une fois (une ligne chacune sur la
 * sortie d'erreur, la copie étant écrite avec les autres marques : ces items
 * se lisent à la main), une erreur trouvée en route (une ligne, sans pile) ou
 * une erreur imprévue (sa pile) ; 2, une option fausse (l'usage) ; -h, --help
 * ou --aide, l'usage et 0.
 *
 * Lit le plan et écrit la copie : aucun processus lancé, aucun réseau.
 * Programmatique : annotate(texte) rend la copie et ses relevés ; main(argv,
 * { out, err }) rend le code de sortie.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLAN = path.join(ROOT, 'docs', 'designs', 'retours-2026-11-08.md');
const COPY = path.join(ROOT, '.gstack', 'tmp', 'plan-lu.md');
const REVIEW_RECORD = '## Review record';
const ELLIPSIS = '…';

const USAGE = [
  'Usage : node tools/lire-plan.js [--plan <fichier>] [--sortie <fichier>]',
  '  Copie le plan (docs/designs/retours-2026-11-08.md) jusqu\'à « ## Review record », avec les mêmes lignes,',
  '  dans .gstack/tmp/plan-lu.md, chaque révision des blocs acceptés écrite juste après ce qu\'elle remplace.',
  '  --plan <fichier>     autre plan à lire',
  '  --sortie <fichier>   autre copie à écrire',
  '  -h, --help, --aide   cette aide',
  'Codes de sortie : 0 copie écrite ; 1 citation introuvable ou en double (copie écrite avec les autres marques),',
  '  ou erreur ; 2 option fausse.',
].join('\n');

// Phases des blocs acceptés, dans l'ordre des relectures : nom du marqueur,
// nom écrit dans les items et les marques.
const PHASES = new Map([['ceo', 'CEO'], ['design', 'design'], ['dx', 'DX'], ['eng', 'ingénierie']]);
const PHASE_NAMES = new Map([['ceo', 'ceo'], ['design', 'design'], ['dx', 'dx'], ['ingénierie', 'eng'], ['eng', 'eng']]);
const VERBS = new Map([['Révise', 'révisée'], ['Précise', 'précisée']]);
const OBJECTS = ['l\'obligation ', 'l’obligation ', 'les obligations '];

// Erreur trouvée en route : une ligne, sans pile.
class UsageError extends Error {}

const isSpace = ch => ch === ' ' || ch === '\t' || ch === ' ' || ch === ' ';
function skipSpaces(text, i) {
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

// Citation entre guillemets qui commence à `start` (« … », imbrications
// comprises) : { text, end }, `end` juste après son « » » ; null sans fin.
function quoteAt(line, start) {
  let depth = 0;
  for (let i = start; i < line.length; i++) {
    if (line[i] === '«') depth++;
    else if (line[i] === '»' && --depth === 0) return { text: line.slice(start + 1, i).trim(), end: i + 1 };
  }
  return null;
}

// Item de révision d'une ligne de bloc : { verb, phase, quotes, rest }, ou
// null pour une autre ligne. `quotes` peut être vide (citation illisible).
function revisionItem(line) {
  let i = skipSpaces(line, 0);
  if (!line.startsWith('- ', i)) return null;
  i = skipSpaces(line, i + 2);
  const verb = [...VERBS.keys()].find(v => line.startsWith(`${v} `, i));
  if (!verb) return null;
  i = skipSpaces(line, i + verb.length);
  const object = OBJECTS.find(o => line.startsWith(o, i));
  if (!object) return null;
  i = skipSpaces(line, i + object.length);
  let j = i;
  while (j < line.length && !isSpace(line[j]) && line[j] !== '«') j++;
  const phase = line.slice(i, j);
  const quotes = [];
  let end = j;
  let k = skipSpaces(line, j);
  while (line[k] === '«') {
    const quote = quoteAt(line, k);
    if (!quote) break;
    quotes.push(quote.text);
    end = quote.end;
    // Citation suivante : « … », « … » et « … », ou « … », et « … ».
    k = skipSpaces(line, end);
    if (line[k] === ',') k = skipSpaces(line, k + 1);
    if (line.startsWith('et ', k)) k = skipSpaces(line, k + 3);
  }
  let r = end;
  while (r < line.length && (isSpace(line[r]) || line[r] === ',' || line[r] === ':' || line[r] === ';')) r++;
  return { verb, phase, quotes, rest: line.slice(r).trimEnd() };
}

// Emplacements de `quote` dans `line`, chacun du début de la citation à sa fin
// ({ start, end }) : citation exacte, ou abrégée (« … »), ses morceaux dans
// l'ordre sur la même ligne. Une citation vide (« ») ne se trouve nulle part :
// indexOf('') ne passerait jamais la fin de la ligne.
function quoteSpans(line, quote) {
  const spans = [];
  if (!quote) return spans;
  if (!quote.includes(ELLIPSIS)) {
    for (let at = line.indexOf(quote); at >= 0; at = line.indexOf(quote, at + 1)) spans.push({ start: at, end: at + quote.length });
    return spans;
  }
  const parts = quote.split(ELLIPSIS).map(part => part.trim()).filter(Boolean);
  if (!parts.length) return spans;
  for (let from = 0; ;) {
    let at = line.indexOf(parts[0], from);
    if (at < 0) return spans;
    const start = at;
    let end = at + parts[0].length;
    for (const part of parts.slice(1)) {
      at = line.indexOf(part, end);
      if (at < 0) return spans;
      end = at + part.length;
    }
    spans.push({ start, end });
    from = Math.max(end, start + 1);
  }
}

// Copie annotée d'un plan : { lines, marks, items, quotes, problems }.
// `lines` : les lignes jusqu'à celle qui précède « ## Review record ».
function annotate(text) {
  const all = String(text).split('\n');
  const recordAt = all.findIndex(line => line.trimEnd() === REVIEW_RECORD);
  if (recordAt < 0) throw new UsageError(`ligne « ${REVIEW_RECORD} » introuvable : ce n'est pas le plan attendu.`);
  const lines = all.slice(0, recordAt);

  // Blocs acceptés : phase → [première, dernière] ligne (indices).
  const blocks = new Map();
  const blockOf = [];
  let open = null;
  lines.forEach((line, n) => {
    const marker = line.trim();
    if (open == null && marker.startsWith('<!-- autoplan-accepted:') && marker.endsWith(' -->')) {
      open = { phase: marker.slice('<!-- autoplan-accepted:'.length, -' -->'.length), from: n };
    } else if (open && marker === `<!-- /autoplan-accepted:${open.phase} -->`) {
      if (!blocks.has(open.phase)) blocks.set(open.phase, [open.from, n]);
      open = null;
    } else if (open) blockOf[n] = open.phase;
  });

  // Items de révision, dans l'ordre du plan ; une marque par citation trouvée une fois.
  const found = new Map(); // indice de ligne → [{ start, end, mark }], dans l'ordre des items
  const problems = [];
  let items = 0, quotes = 0, marks = 0;
  lines.forEach((line, n) => {
    if (blockOf[n] == null || !PHASES.has(blockOf[n])) return;
    const item = revisionItem(line);
    if (!item) return;
    items++;
    const target = PHASE_NAMES.get(item.phase.toLowerCase());
    const range = target ? blocks.get(target) : null;
    const where = `dans le bloc ${item.phase} : item de la ligne ${n + 1}.`;
    if (!item.quotes.length) { problems.push(`Citation introuvable ${where}`); return; }
    const mark = `[${VERBS.get(item.verb)} par ${PHASES.get(blockOf[n])}, l. ${n + 1}${item.rest ? ` : ${item.rest}` : ''}]`;
    for (const quote of item.quotes) {
      quotes++;
      const hits = [];
      if (range) {
        for (let m = range[0] + 1; m < range[1]; m++) {
          if (m === n) continue;
          for (const span of quoteSpans(lines[m], quote)) hits.push({ line: m, ...span });
        }
      }
      if (hits.length === 0) problems.push(`Citation introuvable ${where}`);
      else if (hits.length > 1) problems.push(`Citation trouvée ${hits.length} fois ${where}`);
      else {
        if (!found.has(hits[0].line)) found.set(hits[0].line, []);
        found.get(hits[0].line).push({ start: hits[0].start, end: hits[0].end, open: quote.endsWith(ELLIPSIS), mark });
        marks++;
      }
    }
  });

  // Citations d'une ligne qui se chevauchent, de proche en proche : une même
  // obligation, citée en partie ou en entier. Chaque marque va juste après sa
  // citation ; celle d'une citation abrégée par un « … » final, qui vaut pour
  // toute l'obligation, après la plus lointaine des fins du groupe. Dans un
  // groupe, une marque qui viendrait avant celle d'un item plus ancien la suit :
  // les marques d'une même obligation restent dans l'ordre des items. Marques
  // écrites de la fin de la ligne vers son début ; à la même place, dans
  // l'ordre des items.
  const copy = lines.slice();
  for (const [n, list] of found) {
    const groups = [];
    for (const entry of [...list].sort((a, b) => a.start - b.start)) {
      const group = groups[groups.length - 1];
      if (group && entry.start < group.end) { group.end = Math.max(group.end, entry.end); group.entries.push(entry); }
      else groups.push({ end: entry.end, entries: [entry] });
    }
    const at = new Map(); // entrée → place de sa marque
    for (const group of groups) {
      let last = 0;
      for (const entry of list.filter(e => group.entries.includes(e))) {
        last = Math.max(last, entry.open ? group.end : entry.end);
        at.set(entry, last);
      }
    }
    let line = copy[n];
    for (const place of [...new Set(at.values())].sort((a, b) => b - a)) {
      const text = list.filter(entry => at.get(entry) === place).map(entry => entry.mark).join(' ');
      line = `${line.slice(0, place)} ${text}${line.slice(place)}`;
    }
    copy[n] = line;
  }
  return { lines: copy, marks, items, quotes, problems };
}

function parseArgs(argv) {
  const o = { plan: PLAN, copy: COPY, help: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    if (a === '-h' || a === '--help' || a === '--aide') o.help = true;
    else if (a === '--plan' || a === '--sortie') {
      const value = argv[++k];
      if (!value || value.startsWith('--')) throw new Error(`${a} attend un chemin de fichier`);
      if (a === '--plan') o.plan = path.resolve(value); else o.copy = path.resolve(value);
    } else throw new Error(`Option inconnue : ${a}`);
  }
  return o;
}

const count = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const shown = file => {
  const rel = path.relative(process.cwd(), file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file;
};

function main(argv = process.argv.slice(2), {
  out = line => process.stdout.write(`${line}\n`),
  err = line => process.stderr.write(`${line}\n`),
} = {}) {
  let o;
  try { o = parseArgs(argv); } catch (error) { err(`${error.message}\n\n${USAGE}`); return 2; }
  if (o.help) { out(USAGE); return 0; }
  try {
    const started = process.hrtime.bigint();
    let text;
    try { text = fs.readFileSync(o.plan, 'utf8'); }
    catch (error) { throw new UsageError(`Plan illisible : ${shown(o.plan)} (${error.code || error.name}).`); }
    let result;
    try { result = annotate(text); }
    catch (error) { if (error instanceof UsageError) throw new UsageError(`${shown(o.plan)} : ${error.message}`); throw error; }
    try {
      fs.mkdirSync(path.dirname(o.copy), { recursive: true });
      fs.writeFileSync(`${o.copy}.tmp`, `${result.lines.join('\n')}\n`);
      fs.renameSync(`${o.copy}.tmp`, o.copy);
    } catch (error) { throw new UsageError(`Copie impossible à écrire : ${shown(o.copy)} (${error.code || error.name}).`); }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    for (const problem of result.problems) err(problem);
    out(`${shown(o.copy)} écrit : ${result.lines.length} lignes du plan, ${count(result.marks, 'marque')} pour ` +
      `${count(result.items, 'item')} de révision (${count(result.quotes, 'citation')}), ` +
      `${count(result.problems.length, 'citation')} à lire à la main, en ${ms.toFixed(0)} ms.`);
    return result.problems.length ? 1 : 0;
  } catch (error) {
    err(error instanceof UsageError ? error.message : error?.stack || String(error));
    return 1;
  }
}

module.exports = { annotate, revisionItem, main, PLAN, COPY, USAGE };
if (require.main === module) process.exitCode = main();
