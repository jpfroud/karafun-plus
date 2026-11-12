'use strict';
// Faux KaraFun KCS (fake-karafun.js, issue #59) branché sur le vrai WebSocket de
// Node : celui que kcs-transport.js ouvre avec le vrai KaraFun du bar. Les autres
// tests du protocole remplacent ce WebSocket par un faux ; ici, une coupure du
// WebSocket de Node ou du faux échoue. Aucun accès au vrai KaraFun, aucun vrai code.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { test: nodeTest } = require('node:test');
const { startFakeKaraFun } = require('../fake-karafun');
const { KcsTransport } = require('../kcs-transport');
const { KaraFunBridge } = require('../karafun');

// Chaque essai a son délai : une attente qui ne vient jamais (une régression du faux) le
// fait échouer en le nommant, au lieu de bloquer la suite hors ligne, qui lance chaque
// fichier sans délai.
const test = (name, fn) => nodeTest(name, { timeout: 30000 }, fn);
const CODE = '123456';
const SUBPROTOCOL = 'kcpj~v3+emuping';
const freePort = () => new Promise(resolve => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const until = async (check, what, ms = 8000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`délai dépassé : ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
// Attente bornée d'une promesse (une fermeture, par exemple) : ce qui ne vient pas fait
// échouer l'essai en nommant ce qu'il attendait.
const within = (promise, what, ms = 5000) => Promise.race([promise, new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error(`délai dépassé : ${what}`)), ms).unref();
})]);
async function fake(t, options = {}) {
  const port = options.port ?? await freePort();
  const kf = await startFakeKaraFun({ port, code: CODE, songSeconds: 60, autoplay: false, ...options });
  t.after(() => kf.close());
  return { ...kf, port, url: (code = CODE) => `ws://127.0.0.1:${port}/kcs/${code}` };
}
// WebSocket de Node : messages reçus dans l'ordre, ouverture et fermeture attendues. Une
// connexion refusée ou coupée avant son ouverture fait échouer `opened` tout de suite
// (Node 26 signale alors une erreur puis la fermeture 1006, Node 23 l'erreur seulement).
function open(url, protocols = SUBPROTOCOL) {
  const ws = new WebSocket(url, protocols);
  const received = [];
  ws.addEventListener('message', event => received.push(JSON.parse(String(event.data))));
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(true), { once: true });
    ws.addEventListener('error', () => reject(new Error(`connexion refusée : ${url}`)), { once: true });
    ws.addEventListener('close', event => reject(new Error(`connexion fermée avant son ouverture (${event.code})`)), { once: true });
  });
  opened.catch(() => { /* rejet lu par l'essai qui attend l'ouverture */ });
  const closed = new Promise(resolve => ws.addEventListener('close', event => resolve(event.code), { once: true }));
  return { ws, received, opened, closed, send: message => ws.send(JSON.stringify(message)) };
}

