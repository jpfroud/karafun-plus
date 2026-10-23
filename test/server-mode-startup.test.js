'use strict';
// Mode serveur, socle (issue #24), dans de vrais processus : refus de démarrer
// (R1, et R1b dans une copie), démarrage avec fichier de clé (R2), fuseau
// horaire (R3), adresses d'écoute (R4) et data/staff-key réelle dans une copie
// (R8). Jamais de KaraFun réel : faux KaraFun de la démo (R2 à R4), arrêt
// avant main() (R1, R1b), copie sans data/ ni code de télécommande (R1b, R8).
//
// Ports de ces tests : P, P+1 et P+1001 (faux KaraFun de la démo), P de 3230
// à 3238 (3240 sert à priority-undo-api.test.js).
// SP7 (#27, retour Spotify réel du serveur) : 3260, 3261 et 4261, réservés par
// l'épopée.
// TX5 (#28, port du bar occupé) : 3250, 3251 et 4251, réservés par l'épopée.
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

// Port du serveur lancé, comme server.js : --port, sinon PORT, sinon 3000.
function runtimeFile(child) {
  const i = child.spawnargs.indexOf('--port');
  const port = i >= 0 ? child.spawnargs[i + 1] : (child.launchEnv.PORT || '3000');
  return path.join(child.cwd, 'data', `runtime-${port}.json`);
}
// Fichier d'arrêt laissé par un serveur tué : supprimé s'il est le sien.
function removeRuntime(child) {
  const file = runtimeFile(child);
  try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === child.pid) fs.unlinkSync(file); }
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
  child.launchEnv = childEnv;
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
  const STRAY = 'KARAOKE_PUBLIC_URL est fixée sans le mode serveur : ajoute KARAOKE_MODE=server (ou --server), ou retire les variables KARAOKE_* pour le mode PC.';
  // Variables changées d'un cas, pour les messages d'échec (une variable retirée y figure).
  const variables = overrides => Object.entries(overrides)
    .map(([name, value]) => `${name}=${value === undefined ? '(retirée)' : value}`).join(' ');
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
      // KARAOKE_MODE oubliée (ou --server=1, qui n'est pas --server) avec les
      // autres variables : refus, jamais le mode PC en silence.
      [{ KARAOKE_MODE: undefined }, [], STRAY],
      [{ KARAOKE_MODE: undefined }, ['--server=1'], STRAY],
    ];
    for (const [overrides, extra, reason] of cases) {
      const label = `${variables(overrides)} ${extra.join(' ')}`;
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

  test('R1b refus dans une copie sans data/ : ni data/ ni journal/ créés', async () => {
    const port = await choosePort();
    const cases = [
      // Mode serveur sans fichier de clé fourni : refus avant tout contact avec data/staff-key.
      [{ KARAOKE_STAFF_KEY_FILE: undefined, KARAOKE_PUBLIC_URL: 'http://clients.exemple.fr' },
        'KARAOKE_PUBLIC_URL invalide : Une adresse accessible depuis Internet doit utiliser HTTPS.'],
      // Variables du mode serveur sans KARAOKE_MODE : refus avant journal/ et data/.
      [{ KARAOKE_STAFF_KEY_FILE: undefined, KARAOKE_MODE: undefined }, STRAY],
    ];
    for (const [overrides, reason] of cases) {
      const dir = sandboxCopy();
      const label = variables(overrides);
      const child = launch(['--port', String(port), '--public-port', String(port + 1), '--no-open'],
        { env: serverEnv(overrides), cwd: dir });
      try {
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        const { code } = await child.exited;
        clearTimeout(timer);
        assert.equal(code, 1, `${label} : code de sortie\n${outputs(child)}`);
        assert.equal(child.stderrText, `Impossible de démarrer : ${reason}\n`, label);
        assert.equal(fs.existsSync(path.join(dir, 'data')), false, `${label} : data/ jamais créé`);
        assert.equal(fs.existsSync(path.join(dir, 'journal')), false, `${label} : journal/ jamais créé`);
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
          // Chaque port suit sa variable : P (bar) KARAOKE_BIND, P+1 (clients) KARAOKE_PUBLIC_BIND.
          const listening = p === port ? bind : publicBind;
          if (lan) assert.equal(await reachable(lan, p), listening === '0.0.0.0' ? 'ok' : 'ECONNREFUSED', `${lan}:${p} (réseau)`);
        }
      } finally { await child.stop(); }
    };
    await check('127.0.0.1', '127.0.0.1', serverEnv());
    if (!lan) {
      t.skip('machine sans IPv4 hors boucle locale : partie réseau ignorée');
      return;
    }
    await check('0.0.0.0', '0.0.0.0', serverEnv({ KARAOKE_BIND: '0.0.0.0', KARAOKE_PUBLIC_BIND: '0.0.0.0' }));
    // Écoute asymétrique, dans les deux sens : une adresse échangée entre les deux ports se voit.
    await check('127.0.0.1', '0.0.0.0', serverEnv({ KARAOKE_PUBLIC_BIND: '0.0.0.0' }));
    await check('0.0.0.0', '127.0.0.1', serverEnv({ KARAOKE_BIND: '0.0.0.0' }));
  });

  // Bar, clients et faux KaraFun de la démo (PORT + 1001).
  const SPOTIFY_PORTS = [3260, 3261, 4261];
  test('SP7 retour Spotify réel du serveur : adresse de boucle locale, seul le state protège, page sans clé', async () => {
    for (const port of SPOTIFY_PORTS) {
      if (!await portFree(port)) assert.fail(`Port ${port} occupé : SP7 réserve 3260, 3261 et 4261.`);
    }
    const [port, publicPort] = SPOTIFY_PORTS;
    const env = serverEnv();
    const key = await staffKey(`http://127.0.0.1:${port}`, { keyFile: env.KARAOKE_STAFF_KEY_FILE });
    const child = launch(['--demo', '--port', String(port), '--no-open'], { env });
    try {
      await waitLine(child, 'Adresse des téléphones');
      const base = `http://127.0.0.1:${port}`;
      const spotify = body => fetch(`${base}/api/staff/spotify?key=${encodeURIComponent(key)}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal((await spotify({ action: 'client', clientId: '0123456789abcdef0123456789abcdef' })).status, 200);
      const auth = await spotify({ action: 'auth-url' });
      assert.equal(auth.status, 200);
      assert.equal(new URL((await auth.json()).url).searchParams.get('redirect_uri'), `http://127.0.0.1:${port}/spotify/callback`);

      const callback = await fetch(`${base}/spotify/callback?code=x&state=faux`);
      assert.equal(callback.status, 200, 'retour accepté sur le port du bar');
      const page = await callback.text();
      assert.match(page, /Connexion Spotify expirée : relance-la depuis la page du bar\./);
      assert.ok(page.includes('<a href="/staff">Revenir à la page du bar</a>'));
      assert.equal(page.includes(key), false, 'la clé du fichier n’est pas dans la page');
      const refused = await fetch(`http://127.0.0.1:${publicPort}/spotify/callback?code=x&state=faux`);
      assert.equal(refused.status, 403, 'port clients refusé');
      assert.equal(await refused.text(), 'Réservé au bar');

      const shell = await fetch(`${base}/staff`);
      assert.equal(shell.status, 200, 'page du bar sans clé');
      assert.equal(shell.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal((await shell.text()).includes(key), false);
      assert.equal((await fetch(`${base}/api/staff/state`)).status, 403, 'API sans clé fermée');
      assert.equal((await fetch(`${base}/staff?key=${encodeURIComponent(key)}`)).status, 200, 'lien du bar avec clé');
    } finally { await child.stop(); }
  });

  // Port du bar pris par un autre programme : bar, clients et faux KaraFun de
  // la démo (PORT + 1001), libres au départ.
  const TEXTES_PORTS = [3250, 3251, 4251];
  test('TX5 port du bar occupé en mode serveur (processus réel)', async () => {
    for (const port of TEXTES_PORTS) {
      if (!await portFree(port)) assert.fail(`Port ${port} occupé : le test du port pris réserve 3250, 3251 et 4251.`);
    }
    const [port] = TEXTES_PORTS;
    const holder = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => { holder.once('error', reject); holder.listen(port, '127.0.0.1', resolve); });
    try {
      const started = Date.now();
      const child = launch(['--demo', '--port', String(port), '--no-open'], { env: serverEnv() });
      let exit;
      try {
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        exit = await child.exited;
        clearTimeout(timer);
      } finally { await child.stop(); }
      assert.deepEqual(exit, { code: 1, signal: null }, outputs(child));
      // gstack-timing-ok: borne fixée par TX5 (issue #28), égale au chien de garde SIGKILL ci-dessus ; sortie observée en moins d'une seconde.
      assert.ok(Date.now() - started < 15000, 'sortie en moins de 15 s');
      const lines = completeLines(child);
      assert.ok(lines.includes('Le port 3250 est déjà utilisé : une autre instance de la file tourne peut-être déjà sur ce serveur.'),
        outputs(child));
      assert.equal(lines.some(line => line.includes('autre fenêtre')), false, 'aucun texte du mode PC');
      assert.equal(await reachable('127.0.0.1', port), 'ok', 'le programme du test garde son port');
    } finally { await new Promise(resolve => holder.close(resolve)); }
  });

  test('R8 data/staff-key réelle : créée en 0600 au premier démarrage, gardée ensuite', async () => {
    const dir = sandboxCopy();
    assert.equal(fs.existsSync(path.join(dir, 'data')), false, 'copie sans data/');
    const env = serverEnv({ KARAOKE_STAFF_KEY_FILE: undefined });
    const keyPath = path.join(dir, 'data', 'staff-key');
    const start = async (expectedSource, during) => {
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
        const key = await staffKey(base, { keyFile: keyPath });
        const state = await fetch(`${base}/api/staff/state?key=${encodeURIComponent(key)}`);
        assert.equal(state.status, 200, 'clé de data/staff-key acceptée');
        assert.equal(child.stdoutText.includes(content.trim()), false, 'la clé n’apparaît pas sur stdout');
        await during(base, key, child);
        return content;
      } finally { await child.stop(); }
    };
    // Une autre adresse envoyée par la page du bar est refusée depuis #25 ; la
    // soirée restaurée reprend KARAOKE_PUBLIC_URL (soirée d'une autre adresse : R10).
    const first = await start('data/staff-key, créée à ce démarrage', async (base, key) => {
      const sent = await fetch(`${base}/api/staff/settings?key=${encodeURIComponent(key)}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: 'https://autre.exemple.fr' }) });
      assert.equal(sent.status, 400);
    });
    const second = await start('data/staff-key', async (base, key, child) => {
      await waitLine(child, 'Soirée restaurée');
      const state = await (await fetch(`${base}/api/staff/state?key=${encodeURIComponent(key)}`)).json();
      assert.equal(state.settings.baseUrl, 'https://clients.exemple.fr', 'soirée restaurée : adresse de KARAOKE_PUBLIC_URL');
      assert.ok(state.tables.every(table => !table.url || table.url.startsWith('https://clients.exemple.fr/t/')));
    });
    assert.equal(second, first, 'même clé au redémarrage');
    assert.equal(fs.existsSync(path.join(dir, 'data', 'last-karafun-code.json')), false, 'aucun code KaraFun dans la copie');
  });

  // -------------------------------------------------------------- issue #25
  // Faux KaraFun de la démo (R5), commandes de clé (R6, R7, R9, R9b) et
  // avertissement sur l'ancienne adresse de data/tables.json (R10 à R10d). R5
  // à R7 depuis la racine (démo, ou sortie avant main()) ; R9 à R10d dans une
  // copie sans data/last-karafun-code.json ni --code.
  const pcEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('KARAOKE_')));
  const copyArgs = port => ['--port', String(port), '--public-port', String(port + 1), '--no-open'];
  // Fin d'une commande ponctuelle (tuée si elle ne sort pas d'elle-même).
  const finished = async child => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    const result = await child.exited;
    clearTimeout(timer);
    return result;
  };
  const rotatedLine = key => `Nouvelle clé du bar écrite dans data/staff-key (empreinte ${fingerprint(key)}). ` +
    'Redémarre la file pour l’appliquer, puis donne aux gérants le lien de --print-staff-url : l’ancien lien ne marche plus.\n';
  // R10 à R10d : copie dont data/tables.json garde https://ancien.exemple.fr.
  const OLD_WARNING = 'Attention : data/tables.json indiquait https://ancien.exemple.fr pour les QR. ' +
    'Les QR déjà imprimés avec cette adresse ne mènent pas à ce serveur. QR désormais créés pour https://clients.exemple.fr.';
  const oldTablesCopy = () => {
    const dir = sandboxCopy();
    const tablesPath = path.join(dir, 'data', 'tables.json');
    fs.mkdirSync(path.dirname(tablesPath));
    fs.writeFileSync(tablesPath, JSON.stringify({ version: 1, baseUrl: 'https://ancien.exemple.fr',
      tables: [{ id: '1', name: null, headcount: null, individual: false, secret: crypto.randomBytes(16).toString('base64url') }] }));
    return { dir, tablesBaseUrl: () => JSON.parse(fs.readFileSync(tablesPath, 'utf8')).baseUrl };
  };
  const baseUrlWarnings = child => completeLines(child).filter(line => line.startsWith('Attention : data/tables.json'));
  // Lignes d'avertissement dans les journal/serveur-<date>.log de la copie.
  const loggedWarnings = dir => fs.readdirSync(path.join(dir, 'journal')).filter(name => /^serveur-.*\.log$/.test(name))
    .map(name => fs.readFileSync(path.join(dir, 'journal', name), 'utf8')).join('').split(` ${OLD_WARNING}\n`).length - 1;
  // data/runtime-<P>.json écrit par ce serveur, après ses lignes de démarrage.
  const waitRuntime = async child => {
    const file = runtimeFile(child);
    let runtime = null;
    for (let i = 0; i < 300 && runtime?.pid !== child.pid; i++) {
      try { runtime = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { runtime = null; }
      if (runtime?.pid !== child.pid) await sleep(50);
    }
    assert.equal(runtime?.pid, child.pid, `data/${path.basename(file)} écrit\n${outputs(child)}`);
  };

  test('R5 faux KaraFun de la démo : boucle locale seulement, la démo se connecte (mode PC)', async t => {
    const port = await choosePort();
    const child = launch(demoArgs(port), { env: pcEnv() });
    try {
      assert.equal(await waitLine(child, 'Mode démo'), `Mode démo : faux KaraFun sur http://127.0.0.1:${port + 1001} (chansons de 4 s)`);
      const base = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        try {
          const state = await (await fetch(`${base}/api/staff/state?key=${encodeURIComponent(await staffKey(base))}`)).json();
          ready = state.kf?.ready === true;
        } catch (_) { /* serveur pas encore prêt */ }
        if (!ready) await sleep(100);
      }
      assert.equal(ready, true, `démo prête (kf.ready)\n${outputs(child)}`);
      assert.equal(await reachable('127.0.0.1', port + 1001), 'ok', `127.0.0.1:${port + 1001}`);
      const lan = lanIPv4();
      if (!lan) {
        t.skip('machine sans IPv4 hors boucle locale : partie réseau ignorée');
        return;
      }
      assert.equal(await reachable(lan, port + 1001), 'ECONNREFUSED', `${lan}:${port + 1001} (réseau)`);
    } finally { await child.stop(); }
  });

  test('R6 --print-staff-url réel : le lien du bar seul sur stdout, ni journal ni port', async () => {
    const port = await choosePort();
    const env = serverEnv();
    const expected = `https://bar.exemple.fr/staff?key=${fs.readFileSync(env.KARAOKE_STAFF_KEY_FILE, 'utf8').trim()}\n`;
    for (const args of [['--port', String(port), '--print-staff-url'], ['--print-staff-url', '--port', String(port)]]) {
      const label = args.join(' ');
      const before = footprint(root);
      const child = launch(args, { env });
      try {
        const { code } = await finished(child);
        assert.equal(code, 0, `${label} : code de sortie\n${outputs(child)}`);
        // Comparaison sans afficher la clé en cas d'échec.
        assert.ok(child.stdoutText === expected, `${label} : stdout exact\n${outputs(child)}`);
        assert.equal(child.stderrText, '', label);
        assert.deepEqual(footprint(root), before, `${label} : journal/ et data/ inchangés`);
        assert.equal(await reachable('127.0.0.1', port), 'ECONNREFUSED', `${label} : port ${port} fermé`);
        assert.equal(await reachable('127.0.0.1', port + 1), 'ECONNREFUSED', `${label} : port ${port + 1} fermé`);
      } finally { await child.stop(); }
    }
  });

  test('R7 --rotate-staff-key refusé avec KARAOKE_STAFF_KEY_FILE : fichier de clé intact', async () => {
    const env = serverEnv();
    const keyBytes = fs.readFileSync(env.KARAOKE_STAFF_KEY_FILE);
    const before = footprint(root);
    const child = launch(['--rotate-staff-key'], { env });
    try {
      const { code } = await finished(child);
      assert.equal(code, 1, outputs(child));
      assert.equal(child.stderrText,
        'Commande impossible : la clé du bar vient de KARAOKE_STAFF_KEY_FILE ; change ce fichier, puis redémarre la file.\n');
      assert.equal(child.stdoutText, '');
      assert.ok(fs.readFileSync(env.KARAOKE_STAFF_KEY_FILE).equals(keyBytes), 'clé du fichier identique octet pour octet');
      assert.deepEqual(footprint(root), before, 'journal/ et data/ inchangés');
    } finally { await child.stop(); }
  });

  test('R9 --rotate-staff-key réel : data/ créé, clé en 0600, seule la dernière clé ouvre la page du bar', async () => {
    const dir = sandboxCopy();
    assert.equal(fs.existsSync(path.join(dir, 'data')), false, 'copie sans data/');
    const env = serverEnv({ KARAOKE_STAFF_KEY_FILE: undefined });
    const keyPath = path.join(dir, 'data', 'staff-key');
    const rotate = async () => {
      const child = launch(['--server', '--rotate-staff-key'], { env, cwd: dir });
      try {
        const { code } = await finished(child);
        assert.equal(code, 0, outputs(child));
        const content = fs.readFileSync(keyPath, 'utf8');
        assert.match(content, /^[A-Za-z0-9_-]{22}\n$/);
        assert.equal(child.stdoutText, rotatedLine(content.trim()), 'empreinte du contenu écrit');
        assert.equal(child.stderrText, '');
        if (process.platform !== 'win32') assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600, 'droits 0600');
        assert.deepEqual(fs.readdirSync(path.join(dir, 'data')), ['staff-key'], 'aucun fichier temporaire laissé');
        assert.equal(fs.existsSync(path.join(dir, 'journal')), false, 'sortie avant journal/ : rien au journal');
        return content.trim();
      } finally { await child.stop(); }
    };
    const first = await rotate();
    const second = await rotate();
    assert.notEqual(second, first, 'seconde rotation : autre clé');
    const port = await choosePort();
    const child = launch(copyArgs(port), { env, cwd: dir });
    try {
      assert.equal(await waitLine(child, 'Clé du bar'), `Clé du bar                     : empreinte ${fingerprint(second)} (data/staff-key)`);
      await waitLine(child, 'Adresse des téléphones');
      const base = `http://127.0.0.1:${port}`;
      assert.equal((await fetch(`${base}/api/staff/state?key=${encodeURIComponent(first)}`)).status, 403, 'avant-dernière clé refusée');
      assert.equal((await fetch(`${base}/api/staff/state?key=${encodeURIComponent(second)}`)).status, 200, 'dernière clé acceptée');
    } finally { await child.stop(); }
    assert.equal(fs.existsSync(path.join(dir, 'data', 'last-karafun-code.json')), false, 'aucun code KaraFun dans la copie');
  });

  // La commande passe avant le contrôle de démarrage (serverSetup) : une
  // data/staff-key abîmée se répare par --rotate-staff-key, comme le dit le refus.
  test('R9b data/staff-key abîmée : « Commande impossible », puis réparée par --rotate-staff-key', async () => {
    const dir = sandboxCopy();
    const keyPath = path.join(dir, 'data', 'staff-key');
    fs.mkdirSync(path.dirname(keyPath));
    fs.writeFileSync(keyPath, 'abc\n');
    const env = serverEnv({ KARAOKE_STAFF_KEY_FILE: undefined });
    const run = async args => {
      const child = launch(args, { env, cwd: dir });
      try {
        const { code } = await finished(child);
        return { code, stdout: child.stdoutText, stderr: child.stderrText, outputs: outputs(child) };
      } finally { await child.stop(); }
    };
    // Formes de docker compose exec : KARAOKE_MODE=server, sans --server.
    const refused = await run(['--print-staff-url']);
    assert.equal(refused.code, 1, refused.outputs);
    assert.equal(refused.stderr, 'Commande impossible : data/staff-key ne contient pas une clé valable (au moins 22 caractères ' +
      'parmi A-Z, a-z, 0-9, - et _) : remplace-la avec node server.js --rotate-staff-key.\n');
    assert.equal(refused.stdout, '');
    assert.equal(fs.readFileSync(keyPath, 'utf8'), 'abc\n', 'clé abîmée laissée telle quelle');
    const rotated = await run(['--rotate-staff-key']);
    assert.equal(rotated.code, 0, rotated.outputs);
    const content = fs.readFileSync(keyPath, 'utf8');
    assert.match(content, /^[A-Za-z0-9_-]{22}\n$/);
    assert.equal(rotated.stdout, rotatedLine(content.trim()), 'empreinte de la nouvelle clé');
    assert.equal(rotated.stderr, '');
    if (process.platform !== 'win32') assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600, 'droits 0600');
    const printed = await run(['--print-staff-url']);
    assert.equal(printed.code, 0, printed.outputs);
    assert.ok(printed.stdout === `https://bar.exemple.fr/staff?key=${content.trim()}\n`, `lien de la nouvelle clé\n${printed.outputs}`);
    assert.equal(printed.stderr, '');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'data')), ['staff-key'], 'aucun fichier temporaire laissé');
    assert.equal(fs.existsSync(path.join(dir, 'journal')), false, 'sortie avant journal/ : rien au journal');
  });

  test('R10 ancienne adresse de data/tables.json : avertissement une fois, soirée restaurée sur KARAOKE_PUBLIC_URL', async () => {
    const { dir, tablesBaseUrl } = oldTablesCopy();
    // 1. Mode PC, sans --demo : la soirée est sauvegardée avec l'ancienne adresse.
    let child = launch(copyArgs(await choosePort()), { env: pcEnv(), cwd: dir });
    try { await waitLine(child, 'Laisse cette fenêtre ouverte'); } finally { await child.stop(); }
    assert.equal(tablesBaseUrl(), 'https://ancien.exemple.fr', 'mode PC : adresse gardée');
    // 2. Mode serveur : soirée restaurée, avertissement exact, QR sur KARAOKE_PUBLIC_URL.
    const env = serverEnv();
    const port = await choosePort();
    child = launch(copyArgs(port), { env, cwd: dir });
    try {
      await waitLine(child, 'Soirée restaurée');
      assert.equal(await waitLine(child, 'Attention : data/tables.json'), OLD_WARNING);
      const base = `http://127.0.0.1:${port}`;
      const response = await fetch(`${base}/api/staff/state?key=${encodeURIComponent(await staffKey(base, { keyFile: env.KARAOKE_STAFF_KEY_FILE }))}`);
      assert.equal(response.status, 200);
      const state = await response.json();
      assert.equal(state.phoneBase, 'https://clients.exemple.fr');
      assert.ok(state.tables.some(table => table.id === '1'), 'table 1 restaurée');
      for (const table of state.tables) assert.ok(String(table.url).startsWith('https://clients.exemple.fr/t/'), `${table.id} : ${table.url}`);
      assert.equal(tablesBaseUrl(), 'https://clients.exemple.fr', 'data/tables.json réécrit');
    } finally { await child.stop(); }
    assert.equal(baseUrlWarnings(child).length, 1, 'une seule ligne d’avertissement');
    assert.equal(loggedWarnings(dir), 1, 'avertissement gardé dans journal/serveur-<date>.log');
    // 3. Démarrage suivant : plus d'écart, plus d'avertissement.
    child = launch(copyArgs(await choosePort()), { env, cwd: dir });
    try {
      await waitRuntime(child);
      assert.deepEqual(baseUrlWarnings(child), [], 'aucun avertissement une fois data/runtime-<P>.json écrit');
    } finally { await child.stop(); }
    assert.deepEqual(baseUrlWarnings(child), [], 'aucun avertissement dans toute la sortie');
    assert.ok(completeLines(child).some(line => line.startsWith('Soirée restaurée')), 'démarrage complet');
    assert.equal(fs.existsSync(path.join(dir, 'data', 'last-karafun-code.json')), false, 'aucun code KaraFun dans la copie');
  });

  // Démarrage qui échoue après la réécriture de data/tables.json (port du bar
  // ou port clients déjà pris) : l'ancienne adresse reste à l'écran et au
  // journal, une seule fois, et le démarrage suivant ne voit plus d'écart.
  const failedFirstStart = async ({ busy, lastLine }) => {
    const { dir, tablesBaseUrl } = oldTablesCopy();
    const env = serverEnv();
    const port = await choosePort();
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(busy(port), '127.0.0.1', resolve));
    let child = launch(copyArgs(port), { env, cwd: dir });
    try {
      const { code } = await finished(child);
      assert.equal(code, 1, outputs(child));
    } finally {
      await child.stop();
      await new Promise(resolve => blocker.close(resolve));
    }
    assert.equal(tablesBaseUrl(), 'https://clients.exemple.fr', 'échec après la réécriture');
    assert.deepEqual(baseUrlWarnings(child), [OLD_WARNING], `avertissement à l’écran\n${outputs(child)}`);
    assert.match(completeLines(child).at(-1), lastLine(port), 'raison de l’échec en dernière ligne');
    assert.equal(loggedWarnings(dir), 1, 'avertissement gardé dans journal/serveur-<date>.log');
    // Démarrage suivant : plus d'écart, plus d'avertissement ; le journal garde l'ancienne adresse.
    child = launch(copyArgs(await choosePort()), { env, cwd: dir });
    try {
      await waitLine(child, 'Adresse des téléphones');
      await waitRuntime(child);
    } finally { await child.stop(); }
    assert.deepEqual(baseUrlWarnings(child), [], 'aucun avertissement au démarrage suivant');
    assert.equal(loggedWarnings(dir), 1, 'une seule ligne au journal');
    assert.equal(fs.existsSync(path.join(dir, 'data', 'last-karafun-code.json')), false, 'aucun code KaraFun dans la copie');
  };

  test('R10b ancienne adresse gardée au journal quand le port du bar est pris au premier démarrage du mode serveur', () =>
    failedFirstStart({ busy: port => port,
      lastLine: port => new RegExp(`^Le port ${port} est déjà utilisé : une autre instance de la file tourne peut-être déjà sur ce serveur\\.$`) }));

  test('R10c ancienne adresse gardée au journal quand le port clients est pris au premier démarrage du mode serveur', () =>
    failedFirstStart({ busy: port => port + 1, lastLine: port => new RegExp(`^Port public ${port + 1} indisponible : `) }));

  // Démarrage refusé par main() avant la réécriture (sauvegarde de soirée
  // illisible) : l'avertissement passe avant la raison, et data/tables.json
  // garde l'ancienne adresse, donc le démarrage suivant la signale encore.
  test('R10d démarrage refusé avant la réécriture de data/tables.json : avertissement écrit, puis repris au démarrage suivant', async () => {
    const { dir, tablesBaseUrl } = oldTablesCopy();
    const night = path.join(dir, 'data', 'soiree-a.json');
    fs.mkdirSync(night); // un dossier à la place de la sauvegarde : nightStore.load() lève
    const env = serverEnv();
    let child = launch(copyArgs(await choosePort()), { env, cwd: dir });
    try {
      const { code } = await finished(child);
      assert.equal(code, 1, outputs(child));
    } finally { await child.stop(); }
    assert.deepEqual(baseUrlWarnings(child), [OLD_WARNING], `avertissement à l’écran\n${outputs(child)}`);
    assert.equal(completeLines(child).at(-1), 'Impossible de démarrer : Sauvegarde de soirée invalide : les deux générations sont illisibles',
      'raison de l’échec en dernière ligne');
    assert.equal(loggedWarnings(dir), 1, 'avertissement gardé dans journal/serveur-<date>.log');
    assert.equal(tablesBaseUrl(), 'https://ancien.exemple.fr', 'data/tables.json laissé tel quel');
    // Sauvegarde retirée : démarrage complet, l'écart est encore vu une fois.
    fs.rmdirSync(night);
    child = launch(copyArgs(await choosePort()), { env, cwd: dir });
    try { await waitRuntime(child); } finally { await child.stop(); }
    assert.deepEqual(baseUrlWarnings(child), [OLD_WARNING], 'avertissement repris au démarrage suivant');
    assert.equal(loggedWarnings(dir), 2, 'une ligne de plus au journal');
    assert.equal(tablesBaseUrl(), 'https://clients.exemple.fr', 'data/tables.json réécrit');
    assert.equal(fs.existsSync(path.join(dir, 'data', 'last-karafun-code.json')), false, 'aucun code KaraFun dans la copie');
  });
}
