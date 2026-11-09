'use strict';
// Lanceur des fichiers de test choisis par gstack (pregate de verify et de
// ship, .gstack/pregate.json « runner ») : chaque fichier part avec son
// interpréteur, d'après son extension. node --test ne lance que du
// JavaScript, alors que les hooks gstack se testent aussi en bash et en
// PowerShell (test/gstack-session-hook.test.sh, test/gstack-hook.test.ps1).
//
//   node test/run-files.js <fichier>...
//
// Code 0 si tous passent. Un fichier qu'aucun interpréteur présent ne sait
// lancer (PowerShell absent sous Linux, extension inconnue) n'est jamais
// compté comme réussi : il est nommé et le code de sortie est 1.
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

function has(command) {
  const probe = spawnSync(command, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true });
  return !probe.error && probe.status === 0;
}

function interpreter(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.js', '.cjs', '.mjs'].includes(ext)) return [process.execPath, [file]];
  if (ext === '.sh') return ['bash', [file]];
  if (ext === '.ps1') {
    const shell = ['pwsh', 'powershell.exe'].find(has);
    return shell ? [shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]] : null;
  }
  return null;
}

function main(files) {
  if (!files.length) {
    console.error('Usage : node test/run-files.js <fichier de test>...');
    return 64;
  }
  const failed = [];
  for (const file of files) {
    const command = interpreter(file);
    if (!command) {
      console.error(`NON LANCÉ : ${file} (aucun interpréteur disponible pour ce type de fichier ; PowerShell s'essaie sous Windows ou dans la CI)`);
      failed.push(file);
      continue;
    }
    console.log(`# ${file}`);
    const run = spawnSync(command[0], command[1], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (run.error || run.status !== 0) failed.push(file);
  }
  if (failed.length) console.error(`ÉCHEC : ${failed.join(', ')}`);
  return failed.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { interpreter, main };