// protects=la poignée de main KCS (sous-protocole kcpj~v3+emuping renvoyé par le faux) et le refus (400) d'une
// demande sans lui ; fails_when=le faux ne renvoie pas le sous-protocole (le WebSocket de Node refuse alors), ou
// accepte (101) un client sans lui ; no_claim=la poignée de main du vrai KaraFun (wss, jeton dans l'adresse), que
// seul l'essai réel montre.
test('poignée de main : sous-protocole KCS négocié, refus sans lui', async t => {
  const kf = await fake(t);
  const good = open(kf.url());
  assert.equal(await good.opened, true);
  assert.equal(good.ws.protocol, SUBPROTOCOL);
  good.ws.close();
  // Demande brute : le WebSocket de Node refuserait de lui-même une réponse 101 qui lui impose
  // un sous-protocole qu'il n'a pas demandé, et cacherait ainsi un faux trop accueillant.
  const bad = await rawRequest(kf.port, `GET /kcs/${CODE} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
    + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  bad.socket.destroy();
  assert.match(bad.status, /^HTTP\/1\.1 400 /, 'sans sous-protocole : 400, jamais 101');
});

// protects=l'ordre des premiers messages du vrai KaraFun (journal du 6 novembre 2026) et leurs valeurs ;
// fails_when=un message manque, change de place ou de forme (le pont ne serait plus « prêt » comme avec
// KaraFun) ; no_claim=que KaraFun garde cet ordre dans ses prochaines versions.
test('ordre des premiers messages : celui du vrai KaraFun', async t => {
  const kf = await fake(t);
  const c = open(kf.url());
  await c.opened;
  await until(() => c.received.length >= 1, 'AuthenticatedEvent');
  assert.deepEqual(c.received[0], { type: 'core.AuthenticatedEvent', payload: {} });
  c.send({ id: 1, type: 'remote.UpdateUsernameRequest', payload: { username: 'FileKaraoke-0001' } });
  await until(() => c.received.some(m => m.type === 'remote.UpdateUsernameResponse'), 'accord sur le nom');
  const after = c.received.slice(1).filter(m => m.type !== 'core.PingRequest');
  assert.deepEqual(after.map(m => m.type), ['remote.StatusEvent', 'remote.QueueEvent', 'remote.PermissionsUpdateEvent',
    'remote.PreferencesUpdateEvent', 'remote.ConfigurationUpdateEvent', 'remote.UsernameUpdateEvent', 'remote.UpdateUsernameResponse']);
  assert.deepEqual(after[0].payload, { status: { state: 1, pitch: 0, tempo: 0, tracks: [] } }, 'file vide : état 1 sans titre');
  assert.deepEqual(after[1].payload, { queue: { items: [] } });
  assert.deepEqual(after[2].payload, { permissions: { manageQueue: true, viewQueue: true, addToQueue: true, managePlayback: true,
    manageVolumes: true, sendPhotos: true, shownTypes: { karaoke: true, community: false, quiz: false, battle: true } } });
  assert.deepEqual(after[3].payload, { preferences: { askOptions: false, singerRotation: false } });
  assert.deepEqual(after[4].payload.configuration, { pitchStep: 1, pitchMin: -6, pitchMax: 6, tempoStep: 5, tempoMin: -50,
    tempoMax: 50, compatibleMods: { battle: [1, 2] } });
  assert.deepEqual(after[5].payload, { username: 'FileKaraoke-0001' });
  assert.equal(after[6].id, 1, 'réponse au même identifiant');
  c.ws.close();
});

// protects=le battement KCS : PingRequest numérotés du faux, PingResponse du vrai kcs-transport.js ;
// fails_when=le faux ne pingue plus (le chien de garde du pont couperait toutes les 10 s) ou le transport
// ne répond plus ; no_claim=le rythme exact du vrai KaraFun (environ 1 s le 6 novembre).
test('battement : PingRequest du faux, PingResponse de kcs-transport.js', async t => {
  const kf = await fake(t, { pingMs: 40 });
  const transport = new KcsTransport(kf.url());
  t.after(() => transport.close());
  const pings = [], answers = [];
  transport.on('message', m => { if (m.type === 'core.PingRequest') pings.push(m.id); });
  transport.on('out', m => { if (m.type === 'core.PingResponse') answers.push(m.id); });
  await until(() => answers.length >= 3, 'trois battements');
  assert.deepEqual(answers.slice(0, 3), pings.slice(0, 3), 'chaque PingRequest reçoit sa réponse, même identifiant');
  assert.deepEqual(pings.slice(0, 3), [1, 2, 3]);
});

// protects=les trames longues dans les deux sens (longueur sur 64 bits) ; fails_when=une file ou des
// options de plus de 65 535 octets se perdent ou se coupent ; no_claim=la taille maximale du vrai KaraFun.
test('messages de plus de 65 535 octets : aller et retour', async t => {
  const kf = await fake(t);
  const c = open(kf.url());
  await c.opened;
  c.send({ id: 1, type: 'remote.UpdateUsernameRequest', payload: { username: 'FileKaraoke-0001' } });
  const singer = 'x'.repeat(70000);
  c.send({ id: 2, type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 70002 }, options: { singer }, position: 99999 } });
  await until(() => c.received.some(m => m.type === 'remote.QueueEvent' && m.payload.queue.items.length === 1), 'file d’un titre');
  const queue = c.received.findLast(m => m.type === 'remote.QueueEvent');
  assert.equal(queue.payload.queue.items[0].song.options.singer, singer);
  assert.equal(kf.state().queue[0].singer.length, 70000);
  c.ws.close();
});

// protects=le refus d'un mauvais code, comme le vrai KaraFun quand le code change (fermeture 4404,
// urlRejected de karafun.js) ; fails_when=le faux accepte n'importe quel code ; no_claim=les autres codes
// de fermeture du vrai KaraFun (4401, 4403, 4210).
test('mauvais code : fermeture 4404', async t => {
  const kf = await fake(t);
  const c = open(kf.url('000000'));
  assert.equal(await within(c.closed, 'fermeture 4404'), 4404);
});

// Poignée de main à la main, sur un socket TCP : trames que le WebSocket de Node n'enverrait jamais.
// `allowHalfOpen` : le client garde son côté ouvert après la fermeture du faux, comme un pair qui traîne.
function rawSocket(port, { allowHalfOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen }, () => socket.write(`GET /kcs/${CODE} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
      + `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n`
      + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${SUBPROTOCOL}\r\n\r\n`));
    let data = Buffer.alloc(0), handshake = true, settled = false;
    const closeCode = new Promise(resolveCode => {
      socket.on('data', chunk => {
        data = Buffer.concat([data, chunk]);
        if (handshake) {
          const end = data.indexOf('\r\n\r\n');
          if (end < 0) return;
          handshake = false;
          const head = data.subarray(0, end).toString();
          data = data.subarray(end + 4);
          if (!settled) { settled = true; resolve({ socket, head, closeCode }); }
        }
        // Trames du serveur, jamais masquées : on cherche la fermeture.
        while (data.length >= 2) {
          const opcode = data[0] & 0x0f;
          let length = data[1] & 0x7f, offset = 2;
          if (length === 126) { if (data.length < 4) return; length = data.readUInt16BE(2); offset = 4; }
          else if (length === 127) { if (data.length < 10) return; length = Number(data.readBigUInt64BE(2)); offset = 10; }
          if (data.length < offset + length) return;
          const payload = data.subarray(offset, offset + length);
          data = data.subarray(offset + length);
          if (opcode === 0x8) resolveCode(payload.readUInt16BE(0));
        }
      });
      socket.on('close', () => resolveCode(null));
    });
    socket.on('error', reject);
  });
}
const frame = (first, second, rest = Buffer.alloc(0)) => Buffer.concat([Buffer.from([first, second]), rest]);
const masked = text => {
  const key = crypto.randomBytes(4), data = Buffer.from(text);
  for (let i = 0; i < data.length; i++) data[i] ^= key[i & 3];
  return Buffer.concat([key, data]);
};

// protects=la rigueur du faux : il ferme ce que le vrai protocole interdit ; fails_when=une trame non
// masquée, fragmentée ou annoncée à plus de 1 Mio passe (un client fautif resterait caché) ; no_claim=la
// réaction exacte du vrai KaraFun à ces trames.
test('trames refusées : non masquée (1002), fragmentée (1002), plus de 1 Mio (1009)', async t => {
  const kf = await fake(t);
  // Vraie demande dans le fragment : seul le refus de la fragmentation peut répondre 1002.
  const request = JSON.stringify({ id: 1, type: 'remote.UpdateUsernameRequest', payload: { username: 'FileKaraoke-0001' } });
  const cases = [
    ['non masquée', frame(0x81, 2, Buffer.from('{}')), 1002],
    ['fragmentée', frame(0x01, 0x80 | Buffer.byteLength(request), masked(request)), 1002],
    ['plus de 1 Mio', (() => { const length = Buffer.alloc(8); length.writeBigUInt64BE(2n * 1024n * 1024n); return frame(0x81, 0x80 | 127, length); })(), 1009],
  ];
  for (const [name, bytes, code] of cases) {
    const { socket, head, closeCode } = await rawSocket(kf.port);
    t.after(() => socket.destroy());
    assert.match(head, /^HTTP\/1\.1 101 /, name);
    assert.match(head, new RegExp(`Sec-WebSocket-Protocol: ${SUBPROTOCOL.replace(/[+~]/g, '\\$&')}`), name);
    socket.write(bytes);
    assert.equal(await within(closeCode, `${name} : fermeture ${code}`), code, name);
  }
});

// Requête HTTP brute : rend la première ligne de la réponse et le socket, gardé ouvert.
function rawRequest(port, text) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let data = '';
    socket.on('data', chunk => {
      data += chunk;
      if (data.includes('\r\n')) resolve({ socket, status: data.split('\r\n')[0] });
    });
    socket.on('error', () => { /* coupé par le faux : la fermeture suit */ });
    socket.on('close', () => resolve({ socket, status: data.split('\r\n')[0] || 'fermé sans réponse' }));
  });
}
const upgradeHeaders = (extra = '') => `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n`
  + `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: ${SUBPROTOCOL}\r\n${extra}`;
// Le faux répond encore : une vraie connexion s'ouvre et reçoit AuthenticatedEvent.
async function stillAlive(kf) {
  const c = open(kf.url());
  assert.equal(await c.opened, true, 'le faux répond encore');
  await until(() => c.received.length >= 1, 'AuthenticatedEvent');
  c.ws.close();
}

// protects=la démo face à un client maladroit ou hostile de la boucle locale : adresse illisible, page web d'un
// navigateur (en-tête Origin), refus lu puis connexion coupée net ; fails_when=une exception non rattrapée fait
// tomber le processus (la démo et ses pages), ou une page web ouvre le faux ; no_claim=les protections d'un
// navigateur précis (accès au réseau local) : seul l'en-tête Origin, que le WebSocket de Node n'envoie pas, compte ici ;
// ni la coupure pendant l'écriture du refus, qu'aucun essai ne reproduit (l'écouteur d'erreur reste par prudence).
test('client maladroit ou hostile : refus propres, la démo ne tombe pas', async t => {
  const kf = await fake(t);
  for (const [name, request] of [
    ['upgrade, adresse illisible', `GET http://[ HTTP/1.1\r\nHost: x\r\n${upgradeHeaders()}\r\n`],
    ['HTTP, adresse illisible', 'GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n'],
  ]) {
    const { socket, status } = await rawRequest(kf.port, request);
    socket.destroy();
    assert.match(status, /^HTTP\/1\.1 400 /, name);
  }
  const page = await rawRequest(kf.port, `GET /kcs/${CODE} HTTP/1.1\r\nHost: x\r\n${upgradeHeaders('Origin: https://exemple.invalid\r\n')}\r\n`);
  page.socket.destroy();
  assert.match(page.status, /^HTTP\/1\.1 403 /, 'page web : refusée');
  const reset = await rawRequest(kf.port, `GET /autre HTTP/1.1\r\nHost: x\r\n${upgradeHeaders()}\r\n`);
  assert.match(reset.status, /^HTTP\/1\.1 400 /);
  reset.socket.resetAndDestroy();
  await new Promise(resolve => setTimeout(resolve, 200));
  await stillAlive(kf);
});

