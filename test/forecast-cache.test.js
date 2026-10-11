'use strict';
// Prévision de la file partagée par toutes les lectures d'un même état.
//
// Regression: P1 de la quatrième relecture finale — chaque GET /api/state
// (chaque téléphone toutes les 4 s, pages cachées comprises) recalculait toute
// la prévision (presenceView → readyView → _forecast), comme la page du bar,
// chaque POST et sync() toutes les 2 s. En événement privé, chaque invité est
// son propre groupe de rotation : avec 400 solistes, environ 0,3 s par
// lecture, et le serveur saturait au-delà d'une centaine d'invités.
//
// La garde de performance compte les calculs (espion sur _forecast), jamais
// le temps : elle ne dépend pas de la vitesse de la machine. Même règle pour
// l'empreinte de la file (optimiseur du kit) et le poids des réponses (gzip).
//
// Même harnais que solo-access-routes.test.js : server.js chargé dans un bac
// à sable `vm`, sans port ni KaraFun ; `Date` partagé avec le test, qui fige
// l'heure pour comparer deux réponses.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { Scheduler } = require('../scheduler');
const { PrivateEvent, MAX_PEOPLE } = require('../private-event');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

function memoryFs() {
  const disk = new Map();
  const inMemory = file => [path.join(root, 'data'), path.join(root, 'journal')]
    .some(dir => file === dir || String(file).startsWith(dir + path.sep));
  const missing = file => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  return { ...fs,
    existsSync: file => inMemory(file) ? disk.has(file) : fs.existsSync(file),
    readFileSync(file, ...rest) {
      if (!inMemory(file)) return fs.readFileSync(file, ...rest);
      if (!disk.has(file)) throw missing(file);
      return disk.get(file);
    },
    writeFileSync(file, data) { disk.set(file, String(data)); },
    appendFileSync(file, data) { disk.set(file, (disk.get(file) || '') + data); },
    renameSync(from, to) { if (!disk.has(from)) throw missing(from); disk.set(to, disk.get(from)); disk.delete(from); },
    unlinkSync(file) { disk.delete(file); },
    mkdirSync() {}, readdirSync() { return []; } };
}

function harness() {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const memFs = memoryFs();
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), '--demo'];
  const context = { require: name => name === 'fs' ? memFs : fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL, setTimeout, clearTimeout,
    setImmediate, AbortSignal, Date };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, access, battleVote, rememberBattleSongs, ensureSoloGroup, STAFF_KEY, PORT,
      handle: server.listeners('request')[0] };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  return f;
}

function call(f, method, url, { body, cookie, headers = {}, remote = '127.0.0.1' } = {}) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers: { ...headers, ...(cookie ? { cookie } : {}) },
      socket: { remoteAddress: remote, localPort: f.PORT }, destroy() {} });
    const out = { status: null, headers: {} };
    // `req` : comme http.ServerResponse, la réponse connaît sa requête.
    const res = { req,
      setHeader(name, value) { out.headers[name.toLowerCase()] = value; },
      getHeader(name) { return out.headers[name.toLowerCase()]; },
      hasHeader(name) { return name.toLowerCase() in out.headers; },
      removeHeader(name) { delete out.headers[name.toLowerCase()]; },
      writeHead(status, headers = {}) {
        out.status = status;
        for (const [name, value] of Object.entries(headers)) out.headers[name.toLowerCase()] = value;
      },
      end(data = '') {
        // `raw` : les octets envoyés ; `text` : le contenu, décompressé.
        out.raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        out.text = (out.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(out.raw) : out.raw).toString('utf8');
        out.body = out.text && /json/.test(out.headers['content-type'] || '') ? JSON.parse(out.text) : out.text;
        resolve(out);
      },
    };
    f.handle(req, res);
    setImmediate(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
  });
}
const post = (f, url, body, options = {}) => call(f, 'POST', url, { ...options, body });
const get = (f, url, options = {}) => call(f, 'GET', url, options);
const staff = (f, route) => `${route}${route.includes('?') ? '&' : '?'}key=${encodeURIComponent(f.STAFF_KEY)}`;
const cookieOf = r => r.headers['set-cookie'] ? String(r.headers['set-cookie']).split(';')[0] : null;
const song = (songId, title = `Titre ${songId}`) => ({ songId, title, artist: 'Artiste' });
const plain = value => JSON.parse(JSON.stringify(value));

// Événement privé allumé : le QR commun et son secret.
async function privateEvent(f) {
  f.ensureSoloGroup();
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  assert.equal(on.status, 200, on.text);
  return { tb: { table: 'Comptoir', access: f.access.get('Comptoir') }, secret: new URL(on.body.url).searchParams.get('evenement') };
}

// Un téléphone par invité (adresses distinctes : 30 créations par minute et par appareil).
let devices = 0;
async function eventPhone(f, tb, secret, name) {
  const r = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: `10.3.${devices >> 8 & 255}.${devices++ & 255}` });
  assert.equal(r.status, 200, r.text);
  const phone = { ...tb, personId: r.body.id, token: r.body.token, cookie: cookieOf(r) };
  const named = await post(f, '/api/table/person/rename', { ...tb, personId: phone.personId, token: phone.token, name }, { cookie: phone.cookie });
  assert.equal(named.status, 200, named.text);
  return phone;
}
const asPhone = (phone, extra = {}) => ({ table: phone.table, access: phone.access, personId: phone.personId, token: phone.token, ...extra });
const addSong = (f, phone, songId) => post(f, '/api/table/song', asPhone(phone, { song: song(songId) }), { cookie: phone.cookie });
// Lecture d'une page cachée (« 0 ») : aucune activité notée, rien d'autre ne change.
const poll = (f, phone, headers = {}) => get(f, `/api/state?table=${encodeURIComponent(phone.table)}&access=${phone.access}`,
  { cookie: phone.cookie, headers: { 'x-person-tokens': JSON.stringify([phone.token]), 'x-page-visible': '0', ...headers } });

