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
      ensureSoloGroup, clearEvening, battleElectorate, saveNight, journalRoster, STAFF_KEY, PORT, PUBLIC_PORT,
      handle: server.listeners('request')[0] };
  `, context, { filename: 'server.js' });
  const f = context.fixture;
  f.settings.auto = false;
  f.settings.autoPlay = false;
  f.journal.start({});
  return Object.assign(f, { night: night.control });
}

function call(f, method, url, { body, cookie, headers = {}, port = f.PORT, remote = '127.0.0.1' } = {}) {
  return new Promise(resolve => {
    const req = new EventEmitter();
    Object.assign(req, { method, url, headers: { ...headers, ...(cookie ? { cookie } : {}) },
      socket: { remoteAddress: remote, localPort: port }, destroy() {} });
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
  // Téléphone qui a déjà un prénom inscrit : un autre QR individuel est refusé
  // (une place encore sans prénom, elle, laisse la place au nouveau QR).
  const nina = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...tb, personId: nina.personId, token: nina.token, name: 'Nina' }, { cookie: nina.cookie });
  const second = await post(f, '/api/table/solo/open', { ...tb, invitation: invite() }, { cookie: nina.cookie });
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
  assert.equal(wrong.body.error, 'Ce QR individuel n’est pas valable pour cette table.');
  assert.equal(f.sched.people.size, 2);

  // Ouverte avant l'expiration, la personne garde sa fenêtre de prénom ensuite.
  f.soloInvitations.clear();
  const reopen = await post(f, '/api/table/solo/open', { ...tb, invitation: 'x'.repeat(32) }, { cookie: sam.cookie });
  assert.equal(reopen.status, 403, 'un autre jeton inconnu reste refusé');
  assert.equal(reopen.body.code, 'SOLO_INVITATION');
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

  // Un téléphone qui gère déjà un autre solo (avec son prénom) ne prend pas Clara.
  const bob = await opened(f, tb, invite());
  await post(f, '/api/table/person/rename', { ...tb, personId: bob.personId, token: bob.token, name: 'Bob' }, { cookie: bob.cookie });
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
  assert.equal(gone.body.code, 'PERSON_LEFT', 'ailleurs aussi : « marquée partie »');
  // Son propre navigateur rouvre la clé : « marquée partie », pas « invitation utilisée ».
  const mine = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: next.cookie });
  assert.equal(mine.status, 403, 'même statut que le QR de l’événement et les autres routes');
  assert.equal(mine.body.code, 'PERSON_LEFT');
  assert.equal(mine.body.error, 'Cette personne a été marquée partie. Demande au bar de la réactiver.');
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

// ---------------------------------------------------------------- doublon marqué parti
// Regression: un navigateur qui a créé un doublon (QR de l'événement rescanné
// depuis une autre application) ne pouvait plus reprendre son ancien profil,
// même après que le bar avait marqué le doublon « Parti » : la reprise
// répondait « Ce téléphone a déjà un prénom inscrit. ».
// Chaque entrée vient d'un téléphone distinct (30 créations par minute et par appareil).
let eventDevices = 0;
async function eventEntry(f, tb, secret, name, cookie) {
  const r = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie, remote: `10.1.${eventDevices >> 8 & 255}.${eventDevices++ & 255}` });
  assert.equal(r.status, 200, r.text);
  const me = { ...tb, personId: r.body.id, token: r.body.token, cookie: cookieOf(r) || cookie };
  if (name) {
    const named = await post(f, '/api/table/person/rename', { ...tb, personId: me.personId, token: me.token, name }, { cookie: me.cookie });
    assert.equal(named.status, 200, named.text);
  }
  return me;
}
const linkOf = share => new URL(share.body.url).searchParams.get('reprise');

test('doublon parti : le QR de reprise rend l’ancien profil à ce navigateur ; un doublon encore actif bloque toujours', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  // Léa s'inscrit depuis le scanner d'Instagram, puis perd sa page et
  // rescanne depuis Snapchat : un deuxième chanteur (D1).
  const lea = await eventEntry(f, tb, secret, 'Léa');
  assert.equal((await post(f, '/api/table/song', { ...lea, song: song(7, 'Ma chanson') }, { cookie: lea.cookie })).status, 200);
  const dup = await eventEntry(f, tb, secret, 'Léa B.');

  // Doublon encore actif : toujours une seule place active par navigateur.
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  const blocked = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: dup.cookie });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'SOLO_DEVICE_USED');

  // Le bar marque le doublon parti : la reprise passe.
  assert.equal((await post(f, staff(f, '/api/staff/person/leave'), { personId: dup.personId })).status, 200);
  const offer = (await get(f, `/api/state?table=Comptoir&access=${tb.access}&reprise=${linkOf(share)}`,
    { cookie: dup.cookie, headers: { 'x-person-tokens': JSON.stringify([dup.token]) } })).body.transferOffer;
  assert.deepEqual(plain(offer).personId, lea.personId);
  const claimed = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: dup.cookie });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.id, lea.personId);
  const back = { ...tb, personId: lea.personId, token: claimed.body.token, cookie: cookieOf(claimed) };
  assert.ok(back.cookie && back.cookie !== dup.cookie);
  const view = (await get(f, `/api/state?table=Comptoir&access=${tb.access}`,
    { cookie: back.cookie, headers: { 'x-person-tokens': JSON.stringify([back.token, dup.token]) } })).body;
  assert.deepEqual(view.managedIds, [lea.personId], 'ses chansons reviennent, le doublon parti n’est pas géré');
  assert.deepEqual(view.tablePeople[0].songs.map(s => s.title), ['Ma chanson']);
  assert.deepEqual((await stateOf(f, tb, lea)).body.managedIds, [], 'l’ancien navigateur perd l’accès');
  // Le même navigateur rescanne le QR de l'événement : Léa, rien de créé.
  const rescan = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: back.cookie });
  assert.deepEqual([rescan.body.id, rescan.body.resumed], [lea.personId, true]);
  assert.equal(f.sched.people.size, 2);

  // Ce navigateur gère Léa (active) : il ne prend pas un troisième profil.
  const max = await eventEntry(f, tb, secret, 'Max');
  const maxShare = await post(f, staff(f, '/api/staff/person/share'), { personId: max.personId });
  const twice = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(maxShare) }, { cookie: back.cookie });
  assert.equal(twice.body.code, 'SOLO_DEVICE_USED');

  // Le bar réactive le doublon : il revient sans téléphone, jamais une
  // deuxième place active pour le navigateur de Léa.
  assert.equal((await post(f, staff(f, '/api/staff/person/reactivate'), { personId: dup.personId })).status, 200);
  assert.equal(f.sched.people.get(dup.personId).withdrawnAt, null);
  const after = (await get(f, `/api/state?table=Comptoir&access=${tb.access}`,
    { cookie: back.cookie, headers: { 'x-person-tokens': JSON.stringify([back.token, dup.token]) } })).body;
  assert.deepEqual(after.managedIds, [lea.personId]);
  const dupSong = await post(f, '/api/table/song', { ...dup, song: song(8, 'Autre') }, { cookie: back.cookie });
  assert.equal(dupSong.body.code, 'SOLO_DEVICE_ACCESS');
  // Même avec son ancien cookie (navigateur qui n'aurait pas gardé le nouveau).
  assert.deepEqual((await stateOf(f, tb, dup)).body.managedIds, [], 'le doublon réactivé n’a plus de téléphone');
  assert.equal((await post(f, '/api/table/song', { ...dup, song: song(8, 'Autre') }, { cookie: dup.cookie })).body.code, 'SOLO_DEVICE_ACCESS');
  // Le bar peut le confier à un téléphone par son propre QR de reprise.
  const dupShare = await post(f, staff(f, '/api/staff/person/share'), { personId: dup.personId });
  const handed = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(dupShare) });
  assert.equal(handed.status, 200, handed.text);
});

test('doublon parti : le QR personnel et le code à 4 chiffres reprennent l’ancien profil ; créer une place reste refusé', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const key = invite();
  const clara = await opened(f, tb, key);
  await post(f, '/api/table/person/rename', { ...tb, personId: clara.personId, token: clara.token, name: 'Clara' }, { cookie: clara.cookie });
  // Clara rescanne par erreur le QR de l'événement dans un autre navigateur.
  const dup = await eventEntry(f, tb, secret, 'Clara B.');
  assert.equal((await post(f, '/api/table/solo/open', { ...tb, invitation: key }, { cookie: dup.cookie })).body.code, 'SOLO_DEVICE_USED');
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, key }, { cookie: dup.cookie })).body.code, 'SOLO_DEVICE_USED');

  await post(f, staff(f, '/api/staff/person/leave'), { personId: dup.personId });
  // Créer une NOUVELLE place depuis ce navigateur reste refusé (inchangé).
  assert.equal((await post(f, '/api/table/solo/open', { ...tb, invitation: invite() }, { cookie: dup.cookie })).body.code, 'SOLO_DEVICE_USED');
  assert.equal((await post(f, '/api/join', { ...tb, name: 'Zoé', invitation: invite() }, { cookie: dup.cookie })).body.code, 'SOLO_DEVICE_USED');
  // Même navigateur qui rescanne l'événement : son doublon parti, pas un troisième chanteur.
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: dup.cookie })).body.code, 'PERSON_LEFT');
  assert.equal(f.sched.people.size, 2);

  // Son QR personnel : « C'est bien toi, Clara ? », puis la reprise.
  const offer = await post(f, '/api/table/solo/open', { ...tb, invitation: key }, { cookie: dup.cookie });
  assert.deepEqual(offer.body, { recover: { id: clara.personId, name: 'Clara' } });
  const claimed = await post(f, '/api/table/person/claim', { ...tb, key }, { cookie: dup.cookie });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.id, clara.personId);
  const back = { ...tb, personId: clara.personId, token: claimed.body.token, cookie: cookieOf(claimed) };
  assert.deepEqual((await stateOf(f, tb, back)).body.managedIds, [clara.personId]);
  assert.deepEqual((await stateOf(f, tb, clara)).body.managedIds, []);

  // Code à 4 chiffres, en secours : un autre doublon parti ne le cache ni ne le bloque.
  const second = await eventEntry(f, tb, secret, 'Clara C.');
  await post(f, staff(f, '/api/staff/person/leave'), { personId: second.personId });
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: clara.personId });
  const listed = (await stateOf(f, tb, second)).body.recoveryPeople;
  assert.deepEqual(plain(listed), [{ id: clara.personId, name: 'Clara' }]);
  const byCode = await post(f, '/api/table/person/claim', { ...tb, personId: clara.personId, code: share.body.code }, { cookie: second.cookie });
  assert.equal(byCode.status, 200, byCode.text);
  assert.deepEqual((await stateOf(f, tb, back)).body.managedIds, [], 'le navigateur précédent perd l’accès');
});

// Regression: en quittant sa place partie, un navigateur rendait la main au
// téléphone précédent de cette place (celui qu'un transfert avait écarté) :
// réactivée, la personne revenait sur ce vieux navigateur.
test('doublon parti : la place quittée ne revient pas au navigateur qu’un transfert avait écarté', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const takeOver = async (personId, cookie) => {
    const share = await post(f, staff(f, '/api/staff/person/share'), { personId });
    const r = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie });
    assert.equal(r.status, 200, r.text);
    return { ...tb, personId, token: r.body.token, cookie: cookieOf(r) || cookie };
  };
  for (const viaKey of [false, true]) {
    const key = viaKey ? invite() : null;
    // Bea s'inscrit sur le navigateur Z ; le bar la confie au navigateur Y.
    const z = viaKey ? await opened(f, tb, key) : await eventEntry(f, tb, secret);
    await post(f, '/api/table/person/rename', { ...tb, personId: z.personId, token: z.token, name: viaKey ? 'Bea K' : 'Bea' }, { cookie: z.cookie });
    const y = await takeOver(z.personId, undefined);
    const other = await eventEntry(f, tb, secret, viaKey ? 'Abel K' : 'Abel');
    // Bea est marquée partie ; Y reprend un autre profil (A).
    await post(f, staff(f, '/api/staff/person/leave'), { personId: z.personId });
    await takeOver(other.personId, y.cookie);
    // Le bar réactive Bea : elle revient sans téléphone, Z reste écarté.
    assert.equal((await post(f, staff(f, '/api/staff/person/reactivate'), { personId: z.personId })).status, 200);
    if (viaKey) {
      const reopened = await post(f, '/api/table/solo/open', { ...tb, invitation: key }, { cookie: z.cookie });
      assert.equal(reopened.body.token, undefined, 'clé personnelle rouverte par Z : pas de jeton direct');
      assert.deepEqual(reopened.body, { recover: { id: z.personId, name: 'Bea K' } });
    } else {
      const rescan = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: z.cookie });
      assert.notEqual(rescan.body.id, z.personId, 'QR de l’événement rescanné par Z : pas Bea');
      assert.equal(rescan.body.resumed, undefined);
    }
    assert.ok(!(await stateOf(f, tb, z)).body.managedIds.includes(z.personId), 'Z ne gère plus Bea');
    // Le bar peut toujours la confier à un téléphone.
    await takeOver(z.personId, undefined);
  }
});

test('doublon parti : sauvegarde impossible pendant la reprise = doublon et ancien profil intacts', async () => {
  const f = harness({ persistent: true });
  const { tb } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const lea = await eventEntry(f, tb, secret, 'Léa');
  const dup = await eventEntry(f, tb, secret, 'Léa B.');
  await post(f, staff(f, '/api/staff/person/leave'), { personId: dup.personId });
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  const before = plain([f.sched.people.get(lea.personId).soloDeviceHashes, f.sched.people.get(dup.personId).soloDeviceHashes]);
  f.night.fail = 'disque plein';
  const r = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: dup.cookie });
  assert.equal(r.status, 400);
  assert.deepEqual(plain([f.sched.people.get(lea.personId).soloDeviceHashes, f.sched.people.get(dup.personId).soloDeviceHashes]), before);
  assert.deepEqual((await stateOf(f, tb, lea)).body.managedIds, [lea.personId], 'Léa reste sur son navigateur');
  f.night.fail = null;
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: dup.cookie })).status, 200);
});

// Regression: relecture finale (ADV3) — un invité qui rescanne le QR de
// l'événement depuis une autre application reçoit une place « Solo N » sans
// prénom ; cette place bloquait le QR de reprise, le lien de transfert et la
// clé personnelle (SOLO_DEVICE_USED), et son propre prénom était « déjà pris ».
const placeholderGone = (f, id) => {
  assert.equal(f.sched.people.has(id), false, 'la place provisoire est retirée');
  assert.ok(!plain(f.staffState().people).some(p => p.id === id), 'pas de « Solo N » chez le bar');
  assert.ok(!JSON.stringify(f.journal.current.events).includes(id), 'aucune trace au journal');
};

test('rescan : la place sans prénom de ce navigateur ne bloque ni le QR de reprise ni le lien de transfert', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const lea = await eventEntry(f, tb, secret, 'Léa');
  assert.equal((await post(f, '/api/table/song', { ...lea, song: song(7, 'Ma chanson') }, { cookie: lea.cookie })).status, 200);
  // Rescan depuis Snapchat : « Solo 2 », prénom demandé ; « Léa » est pris.
  const rescan = await eventEntry(f, tb, secret);
  assert.equal(f.sched.people.get(rescan.personId).nameRequired, true);
  const taken = await post(f, '/api/table/person/rename', { ...rescan, name: 'Léa' }, { cookie: rescan.cookie });
  assert.equal(taken.body.code, 'NAME_TAKEN');

  // Le bar donne à Léa un QR de reprise : la page l'ouvre sur ce navigateur.
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  const offer = (await get(f, `/api/state?table=Comptoir&access=${tb.access}&reprise=${linkOf(share)}`,
    { cookie: rescan.cookie, headers: { 'x-person-tokens': JSON.stringify([rescan.token]) } })).body.transferOffer;
  assert.equal(plain(offer).personId, lea.personId);
  const claimed = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: rescan.cookie });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.id, lea.personId);
  placeholderGone(f, rescan.personId);
  const back = { ...tb, personId: lea.personId, token: claimed.body.token, cookie: cookieOf(claimed) };
  const view = (await get(f, `/api/state?table=Comptoir&access=${tb.access}`,
    { cookie: back.cookie, headers: { 'x-person-tokens': JSON.stringify([back.token, rescan.token]) } })).body;
  assert.deepEqual(view.managedIds, [lea.personId]);
  assert.deepEqual(view.tablePeople[0].songs.map(s => s.title), ['Ma chanson']);
  assert.deepEqual((await stateOf(f, tb, lea)).body.managedIds, [], 'l’ancien navigateur perd l’accès');
  // Ce navigateur rescanne encore : Léa revient, rien n'est créé.
  const again = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: back.cookie });
  assert.deepEqual([again.body.id, again.body.resumed], [lea.personId, true]);
  assert.equal(f.sched.people.size, 1);

  // Même chose par le code à 4 chiffres (même route de reprise).
  const max = await eventEntry(f, tb, secret, 'Max');
  const other = await eventEntry(f, tb, secret);
  const code = await post(f, staff(f, '/api/staff/person/share'), { personId: max.personId });
  const byCode = await post(f, '/api/table/person/claim', { ...tb, personId: max.personId, code: code.body.code }, { cookie: other.cookie });
  assert.equal(byCode.status, 200, byCode.text);
  placeholderGone(f, other.personId);

  // Une place encore sans prénom mais avec un titre (cas impossible par les
  // routes) n'est jamais effacée : la reprise reste refusée.
  const odd = await eventEntry(f, tb, secret);
  f.sched.people.get(odd.personId).backlog.push({ songId: 9, title: 'Titre', artist: 'A' });
  const kept = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, link: linkOf(kept) }, { cookie: odd.cookie })).body.code, 'SOLO_DEVICE_USED');
  assert.ok(f.sched.people.has(odd.personId));
  // Une place nommée (un vrai doublon) bloque toujours.
  const named = await eventEntry(f, tb, secret, 'Léa B.');
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, link: linkOf(kept) }, { cookie: named.cookie })).body.code, 'SOLO_DEVICE_USED');
});

test('rescan : la clé personnelle reprend son profil malgré la place sans prénom de ce navigateur', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const key = invite();
  const clara = await opened(f, tb, key);
  await post(f, '/api/table/person/rename', { ...tb, personId: clara.personId, token: clara.token, name: 'Clara' }, { cookie: clara.cookie });
  const rescan = await eventEntry(f, tb, secret);
  const offer = await post(f, '/api/table/solo/open', { ...tb, invitation: key }, { cookie: rescan.cookie });
  assert.deepEqual(offer.body, { recover: { id: clara.personId, name: 'Clara' } });
  assert.ok(f.sched.people.has(rescan.personId), 'la proposition seule ne retire rien');
  const claimed = await post(f, '/api/table/person/claim', { ...tb, key }, { cookie: rescan.cookie });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.id, clara.personId);
  placeholderGone(f, rescan.personId);
  const back = { ...tb, personId: clara.personId, token: claimed.body.token, cookie: cookieOf(claimed) };
  assert.deepEqual((await stateOf(f, tb, back)).body.managedIds, [clara.personId]);

  // Clé d'une personne encore sans prénom : reprise directe, la place provisoire part aussi.
  const key2 = invite();
  const zoe = await opened(f, tb, key2);
  const rescan2 = await eventEntry(f, tb, secret);
  const direct = await post(f, '/api/table/solo/open', { ...tb, invitation: key2 }, { cookie: rescan2.cookie });
  assert.equal(direct.status, 200, direct.text);
  assert.deepEqual([direct.body.id, direct.body.recovered, direct.body.nameRequired], [zoe.personId, true, true]);
  placeholderGone(f, rescan2.personId);
});

// Relecture finale (ADV2) : l'ancien navigateur de Léa (B1) rescanne le QR de
// l'événement après son passage sur Safari (B2), puis reprend Léa par un QR de
// reprise. Le rescan remplace le cookie de B1 (celui de la place « Solo N ») :
// la reprise retire cette place, aucun « Solo N » ne reste chez le bar.
test('rescan : l’ancien navigateur de la personne reprise retire aussi sa place sans prénom', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const lea = await eventEntry(f, tb, secret, 'Léa');
  // Léa passe sur Safari (B2) par le QR de reprise du bar.
  const toSafari = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, link: linkOf(toSafari) })).status, 200);
  // De retour dans Instagram (B1), elle rescanne le QR de l'événement.
  const rescan = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: lea.cookie, remote: '10.0.4.1' });
  assert.equal(rescan.status, 200, rescan.text);
  assert.equal(rescan.body.nameRequired, true);
  const placeholder = rescan.body.id;
  const b1 = cookieOf(rescan) || lea.cookie;
  // Le bar lui redonne un QR de reprise, scanné dans B1.
  const back = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  const claimed = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(back) }, { cookie: b1 });
  assert.equal(claimed.status, 200, claimed.text);
  assert.equal(claimed.body.id, lea.personId);
  placeholderGone(f, placeholder);
  const view = (await get(f, `/api/state?table=Comptoir&access=${tb.access}`, { cookie: cookieOf(claimed),
    headers: { 'x-person-tokens': JSON.stringify([claimed.body.token, rescan.body.token]) } })).body;
  assert.deepEqual(view.managedIds, [lea.personId]);
  assert.deepEqual(plain(f.staffState().people).map(p => p.name), ['Léa']);
});

test('rescan : sauvegarde impossible pendant la reprise = place provisoire et profil intacts', async () => {
  const f = harness({ persistent: true });
  const { tb } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const lea = await eventEntry(f, tb, secret, 'Léa', undefined);
  const rescan = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.0.9' });
  const dup = { ...tb, personId: rescan.body.id, token: rescan.body.token, cookie: cookieOf(rescan) };
  const share = await post(f, staff(f, '/api/staff/person/share'), { personId: lea.personId });
  f.night.fail = 'disque plein';
  const r = await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: dup.cookie });
  assert.equal(r.status, 400);
  assert.ok(f.sched.people.has(dup.personId), 'la place provisoire revient');
  assert.equal(f.sched.person(dup.token)?.id, dup.personId);
  assert.deepEqual((await stateOf(f, tb, dup)).body.managedIds, [dup.personId]);
  assert.deepEqual((await stateOf(f, tb, lea)).body.managedIds, [lea.personId], 'Léa reste sur son navigateur');
  f.night.fail = null;
  assert.equal((await post(f, '/api/table/person/claim', { ...tb, link: linkOf(share) }, { cookie: dup.cookie })).status, 200);
  assert.equal(f.sched.people.has(dup.personId), false);
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
  assert.equal(view.tablePeople[0].viaEvent, true, 'la page sait que son chanteur vient du QR de l’événement');
  assert.notEqual(f.sched.people.get(a.body.id).group, f.sched.people.get(b.body.id).group, 'chacun son tour');
  // Prénom déjà pris : consigne d'ajouter une initiale côté page.
  await post(f, '/api/table/person/rename', { ...tb, personId: a.body.id, token: a.body.token, name: 'Marie' }, { cookie: aCookie });
  const dup = await post(f, '/api/table/person/rename', { ...tb, personId: b.body.id, token: b.body.token, name: 'Marie' },
    { cookie: cookieOf(b) });
  assert.equal(dup.body.code, 'NAME_TAKEN');
  // Les invitations individuelles fonctionnent toujours pendant l'événement.
  const solo = await opened(f, tb, f.soloInvitations.issue('Comptoir').token);
  assert.ok(solo.personId);
  assert.equal((await stateOf(f, tb, solo)).body.tablePeople[0].viaEvent, undefined, 'QR individuel : pas venu par l’événement');

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

// Regression: relecture finale (ADV1, S2) — un plafond de 30 créations par
// minute pour tout le bar et un plafond de 400 qui comptait aussi les partis :
// un script sans cookie bloquait les vrais invités, et le 31e invité de la
// minute était refusé.
// Regression: deuxième relecture finale (ADV F1, S2-2, A2-2) — 5 par appareil
// bloquaient tout un Wi-Fi qui sort par une seule adresse publique (tunnel) ;
// le refus répondait 400 sans dire quand réessayer.
test('événement privé : 30 créations par minute et par appareil, 120 pour le bar, 429 + Retry-After, X-Forwarded-For ignoré', async () => {
  const f = harness({ persistent: true });
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const enter = (remote, headers = {}) => post(f, '/api/table/enter', { ...tb, event: secret }, { remote, headers });
  f.night.fail = 'disque plein';
  const failed = await enter('10.0.0.1');
  assert.equal(failed.status, 400);
  assert.equal(f.sched.people.size, 0);
  assert.equal(failed.headers['set-cookie'], undefined);
  f.night.fail = null;
  // Une création annulée ne compte pas : trente de plus depuis le même appareil.
  for (let i = 0; i < 30; i++) assert.equal((await enter('10.0.0.1')).status, 200);
  const busy = await enter('10.0.0.1');
  assert.equal(busy.status, 429, 'trop de demandes : 429');
  assert.equal(busy.body.code, 'PRIVATE_EVENT_BUSY');
  assert.equal(busy.body.error, 'Trop d’inscriptions d’un coup : réessaie dans une minute.');
  const retryAfter = Number(busy.headers['retry-after']);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After : ${busy.headers['retry-after']}`);
  // Un en-tête X-Forwarded-For inventé ne change pas d'appareil.
  assert.equal((await enter('10.0.0.1', { 'x-forwarded-for': '10.9.9.9' })).body.code, 'PRIVATE_EVENT_BUSY');
  // Les autres invités entrent toujours.
  assert.equal((await enter('10.0.0.2')).status, 200, 'un autre appareil n’est pas bloqué');
  // Le bar entier : 120 par minute.
  for (let n = 3; f.sched.people.size < 120; n++) {
    for (let i = 0; i < 30 && f.sched.people.size < 120; i++) assert.equal((await enter(`10.0.1.${n}`)).status, 200);
  }
  const venue = await enter('10.0.2.1');
  assert.equal(venue.status, 429);
  assert.equal(venue.body.code, 'PRIVATE_EVENT_BUSY', '121e création de la minute : nouvel essai plus tard');
  assert.ok(Number(venue.headers['retry-after']) >= 1);
  assert.equal(f.sched.people.size, 120);
  const saved = f.night.saves.at(-1);
  assert.deepEqual(Object.keys(saved.privateEvent).sort(), ['enabled', 'secret', 'since']);
  assert.equal(saved.privateEvent.enabled, true);
  assert.equal(saved.scheduler.people.filter(p => p.viaEvent && p.nameRequired).length, 120);
});