// protects=la lecture des demandes : une valeur d'un autre type est refusée ou ignorée, jamais convertie de force ;
// fails_when=un nom ou un volume piégé (objet sans conversion possible) lève une exception qui fait tomber la démo,
// tout de suite ou au démarrage du titre ; no_claim=la réaction du vrai KaraFun à ces valeurs.
test('données piégées : nom refusé, volume ignoré, la démo ne tombe pas', async t => {
  const kf = await fake(t);
  const c = open(kf.url());
  await c.opened;
  c.send({ id: 1, type: 'remote.UpdateUsernameRequest', payload: { username: { toString: 1 } } });
  await until(() => c.received.some(m => m.type === 'Error' && m.id === 1), 'nom piégé refusé');
  c.send({ id: 2, type: 'remote.UpdateUsernameRequest', payload: { username: 'FileKaraoke-0001' } });
  c.send({ id: 3, type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 70002 }, position: 99999,
    options: { singer: 'Essai', tracks: [{ track: { type: 5 }, volume: { valueOf: 1, toString: 1 } }] } } });
  c.send({ id: 4, type: 'remote.PlayRequest', payload: {} });
  await until(() => c.received.some(m => m.type === 'remote.StatusEvent' && m.payload.status.state === 4), 'lecture');
  const live = c.received.findLast(m => m.type === 'remote.StatusEvent').payload.status;
  assert.equal(live.tracks.find(row => row.track.type === 5).volume, 0, 'volume piégé ignoré : valeur de KaraFun');
  c.ws.close();
  await stillAlive(kf);
});

