'use strict';
/*
 * Faux KaraFun pour essayer le programme sans KaraFun (mode démo) et pour les tests.
 * Il parle la télécommande actuelle de KaraFun (KCS) : du JSON sur un WebSocket,
 * sous-protocole kcpj~v3+emuping, à ws://127.0.0.1:<port>/kcs/<code>. L'ordre et la
 * forme des messages sont ceux du vrai KaraFun, relevés le 6 novembre 2026 (issue
 * #59) : AuthenticatedEvent, puis, à la demande de nom, l'état, la file, les droits,
 * les préférences, la configuration et l'accord sur le nom ; un PingRequest chaque
 * seconde. Les réponses aux réglages de titre et les états 4 (lecture) et 5 (pause)
 * n'y ont pas été vus : le faux répond à chaque commande, sans erreur inventée.
 * Commandes : ajout (options à l'ajout, Battle), retrait, déplacement, lecture,
 * suivant, options d'un titre de la file (remplacées en entier), tonalité, tempo et
 * volume des voix du titre en cours ; chaque titre annonce ses pistes vocales
 * (4 chœurs, 5, 6 voix guides). Un titre est annoncé sans être chargé (état 1), se
 * charge (2), est prêt (3) puis joue (4). Les chansons « durent » songSeconds
 * secondes. La recherche passe par HTTP, comme sur le site de KaraFun.
 * Serveur WebSocket minimal (RFC 6455) écrit avec la bibliothèque standard de Node,
 * sans dépendance, sur la boucle locale seulement. Il tourne dans le processus de la
 * démo : un client maladroit ou hostile (page web, valeur piégée) est refusé, jamais
 * une exception qui ferait tomber la démo.
 */
const http = require('http');
const crypto = require('crypto');

const CATALOG = [
  ['Toxic', 'Britney Spears'], ['Les lacs du Connemara', 'Michel Sardou'], ['Bohemian Rhapsody', 'Queen'],
  ['Wannabe', 'Spice Girls'], ['Alexandrie Alexandra', 'Claude François'], ['I Will Survive', 'Gloria Gaynor'],
  ['Djadja', 'Aya Nakamura'], ['Dancing Queen', 'ABBA'], ['La Bohème', 'Charles Aznavour'],
  ['Shallow', 'Lady Gaga & Bradley Cooper'], ['Mistral gagnant', 'Renaud'], ['Toi + Moi', 'Grégoire'],
  ["Livin' on a Prayer", 'Bon Jovi'], ["Don't Stop Me Now", 'Queen'], ['Femme Like U', 'K-Maro'],
  ['Je te promets', 'Johnny Hallyday'], ['Quand la musique est bonne', 'Jean-Jacques Goldman'],
  ["Pour que tu m'aimes encore", 'Céline Dion'], ['Hey Jude', 'The Beatles'], ['Sweet Caroline', 'Neil Diamond'],
  ['Le Sud', 'Nino Ferrer'], ['Wonderwall', 'Oasis'], ['Rolling in the Deep', 'Adele'], ['Someone Like You', 'Adele'],
  ['Emmenez-moi', 'Charles Aznavour'], ['Les démons de minuit', 'Images'], ['Tout le bonheur du monde', 'Sinsemilia'],
  ["L'aventurier", 'Indochine'], ['Ça plane pour moi', 'Plastic Bertrand'], ['Dernière danse', 'Indila'],
  ['Balance ton quoi', 'Angèle'], ['Tous les mêmes', 'Stromae'], ['Papaoutai', 'Stromae'], ['Zombie', 'The Cranberries'],
  ['Africa', 'Toto'], ['Take On Me', 'a-ha'], ['Total Eclipse of the Heart', 'Bonnie Tyler'], ['Waterloo', 'ABBA'],
  ['Mamma Mia', 'ABBA'], ['Hotel California', 'Eagles'], ['La Grenade', 'Clara Luciani'], ['Formidable', 'Stromae'],
  ['Les Champs-Élysées', 'Joe Dassin'], ["L'Été indien", 'Joe Dassin'], ['Où sont les femmes ?', 'Patrick Juvet'],
  ['Voyage, voyage', 'Desireless'], ['Ella, elle l\'a', 'France Gall'], ['Résiste', 'France Gall'],
  ['Sympathique', 'Pink Martini'], ['Nuit de folie', 'Début de Soirée'],
].map(([title, artist], i) => ({ songId: 70000 + i, title, artist, img: null, duration: 200 }));

