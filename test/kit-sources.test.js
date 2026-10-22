'use strict';
// Manifeste unique des fichiers livrés (livrable.json, issue #21), lu par
// PREPARER-KIT-BAR.ps1 (kit Windows) et par scripts/preparer-livrable.js
// (image Docker). Ces tests le confrontent au graphe des require du serveur,
// aux lectures par path.join(__dirname, …) et à la mesure de couverture, en
// lisant livrable.json directement (jamais par scripts/preparer-livrable.js) :
// un module oublié arrêterait le serveur au démarrage, sur le PC du bar comme
// dans l'image.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8');
const manifest = JSON.parse(read('livrable.json').replace(/^\uFEFF/, ''));

// Points d'entrée : ceux du kit, puis ceux de l'image (sans les deux lanceurs
// Windows, absents de l'image).
const LAUNCHERS = ['start-evening.js', 'stop.js'];
const ENTRIES = ['server.js', ...LAUNCHERS, 'fake-karafun.js', 'tools/diag-karafun.js'];
const IMAGE_ENTRIES = ENTRIES.filter(file => !LAUNCHERS.includes(file));
const PRODUCTS = ['KaraFun Plus.exe', 'build-info.json', 'solver/karafun-solver.jar'];
const FORBIDDEN = ['data', 'journal', 'test', 'node', 'node_modules', 'solver-runtime', 'LICENCES-JAVA', 'deploy', 'scripts', '.github'];
// Lectures par path.join(__dirname, '<littéral>', …), rapportées à la racine.
const READS = {
  livré: ['package.json', 'public'],
  produit: ['build-info.json', 'solver/karafun-solver.jar', 'solver/target'],
  exécution: ['data', 'journal'],
  racine: ['.'],
};

const under = (file, dirs) => dirs.some(dir => file === dir || file.startsWith(`${dir}/`));
const comment = line => /^\s*(\/\/|\*|\/\*)/.test(line);

// Fichiers d'une entrée du manifeste, dossiers développés (fichiers cachés
// compris), en chemins relatifs « / ».
function expand(entry) {
  const absolute = path.join(root, ...entry.split('/'));
  if (!fs.statSync(absolute).isDirectory()) return [entry];
  return fs.readdirSync(absolute).sort().flatMap(name => expand(`${entry}/${name}`));
}
const expandAll = list => new Set(list.flatMap(expand));