// protects=le refus, à l'entrée, d'options imbriquées sans fin envoyées par un programme local : une Error au même
// identifiant, rien de changé, et la démo comme le pont du même processus tiennent ; fails_when=le faux accepte ces
// options sans le dire (pas d'Error), change la file ou les options, ou tombe ; no_claim=la profondeur que le vrai
// KaraFun accepte, ni ce qu'il relaie d'une autre télécommande.
test('options imbriquées sans fin : refusées à l’entrée, la démo et le pont tiennent', async t => {
  const kf = await fake(t, { autoplay: true, songSeconds: 2 });
  const bridge = new KaraFunBridge({ bases: [kf.base] });
  t.after(() => bridge.disconnect());
  bridge.connect(CODE);
  await until(() => bridge.ready, 'pont prêt');
  const c = open(kf.url());
  await c.opened;
  c.send({ id: 1, type: 'remote.UpdateUsernameRequest', payload: { username: 'FileKaraoke-0002' } });
  await until(() => c.received.some(m => m.type === 'remote.UpdateUsernameResponse'), 'nom accepté');
  bridge.add(70002, 'Léa · T1', 99999, {});
  bridge.add(70003, 'Essai · T2', 99999, {});
  await until(() => kf.state().queue.length === 2 && kf.state().state === 'playing', 'deux titres, le premier joue');
  const next = kf.state().queue[1], before = structuredClone(next.options);
  // Moins de 1 Mio par message. Sans le refus, optionsFrom ne garderait de toute façon que les champs connus, sur
  // quatre niveaux au plus : le refus dit au client que sa demande est illisible, au lieu de la tronquer sans bruit.
  const deep = n => '{"a":'.repeat(n) + '1' + '}'.repeat(n);
  c.ws.send(`{"id":2,"type":"remote.SetQueueItemOptionsRequest","payload":{"queueItemId":"${next.queueId}","options":${deep(100000)}}}`);
  c.ws.send(`{"id":3,"type":"remote.SetQueueItemOptionsRequest","payload":{"queueItemId":"${next.queueId}",`
    + `"options":{"mod":{"id":1,"data":{"battle":{"subtype":1,"x":${deep(20000)}}}}}}}`);
  c.ws.send(`{"id":4,"type":"remote.AddToQueueRequest","payload":{"song":{"type":1,"id":70004},"position":99999,`
    + `"options":${deep(100000)}}}`);
  await until(() => [2, 3, 4].every(id => c.received.some(m => m.type === 'Error' && m.id === id)), 'trois refus');
  assert.equal(kf.state().queue.length, 2, 'rien d’ajouté');
  assert.deepEqual(kf.state().queue[1].options, before, 'options du titre suivant inchangées');
  await until(() => bridge.status?.kcsState === 4 && bridge.status.current?.songId === 70003, 'titre suivant en lecture');
  assert.equal(bridge.ready, true, 'pont toujours prêt');
  c.ws.close();
});

