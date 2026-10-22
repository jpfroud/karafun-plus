'use strict';
// Mode serveur, socle (issue #24), dans de vrais processus : refus de démarrer
// (R1), démarrage avec fichier de clé (R2), fuseau horaire (R3), adresses
// d'écoute (R4) et data/staff-key réelle dans une copie (R8). Jamais de
// KaraFun réel : faux KaraFun de la démo (R2 à R4), arrêt avant main() (R1),
// copie sans data/ ni code de télécommande (R8).
//
// Ports de ces tests : P, P+1 et P+1001 (faux KaraFun de la démo), P de 3230
// à 3238 (3240 sert à priority-undo-api.test.js).
//
// Les aides exportées (portFree, choosePort, serverEnv, sandboxCopy, launch,
// waitLine) servent aux autres tests du mode serveur : les tests de ce fichier
// ne tournent que s'il est lancé directement.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const temporary = [];
const launched = new Set();

async function portFree(port) {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    return true;
  } catch (error) {
    if (error.code === 'EADDRINUSE') return false;
    throw error;
  } finally {
    if (probe.listening) await new Promise(resolve => probe.close(resolve));
  }
}

// Premier P de 3230 à 3238 dont P (bar), P+1 (clients) et P+1001 (faux
// KaraFun de la démo) sont libres.
async function choosePort() {
  for (let port = 3230; port <= 3238; port++) {
    if (await portFree(port) && await portFree(port + 1) && await portFree(port + 1001)) return port;
  }
  throw new Error('Aucun groupe de ports libre entre 3230 et 3238.');
}

// Fichier de clé du bar du test, tiré une fois par processus, supprimé à la fin.
let keyFile = null;
function testKeyFile() {
  if (!keyFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-server-key-'));
    temporary.push(dir);
    keyFile = path.join(dir, 'staff-key');
    fs.writeFileSync(keyFile, `${crypto.randomBytes(24).toString('base64url')}\n`, { mode: 0o600 });
  }
  return keyFile;
}

// Environnement du mode serveur : celui du test sans KARAOKE_*, les variables
// du harnais de server-mode.test.js sauf KARAOKE_CLIENT_IP_HEADER, la clé dans
// un fichier temporaire, puis `overrides` (undefined retire).
function serverEnv(overrides = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('KARAOKE_')));
  Object.assign(env, { KARAOKE_MODE: 'server', KARAOKE_PUBLIC_URL: 'https://clients.exemple.fr',
    KARAOKE_STAFF_URL: 'https://bar.exemple.fr', KARAOKE_STAFF_KEY_FILE: testKeyFile() });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

// Copie temporaire du serveur (comme night-restart-api.test.js, sans injection
// de panne ni data/) : .js de la racine, lib/, solver/bridge.js sans le jar,
// public/. launch() y ajoute NODE_PATH vers les node_modules du dépôt.
function sandboxCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karafun-server-mode-'));
  temporary.push(dir);
  for (const name of fs.readdirSync(root).filter(name => name.endsWith('.js'))) {
    fs.copyFileSync(path.join(root, name), path.join(dir, name));
  }
  fs.cpSync(path.join(root, 'lib'), path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'solver'));
  fs.copyFileSync(path.join(root, 'solver', 'bridge.js'), path.join(dir, 'solver', 'bridge.js'));
  fs.cpSync(path.join(root, 'public'), path.join(dir, 'public'), { recursive: true });
  return dir;
}

function runtimeFile(child) {
  const i = child.spawnargs.indexOf('--port');
  return i >= 0 ? path.join(child.cwd, 'data', `runtime-${child.spawnargs[i + 1]}.json`) : null;
}
// Fichier d'arrêt laissé par un serveur tué : supprimé s'il est le sien.
function removeRuntime(child) {
  const file = runtimeFile(child);
  try { if (file && JSON.parse(fs.readFileSync(file, 'utf8')).pid === child.pid) fs.unlinkSync(file); }
  catch (_) { /* absent ou d'un autre serveur */ }
}
const running = child => child.exitCode === null && child.signalCode === null;

