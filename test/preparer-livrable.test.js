'use strict';
// Préparation du livrable de l'image (scripts/preparer-livrable.js, issue #21) :
// copie exacte de la liste « commun » de livrable.json, build-info.json, refus
// de la ligne de commande et du manifeste. Dossiers temporaires sous
// os.tmpdir(), supprimés en fin de test. La liste attendue est calculée ici par
// un parcours du disque, jamais par listFiles.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { prepare, listFiles } = require('../scripts/preparer-livrable');

const root = path.join(__dirname, '..');
const SCRIPT = 'scripts/preparer-livrable.js';
// Textes attendus, recopiés de la spécification (et non du script).
const USAGE = 'Usage : node scripts/preparer-livrable.js <dossier de destination>';
const LISTS_ERROR = 'livrable.json : listes « commun » et « windows » attendues.';
const invalid = entry => `livrable.json : entrée invalide « ${entry} »`;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'livrable.json'), 'utf8').replace(/^\uFEFF/, ''));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livrable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Fichiers sous base (ou sous base/relative), en chemins relatifs « / ».
function filesUnder(base, relative = '') {
  const absolute = path.join(base, ...relative.split('/').filter(Boolean));
  if (!fs.statSync(absolute).isDirectory()) return [relative];
  return fs.readdirSync(absolute).flatMap(name => filesUnder(base, relative ? `${relative}/${name}` : name));
}
const expectedFiles = (base, list) => list.flatMap(entry => filesUnder(base, entry)).sort();
const at = (base, file) => path.join(base, ...file.split('/'));
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mode = file => fs.statSync(file).mode & 0o7777;
// Environnement du lancement, sans les variables de build-info.json.
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of ['VERSION', 'COMMIT', 'BUILT_AT']) if (!(key in extra)) delete env[key];
  return env;
}
const cli = (args, env = cleanEnv()) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf8', env });

