'use strict';
// Retours du 4 octobre, côté serveur : accès solo (QR compté à l'ouverture,
// prénom obligatoire, récupération par le QR personnel), événement privé (un
// seul QR pour tout le monde), dernière activité des personnes et QR de table
// partagé depuis un téléphone.
//
// Regression: retours de la soirée du 4 octobre — QR solo expiré avant la
// saisie du prénom, solo qui perd sa page (neuf transferts par le bar).
//
// Même harnais que server-table-routes.test.js : server.js chargé dans un bac
// à sable `vm`, sans port, disque en mémoire, faux magasin de soirée.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fromServer = createRequire(path.join(root, 'server.js'));

function memoryDisk() {
  const disk = new Map();
  const inMemory = file => [path.join(root, 'data'), path.join(root, 'journal')]
    .some(dir => file === dir || String(file).startsWith(dir + path.sep));
  const missing = file => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  const memFs = { ...fs,
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
  return { disk, memFs };
}

function fakeNightStore() {
  const control = { saves: [], fail: null };
  class Store {
    load() { return null; }
    save(snapshot) {
      if (control.fail) throw new Error(control.fail);
      control.saves.push(JSON.parse(JSON.stringify(snapshot)));
      return true;
    }
  }
  return { control, Store };
}

function harness({ persistent = false } = {}) {
  const entry = source.lastIndexOf('main().catch(');
  assert.ok(entry > 0, 'point d’entrée du serveur introuvable');
  const memory = memoryDisk();
  const night = fakeNightStore();
  const overrides = persistent ? {
    './night-state': { ...fromServer('./night-state'), NightStateStore: night.Store },
    './scheduler': (() => {
      const real = fromServer('./scheduler');
      return { ...real, Scheduler: class extends real.Scheduler { constructor(o) { super({ ...o, solverEnabled: false }); } } };
    })(),
    './spotify': (() => {
      const real = fromServer('./spotify');
      return { ...real, SpotifyLink: class extends real.SpotifyLink { constructor(o) { super({ ...o, file: null }); } } };
    })(),
  } : {};
  const fixtureProcess = Object.create(process);
  fixtureProcess.argv = [process.argv[0], path.join(root, 'server.js'), ...(persistent ? [] : ['--demo'])];
  const context = { require: name => name === 'fs' ? memory.memFs : overrides[name] || fromServer(name),
    __dirname: root, process: fixtureProcess, console: { ...console, log() {} }, Buffer, URL, setTimeout, clearTimeout,
    setImmediate, AbortSignal };
  vm.runInNewContext(source.slice(0, entry) + `
    globalThis.fixture = { sched, settings, access, soloInvitations, privateEvent, staffState, journal,
      ensureSoloGroup, clearEvening, battleElectorate, saveNight, STAFF_KEY, PORT, PUBLIC_PORT,
      handle: server.listeners('request')[0] };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  f.journal.start({});
  return Object.assign(f, { night: night.control });
}

function call(f, method, url, { body, cookie, headers = {}, port = f.PORT } = {}) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers: { ...headers, ...(cookie ? { cookie } : {}) },
      socket: { remoteAddress: '127.0.0.1', localPort: port }, destroy() {} });
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
const plain = value => JSON.parse(JSON.stringify(value));
const song = (songId, title) => ({ songId, title, artist: 'Artiste' });
const events = (f, type) => f.journal.current.events.filter(e => !type || e.ev === type);

function openSolo(f) {
  f.ensureSoloGroup();
  const tb = { table: 'Comptoir', access: f.access.get('Comptoir') };
  return { tb, invite: () => f.soloInvitations.issue('Comptoir').token };
}
function openTable(f, id, headcount = 4) {
  f.sched.table(id).headcount = headcount;
  return { table: id, access: f.access.issue(id) };
}
async function opened(f, tb, invitation, cookie) {
  const r = await post(f, '/api/table/solo/open', { ...tb, invitation }, { cookie });
  assert.equal(r.status, 200, r.text);
  return { ...tb, personId: r.body.id, token: r.body.token, cookie: cookieOf(r) || cookie, body: r.body };
}
const stateOf = (f, tb, me, extra = {}) => get(f, `/api/state?table=${encodeURIComponent(tb.table)}&access=${tb.access}`,
  { cookie: me?.cookie, headers: { 'x-person-tokens': JSON.stringify(me ? [me.token] : []), ...extra } });

// ---------------------------------------------------------------- A1 : le QR individuel compte à l'ouverture
test('QR individuel : l’ouverture crée la personne « Solo 1 » avec prénom obligatoire, idempotente, sans journal', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const token = invite();
  // Une lecture d'état (aperçu de lien, page chargée) ne crée personne.
  const preview = await get(f, `/api/state?table=Comptoir&access=${tb.access}&invitation=${token}`);
  assert.equal(preview.body.soloInvitationReady, true);
  assert.equal(f.sched.people.size, 0, 'un aperçu de lien ne crée personne');

  const sam = await opened(f, tb, token);
  assert.deepEqual(Object.keys(sam.body).sort(), ['id', 'nameRequired', 'token']);
  assert.equal(sam.body.nameRequired, true);
  assert.ok(sam.cookie, 'le téléphone reçoit son identité solo');
  const person = f.sched.people.get(sam.personId);
  assert.equal(person.name, 'Solo 1');
  assert.equal(person.nameRequired, true);
  assert.equal(person.soloKeyHash, crypto.createHash('sha256').update(token).digest('hex'),
    'le QR individuel devient la clé personnelle (empreinte seulement)');
  assert.equal(f.soloInvitations.verify(token, 'Comptoir'), null, 'invitation consommée dès l’ouverture');
  assert.deepEqual(events(f, 'person.joined'), [], 'une ouverture sans prénom n’est pas une inscription');

  // Même téléphone qui rouvre le même QR : la même personne, rien de créé.
  const again = await opened(f, tb, token, sam.cookie);
  assert.equal(again.personId, sam.personId);
  assert.equal(again.token, sam.token);
  assert.equal(again.body.nameRequired, true);
  assert.equal(f.sched.people.size, 1);

  // La page de cette personne sait qu'il faut un prénom.
  const view = (await stateOf(f, tb, sam)).body;
  assert.deepEqual(view.managedIds, [sam.personId]);
  assert.equal(view.me.nameRequired, true);
  assert.equal(view.tablePeople[0].nameRequired, true);
  // Le bar la voit dès l'ouverture, avec la mention à afficher.
  const row = plain(f.staffState()).people.find(p => p.id === sam.personId);
  assert.equal(row.nameRequired, true);
  assert.equal(row.joinedAt, person.joinedAt);

  // Une deuxième personne prend le plus petit numéro libre.
  const second = await opened(f, tb, invite());
  assert.equal(f.sched.people.get(second.personId).name, 'Solo 2');
  f.sched.people.get(sam.personId).name = 'Anna';
  const third = await opened(f, tb, invite());
  assert.equal(f.sched.people.get(third.personId).name, 'Solo 1', 'numéro libéré réutilisé');
});

test('prénom obligatoire : titres, duos et Battle refusés, exclue des votants et des partenaires, puis prénom', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  const body = extra => ({ ...tb, personId: sam.personId, token: sam.token, ...extra });
  const refused = async (route, extra) => {
    const r = await post(f, route, body(extra), { cookie: sam.cookie });
    assert.equal(r.status, 400, `${route} : ${r.text}`);
    assert.equal(r.body.code, 'NAME_REQUIRED');
    assert.equal(r.body.error, 'Indique d’abord ton prénom.');
  };
  await refused('/api/table/song', { song: song(1, 'Sans prénom') });
  await refused('/api/table/duet', { partnerId: 'x', song: song(2, 'Duo') });
  await refused('/api/table/duet/answer', { accept: true, entryId: 'x' });
  await refused('/api/table/duet/join', { ownerId: 'x', entryId: 'x' });
  await refused('/api/table/duet/join/answer', { accept: true, entryId: 'x', fromId: 'x' });
  await refused('/api/table/battle/propose', { songs: [song(3, 'B')] });
  await refused('/api/table/battle/vote', { choice: 1 });
  // Refuser un duo reste possible : ce n'est pas une participation.
  const decline = await post(f, '/api/table/duet/answer', body({ accept: false, entryId: 'x' }), { cookie: sam.cookie });
  assert.notEqual(decline.body.code, 'NAME_REQUIRED');
  // Ancienne API par jeton : même règle.
  for (const [route, extra] of [['/api/song', { song: song(4, 'Ancienne') }], ['/api/duet', { partnerId: 'x', song: song(5, 'D') }],
    ['/api/duet/answer', { accept: true, entryId: 'x' }]]) {
    const r = await post(f, route, { token: sam.token, ...extra }, { cookie: sam.cookie });
    assert.equal(r.body.code, 'NAME_REQUIRED', route);
  }
  assert.equal(f.sched.songsOf(f.sched.people.get(sam.personId)).length, 0);

  // Exclue de l'électorat Battle et de la liste des partenaires de duo.
  const tableTb = openTable(f, '4');
  const lea = await post(f, '/api/table/person', { ...tableTb, name: 'Léa' });
  assert.deepEqual(plain(f.battleElectorate()), [lea.body.id]);
  const partners = await get(f, `/api/duo/partners?table=4&access=${tableTb.access}`);
  assert.deepEqual(partners.body.map(p => p.name), ['Léa']);

  // Prénom déjà pris : le drapeau reste.
  const taken = await post(f, '/api/table/person/rename', body({ name: 'Léa' }), { cookie: sam.cookie });
  assert.equal(taken.status, 200, 'Léa est à une autre table : prénom libre ici');
  f.sched.people.get(sam.personId).nameRequired = true; // remis pour la suite du test
  f.sched.people.get(sam.personId).name = 'Solo 1';
  const other = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...tb, personId: other.personId, token: other.token, name: 'Zoé' }, { cookie: other.cookie });
  const duplicate = await post(f, '/api/table/person/rename', body({ name: 'zoé' }), { cookie: sam.cookie });
  assert.equal(duplicate.body.code, 'NAME_TAKEN');
  assert.equal(f.sched.people.get(sam.personId).nameRequired, true, 'un prénom refusé garde la fenêtre');

  // Premier vrai prénom : drapeau effacé, inscription notée au journal à ce moment.
  const before = events(f, 'person.joined').length;
  const named = await post(f, '/api/table/person/rename', body({ name: 'Sam' }), { cookie: sam.cookie });
  assert.equal(named.status, 200, named.text);
  const person = f.sched.people.get(sam.personId);
  assert.equal(person.name, 'Sam');
  assert.equal(person.nameRequired, undefined);
  const joined = events(f, 'person.joined').slice(before);
  assert.deepEqual(joined.map(e => [e.personId, e.tableId]), [[sam.personId, 'Comptoir']]);
  assert.equal(f.journal.current.meta.roster[sam.personId].name, 'Sam');
  assert.equal(events(f, 'person.renamed').filter(e => e.personId === sam.personId).length, 0,
    'le premier prénom n’est pas un changement de prénom');
  // Un prénom identique au provisoire est accepté tel quel.
  const keep = await opened(f, tb, invite());
  const kept = await post(f, '/api/table/person/rename', { ...tb, personId: keep.personId, token: keep.token,
    name: f.sched.people.get(keep.personId).name }, { cookie: keep.cookie });
  assert.equal(kept.status, 200);
  assert.equal(f.sched.people.get(keep.personId).nameRequired, undefined);
  await post(f, '/api/table/song', body({ song: song(6, 'Enfin') }), { cookie: sam.cookie });
  assert.equal(f.sched.songsOf(person).length, 1, 'une fois nommée, elle choisit ses titres');
  assert.ok(plain(f.battleElectorate()).includes(sam.personId));
});

test('journal : une ouverture abandonnée ne laisse aucun événement, même marquée partie', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  // Lecture d'état visible ou non : pas de « person.seen » pour une personne sans prénom.
  await stateOf(f, tb, sam, { 'x-page-visible': '1' });
  const leave = await post(f, staff(f, '/api/staff/person/leave'), { personId: sam.personId });
  assert.equal(leave.status, 200, leave.text);
  assert.deepEqual(events(f).filter(e => e.personId === sam.personId), []);
  assert.equal(f.journal.current.meta.roster[sam.personId], undefined, 'son prénom provisoire n’entre pas au journal');
});

test('QR individuel : refus inchangés (téléphone déjà solo, invitation expirée, autre groupe)', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  const second = await post(f, '/api/table/solo/open', { ...tb, invitation: invite() }, { cookie: sam.cookie });
  assert.equal(second.status, 403);
  assert.equal(second.body.code, 'SOLO_DEVICE_USED');

  const late = invite();
  f.soloInvitations.verify(late, 'Comptoir').expiresAt = Date.now() - 1;
  const expired = await post(f, '/api/table/solo/open', { ...tb, invitation: late });
  assert.equal(expired.status, 403);
  assert.equal(expired.body.code, 'SOLO_INVITATION');
  assert.equal(expired.body.error, 'Cette invitation a déjà été utilisée ou a expiré. Demande un nouveau QR individuel au bar.');
  const garbage = await post(f, '/api/table/solo/open', { ...tb, invitation: 'pas-un-jeton' });
  assert.equal(garbage.body.code, 'SOLO_INVITATION');

  const table = openTable(f, '2');
  const wrong = await post(f, '/api/table/solo/open', { ...table, invitation: invite() });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, 'Ce QR individuel ne sert que pour « En solo ».');
  assert.equal(f.sched.people.size, 1);

  // Ouverte avant l'expiration, la personne garde sa fenêtre de prénom ensuite.
  f.soloInvitations.clear();
  const reopen = await opened(f, tb, 'x'.repeat(32), sam.cookie).catch(error => error);
  assert.ok(reopen instanceof Error, 'un autre jeton inconnu reste refusé');
  const named = await post(f, '/api/table/person/rename', { ...tb, personId: sam.personId, token: sam.token, name: 'Sam' },
    { cookie: sam.cookie });
  assert.equal(named.status, 200, '30 min plus tard, le prénom se donne encore');
});

test('QR individuel : sauvegarde impossible = rien de créé, invitation intacte, pas de cookie', async () => {
  const f = harness({ persistent: true });
  const { tb, invite } = openSolo(f);
  const token = invite();
  f.night.fail = 'disque plein';
  const r = await post(f, '/api/table/solo/open', { ...tb, invitation: token });
  assert.equal(r.status, 400);
  assert.equal(f.sched.people.size, 0);
  assert.equal(r.headers['set-cookie'], undefined);
  assert.ok(f.soloInvitations.verify(token, 'Comptoir'), 'le QR reste utilisable');
  f.night.fail = null;
  const ok = await opened(f, tb, token);
  assert.equal(f.night.saves.at(-1).scheduler.people.find(p => p.id === ok.personId).nameRequired, true,
    'personne provisoire sauvegardée avec son drapeau');
});

// ---------------------------------------------------------------- A2 : récupération par le QR personnel
test('QR personnel rouvert ailleurs : même personne proposée, récupération par la clé, l’ancien téléphone perd l’accès', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const token = invite();
  const first = await opened(f, tb, token);
  await post(f, '/api/table/person/rename', { ...tb, personId: first.personId, token: first.token, name: 'Clara' },
    { cookie: first.cookie });

  // Autre navigateur (scanner intégré, onglet privé…) : rien de créé, une proposition.
  const elsewhere = await post(f, '/api/table/solo/open', { ...tb, invitation: token });
  assert.equal(elsewhere.status, 200, elsewhere.text);
  assert.deepEqual(elsewhere.body, { recover: { id: first.personId, name: 'Clara' } });
  assert.equal(elsewhere.headers['set-cookie'], undefined, 'pas de cookie avant la confirmation');
  assert.equal(f.sched.people.size, 1);

  // Confirmation : même effet qu'une reprise par le bar.
  const claimed = await post(f, '/api/table/person/claim', { ...tb, key: token });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.id, first.personId);
  assert.notEqual(claimed.body.token, first.token);
  const next = { ...tb, personId: first.personId, token: claimed.body.token, cookie: cookieOf(claimed) };
  assert.ok(next.cookie && next.cookie !== first.cookie);
  assert.equal(f.sched.people.size, 1, 'jamais une deuxième place');
  assert.deepEqual((await stateOf(f, tb, next)).body.managedIds, [first.personId]);
  assert.deepEqual((await stateOf(f, tb, first)).body.managedIds, [], 'l’ancien téléphone perd l’accès');
  assert.ok(events(f, 'person.transferred').some(e => e.personId === first.personId));
  assert.ok(f.sched.people.get(first.personId).lastActionAt > 0, 'une récupération compte comme activité');

  // L'ancien téléphone rouvre son QR : proposition de récupération, pas de retour silencieux.
  const oldPhone = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: first.cookie });
  assert.deepEqual(oldPhone.body, { recover: { id: first.personId, name: 'Clara' } });
  // Le nouveau téléphone le rouvre : sa personne, sans rien changer.
  const same = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: next.cookie });
  assert.deepEqual([same.body.id, same.body.token, same.body.nameRequired], [first.personId, next.token, false]);

  // Un téléphone qui gère déjà un autre solo ne prend pas Clara.
  const bob = await opened(f, tb, invite());
  const bobTakes = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: bob.cookie });
  assert.equal(bobTakes.body.code, 'SOLO_DEVICE_USED');
  const bobClaims = await post(f, '/api/table/person/claim', { ...tb, key: token }, { cookie: bob.cookie });
  assert.equal(bobClaims.body.code, 'SOLO_DEVICE_USED');

  // Clé inconnue ou mal formée.
  for (const key of ['x'.repeat(32), 'court', 42]) {
    const bad = await post(f, '/api/table/person/claim', { ...tb, key });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'Ce QR personnel n’est plus valable. Demande au bar un QR de reprise.');
  }

  // Marquée partie : la clé ne sert plus ; une nouvelle soirée l'efface aussi.
  await post(f, staff(f, '/api/staff/person/leave'), { personId: first.personId });
  const gone = await post(f, '/api/table/solo/open', { ...tb, invitation: token });
  assert.equal(gone.body.code, 'SOLO_INVITATION');
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, key: token })).status, 400);
});

test('QR personnel d’une personne encore sans prénom : récupérée sans confirmation', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const token = invite();
  const first = await opened(f, tb, token);
  const second = await post(f, '/api/table/solo/open', { ...tb, invitation: token });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.id, first.personId);
  assert.equal(second.body.nameRequired, true);
  assert.equal(second.body.recovered, true);
  assert.notEqual(second.body.token, first.token);
  assert.ok(cookieOf(second) && cookieOf(second) !== first.cookie);
  assert.equal(f.sched.people.size, 1);
  assert.deepEqual((await stateOf(f, tb, first)).body.managedIds, []);
  assert.deepEqual(events(f, 'person.transferred'), [], 'personne sans prénom : rien au journal');
});

test('inscription par l’ancien formulaire : le QR devient aussi la clé personnelle', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const token = invite();
  const joined = await post(f, '/api/join', { ...tb, name: 'Nina', invitation: token });
  assert.equal(joined.status, 200, joined.text);
  const person = f.sched.people.get(joined.body.id);
  assert.equal(person.nameRequired, undefined);
  assert.ok(person.soloKeyHash);
  const elsewhere = await post(f, '/api/table/solo/open', { ...tb, invitation: token });
  assert.deepEqual(elsewhere.body, { recover: { id: joined.body.id, name: 'Nina' } });
});

// ---------------------------------------------------------------- B : événement privé
test('événement privé : interrupteur du bar, QR unique, même navigateur = même chanteur, autre = nouveau', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const fresh = 'A'.repeat(22);
  // Mode coupé : le QR est refusé.
  const refused = await post(f, '/api/table/enter', { ...tb, event: fresh });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'PRIVATE_EVENT');
  assert.equal(refused.body.error, 'Ce QR d’événement n’est plus actif. Demande au bar.');
  assert.deepEqual(plain(f.staffState().privateEvent), { enabled: false, url: null, qrUrl: null });
  assert.equal((await get(f, staff(f, '/qr-evenement.svg'))).status, 404, 'pas de QR tant que le mode est coupé');

  // Réservé au bar, jamais sur la prise publique.
  assert.equal((await post(f, '/api/staff/private-event', { enabled: true })).status, 403);
  assert.equal((await post(f, staff(f, '/api/staff/private-event'), { enabled: true }, { port: f.PUBLIC_PORT })).status, 403);
  assert.equal((await post(f, staff(f, '/api/staff/private-event'), { enabled: 'oui' })).status, 400);
  const rotateOff = await post(f, staff(f, '/api/staff/private-event'), { rotate: true });
  assert.equal(rotateOff.body.error, 'Active d’abord l’événement privé.');

  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.body.enabled, true);
  assert.equal(on.body.qrUrl, '/qr-evenement.svg');
  const url = new URL(on.body.url);
  assert.equal(url.pathname, `/t/Comptoir/${tb.access}`);
  const secret = url.searchParams.get('evenement');
  assert.match(secret, /^[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(plain(f.staffState().privateEvent), plain(on.body));
  assert.ok(!JSON.stringify(plain(f.staffState().settings)).includes(secret), 'le secret n’est pas un réglage');
  const changed = events(f, 'settings.changed').filter(e => e.setting === 'privateEvent');
  assert.deepEqual(changed.map(e => [e.from, e.to]), [[false, true]]);
  assert.ok(!JSON.stringify(f.journal.current).includes(secret), 'jamais le secret au journal');
  const svg = await get(f, staff(f, '/qr-evenement.svg'));
  assert.equal(svg.status, 200);
  assert.match(svg.text, /<svg/);
  assert.equal((await get(f, '/qr-evenement.svg')).status, 403, 'QR réservé au bar');

  // L'état de la page dit si le QR est valable ; une lecture ne crée personne.
  const ready = await get(f, `/api/state?table=Comptoir&access=${tb.access}&evenement=${secret}`);
  assert.equal(ready.body.privateEventReady, true);
  assert.equal((await get(f, `/api/state?table=Comptoir&access=${tb.access}&evenement=${fresh}`)).body.privateEventReady, false);
  assert.ok(!ready.text.includes(secret), 'la page ne reçoit pas le secret');
  assert.equal(f.sched.people.size, 0);

  // Premier scan : chanteur provisoire, prénom obligatoire.
  const a = await post(f, '/api/table/enter', { ...tb, event: secret });
  assert.equal(a.status, 200, a.text);
  assert.deepEqual(Object.keys(a.body).sort(), ['id', 'nameRequired', 'token']);
  const pa = f.sched.people.get(a.body.id);
  assert.equal(pa.name, 'Solo 1');
  assert.equal(pa.nameRequired, true);
  assert.equal(pa.viaEvent, true);
  assert.equal(pa.soloKeyHash, undefined, 'pas de clé personnelle par l’événement');
  const aCookie = cookieOf(a);
  // Même navigateur qui rescanne : son chanteur revient.
  const again = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: aCookie });
  assert.deepEqual([again.body.id, again.body.token, again.body.resumed], [a.body.id, a.body.token, true]);
  assert.equal(f.sched.people.size, 1);
  // Autre navigateur : toujours un nouveau chanteur (décision D1).
  const b = await post(f, '/api/table/enter', { ...tb, event: secret });
  assert.notEqual(b.body.id, a.body.id);
  assert.equal(f.sched.people.get(b.body.id).name, 'Solo 2');
  // Chaque participant ne voit que lui-même.
  const view = (await stateOf(f, tb, { token: a.body.token, cookie: aCookie })).body;
  assert.deepEqual(view.tablePeople.map(p => p.id), [a.body.id]);
  assert.notEqual(f.sched.people.get(a.body.id).group, f.sched.people.get(b.body.id).group, 'chacun son tour');
  // Prénom déjà pris : consigne d'ajouter une initiale côté page.
  await post(f, '/api/table/person/rename', { ...tb, personId: a.body.id, token: a.body.token, name: 'Marie' }, { cookie: aCookie });
  const dup = await post(f, '/api/table/person/rename', { ...tb, personId: b.body.id, token: b.body.token, name: 'Marie' },
    { cookie: cookieOf(b) });
  assert.equal(dup.body.code, 'NAME_TAKEN');
  // Les invitations individuelles fonctionnent toujours pendant l'événement.
  const solo = await opened(f, tb, f.soloInvitations.issue('Comptoir').token);
  assert.ok(solo.personId);

  // Renouveler : l'ancien QR est refusé, les inscrits gardent leur accès.
  const rotated = await post(f, staff(f, '/api/staff/private-event'), { rotate: true });
  const next = new URL(rotated.body.url).searchParams.get('evenement');
  assert.notEqual(next, secret);
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret })).body.code, 'PRIVATE_EVENT');
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: next }, { cookie: aCookie })).body.id, a.body.id);
  assert.equal((await post(f, '/api/table/song', { ...tb, personId: a.body.id, token: a.body.token, song: song(7, 'Encore') },
    { cookie: aCookie })).status, 200);

  // Marquée partie : le même navigateur ne la recrée pas, le bar la réactive.
  await post(f, staff(f, '/api/staff/person/leave'), { personId: a.body.id });
  const left = await post(f, '/api/table/enter', { ...tb, event: next }, { cookie: aCookie });
  assert.equal(left.body.code, 'PERSON_LEFT');

  // Couper : QR refusé, secret gardé pour le rallumer.
  await post(f, staff(f, '/api/staff/private-event'), { enabled: false });
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: next })).status, 403);
  assert.equal(new URL((await post(f, staff(f, '/api/staff/private-event'), { enabled: true })).body.url)
    .searchParams.get('evenement'), next, 'couper puis rallumer garde le QR imprimé');

  // Pas pour une table ordinaire.
  const table = openTable(f, '3');
  assert.equal((await post(f, '/api/table/enter', { ...table, event: next })).body.code, 'PRIVATE_EVENT');

  // « Supprimer toutes les tables » coupe le mode et efface le secret.
  f.clearEvening();
  assert.equal(f.privateEvent.enabled, false);
  assert.equal(f.privateEvent.secret, null);
  assert.deepEqual(plain(f.staffState().privateEvent), { enabled: false, url: null, qrUrl: null });
});

test('événement privé : plafond de créations, sauvegarde impossible annulée, sauvegarde de la soirée', async () => {
  const f = harness({ persistent: true });
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  f.night.fail = 'disque plein';
  const failed = await post(f, '/api/table/enter', { ...tb, event: secret });
  assert.equal(failed.status, 400);
  assert.equal(f.sched.people.size, 0);
  assert.equal(failed.headers['set-cookie'], undefined);
  f.night.fail = null;
  for (let i = 0; i < 30; i++) assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret })).status, 200);
  const busy = await post(f, '/api/table/enter', { ...tb, event: secret });
  assert.equal(busy.body.code, 'PRIVATE_EVENT_BUSY');
  assert.equal(busy.body.error, 'Trop d’inscriptions d’un coup : réessaie dans une minute.');
  assert.equal(f.sched.people.size, 30);
  const saved = f.night.saves.at(-1);
  assert.deepEqual(Object.keys(saved.privateEvent).sort(), ['enabled', 'secret', 'since']);
  assert.equal(saved.privateEvent.enabled, true);
  assert.equal(saved.scheduler.people.filter(p => p.viaEvent && p.nameRequired).length, 30);
});

test('sauvegarde de la soirée : événement privé et champs des personnes repris, formes abîmées tolérées', () => {
  const { Scheduler } = require('../scheduler');
  const { TableAccess } = require('../table-access');
  const { SoloInvitations } = require('../solo-invitations');
  const { PrivateEvent } = require('../private-event');
  const { snapshotNight, restoreNight } = require('../night-state');
  const sched = new Scheduler({ solverEnabled: false });
  const access = new TableAccess();
  const comptoir = sched.table('Comptoir');
  access.issue(comptoir.id);
  const p = sched.join({ tableId: 'Comptoir', name: 'Solo 1', nameRequired: true });
  p.soloKeyHash = 'a'.repeat(64);
  p.lastActionAt = 123;
  p.viaEvent = true;
  const privateEvent = new PrivateEvent();
  const secret = privateEvent.enable();
  const settings = () => ({ auto: false, autoPlay: false, baseUrl: null, pushDelaySec: 45, playDelaySec: 8 });
  const snapshot = JSON.parse(JSON.stringify(snapshotNight({ scheduler: sched, access, settings: settings(),
    soloInvitations: new SoloInvitations(), privateEvent })));
  const restore = snap => {
    const target = new Scheduler({ solverEnabled: false });
    const result = restoreNight(snap, { scheduler: target, access: new TableAccess(), settings: settings() });
    return { result, person: target.people.get(p.id) };
  };
  const { result, person } = restore(snapshot);
  assert.equal(new PrivateEvent(result.privateEvent).verify(secret), true, 'un redémarrage garde le QR de l’événement');
  assert.equal(person.nameRequired, true);
  assert.equal(person.soloKeyHash, 'a'.repeat(64));
  assert.equal(person.lastActionAt, 123);
  assert.equal(person.viaEvent, true);
  // Ancienne sauvegarde sans ces champs, ou champs abîmés : jamais d'échec de la soirée.
  const old = JSON.parse(JSON.stringify(snapshot));
  delete old.privateEvent;
  assert.equal(restore(old).result.privateEvent, null);
  const broken = JSON.parse(JSON.stringify(snapshot));
  broken.privateEvent = { enabled: true, secret: 'abîmé', since: 1 };
  Object.assign(broken.scheduler.people[0], { nameRequired: 'oui', soloKeyHash: 'zz', lastActionAt: 'hier', viaEvent: 1 });
  const fixed = restore(broken);
  assert.equal(fixed.result.privateEvent, null, 'forme abîmée : mode coupé');
  for (const field of ['nameRequired', 'soloKeyHash', 'lastActionAt', 'viaEvent']) {
    assert.equal(fixed.person[field], undefined, `${field} abîmé : ignoré`);
  }
});

// ---------------------------------------------------------------- C : dernière activité
test('activité : seule une page visible compte, pour toutes les personnes du téléphone ; actions comptées, accusé non', async () => {
  const f = harness();
  const tb = openTable(f, '5');
  const ana = await post(f, '/api/table/person', { ...tb, name: 'Ana' });
  const ben = await post(f, '/api/table/person', { ...tb, name: 'Ben' });
  const people = [ana, ben].map(r => f.sched.people.get(r.body.id));
  const old = Date.now() - 30 * 60000;
  for (const p of people) { p.lastSeen = old; delete p.lastActionAt; }
  const poll = headers => get(f, `/api/state?table=5&access=${tb.access}`,
    { headers: { 'x-person-tokens': JSON.stringify(people.map(p => p.token)), ...headers } });
  await poll({});
  assert.deepEqual(people.map(p => p.lastSeen), [old, old], 'page cachée : rien ne bouge');
  await poll({ 'x-page-visible': '0' });
  assert.deepEqual(people.map(p => p.lastSeen), [old, old]);
  await poll({ 'x-page-visible': '1' });
  assert.ok(people.every(p => p.lastSeen > old), 'page visible : toutes les personnes du téléphone');
  // Au plus une fois par minute.
  const seen = people.map(p => p.lastSeen - 1000);
  people.forEach((p, i) => { p.lastSeen = seen[i]; });
  await poll({ 'x-page-visible': '1' });
  assert.deepEqual(people.map(p => p.lastSeen), seen);
  // Sans jeton valable : rien.
  people[0].lastSeen = old;
  await get(f, `/api/state?table=5&access=${tb.access}`, { headers: { 'x-page-visible': '1' } });
  assert.equal(people[0].lastSeen, old);
  // Ancienne lecture par jeton seul : même règle.
  await get(f, `/api/state?token=${people[0].token}`);
  assert.equal(people[0].lastSeen, old);
  await get(f, `/api/state?token=${people[0].token}`, { headers: { 'x-page-visible': '1' } });
  assert.ok(people[0].lastSeen > old);

  // L'accusé automatique des messages n'est pas une action.
  const body = { ...tb, personId: people[0].id, token: people[0].token };
  await post(f, '/api/table/notice/ack', { ...body, ids: [] });
  assert.equal(people[0].lastActionAt, undefined);
  await post(f, '/api/table/confirm', body);
  assert.ok(people[0].lastActionAt > 0, 'confirmation de présence = action');
  delete people[0].lastActionAt;
  await post(f, '/api/confirm', { token: people[0].token });
  assert.ok(people[0].lastActionAt > 0, 'ancienne API par jeton : action aussi');

  // Bar : dernière activité = la plus récente des deux, heure du serveur fournie.
  people[1].lastSeen = 1000; people[1].lastActionAt = 5000;
  const state = plain(f.staffState());
  assert.equal(state.people.find(p => p.id === people[1].id).lastActiveAt, 5000);
  people[1].lastActionAt = 10;
  assert.equal(plain(f.staffState()).people.find(p => p.id === people[1].id).lastActiveAt, 1000);
  assert.ok(Number.isFinite(state.now));
  // Jamais dans l'état des téléphones.
  const phone = (await poll({})).text;
  assert.ok(!/lastActiveAt|lastActionAt|lastSeen/.test(phone));
});

test('activité solo : page visible avec le cookie du téléphone', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  const p = f.sched.people.get(sam.personId);
  p.lastSeen = 1;
  await stateOf(f, tb, { token: sam.token }, { 'x-page-visible': '1' });
  assert.equal(p.lastSeen, 1, 'sans le cookie du téléphone : rien');
  await stateOf(f, tb, sam, { 'x-page-visible': '1' });
  assert.ok(p.lastSeen > 1);
  const again = await post(f, '/api/table/solo/open', { ...tb, invitation: 'x'.repeat(32) }, { cookie: sam.cookie });
  assert.equal(again.status, 403);
});

// ---------------------------------------------------------------- D1 : faire scanner sa table
test('QR de table pour le téléphone : même lien que le QR imprimé, pas pour « En solo »', async () => {
  const f = harness();
  const tb = openTable(f, '6');
  const r = await get(f, `/api/table/invite?table=6&access=${tb.access}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.url, f.access.url(`http://${new URL(r.body.url).host}`, '6'));
  assert.match(r.body.qr, /^data:image\/png;base64,/);
  assert.equal(new URL(plain(f.staffState()).tables.find(t => t.id === '6').url).href, r.body.url);
  const bad = await get(f, `/api/table/invite?table=6&access=${'x'.repeat(22)}`);
  assert.equal(bad.status, 403);
  const { tb: solo } = openSolo(f);
  const soloInvite = await get(f, `/api/table/invite?table=Comptoir&access=${solo.access}`);
  assert.equal(soloInvite.status, 400);
  assert.equal(soloInvite.body.error, 'Pas de QR à partager pour « En solo » : chacun demande son QR individuel au bar.');
  assert.equal((await get(f, '/api/table/inconnue')).status, 404);
});