// Chaînes d'un tableau littéral ('a', "b"), ou null si un élément n'en est pas une.
function literalList(text) {
  const items = text.split(',').map(item => item.trim()).filter(Boolean);
  return items.every(item => /^(['"])[^'"\\]+\1$/.test(item)) ? items.map(item => item.slice(1, -1)) : null;
}

// Parties chargées par la boucle de scheduler.js : for (const part of [ … ]).
function loopParts(text, name = 'part') {
  const loop = new RegExp(`for\\s*\\(\\s*const\\s+${name}\\s+of\\s+\\[([^\\]]*)\\]\\s*\\)`).exec(text);
  return loop && literalList(loop[1]);
}

// require d'un fichier : littéraux, plus le seul gabarit admis, celui de
// scheduler.js, résolu par le tableau littéral de la boucle qui le précède.
// Tout autre require non littéral échoue.
function requiresOf(file, text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (comment(line)) return;
    for (const match of line.matchAll(/(?<![\w$.])require\s*\(/g)) {
      const where = `${file}:${index + 1}`;
      const rest = line.slice(match.index + match[0].length);
      const literal = /^\s*(['"])([^'"\\]+)\1\s*\)/.exec(rest);
      if (literal) { found.push({ spec: literal[2], where }); continue; }
      const template = file === 'scheduler.js' && /^\s*`([^`$\\]*)\$\{(\w+)\}([^`$\\]*)`\s*\)/.exec(rest);
      const parts = template && lines.slice(Math.max(0, index - 3), index).reverse()
        .map(previous => loopParts(previous, template[2])).find(Boolean);
      if (!parts) throw new Error(`require non résolu : ${where}`);
      for (const part of parts) found.push({ spec: template[1] + part + template[3], where });
    }
  });
  return found;
}

// Graphe statique des require depuis des points d'entrée : fichiers du dépôt
// atteints et paquets npm notés ; modules intégrés de Node ignorés.
function graph(entries) {
  const files = new Set();
  const packages = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;
    files.add(file);
    for (const { spec, where } of requiresOf(file, read(file))) {
      if (spec.startsWith('node:') || builtinModules.includes(spec)) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) {
        let target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
        if (!target.endsWith('.js')) target += '.js';
        if (target.startsWith('../') || !fs.existsSync(path.join(root, ...target.split('/')))) {
          throw new Error(`require vers un fichier absent du dépôt : ${where} → ${target}`);
        }
        queue.push(target);
      } else if (/^(@[\w.-]+\/)?[\w][\w.-]*(\/|$)/.test(spec)) {
        packages.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
      } else {
        throw new Error(`require non résolu : ${where}`);
      }
    }
  }
  return { files, packages };
}

// Lectures path.join(__dirname, '<littéral>', …) : dossier du fichier plus
// premier littéral, rapporté à la racine.
function readsOf(file, text) {
  const reads = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (comment(line)) return;
    for (const match of line.matchAll(/path\.join\(\s*__dirname\s*([,)])/g)) {
      const rest = line.slice(match.index + match[0].length);
      const first = match[1] === ')' ? '' : /^\s*(['"])([^'"\\]*)\1/.exec(rest)?.[2];
      const target = first === undefined ? '<non littéral>'
        : path.posix.normalize(path.posix.join(path.posix.dirname(file), first));
      reads.push({ where: `${file}:${index + 1}`, target });
    }
  });
  return reads;
}

function classify({ where, target }) {
  const kind = Object.keys(READS).find(key => READS[key].includes(target));
  if (!kind) throw new Error(`Lecture par path.join(__dirname, …) non classée : ${where} → ${target}`);
  return kind;
}

function coverageSources() {
  const sources = /const SOURCES = \[([\s\S]*?)\];/.exec(read('test/coverage.js'));
  assert.ok(sources, 'SOURCES introuvable dans test/coverage.js');
  const list = literalList(sources[1]);
  assert.ok(list, 'SOURCES de test/coverage.js : tableau de chaînes attendu');
  return new Set(list);
}

test('K1 livrable.json bien formé', t => {
  assert.deepEqual(Object.keys(manifest).sort(), ['commun', 'windows']);
  const entries = [];
  for (const key of ['commun', 'windows']) {
    assert.ok(Array.isArray(manifest[key]), `« ${key} » : tableau attendu`);
    assert.equal(new Set(manifest[key]).size, manifest[key].length, `doublon dans « ${key} »`);
    for (const entry of manifest[key]) {
      assert.equal(typeof entry, 'string', `« ${key} » : chaîne attendue`);
      assert.ok(entry !== '' && !entry.includes('\\') && !path.posix.isAbsolute(entry) && !path.win32.isAbsolute(entry)
        && entry.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'),
      `chemin relatif en « / » attendu : ${entry}`);
      assert.ok(!under(entry, FORBIDDEN), `dossier non livré : ${entry}`);
      assert.ok(!PRODUCTS.includes(entry), `produit de la construction listé : ${entry}`);
      assert.ok(fs.existsSync(path.join(root, ...entry.split('/'))), `entrée absente du disque : ${entry}`);
      entries.push(entry);
    }
  }
  assert.deepEqual(manifest.commun.filter(entry => manifest.windows.includes(entry)), [], 'entrée dans les deux listes');
  // Développé : aucun fichier compté deux fois (dossier qui en recouvre un
  // autre), ni produit ni fichier d'un dossier non livré.
  const files = entries.flatMap(expand);
  assert.equal(new Set(files).size, files.length, 'recouvrement entre entrées');
  for (const file of files) {
    assert.ok(!under(file, FORBIDDEN), `fichier non livrable : ${file}`);
    assert.ok(!PRODUCTS.includes(file), `produit de la construction listé : ${file}`);
  }
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  if (git.error || git.status !== 0) {
    t.skip('git ne répond pas : versionnement des entrées non vérifié');
    return;
  }
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', ...entries], { cwd: root, encoding: 'utf8' });
  assert.equal(tracked.status, 0, `entrée non versionnée : ${tracked.stderr}`);
  // Un dossier est copié tel qu'il est sur le disque : il ne doit contenir que
  // des fichiers versionnés (un fichier non suivi ou ignoré, .DS_Store par
  // exemple, partirait dans le kit et dans l'image).
  for (const entry of entries.filter(entry => fs.statSync(path.join(root, ...entry.split('/'))).isDirectory())) {
    const listed = spawnSync('git', ['ls-files', '-z', '--', entry], { cwd: root, encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(expand(entry).sort(), listed.stdout.split('\0').filter(Boolean).sort(),
      `${entry} : fichiers du disque différents des fichiers versionnés`);
  }
});

test('K2 graphe des require dans le manifeste', () => {
  const commun = expandAll(manifest.commun);
  const delivered = new Set([...commun, ...expandAll(manifest.windows)]);
  const all = graph(ENTRIES);
  const image = graph(IMAGE_ENTRIES);
  for (const part of loopParts(read('scheduler.js'))) {
    assert.ok(all.files.has(`lib/scheduler/${part}.js`), `partie du gabarit de scheduler.js non suivie : ${part}`);
  }
  for (const file of all.files) assert.ok(delivered.has(file), `${file} : chargé par require, absent de livrable.json`);
  for (const file of image.files) {
    assert.ok(commun.has(file), `${file} : chargé par le serveur, absent de « commun » (donc de l'image)`);
  }
  const dependencies = Object.keys(JSON.parse(read('package.json')).dependencies).sort();
  assert.deepEqual([...all.packages].sort(), dependencies);
  // Le parcours refuse ce qu'il ne sait pas lire : un require non littéral.
  assert.throws(() => requiresOf('exemple.js', 'const a = 1;\nconst m = require(nom);\n'),
    { message: 'require non résolu : exemple.js:2' });
  assert.throws(() => requiresOf('exemple.js', "for (const part of ['a']) {\n  require(`./lib/${part}`);\n}\n"),
    { message: 'require non résolu : exemple.js:2' });
});

test('K3 windows : lanceurs et textes', () => {
  const others = manifest.windows.filter(entry => !/\.(bat|txt|md)$/.test(entry));
  assert.deepEqual(others.sort(), [...LAUNCHERS].sort(), 'seuls .bat, .txt, .md et les deux lanceurs vont dans « windows »');
  const image = graph(IMAGE_ENTRIES).files;
  for (const file of expandAll(manifest.windows)) {
    assert.ok(!image.has(file), `${file} : chargé par le serveur, rangé dans « windows » (absent de l'image)`);
  }
  const commun = expandAll(manifest.commun);
  for (const launcher of LAUNCHERS) assert.ok(!commun.has(launcher), `${launcher} dans « commun », donc dans l'image`);
});

test('K4 lectures par __dirname classées', () => {
  const commun = expandAll(manifest.commun);
  const reads = [...graph(ENTRIES).files].flatMap(file => readsOf(file, read(file)));
  assert.ok(reads.some(entry => entry.target === 'public'), 'lecture de public/ par server.js introuvable');
  for (const entry of reads) {
    if (classify(entry) === 'livré') {
      assert.ok(manifest.commun.includes(entry.target) || commun.has(entry.target),
        `${entry.where} : ${entry.target} lu par le serveur, absent de « commun »`);
    }
  }
  assert.throws(() => classify(readsOf('exemple.js', "fs.readFileSync(path.join(__dirname, 'secret.txt'));\n")[0]),
    { message: 'Lecture par path.join(__dirname, …) non classée : exemple.js:1 → secret.txt' });
  // Produits : écrits par les constructeurs du kit et de l'image.
  const kit = read('PREPARER-KIT-BAR.ps1');
  const image = read('scripts/preparer-livrable.js');
  assert.ok(kit.includes("'build-info.json'"), 'build-info.json non produit par PREPARER-KIT-BAR.ps1');
  assert.ok(image.includes("'build-info.json'"), 'build-info.json non produit par scripts/preparer-livrable.js');
  assert.ok(kit.includes("'solver\\karafun-solver.jar'"), 'solver/karafun-solver.jar non produit par PREPARER-KIT-BAR.ps1');
});

test('K5 planificateur livré, mesuré, chargé', () => {
  const commun = expandAll(manifest.commun);
  const sources = coverageSources();
  const loader = loopParts(read('scheduler.js'));
  assert.ok(loader, 'boucle de chargement de scheduler.js introuvable');
  const parts = fs.readdirSync(path.join(root, 'lib', 'scheduler')).filter(file => file.endsWith('.js'));
  assert.ok(parts.length >= 7, `au moins 7 parties attendues : ${parts.length}`);
  for (const file of parts) {
    assert.ok(commun.has(`lib/scheduler/${file}`), `livrable.json : ${file}`);
    assert.ok(sources.has(`lib/scheduler/${file}`), `couverture : ${file}`);
    if (file !== 'common.js') assert.ok(loader.includes(file.replace(/\.js$/, '')), `planificateur : ${file}`);
  }
  for (const file of graph(ENTRIES).files) {
    if (file.endsWith('.js')) assert.ok(sources.has(file), `couverture : ${file} chargé par le serveur, absent de SOURCES`);
  }
});