// Espion : nombre de prévisions complètes réellement calculées.
function countForecasts(sched) {
  const real = sched._forecast;
  const spy = { count: 0 };
  sched._forecast = function (...args) { spy.count++; return real.apply(this, args); };
  return spy;
}

// Espion : empreintes de la file (toutes les personnes sérialisées, SHA-256).
function countFingerprints(sched) {
  const real = sched.solverContextFingerprint;
  const spy = { count: 0 };
  sched.solverContextFingerprint = function (...args) { spy.count++; return real.apply(this, args); };
  return spy;
}

// Optimiseur du kit simulé : disponible, ne répond jamais (l'ordre local
// reste affiché) ; chaque demande est gardée.
function idleOptimiser() {
  const requests = [];
  return { requests, available: true, lastError: null, solve(request) { requests.push(request); return new Promise(() => {}); }, close() {} };
}

async function eventRoom(f, count) {
  const { tb, secret } = await privateEvent(f);
  const phones = [];
  for (let i = 0; i < count; i++) {
    const phone = await eventPhone(f, tb, secret, `Invité ${i}`);
    const added = await addSong(f, phone, 5000 + i);
    assert.equal(added.status, 200, added.text);
    phones.push(phone);
  }
  return { tb, secret, phones };
}

test('lectures d’un même état : une seule prévision pour tous les téléphones et la page du bar', async () => {
  const f = harness();
  const { phones } = await eventRoom(f, 12);
  const spy = countForecasts(f.sched);
  // Un réglage du bar change l'état (nouvelle version) sans rien recalculer.
  assert.equal((await post(f, staff(f, '/api/staff/settings'), { requirePresence: false })).status, 200);
  assert.equal(spy.count, 0);
  for (let round = 0; round < 3; round++) {
    for (const phone of phones) assert.equal((await poll(f, phone)).status, 200);
    assert.equal((await get(f, staff(f, '/api/staff/state'))).status, 200);
  }
  assert.equal(spy.count, 1, `39 lectures du même état : ${spy.count} prévisions calculées au lieu d’une`);
  // « Je suis là » demandé : la demande de présence lit la même prévision.
  assert.equal((await post(f, staff(f, '/api/staff/settings'), { requirePresence: true })).status, 200);
  spy.count = 0;
  for (const phone of phones) assert.equal((await poll(f, phone)).status, 200);
  assert.equal((await get(f, staff(f, '/api/staff/state'))).status, 200);
  assert.equal(spy.count, 1, `présence demandée : ${spy.count} prévisions pour 13 lectures du même état`);
});

test('un téléphone qui change la file la voit changée dès sa relecture, et les autres lectures ne recalculent rien', async () => {
  const f = harness();
  const { phones } = await eventRoom(f, 12);
  const me = phones[3];
  assert.equal((await poll(f, me)).status, 200);
  const spy = countForecasts(f.sched);
  const added = await addSong(f, me, 6003);
  assert.equal(added.status, 200, added.text);
  const mine = (await poll(f, me)).body;
  assert.ok(mine.me.songs.some(item => item.songId === 6003), 'le titre ajouté est dans sa liste');
  assert.ok(mine.queue.some(item => item.ids?.includes(me.personId) && item.song?.songId === 6003),
    'le titre ajouté est déjà dans la file affichée');
  for (const phone of phones) assert.equal((await poll(f, phone)).status, 200);
  assert.equal((await get(f, staff(f, '/api/staff/state'))).status, 200);
  assert.equal(spy.count, 1, `l’ajout puis 14 lectures : ${spy.count} prévisions au lieu d’une`);
});