// protects=le pont du même processus face à des options mal typées, envoyées par un programme local : le faux les
// recopie champ par champ avec leur type, comme KaraFun les montre, et oublie le reste ; fails_when=une valeur
// impossible à convertir (un objet à la place d'un nombre ou d'un texte) est gardée puis relayée, et le pont tombe
// en la lisant, à l'arrivée de la file (isBattleMod de karafun.js) ou au chargement du titre (song-settings.js) ;
// no_claim=ce que le vrai KaraFun fait de ces valeurs.
test('options mal typées : recopiées champ par champ, le pont tient jusqu’à la lecture', async t => {
  const trapped = { toString: 1 };
  for (const [name, options, kept] of [
    ['mode de Battle', { singer: 'Essai · T2', mod: { id: trapped, caption: 'Battle', data: { battle: { subtype: 1 } } } },
      { singer: 'Essai · T2' }],
    ['voix', { singer: 'Essai · T2', tracks: [{ track: { type: trapped }, volume: 1 }, { track: { type: 5 }, volume: 40 }] },
      { singer: 'Essai · T2', tracks: [{ track: { type: 5 }, volume: 40 }] }],
    ['chanteur, tonalité et tempo', { singer: trapped, pitch: trapped, tempo: '5', tracks: 'abc' }, {}],
  ]) {
    const kf = await fake(t);
    const bridge = new KaraFunBridge({ bases: [kf.base] });
    t.after(() => bridge.disconnect());
    bridge.connect(CODE);
    await until(() => bridge.ready, `${name} : pont prêt`);
    const c = open(kf.url());
    await c.opened;
    c.send({ id: 1, type: 'remote.UpdateUsernameRequest', payload: { username: 'FileKaraoke-0002' } });
    await until(() => c.received.some(m => m.type === 'remote.UpdateUsernameResponse'), `${name} : nom accepté`);
    c.send({ id: 2, type: 'remote.AddToQueueRequest', payload: { song: { type: 1, id: 70002 }, position: 99999, options } });
    await until(() => bridge.queue.length === 1, `${name} : titre vu par le pont`);
    assert.deepEqual(kf.state().queue[0].options, kept, `${name} : seuls les champs bien typés sont gardés`);
    c.send({ id: 3, type: 'remote.PlayRequest', payload: {} });
    await until(() => bridge.status?.kcsState === 4, `${name} : lecture`);
    assert.equal(bridge.ready, true, `${name} : pont toujours prêt`);
    c.ws.close();
  }
});