// Regression: deuxième relecture finale (ADV F1, S2-1) — l'appareil était
// l'adresse exacte : un téléphone en IPv6 change d'adresse dans son /64 et
// passait la limite ; ::ffff:a.b.c.d comptait à part de a.b.c.d.
test('événement privé : un même /64 IPv6 est un seul appareil, une IPv4 mappée est son IPv4', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const enter = (remote, options = {}) => post(f, '/api/table/enter', { ...tb, event: secret }, { remote, ...options });
  for (let i = 1; i <= 30; i++) assert.equal((await enter(`2001:db8:5:6::${i.toString(16)}`)).status, 200);
  assert.equal((await enter('2001:db8:5:6:abcd:ef01:2345:6789')).body.code, 'PRIVATE_EVENT_BUSY', 'nouvelle adresse du même /64');
  assert.equal((await enter('2001:db8:5:7::1')).status, 200, 'autre /64 : autre appareil');
  for (let i = 0; i < 15; i++) assert.equal((await enter('::ffff:10.4.4.4')).status, 200);
  for (let i = 0; i < 15; i++) assert.equal((await enter('10.4.4.4')).status, 200);
  assert.equal((await enter('::ffff:10.4.4.4')).body.code, 'PRIVATE_EVENT_BUSY', 'IPv4 mappée et IPv4 : même appareil');
  // Par le tunnel : même règle sur l'adresse donnée par Cloudflare.
  const edge = ip => enter('127.0.0.1', { port: f.PUBLIC_PORT, headers: { 'cf-connecting-ip': ip } });
  for (let i = 1; i <= 30; i++) assert.equal((await edge(`2001:db8:9:9:${i.toString(16)}::1`)).status, 200);
  assert.equal((await edge('2001:db8:9:9:ffff::1')).body.code, 'PRIVATE_EVENT_BUSY');
});