// Regression: relecture finale fraîche, première passe (performance
// CRITIQUE) — une entrée refusée par le QR de l'événement (429 trop
// d'inscriptions dans la minute, 403 complet) ne change rien, mais son retour
// arrière réécrivait `version` : la prévision gardée était oubliée et la
// lecture suivante la recalculait (environ 0,2 s à 200 invités). Les refus ne
// sont pas limités : un script, ou les nouveaux essais des téléphones pendant
// une affluence, saturaient le serveur.
test('entrée refusée par le QR de l’événement (trop d’inscriptions, complet) : la prévision gardée reste servie', async () => {
  const f = harness();
  const { tb, secret, phones } = await eventRoom(f, 12);
  const enter = remote => post(f, '/api/table/enter', { ...tb, event: secret }, { remote });
  const readAll = async () => {
    for (const phone of phones) assert.equal((await poll(f, phone)).status, 200);
    assert.equal((await get(f, staff(f, '/api/staff/state'))).status, 200);
  };
  // Un même appareil : 30 créations par minute, puis 429.
  for (let i = 0; i < 30; i++) assert.equal((await enter('10.9.9.9')).status, 200);
  await readAll();
  const spy = countForecasts(f.sched);
  let version = f.sched.version;
  for (let i = 0; i < 10; i++) {
    const busy = await enter('10.9.9.9');
    assert.deepEqual([busy.status, busy.body.code], [429, 'PRIVATE_EVENT_BUSY'], busy.text);
    await readAll();
  }
  assert.equal(f.sched.version, version, '429 : aucun changement d’état');
  assert.equal(spy.count, 0, `10 refus (429) puis lectures : ${spy.count} prévisions recalculées pour un état inchangé`);
  // Complet : 200 personnes nommées présentes venues par l'événement.
  for (let n = 0; PrivateEvent.present(f.sched.people.values()) < MAX_PEOPLE; n++) {
    f.sched.join({ tableId: 'Comptoir', name: `Complet ${n}` }).viaEvent = true;
  }
  await readAll();
  spy.count = 0;
  version = f.sched.version;
  for (let i = 0; i < 10; i++) {
    const full = await enter(`10.8.0.${i}`);
    assert.deepEqual([full.status, full.body.code], [403, 'PRIVATE_EVENT_FULL'], full.text);
    await readAll();
  }
  assert.equal(f.sched.version, version, '403 : aucun changement d’état');
  assert.equal(spy.count, 0, `10 refus (403) puis lectures : ${spy.count} prévisions recalculées pour un état inchangé`);
  // Une place libérée par le bar, puis une entrée acceptée : l'état change,
  // la lecture suivante recalcule, une seule fois pour tous.
  const freed = [...f.sched.people.values()].find(p => p.name === 'Complet 0');
  assert.equal((await post(f, staff(f, '/api/staff/person/leave'), { personId: freed.id })).status, 200);
  await readAll();
  spy.count = 0;
  version = f.sched.version;
  const accepted = await enter('10.8.1.1');
  assert.equal(accepted.status, 200, accepted.text);
  assert.ok(f.sched.version > version, 'entrée acceptée : nouvelle version');
  await readAll();
  assert.equal(spy.count, 1, `entrée acceptée puis lectures : ${spy.count} prévisions au lieu d’une`);
});

// Même règle pour une inscription refusée à une table (prénom déjà pris) :
// rien n'a changé, la version n'est pas réécrite.
test('inscription refusée à une table (prénom déjà pris) : la prévision gardée reste servie', async () => {
  const f = harness();
  const { phones } = await eventRoom(f, 6);
  f.sched.table('4').headcount = 6;
  const tb = { table: '4', access: f.access.issue('4') };
  assert.equal((await post(f, '/api/table/person', { ...tb, name: 'Max' })).status, 200);
  for (const phone of phones) assert.equal((await poll(f, phone)).status, 200);
  const spy = countForecasts(f.sched);
  const version = f.sched.version;
  for (let i = 0; i < 5; i++) {
    const taken = await post(f, '/api/table/person', { ...tb, name: 'max' });
    assert.deepEqual([taken.status, taken.body.code], [400, 'NAME_TAKEN'], taken.text);
    for (const phone of phones) assert.equal((await poll(f, phone)).status, 200);
  }
  assert.equal(f.sched.version, version, 'aucun changement d’état');
  assert.equal(spy.count, 0, `5 refus puis lectures : ${spy.count} prévisions recalculées pour un état inchangé`);
});

test('prévision du Scheduler : un seul calcul par état, des copies que l’appelant peut trier', () => {
  const s = new Scheduler({ solverEnabled: false });
  s.table('Comptoir').individual = true;
  for (let i = 0; i < 8; i++) s.chooseSong(s.join({ tableId: 'Comptoir', name: `Solo ${i}x` }), song(100 + i));
  const spy = countForecasts(s);
  const first = s.presenceView();
  for (let i = 0; i < 20; i++) s.presenceView();
  assert.equal(spy.count, 1, 'vingt lectures du même état, un seul calcul');
  const copy = s.presenceView();
  copy.reverse();
  copy.push({ ids: ['x'] });
  assert.deepEqual(plain(s.presenceView()), plain(first), 'trier ou allonger sa copie ne change pas la prévision gardée');
  // Une exclusion (titre sur scène) : son propre calcul, gardé lui aussi.
  s.presenceView([first[0].ids[0]]);
  assert.equal(spy.count, 2);
  s.presenceView([first[0].ids[0]]);
  assert.equal(spy.count, 2);
  s.readyView();
  assert.equal(spy.count, 3, 'sans présence (readyView) : une prévision distincte');
  s.note('Changement');
  s.presenceView();
  assert.equal(spy.count, 4, 'version changée : nouveau calcul');
});