// protects=la démo face à une demande dont l'identifiant est illisible (ni entier ni texte court), envoyée par un
// programme local : connexion fermée (1002) avant tout changement ; fails_when=la demande est appliquée puis sa
// réponse échoue (titre ajouté sans diffusion, fermeture 1011), ou la démo tombe ; no_claim=les identifiants que
// le vrai KaraFun accepte : le pont, comme KaraFun le 6 novembre, n'envoie que des entiers.
test('identifiant illisible : connexion fermée (1002) avant tout changement', async t => {
  const kf = await fake(t);
  const c = open(kf.url());
  await c.opened;
  c.send({ id: 1, type: 'remote.UpdateUsernameRequest', payload: { username: 'FileKaraoke-0001' } });
  await until(() => c.received.some(m => m.type === 'remote.UpdateUsernameResponse'), 'nom accepté');
  // Identifiant imbriqué sur 100 000 niveaux, moins de 1 Mio : sa réponse ne pourrait pas être écrite.
  const id = '['.repeat(100000) + ']'.repeat(100000);
  c.ws.send(`{"id":${id},"type":"remote.AddToQueueRequest","payload":{"song":{"type":1,"id":70002},"position":99999}}`);
  assert.equal(await within(c.closed, 'fermeture 1002'), 1002);
  assert.equal(kf.state().queue.length, 0, 'rien d’ajouté');
  await stillAlive(kf);
});