// node server.js <args> ; stdout et stderr gardés (child.stdoutText,
// child.stderrText), child.exited rend { code, signal }, child.stop() arrête
// le serveur à coup sûr.
function launch(args, { env, cwd = root } = {}) {
  const childEnv = { ...(env || serverEnv()) };
  if (path.resolve(cwd) !== root) {
    childEnv.NODE_PATH = [path.join(root, 'node_modules'), childEnv.NODE_PATH].filter(Boolean).join(path.delimiter);
  }
  const child = spawn(process.execPath, ['server.js', ...args], { cwd, env: childEnv, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.cwd = cwd;
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { child.stdoutText += chunk; });
  child.stderr.on('data', chunk => { child.stderrText += chunk; });
  child.exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stop = async () => {
    if (running(child)) {
      child.kill();
      const timer = setTimeout(() => { if (running(child)) child.kill('SIGKILL'); }, 5000);
      await child.exited;
      clearTimeout(timer);
    }
    removeRuntime(child);
    launched.delete(child);
  };
  launched.add(child);
  return child;
}

// Sorties d'un processus pour un message d'échec, liens de clé masqués.
const outputs = child => `stdout :\n${child.stdoutText}\nstderr :\n${child.stderrText}`.replace(/key=[A-Za-z0-9_%-]+/g, 'key=…');
const completeLines = child => child.stdoutText.split(/\r?\n/).slice(0, -1);

// Première ligne complète de stdout qui commence par `prefix`.
async function waitLine(child, prefix, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const line = completeLines(child).find(text => text.startsWith(prefix));
    if (line !== undefined) return line;
    if (!running(child) || Date.now() > deadline) {
      throw new Error(`Ligne « ${prefix} » absente (${running(child) ? `${ms} ms écoulées` :
        `processus terminé : ${child.exitCode ?? child.signalCode}`}).\n${outputs(child)}`);
    }
    await sleep(50);
  }
}