// Ce qui change la prévision sans nouvelle version : l'heure (fin d'un report
// « Pas prêt », d'une confirmation « Je suis là »), une version remise à sa
// valeur d'avant (server.js le fait quand une sauvegarde échoue : la même
// valeur peut ensuite revenir pour un autre état) et un réglage écrit
// directement dans `opts`.
test('prévision gardée : l’heure, une version remise en arrière et les réglages la renouvellent', () => {
  const realNow = Date.now;
  let clock = realNow.call(Date);
  Date.now = () => clock;
  try {
    const s = new Scheduler({ solverEnabled: false });
    s.table('Comptoir').individual = true;
    const people = ['Ana', 'Ben', 'Cléo', 'Dan', 'Eva'].map((name, i) => {
      const p = s.join({ tableId: 'Comptoir', name });
      s.chooseSong(p, song(200 + i));
      return p;
    });
    const owners = view => view.filter(v => !v.future).map(v => s.people.get(v.ids[0]).name);
    const usual = owners(s.presenceView());
    // « Pas prêt » : le passage laisse passer une chanson, puis son report
    // échoit à son heure sans aucune autre action.
    const first = s.presenceView().find(v => !v.future);
    s.deferPassage(first.ids[0], first, 1);
    const deferred = owners(s.presenceView());
    assert.notEqual(deferred[0], usual[0], 'le passage repoussé n’est plus le premier');
    clock = s.people.get(first.ids[0]).deferral.until;
    assert.deepEqual(owners(s.presenceView()), usual, 'report échu : la file retrouve son ordre');
    // « Je suis là » : la confirmation vaut 30 minutes.
    s.opts.requirePresence = true;
    s.version++;
    s.confirm(people[1]);
    assert.deepEqual(owners(s.readyView()), ['Ben'], 'seule la personne confirmée est prête');
    assert.equal(s.presenceView().find(v => v.ids[0] === people[1].id).confirmed, true);
    clock += 30 * 60 * 1000;
    assert.deepEqual(owners(s.readyView()), [], 'confirmation échue : plus personne de prêt');
    assert.equal(s.presenceView().find(v => v.ids[0] === people[1].id).confirmed, false);
    s.opts.requirePresence = false;
    s.version++;
    // Sauvegarde impossible : l'ajout est défait et la version remise à sa
    // valeur d'avant ; un autre ajout retrouve ensuite le même numéro.
    const before = s.version;
    s.chooseSong(people[4], song(300), 'append');
    const undone = s.version;
    assert.ok(s.presenceView().some(v => v.song?.songId === 300));
    people[4].backlog = [];
    s.version = before;
    s.chooseSong(people[4], song(301), 'append');
    assert.equal(s.version, undone, 'même numéro de version que l’état défait');
    const listed = s.presenceView().map(v => v.song?.songId);
    assert.ok(listed.includes(301) && !listed.includes(300), 'la prévision suit le nouvel ajout, pas l’état défait');
    // Réglage écrit directement : la prévision le reprend.
    s.opts.cap = 7;
    assert.equal(s.presenceView()[0].cap, 7);
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------- équivalence
// Référence sans cache : readyView (et presenceView, qui l'appelle) refait
// le calcul complet à chaque lecture, sans lire ni remplir les prévisions
// gardées.
function uncached(sched, read) {
  sched.readyView = function (excludeIds = [], provisional = null, ignorePresence = false) {
    this._maybeRequestSolver();
    return this._readyView(excludeIds, provisional, ignorePresence);
  };
  const done = () => { delete sched.readyView; };
  try {
    const out = read();
    if (out && typeof out.then === 'function') return out.finally(done);
    done();
    return out;
  } catch (error) { done(); throw error; }
}

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

// Actions d'une graine : tours mélangés, chaque action revient une fois par
// tour (tirée au hasard pur, une action pouvait ne jamais venir), deux fois
// pour les arrivées et les titres : sinon les départs vident la file. Une
// action qui suppose une autre (répondre à un duo, se dire prêt, lever une
// réservation) vient après elle dans le tour.
const AFTER = { 'duo répondu': 'duo', 'duo annulé': 'duo', 'prêt': 'pas prêt', 'réservation levée': 'réservation' };
function actionOrder(r, names, count) {
  const order = [];
  while (order.length < count) {
    const round = names.flatMap(name => ['arrivée', 'titre'].includes(name) ? [name, name] : [name]);
    for (let i = round.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [round[i], round[j]] = [round[j], round[i]];
    }
    for (const [later, earlier] of Object.entries(AFTER)) {
      const i = round.indexOf(later), j = round.indexOf(earlier);
      if (i >= 0 && j > i) [round[i], round[j]] = [round[j], round[i]];
    }
    order.push(...round);
  }
  return order.slice(0, count);
}

// Une action toujours refusée ne change rien : la comparaison qui la suit ne
// prouve rien, et le try/catch la cachait (aucun duo n'était jamais formé
// dans le Scheduler, aucun déplacement du bar n'aboutissait au serveur).
// Chaque action doit aboutir au moins une fois par graine.
function assertEveryAction(done, names, label) {
  const dead = names.filter(name => !done.get(name));
  assert.deepEqual(dead, [], `${label} : action jamais aboutie (${dead.join(', ')})`);
}

test('équivalence (Scheduler) : la prévision gardée égale le calcul complet, pas à pas au hasard', () => {
  const realNow = Date.now;
  let clock = realNow.call(Date);
  Date.now = () => clock;
  try {
    let compared = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const r = rng(seed * 104729);
      const pick = list => list[Math.floor(r() * list.length)];
      const s = new Scheduler({ solverEnabled: false, tableRotation: r() < 0.4, requirePresence: r() < 0.3 });
      // Une graine sur deux, l'optimiseur du kit est disponible (PC du bar) :
      // chaque lecture lui passe l'empreinte de la file.
      const optimiser = seed % 2 === 0 ? idleOptimiser() : null;
      if (optimiser) s.solverBridge = optimiser;
      s.table('Comptoir').individual = true;
      for (const t of ['1', '2']) s.table(t).headcount = 30;
      let next = 1;
      const live = () => [...s.people.values()].filter(p => !p.withdrawnAt);
      const withSong = () => live().filter(p => p.song);
      // Huit chanteurs avec un ou deux titres, solistes et tables : dès le
      // premier pas, la comparaison porte sur une vraie file.
      for (let i = 0; i < 8; i++) {
        const p = s.join({ tableId: ['Comptoir', '1', '2'][i % 3], name: `P${next++}` });
        for (let k = r() < 0.5 ? 1 : 2; k > 0; k--) s.chooseSong(p, song(next++), 'append');
      }
      let provisional = null;
      const views = () => {
        const out = [s.presenceView(), s.readyView(), s.readyView([], null, true)];
        if (provisional) out.push(s.presenceView(provisional.consumedIds || provisional.ids, provisional));
        const first = out[0].find(v => !v.future);
        if (first) out.push(s.presenceView(first.ids));
        return plain(out);
      };
      // Chaque action rend vrai si elle a abouti (un refus lève une erreur).
      const steps = {
        'arrivée': () => { const p = s.join({ tableId: pick(['Comptoir', 'Comptoir', '1', '2']), name: `P${next}` }); s.chooseSong(p, song(next++)); return true; },
        'titre': () => { s.chooseSong(pick(live()), song(next++), r() < 0.7 ? 'append' : 'replace'); return true; },
        'titre retiré': () => { const p = pick(withSong()); s.removeSong(p, pick(s.songsOf(p)).entryId); return true; },
        'prénom': () => { s.rename(pick(live()), `R${next++}`); return true; },
        'départ': () => { s.leave(pick(live())); return true; },
        // inviteDuet ajoute le titre du duo : un objet chanson, pas l'entrée
        // d'un titre déjà prévu. La réponse de l'invitée est une autre action,
        // lue avant et après comme les autres.
        'duo': () => { const p = pick(live()); s.inviteDuet(p, pick(live().filter(x => x !== p)).id, song(next++)); return true; },
        'duo répondu': () => {
          const invites = live().flatMap(q => s.duetInvites(q).map(inv => [q, inv]));
          if (!invites.length) return false;
          const [q, inv] = pick(invites);
          s.answerDuet(q, r() < 0.8, inv.entryId);
          return true;
        },
        // L'auteur annule, ou l'invitée refuse (en attente) ou se retire (accepté).
        'duo annulé': () => {
          const duos = live().flatMap(p => s.songsOf(p).filter(item => item.duet).map(item => [p, item]));
          if (!duos.length) return false;
          const [owner, item] = pick(duos);
          s.cancelDuet(r() < 0.5 ? owner : s.people.get(item.duet.partnerId), item.entryId);
          return true;
        },
        'présence': () => { s.confirm(pick(live())); return true; },
        'envoi': () => {
          const sel = s.select({ stageFree: true });
          if (!sel) return false;
          if (r() < 0.3) provisional = sel; else { s.commit(sel); provisional = null; }
          return true;
        },
        'pas prêt': () => { const first = s.presenceView().find(v => !v.future); if (!first) return false; s.deferPassage(first.ids[0], first, 1 + Math.floor(r() * 2)); return true; },
        'prêt': () => { const owner = live().find(p => s.isDeferred(p)); if (!owner) return false; s.cancelDeferral(owner.id); return true; },
        'absent': () => !!s.skipUnconfirmed(pick(withSong()).id),
        'déplacement': () => {
          const visible = s.presenceView().filter(v => !v.future);
          if (visible.length < 2) return false;
          s.staffMove(pick(visible).ids[0], Math.floor(r() * visible.length));
          return true;
        },
        'bonus': () => { s.setPersonBonus(pick(live()).id, Math.floor(r() * 7) - 3); return true; },
        'réglage présence': () => { s.opts.requirePresence = !s.opts.requirePresence; return true; },
        'réglage rotation': () => { s.opts.tableRotation = !s.opts.tableRotation; return true; },
        'réglage plafond': () => { s.opts.cap = 1 + Math.floor(r() * 4); return true; },
        'heure': () => { clock += pick([1000, 60000, 10 * 60000, 31 * 60000]); return true; },
        'version remise': () => { const v = s.version; s.chooseSong(pick(live()), song(next++), 'append'); s.version = v; return true; },
        'réservation': () => !!s.reserveNext(),
        'réservation levée': () => { if (!s.reservedNext) return false; s.releaseNext(); return true; },
      };
      const names = Object.keys(steps);
      const done = new Map();
      let longest = 0;
      for (const [step, name] of actionOrder(r, names, 180).entries()) {
        views(); // prévisions gardées avant l'action
        let accepted = false;
        try { accepted = steps[name]() === true; } catch (_) { /* action refusée : on compare quand même */ }
        if (accepted) done.set(name, (done.get(name) || 0) + 1);
        const cached = views();
        const asked = optimiser?.requests.length;
        assert.deepEqual(cached, uncached(s, views), `graine ${seed}, pas ${step} (${name}) : prévision gardée différente du calcul complet`);
        // Les lectures gardées ont déjà demandé l'ordre de cet état : relues
        // avec l'empreinte recalculée, elles n'ont rien à redemander.
        assert.equal(optimiser?.requests.length, asked, `graine ${seed}, pas ${step} (${name}) : empreinte des lectures gardées périmée`);
        compared++;
        longest = Math.max(longest, cached[0].length);
      }
      assertEveryAction(done, names, `Scheduler, graine ${seed}`);
      assert.ok(longest >= 15, `Scheduler, graine ${seed} : file de ${longest} titres au plus`);
    }
    assert.ok(compared > 1000);
  } finally {
    Date.now = realNow;
  }
});

test('équivalence (serveur) : téléphones et page du bar identiques au calcul complet, pas à pas au hasard', async () => {
  const realNow = Date.now;
  let clock = realNow.call(Date);
  Date.now = () => clock;
  try {
    let compared = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const r = rng(seed * 7919);
      const pick = list => list[Math.floor(r() * list.length)];
      const f = harness();
      const optimiser = seed === 2 ? idleOptimiser() : null;
      if (optimiser) f.sched.solverBridge = optimiser;
      f.battleVote.setMinVoters(1);
      const battleSongs = [song(81001, 'Battle A'), song(81002, 'Battle B')];
      f.rememberBattleSongs(battleSongs);
      const { tb, secret } = await privateEvent(f);
      const tables = ['1', '2'].map(id => { f.sched.table(id).headcount = 12; return { table: id, access: f.access.issue(id) }; });
      const phones = [];
      let next = 1;
      // Vrai si le serveur a accepté l'action (HTTP 200).
      const ok = async (url, body, phone) => (await post(f, url, body, { cookie: phone?.cookie })).status === 200;
      const someone = () => pick(phones);
      const songOf = phone => {
        const p = f.sched.people.get(phone.personId);
        return p && pick(f.sched.songsOf(p));
      };
      const present = () => phones.filter(phone => !f.sched.people.get(phone.personId)?.withdrawnAt);
      // Passages prêts de la file, comme les lignes du bar (rien en cours d'envoi :
      // l'envoi automatique est coupé) ; le téléphone d'un passage.
      const visible = () => f.sched.presenceView().filter(v => !v.future);
      const phoneOf = passage => passage && phones.find(phone => passage.ids.includes(phone.personId));
      const steps = {
        'arrivée': async () => { phones.push(await eventPhone(f, tb, secret, `Invité ${next++}`)); return true; },
        'table': async () => {
          const at = pick(tables);
          const joined = await post(f, '/api/table/person', { ...at, name: `Table ${next++}` });
          if (joined.status === 200) phones.push({ ...at, personId: joined.body.id, token: joined.body.token, cookie: null });
          return joined.status === 200;
        },
        'titre': async () => { const phone = someone(); return ok('/api/table/song', asPhone(phone, { song: song(next++), mode: r() < 0.8 ? 'append' : 'replace' }), phone); },
        'titre retiré': async () => {
          const phone = pick(phones.filter(item => songOf(item)));
          return !!phone && ok('/api/table/song/remove', asPhone(phone, { entryId: songOf(phone).entryId }), phone);
        },
        'prénom': async () => { const phone = someone(); return ok('/api/table/person/rename', asPhone(phone, { name: `Nom ${next++}` }), phone); },
        'parti': async () => ok(staff(f, '/api/staff/person/leave'), { personId: pick(present()).personId }),
        'réactivé': async () => {
          const gone = phones.filter(phone => f.sched.people.get(phone.personId)?.withdrawnAt);
          return gone.length > 0 && ok(staff(f, '/api/staff/person/reactivate'), { personId: pick(gone).personId });
        },
        'duo': async () => {
          const owner = someone(), partner = someone();
          return owner !== partner && ok('/api/table/duet', asPhone(owner, { partnerId: partner.personId, song: song(next++) }), owner);
        },
        // Réponse de l'invitée, une action à part : lue avant et après.
        'duo répondu': async () => {
          const invited = phones.flatMap(phone => {
            const p = f.sched.people.get(phone.personId);
            return p ? f.sched.duetInvites(p).map(inv => [phone, inv]) : [];
          });
          if (!invited.length) return false;
          const [phone, inv] = pick(invited);
          return ok('/api/table/duet/answer', asPhone(phone, { entryId: inv.entryId, accept: r() < 0.8 }), phone);
        },
        'réglage présence': async () => ok(staff(f, '/api/staff/settings'), { requirePresence: r() < 0.6 }),
        // Présence demandée : seul le prochain passage peut confirmer.
        'présence': async () => { const phone = phoneOf(visible()[0]) || someone(); return ok('/api/table/confirm', asPhone(phone), phone); },
        // « Pas prêt » : le prochain passage qui n'est pas déjà repoussé.
        'pas prêt': async () => {
          const phone = phoneOf(visible().find(v => !f.sched.isDeferred(f.sched.people.get(v.ids[0]))));
          return !!phone && ok('/api/table/defer', asPhone(phone, { songs: 1 + Math.floor(r() * 2) }), phone);
        },
        'prêt': async () => {
          const phone = phones.find(item => f.sched.deferralFor(item.personId));
          return !!phone && ok('/api/table/defer/cancel', asPhone(phone), phone);
        },
        // Déplacement ou « Priorité » d'une ligne du bar vers une autre place.
        'déplacement': async () => {
          const lines = visible();
          if (lines.length < 2) return false;
          const from = Math.floor(r() * lines.length);
          const to = (from + 1 + Math.floor(r() * (lines.length - 1))) % lines.length;
          return ok(staff(f, '/api/staff/move'), { personId: lines[from].ids[0], toIndex: to, priority: to === 0 && r() < 0.5 });
        },
        'bonus': async () => ok(staff(f, '/api/staff/bonus'), { personId: someone().personId, level: Math.floor(r() * 7) - 3 }),
        'réglage rotation': async () => { const rotation = r() < 0.5; return ok(staff(f, '/api/staff/settings'), { tableRotation: rotation, weightedTables: rotation && r() < 0.5 }); },
        'battle': async () => {
          const phone = someone();
          let accepted = await ok('/api/table/battle/propose', asPhone(phone, { songs: battleSongs, proposerChoice: battleSongs[0].songId }), phone);
          for (const voter of phones) if (r() < 0.5) accepted = await ok('/api/table/battle/vote', asPhone(voter, { choice: pick([81001, 81002, 'none']) }), voter) || accepted;
          return accepted;
        },
        'retiré par le bar': async () => ok(staff(f, '/api/staff/remove'), { personId: someone().personId }),
        'heure': async () => { clock += pick([1000, 60000, 10 * 60000, 31 * 60000]); return true; },
      };
      const names = Object.keys(steps);
      const done = new Map();
      // Huit invités avec un à trois titres : dès le premier pas, la
      // comparaison porte sur une vraie file (déplacements, « Pas prêt », duos).
      for (let i = 0; i < 8; i++) {
        const phone = await eventPhone(f, tb, secret, `Invité ${next++}`);
        phones.push(phone);
        for (let k = 1 + Math.floor(r() * 3); k > 0; k--) assert.equal((await addSong(f, phone, next++)).status, 200);
      }
      let longest = 0;
      for (const [step, name] of actionOrder(r, names, 100).entries()) {
        const viewers = [someone(), someone()];
        const read = async () => [
          ...(await Promise.all(viewers.map(async phone => (await poll(f, phone)).text))),
          (await get(f, staff(f, '/api/staff/state'))).text];
        await read(); // prévisions gardées avant l'action
        let accepted = false;
        try { accepted = await steps[name]() === true; } catch (_) { /* action refusée : on compare quand même */ }
        if (accepted) done.set(name, (done.get(name) || 0) + 1);
        // Échéances du vote Battle, comme le tour de 2 s du serveur : lire la
        // page ne doit pas les faire passer entre les deux lectures comparées.
        f.battleVote.tick();
        const cached = await read();
        const asked = optimiser?.requests.length;
        assert.deepEqual(cached, await uncached(f.sched, read), `graine ${seed}, pas ${step} (${name}) : réponse servie par la prévision gardée différente du calcul complet`);
        assert.equal(optimiser?.requests.length, asked, `graine ${seed}, pas ${step} (${name}) : empreinte des lectures gardées périmée`);
        compared++;
        longest = Math.max(longest, JSON.parse(cached.at(-1)).queue.length);
      }
      assertEveryAction(done, names, `serveur, graine ${seed}`);
      assert.ok(longest >= 15, `serveur, graine ${seed} : file de ${longest} titres au plus`);
    }
    assert.equal(compared, 300);
  } finally {
    Date.now = realNow;
  }
});

test('sans optimiseur ni plan : aucune empreinte de file calculée à chaque lecture', () => {
  const s = new Scheduler({ solverEnabled: false });
  s.table('Comptoir').individual = true;
  for (let i = 0; i < 6; i++) s.chooseSong(s.join({ tableId: 'Comptoir', name: `Solo ${i}y` }), song(300 + i));
  const real = s.solverContextFingerprint;
  let fingerprints = 0;
  s.solverContextFingerprint = function (...args) { fingerprints++; return real.apply(this, args); };
  for (let i = 0; i < 10; i++) s.presenceView();
  assert.equal(fingerprints, 0, 'l’empreinte ne sert qu’à l’optimiseur ou à un plan adopté');
});

// Sur le PC du bar (hors démo), l'optimiseur du kit est disponible ; après un
// déplacement du bar, un plan « manuel » est adopté. Chaque lecture, même
// servie par la prévision gardée, recalculait alors l'empreinte de la file
// pour _maybeRequestSolver : plus cher que la lecture elle-même (0,3 ms à 400
// invités, contre quelques microsecondes).
test('optimiseur disponible ou plan du bar : les lectures gardées ne recalculent pas l’empreinte de la file', () => {
  const s = new Scheduler({ solverEnabled: false });
  const optimiser = idleOptimiser();
  s.solverBridge = optimiser;
  s.table('Comptoir').individual = true;
  for (let i = 0; i < 12; i++) s.chooseSong(s.join({ tableId: 'Comptoir', name: `Solo ${i}w` }), song(400 + i));
  const fingerprints = countFingerprints(s);
  const first = s.presenceView();
  assert.equal(optimiser.requests.length, 1, 'l’état part à l’optimiseur');
  fingerprints.count = 0;
  for (let i = 0; i < 20; i++) s.presenceView();
  assert.equal(fingerprints.count, 0, `20 lectures du même état : ${fingerprints.count} empreintes recalculées`);
  assert.equal(optimiser.requests.length, 1, 'aucune nouvelle demande pour le même état');
  // Un titre ajouté : la lecture suivante relève la nouvelle empreinte et
  // redemande l'ordre.
  s.chooseSong(s.people.get(first[0].ids[0]), song(499), 'append');
  s.presenceView();
  assert.equal(optimiser.requests.length, 2, 'le nouvel état part à l’optimiseur');
  // Plan du bar, sans optimiseur : même règle.
  s.solverBridge = null;
  s.staffMove(s.presenceView().filter(v => !v.future)[3].ids[0], 1);
  assert.equal(s.solverPlan.source, 'manual');
  const moved = plain(s.presenceView());
  fingerprints.count = 0;
  for (let i = 0; i < 20; i++) assert.deepEqual(plain(s.presenceView()), moved);
  assert.equal(fingerprints.count, 0, `plan du bar, 20 lectures : ${fingerprints.count} empreintes recalculées`);
  assert.equal(s.solverPlan?.source, 'manual', 'le plan du bar tient');
});

// La prévision gardée ne fait pas taire l'optimiseur : revenu après sa pause
// de sécurité, il reçoit l'état courant à la lecture suivante, sans attendre
// un changement de la file.
test('optimiseur revenu après une panne : la lecture suivante du même état lui redemande l’ordre', async () => {
  const s = new Scheduler({ solverEnabled: false });
  let up = true;
  const asked = [];
  s.solverBridge = { get available() { return up; }, lastError: null, close() {},
    solve(request) { return new Promise((resolve, reject) => asked.push({ request, reject })); } };
  s.table('Comptoir').individual = true;
  for (let i = 0; i < 6; i++) s.chooseSong(s.join({ tableId: 'Comptoir', name: `Solo ${i}v` }), song(600 + i));
  s.presenceView();
  assert.equal(asked.length, 1);
  up = false;
  asked[0].reject(new Error('L’optimiseur de file s’est arrêté.'));
  assert.equal(await s.solverPromise, false);
  for (let i = 0; i < 5; i++) s.presenceView();
  assert.equal(asked.length, 1, 'en pause : rien n’est demandé');
  up = true;
  s.presenceView();
  assert.equal(asked.length, 2, 'revenu : l’état courant lui est redemandé');
  assert.equal(asked[1].request.performances.length, 6);
});

// L'optimiseur refuse plus de 200 titres : avant, chaque changement de la
// file calculait toute une prévision (la graine) pour ce seul refus, en plus
// de celle des lectures.
test('optimiseur disponible et plus de 200 titres : le refus ne recalcule pas une seconde prévision', () => {
  const s = new Scheduler({ solverEnabled: false });
  const requests = [];
  s.solverBridge = { available: true, solve(request) { requests.push(request); return new Promise(() => {}); }, close() {} };
  s.table('Comptoir').individual = true;
  for (let i = 0; i < 201; i++) s.chooseSong(s.join({ tableId: 'Comptoir', name: `Invité ${i}z` }), song(1000 + i));
  const spy = countForecasts(s);
  const view = s.presenceView();
  assert.equal(view.length, 201);
  assert.equal(spy.count, 1, `${spy.count} prévisions pour une lecture`);
  assert.equal(s.solverStatus().fallbackLastError, 'Plus de 200 titres prêts : ordonnanceur local seul.');
  assert.equal(requests.length, 0);
  // Un titre retiré : 200 titres, l'optimiseur repart sur la graine habituelle.
  const first = s.people.get(view[0].ids[0]);
  s.removeSong(first, first.song.entryId);
  spy.count = 0;
  s.presenceView();
  assert.equal(requests.length, 1, 'à 200 titres, le calcul part');
  assert.equal(requests[0].performances.length, 200);
});

// Poids des réponses : à 400 invités, chaque lecture d'un téléphone (toutes
// les 4 s, pages cachées comprises) portait environ 240 Ko de JSON en clair,
// 23,5 Mo/s pour 400 pages ouvertes, par le Wi-Fi du bar ou par le tunnel.
// Les navigateurs acceptent tous gzip : le JSON part compressé.
test('réponses JSON compressées en gzip quand le navigateur l’accepte', async () => {
  const realNow = Date.now;
  const clock = realNow.call(Date);
  Date.now = () => clock;
  try {
    const f = harness();
    const { phones } = await eventRoom(f, 40);
    const me = phones[0];
    const clear = await poll(f, me);
    assert.equal(clear.headers['content-encoding'], undefined, 'sans Accept-Encoding : en clair');
    const zipped = await poll(f, me, { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(zipped.status, 200);
    assert.equal(zipped.headers['content-encoding'], 'gzip');
    assert.equal(zipped.headers.vary, 'Accept-Encoding');
    assert.equal(zipped.text, clear.text, 'même contenu une fois décompressé');
    assert.ok(zipped.raw.length * 5 < clear.raw.length, `${zipped.raw.length} octets compressés pour ${clear.raw.length} en clair`);
    const bar = await get(f, staff(f, '/api/staff/state'), { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(bar.headers['content-encoding'], 'gzip', 'page du bar compressée aussi');
    assert.equal(bar.body.queue.length, 40);
    // gzip refusé (q=0) : en clair.
    assert.equal((await poll(f, me, { 'accept-encoding': 'br, gzip;q=0' })).headers['content-encoding'], undefined);
    // Petite réponse : en clair, rien à gagner.
    const small = await post(f, '/api/table/confirm', asPhone(me), { cookie: me.cookie, headers: { 'accept-encoding': 'gzip' } });
    assert.equal(small.status, 200, small.text);
    assert.equal(small.headers['content-encoding'], undefined);
  } finally {
    Date.now = realNow;
  }
});
