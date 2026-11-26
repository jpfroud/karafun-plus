'use strict';
// Démarrage et réparation des soirées en vrai processus (plan du 8 novembre,
// A3, A4 et A7, « Vrai processus ») : copies du dépôt (sandboxCopy et launch
// de server-mode-startup.test.js), au pont dirigé vers le faux KaraFun que
// l'essai lance (fake-karafun.js, en KCS, son code passé par --code), par une
// retouche de la copie seulement : jamais le vrai KaraFun. La démo ne
// convient pas : elle n'a ni sauvegarde de soirée ni dossier de journal.
//
// Premier commit du jalon 1 : ordre du démarrage et fichier d'arrêt
// (starting), les deux rappels en échec, ARRETER.bat pendant la réparation,
// deux lancements de la même copie, KARAOKE_REPAIR=off, archives abîmées. Le
// second commit y ajoute la fin de soirée (remise à zéro et découpage du
// démarrage, bandeau, soirées antidatées, scénarios du qa).
//
// Ports : P de 3290 à 3298, avec P+1 (clients) et P+1001 (faux KaraFun),
// qu'aucun essai de la suite n'emploie ; P est pris par une boucle sur les
// ports libres (choosePort de server-mode-startup.test.js ne cherche qu'entre
// 3230 et 3238).
//
// Les aides exportées (ports, copie retouchée, environnement, journal du
// serveur, soirées posées dans data/) servent aux scénarios du qa du second
// commit : les essais ne tournent que si le fichier est lancé directement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { portFree, serverEnv, sandboxCopy, launch, waitLine, apresHuitHeures } = require('./server-mode-startup.test');
const { recopierFixture, DAY, MIN } = require('./journaux-tires');
const { NightStateStore } = require('../night-state');
const { parseLines } = require('../evening-journal');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const KARAFUN_CODE = '271828';
const RETOUCHE = 'bases: DEMO ? [fake.base] : undefined';

// Premier P de 3290 à 3298 dont P, P+1 et P+1001 sont libres.
async function portsEssai() {
  for (let port = 3290; port <= 3298; port++) {
    if (await portFree(port) && await portFree(port + 1) && await portFree(port + 1001)) return port;
  }
  throw new Error('Aucun groupe de ports libre entre 3290 et 3298 (P, P+1 et P+1001).');
}

// Copie du dépôt dont le pont vise le faux KaraFun du port `fakePort`. La
// retouche doit prendre une fois et une seule, et le texte d'origine
// disparaître ; sinon l'essai s'arrête avant de lancer la copie.
function copieEssai(fakePort) {
  const dir = sandboxCopy();
  const file = path.join(dir, 'server.js');
  const text = fs.readFileSync(file, 'utf8');
  const found = text.split(RETOUCHE).length - 1;
  if (found !== 1) throw new Error(`Retouche du pont impossible : « ${RETOUCHE} » trouvé ${found} fois dans server.js.`);
  const retouched = text.split(RETOUCHE).join(`bases: [${JSON.stringify(`http://127.0.0.1:${fakePort}`)}]`);
  if (retouched.includes(RETOUCHE)) throw new Error('Retouche du pont : le texte d’origine reste dans server.js.');
  fs.writeFileSync(file, retouched);
  return dir;
}

// Environnement d'une copie : en mode PC, celui de l'essai sans KARAOKE_*
// (première ligne de serverEnv, sans les variables du mode serveur qu'il
// ajoute ensuite) ; en mode serveur, serverEnv() ; puis la variable que
// l'essai pose lui-même (`extra`, KARAOKE_REPAIR…).
const sansKaraoke = env => Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('KARAOKE_')));
const envEssai = (mode, extra = {}) => ({ ...(mode === 'server' ? serverEnv() : sansKaraoke(process.env)), ...extra });
const argsEssai = (port, { code = false } = {}) => ['--port', String(port), '--public-port', String(port + 1), '--no-open',
  ...(code ? ['--code', KARAFUN_CODE] : [])];
const MODES = [['pc', 'mode PC'], ['server', 'mode serveur']];