// Pistes vocales d'un titre, dans les proportions vues sur la file du bar :
// chœurs et guide, guide seul, duo avec chœurs, duo sans chœurs.
function songTracksFor(songId) {
  const n = Math.abs(Number(songId) || 0) % 8;
  return n < 4 ? [4, 5] : n < 6 ? [5] : n === 6 ? [4, 5, 6] : [5, 6];
}
const DEFAULT_VOLUMES = Object.freeze({ 4: 100, 5: 0, 6: 0 });
// État en direct d'un titre qui démarre : ses options, sinon les valeurs de KaraFun.
function liveFrom(options = {}) {
  const volumes = { ...DEFAULT_VOLUMES };
  for (const row of Array.isArray(options.tracks) ? options.tracks : []) {
    if (Number.isInteger(row?.track?.type) && Number.isFinite(row.volume)) volumes[row.track.type] = row.volume;
  }
  return { pitch: Number.isInteger(options.pitch) ? options.pitch : 0, tempo: Number.isInteger(options.tempo) ? options.tempo : 0, volumes };
}

// ---------------------------------------------------------------- WebSocket
const SUBPROTOCOL = 'kcpj~v3+emuping';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;

// Trame envoyée par le serveur : jamais masquée, longueur sur 7, 16 ou 64 bits.
function wsFrame(opcode, payload) {
  const data = Buffer.from(payload);
  let head;
  if (data.length < 126) head = Buffer.from([0x80 | opcode, data.length]);
  else if (data.length < 65536) {
    head = Buffer.alloc(4);
    head.writeUInt16BE(data.length, 2);
    head[1] = 126;
  } else {
    head = Buffer.alloc(10);
    head.writeBigUInt64BE(BigInt(data.length), 2);
    head[1] = 127;
  }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, data]);
}

// Connexion acceptée : messages texte, ping, pong et fermeture. Une trame hors de
// ce sous-ensemble (fragmentée, non masquée, bits réservés, opcode inconnu) ferme
// la connexion par 1002, un message de plus de 1 Mio par 1009 : un faux qui
// accepterait tout cacherait un client fautif.
class WsConnection {
  constructor(socket, { onText, onClose }) {
    this.socket = socket;
    this.onText = onText;
    this.onClose = onClose;
    this.buffer = Buffer.alloc(0);
    this.open = true;
    this.notified = false;
    socket.on('data', chunk => this.read(chunk));
    socket.on('error', () => { /* la fermeture suit */ });
    // Pair qui ferme son côté sans trame de fermeture : connexion coupée.
    socket.on('end', () => {
      this.open = false;
      socket.destroy();
    });
    socket.on('close', () => {
      this.open = false;
      this._notify(1006);
    });
  }

  send(text) {
    if (this.open && !this.socket.destroyed) this.socket.write(wsFrame(0x1, text));
  }

  // Trame de fermeture, puis plus rien n'est lu ; un pair qui ne ferme pas de son
  // côté est coupé au bout d'une seconde, avec ce qu'il envoie encore.
  close(code = 1000) {
    if (!this.open) return;
    this.open = false;
    this.buffer = Buffer.alloc(0);
    const status = Buffer.alloc(2);
    status.writeUInt16BE(code);
    this.socket.end(wsFrame(0x8, status));
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this._notify(code);
  }

  _notify(code) {
    if (this.notified) return;
    this.notified = true;
    this.onClose(code);
  }

  read(chunk) {
    if (!this.open) return;
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.open && this.buffer.length >= 2) {
      const first = this.buffer[0], second = this.buffer[1];
      const opcode = first & 0x0f;
      if (!(first & 0x80) || (first & 0x70) || !(second & 0x80) || ![0x1, 0x8, 0x9, 0xa].includes(opcode)) {
        this.close(1002);
        return;
      }
      let length = second & 0x7f, offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) { this.close(1009); return; }
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_MESSAGE) { this.close(1009); return; }
      if (opcode >= 0x8 && length > 125) { this.close(1002); return; }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      this.buffer = this.buffer.subarray(offset + 4 + length);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      if (opcode === 0x1) {
        // Dernier filet : une demande imprévue ferme la connexion (1011), jamais la démo.
        try { this.onText(payload.toString('utf8')); } catch { this.close(1011); }
      } else if (opcode === 0x9) this.socket.write(wsFrame(0xa, payload));
      else if (opcode === 0x8) this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
    }
  }
}