// Regression: relecture finale (ADV1) — par le tunnel HTTPS (cloudflared vers
// le port clients, la configuration du guide), chaque invité arrive de
// 127.0.0.1 : la limite par appareil devenait 5 invités par minute pour tout
// le bar.
test('événement privé par le tunnel HTTPS : l’appareil est l’adresse donnée par Cloudflare', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const enter = headers => post(f, '/api/table/enter', { ...tb, event: secret },
    { port: f.PUBLIC_PORT, remote: '127.0.0.1', headers });
  for (let i = 1; i <= 8; i++) {
    const r = await enter({ 'cf-connecting-ip': `203.0.113.${i}` });
    assert.equal(r.status, 200, `invité ${i} : ${r.text}`);
  }
  // Un même invité reste limité à 30 par minute, même s'il invente X-Forwarded-For.
  for (let i = 0; i < 30; i++) assert.equal((await enter({ 'cf-connecting-ip': '198.51.100.7' })).status, 200);
  assert.equal((await enter({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '10.9.9.9' })).body.code, 'PRIVATE_EVENT_BUSY');
  // Tunnel sans cet en-tête : pas de limite par appareil, celle du bar (120) seulement.
  for (let i = 0; i < 31; i++) assert.equal((await enter({})).status, 200);
  // Sur le port du Wi-Fi, l'en-tête n'est pas cru : l'adresse de la connexion compte.
  const lan = (remote, ip) => post(f, '/api/table/enter', { ...tb, event: secret }, { remote, headers: { 'cf-connecting-ip': ip } });
  for (let i = 0; i < 30; i++) assert.equal((await lan('10.0.5.1', `192.0.2.${i}`)).status, 200);
  assert.equal((await lan('10.0.5.1', '192.0.2.99')).body.code, 'PRIVATE_EVENT_BUSY');
});

