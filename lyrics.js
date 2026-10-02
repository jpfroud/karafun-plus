'use strict';
// Paroles d'un titre, pour vérifier qu'on le connaît avant de le choisir.
// KaraFun n'expose pas les paroles par sa télécommande : elles sont lues sur
// la page publique du titre (www.karafun.fr/karaoke/<artiste>/<titre>/), comme
// le ferait un navigateur. Le titre est retrouvé par son identifiant KaraFun ;
// à défaut, par son titre exact. Aucune donnée de la soirée n'est envoyée.

const BASE = 'https://www.karafun.fr';
const SONG_PATH = /^\/karaoke\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/$/;
const MAX_LINES = 400;
const MAX_PAGES = 5;             // pages de titres lues au plus par recherche
const MAX_PARALLEL = 2;          // lectures simultanées sur www.karafun.fr
const MAX_WAITING = 20;          // au-delà, « indisponible pour le moment »
const MISS_TTL_MS = 30 * 60000;  // titre introuvable ou version voisine
const FAILURE_TTL_MS = 2 * 60000; // site injoignable

// Même règle que les adresses du site : accents retirés, minuscules, tout
// le reste devient un tiret.
function slug(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };
function decode(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === '#') {
      const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

// Page d'un titre : identifiant, titre affiché et paroles ligne à ligne.
function parsePage(html) {
  const text = String(html || '');
  const start = text.search(/class="[^"]*\blyrics\b[^"]*\bjs-lyrics\b/);
  const id = start >= 0 ? /data-song-id="(\d+)"/.exec(text.slice(start, start + 400))?.[1] : null;
  const pageTitle = decode(/<title>([^<]*)<\/title>/i.exec(text)?.[1] || '').trim();
  if (start < 0) return { songId: id ? Number(id) : null, pageTitle, lines: [] };
  // Le bloc des paroles s'arrête à ses boutons d'édition ; la page répète
  // parfois les paroles plus bas dans un formulaire.
  let end = text.indexOf('js-lyrics__action', start);
  if (end < 0) end = Math.min(text.length, start + 200000);
  const block = text.slice(start, end);
  const joined = [...block.matchAll(/<p\b[^>]*\bdata-original="([^"]*)"/g)].map(match => decode(match[1])).join('');
  const lines = [];
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
    // Une ligne vide sépare deux couplets ; jamais deux de suite.
    if (!line && (!lines.length || lines.at(-1) === '')) continue;
    lines.push(line);
    if (lines.length >= MAX_LINES) break;
  }
  while (lines.at(-1) === '') lines.pop();
  return { songId: id ? Number(id) : null, pageTitle, lines };
}

// Liens vers des pages de titres dans une page de résultats du site.
function songLinks(html, base = BASE) {
  const out = [];
  for (const match of String(html || '').matchAll(/href="([^"]+)"/g)) {
    let url;
    try { url = new URL(decode(match[1]), base); } catch (_) { continue; }
    if (url.origin !== new URL(base).origin || !SONG_PATH.test(url.pathname)) continue;
    const path = url.pathname;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

class Lyrics {
  constructor({ fetchImpl = globalThis.fetch, base = BASE, timeoutMs = 8000, cacheSize = 300, now = Date.now } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch manquant');
    this.fetchImpl = fetchImpl;
    this.base = new URL(base).origin;
    this.timeoutMs = timeoutMs;
    this.cacheSize = cacheSize;
    this.now = now;
    this.cache = new Map();
    this.inflight = new Map(); // même recherche demandée par plusieurs téléphones
    this.active = 0;
    this.waiting = [];
  }

  // Au plus MAX_PARALLEL lectures à la fois : un téléphone ne peut pas faire
  // inonder www.karafun.fr par le PC du bar.
  async _slot() {
    if (this.active < MAX_PARALLEL) { this.active++; return; }
    if (this.waiting.length >= MAX_WAITING) throw new Error('trop de demandes');
    await new Promise(resolve => this.waiting.push(resolve));
  }

  _release() {
    const next = this.waiting.shift();
    if (next) next(); else this.active--;
  }

  async _get(path) {
    await this._slot();
    try {
      const response = await this.fetchImpl(new URL(path, this.base).href, {
        signal: AbortSignal.timeout(this.timeoutMs), headers: { Accept: 'text/html', 'Accept-Language': 'fr' } });
      // Une redirection hors du site ne vaut pas une page de titre.
      if (response.url && new URL(response.url).origin !== this.base) return null;
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } finally { this._release(); }
  }

  _cached(key) {
    const row = this.cache.get(key);
    return row && (!row.expiresAt || this.now() < row.expiresAt) ? row.value : null;
  }

  _remember(key, value, ttlMs = 0) {
    this.cache.delete(key);
    this.cache.set(key, { value, expiresAt: ttlMs ? this.now() + ttlMs : 0 });
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value);
    return value;
  }

  // { lines, url, exact, unavailable? } : `lines` vide si la page n'a pas de
  // paroles, `null` si le titre est introuvable (le lien mène alors à la
  // recherche) ; `unavailable` si le site n'a pas répondu.
  async find({ songId = null, title, artist = '' }) {
    if (!String(title || '').trim()) throw new Error('Titre manquant.');
    const id = Number(songId) > 0 ? Number(songId) : null;
    const titleSlug = slug(title), artistSlug = slug(artist);
    const searchPath = `/search/?query=${encodeURIComponent(`${title} ${artist}`.trim())}`;
    // Titre sans lettre latine (cyrillique, japonais…) : pas d'adresse à
    // deviner, la recherche du site fait mieux.
    if (!titleSlug) return { lines: null, url: new URL(searchPath, this.base).href, exact: false };
    // Seule une page dont l'identifiant correspond est rangée sous cet
    // identifiant : un titre inventé ne peut pas remplacer les paroles.
    const exactKey = id ? `id:${id}` : null;
    const key = `t:${id || ''}|${titleSlug}|${artistSlug}`;
    const known = (exactKey && this._cached(exactKey)) || this._cached(key);
    if (known) return known;
    if (!this.inflight.has(key)) {
      this.inflight.set(key, this._lookup({ id, title, titleSlug, artistSlug, searchPath, exactKey, key })
        .finally(() => this.inflight.delete(key)));
    }
    return this.inflight.get(key);
  }

  async _lookup({ id, titleSlug, artistSlug, searchPath, exactKey, key }) {
    const tried = new Set();
    let fallback = null;
    const check = async path => {
      if (tried.has(path) || tried.size >= MAX_PAGES) return null;
      tried.add(path);
      const html = await this._get(path);
      if (html == null) return null;
      const page = parsePage(html);
      const value = { lines: page.lines, url: new URL(path, this.base).href, exact: !!id && page.songId === id };
      if (value.exact || (!id && page.songId)) return value;
      // Identifiant différent : même titre exact, mais peut-être une autre
      // version. Gardé seulement si aucune page ne correspond mieux.
      if (!fallback && page.lines.length && slug(page.pageTitle).includes(titleSlug)) fallback = { ...value, exact: false };
      return null;
    };
    try {
      let found = artistSlug ? await check(`/karaoke/${artistSlug}/${titleSlug}/`) : null;
      if (!found) {
        const results = await this._get(searchPath);
        const links = songLinks(results, this.base);
        const rank = path => { const songPart = SONG_PATH.exec(path)[2];
          return songPart === titleSlug ? 0 : songPart.startsWith(`${titleSlug}-`) ? 1 : songPart.includes(titleSlug) ? 2 : 3; };
        for (const path of links.filter(path => rank(path) < 3).sort((a, b) => rank(a) - rank(b))) {
          found = await check(path);
          if (found) break;
        }
      }
      if (found?.exact) return this._remember(exactKey, found);
      if (found) return this._remember(key, found);
      return this._remember(key, fallback || { lines: null, url: new URL(searchPath, this.base).href, exact: false }, MISS_TTL_MS);
    } catch (_) {
      return this._remember(key, { lines: null, url: new URL(searchPath, this.base).href, exact: false, unavailable: true }, FAILURE_TTL_MS);
    }
  }
}

module.exports = { Lyrics, parsePage, songLinks, slug };
