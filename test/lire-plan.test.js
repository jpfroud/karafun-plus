'use strict';
// Copie annotée du plan (tools/lire-plan.js, « Ordre de travail », « Copie
// annotée du plan ») : petits plans écrits par l'essai, puis le plan du dépôt,
// dont chaque citation doit se trouver une fois dans son bloc. Ni port, ni
// navigateur, ni processus.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lirePlan = require('../tools/lire-plan');

const capture = () => {
  const lines = { out: [], err: [] };
  return { lines, io: { out: line => lines.out.push(line), err: line => lines.err.push(line) } };
};
function inTemp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lire-plan-'));
  try { return run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// Nom d'un fichier tel que l'outil l'affiche : relatif au dossier courant qui
// le contient, sinon absolu (shown(), tools/lire-plan.js). Le dossier
// temporaire peut être sous le dossier courant : essai lancé de « / », ou
// TMPDIR sous le dossier de lancement.
const shownPath = file => {
  const rel = path.relative(process.cwd(), file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : file;
};
// Plan écrit dans un dossier d'essai, copie lue après main().
function runOn(lines, argv = []) {
  return inTemp(dir => {
    const plan = path.join(dir, 'plan.md');
    const copy = path.join(dir, 'tmp', 'plan-lu.md');
    fs.writeFileSync(plan, `${lines.join('\n')}\n`);
    const run = capture();
    const code = lirePlan.main(['--plan', plan, '--sortie', copy, ...argv], run.io);
    const written = fs.existsSync(copy) ? fs.readFileSync(copy, 'utf8') : null;
    return { code, ...run.lines, copy: written == null ? null : written.split('\n').slice(0, -1), dir };
  });
}

// Petit plan : blocs CEO, design, DX et ingénierie, révisions exactes,
// abrégée, imbriquées, multiples, révision d'une révision, puis un bloc
// recopié après « ## Review record », qui ne compte pas.
const PLAN = [
  '# Plan d\'essai', // 1
  'Prose hors bloc : « - Révise l\'obligation CEO « x » » n\'est pas un item.', // 2
  '<!-- autoplan-accepted:ceo -->', // 3
  '- Règle A : la soirée se termine le matin à 8 h, seulement si aucun titre n\'a démarré depuis une heure.', // 4
  '- Règle B : bandeau « OK » ou « Les garder » (route de « OK », sans rien changer).', // 5
  '- Règle C : premier point ; second point ; troisième point avec un détail.', // 6
  '<!-- /autoplan-accepted:ceo -->', // 7
  '', // 8
  '<!-- autoplan-accepted:design -->', // 9
  '- Panneau : le texte du design, à réviser par la phase DX.', // 10
  '  - Révise l\'obligation CEO « la soirée se termine le matin à 8 h » : à 8 h locale, au premier calme.', // 11
  '<!-- /autoplan-accepted:design -->', // 12
  '<!-- autoplan-accepted:dx -->', // 13
  '- Révisions.', // 14
  '  - Précise l\'obligation CEO « Règle C : premier point ; … troisième point » : le second point reste.', // 15
  '  - Révise l\'obligation design « le texte du design » : le texte révisé « par la DX ».', // 16
  '  - Révise l\'obligation CEO « la soirée se termine le matin à 8 h » : seconde révision.', // 17
  '<!-- /autoplan-accepted:dx -->', // 18
  '<!-- autoplan-accepted:eng -->', // 19
  '- Révisions.', // 20
  '  - Révise l\'obligation DX « le texte révisé « par la DX » » : révision d\'une révision.', // 21
  '  - Révise les obligations CEO « « OK » ou « Les garder » (route de « OK », sans rien changer) » et ' +
    '« aucun titre n\'a démarré depuis une heure », avec leurs reprises dans « Lots » : deux citations.', // 22
  '<!-- /autoplan-accepted:eng -->', // 23
  '## Review record', // 24
  '<!-- autoplan-accepted:ceo -->',
  '- Règle A : la soirée se termine le matin à 8 h, seulement si aucun titre n\'a démarré depuis une heure.',
  '  - Révise l\'obligation CEO « Règle A » : après « ## Review record », sans effet.',
  '<!-- /autoplan-accepted:ceo -->',
];

test('Copie annotée du plan : --aide, -h et --help rendent 0 et l’usage ; une option fausse, 2', () => {
  for (const argv of [['--aide'], ['-h'], ['--help']]) {
    const run = capture();
    assert.equal(lirePlan.main(argv, run.io), 0, argv[0]);
    assert.match(run.lines.out.join('\n'), /^Usage : node tools\/lire-plan\.js \[--plan <fichier>\] \[--sortie <fichier>\]/);
  }
  // `--plan` vers un fichier absent d'un dossier d'essai, avant `--sortie
  // --aide` : si `--sortie` prenait « --aide » pour un chemin, l'outil
  // s'arrêterait sur « Plan illisible » (code 1) sans rien écrire, au lieu de
  // copier le plan du dépôt dans un fichier « --aide » du dossier courant.
  inTemp(dir => {
    for (const [argv, message] of [[['--x'], 'Option inconnue : --x'], [['--plan'], '--plan attend un chemin de fichier'],
      [['--plan', path.join(dir, 'absent.md'), '--sortie', '--aide'], '--sortie attend un chemin de fichier']]) {
      const run = capture();
      assert.equal(lirePlan.main(argv, run.io), 2, argv.join(' '));
      assert.equal(run.lines.err.join('\n'), `${message}\n\n${lirePlan.USAGE}`);
      assert.deepEqual(run.lines.out, []);
    }
  });
});

test('Copie annotée du plan : mêmes lignes jusqu’à « ## Review record », chaque révision juste après ce qu’elle remplace', () => {
  const run = runOn(PLAN);
  assert.equal(run.code, 0, run.err.join('\n'));
  assert.deepEqual(run.err, []);
  const expected = PLAN.slice(0, 23);
  expected[3] = '- Règle A : la soirée se termine le matin à 8 h [révisée par design, l. 11 : à 8 h locale, au premier calme.] ' +
    '[révisée par DX, l. 17 : seconde révision.], seulement si aucun titre n\'a démarré depuis une heure ' +
    '[révisée par ingénierie, l. 22 : avec leurs reprises dans « Lots » : deux citations.].';
  expected[4] = '- Règle B : bandeau « OK » ou « Les garder » (route de « OK », sans rien changer) ' +
    '[révisée par ingénierie, l. 22 : avec leurs reprises dans « Lots » : deux citations.].';
  expected[5] = '- Règle C : premier point ; second point ; troisième point [précisée par DX, l. 15 : le second point reste.] avec un détail.';
  expected[9] = '- Panneau : le texte du design [révisée par DX, l. 16 : le texte révisé « par la DX ».], à réviser par la phase DX.';
  expected[15] = '  - Révise l\'obligation design « le texte du design » : le texte révisé « par la DX » ' +
    '[révisée par ingénierie, l. 21 : révision d\'une révision.].';
  assert.deepEqual(run.copy, expected);
  assert.deepEqual(run.out, [`${shownPath(path.join(run.dir, 'tmp', 'plan-lu.md'))} écrit : 23 lignes du plan, 7 marques pour 6 items ` +
    'de révision (7 citations), 0 citation à lire à la main, en ' + run.out[0].match(/en (\d+) ms\.$/)?.[1] + ' ms.']);
  // Même résultat sans fichier, et des lignes Windows gardées telles quelles.
  const direct = lirePlan.annotate(PLAN.join('\n'));
  assert.deepEqual([direct.lines, direct.marks, direct.items, direct.quotes, direct.problems], [expected, 7, 6, 7, []]);
  assert.deepEqual(lirePlan.annotate(PLAN.join('\r\n')).lines, expected.map(line => `${line}\r`));
});

test('Copie annotée du plan : citation absente, puis citation en double : code 1, chacun de ces textes, copie écrite avec les autres marques', () => {
  const plan = [
    '# Plan', // 1
    '<!-- autoplan-accepted:ceo -->', // 2
    '- Règle : une phrase répétée. Puis encore : une phrase répétée.', // 3
    '- Une règle unique.', // 4
    '- Début du point, puis sa fin.', // 5
    '- Début du point, puis sa fin aussi.', // 6
    '<!-- /autoplan-accepted:ceo -->', // 7
    '<!-- autoplan-accepted:dx -->', // 8
    '  - Révise l\'obligation CEO « une règle absente » : introuvable.', // 9
    '  - Révise l\'obligation CEO « une phrase répétée » : deux fois sur une ligne.', // 10
    '  - Précise l\'obligation CEO « Début du point, … sa fin » : abrégée, sur deux lignes.', // 11
    '  - Révise l\'obligation design « un bloc absent » : pas de bloc design.', // 12
    '  - Révise l\'obligation CEO « Une règle unique » : trouvée.', // 13
    '  - Révise l\'obligation CEO sans citation : illisible.', // 14
    '  - Révise l\'obligation CEO « » : citation vide, oubliée.', // 15
    '  - Révise l\'obligation CEO «» et « … » : vides aussi.', // 16
    '<!-- /autoplan-accepted:dx -->', // 17
    '## Review record', // 18
  ];
  const run = runOn(plan);
  assert.equal(run.code, 1);
  assert.deepEqual(run.err, [
    'Citation introuvable dans le bloc CEO : item de la ligne 9.',
    'Citation trouvée 2 fois dans le bloc CEO : item de la ligne 10.',
    'Citation trouvée 2 fois dans le bloc CEO : item de la ligne 11.',
    'Citation introuvable dans le bloc design : item de la ligne 12.',
    'Citation introuvable dans le bloc CEO : item de la ligne 14.',
    'Citation introuvable dans le bloc CEO : item de la ligne 15.',
    'Citation introuvable dans le bloc CEO : item de la ligne 16.',
    'Citation introuvable dans le bloc CEO : item de la ligne 16.',
  ]);
  const expected = plan.slice(0, 17);
  expected[3] = '- Une règle unique [révisée par DX, l. 13 : trouvée.].';
  assert.deepEqual(run.copy, expected, 'copie écrite avec les autres marques');
  assert.match(run.out[0], / 1 marque pour 8 items de révision \(8 citations\), 8 citations à lire à la main, en \d+ ms\.$/);
});

test('Copie annotée du plan : révision d’une obligation de son propre bloc : la ligne de l’item ne compte pas', () => {
  const plan = [
    '<!-- autoplan-accepted:dx -->', // 1
    '- Outils : une même interface pour chaque outil.', // 2
    '  - Révise l\'obligation DX « une même interface pour chaque outil » : sauf l\'outil des captures.', // 3
    '<!-- /autoplan-accepted:dx -->', // 4
    '## Review record', // 5
  ];
  const { lines, marks, problems } = lirePlan.annotate(plan.join('\n'));
  assert.deepEqual(problems, []);
  assert.equal(marks, 1);
  assert.equal(lines[1], '- Outils : une même interface pour chaque outil [révisée par DX, l. 3 : sauf l\'outil des captures.].');
});

// Comme la ligne « Découpage : … » du bloc CEO du plan : une partie révisée,
// puis le tout, puis le tout encore, cité avec un « … » final qui s'arrête
// avant sa fin. La partie garde sa marque juste après elle ; la citation
// abrégée vaut pour le tout : sa marque suit celle du tout. Une autre
// obligation de la même ligne, citée seule avec un « … » final, garde sa
// marque à sa place. Une obligation révisée en entier, puis en partie : la
// marque de la partie, plus récente, suit celle du tout. Une obligation citée
// avec un « … » final, puis en entier : les deux marques après sa fin.
test('Copie annotée du plan : une obligation révisée en partie, en entier, puis citée avec un « … » final : chaque marque juste après sa citation, dans l’ordre des items', () => {
  const plan = [
    '<!-- autoplan-accepted:ceo -->', // 1
    '- Règle : première partie, seconde partie (avec un détail). Autre règle : son début, puis sa fin.', // 2
    '- Troisième règle : un début, puis une fin.', // 3
    '- Quatrième règle : un premier temps, puis un second temps.', // 4
    '<!-- /autoplan-accepted:ceo -->', // 5
    '<!-- autoplan-accepted:design -->', // 6
    '  - Révise l\'obligation CEO « seconde partie (avec un détail) » : révision d\'une partie.', // 7
    '  - Révise l\'obligation CEO « Règle : … (avec un détail). » : révision du tout.', // 8
    '  - Révise l\'obligation CEO « Autre règle : son début, … » : seule sur son obligation.', // 9
    '  - Révise l\'obligation CEO « Troisième règle : un début, puis une fin. » : le tout d\'abord.', // 10
    '  - Révise l\'obligation CEO « Quatrième règle : un premier temps, … » : abrégée d\'abord.', // 11
    '<!-- /autoplan-accepted:design -->', // 12
    '<!-- autoplan-accepted:dx -->', // 13
    '  - Révise l\'obligation CEO « Règle : première partie, … » : abrégée à la fin, la plus récente.', // 14
    '  - Révise l\'obligation CEO « un début » : une partie ensuite.', // 15
    '  - Révise l\'obligation CEO « Quatrième règle : … un second temps. » : le tout ensuite.', // 16
    '<!-- /autoplan-accepted:dx -->', // 17
    '## Review record', // 18
  ];
  const { lines, marks, problems } = lirePlan.annotate(plan.join('\n'));
  assert.deepEqual(problems, []);
  assert.equal(marks, 8);
  assert.equal(lines[1], '- Règle : première partie, seconde partie (avec un détail) [révisée par design, l. 7 : révision d\'une partie.]. ' +
    '[révisée par design, l. 8 : révision du tout.] [révisée par DX, l. 14 : abrégée à la fin, la plus récente.] ' +
    'Autre règle : son début, [révisée par design, l. 9 : seule sur son obligation.] puis sa fin.');
  assert.equal(lines[2], '- Troisième règle : un début, puis une fin. [révisée par design, l. 10 : le tout d\'abord.] ' +
    '[révisée par DX, l. 15 : une partie ensuite.]');
  assert.equal(lines[3], '- Quatrième règle : un premier temps, puis un second temps. [révisée par design, l. 11 : abrégée d\'abord.] ' +
    '[révisée par DX, l. 16 : le tout ensuite.]');
});

test('Copie annotée du plan : plan illisible ou sans « ## Review record » : une ligne, code 1, aucune copie', () => {
  const run = runOn(['# Plan', '<!-- autoplan-accepted:ceo -->', '- Règle.', '<!-- /autoplan-accepted:ceo -->']);
  assert.equal(run.code, 1);
  assert.equal(run.err.length, 1);
  assert.match(run.err[0], /plan\.md : ligne « ## Review record » introuvable : ce n'est pas le plan attendu\.$/);
  assert.equal(run.copy, null);
  inTemp(dir => {
    const missing = capture();
    const copy = path.join(dir, 'copie.md');
    assert.equal(lirePlan.main(['--plan', path.join(dir, 'absent.md'), '--sortie', copy], missing.io), 1);
    assert.deepEqual(missing.lines.err, [`Plan illisible : ${shownPath(path.join(dir, 'absent.md'))} (ENOENT).`]);
    assert.equal(fs.existsSync(copy), false);
  });
});

// Plan du dépôt. Marques posées par l'outil dans une ligne de la copie, chacune
// après une espace : « [révisée par <phase>, l. <N> » ou « [précisée par … »,
// puis « ] » ou « : <fin de la ligne N du plan>] ». Rend la ligne sans elles et
// ses marques ({ verb, phase, item }).
const MARK = / \[(révisée|précisée) par (CEO|design|DX|ingénierie), l\. (\d+)/y;
function markEnd(line, from, itemLine = '') {
  if (line[from] === ']') return from + 1;
  if (!line.startsWith(' : ', from)) return -1;
  const item = itemLine.trimEnd();
  for (let close = line.indexOf(']', from + 3); close >= 0; close = line.indexOf(']', close + 1)) {
    const rest = line.slice(from + 3, close);
    if (rest && item.endsWith(rest)) return close + 1;
  }
  return -1;
}
function withoutMarks(line, plan) {
  const marks = [];
  let text = '';
  let from = 0;
  for (let at = line.indexOf(' [', from); at >= 0; at = line.indexOf(' [', from)) {
    MARK.lastIndex = at;
    const m = MARK.exec(line);
    const end = m ? markEnd(line, MARK.lastIndex, plan[Number(m[3]) - 1]) : -1;
    text += line.slice(from, end < 0 ? at + 2 : at);
    if (end >= 0) marks.push({ verb: m[1], phase: m[2], item: Number(m[3]) });
    from = end < 0 ? at + 2 : end;
  }
  return { text: text + line.slice(from), marks };
}
// Blocs acceptés d'un plan : phase du marqueur → { from, to }, indices de ses deux marqueurs.
const BLOCK_OF = new Map([['CEO', 'ceo'], ['design', 'design'], ['DX', 'dx'], ['ingénierie', 'eng']]);
function acceptedBlocks(lines) {
  const blocks = new Map();
  lines.forEach((line, n) => {
    const open = line.trim().match(/^<!-- autoplan-accepted:(\w+) -->$/);
    if (open) blocks.set(open[1], { from: n, to: -1 });
    const close = line.trim().match(/^<!-- \/autoplan-accepted:(\w+) -->$/);
    if (close && blocks.has(close[1])) blocks.get(close[1]).to = n;
  });
  return blocks;
}
// Item de révision, reconnu sans l'outil : « - Révise » ou « - Précise »,
// « l'obligation » ou « les obligations », puis la phase nommée.
const ITEM = /^\s*- (Révise|Précise) (?:l'obligation|l’obligation|les obligations) (\S+)/;
// Citations d'un item, comptées sans l'outil : les « … » de premier niveau
// qui suivent la phase nommée, jointes par une virgule ou par « et » ; les
// guillemets du reste de la ligne n'en sont pas.
function citationsOf(line) {
  let at = line.match(ITEM)[0].length;
  const spaces = () => { while (line[at] === ' ') at++; };
  for (let count = 0; ; count++) {
    spaces();
    if (count) { // entre deux citations : « , », « et » ou « , et »
      if (line[at] === ',') { at++; spaces(); }
      if (line.startsWith('et ', at)) { at += 3; spaces(); }
    }
    if (line[at] !== '«') return count;
    let depth = 0;
    do {
      if (line[at] === '«') depth++;
      else if (line[at] === '»') depth--;
      at++;
    } while (depth > 0 && at < line.length);
    if (depth > 0) return count;
  }
}

test('Copie annotée du plan : le plan du dépôt : code 0, une marque par citation, mêmes lignes jusqu’à « ## Review record », et les marques que nomme le plan', () => {
  const source = fs.readFileSync(lirePlan.PLAN, 'utf8');
  const plan = source.split('\n'); // lignes Windows (\r) gardées, comme dans la copie
  const recordAt = plan.findIndex(line => line.trimEnd() === '## Review record');
  assert.ok(recordAt > 0, 'ligne « ## Review record » du plan');
  const copy = inTemp(dir => {
    const run = capture();
    const file = path.join(dir, 'plan-lu.md');
    const code = lirePlan.main(['--sortie', file], run.io);
    assert.deepEqual(run.lines.err, [], 'aucune citation introuvable ni en double');
    assert.equal(code, 0);
    return fs.readFileSync(file, 'utf8').split('\n').slice(0, -1);
  });
  // Mêmes lignes : autant que le plan avant « ## Review record », chacune égale à la sienne sans ses marques.
  assert.equal(copy.length, recordAt, 'lignes du plan jusqu’à « ## Review record »');
  const marks = [];
  copy.forEach((line, n) => {
    const { text, marks: found } = withoutMarks(line, plan);
    assert.equal(text, plan[n], `ligne ${n + 1} : rien d’autre que des marques ajoutées`);
    for (const mark of found) marks.push({ ...mark, line: n });
  });
  // Une marque par citation : chaque item est dans le bloc de la phase de sa
  // marque, et sa citation dans le bloc de la phase qu'il nomme.
  const result = lirePlan.annotate(source);
  assert.deepEqual(result.problems, []);
  assert.equal(marks.length, result.marks, 'marques lues dans la copie');
  const blocks = acceptedBlocks(plan.slice(0, recordAt));
  const inBlock = (phase, n) => blocks.has(phase) && blocks.get(phase).from < n && n < blocks.get(phase).to;
  for (const mark of marks) {
    const where = `marque de l’item de la ligne ${mark.item}, ligne ${mark.line + 1}`;
    const named = plan[mark.item - 1].match(ITEM);
    assert.ok(named && inBlock(BLOCK_OF.get(mark.phase), mark.item - 1), `${where} : item du bloc ${mark.phase}`);
    assert.equal(mark.verb, named[1] === 'Révise' ? 'révisée' : 'précisée', where);
    assert.ok(inBlock(BLOCK_OF.get(named[2]), mark.line), `${where} : dans le bloc ${named[2]}`);
  }
  // Chaque item de révision des quatre blocs, trouvé et compté sans l'outil,
  // a une marque par citation : un item que l'outil ne reconnaîtrait plus
  // manquerait ici, au lieu de sortir de tous ses comptes à la fois.
  const marksOf = item => marks.filter(mark => mark.item === item).length;
  const items = [];
  plan.slice(0, recordAt).forEach((line, n) => {
    if (ITEM.test(line) && [...BLOCK_OF.values()].some(phase => inBlock(phase, n))) items.push(n + 1);
  });
  for (const item of items) {
    assert.ok(marksOf(item) > 0, `item de la ligne ${item} : marqué dans la copie`);
    assert.equal(marksOf(item), citationsOf(plan[item - 1]), `item de la ligne ${item} : une marque par citation`);
  }
  const citations = items.reduce((sum, item) => sum + citationsOf(plan[item - 1]), 0);
  assert.deepEqual({ items: result.items, quotes: result.quotes, marks: marks.length },
    { items: items.length, quotes: citations, marks: citations }, 'items et citations comptés sans l’outil');

  // Cas nommés par le plan, trouvés par leur texte. Ligne seule de son bloc qui
  // contient `fragment` (indice), ou item qui commence par `start` (numéro de ligne).
  const lineWith = (phase, fragment, start = false) => {
    const found = [];
    plan.forEach((line, n) => {
      if (inBlock(phase, n) && (start ? line.trimStart().startsWith(fragment) : line.includes(fragment))) found.push(n);
    });
    assert.equal(found.length, 1, `« ${fragment} » : une ligne du bloc ${phase}`);
    return found[0];
  };
  const itemOf = (phase, start) => lineWith(phase, start, true) + 1;
  // Marque d'un item à une citation : « [révisée par <phase>, l. N : <fin de l'item>] ».
  const markOf = (phase, item) => {
    const line = plan[item - 1];
    return `[révisée par ${phase}, l. ${item} : ${line.slice(line.indexOf(' » : ') + ' » : '.length).trimEnd()}]`;
  };
  const clock = 'Heure murale avancée de plus de 15 min de plus que l\'horloge monotone : découpage seulement.';
  assert.ok(copy[lineWith('ceo', clock)].includes(`${clock} ${markOf('ingénierie', itemOf('eng', `- Révise l'obligation CEO « ${clock} »`))}`),
    'règle du saut d’horloge du bloc CEO suivie de sa marque d’ingénierie');
  // Citation abrégée de la coupure à l'heure de `closedAt` (« … » final),
  // marquée sur sa ligne du bloc CEO. Deux items plus anciens révisent la même
  // obligation, l'un en partie, l'autre en entier : la partie garde sa marque
  // juste après elle ; le tout, puis la citation abrégée, qui vaut pour lui,
  // ont les leurs après sa fin, dans l'ordre des items.
  const cut = 'Découpage : la coupure à l\'heure de `closedAt`,';
  const cutPart = '« Les garder » (route de « OK », qu\'il redevient à 0 personne)';
  const cutEnd = 'et l\'envoi suspendu si `autoStopped` est vrai.';
  const cutItems = [
    itemOf('design', '- Révise l\'obligation CEO « Tant que l\'envoi est suspendu, « Envoi automatique »'),
    itemOf('design', `- Révise les obligations CEO « Découpage : … ${cutEnd} »`),
    itemOf('design', `- Révise l'obligation CEO « ${cut} … »`),
  ];
  assert.deepEqual(cutItems, [...cutItems].sort((a, b) => a - b), 'items de la coupure, dans l’ordre du plan');
  const cutLine = copy[lineWith('ceo', cut)];
  const partEnd = cutLine.indexOf(cutPart) + cutPart.length;
  const endAt = cutLine.indexOf(cutEnd, partEnd);
  const afterPart = withoutMarks(cutLine.slice(partEnd, endAt), plan);
  const afterCut = cutLine.slice(endAt + cutEnd.length).trimEnd();
  const cutMarks = withoutMarks(afterCut, plan);
  assert.deepEqual({ part: afterPart.text, partItems: afterPart.marks.map(mark => mark.item), text: cutMarks.text, items: cutMarks.marks.map(mark => mark.item) },
    { part: ', ', partItems: [cutItems[0]], text: '', items: cutItems.slice(1) },
    'citation abrégée de la coupure à l’heure de closedAt marquée sur sa ligne du bloc CEO, après la fin de l’obligation, ' +
    'la partie révisée suivie de sa marque, puis les autres dans l’ordre des items');
  assert.ok(cutLine.slice(partEnd).startsWith(` ${markOf('design', cutItems[0])}, `), 'marque de la partie juste après elle');
  assert.ok(afterCut.endsWith(` ${markOf('design', cutItems[2])}`), 'marque de la citation abrégée en dernier');
  const guard = 'Une même garde entoure ces appels';
  const guardDx = itemOf('dx', `- Révise l'obligation CEO « ${guard}`);
  const guardEng = itemOf('eng', `- Révise l'obligation CEO « ${guard}`);
  assert.ok(copy[lineWith('ceo', guard)].includes(`et l'appelant continue. ${markOf('DX', guardDx)} ${markOf('ingénierie', guardEng)}`),
    'garde de la fin de soirée du bloc CEO : marque DX, puis marque d’ingénierie');
  const dxText = 'sans couper l\'envoi ni afficher `check-failed`';
  const dxItem = itemOf('eng', '- Révise l\'obligation DX « interrupteur « Nouvelle soirée automatique le matin » coupé');
  assert.ok(copy[guardDx - 1].includes(`${dxText} ${markOf('ingénierie', dxItem)}`), 'texte DX révisé suivi de sa marque d’ingénierie');
  // Items à plusieurs citations, jointes par une virgule ou par « et » : une marque chacune.
  assert.equal(marksOf(itemOf('design', '- Révise l\'obligation CEO « Tant que l\'envoi est suspendu, « Envoi automatique »')), 2,
    '« … », et « … »');
  assert.equal(marksOf(itemOf('design', '- Révise les obligations CEO « haut de la Battle au premier écran de Plus')), 3, '« … », « … » et « … »');

  // L'outil lit le plan et écrit la copie : aucun processus lancé.
  const tool = fs.readFileSync(path.join(__dirname, '..', 'tools', 'lire-plan.js'), 'utf8');
  assert.doesNotMatch(tool, /require\(\s*['"](node:)?(child_process|worker_threads|cluster)['"]\s*\)/);
});