// Regression: deuxième relecture finale (ADV F1, A2-2) — 400 « Solo N » jamais
// nommés remplissaient l'événement pour toute la soirée ; complet répondait 400.
test('événement privé : le plafond de 400 compte les présents nommés et les places sans prénom des 10 dernières minutes', async () => {
  const f = harness();
  const { tb } = openSolo(f);
  const secret = f.privateEvent.enable();
  const crowd = [];
  for (let i = 0; i < 400; i++) {
    const p = f.sched.join({ tableId: 'Comptoir', name: `Invité ${i}`, ...(i % 2 ? { nameRequired: true } : {}) });
    p.viaEvent = true;
    crowd.push(p);
  }
  const full = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.3.1' });
  assert.equal(full.status, 403, 'complet : 403');
  assert.equal(full.body.code, 'PRIVATE_EVENT_FULL', '400 présents : plus de création par le QR commun');
  assert.equal(full.body.error, 'L’événement est complet par ce QR : demande au bar un QR individuel.');
  assert.equal(full.headers['retry-after'], undefined, 'pas de nouvel essai annoncé');
  // Deux personnes marquées parties (une nommée, une sans prénom) libèrent leur place.
  f.sched.leave(crowd[0], 'staff');
  f.sched.leave(crowd[1], 'staff');
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.3.2' })).status, 200);
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.3.3' })).status, 200);
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.3.4' })).body.code, 'PRIVATE_EVENT_FULL');
  // Places sans prénom ouvertes il y a plus de 10 minutes : elles ne comptent plus…
  for (const p of crowd.slice(2, 12)) if (p.nameRequired) p.joinedAt = Date.now() - 10 * 60000 - 1;
  for (let i = 0; i < 5; i++) {
    const r = await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: `10.0.4.${i}` });
    assert.equal(r.status, 200, r.text);
  }
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.4.9' })).body.code, 'PRIVATE_EVENT_FULL');
  // … mais restent nommables.
  const late = crowd[3];
  assert.equal(f.sched.people.get(late.id).nameRequired, true);
  f.sched.rename(late, 'Tardive');
  assert.equal(late.nameRequired, undefined);
  assert.equal((await post(f, '/api/table/enter', { ...tb, event: secret }, { remote: '10.0.4.10' })).body.code, 'PRIVATE_EVENT_FULL',
    'une fois nommée, elle compte de nouveau');
});