test('P1 copie exacte de commun', t => {
  const expected = expectedFiles(root, manifest.commun);
  const dest = tempDir(t);
  const run = cli([dest]);
  assert.equal(run.stderr, '');
  assert.equal(run.status, 0);
  assert.equal(run.stdout, `Livrable préparé : ${dest} (${expected.length} fichiers et build-info.json)\n`);
  const copied = filesUnder(dest).sort();
  assert.deepEqual(copied, [...expected, 'build-info.json'].sort());
  for (const file of expected) {
    assert.equal(sha256(at(dest, file)), sha256(at(root, file)), `octets : ${file}`);
    if (process.platform !== 'win32') assert.equal(mode(at(dest, file)), mode(at(root, file)), `mode : ${file}`);
  }
  const windows = new Set(expectedFiles(root, manifest.windows));
  for (const file of copied) {
    assert.ok(!windows.has(file), `fichier du kit seul copié : ${file}`);
    assert.ok(!/^(data|journal|test)\//.test(file), `fichier privé copié : ${file}`);
  }

  // Racine fabriquée : fichier exécutable, fichier caché dans un dossier,
  // lanceur de la liste « windows » non copié.
  const base = tempDir(t);
  const fake = path.join(base, 'racine');
  fs.mkdirSync(path.join(fake, 'dossier', 'sous'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'outil.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'dossier', '.cache'), 'caché\n');
  fs.writeFileSync(path.join(fake, 'dossier', 'sous', 'note.txt'), 'privé\n', { mode: 0o600 });
  fs.writeFileSync(path.join(fake, 'lanceur.bat'), '@echo off\r\n');
  fs.writeFileSync(path.join(fake, 'package.json'), '{"version":"1.2.3"}\n');
  fs.writeFileSync(path.join(fake, 'livrable.json'), JSON.stringify({ commun: ['outil.sh', 'dossier'], windows: ['lanceur.bat'] }));
  const out = path.join(base, 'sortie');
  assert.deepEqual(prepare({ root: fake, dest: out, env: {}, now: () => new Date(0) }), { files: 3 });
  assert.deepEqual(filesUnder(out).sort(), ['build-info.json', 'dossier/.cache', 'dossier/sous/note.txt', 'outil.sh']);
  for (const file of ['outil.sh', 'dossier/.cache', 'dossier/sous/note.txt']) {
    assert.equal(sha256(at(out, file)), sha256(at(fake, file)), `octets : ${file}`);
    if (process.platform !== 'win32') assert.equal(mode(at(out, file)), mode(at(fake, file)), `mode : ${file}`);
  }
});

test('P2 build-info.json', t => {
  const base = tempDir(t);
  const files = expectedFiles(root, manifest.commun).length;
  const dest = path.join(base, 'niveau', 'avec');
  const env = { VERSION: 'v9.8.7', COMMIT: '0123456789abcdef0123456789abcdef01234567', BUILT_AT: '2026-10-22T09:30:00Z' };
  const now = () => { throw new Error('now() appelé malgré BUILT_AT'); };
  assert.deepEqual(prepare({ root, dest, env, now }), { files });
  assert.equal(fs.readFileSync(path.join(dest, 'build-info.json'), 'utf8'),
    '{\n  "version": "v9.8.7",\n  "commit": "0123456789abcdef0123456789abcdef01234567",\n  "builtAt": "2026-10-22T09:30:00Z"\n}\n');

  // Sans ces variables, ou vides : « v » + package.json, commit vide, now().
  const version = `v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}`;
  const instant = new Date('2026-10-22T21:45:12.345Z');
  for (const [name, vars] of [['sans', {}], ['vides', { VERSION: '', COMMIT: '', BUILT_AT: '' }]]) {
    const out = path.join(base, name);
    assert.deepEqual(prepare({ root, dest: out, env: vars, now: () => instant }), { files });
    const text = fs.readFileSync(path.join(out, 'build-info.json'), 'utf8');
    assert.equal(text, `{\n  "version": "${version}",\n  "commit": "",\n  "builtAt": "2026-10-22T21:45:12.345Z"\n}\n`, name);
    assert.deepEqual(Object.keys(JSON.parse(text)), ['version', 'commit', 'builtAt']);
  }
});

test('P3 refus de la ligne de commande', t => {
  for (const args of [[], ['un', 'deux']]) {
    const run = cli(args);
    assert.equal(run.status, 2, `arguments : ${args.length}`);
    assert.equal(run.stderr, `${USAGE}\n`);
    assert.equal(run.stdout, '');
  }

  const base = tempDir(t);
  const full = path.join(base, 'plein');
  fs.mkdirSync(full);
  fs.writeFileSync(path.join(full, 'garde.txt'), 'à garder\n');
  const refused = cli([full]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, `Dossier de destination non vide : ${full}\n`);
  assert.equal(refused.stdout, '');
  assert.deepEqual(fs.readdirSync(full), ['garde.txt']);
  assert.equal(fs.readFileSync(path.join(full, 'garde.txt'), 'utf8'), 'à garder\n');

  const fresh = path.join(base, 'neuf');
  const late = cli([fresh], cleanEnv({ BUILT_AT: 'hier' }));
  assert.equal(late.status, 1);
  assert.equal(late.stderr, 'BUILT_AT invalide : hier (date ISO 8601 attendue)\n');
  assert.equal(late.stdout, '');
  assert.equal(fs.existsSync(fresh), false, 'dossier créé malgré le refus');
  assert.deepEqual(fs.readdirSync(base), ['plein']);

  // Destination qui est un fichier ordinaire : refusée comme non vide, fichier
  // inchangé.
  const file = path.join(base, 'fichier.txt');
  fs.writeFileSync(file, 'à garder\n');
  const onFile = cli([file]);
  assert.equal(onFile.status, 1);
  assert.equal(onFile.stderr, `Dossier de destination non vide : ${file}\n`);
  assert.equal(onFile.stdout, '');
  assert.equal(fs.readFileSync(file, 'utf8'), 'à garder\n');

  // Destination dans la source (dossier listé, autre dossier, racine elle-même,
  // chemin passant par un lien vers la racine) : refus, rien d'écrit.
  const source = path.join(base, 'source');
  fs.mkdirSync(path.join(source, 'public'), { recursive: true });
  fs.writeFileSync(path.join(source, 'public', 'a.html'), '<p>a</p>\n');
  fs.writeFileSync(path.join(source, 'package.json'), '{"version":"1.0.0"}\n');
  fs.writeFileSync(path.join(source, 'livrable.json'), JSON.stringify({ commun: ['public', 'package.json'], windows: [] }));
  const inside = [path.join(source, 'public', 'build'), path.join(source, 'sortie'), source];
  try {
    fs.symlinkSync(source, path.join(base, 'lien-source'), 'dir');
    inside.push(path.join(base, 'lien-source', 'sortie'));
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
  for (const dest of inside) {
    assert.throws(() => prepare({ root: source, dest, env: {}, now: () => new Date(0) }),
      { message: `Dossier de destination dans la source : ${dest}` });
  }
  assert.deepEqual(filesUnder(source).sort(), ['livrable.json', 'package.json', 'public/a.html']);
});

test('P4 manifeste invalide', t => {
  const base = tempDir(t);
  const fake = path.join(base, 'racine');
  fs.mkdirSync(path.join(fake, 'dossier'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(fake, 'dossier', 'b.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(fake, 'package.json'), '{"version":"1.0.0"}\n');
  const dest = path.join(base, 'sortie');
  const write = content => fs.writeFileSync(path.join(fake, 'livrable.json'), JSON.stringify(content));
  const refuse = (content, message) => {
    write(content);
    assert.throws(() => prepare({ root: fake, dest, env: {}, now: () => new Date(0) }), { message }, JSON.stringify(content));
    assert.equal(fs.existsSync(dest), false, `écriture malgré le refus : ${JSON.stringify(content)}`);
  };

  for (const content of [{}, { commun: ['a.js'] }, { windows: [] }, { commun: 'a.js', windows: [] },
    { commun: [1], windows: [] }, { commun: [], windows: [null] }, [], null, 'a.js']) refuse(content, LISTS_ERROR);
  for (const entry of ['../x', '/x', 'a\\b', '', '.', './a.js', 'dossier/../a.js', 'dossier/.']) {
    refuse({ commun: [entry], windows: [] }, invalid(entry));
  }
  refuse({ commun: ['a.js', 'a.js'], windows: [] }, invalid('a.js'));
  refuse({ commun: [], windows: ['x.bat', 'x.bat'] }, invalid('x.bat'));
  refuse({ commun: ['a.js'], windows: ['a.js'] }, invalid('a.js'));
  // Recouvrement, dans une liste ou d'une liste à l'autre, dans les deux sens ;
  // entrée invalide dans « windows ».
  refuse({ commun: ['dossier', 'dossier/b.js'], windows: [] }, invalid('dossier/b.js'));
  refuse({ commun: ['dossier/b.js', 'dossier'], windows: [] }, invalid('dossier'));
  refuse({ commun: ['dossier/b.js'], windows: ['dossier'] }, invalid('dossier'));
  refuse({ commun: [], windows: ['../x'] }, invalid('../x'));
  // Dossiers privés, de test ou de construction, et produits de la construction.
  for (const entry of ['data', 'data/staff-key', 'journal', 'test/x.js', 'node', 'node_modules/qrcode', 'solver-runtime',
    'LICENCES-JAVA', 'deploy/.env', 'scripts/preparer-livrable.js', '.github', 'KaraFun Plus.exe', 'build-info.json',
    'solver/karafun-solver.jar', 'solver']) {
    refuse({ commun: [entry], windows: [] }, invalid(entry));
  }
  refuse({ commun: [], windows: ['data'] }, invalid('data'));
  // Sans casse (disque Windows ou macOS : « Data » désigne data/), et segments
  // que Windows lit autrement : point ou espace final retiré, « : » de flux
  // NTFS ou de lecteur.
  for (const entry of ['Data', 'DATA/x', 'Node_Modules', 'licences-java', 'Build-Info.json', 'Solver', 'data.', 'data ',
    'a.js.', 'dossier /b.js', 'C:data', 'a.js:flux']) {
    refuse({ commun: [entry], windows: [] }, invalid(entry));
  }
  refuse({ commun: ['a.js', 'A.js'], windows: [] }, invalid('A.js'));
  refuse({ commun: ['dossier'], windows: ['Dossier/b.js'] }, invalid('Dossier/b.js'));
  refuse({ commun: ['absent.js'], windows: [] }, 'Fichier du manifeste absent : absent.js');
  refuse({ commun: ['dossier/absent.js'], windows: [] }, 'Fichier du manifeste absent : dossier/absent.js');
  // JSON illisible : message du script, rien d'écrit.
  fs.writeFileSync(path.join(fake, 'livrable.json'), '{');
  assert.throws(() => prepare({ root: fake, dest, env: {}, now: () => new Date(0) }),
    { message: /^livrable\.json : JSON illisible \(/ });
  assert.equal(fs.existsSync(dest), false, 'écriture malgré le JSON illisible');

  // Témoin : la même racine, avec un manifeste valide, se prépare.
  write({ commun: ['a.js', 'dossier'], windows: ['lanceur.bat'] });
  const witness = path.join(base, 'temoin');
  assert.deepEqual(prepare({ root: fake, dest: witness, env: {}, now: () => new Date(0) }), { files: 2 });
  // Manifeste enregistré avec un BOM (éditeur Windows) : lu comme sans BOM.
  fs.writeFileSync(path.join(fake, 'livrable.json'), `\uFEFF${JSON.stringify({ commun: ['a.js'], windows: [] })}`);
  assert.deepEqual(prepare({ root: fake, dest: path.join(base, 'bom'), env: {}, now: () => new Date(0) }), { files: 1 });

  // Fichier spécial (tube nommé) dans un dossier listé : refusé avant toute
  // écriture. listFiles d'abord : sans ce refus, il échoue tout de suite, là où
  // prepare() resterait bloqué dans la copie du tube.
  if (process.platform !== 'win32') {
    const tube = path.join(fake, 'dossier', 'tube');
    const made = spawnSync('mkfifo', [tube]);
    if (made.error || made.status !== 0) t.diagnostic('mkfifo indisponible : cas du tube nommé sauté');
    else {
      assert.throws(() => listFiles(fake, ['dossier']), { message: 'Ni fichier ni dossier dans le livrable : dossier/tube' });
      refuse({ commun: ['dossier'], windows: [] }, 'Ni fichier ni dossier dans le livrable : dossier/tube');
      fs.rmSync(tube);
    }
  }

  try {
    fs.symlinkSync('a.js', path.join(fake, 'lien.js'));
    fs.symlinkSync(path.join('..', 'a.js'), path.join(fake, 'dossier', 'lien.js'));
    fs.symlinkSync('dossier', path.join(fake, 'lienrep'), 'dir');
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    t.skip(`liens symboliques impossibles à créer sur ce Windows (${error.code})`);
    return;
  }
  refuse({ commun: ['lien.js'], windows: [] }, 'Lien symbolique refusé dans le livrable : lien.js');
  refuse({ commun: ['a.js', 'dossier'], windows: [] }, 'Lien symbolique refusé dans le livrable : dossier/lien.js');
  // Lien sur un segment intermédiaire de l'entrée.
  refuse({ commun: ['lienrep/b.js'], windows: [] }, 'Lien symbolique refusé dans le livrable : lienrep');
});