const runtimePath = (dir, port) => path.join(dir, 'data', `runtime-${port}.json`);
function lireRuntime(dir, port) {
  try { return JSON.parse(fs.readFileSync(runtimePath(dir, port), 'utf8')); } catch (_) { return null; }
}
const fini = child => child.exitCode !== null || child.signalCode !== null;
const sorties = child => `stdout :\n${child.stdoutText}\nstderr :\n${child.stderrText}`.replace(/key=[A-Za-z0-9_%-]+/g, 'key=…');
const derniereLigne = child => child.stdoutText.split(/\r?\n/).filter(Boolean).at(-1);
// Fin du démarrage d'une copie : la seconde écriture de son fichier d'arrêt,
// à son pid, sans starting (A3).
async function demarree(child, dir, port, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const runtime = lireRuntime(dir, port);
    if (runtime?.pid === child.pid && runtime.starting === undefined) return runtime;
    if (fini(child) || Date.now() > deadline) {
      throw new Error(`Démarrage de la copie non fini (${fini(child) ? `sortie ${child.exitCode ?? child.signalCode}` : `${ms} ms`}).\n${sorties(child)}`);
    }
    await sleep(20);
  }
}
// Sortie d'une copie qui doit s'arrêter seule (tuée au-delà de 30 s).
async function sortie(child) {
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const exit = await child.exited;
  clearTimeout(timer);
  return exit;
}

// Clé du bar : en mode PC, la redirection de GET / (une nouvelle clé à
// chaque lancement) ; en mode serveur, le fichier de clé.
async function cleBar(base, env) {
  if (env.KARAOKE_MODE === 'server') return fs.readFileSync(env.KARAOKE_STAFF_KEY_FILE, 'utf8').trim();
  const response = await fetch(`${base}/`, { redirect: 'manual' });
  const key = response.status === 302 && new URL(response.headers.get('location'), base).searchParams.get('key');
  if (!key) throw new Error(`Clé du bar introuvable : GET / répond ${response.status}.`);
  return key;
}
const etat = async (base, key) => (await fetch(`${base}/api/staff/state?key=${encodeURIComponent(key)}`)).json();
// Preuve de connexion d'une copie lancée avec --code, avant sa première
// assertion : kf.base est l'adresse du faux KaraFun, karafun.connected est
// vrai et le pont parle KCS ; sinon l'essai s'arrête.
async function relieeAuFaux(base, key, fake) {
  let state = null;
  for (let i = 0; i < 100 && !(state?.karafun?.connected && state.kf?.protocol === 'kcs'); i++) {
    if (i) await sleep(100);
    state = await etat(base, key);
  }
  if (state?.kf?.base !== fake.base || state.karafun?.connected !== true || state.kf?.protocol !== 'kcs') {
    throw new Error(`Copie non reliée au faux KaraFun : kf.base ${state?.kf?.base}, connected ${state?.karafun?.connected}, protocole ${state?.kf?.protocol}.`);
  }
  return state;
}

// Lignes du journal du serveur de la copie (journal/serveur-*.log), sans leur
// heure, dans l'ordre.
function journalServeur(dir) {
  const folder = path.join(dir, 'journal');
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(name => /^serveur-.*\.log$/.test(name)).sort()
    .flatMap(name => fs.readFileSync(path.join(folder, name), 'utf8').split('\n').filter(Boolean))
    .map(line => line.slice(line.indexOf(' ') + 1));
}
// Fichiers de data/ de la copie (sauf le fichier d'arrêt), chemin → contenu.
function empreinteData(dir, port) {
  const data = path.join(dir, 'data');
  const out = {};
  for (const rel of fs.existsSync(data) ? fs.readdirSync(data, { recursive: true }) : []) {
    const file = path.join(data, rel);
    if (rel === `runtime-${port}.json` || !fs.statSync(file).isFile()) continue;
    out[rel.split(path.sep).join('/')] = fs.readFileSync(file, 'utf8');
  }
  return out;
}

