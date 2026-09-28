'use strict';
// Point d'entrée en un clic pour le PC du bar.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const BAR_URL = 'http://localhost:3000/';

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

function openBar() {
  spawn('cmd.exe', ['/c', 'start', '', BAR_URL],
    { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
}

async function helperRunning() {
  try {
    const response = await fetch(BAR_URL, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    if (response.status === 302 && /^\/staff\?key=/.test(response.headers.get('location') || '')) return true;
    throw new Error('Le port 3000 est utilisé par un autre programme.');
  } catch (error) {
    if (error.message === 'Le port 3000 est utilisé par un autre programme.') throw error;
    return false;
  }
}

async function main() {
  if (process.platform === 'win32') {
    const running = await karafunRunning();
    const karaFun = locateKaraFun();
    if (running === false && karaFun) {
      spawn(karaFun, [], { detached: true, windowsHide: false, stdio: 'ignore' }).unref();
      console.log('KaraFun démarre. Active sa télécommande si elle ne l’est pas déjà.');
    } else if (running === false && !karaFun) {
      console.log('KaraFun introuvable aux emplacements habituels : ouvre-le manuellement, puis active sa télécommande.');
    } else if (running === null) console.log('Ouvre KaraFun manuellement si sa fenêtre ne s’affiche pas.');
  }
  if (await helperRunning()) {
    console.log('La file karaoké tourne déjà : ouverture de la page du bar.');
    openBar();
    return;
  }
  console.log('La file karaoké démarre. Si le code KaraFun a changé, saisis-le sur la page du bar.');
  require('./server');
}

if (require.main === module) main().catch(error => {
  console.error(`Démarrage impossible : ${error.message}`);
  process.exitCode = 1;
});

module.exports = { karafunRunning, helperRunning, locateKaraFun };
