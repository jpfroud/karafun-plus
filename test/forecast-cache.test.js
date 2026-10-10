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
// le temps : elle ne dépend pas de la vitesse de la machine.
//
// Même harnais que solo-access-routes.test.js : server.js chargé dans un bac
// à sable `vm`, sans port ni KaraFun ; `Date` partagé avec le test, qui fige
// l'heure pour comparer deux réponses.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { Scheduler } = require('../scheduler');

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
    const res = {
      setHeader(name, value) { out.headers[name.toLowerCase()] = value; },
      getHeader(name) { return out.headers[name.toLowerCase()]; },
      hasHeader(name) { return name.toLowerCase() in out.headers; },
      removeHeader(name) { delete out.headers[name.toLowerCase()]; },
      writeHead(status, headers = {}) {
        out.status = status;
        for (const [name, value] of Object.entries(headers)) out.headers[name.toLowerCase()] = value;
      },
      end(data = '') {
        out.text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
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
const poll = (f, phone) => get(f, `/api/state?table=${encodeURIComponent(phone.table)}&access=${phone.access}`,
  { cookie: phone.cookie, headers: { 'x-person-tokens': JSON.stringify([phone.token]), 'x-page-visible': '0' } });

// Espion : nombre de prévisions complètes réellement calculées.
function countForecasts(sched) {
  const real = sched._forecast;
  const spy = { count: 0 };
  sched._forecast = function (...args) { spy.count++; return real.apply(this, args); };
  return spy;
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
      s.table('Comptoir').individual = true;
      for (const t of ['1', '2']) s.table(t).headcount = 30;
      let next = 1;
      const live = () => [...s.people.values()].filter(p => !p.withdrawnAt);
      const withSong = () => live().filter(p => p.song);
      let provisional = null;
      const views = () => {
        const out = [s.presenceView(), s.readyView(), s.readyView([], null, true)];
        if (provisional) out.push(s.presenceView(provisional.consumedIds || provisional.ids, provisional));
        const first = out[0].find(v => !v.future);
        if (first) out.push(s.presenceView(first.ids));
        return plain(out);
      };
      const steps = [
        () => { const p = s.join({ tableId: pick(['Comptoir', 'Comptoir', '1', '2']), name: `P${next}` }); s.chooseSong(p, song(next++)); },
        () => s.chooseSong(pick(live()), song(next++), r() < 0.7 ? 'append' : 'replace'),
        () => { const p = pick(withSong()); s.removeSong(p, pick(s.songsOf(p)).entryId); },
        () => s.rename(pick(live()), `R${next++}`),
        () => s.leave(pick(live())),
        () => { const p = pick(withSong()); const q = pick(live().filter(x => x !== p)); s.inviteDuet(p, q.id, p.song.entryId);
          if (r() < 0.8) s.answerDuet(q, true, p.song.entryId); },
        () => s.confirm(pick(live())),
        () => { const sel = s.select({ stageFree: true }); if (sel) { if (r() < 0.3) provisional = sel; else { s.commit(sel); provisional = null; } } },
        () => { const first = s.presenceView().find(v => !v.future); if (first) s.deferPassage(first.ids[0], first, 1 + Math.floor(r() * 2)); },
        () => s.skipUnconfirmed(pick(withSong()).id),
        () => { const visible = s.presenceView().filter(v => !v.future); if (visible.length > 1) s.staffMove(pick(visible).ids[0], Math.floor(r() * visible.length)); },
        () => s.setPersonBonus(pick(live()).id, Math.floor(r() * 7) - 3),
        () => { s.opts.requirePresence = !s.opts.requirePresence; },
        () => { s.opts.tableRotation = !s.opts.tableRotation; },
        () => { s.opts.cap = 1 + Math.floor(r() * 4); },
        () => { clock += pick([1000, 60000, 10 * 60000, 31 * 60000]); },
        () => { const v = s.version; s.chooseSong(pick(live()), song(next++), 'append'); s.version = v; },
        () => s.reserveNext(),
        () => s.releaseNext(),
      ];
      for (let step = 0; step < 180; step++) {
        views(); // prévisions gardées avant l'action
        const action = Math.floor(r() * steps.length);
        try { steps[action](); } catch (_) { /* action refusée : on compare quand même */ }
        const cached = views();
        assert.deepEqual(cached, uncached(s, views), `graine ${seed}, pas ${step} (action ${action}) : prévision gardée différente du calcul complet`);
        compared++;
      }
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
      f.battleVote.setMinVoters(1);
      const battleSongs = [song(81001, 'Battle A'), song(81002, 'Battle B')];
      f.rememberBattleSongs(battleSongs);
      const { tb, secret } = await privateEvent(f);
      const tables = ['1', '2'].map(id => { f.sched.table(id).headcount = 12; return { table: id, access: f.access.issue(id) }; });
      const phones = [];
      let next = 1;
      const ok = async (url, body, phone) => (await post(f, url, body, { cookie: phone?.cookie })).body;
      const someone = () => pick(phones);
      const songOf = phone => {
        const p = f.sched.people.get(phone.personId);
        return p && pick(f.sched.songsOf(p));
      };
      const steps = [
        async () => { phones.push(await eventPhone(f, tb, secret, `Invité ${next++}`)); },
        async () => {
          const at = pick(tables);
          const joined = await post(f, '/api/table/person', { ...at, name: `Table ${next++}` });
          if (joined.status === 200) phones.push({ ...at, personId: joined.body.id, token: joined.body.token, cookie: null });
        },
        async () => { const phone = someone(); await ok('/api/table/song', asPhone(phone, { song: song(next++), mode: r() < 0.8 ? 'append' : 'replace' }), phone); },
        async () => { const phone = someone(); const item = songOf(phone); if (item) await ok('/api/table/song/remove', asPhone(phone, { entryId: item.entryId }), phone); },
        async () => { const phone = someone(); await ok('/api/table/person/rename', asPhone(phone, { name: `Nom ${next++}` }), phone); },
        async () => { await ok(staff(f, '/api/staff/person/leave'), { personId: someone().personId }); },
        async () => { await ok(staff(f, '/api/staff/person/reactivate'), { personId: someone().personId }); },
        async () => {
          const owner = someone(), partner = someone();
          if (owner === partner) return;
          const invited = await post(f, '/api/table/duet', asPhone(owner, { partnerId: partner.personId, song: song(next++) }), { cookie: owner.cookie });
          if (invited.status !== 200 || r() < 0.2) return;
          const p = f.sched.people.get(owner.personId);
          const duo = f.sched.songsOf(p).find(item => item.duet?.partnerId === partner.personId && item.duet.state === 'pending');
          if (duo) await ok('/api/table/duet/answer', asPhone(partner, { entryId: duo.entryId, accept: true }), partner);
        },
        async () => { await ok(staff(f, '/api/staff/settings'), { requirePresence: r() < 0.6 }); },
        async () => { const phone = someone(); await ok('/api/table/confirm', asPhone(phone), phone); },
        async () => { const phone = someone(); await ok('/api/table/defer', asPhone(phone, { songs: 1 }), phone); },
        async () => { const phone = someone(); await ok('/api/table/defer/cancel', asPhone(phone), phone); },
        async () => { await ok(staff(f, '/api/staff/move'), { personId: someone().personId, toIndex: Math.floor(r() * 4) }); },
        async () => { await ok(staff(f, '/api/staff/bonus'), { personId: someone().personId, level: Math.floor(r() * 7) - 3 }); },
        async () => { const rotation = r() < 0.5; await ok(staff(f, '/api/staff/settings'), { tableRotation: rotation, weightedTables: rotation && r() < 0.5 }); },
        async () => {
          const phone = someone();
          await ok('/api/table/battle/propose', asPhone(phone, { songs: battleSongs, proposerChoice: battleSongs[0].songId }), phone);
          for (const voter of phones) if (r() < 0.5) await ok('/api/table/battle/vote', asPhone(voter, { choice: pick([81001, 81002, 'none']) }), voter);
        },
        async () => { await ok(staff(f, '/api/staff/remove'), { personId: someone().personId }); },
        async () => { clock += pick([1000, 60000, 10 * 60000, 31 * 60000]); },
      ];
      for (let i = 0; i < 4; i++) phones.push(await eventPhone(f, tb, secret, `Invité ${next++}`));
      for (let step = 0; step < 60; step++) {
        const viewers = [someone(), someone()];
        const read = async () => [
          ...(await Promise.all(viewers.map(async phone => (await poll(f, phone)).text))),
          (await get(f, staff(f, '/api/staff/state'))).text];
        await read(); // prévisions gardées avant l'action
        const action = Math.floor(r() * steps.length);
        try { await steps[action](); } catch (_) { /* action refusée : on compare quand même */ }
        // Échéances du vote Battle, comme le tour de 2 s du serveur : lire la
        // page ne doit pas les faire passer entre les deux lectures comparées.
        f.battleVote.tick();
        const cached = await read();
        assert.deepEqual(cached, await uncached(f.sched, read), `graine ${seed}, pas ${step} (action ${action}) : réponse servie par la prévision gardée différente du calcul complet`);
        compared++;
      }
    }
    assert.equal(compared, 180);
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
