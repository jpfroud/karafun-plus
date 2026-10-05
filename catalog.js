/* Catalogue HTTP de la télécommande KaraFun. Aucune URL KCS signée ici. */
const CATEGORY_TYPES = new Set(['playlist', 'styles', 'top']);
const HIGHLIGHT_TYPES = new Set(['news', 'featured']);

// Titres de la communauté KaraFun : partagés par ses membres, hors du
// catalogue officiel. La télécommande de KaraFun choisit les types de titres
// listés par le paramètre `types` (« karaoke,battle » relevé le 19 septembre),
// d'après les types permis (`shownTypes` : karaoke, community, quiz, battle).
// Un résultat peut porter son type, qui prime alors sur la demande : un
// identifiant { type, id } comme le SongIdentifier du SDK de la télécommande
// (1 catalogue, 2 communauté), ou un nom (« community », « karaoke »). Un
// nombre seul dans `type` ne dit rien de sûr : il est ignoré.
function songKind(item) {
  if (item?.id && typeof item.id === 'object') {
    const type = Number(item.id.type);
    return type === 2 ? 'community' : type === 1 ? 'catalog' : null;
  }
  for (const raw of [item?.songType, item?.type, item?.kind]) {
    const text = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (text.startsWith('communit')) return 'community';
    if (text === 'karaoke' || text === 'catalog') return 'catalog';
  }
  return null;
}