process.on('exit', () => {
  for (const child of launched) {
    if (running(child)) child.kill('SIGKILL');
    removeRuntime(child);
  }
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

module.exports = { portFree, choosePort, serverEnv, sandboxCopy, launch, waitLine };

// ---------------------------------------------------------------- tests
if (require.main === module) {
  const { test } = require('node:test');
  const { staffKey } = require('./staff-auth');
  const demoArgs = port => ['--demo', '--song-seconds', '4', '--port', String(port), '--no-open'];
  const fingerprint = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  const WARNING = 'Attention : fuseau horaire UTC. L’heure de fermeture et les heures du journal seront décalées : fixe TZ=Europe/Paris.';
  // Fichiers de data/ et journal/ (nom, taille, contenu de data/staff-key) d'un dossier.
  const footprint = dir => {
    const listing = {};
    for (const sub of ['data', 'journal']) {
      let names = [];
      try { names = fs.readdirSync(path.join(dir, sub)); } catch (_) { /* dossier absent */ }
      for (const name of names) {
        const file = path.join(dir, sub, name);
        const stat = fs.statSync(file);
        listing[`${sub}/${name}`] = stat.isFile() ? stat.size : 'dossier';
      }
    }
    try { listing['data/staff-key (contenu)'] = fs.readFileSync(path.join(dir, 'data', 'staff-key'), 'utf8'); }
    catch (_) { /* absent */ }
    return listing;
  };
  // Lignes ajoutées aux journal/serveur-<date>.log depuis `before` (tailles).
  const journalSizes = () => Object.fromEntries(Object.entries(footprint(root))
    .filter(([name]) => /^journal\/serveur-.*\.log$/.test(name)));
  const journalAdded = before => Object.keys(journalSizes()).map(name => {
    const text = fs.readFileSync(path.join(root, name));
    return text.subarray(before[name] || 0).toString('utf8');
  }).join('');
  const reachable = (host, port, ms = 5000) => new Promise(resolve => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); resolve('TIMEOUT'); }, ms);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve('ok'); });
    socket.once('error', error => { clearTimeout(timer); resolve(error.code); });
  });
  const lanIPv4 = () => Object.values(os.networkInterfaces()).flat()
    .find(a => a && a.family === 'IPv4' && !a.internal)?.address || null;

  test('R1 refus réels : code 1, raison exacte sur stderr, aucun port ni fichier', async () => {
    const port = await choosePort();
    const absent = path.join(os.tmpdir(), `karafun-cle-absente-${crypto.randomUUID()}`);
    const cases = [
      [{ KARAOKE_MODE: 'serveur' }, [],
        'KARAOKE_MODE vaut « serveur » : seule la valeur server est reconnue (retire la variable pour le mode PC).'],
      // Avec --server aussi : une valeur inconnue refuse dans tous les cas.
      [{ KARAOKE_MODE: 'serveur' }, ['--server'],
        'KARAOKE_MODE vaut « serveur » : seule la valeur server est reconnue (retire la variable pour le mode PC).'],
      [{ KARAOKE_PUBLIC_URL: undefined }, [],
        'KARAOKE_PUBLIC_URL manque : indique l’adresse HTTPS des QR clients, par exemple https://chant.exemple.fr.'],
      [{ KARAOKE_PUBLIC_URL: 'http://clients.exemple.fr' }, [],
        'KARAOKE_PUBLIC_URL invalide : Une adresse accessible depuis Internet doit utiliser HTTPS.'],
      [{ KARAOKE_PUBLIC_URL: 'http://192.168.1.5:3000' }, [], 'KARAOKE_PUBLIC_URL doit commencer par https://.'],
      [{ KARAOKE_PUBLIC_URL: 'https://clients.exemple.fr/x' }, [],
        'KARAOKE_PUBLIC_URL invalide : Indique seulement l’adresse de base, sans chemin, paramètres ni identifiants.'],
      [{ KARAOKE_STAFF_URL: undefined }, [],
        'KARAOKE_STAFF_URL manque : indique l’adresse HTTPS de la page du bar, par exemple https://bar.exemple.fr.'],
      [{ KARAOKE_STAFF_URL: 'https://clients.exemple.fr' }, [],
        'KARAOKE_STAFF_URL doit différer de KARAOKE_PUBLIC_URL : la page du bar n’est jamais servie par l’adresse des clients.'],
      [{ KARAOKE_BIND: 'localhost' }, [],
        'KARAOKE_BIND invalide (« localhost ») : indique une adresse IP, par exemple 127.0.0.1 ou 0.0.0.0.'],
      [{ KARAOKE_TRUSTED_PROXIES: '10.0.0.0/40' }, [],
        'KARAOKE_TRUSTED_PROXIES invalide (« 10.0.0.0/40 ») : indique des blocs CIDR séparés par des virgules, par exemple 172.16.0.0/12.'],
      [{ KARAOKE_CLIENT_IP_HEADER: 'x real ip' }, [],
        'KARAOKE_CLIENT_IP_HEADER invalide (« x real ip ») : indique un nom d’en-tête HTTP, par exemple x-real-ip.'],
      [{ KARAOKE_STAFF_KEY_FILE: absent }, [], `KARAOKE_STAFF_KEY_FILE illisible (${absent} : ENOENT).`],
    ];
    for (const [overrides, extra, reason] of cases) {
      const label = `${JSON.stringify(overrides)} ${extra.join(' ')}`;
      const before = footprint(root);
      const child = launch([...demoArgs(port), ...extra], { env: serverEnv(overrides) });
      try {
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        const { code } = await child.exited;
        clearTimeout(timer);
        assert.equal(code, 1, `${label} : code de sortie\n${outputs(child)}`);
        assert.equal(child.stderrText, `Impossible de démarrer : ${reason}\n`, label);
        assert.equal(child.stdoutText, '', `${label} : rien sur stdout`);
        assert.equal(await portFree(port), true, `${label} : port ${port}`);
        assert.equal(await portFree(port + 1), true, `${label} : port ${port + 1}`);
        assert.deepEqual(footprint(root), before, `${label} : data/ et journal/ inchangés`);
      } finally { await child.stop(); }
    }
  });

  test('R2 démarrage réel avec fichier de clé : clé jamais écrite, boucle locale sans droit', async () => {
    const port = await choosePort();
    const env = serverEnv();
    const keyFile = env.KARAOKE_STAFF_KEY_FILE;
    const key = fs.readFileSync(keyFile, 'utf8').trim();
    const base = `http://127.0.0.1:${port}`;
    const before = journalSizes();
    const child = launch(demoArgs(port), { env });
    try {
      await waitLine(child, 'Adresse des téléphones');
      const runtimePath = path.join(root, 'data', `runtime-${port}.json`);
      let runtime = null;
      for (let i = 0; i < 100 && !runtime; i++) {
        try { runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8')); } catch (_) { await sleep(50); }
      }
      assert.equal(runtime?.pid, child.pid, 'data/runtime-<P>.json écrit par ce serveur');
      const state = await fetch(`${base}/api/staff/state?key=${encodeURIComponent(await staffKey(base, { keyFile }))}`);
      assert.equal(state.status, 200);
      assert.equal((await state.json()).app.mode, 'server');
      for (const p of [port, port + 1]) {
        const home = await fetch(`http://127.0.0.1:${p}/`, { redirect: 'manual' });
        assert.equal(home.status, 403, `GET / sur ${p}`);
        assert.equal(home.headers.get('location'), null, `GET / sur ${p} : aucun en-tête location`);
        assert.equal(await home.text(), 'Scanne le QR code de ta table.');
      }
      const shutdown = await fetch(`${base}/internal/shutdown`, { method: 'POST', headers: { 'x-helper-stop': runtime.secret } });
      assert.equal(shutdown.status, 404);
      assert.deepEqual(await shutdown.json(), { error: 'Introuvable' });
      await sleep(1000);
      assert.equal(running(child), true, 'serveur toujours en marche 1 s après');
      assert.equal((await fetch(`${base}/api/staff/state?key=${encodeURIComponent(key)}`)).status, 200, 'serveur encore joignable');
      const logged = journalAdded(before);
      assert.ok(logged.length > 0, 'nouvelles lignes dans journal/serveur-<date>.log');
      for (const [where, text] of [['stdout', child.stdoutText], ['stderr', child.stderrText], ['journal', logged]]) {
        assert.equal(text.includes(key), false, `${where} : la clé n’apparaît pas`);
        assert.equal(text.includes('staff?key='), false, `${where} : aucun lien avec clé`);
        assert.equal(text.includes('Laisse cette fenêtre ouverte'), false, where);
      }
      for (const [where, text] of [['stdout', child.stdoutText], ['journal', logged]]) {
        assert.ok(text.includes('Mode                           : serveur'), `${where} : ligne du mode`);
        assert.ok(text.includes(`Clé du bar                     : empreinte ${fingerprint(key)} (KARAOKE_STAFF_KEY_FILE)`), where);
      }
    } finally { await child.stop(); }
  });

  test('R3 fuseau réel : avertissement seulement en UTC', async () => {
    for (const [zone, warned] of [['UTC', true], ['Europe/Paris', false]]) {
      const port = await choosePort();
      const child = launch(demoArgs(port), { env: serverEnv({ TZ: zone }) });
      try {
        assert.equal(await waitLine(child, 'Fuseau horaire'), `Fuseau horaire                 : ${zone}`);
        await waitLine(child, 'Adresse des téléphones');
        assert.equal(completeLines(child).includes(WARNING), warned, `${zone} : avertissement`);
        assert.equal(completeLines(child).filter(line => line.startsWith('Attention : fuseau')).length, warned ? 1 : 0, zone);
      } finally { await child.stop(); }
    }
  });

  test('R4 écoute : boucle locale par défaut, KARAOKE_BIND et KARAOKE_PUBLIC_BIND respectées', async t => {
    const lan = lanIPv4();
    const check = async (bind, publicBind, env) => {
      const port = await choosePort();
      const child = launch(demoArgs(port), { env });
      try {
        assert.equal(await waitLine(child, 'Adresse des clients (QR)'),
          `Adresse des clients (QR)       : https://clients.exemple.fr  (port ${port + 1} sur ${publicBind})`);
        assert.equal(await waitLine(child, 'Adresse de la page du bar'),
          `Adresse de la page du bar      : https://bar.exemple.fr  (port ${port} sur ${bind})`);
        await waitLine(child, 'Adresse des téléphones');
        for (const p of [port, port + 1]) {
          assert.equal(await reachable('127.0.0.1', p), 'ok', `127.0.0.1:${p}`);
          if (lan) assert.equal(await reachable(lan, p), bind === '0.0.0.0' ? 'ok' : 'ECONNREFUSED', `${lan}:${p} (réseau)`);
        }
      } finally { await child.stop(); }
    };
    await check('127.0.0.1', '127.0.0.1', serverEnv());
    if (!lan) {
      t.skip('machine sans IPv4 hors boucle locale : partie réseau ignorée');
      return;
    }
    await check('0.0.0.0', '0.0.0.0', serverEnv({ KARAOKE_BIND: '0.0.0.0', KARAOKE_PUBLIC_BIND: '0.0.0.0' }));
  });

  test('R8 data/staff-key réelle : créée en 0600 au premier démarrage, gardée ensuite', async () => {
    const dir = sandboxCopy();
    assert.equal(fs.existsSync(path.join(dir, 'data')), false, 'copie sans data/');
    const env = serverEnv({ KARAOKE_STAFF_KEY_FILE: undefined });
    const keyPath = path.join(dir, 'data', 'staff-key');
    const start = async expectedSource => {
      const port = await choosePort();
      const child = launch(['--port', String(port), '--public-port', String(port + 1), '--no-open'], { env, cwd: dir });
      try {
        const line = await waitLine(child, 'Clé du bar');
        await waitLine(child, 'Adresse des téléphones');
        const content = fs.readFileSync(keyPath, 'utf8');
        assert.match(content, /^[A-Za-z0-9_-]{22}\n$/);
        if (process.platform !== 'win32') assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600, 'droits 0600');
        assert.equal(line, `Clé du bar                     : empreinte ${fingerprint(content.trim())} (${expectedSource})`);
        const base = `http://127.0.0.1:${port}`;
        const state = await fetch(`${base}/api/staff/state?key=${encodeURIComponent(await staffKey(base, { keyFile: keyPath }))}`);
        assert.equal(state.status, 200, 'clé de data/staff-key acceptée');
        assert.equal(child.stdoutText.includes(content.trim()), false, 'la clé n’apparaît pas sur stdout');
        return content;
      } finally { await child.stop(); }
    };
    const first = await start('data/staff-key, créée à ce démarrage');
    const second = await start('data/staff-key');
    assert.equal(second, first, 'même clé au redémarrage');
    assert.equal(fs.existsSync(path.join(dir, 'data', 'last-karafun-code.json')), false, 'aucun code KaraFun dans la copie');
  });
}