// Poignée de main : GET /kcs/<code>, WebSocket 13 et sous-protocole KCS demandés.
// Rend le code de l'adresse, ou null après avoir refusé la demande, puis coupé la
// connexion. Le WebSocket de Node n'envoie pas d'en-tête Origin, un navigateur
// toujours : une page web ne parle jamais au faux (403).
function acceptUpgrade(req, socket) {
  const refuse = status => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
    return null;
  };
  if (req.headers.origin !== undefined) return refuse('403 Forbidden');
  const key = String(req.headers['sec-websocket-key'] || '');
  const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(protocol => protocol.trim());
  let path, code;
  try { path = /^\/kcs\/([^/]+)$/.exec(new URL(req.url, 'http://localhost').pathname); } catch { return refuse('400 Bad Request'); }
  if (req.method !== 'GET' || !path || String(req.headers.upgrade || '').toLowerCase() !== 'websocket'
    || req.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || !protocols.includes(SUBPROTOCOL)) {
    return refuse('400 Bad Request');
  }
  try { code = decodeURIComponent(path[1]); } catch { return refuse('400 Bad Request'); }
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${crypto.createHash('sha1').update(key + WS_GUID).digest('base64')}`,
    `Sec-WebSocket-Protocol: ${SUBPROTOCOL}`, '', ''].join('\r\n'));
  socket.setNoDelay(true);
  return code;
}

// ---------------------------------------------------------------- KCS
// Valeurs du vrai KaraFun, relevées le 6 novembre 2026.
const PERMISSIONS = Object.freeze({ manageQueue: true, viewQueue: true, addToQueue: true, managePlayback: true,
  manageVolumes: true, sendPhotos: true, shownTypes: Object.freeze({ karaoke: true, community: false, quiz: false, battle: true }) });
const PREFERENCES = Object.freeze({ askOptions: false, singerRotation: false });
const CONFIGURATION = Object.freeze({ pitchStep: 1, pitchMin: -6, pitchMax: 6, tempoStep: 5, tempoMin: -50, tempoMax: 50,
  compatibleMods: Object.freeze({ battle: Object.freeze([1, 2]) }) });

function startFakeKaraFun({ port = 4001, code = '123456', songSeconds = 30, autoplay = true, pingMs = 1000, log = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
    const m = u.pathname.match(/^\/(\d+)\/?$/);
    if (m && u.searchParams.get('type') === 'search') {
      const q = String(u.searchParams.get('q') || '').toLowerCase();
      const out = CATALOG.filter(s => (s.title + ' ' + s.artist).toLowerCase().includes(q)).slice(0, 20);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    res.writeHead(404); res.end('fake karafun');
  });

  let queue = [];          // [{queueId, songId, title, artist, singer, status, songTracks, options}]
  let state = 'infoscreen';
  let timer = null;
  let qid = 1;
  let live = liveFrom();
  const clients = new Set(); // connexions dont le code est le bon

  const withIds = () => queue.map((it, i) => ({ ...it, id: i }));
  const playingItem = () => state === 'playing' && queue[0] ? queue[0] : null;
  // Titre de la file tel que KaraFun l'envoie : options complètes, `tracks` vide
  // sans réglage de voix ; une Battle n'a que son mode.
  const kcsItem = it => ({ id: String(it.queueId), song: { id: { id: it.songId, type: 1 }, title: it.title, artist: it.artist,
    options: it.options?.mod ? { ...it.options } : { singer: it.singer, tracks: [], ...it.options },
    songTracks: it.songTracks.map(type => ({ type })) } });
  // État de la télécommande : 1 titre annoncé (ou file vide), 2 chargement,
  // 3 prêt, 4 lecture. Pistes, tonalité et tempo à partir du chargement.
  const statusPayload = (kcsState = state === 'playing' ? 4 : 1) => {
    const cur = queue[0] || null;
    const loaded = !!cur && kcsState >= 2;
    return { state: kcsState, ...(cur ? { current: kcsItem(cur) } : {}), pitch: loaded ? live.pitch : 0, tempo: loaded ? live.tempo : 0,
      tracks: loaded ? cur.songTracks.map(type => ({ track: { type }, volume: live.volumes[type] ?? 0 })) : [] };
  };
  const send = (client, type, payload = {}, id) => client.ws.send(JSON.stringify({ ...(id === undefined ? {} : { id }), type, payload }));
  const toAll = (type, payload) => { for (const client of clients) if (client.named) send(client, type, payload); };
  const sendStatus = kcsState => toAll('remote.StatusEvent', { status: statusPayload(kcsState) });
  const broadcast = () => { toAll('remote.QueueEvent', { queue: { items: queue.map(kcsItem) } }); sendStatus(); };

  function playFirst(manual = false) {
    clearTimeout(timer);
    if (!queue.length) { state = 'infoscreen'; broadcast(); return; }
    // Une Battle en attente laisse d'abord les téléphones rejoindre. Le faux
    // KaraFun ne la lance que lorsque le bar demande explicitement la lecture.
    if (queue[0].options?.mod?.data?.battle && !manual) {
      state = 'infoscreen'; broadcast(); return;
    }
    // Comme KaraFun : le titre est d'abord annoncé sans être chargé (état 1,
    // pistes vides et réglages d'origine), puis il se charge, est prêt et joue.
    state = 'infoscreen';
    sendStatus(1);
    queue[0].status = 'playing';
    live = liveFrom(queue[0].options);
    toAll('remote.QueueEvent', { queue: { items: queue.map(kcsItem) } });
    sendStatus(2);
    sendStatus(3);
    state = 'playing';
    log(`[faux KaraFun] lecture : ${queue[0].title} (${queue[0].singer})`);
    sendStatus(4);
    timer = setTimeout(() => {
      const wasBattle = !!queue.shift()?.options?.mod?.data?.battle;
      if (autoplay && !wasBattle) playFirst();
      else { state = 'infoscreen'; broadcast(); }
    }, songSeconds * 1000);
  }

  // Valeurs des demandes, lues seulement si elles ont le bon type : jamais de
  // conversion forcée d'un objet, qui pourrait lever une exception.
  const textOf = value => (typeof value === 'string' ? value : Number.isFinite(value) ? String(value) : null);
  const numberOf = value => (Number.isFinite(value) ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null);
  const objectOf = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

  // Demandes du client. Chaque commande reçoit sa réponse (<Nom>Response, même
  // identifiant) avant les événements, comme AddToQueueResponse le 6 novembre.
  function receive(client, text) {
    let message;
    try { message = JSON.parse(text); } catch { client.ws.close(1002); return; }
    if (!message || typeof message.type !== 'string') { client.ws.close(1002); return; }
    const { id, type } = message, p = objectOf(message.payload) || {};
    const reply = () => send(client, type.replace(/Request$/, 'Response'), {}, id);
    const refuse = reason => send(client, 'Error', { type: 1, message: reason }, id);
    const itemOf = queueItemId => queue.find(it => String(it.queueId) === textOf(queueItemId));
    switch (type) {
      case 'core.PingResponse':
      case 'core.TimestampResponse':
        return;
      case 'remote.UpdateUsernameRequest': {
        const username = textOf(p.username);
        if (!username) { refuse('Invalid username'); return; }
        // Nom tenu par une autre connexion : refus sans identifiant, comme KaraFun.
        if ([...clients].some(other => other !== client && other.username === username)) {
          send(client, 'Error', { type: 4, message: 'username is already used' });
          return;
        }
        const first = !client.named;
        client.username = username;
        client.named = true;
        if (first) {
          send(client, 'remote.StatusEvent', { status: statusPayload() });
          send(client, 'remote.QueueEvent', { queue: { items: queue.map(kcsItem) } });
          send(client, 'remote.PermissionsUpdateEvent', { permissions: PERMISSIONS });
          send(client, 'remote.PreferencesUpdateEvent', { preferences: PREFERENCES });
          send(client, 'remote.ConfigurationUpdateEvent', { configuration: CONFIGURATION });
        }
        send(client, 'remote.UsernameUpdateEvent', { username });
        reply();
        return;
      }
      case 'remote.AddToQueueRequest': {
        const songId = numberOf(objectOf(p.song)?.id);
        if (songId === null) { refuse('Invalid song'); return; }
        const song = CATALOG.find(s => s.songId === songId) || { songId, title: `Chanson ${songId}`, artist: '?' };
        const options = objectOf(p.options) ? structuredClone(p.options) : {};
        const item = { queueId: qid++, songId: song.songId, title: song.title, artist: song.artist,
          singer: textOf(options.singer) || '', status: 'ready', songTracks: songTracksFor(song.songId), options };
        const pos = Math.max(0, Math.min(queue.length, numberOf(p.position) || queue.length));
        queue.splice(Math.max(pos, state === 'playing' ? 1 : 0), 0, item);
        reply();
        if (state !== 'playing' && autoplay) playFirst(); else broadcast();
        return;
      }
      case 'remote.RemoveFromQueueRequest': {
        const i = queue.findIndex(it => String(it.queueId) === textOf(p.queueItemId));
        if (i > 0 || (i === 0 && state !== 'playing')) queue.splice(i, 1);
        reply();
        broadcast();
        return;
      }
      case 'remote.MoveInQueueRequest': {
        const i = queue.findIndex(it => String(it.queueId) === textOf(p.queueItemId));
        if (i > 0) { const [it] = queue.splice(i, 1); queue.splice(Math.max(1, numberOf(p.to) || 0), 0, it); }
        reply();
        broadcast();
        return;
      }
      // Options d'un titre de la file : remplacées en entier, comme KaraFun. Titre
      // inconnu : rien ne change, et le faux répond quand même.
      case 'remote.SetQueueItemOptionsRequest': {
        const item = itemOf(p.queueItemId);
        if (item) {
          item.options = { ...(objectOf(p.options) || {}) };
          if (item === playingItem()) live = liveFrom(item.options);
        }
        reply();
        broadcast();
        return;
      }
      case 'remote.PitchRequest':
        if (playingItem() && Number.isInteger(p.pitch)) live.pitch = p.pitch;
        reply();
        broadcast();
        return;
      case 'remote.TempoRequest':
        if (playingItem() && Number.isInteger(p.tempo)) live.tempo = p.tempo;
        reply();
        broadcast();
        return;
      case 'remote.TrackVolumeRequest': {
        const cur = playingItem(), volume = numberOf(p.volume);
        if (cur && cur.songTracks.includes(p.type) && volume !== null) live.volumes[p.type] = volume;
        reply();
        broadcast();
        return;
      }
      case 'remote.PlayRequest':
        reply();
        if (state !== 'playing') playFirst(true);
        return;
      case 'remote.NextRequest':
        reply();
        if (state === 'playing') { queue.shift(); state = 'infoscreen'; clearTimeout(timer); broadcast(); }
        return;
      default:
        if (id !== undefined) refuse('Unknown request');
    }
  }

  server.on('upgrade', (req, socket, head) => {
    // Le serveur HTTP retire son écouteur d'erreur avant « upgrade » : sans le
    // nôtre, un client qui coupe pendant le refus ferait tomber toute la démo.
    socket.on('error', () => { /* connexion coupée par le client */ });
    const wanted = acceptUpgrade(req, socket);
    if (wanted === null) return;
    const client = { ws: null, username: null, named: false, pingId: 0, pings: null };
    client.ws = new WsConnection(socket, {
      onText: text => receive(client, text),
      onClose: () => { clearInterval(client.pings); clients.delete(client); },
    });
    // Mauvais code : KaraFun ferme la connexion (4404), le pont relit son code.
    if (wanted !== code) { client.ws.close(4404); return; }
    clients.add(client);
    send(client, 'core.AuthenticatedEvent');
    client.pings = setInterval(() => send(client, 'core.PingRequest', {}, ++client.pingId), pingMs);
    client.pings.unref();
    if (head?.length) client.ws.read(head);
  });

  // Boucle locale seulement (deux modes) : ses commandes ne sont pas authentifiées.
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${port}`, code,
    // KaraFun qu'on quitte : AppLeftEvent, puis fermeture de chaque connexion.
    close: () => {
      clearTimeout(timer);
      for (const client of [...clients]) {
        if (client.named) send(client, 'remote.AppLeftEvent');
        client.ws.close(1001);
      }
      server.close();
      server.closeAllConnections?.();
    },
    // pour les tests : ajouter une chanson « à la main » comme le ferait le bar dans KaraFun
    manualAdd: (songId, singer) => { const s = CATALOG.find(x => x.songId === songId) || CATALOG[0]; queue.push({ queueId: qid++, songId: s.songId, title: s.title, artist: s.artist, singer, status: 'ready', songTracks: songTracksFor(s.songId) }); broadcast(); },
    skip: () => { if (state === 'playing') {
      const wasBattle = !!queue.shift()?.options?.mod?.data?.battle;
      clearTimeout(timer);
      if (autoplay && !wasBattle) playFirst();
      else { state = 'infoscreen'; broadcast(); }
    } },
    state: () => ({ state, queue: withIds() }),
  })));
}

module.exports = { startFakeKaraFun, CATALOG };

if (require.main === module) {
  startFakeKaraFun({ log: console.log }).then(f => console.log(`Faux KaraFun sur ${f.base}, code ${f.code}`));
}