// protects=la mémoire du faux après une fermeture ; fails_when=un pair qui garde la connexion ouverte et
// continue d'envoyer est gardé, et ses données avec, sans limite ; no_claim=le délai exact (1 s ici).
test('après sa fermeture, le faux coupe un client qui ne ferme pas', async t => {
  const kf = await fake(t);
  const { socket, closeCode } = await rawSocket(kf.port, { allowHalfOpen: true });
  t.after(() => socket.destroy());
  const ended = new Promise(resolve => socket.on('close', () => resolve('coupé')));
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(2n * 1024n * 1024n);
  socket.write(frame(0x81, 0x80 | 127, length));
  assert.equal(await within(closeCode, 'fermeture 1009'), 1009);
  const flood = setInterval(() => { if (!socket.destroyed) socket.write(Buffer.alloc(64 * 1024)); }, 20);
  t.after(() => clearInterval(flood));
  const outcome = await Promise.race([ended, new Promise(resolve => setTimeout(() => resolve('toujours ouvert'), 2500))]);
  assert.equal(outcome, 'coupé');
});

// protects=le refus d'un nom tenu par une autre connexion, tel que karafun.js le lit (Error type 4 sans
// identifiant) ; fails_when=le faux accepte le doublon ou change la forme du refus ; no_claim=le délai pendant
// lequel le vrai KaraFun garde un ancien nom après une coupure.
test('nom déjà pris : Error type 4 sans identifiant, sans état ni file', async t => {
  const kf = await fake(t);
  const a = open(kf.url());
  await a.opened;
  a.send({ id: 1, type: 'remote.UpdateUsernameRequest', payload: { username: 'FileKaraoke-0001' } });
  await until(() => a.received.some(m => m.type === 'remote.UpdateUsernameResponse'), 'premier nom accepté');
  const b = open(kf.url());
  await b.opened;
  b.send({ id: 1, type: 'remote.UpdateUsernameRequest', payload: { username: 'FileKaraoke-0001' } });
  await until(() => b.received.some(m => m.type === 'Error'), 'doublon refusé');
  assert.deepEqual(b.received.find(m => m.type === 'Error'), { type: 'Error', payload: { type: 4, message: 'username is already used' } });
  assert.equal(b.received.some(m => /StatusEvent|QueueEvent|UsernameUpdate/.test(m.type)), false);
  b.send({ id: 2, type: 'remote.UpdateUsernameRequest', payload: { username: 'FileKaraoke-0002' } });
  await until(() => b.received.some(m => m.type === 'remote.UpdateUsernameResponse' && m.id === 2), 'autre nom accepté');
  a.ws.close();
  b.ws.close();
});

// protects=le vrai pont avec un mauvais code local : refus 4404, pas « prêt », relance prévue, puis prêt avec
// le bon code ; fails_when=le pont se croit prêt, plante, ou reste bloqué après le bon code ; no_claim=le
// calendrier des relances (karafun.js, DISCOVERY_STEPS_MS), essayé avec un faux WebSocket dans kcs-connection.
test('pont local avec un mauvais code : refus 4404, relance prévue, puis prêt avec le bon code', async t => {
  const kf = await fake(t);
  const bridge = new KaraFunBridge({ bases: [kf.base] });
  t.after(() => bridge.disconnect());
  bridge.connect('000000');
  await until(() => bridge.connectionState().phase === 'retry', 'refus du code');
  assert.equal(bridge.ready, false);
  assert.match(bridge.lastError, /code 4404/);
  bridge.connect(CODE);
  await until(() => bridge.ready, 'prêt avec le bon code');
  assert.equal(bridge.protocol, 'kcs');
});

