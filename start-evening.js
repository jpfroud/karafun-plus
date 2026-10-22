'use strict';
// Point d'entrée en un clic pour le PC du bar.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

// Port du bar lu comme server.js (--port, sinon PORT, sinon 3000) : la valeur
// qui suit --port (absente ou en -- : invalide), par parseInt. Un port que
// server.js ne pourrait pas ouvrir est refusé avant tout lancement.
function barPort(argv = process.argv.slice(2), env = process.env) {
  const at = argv.indexOf('--port');
  const text = at >= 0 ? (argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : '') : (env.PORT || '3000');
  const port = parseInt(text, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port invalide.');
  return port;
}

function barUrl(port = barPort()) {
  return `http://localhost:${port}/`;
}

function locateKaraFun(env = process.env) {
  const candidates = [
    env.KARAFUN_EXE,
    env.ProgramFiles && path.join(env.ProgramFiles, 'KaraFun', 'KaraFun.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'KaraFun', 'KaraFun.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'KaraFun', 'KaraFun.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'KaraFun', 'KaraFun.exe'),
  ].filter(Boolean);
  return candidates.find(file => fs.existsSync(file)) || null;
}

function karafunRunning() {
  return new Promise(resolve => {
    // Get-Process fonctionne aussi sur les PC où tasklist est refusé.
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-Process -Name KaraFun -ErrorAction SilentlyContinue | Measure-Object).Count'],
      { windowsHide: true, timeout: 5000 }, (error, output) => {
        resolve(error ? null : Number(output.trim()) > 0);
      });
  });
}

// Page du bar dans le navigateur de ce PC (Windows seulement). Un échec du
// lancement (cmd.exe absent) est expliqué, sans trace de pile.
function openBar(url) {
  const child = spawn('cmd.exe', ['/c', 'start', '', url],
    { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', error => {
    console.error(`Ouverture de la page du bar impossible (${error.code || error.message}) : ouvre ${url} dans ton navigateur.`);
  });
  child.unref();
}

async function helperRunning(port = barPort()) {
  try {
    const response = await fetch(barUrl(port), { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    if (response.status === 302 && /^\/staff\?key=/.test(response.headers.get('location') || '')) return true;
    throw Object.assign(new Error(`Le port ${port} est utilisé par un autre programme.`), { code: 'PORT_TAKEN' });
  } catch (error) {
    if (error.code === 'PORT_TAKEN') throw error;
    return false;
  }
}

async function main() {
  const port = barPort();
  const BAR_URL = barUrl(port);
  if (process.platform === 'win32') {
    const running = await karafunRunning();
    const karaFun = locateKaraFun();
    if (running === false && karaFun) {
      const child = spawn(karaFun, [], { detached: true, windowsHide: false, stdio: 'ignore' });
      // KaraFun impossible à lancer : le bar l'ouvre lui-même, la file démarre quand même.
      child.on('error', error => {
        console.error(`KaraFun n’a pas pu être lancé (${error.code || error.message}) : ouvre-le manuellement, puis active sa télécommande.`);
      });
      child.unref();
      console.log('KaraFun démarre. Active sa télécommande si elle ne l’est pas déjà.');
    } else if (running === false && !karaFun) {
      console.log('KaraFun introuvable aux emplacements habituels : ouvre-le manuellement, puis active sa télécommande.');
    } else if (running === null) console.log('Ouvre KaraFun manuellement si sa fenêtre ne s’affiche pas.');
  }
  if (await helperRunning(port)) {
    if (process.platform === 'win32') {
      console.log('La file karaoké tourne déjà : ouverture de la page du bar. Si elle affiche « essais arrêtés », clique sur « Reconnecter » une fois la Télécommande de KaraFun activée.');
      openBar(BAR_URL);
    } else {
      // Hors de Windows (copie du dépôt sous Linux) : aucun programme lancé.
      console.log(`La file karaoké tourne déjà : ouvre la page du bar à l’adresse ${BAR_URL}. Si elle affiche « essais arrêtés », clique sur « Reconnecter » une fois la Télécommande de KaraFun activée.`);
    }
    return;
  }
  console.log('La file karaoké démarre. Si le code KaraFun a changé, saisis-le sur la page du bar.');
  require('./server');
}

if (require.main === module) main().catch(error => {
  console.error(`Démarrage impossible : ${error.message}`);
  process.exitCode = 1;
});

module.exports = { karafunRunning, helperRunning, locateKaraFun, barPort, barUrl };