// Regression: deuxième relecture finale (ADV F1, D2-4) — « Renouveler » ne
// faisait pas baisser le compte : les « Solo N » jamais nommés restaient.
test('événement privé : « Renouveler le QR » retire sans trace les places sans prénom ni titre venues par l’événement', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const on = await post(f, staff(f, '/api/staff/private-event'), { enabled: true });
  const secret = new URL(on.body.url).searchParams.get('evenement');
  const lea = await eventEntry(f, tb, secret, 'Léa');
  const ghost = await eventEntry(f, tb, secret);
  const other = await eventEntry(f, tb, secret);
  const personal = await opened(f, tb, invite()); // QR individuel sans prénom : gardé
  const before = events(f).length;
  const rotated = await post(f, staff(f, '/api/staff/private-event'), { rotate: true });
  assert.equal(rotated.status, 200, rotated.text);
  assert.ok(f.sched.people.has(lea.personId), 'nommée : gardée');
  assert.ok(f.sched.people.has(personal.personId), 'QR individuel : gardé');
  for (const gone of [ghost, other]) {
    assert.equal(f.sched.people.has(gone.personId), false, 'place sans prénom retirée');
    assert.equal(f.sched.person(gone.token), null);
  }
  assert.deepEqual(events(f).slice(before).filter(e => e.personId), [], 'rien au journal pour ces places');
  // La page de la place retirée qui se recharge : l'ancien QR n'est plus actif.
  const reload = await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: ghost.cookie });
  assert.equal(reload.status, 403);
  assert.equal(reload.body.code, 'PRIVATE_EVENT');
  assert.deepEqual((await stateOf(f, tb, ghost)).body.managedIds, []);
  // Léa garde son accès.
  assert.deepEqual((await stateOf(f, tb, lea)).body.managedIds, [lea.personId]);
});

