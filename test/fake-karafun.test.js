'use strict';
// Faux KaraFun KCS (fake-karafun.js, issue #59) branché sur le vrai WebSocket de
// Node : celui que kcs-transport.js ouvre avec le vrai KaraFun du bar. Les autres
// tests du protocole remplacent ce WebSocket par un faux ; ici, une coupure du
// WebSocket de Node ou du faux échoue. Aucun accès au vrai KaraFun, aucun vrai code.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { test } = require('node:test');
const { startFakeKaraFun } = require('../fake-karafun');
const { KcsTransport } = require('../kcs-transport');
const { KaraFunBridge } = require('../karafun');

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
async function fake(t, options = {}) {
  const port = options.port ?? await freePort();
  const kf = await startFakeKaraFun({ port, code: CODE, songSeconds: 60, autoplay: false, ...options });
  t.after(() => kf.close());
  return { ...kf, port, url: (code = CODE) => `ws://127.0.0.1:${port}/kcs/${code}` };
}
// WebSocket de Node : messages reçus dans l'ordre, ouverture et fermeture attendues.
function open(url, protocols = SUBPROTOCOL) {
  const ws = new WebSocket(url, protocols);
  const received = [];
  ws.addEventListener('message', event => received.push(JSON.parse(String(event.data))));
  const opened = new Promise(resolve => ws.addEventListener('open', () => resolve(true), { once: true }));
  const closed = new Promise(resolve => ws.addEventListener('close', event => resolve(event.code), { once: true }));
  // Poignée de main refusée : Node 26 signale une erreur puis la fermeture 1006,
  // Node 23 l'erreur seulement.
  const failed = new Promise(resolve => {
    ws.addEventListener('error', () => resolve('erreur'), { once: true });
    ws.addEventListener('close', event => resolve(`fermé ${event.code}`), { once: true });
  });
  return { ws, received, opened, closed, failed, send: message => ws.send(JSON.stringify(message)) };
}

// protects=la poignée de main KCS (sous-protocole kcpj~v3+emuping renvoyé par le faux) ; fails_when=le faux
// accepte un client sans le sous-protocole, ou ne le renvoie pas et le WebSocket de Node refuse ;
// no_claim=la poignée de main du vrai KaraFun (wss, jeton dans l'adresse), que seul l'essai réel montre.
test('poignée de main : sous-protocole KCS négocié, refus sans lui', async t => {
  const kf = await fake(t);
  const good = open(kf.url());
  assert.equal(await good.opened, true);
  assert.equal(good.ws.protocol, SUBPROTOCOL);
  good.ws.close();
  const bad = open(kf.url(), []);
  const outcome = await Promise.race([bad.opened.then(() => 'ouvert'), bad.failed]);
  assert.match(outcome, /^(erreur|fermé 1006)$/, 'sans sous-protocole : 400, jamais ouvert');
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
  assert.equal(after[2].payload.permissions.shownTypes.battle, true);
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
  assert.equal(await c.closed, 4404);
});

// Poignée de main à la main, sur un socket TCP : trames que le WebSocket de Node n'enverrait jamais.
function rawSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET /kcs/${CODE} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
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
  const cases = [
    ['non masquée', frame(0x81, 2, Buffer.from('{}')), 1002],
    ['fragmentée', frame(0x01, 0x80 | 2, masked('{}')), 1002],
    ['plus de 1 Mio', (() => { const length = Buffer.alloc(8); length.writeBigUInt64BE(2n * 1024n * 1024n); return frame(0x81, 0x80 | 127, length); })(), 1009],
  ];
  for (const [name, bytes, code] of cases) {
    const { socket, head, closeCode } = await rawSocket(kf.port);
    t.after(() => socket.destroy());
    assert.match(head, /^HTTP\/1\.1 101 /, name);
    assert.match(head, new RegExp(`Sec-WebSocket-Protocol: ${SUBPROTOCOL.replace(/[+~]/g, '\\$&')}`), name);
    socket.write(bytes);
    assert.equal(await closeCode, code, name);
  }
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
  // KaraFun fermé (AppLeftEvent), puis rouvert sur le même port : le pont se reconnecte seul.
  kf.close();
  await until(() => !bridge.ready, 'KaraFun fermé');
  const again = await fake(t, { port: kf.port });
  await until(() => bridge.ready, 'reconnexion', 15000);
  assert.equal(bridge.protocol, 'kcs');
  assert.deepEqual(again.state().queue, [], 'nouveau KaraFun : file vide');
});
