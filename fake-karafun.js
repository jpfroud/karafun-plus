'use strict';
/*
 * Faux KaraFun pour essayer le programme sans KaraFun (mode démo) et pour les tests.
 * Imite la télécommande : socket.io v2, 'authenticate', événements queue/status,
 * commandes queueAdd/queueRemove/queueMove/play/next, et la recherche HTTP.
 * Les chansons « durent » SONG_SECONDS secondes.
 */
const http = require('http');

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

function startFakeKaraFun({ port = 4001, code = '123456', songSeconds = 30, autoplay = true, log = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const m = u.pathname.match(/^\/(\d+)\/?$/);
    if (m && u.searchParams.get('type') === 'search') {
      const q = String(u.searchParams.get('q') || '').toLowerCase();
      const out = CATALOG.filter(s => (s.title + ' ' + s.artist).toLowerCase().includes(q)).slice(0, 20);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(out));
    }
    res.writeHead(404); res.end('fake karafun');
  });
  const io = require('socket.io')(server, { serveClient: false });

  let queue = [];          // [{queueId, songId, title, artist, singer, status}]
  let state = 'infoscreen';
  let timer = null;
  let startedAt = 0;
  let qid = 1;

  const withIds = () => queue.map((it, i) => ({ ...it, id: i }));
  const statusPayload = () => {
    const cur = state === 'playing' && queue[0] ? queue[0] : null;
    return { state, songPlaying: cur ? { title: cur.title, artist: cur.artist, singer: cur.singer, songId: cur.songId, queueId: cur.queueId } : null, position: cur ? Math.round((Date.now() - startedAt) / 1000) : 0 };
  };
  const broadcast = () => { io.emit('queue', withIds()); io.emit('status', statusPayload()); };

  function playFirst() {
    clearTimeout(timer);
    if (!queue.length) { state = 'infoscreen'; broadcast(); return; }
    state = 'playing';
    startedAt = Date.now();
    queue[0].status = 'playing';
    log(`[faux KaraFun] lecture : ${queue[0].title} (${queue[0].singer})`);
    broadcast();
    timer = setTimeout(() => { queue.shift(); if (autoplay) playFirst(); else { state = 'infoscreen'; broadcast(); } }, songSeconds * 1000);
  }

  io.on('connection', (socket) => {
    const remote = String((socket.handshake.query || {}).remote || '');
    socket.on('authenticate', (p) => {
      if (remote !== `kf${code}` || String(p && p.channel) !== code) { socket.emit('serverUnreacheable'); return; }
      socket.emit('permissions', { addToQueue: true, admin: false });
      socket.emit('preferences', { askSingerName: true });
      socket.emit('status', statusPayload());
      socket.emit('queue', withIds());
    });
    socket.on('queueAdd', (p) => {
      const song = CATALOG.find(s => s.songId === Number(p && p.songId)) || { songId: Number(p && p.songId), title: `Chanson ${p && p.songId}`, artist: '?' };
      const item = { queueId: qid++, songId: song.songId, title: song.title, artist: song.artist, singer: String((p && p.singer) || ''), status: 'ready' };
      const pos = Math.max(0, Math.min(queue.length, Number(p && p.pos) || queue.length));
      queue.splice(Math.max(pos, state === 'playing' ? 1 : 0), 0, item);
      if (state !== 'playing' && autoplay) playFirst(); else broadcast();
    });
    socket.on('queueRemove', (queueId) => {
      const i = queue.findIndex(it => it.queueId === queueId);
      if (i > 0 || (i === 0 && state !== 'playing')) queue.splice(i, 1);
      broadcast();
    });
    socket.on('queueMove', (p) => {
      const i = queue.findIndex(it => it.queueId === p.queueId);
      if (i > 0) { const [it] = queue.splice(i, 1); queue.splice(Math.max(1, p.to), 0, it); }
      broadcast();
    });
    socket.on('next', () => { if (state === 'playing') { queue.shift(); state = 'infoscreen'; clearTimeout(timer); broadcast(); } });
    socket.on('play', () => { if (state !== 'playing') playFirst(); });
  });

  return new Promise((resolve) => server.listen(port, () => resolve({
    base: `http://localhost:${port}`, code, close: () => { clearTimeout(timer); io.close(); server.close(); },
    // pour les tests : ajouter une chanson « à la main » comme le ferait le bar dans KaraFun
    manualAdd: (songId, singer) => { const s = CATALOG.find(x => x.songId === songId) || CATALOG[0]; queue.push({ queueId: qid++, songId: s.songId, title: s.title, artist: s.artist, singer, status: 'ready' }); broadcast(); },
    skip: () => { if (state === 'playing') { queue.shift(); clearTimeout(timer); if (autoplay) playFirst(); else { state = 'infoscreen'; broadcast(); } } },
    state: () => ({ state, queue: withIds() }),
  })));
}

module.exports = { startFakeKaraFun, CATALOG };

if (require.main === module) {
  startFakeKaraFun({ log: console.log }).then(f => console.log(`Faux KaraFun sur ${f.base}, code ${f.code}`));
}
