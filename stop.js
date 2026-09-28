'use strict';
const fs = require('node:fs');
const path = require('node:path');
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3000;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port invalide.');
const file = path.join(__dirname, 'data', `runtime-${port}.json`);

(async () => {
  if (!fs.existsSync(file)) throw new Error('La file karaoké ne semble pas lancée par cette version. Ferme sa fenêtre noire avec Ctrl+C.');
  const runtime = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Number.isInteger(runtime.port) || typeof runtime.secret !== 'string') throw new Error('Fichier de session invalide.');
  const response = await fetch(`http://127.0.0.1:${runtime.port}/internal/shutdown`, {
    method: 'POST', headers: { 'x-helper-stop': runtime.secret },
  });
  if (!response.ok) throw new Error(`Arrêt refusé (HTTP ${response.status}).`);
  console.log('La file karaoké s’arrête. Tu peux ensuite relancer DEMARRER.bat.');
})().catch(error => { console.error(`Impossible d’arrêter la file karaoké : ${error.message}`); process.exitCode = 1; });
