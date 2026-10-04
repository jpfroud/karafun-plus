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
function start({ capture = false } = {}) {
  // Le dossier peut mémoriser un vrai code de télécommande. Ce test de ports
  // ne doit jamais se connecter à la soirée KaraFun ouverte sur le PC.
  const child = spawn(process.execPath, ['server.js', '--demo', '--song-seconds', '4',
    '--port', String(PORT), '--no-open'],
    { cwd: root, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
  // Ce que le serveur affiche est aussi écrit dans journal\serveur-<date>.log.
  child.output = '';
  if (capture) child.stdout.on('data', chunk => { child.output += chunk; });
  return child;
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
    first = start({ capture: true });
    for (let i = 0; i < 50 && !(await state()); i++) await sleep(100);
    assert.ok(await state(), 'Premier serveur non démarré');
    // Regression: relecture PR #11 — le guide permet d'envoyer le journal sans
    // la ligne « Clé du bar » : la clé ne doit apparaître sur aucune autre.
    for (let i = 0; i < 50 && !first.output.includes('Laisse cette fenêtre ouverte'); i++) await sleep(100);
    const lines = first.output.split(/\r?\n/);
    const key = /Clé du bar \(autre appareil\)\s*: (\S+)/.exec(first.output)?.[1];
    assert.ok(key && key.length >= 16, 'clé du bar affichée au démarrage');
    assert.deepEqual(lines.filter(line => line.includes(key)).map(line => line.split(':')[0].trim()), ['Clé du bar (autre appareil)'],
      'la clé du bar n’apparaît que sur sa ligne');
    assert.ok(lines.some(line => line.startsWith('Page du bar (sur ce PC)') && line.endsWith(`http://localhost:${PORT}/`)));
    const home = await fetch(url, { redirect: 'manual' });
    assert.equal(home.headers.get('location'), `/staff?key=${key}`, 'l’adresse sans clé ouvre la page du bar sur ce PC');
    console.log('ok - clé du bar sur sa seule ligne du journal');
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