// Regression: deuxième relecture finale (ADV F1) — /api/leave sur une place
// sans prénom puis un nouveau scan sans cookie : des fiches parties
// s'accumulaient pour toute la soirée.
test('événement privé : quitter une place sans prénom ni titre la supprime, sans trace', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const secret = f.privateEvent.enable();
  const before = f.sched.people.size;
  for (let i = 0; i < 3; i++) {
    const me = await eventEntry(f, tb, secret);
    const left = await post(f, '/api/leave', { token: me.token }, { cookie: me.cookie });
    assert.equal(left.status, 200, left.text);
    assert.equal(f.sched.people.has(me.personId), false);
  }
  assert.equal(f.sched.people.size, before, 'aucune fiche partie accumulée');
  assert.deepEqual(events(f, 'person.left'), []);
  // Une personne nommée qui part reste inscrite (marquée partie).
  const lea = await eventEntry(f, tb, secret, 'Léa');
  assert.equal((await post(f, '/api/leave', { token: lea.token }, { cookie: lea.cookie })).status, 200);
  assert.ok(f.sched.people.get(lea.personId).withdrawnAt);
  // QR individuel sans prénom : marquée partie comme avant (le bar peut la réactiver).
  const sam = await opened(f, tb, invite());
  assert.equal((await post(f, '/api/leave', { token: sam.token }, { cookie: sam.cookie })).status, 200);
  assert.ok(f.sched.people.get(sam.personId).withdrawnAt);
});

// Regression: deuxième relecture finale (ADV F5) — un QR individuel neuf était
// refusé (« Ce téléphone a déjà un prénom inscrit ») sur un navigateur qui ne
// gardait qu'une place sans prénom du QR de l'événement.
test('QR individuel neuf : la place sans prénom de ce navigateur part, le QR s’ouvre ; jamais deux places', async () => {
  const f = harness({ persistent: true });
  const { tb, invite } = openSolo(f);
  const secret = f.privateEvent.enable();
  const ghost = await eventEntry(f, tb, secret);
  // Sauvegarde impossible : la place provisoire reste, l'invitation aussi.
  const token = invite();
  f.night.fail = 'disque plein';
  const failed = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: ghost.cookie });
  assert.equal(failed.status, 400);
  assert.ok(f.sched.people.has(ghost.personId), 'place provisoire intacte');
  assert.equal(f.sched.person(ghost.token)?.id, ghost.personId);
  assert.ok(f.soloInvitations.verify(token, 'Comptoir'));
  f.night.fail = null;
  const before = events(f).length;
  const r = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: ghost.cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.nameRequired, true);
  assert.notEqual(r.body.id, ghost.personId);
  assert.equal(f.sched.people.has(ghost.personId), false, 'la place provisoire part');
  assert.deepEqual(events(f).slice(before).filter(e => e.personId === ghost.personId), [], 'sans trace');
  const me = { ...tb, personId: r.body.id, token: r.body.token, cookie: cookieOf(r) || ghost.cookie };
  assert.deepEqual((await stateOf(f, tb, me)).body.managedIds, [r.body.id]);
  // Nommée ou avec un titre : toujours refusé.
  await post(f, '/api/table/person/rename', { ...tb, personId: me.personId, token: me.token, name: 'Nina' }, { cookie: me.cookie });
  const again = await post(f, '/api/table/solo/open', { ...tb, invitation: invite() }, { cookie: me.cookie });
  assert.equal(again.body.code, 'SOLO_DEVICE_USED');
});

// Regression: deuxième relecture finale (A2-3) — une personne marquée partie
// qui rouvrait son QR personnel dans un autre navigateur lisait « demande un
// nouveau QR » au lieu de « marquée partie ».
test('QR personnel d’une personne marquée partie, ouvert ailleurs : PERSON_LEFT', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const token = invite();
  const sam = await opened(f, tb, token);
  await post(f, '/api/table/person/rename', { ...tb, personId: sam.personId, token: sam.token, name: 'Sam' }, { cookie: sam.cookie });
  await post(f, staff(f, '/api/staff/person/leave'), { personId: sam.personId });
  for (const cookie of [undefined, (await opened(f, tb, invite())).cookie]) {
    const r = await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'PERSON_LEFT');
  }
  // Une invitation jamais utilisée garde son message.
  const unknown = await post(f, '/api/table/solo/open', { ...tb, invitation: 'y'.repeat(32) });
  assert.equal(unknown.body.code, 'SOLO_INVITATION');
});