// Soirée du 15 octobre recopiée `nuits` fois à +24 h (journaux-tires.js),
// avancée de `decalage` ms (négatif : dans le passé), ouverte, ou close par
// le bar 5 min après sa dernière ligne : { meta, events }.
function nuitsMelees(id, { nuits = 2, close = false, decalage = 0 } = {}) {
  const { events, meta } = recopierFixture({ fois: nuits, eveningId: id });
  for (const e of events) {
    e.t += decalage;
    for (const field of ['sentAt', 'closesAt', 'closingAt']) if (Number.isFinite(e[field])) e[field] += decalage;
  }
  meta.startedAt += decalage;
  if (close) {
    const t = events.at(-1).t + 5 * MIN;
    events.push({ by: 'staff-reset', v: 1, seq: events.length + 1, t, ev: 'evening.closed', boot: `nuit-${nuits}` });
    meta.endedAt = t;
  }
  return { meta, events };
}
// Soirée posée dans data/soirees/<id>/ de la copie (meta.json, journal.jsonl).
function poserSoiree(dir, id, { meta, events }) {
  const folder = path.join(dir, 'data', 'soirees', id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(folder, 'journal.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n');
}
const contenusSoiree = (dir, id) => Object.fromEntries(fs.readdirSync(path.join(dir, 'data', 'soirees', id))
  .map(name => [name, fs.readFileSync(path.join(dir, 'data', 'soirees', id, name), 'utf8')]));
const lignesSoiree = (dir, id) => parseLines(fs.readFileSync(path.join(dir, 'data', 'soirees', id, 'journal.jsonl'), 'utf8')).events;
const indexSoirees = dir => JSON.parse(fs.readFileSync(path.join(dir, 'data', 'soirees', '.bornage.json'), 'utf8')).checked;
// Soirée que désigne la sauvegarde de la copie.
const soireeSauvegardee = dir => new NightStateStore(path.join(dir, 'data', 'soiree')).load()?.evening?.id;

// Premier lancement d'une copie neuve : une soirée ouverte et sauvegardée,
// puis l'arrêt. Rend l'identifiant de la soirée.
async function premiereSoiree(dir, port, env) {
  await apresHuitHeures();
  const child = launch(argsEssai(port), { env, cwd: dir });
  try { await demarree(child, dir, port); } finally { await child.stop(); }
  const id = soireeSauvegardee(dir);
  assert.ok(id, 'soirée sauvegardée au premier lancement');
  return id;
}

module.exports = { portsEssai, copieEssai, envEssai, argsEssai, KARAFUN_CODE, lireRuntime, demarree, cleBar, relieeAuFaux, journalServeur,
  nuitsMelees, poserSoiree, soireeSauvegardee };

// ---------------------------------------------------------------- essais
if (require.main === module) {
  const { test } = require('node:test');
  const { startFakeKaraFun } = require('../fake-karafun');
  const ACTIVE = 'Réparation des soirées : active.';
  const ARCHIVE = '2026-08-10_2000_e0e0';
  // Deux nuits closes, deux mois plus tôt : la passe des soirées closes les sépare.
  const archiveMelee = dir => poserSoiree(dir, ARCHIVE, nuitsMelees(ARCHIVE, { close: true, decalage: -60 * DAY }));
  const fauxKaraFun = port => startFakeKaraFun({ port: port + 1001, code: KARAFUN_CODE, songSeconds: 600, autoplay: false });
  // Dernière ligne d'une copie qui trouve le port du bar occupé, dans chaque
  // mode (portInUseMessage de server.js).
  const portOccupe = (mode, port) => `Le port ${port} est déjà utilisé : ${mode === 'server'
    ? 'une autre instance de la file tourne peut-être déjà sur ce serveur.' : 'le programme tourne peut-être déjà dans une autre fenêtre.'}`;

  test('A7 : environnement des copies : en mode PC, aucune variable KARAOKE_* (même posée dans celui de l’essai), sauf celle que l’essai ajoute ; en mode serveur, celui de serverEnv()', () => {
    const had = Object.hasOwn(process.env, 'KARAOKE_REPAIR');
    const saved = process.env.KARAOKE_REPAIR;
    process.env.KARAOKE_REPAIR = 'off';
    try {
      assert.deepEqual(Object.keys(envEssai('pc')).filter(name => name.toUpperCase().startsWith('KARAOKE_')), []);
      assert.deepEqual(Object.keys(envEssai('pc', { KARAOKE_REPAIR: 'OFF' })).filter(name => name.startsWith('KARAOKE_')), ['KARAOKE_REPAIR']);
      const server = envEssai('server');
      assert.equal(server.KARAOKE_MODE, 'server');
      assert.equal(server.KARAOKE_REPAIR, undefined);
    } finally {
      if (had) process.env.KARAOKE_REPAIR = saved; else delete process.env.KARAOKE_REPAIR;
    }
  });

  for (const [mode, label] of MODES) {
    test(`A3 : ordre du démarrage au journal du serveur (${label}) : « ${ACTIVE} », « Soirée restaurée », « === File karaoké … === », « Connexion à KaraFun (code … », puis la fin de la passe des soirées closes ; fichier d’arrêt au pid de la copie, sans starting`, async () => {
      const port = await portsEssai();
      const fake = await fauxKaraFun(port);
      const dir = copieEssai(port + 1001);
      const env = envEssai(mode);
      const base = `http://127.0.0.1:${port}`;
      try {
        await apresHuitHeures();
        let child = launch(argsEssai(port, { code: true }), { env, cwd: dir });
        try {
          await demarree(child, dir, port);
          await relieeAuFaux(base, await cleBar(base, env), fake);
        } finally { await child.stop(); }
        archiveMelee(dir);
        const before = journalServeur(dir).length;
        child = launch(argsEssai(port, { code: true }), { env, cwd: dir });
        try {
          await waitLine(child, 'Réparation des soirées closes terminée', 30000);
          const runtime = await demarree(child, dir, port);
          await relieeAuFaux(base, await cleBar(base, env), fake);
          const lines = journalServeur(dir).slice(before);
          const at = prefix => {
            const i = lines.findIndex(line => line.startsWith(prefix));
            assert.ok(i >= 0, `« ${prefix} » absente du journal du serveur :\n${lines.join('\n')}`);
            return i;
          };
          const order = [ACTIVE, 'Soirée restaurée : ', '=== File karaoké ', 'Connexion à KaraFun (code ', 'Réparation des soirées closes terminée : '].map(at);
          assert.deepEqual([...order].sort((a, b) => a - b), order, `ordre du démarrage :\n${lines.join('\n')}`);
          assert.match(lines[order[4]], /^Réparation des soirées closes terminée : 1 vérifiées, 1 découpées, 0 en échec, 0 à refaire ; en \d+ ms\.$/);
          assert.equal(lines.filter(line => line === ACTIVE).length, 1);
          assert.deepEqual(Object.keys(runtime).sort(), ['pid', 'port', 'secret'], 'fichier d’arrêt sans starting');
          assert.equal(runtime.port, port);
          assert.equal(indexSoirees(dir)[ARCHIVE], 'split');
        } finally { await child.stop(); }
      } finally { fake.close(); }
    });

    test(`A3 : data/runtime-<port>.json remplacé par un dossier (${label}) : premier rappel en échec, code 1, « Impossible de démarrer : … » en dernière ligne, port du bar rendu, aucune ligne au journal de la soirée ni sauvegarde écrite`, async () => {
      const port = await portsEssai();
      const dir = copieEssai(port + 1001);
      const env = envEssai(mode);
      await premiereSoiree(dir, port, env);
      const before = empreinteData(dir, port);
      const lines = journalServeur(dir).length;
      fs.mkdirSync(runtimePath(dir, port));
      const child = launch(argsEssai(port), { env, cwd: dir });
      try {
        assert.deepEqual(await sortie(child), { code: 1, signal: null }, sorties(child));
        assert.match(derniereLigne(child), /^Impossible de démarrer : /, sorties(child));
        assert.equal(await portFree(port), true, 'port du bar rendu');
        assert.equal(await portFree(port + 1), true, 'port des clients jamais pris');
        assert.deepEqual(empreinteData(dir, port), before, 'ni ligne au journal de la soirée ni sauvegarde');
        assert.ok(!journalServeur(dir).slice(lines).some(line => line.startsWith('Réparation des soirées')), 'arrêt avant startNight()');
      } finally { await child.stop(); }
      fs.rmdirSync(runtimePath(dir, port));
    });

    test(`A3 : seconde écriture de data/runtime-<port>.json (sans starting) qui lève EACCES (${label}) : second rappel en échec, code 1, « Impossible de démarrer : … » en dernière ligne après « === File karaoké … === », aucune « Connexion à KaraFun (code … », plus de fichier d’arrêt, les deux ports rendus`, async () => {
      const port = await portsEssai();
      const fake = await fauxKaraFun(port);
      const dir = copieEssai(port + 1001);
      // Module préchargé (comme stopPreload de cli-persistence.test.js) : la
      // seconde écriture du fichier d'arrêt de ce port lève EACCES.
      fs.writeFileSync(path.join(dir, 'runtime-eacces.js'), `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const name = 'runtime-' + process.env.RUNTIME_EACCES_PORT + '.json';
const writeFileSync = fs.writeFileSync;
let writes = 0;
fs.writeFileSync = function (file, ...rest) {
  if (typeof file === 'string' && path.basename(file) === name && ++writes === 2) {
    throw Object.assign(new Error("EACCES: permission denied, open '" + file + "'"), { code: 'EACCES', syscall: 'open', path: file });
  }
  return writeFileSync.call(this, file, ...rest);
};
`);
      const base = envEssai(mode);
      const env = { ...base, RUNTIME_EACCES_PORT: String(port), NODE_OPTIONS: `${base.NODE_OPTIONS || ''} --require ./runtime-eacces.js`.trim() };
      try {
        await apresHuitHeures();
        const child = launch(argsEssai(port, { code: true }), { env, cwd: dir });
        try {
          assert.deepEqual(await sortie(child), { code: 1, signal: null }, sorties(child));
          const out = child.stdoutText.split(/\r?\n/).filter(Boolean);
          assert.match(out.at(-1), /^Impossible de démarrer : EACCES: permission denied/, sorties(child));
          assert.ok(out.findIndex(line => line.startsWith('=== File karaoké ')) >= 0, `« === File karaoké … === » écrite\n${sorties(child)}`);
          assert.ok(!out.some(line => line.startsWith('Connexion à KaraFun (code ')), 'KaraFun jamais contacté');
          assert.equal(fs.existsSync(runtimePath(dir, port)), false, 'fichier d’arrêt effacé');
          assert.equal(await portFree(port), true, 'port du bar rendu');
          assert.equal(await portFree(port + 1), true, 'port des clients rendu');
        } finally { await child.stop(); }
      } finally { fake.close(); }
    });

    test(`A3 : deux lancements de la même copie à 100 ms d’écart, sur une soirée que la réparation coupe (${label}) : un seul démarre la soirée, l’autre s’arrête sur le port occupé (code 1), une seule ligne « Réparation des soirées : active. », un seul app.started`, async () => {
      const port = await portsEssai();
      const dir = copieEssai(port + 1001);
      const env = envEssai(mode);
      const id = await premiereSoiree(dir, port, env);
      poserSoiree(dir, id, nuitsMelees(id, { decalage: -60 * DAY }));
      const before = journalServeur(dir).length;
      const launchedAt = Date.now();
      const first = launch(argsEssai(port), { env, cwd: dir });
      await sleep(100);
      const second = launch(argsEssai(port), { env, cwd: dir });
      try {
        const lost = await Promise.race([first, second].map(child => child.exited.then(exit => ({ child, exit }))));
        const kept = lost.child === first ? second : first;
        assert.deepEqual(lost.exit, { code: 1, signal: null }, sorties(lost.child));
        assert.equal(derniereLigne(lost.child), portOccupe(mode, port), sorties(lost.child));
        await demarree(kept, dir, port);
        const lines = journalServeur(dir).slice(before);
        assert.equal(lines.filter(line => line === ACTIVE).length, 1, lines.join('\n'));
        assert.equal(lines.filter(line => line.startsWith(`Réparation : ${id} découpée en 2 morceaux`)).length, 1, lines.join('\n'));
        // Ligne d'état de la réparation avant celle de la soirée en cours (A4, « Coupure »).
        assert.ok(lines.indexOf(ACTIVE) < lines.findIndex(line => line.startsWith(`Réparation : ${id} découpée en 2 morceaux`)), lines.join('\n'));
        const started = lignesSoiree(dir, id).filter(e => e.ev === 'app.started' && e.t >= launchedAt);
        assert.equal(started.length, 1, 'un seul app.started pour ce démarrage');
        assert.equal(fini(kept), false, 'la copie qui a pris le port tourne');
      } finally {
        await first.stop();
        await second.stop();
      }
    });

    test(`A4 : KARAOKE_REPAIR=off (${label}) : une archive close fusionnée reste entière, aucun .bornage.json, la ligne « coupée » au journal du serveur, la copie démarre`, async () => {
      const port = await portsEssai();
      const dir = copieEssai(port + 1001);
      archiveMelee(dir);
      const before = contenusSoiree(dir, ARCHIVE);
      await apresHuitHeures();
      const child = launch(argsEssai(port), { env: envEssai(mode, { KARAOKE_REPAIR: 'off' }), cwd: dir });
      try {
        await demarree(child, dir, port);
        assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
        const lines = journalServeur(dir);
        assert.deepEqual(lines.filter(line => line.startsWith('Réparation des soirées')),
          ['Réparation des soirées : coupée (KARAOKE_REPAIR=off). La remise à zéro du matin reste. Pour la rallumer, retire KARAOKE_REPAIR (DEPLOIEMENT-SERVEUR §18, « Couper la réparation »).']);
        assert.deepEqual(contenusSoiree(dir, ARCHIVE), before, 'archive entière');
        assert.equal(fs.existsSync(path.join(dir, 'data', 'soirees', '.bornage.json')), false, 'aucun .bornage.json');
        assert.equal(fs.existsSync(path.join(dir, 'data', 'soirees-originales')), false, 'aucune copie d’origine');
      } finally { await child.stop(); }
    });

    test(`A4 : archives closes au journal abîmé (dossier à sa place) et au meta.json illisible, puis soirée en cours au journal abîmé (${label}) : /healthz répond, page du bar servie, failed noté, notes au bar, envoi automatique coupé`, async () => {
      const port = await portsEssai();
      const dir = copieEssai(port + 1001);
      const env = envEssai(mode);
      const base = `http://127.0.0.1:${port}`;
      await apresHuitHeures();
      let child = launch(argsEssai(port), { env, cwd: dir });
      let current;
      try {
        await demarree(child, dir, port);
        const key = await cleBar(base, env);
        const set = await fetch(`${base}/api/staff/settings?key=${encodeURIComponent(key)}`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto: true }) });
        assert.equal(set.status, 200, await set.text());
        current = soireeSauvegardee(dir);
      } finally { await child.stop(); }
      const JOURNAL = '2026-08-11_2000_a1a1', META = '2026-08-12_2000_b2b2';
      const broken = nuitsMelees(JOURNAL, { close: true, decalage: -60 * DAY });
      fs.mkdirSync(path.join(dir, 'data', 'soirees', JOURNAL, 'journal.jsonl'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'data', 'soirees', JOURNAL, 'meta.json'), JSON.stringify(broken.meta));
      poserSoiree(dir, META, nuitsMelees(META, { close: true, decalage: -60 * DAY }));
      fs.writeFileSync(path.join(dir, 'data', 'soirees', META, 'meta.json'), '{ "eveningId": "2026-08-12_2000_b2b2", "roster": { "S01": Léa');
      // Soirée en cours : son journal remplacé par un dossier.
      fs.rmSync(path.join(dir, 'data', 'soirees', current, 'journal.jsonl'));
      fs.mkdirSync(path.join(dir, 'data', 'soirees', current, 'journal.jsonl'));
      const before = journalServeur(dir).length;
      child = launch(argsEssai(port), { env, cwd: dir });
      try {
        await waitLine(child, 'Réparation des soirées closes terminée', 30000);
        await demarree(child, dir, port);
        assert.equal((await fetch(`${base}/healthz`)).status, 200);
        const key = await cleBar(base, env);
        const page = await fetch(`${base}/staff?key=${encodeURIComponent(key)}`);
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-type'), /^text\/html/);
        const index = indexSoirees(dir);
        assert.deepEqual([index[JOURNAL]?.status, index[JOURNAL]?.code], ['failed', 'EISDIR']);
        assert.deepEqual([index[META]?.status, index[META]?.code], ['failed', 'BAD_JSON']);
        assert.deepEqual([index[current]?.status, index[current]?.code], ['failed', 'EISDIR']);
        const state = await etat(base, key);
        assert.equal(state.settings.auto, false, 'envoi automatique coupé');
        const notes = state.log.map(entry => entry.msg);
        assert.ok(notes.some(msg => msg.startsWith('Au démarrage, la soirée précédente n’a pas pu être séparée de celle-ci')), notes.join('\n'));
        assert.equal(notes.filter(msg => msg.endsWith(' : réparation impossible, à vérifier : préviens le mainteneur.')).length, 2, notes.join('\n'));
        const lines = journalServeur(dir).slice(before);
        assert.match(lines.find(line => line.startsWith('Réparation des soirées closes terminée')) || '',
          /^Réparation des soirées closes terminée : 0 vérifiées, 0 découpées, 2 en échec, 0 à refaire ; en \d+ ms\.$/);
        assert.ok(!lines.some(line => line.includes('Léa')), 'aucun prénom du meta.json abîmé au journal du serveur');
      } finally { await child.stop(); }
    });
  }

  test('A3 : ARRETER (stop.js) lancé dès que le fichier d’arrêt porte starting, pendant la réparation d’une soirée en cours de 60 nuits : stop.js et la copie sortent en code 0, « === File karaoké … === » avant « Arrêt de la file karaoké demandé par le bar. », plus de fichier d’arrêt (mode PC)', async () => {
    const port = await portsEssai();
    const dir = copieEssai(port + 1001);
    const env = envEssai('pc');
    const id = await premiereSoiree(dir, port, env);
    poserSoiree(dir, id, nuitsMelees(id, { nuits: 60, decalage: -70 * DAY }));
    const before = journalServeur(dir).length;
    const child = launch(argsEssai(port), { env, cwd: dir });
    try {
      for (;;) {
        const runtime = lireRuntime(dir, port);
        if (runtime?.pid === child.pid && runtime.starting === true) break;
        if (fini(child) || runtime?.pid === child.pid) assert.fail(`fichier d’arrêt à starting jamais vu\n${sorties(child)}`);
        await sleep(2);
      }
      const stop = spawn(process.execPath, [path.join(dir, 'stop.js'), '--port', String(port)], { cwd: dir, env, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'] });
      let stopOut = '', stopErr = '';
      stop.stdout.on('data', chunk => { stopOut += chunk; });
      stop.stderr.on('data', chunk => { stopErr += chunk; });
      const stopped = new Promise(resolve => stop.once('close', code => resolve(code)));
      assert.equal(await stopped, 0, stopErr);
      assert.match(stopOut, /La file karaoké s’arrête\./);
      assert.deepEqual(await sortie(child), { code: 0, signal: null }, sorties(child));
      // Avant child.stop(), qui efface le fichier d'un serveur arrêté (comme
      // R10d) : c'est stopHelper qui l'a effacé.
      assert.equal(fs.existsSync(runtimePath(dir, port)), false, 'fichier d’arrêt effacé par la copie');
    } finally { await child.stop(); }
    const lines = journalServeur(dir).slice(before);
    const file = lines.findIndex(line => line.startsWith('=== File karaoké '));
    const stopLine = lines.indexOf('Arrêt de la file karaoké demandé par le bar.');
    assert.ok(file >= 0 && stopLine > file, `« === File karaoké … === » avant l’arrêt :\n${lines.join('\n')}`);
    assert.ok(lines.some(line => line.startsWith(`Réparation : ${id} découpée en 60 morceaux`)), `réparation faite pendant ce démarrage :\n${lines.join('\n')}`);
  });
}