function positiveId(value) {
  if (!/^\d{1,10}$/.test(String(value ?? ''))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// `community` : liste demandée avec les seuls titres de la communauté.
function normalizeSong(item, { community = false } = {}) {
  if (!item || typeof item !== 'object') return null;
  const songId = positiveId(item.songId ?? (item.id && typeof item.id === 'object' ? item.id.id : item.id));
  const title = String(item.title || '').trim();
  if (!songId || !title) return null;
  const kind = songKind(item) || (community ? 'community' : 'catalog');
  return {
    songId,
    title,
    artist: String(item.artist || '').trim(),
    duration: item.duration != null && Number.isFinite(Number(item.duration)) ? Number(item.duration) : null,
    img: typeof item.img === 'string' ? item.img : null,
    year: item.year != null && Number.isInteger(Number(item.year)) ? Number(item.year) : null,
    isExplicit: item.isExplicit === true,
    ...(kind === 'community' ? { community: true } : {}),
  };
}

function normalizeCategory(item, type) {
  if (!item || typeof item !== 'object') return null;
  const id = positiveId(item.id);
  const name = String(item.name || item.title || '').trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    filter: `${type === 'styles' ? 'st' : 'pl'}_${id}`,
    img: typeof item.img === 'string' ? item.img : null,
  };
}

// Mêmes en-têtes que la recherche (karafun.js), qui passe là où le catalogue était refusé.
const HEADERS = Object.freeze({ Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' });
const validSongPage = data => !!data && Array.isArray(data.songs) &&
  Number.isInteger(Number(data.total)) && Number(data.total) >= 0;

class Catalog {
  // `bases` : domaines KaraFun essayés dans l'ordre, en commençant par le dernier
  // qui a répondu (comme la recherche). `base` seul reste accepté.
  constructor({ base, bases, code, fetchImpl = globalThis.fetch, timeoutMs = 8000, onFailure = null }) {
    const list = Array.isArray(bases) && bases.length ? bases : [base];
    const origins = [...new Set(list.map(b => {
      const origin = new URL(b);
      if (!['http:', 'https:'].includes(origin.protocol)) throw new Error('Origine catalogue invalide');
      return origin.origin;
    }))];
    if (!/^\d{4,12}$/.test(String(code))) throw new Error('Code KaraFun invalide');
    if (typeof fetchImpl !== 'function') throw new Error('fetch manquant');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('Délai invalide');
    if (onFailure != null && typeof onFailure !== 'function') throw new Error('onFailure invalide');
    this.endpoints = origins.map(origin => new URL(`/${code}/`, origin));
    this.baseIdx = 0;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.onFailure = onFailure;
    this.lastFailure = new Map(); // domaine → dernier échec signalé (une ligne par changement)
  }

  async _fetchOne(endpoint, params) {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    let timer;
    const request = (async () => {
      const response = await this.fetchImpl(url.href, { headers: { ...HEADERS }, signal: controller.signal });
      if (!response.ok) throw Object.assign(new Error(`Catalogue KaraFun : HTTP ${response.status}`), { status: response.status, kind: 'http' });
      try { return await response.json(); }
      catch { throw Object.assign(new Error('Catalogue KaraFun : réponse illisible'), { kind: 'json' }); }
    })();
    request.catch(() => {}); // perdue après le délai : pas de rejet non géré
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error('Catalogue KaraFun : timeout'), { kind: 'timeout' }));
      }, this.timeoutMs);
    });
    try { return await Promise.race([request, timeout]); }
    finally { clearTimeout(timer); }
  }

  _report(endpoint, error) {
    const host = endpoint.host;
    const key = error ? `${error.kind || 'network'}:${error.status || ''}` : '';
    if ((this.lastFailure.get(host) || '') === key) return;
    if (key) this.lastFailure.set(host, key); else this.lastFailure.delete(host);
    // Seulement le domaine et le statut : l'URL contient le code de la télécommande.
    if (error && this.onFailure) {
      try { this.onFailure({ host, status: error.status || null, kind: error.kind || 'network' }); } catch { /* journal facultatif */ }
    }
  }

  // Essaie chaque domaine ; une erreur HTTP, un JSON illisible, une coupure, un
  // délai dépassé ou une réponse de forme inattendue passent au domaine suivant.
  async _get(params, isValid = () => true, invalidMessage = 'Réponse du catalogue invalide') {
    let last = null;
    let lastStatus = null;
    for (let k = 0; k < this.endpoints.length; k++) {
      const idx = (this.baseIdx + k) % this.endpoints.length;
      const endpoint = this.endpoints[idx];
      try {
        const data = await this._fetchOne(endpoint, params);
        if (!isValid(data)) throw Object.assign(new Error(invalidMessage), { kind: 'invalid', shape: true });
        this.baseIdx = idx;
        this._report(endpoint, null);
        return data;
      } catch (error) {
        if (!error.kind) error.kind = 'network';
        if (error.status) lastStatus = error.status;
        last = error;
        this._report(endpoint, error);
      }
    }
    // Tout a échoué : un refus HTTP renseigne mieux qu'un délai sur l'autre domaine.
    if (last.shape && !lastStatus) throw new Error(invalidMessage);
    const message = lastStatus ? `Catalogue KaraFun : HTTP ${lastStatus}`
      : last.kind === 'timeout' || last.kind === 'json' ? last.message : 'Catalogue KaraFun : réseau injoignable';
    throw Object.assign(new Error(message), { status: lastStatus, kind: lastStatus ? 'http' : last.kind, catalogUnavailable: true });
  }

  async categories(type) {
    if (!CATEGORY_TYPES.has(type)) throw new Error('Catégorie inconnue');
    const data = await this._get({ type }, Array.isArray, 'Réponse de catégories invalide');
    return data.map((item) => normalizeCategory(item, type)).filter(Boolean);
  }

  async highlights(type, { community = false } = {}) {
    if (!HIGHLIGHT_TYPES.has(type)) throw new Error('Sélection inconnue');
    const data = await this._get({ type, types: community ? 'community' : 'karaoke' }, Array.isArray, 'Réponse de sélection invalide');
    return data.map(item => normalizeSong(item, { community })).filter(Boolean);
  }

  async songs(filter, offset = 0) {
    if (typeof filter !== 'string' || !/^(?:pl|st|si)_\d{1,10}$/.test(filter) ||
        !positiveId(filter.slice(3))) throw new Error('Filtre de catalogue invalide');
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000) throw new Error('Offset invalide');
    const data = await this._get({ type: 'song_list', filter, offset, filters: 'karaoke' }, validSongPage, 'Réponse de chansons invalide');
    return { songs: data.songs.map(item => normalizeSong(item)).filter(Boolean), total: Number(data.total) };
  }
}

module.exports = { Catalog, normalizeSong, normalizeCategory, songKind };
