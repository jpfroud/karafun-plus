'use strict';
// Lanceur des tests choisis par gstack (test/run-files.js) : chaque fichier
// part avec son interpréteur, un échec se voit, et un fichier impossible à
// lancer ici (PowerShell absent, extension inconnue) n'est jamais un succès.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runner = path.join(__dirname, 'run-files.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'run-files-'));
const run = (...files) => spawnSync(process.execPath, [runner, ...files], { encoding: 'utf8' });
const write = (name, text) => { const file = path.join(work, name); fs.writeFileSync(file, text); return file; };

try {
  const okJs = write('ok.test.js', 'console.log("js ok")');
  const okSh = write('ok.test.sh', 'echo "sh ok"');
  let r = run(okJs, okSh);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /js ok/);
  assert.match(r.stdout, /sh ok/);

  const badSh = write('bad.test.sh', 'exit 3');
  r = run(okJs, badSh);
  assert.equal(r.status, 1, 'un test shell en échec fait échouer le lot');
  assert.match(r.stderr, /ÉCHEC : .*bad\.test\.sh/);

  const other = write('notes.test.txt', 'rien');
  r = run(other);
  assert.equal(r.status, 1, 'un fichier impossible à lancer ne passe jamais');
  assert.match(r.stderr, /NON LANCÉ : .*notes\.test\.txt/);

  const { interpreter } = require('./run-files');
  const ps = interpreter('test/gstack-hook.test.ps1');
  if (ps) assert.ok(/pwsh|powershell/i.test(ps[0]), 'PowerShell pour un .ps1');
  else {
    r = run(path.join(__dirname, 'gstack-hook.test.ps1'));
    assert.equal(r.status, 1, 'sans PowerShell, le test .ps1 est signalé, pas compté comme réussi');
    assert.match(r.stderr, /NON LANCÉ : .*gstack-hook\.test\.ps1/);
  }

  assert.equal(run().status, 64, 'sans fichier : usage');
  console.log('Lanceur des tests de gstack : interpréteur par extension, échecs et fichiers non lancés signalés OK');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
