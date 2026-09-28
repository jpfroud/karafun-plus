'use strict';
// Un deuxième démarrage ou un port de tunnel occupé ne doit laisser aucun
// deuxième serveur en marche (risque de tunnel vers la mauvaise instance).
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const root = path.join(__dirname, '..');
const PORT = 3130;
const url = `http://127.0.0.1:${PORT}/`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function state() {
  try { const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000) }); return r.status === 302 ? true : null; }
  catch { return null; }
}
function start() {
  // Le dossier peut mémoriser un vrai code de télécommande. Ce test de ports
  // ne doit jamais se connecter à la soirée KaraFun ouverte sur le PC.
  return spawn(process.execPath, ['server.js', '--demo', '--song-seconds', '4',
    '--port', String(PORT), '--no-open'],
    { cwd: root, windowsHide: true, stdio: 'ignore' });
}
async function stopped(child, timeout = 5000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Serveur concurrent resté actif')); }, timeout);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

(async () => {
  assert.equal(await state(), null, `Port ${PORT} occupé avant le test`);
  let first;
  try {
    first = start();
    for (let i = 0; i < 50 && !(await state()); i++) await sleep(100);
    assert.ok(await state(), 'Premier serveur non démarré');
    const second = start();
    assert.equal(await stopped(second), 1, 'Deuxième instance devrait quitter avec erreur');
    assert.ok(await state(), 'La deuxième instance a perturbé la première');
    console.log('ok - deuxième lancement refusé, première instance conservée');
  } finally {
    if (first && first.exitCode === null) { first.kill(); await stopped(first); }
  }
  for (let i = 0; i < 30 && await state(); i++) await sleep(100);
  assert.equal(await state(), null, 'Premier serveur encore actif');

  const occupied = net.createServer();
  await new Promise(resolve => occupied.listen(PORT + 1, '127.0.0.1', resolve));
  try {
    const helper = start();
    assert.equal(await stopped(helper), 1, 'Port client occupé devrait arrêter le helper');
    assert.equal(await state(), null, 'Port du bar abandonné ouvert après échec du port client');
    console.log('ok - port du tunnel occupé : helper arrêté entièrement');
  } finally {
    await new Promise(resolve => occupied.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
