'use strict';
// Prépare le livrable de l'image Docker : copie les fichiers de la liste
// « commun » de livrable.json (manifeste unique des fichiers livrés, lu aussi
// par PREPARER-KIT-BAR.ps1 pour le kit Windows) et écrit build-info.json.
// La liste « windows » (lanceurs .bat, textes du kit, start-evening.js et
// stop.js) n'est pas copiée : elle ne sert qu'au kit.
//
//   node scripts/preparer-livrable.js <dossier de destination>
//
// Le dossier de destination doit être hors de la source, et absent (il est
// créé) ou vide. Tous les contrôles (manifeste, destination, fichiers, liens
// symboliques, BUILT_AT) ont lieu avant la première écriture. Variables
// d'environnement lues pour build-info.json : VERSION (sinon « v » + version
// de package.json), COMMIT (sinon vide) et BUILT_AT (date ISO 8601, sinon
// l'heure de la préparation).
//
// Code de construction, non livré : hors de la mesure de couverture
// (SOURCES de test/coverage.js), comme PREPARER-KIT-BAR.ps1.
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = 'livrable.json';
const LISTS = ['commun', 'windows'];
const LISTS_ERROR = 'livrable.json : listes « commun » et « windows » attendues.';
const USAGE = 'Usage : node scripts/preparer-livrable.js <dossier de destination>';

// Règles du manifeste (vérifiées aussi par K1 de test/kit-sources.test.js) :
// rien sous les dossiers privés, de test ou de construction, et aucun produit
// de la construction, écrit par PREPARER-KIT-BAR.ps1 ou par ce script.
const FORBIDDEN = ['data', 'journal', 'test', 'node', 'node_modules', 'solver-runtime', 'LICENCES-JAVA', 'deploy', 'scripts', '.github'];
const PRODUCTS = ['KaraFun Plus.exe', 'build-info.json', 'solver/karafun-solver.jar'];

const invalidEntry = entry => new Error(`livrable.json : entrée invalide « ${entry} »`);
// Texte UTF-8, BOM éventuel retiré (fichier enregistré par un éditeur Windows).
const readText = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

// Chemin relatif en « / », sans segment vide, « . » ni « .. », hors des
// dossiers interdits, ni produit ni dossier qui contient un produit.
function validEntry(entry) {
  if (entry === '' || entry.includes('\\') || path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry)) return false;
  if (!entry.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')) return false;
  return !FORBIDDEN.some(dir => entry === dir || entry.startsWith(`${dir}/`))
    && !PRODUCTS.some(product => product === entry || product.startsWith(`${entry}/`));
}

// Lit et valide <root>/livrable.json, sans toucher au reste du disque.
function readManifest(root) {
  const text = readText(path.join(root, MANIFEST));
  let manifest;
  try { manifest = JSON.parse(text); } catch (error) { throw new Error(`livrable.json : JSON illisible (${error.message})`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || !LISTS.every(key => Array.isArray(manifest[key]) && manifest[key].every(entry => typeof entry === 'string'))) {
    throw new Error(LISTS_ERROR);
  }
  const seen = new Set();
  for (const key of LISTS) {
    for (const entry of manifest[key]) {
      // Doublon dans une liste, entrée présente dans les deux, ou entrée qui
      // contient une entrée déjà vue ou y est contenue, dans l'une ou l'autre
      // liste (fichier compté deux fois).
      if (!validEntry(entry) || seen.has(entry)) throw invalidEntry(entry);
      for (const other of seen) {
        if (entry.startsWith(`${other}/`) || other.startsWith(`${entry}/`)) throw invalidEntry(entry);
      }
      seen.add(entry);
    }
  }
  return { commun: [...manifest.commun], windows: [...manifest.windows] };
}

function lstatOrNull(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

// Fichiers désignés par les entrées : chemins relatifs à root en « / »,
// triés, dossiers développés (fichiers cachés compris). Refuse une entrée
// absente et tout lien symbolique, dans le chemin d'une entrée ou dans un
// dossier.
function listFiles(root, entries) {
  const files = [];
  const walk = relative => {
    const absolute = path.join(root, ...relative.split('/'));
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Lien symbolique refusé dans le livrable : ${relative}`);
    if (stat.isFile()) { files.push(relative); return; }
    if (!stat.isDirectory()) throw new Error(`Ni fichier ni dossier dans le livrable : ${relative}`);
    for (const name of fs.readdirSync(absolute).sort()) walk(`${relative}/${name}`);
  };
  for (const entry of entries) {
    const segments = entry.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const stat = lstatOrNull(path.join(root, ...segments.slice(0, i)));
      if (!stat) throw new Error(`Fichier du manifeste absent : ${entry}`);
      if (stat.isSymbolicLink()) throw new Error(`Lien symbolique refusé dans le livrable : ${segments.slice(0, i).join('/')}`);
    }
    walk(entry);
  }
  return files.sort();
}

function destinationEmpty(dest) {
  const stat = lstatOrNull(dest);
  if (!stat) return true;
  return stat.isDirectory() && fs.readdirSync(dest).length === 0;
}

// Chemin réel : liens symboliques résolus jusqu'au dernier parent existant.
function realPath(file) {
  const rest = [];
  let current = path.resolve(file);
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...rest); } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(file);
    rest.unshift(path.basename(current));
    current = parent;
  }
}

// Destination dans la source, racine comprise : la copie y resterait, et un
// dossier listé (public) la livrerait à la construction suivante.
function insideRoot(root, dest) {
  const relative = path.relative(realPath(root), realPath(dest));
  return relative === '' || (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..');
}

// Copie « commun » dans dest et écrit dest/build-info.json.
function prepare({ root, dest, env = process.env, now = () => new Date() }) {
  const manifest = readManifest(root);
  if (insideRoot(root, dest)) throw new Error(`Dossier de destination dans la source : ${dest}`);
  if (!destinationEmpty(dest)) throw new Error(`Dossier de destination non vide : ${dest}`);
  const files = listFiles(root, manifest.commun);
  if (env.BUILT_AT && Number.isNaN(Date.parse(env.BUILT_AT))) {
    throw new Error(`BUILT_AT invalide : ${env.BUILT_AT} (date ISO 8601 attendue)`);
  }
  // Repli de PREPARER-KIT-BAR.ps1 : « v » + version de package.json.
  const version = env.VERSION || `v${JSON.parse(readText(path.join(root, 'package.json'))).version}`;
  const info = { version, commit: env.COMMIT || '', builtAt: env.BUILT_AT || now().toISOString() };

  fs.mkdirSync(dest, { recursive: true });
  for (const relative of files) {
    const source = path.join(root, ...relative.split('/'));
    const target = path.join(dest, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, fs.statSync(source).mode & 0o7777);
  }
  fs.writeFileSync(path.join(dest, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`, { flag: 'wx' });
  return { files: files.length };
}

module.exports = { readManifest, listFiles, prepare };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error(USAGE);
    process.exitCode = 2;
  } else {
    try {
      const dest = path.resolve(args[0]);
      const { files } = prepare({ root: path.join(__dirname, '..'), dest });
      console.log(`Livrable préparé : ${dest} (${files} fichiers et build-info.json)`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