// Regression: deuxième relecture finale (P2-2) — chaque reprise ajoutait une
// empreinte de téléphone, même redemandée par le téléphone actuel : la liste
// grandissait sans fin.
test('reprises répétées : le téléphone actuel ne se réassocie pas ; au plus 8 empreintes, l’actuelle en dernier', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const token = invite();
  const sam = await opened(f, tb, token);
  await post(f, '/api/table/person/rename', { ...tb, personId: sam.personId, token: sam.token, name: 'Sam' }, { cookie: sam.cookie });
  const person = f.sched.people.get(sam.personId);
  let cookie = sam.cookie;
  for (let i = 0; i < 5; i++) {
    const again = await post(f, '/api/table/person/claim', { ...tb, key: token }, { cookie });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.headers['set-cookie'], undefined, 'même téléphone : même cookie');
  }
  assert.equal(person.soloDeviceHashes.length, 1, 'le téléphone actuel ne s’ajoute pas à chaque reprise');
  assert.equal(person.soloDeviceHashes.at(-1), crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex'));
  for (let i = 0; i < 12; i++) {
    const claimed = await post(f, '/api/table/person/claim', { ...tb, key: token });
    assert.equal(claimed.status, 200, claimed.text);
    cookie = cookieOf(claimed);
  }
  assert.equal(person.soloDeviceHashes.length, 8, 'au plus 8 empreintes');
  assert.equal(person.soloDeviceHashes.at(-1), crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex'), 'l’actuelle en dernier');
  assert.deepEqual((await stateOf(f, tb, { token: f.sched.people.get(sam.personId).token, cookie })).body.managedIds, [sam.personId]);
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
test('activité : seule une page cachée (x-page-visible: 0) ne compte pas ; une page visible compte pour toutes les personnes du téléphone ; actions comptées, accusé non', async () => {
  const f = harness();
  const tb = openTable(f, '5');
  const ana = await post(f, '/api/table/person', { ...tb, name: 'Ana' });
  const ben = await post(f, '/api/table/person', { ...tb, name: 'Ben' });
  const people = [ana, ben].map(r => f.sched.people.get(r.body.id));
  const old = Date.now() - 30 * 60000;
  for (const p of people) { p.lastSeen = old; delete p.lastActionAt; }
  const poll = headers => get(f, `/api/state?table=5&access=${tb.access}`,
    { headers: { 'x-person-tokens': JSON.stringify(people.map(p => p.token)), ...headers } });
  await poll({ 'x-page-visible': '0' });
  assert.deepEqual(people.map(p => p.lastSeen), [old, old], 'page cachée : rien ne bouge');
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
  await get(f, `/api/state?token=${people[0].token}`, { headers: { 'x-page-visible': '0' } });
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

// Regression: constat QA Q1 (8 octobre) — un prénom refusé (déjà pris, vide)
// comptait comme activité : le bar affichait « Actif il y a N min » au lieu de
// « Pas revenu depuis l'ouverture du QR ». Seule une action acceptée compte (C1).
test('activité : une action personnelle refusée (prénom pris, vide, 4xx) ne compte pas', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const marie = await opened(f, tb, invite());
  assert.equal((await post(f, '/api/table/person/rename', { ...tb, personId: marie.personId, token: marie.token, name: 'Marie' },
    { cookie: marie.cookie })).status, 200);
  const sam = await opened(f, tb, invite());
  const p = f.sched.people.get(sam.personId);
  delete p.lastActionAt;
  const body = extra => ({ ...tb, personId: sam.personId, token: sam.token, ...extra });
  const refused = async (route, extra) => {
    const r = await post(f, route, body(extra), { cookie: sam.cookie });
    assert.ok(r.status >= 400 && r.status < 500, `${route} : ${r.status} ${r.text}`);
    assert.equal(p.lastActionAt, undefined, `${route} refusé : pas une activité`);
    return r;
  };
  assert.equal((await refused('/api/table/person/rename', { name: 'marie' })).body.code, 'NAME_TAKEN');
  await refused('/api/table/person/rename', { name: '   ' });
  await refused('/api/table/song', { song: song('1', 'Titre') });
  await refused('/api/table/battle/vote', { choice: 'a' });
  await refused('/api/table/song/remove', { entryId: 'inconnu' });
  assert.equal(plain(f.staffState()).people.find(row => row.id === sam.personId).lastActiveAt, p.lastSeen,
    'le bar garde l’heure d’ouverture du QR');
  // Une action acceptée compte toujours.
  assert.equal((await post(f, '/api/table/person/rename', body({ name: 'Sam' }), { cookie: sam.cookie })).status, 200);
  assert.ok(p.lastActionAt > 0, 'prénom accepté = action');
  // Ancienne API par jeton : un refus ne compte pas non plus.
  delete p.lastActionAt;
  const legacy = await post(f, '/api/duet/answer', { token: sam.token, accept: true, entryId: 'inconnu' }, { cookie: sam.cookie });
  assert.equal(legacy.status, 400, legacy.text);
  assert.equal(p.lastActionAt, undefined, 'ancienne API refusée : pas une activité');
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
  assert.equal(soloInvite.body.error, 'Pas de QR à partager : chacun demande son QR individuel au bar.');
  assert.equal((await get(f, '/api/table/inconnue')).status, 404);
});

// ---------------------------------------------------------------- relecture finale (lot serveur)
// Regression: relecture finale C1 — une page des chanteurs gardée en cache
// d'avant une mise à jour en cours de soirée n'envoie jamais x-page-visible :
// ses solos apparaissaient « Sans nouvelles » au bar. Seul « 0 » (page
// cachée, nouvelle page) ne compte pas.
test('activité : une page d’avant la mise à jour (sans en-tête) compte encore ; « 0 » seulement ne compte pas', async () => {
  const f = harness();
  const tb = openTable(f, '5');
  const ana = await post(f, '/api/table/person', { ...tb, name: 'Ana' });
  const p = f.sched.people.get(ana.body.id);
  const old = Date.now() - 30 * 60000;
  const poll = headers => get(f, `/api/state?table=5&access=${tb.access}`,
    { headers: { 'x-person-tokens': JSON.stringify([p.token]), ...headers } });
  p.lastSeen = old;
  await poll({});
  assert.ok(p.lastSeen > old, 'page en cache sans en-tête : activité notée');
  p.lastSeen = old;
  await poll({ 'x-page-visible': '0' });
  assert.equal(p.lastSeen, old, 'nouvelle page cachée : rien');
  // Ancienne lecture par jeton seul : même règle.
  await get(f, `/api/state?token=${p.token}`);
  assert.ok(p.lastSeen > old, 'lecture par jeton sans en-tête : activité notée');
  p.lastSeen = old;
  await get(f, `/api/state?token=${p.token}`, { headers: { 'x-page-visible': '0' } });
  assert.equal(p.lastSeen, old);
  // Solo : page en cache avec le cookie de son téléphone.
  const { tb: solo, invite } = openSolo(f);
  const sam = await opened(f, solo, invite());
  const sp = f.sched.people.get(sam.personId);
  sp.lastSeen = old;
  await stateOf(f, solo, sam);
  assert.ok(sp.lastSeen > old, 'solo : page en cache comptée');
});

// Regression: relecture finale C3 — au redémarrage, journalRoster() inscrivait
// au journal le prénom provisoire (« Solo 1 ») des QR ouverts sans prénom
// (spéc. A1.5 : une ouverture abandonnée n'entre ni au journal ni aux stats).
test('journal : au redémarrage, une personne encore sans prénom n’entre pas dans les prénoms du journal', async () => {
  const f = harness();
  const { tb, invite } = openSolo(f);
  const sam = await opened(f, tb, invite());
  const zoe = await opened(f, tb, invite());
  assert.equal((await post(f, '/api/table/person/rename', { ...tb, personId: zoe.personId, token: zoe.token, name: 'Zoé' },
    { cookie: zoe.cookie })).status, 200);
  f.journalRoster(); // ce que fait le démarrage (et une nouvelle soirée)
  const roster = f.journal.current.meta.roster;
  assert.equal(roster[sam.personId], undefined, 'prénom provisoire absent');
  assert.equal(roster[zoe.personId].name, 'Zoé');
  const exported = await get(f, staff(f, '/api/staff/stats/export?names=1'));
  assert.equal(exported.status, 200, exported.text);
  assert.ok(!exported.text.includes('Solo 1'), 'export avec prénoms : aucun prénom provisoire');
  assert.ok(exported.text.includes('Zoé'));
  // Son premier vrai prénom l'inscrit ensuite, comme sans redémarrage.
  await post(f, '/api/table/person/rename', { ...tb, personId: sam.personId, token: sam.token, name: 'Sam' }, { cookie: sam.cookie });
  assert.equal(f.journal.current.meta.roster[sam.personId].name, 'Sam');
});

// Regression: relecture finale C4 — PERSON_LEFT répondait 400 depuis les
// routes de table (QR individuel, QR de l'événement, actions d'une personne)
// mais 403 depuis l'ancienne API par jeton.
test('personne marquée partie : 403 PERSON_LEFT sur toutes les routes', async () => {
  const f = harness();
  const message = 'Cette personne a été marquée partie. Demande au bar de la réactiver.';
  const { tb, invite } = openSolo(f);
  const token = invite();
  const sam = await opened(f, tb, token);
  await post(f, '/api/table/person/rename', { ...tb, personId: sam.personId, token: sam.token, name: 'Sam' }, { cookie: sam.cookie });
  const secret = new URL((await post(f, staff(f, '/api/staff/private-event'), { enabled: true })).body.url).searchParams.get('evenement');
  const eva = await post(f, '/api/table/enter', { ...tb, event: secret });
  assert.equal(eva.status, 200, eva.text);
  const evaCookie = cookieOf(eva);
  const table = openTable(f, '3');
  const ana = await post(f, '/api/table/person', { ...table, name: 'Ana' });
  for (const personId of [sam.personId, eva.body.id, ana.body.id]) await post(f, staff(f, '/api/staff/person/leave'), { personId });
  const answers = [
    await post(f, '/api/table/solo/open', { ...tb, invitation: token }, { cookie: sam.cookie }),
    await post(f, '/api/table/enter', { ...tb, event: secret }, { cookie: evaCookie }),
    await post(f, '/api/table/confirm', { ...table, personId: ana.body.id, token: ana.body.token }),
    await post(f, '/api/confirm', { token: ana.body.token }),
  ];
  assert.deepEqual(answers.map(r => [r.status, r.body.code, r.body.error]), Array(4).fill([403, 'PERSON_LEFT', message]));
});

// Regression: relecture finale C5 — la durée envoyée par un téléphone était
// gardée telle quelle (une chaîne de 200 Ko acceptée) et renvoyée à tous les
// téléphones. Seul un nombre borné (30 à 1200 s) est gardé, sinon rien.
test('durée envoyée par un téléphone : seulement un nombre borné, pour un titre comme pour un duo', async () => {
  const f = harness();
  const tb = openTable(f, '7', 6);
  const people = [];
  for (const name of ['Ana', 'Ben', 'Cléo', 'Dan']) people.push((await post(f, '/api/table/person', { ...tb, name })).body);
  const at = (person, extra) => ({ ...tb, personId: person.id, token: person.token, ...extra });
  const choose = async (person, songId, duration) => {
    const r = await post(f, '/api/table/song', at(person, { song: { songId, title: `T${songId}`, artist: 'A', duration } }));
    assert.equal(r.status, 200, r.text);
  };
  await choose(people[0], 1, 'x'.repeat(200000));
  await choose(people[0], 2, 99999);
  await choose(people[0], 3, 10);
  await choose(people[0], 4, 215.4);
  await choose(people[0], 5, '215');
  const durations = f.sched.songsOf(f.sched.people.get(people[0].id)).map(song => song.duration);
  assert.deepEqual(durations, [null, 1200, 30, 215, 215]);
  // Duo : même règle.
  const duet = await post(f, '/api/table/duet', at(people[1], { partnerId: people[2].id,
    song: { songId: 9, title: 'Duo', artist: 'A', duration: 'y'.repeat(5000) } }));
  assert.equal(duet.status, 200, duet.text);
  assert.equal(f.sched.songsOf(f.sched.people.get(people[1].id)).at(-1).duration, null);
  // Ancienne API par jeton : même règle.
  assert.equal((await post(f, '/api/song', { token: people[3].token, song: { songId: 8, title: 'T8', artist: 'A', duration: [1, 2] } })).status, 200);
  assert.equal(f.sched.songsOf(f.sched.people.get(people[3].id))[0].duration, null);
  // Ce que les téléphones reçoivent.
  const view = await get(f, `/api/state?table=7&access=${tb.access}`, { headers: { 'x-person-tokens': JSON.stringify([people[0].token]) } });
  assert.ok(view.text.length < 50000, 'aucune durée géante renvoyée aux téléphones');
});