// protects=la connexion locale quand le WebSocket de Node manque (Node trop ancien) : un nouvel essai prévu et un
// message clair ; fails_when=connect() lève ou laisse une promesse rejetée sans suite, ou le pont ne prévoit rien ;
// no_claim=un vrai Node sans WebSocket (le global est retiré ici, puis remis), ni le calendrier des essais.
test('pont local sans WebSocket de Node : nouvel essai prévu, message clair', async t => {
  const saved = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  t.after(() => { globalThis.WebSocket = saved; });
  const bridge = new KaraFunBridge({ bases: ['http://127.0.0.1:9'] });
  t.after(() => bridge.disconnect());
  bridge.connect(CODE);
  await until(() => bridge.connectionState().phase === 'retry', 'nouvel essai prévu');
  assert.equal(bridge.ready, false);
  assert.match(bridge.lastError, /WebSocket indisponible.*Node 22/);
});

// protects=le vrai pont (karafun.js → kcs-transport.js → WebSocket de Node) avec le faux, comme la démo
// et les tests hors ligne : prêt en KCS, ajout avec réglages, Battle, retrait, lecture, réglage en
// direct, KaraFun fermé puis rouvert ; fails_when=le pont ne devient pas prêt, une commande n'atteint pas
// le faux ou la reconnexion échoue ; no_claim=que le vrai KaraFun accepte ces commandes (seul l'essai
// réel avant fusion le montre), ni la découverte par la page de KaraFun, sans objet en local.
test('le vrai pont avec le faux KaraFun, par le WebSocket de Node', async t => {
  const kf = await fake(t);
  const bridge = new KaraFunBridge({ bases: [kf.base] });
  t.after(() => bridge.disconnect());
  bridge.connect(CODE);
  await until(() => bridge.ready, 'pont prêt');
  assert.equal(bridge.protocol, 'kcs');
  assert.equal(bridge.connectionState().phase, 'ready');
  assert.equal(bridge.songSettingsState().available, true, 'réglages de titre pris en charge');
  assert.deepEqual(bridge.add(70002, 'Léa · T1', 99999, { pitch: -2 }), { pitch: -2 });
  await until(() => kf.state().queue.length === 1, 'titre ajouté au faux');
  assert.equal(kf.state().queue[0].singer, 'Léa · T1');
  assert.equal(kf.state().queue[0].options.pitch, -2);
  bridge.addBattle(70003);
  await until(() => kf.state().queue.length === 2 && bridge.queue.length === 2, 'Battle ajoutée');
  assert.equal(kf.state().queue[1].options.mod.data.battle.subtype, 1);
  bridge.remove(bridge.queue[1].queueId);
  await until(() => kf.state().queue.length === 1 && bridge.queue.length === 1, 'Battle retirée');
  bridge.play();
  await until(() => bridge.status?.kcsState === 4, 'lecture');
  assert.equal(bridge.status.pitch, -2, 'réglage de l’ajout appliqué au démarrage');
  bridge.setPitch(1);
  await until(() => bridge.status.pitch === 1, 'tonalité en direct');
  // Aucune coupure pendant le parcours : une demande qui ferait fermer le faux (1011) se verrait ici.
  assert.equal(bridge.events.some(e => e.name === 'connexion-perdue'), false, 'aucune coupure avant la fermeture');
  // KaraFun fermé (AppLeftEvent), puis rouvert sur le même port : le pont se reconnecte seul.
  kf.close();
  await until(() => !bridge.ready, 'KaraFun fermé');
  const again = await fake(t, { port: kf.port });
  await until(() => bridge.ready, 'reconnexion', 15000);
  assert.equal(bridge.protocol, 'kcs');
  assert.deepEqual(again.state().queue, [], 'nouveau KaraFun : file vide');
});
