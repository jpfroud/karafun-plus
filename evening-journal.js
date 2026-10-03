'use strict';
/*
 * Journal de soirée : un fichier par soirée, en ajout seulement.
 *
 *   data/soirees/<eveningId>/journal.jsonl   un événement JSON par ligne
 *   data/soirees/<eveningId>/meta.json       début, fin, prénoms et tables
 *   data/soirees/<eveningId>/summary.json    statistiques écrites à la clôture
 *
 * Les lignes ne portent que des identifiants (personne, table, titre, passage
 * KaraFun) : les prénoms vivent seulement dans meta.json. Jamais de photo, de
 * note privée, de jeton, de secret QR, de clé du bar ni de code KaraFun.
 * Écriture au mieux : une erreur de disque est signalée une fois mais
 * n'arrête jamais la file. Sans dossier (démo, tests), tout reste en mémoire.
 */
const crypto = require('crypto');
const path = require('path');

const FORMAT = 1;
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{4}_[0-9a-f]{4}$/;
const EVENT_PATTERN = /^[a-z][a-zA-Z]*(\.[a-zA-Z]+){0,3}$/;
const EARLY_LIMIT = 500;        // événements gardés avant l'ouverture
// Champs jamais écrits, même si un appelant les fournit par erreur.
const PRIVATE_KEY = /^(names?|label|labels|singer|token|tokens|secret|code|key|staffKey|photo|photoUrl|privateNote|note|access|invitation|link|cookie|url|qr|hash|password)$/i;
const MAX_STRING = 200;
const MAX_ARRAY = 60;

const pad = n => String(n).padStart(2, '0');
function newEveningId(at = Date.now(), random = crypto.randomBytes(2).toString('hex')) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}_${random}`;
}
const validId = value => typeof value === 'string' && ID_PATTERN.test(value);

// Copie sûre d'un champ : profondeur et tailles bornées, clés privées retirées.
function clean(value, depth = 0) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (depth > 3) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map(item => clean(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PRIVATE_KEY.test(k) || v === undefined || typeof v === 'function') continue;
      out[k] = clean(v, depth + 1);
    }
    return out;
  }
  return null;
}

// Lecture tolérante : une dernière ligne coupée (arrêt brutal) est ignorée.
function parseLines(text) {
  const lines = String(text || '').split('\n');
  const events = [];
  let truncated = false, corrupt = 0;
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && typeof event.ev === 'string' && Number.isFinite(event.t)) events.push(event);
      else corrupt++;
    } catch (_) {
      if (index === lines.length - 1 || (index === lines.length - 2 && !lines.at(-1))) truncated = true;
      else corrupt++;
    }
  });
  return { events, truncated, corrupt };
}

class EveningJournal {
  // `dir` : dossier des soirées (data/soirees), null pour garder en mémoire.
  // `fs` : module de fichiers injecté (disque en mémoire des tests).
  constructor({ dir = null, fs = require('fs'), now = Date.now, app = null, boot = null, onError = null } = {}) {
    this.dir = dir;
    this.fs = fs;
    this.now = now;
    this.app = app;
    this.boot = boot || crypto.randomBytes(4).toString('hex');
    this.onError = onError;
    this.current = null;      // { id, meta, events, seq }
    this.memory = new Map();  // soirées closes sans disque : id → { meta, events, summary }
    this.early = [];
    this.lastError = null;
  }

  get id() { return this.current?.id || null; }
  get startedAt() { return this.current?.meta.startedAt || null; }

  _folder(id) { return path.join(this.dir, id); }

  _fail(error) {
    const first = !this.lastError;
    this.lastError = error.message;
    if (first && this.onError) {
      try { this.onError(error); } catch (_) { /* le signalement ne doit rien casser */ }
    }
  }

  _writeMeta() {
    const cur = this.current;
    if (!cur || !this.dir) return;
    try {
      this.fs.mkdirSync(this._folder(cur.id), { recursive: true });
      const target = path.join(this._folder(cur.id), 'meta.json');
      this.fs.writeFileSync(`${target}.tmp`, JSON.stringify(cur.meta, null, 1));
      this.fs.renameSync(`${target}.tmp`, target);
    } catch (error) { this._fail(error); }
  }

  // Ouvre la soirée enregistrée dans l'instantané (redémarrage), sinon une
  // nouvelle. Rend true si la soirée précédente a été reprise.
  open({ resume = null, rules = null } = {}) {
    const now = this.now();
    if (resume && validId(resume.id)) {
      const saved = this.read(resume.id);
      if (saved) {
        const last = saved.events.at(-1);
        this.current = { id: resume.id, meta: saved.meta, events: saved.events,
          seq: saved.events.reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0) };
        delete this.current.meta.endedAt;
        this._flushEarly();
        this.append('app.started', { restored: true, offlineMs: last ? Math.max(0, now - last.t) : 0,
          version: this.app?.version || null, truncated: saved.truncated || undefined });
        return true;
      }
    }
    this.start({ rules });
    return false;
  }

  // Nouvelle soirée, sans fermer la précédente (voir close).
  start({ rules = null } = {}) {
    const now = this.now();
    let id = newEveningId(now);
    while (this.memory.has(id) || (this.dir && this._exists(id))) id = newEveningId(now);
    this.current = { id, events: [], seq: 0, meta: { format: 'karaoke-evening-meta', version: FORMAT,
      eveningId: id, startedAt: now, endedAt: null,
      app: this.app ? { version: this.app.version || null, commit: this.app.commit || null } : null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null, roster: {}, tables: {} } };
    this._writeMeta();
    this.append('evening.started', { rules });
    this._flushEarly();
    this.append('app.started', { restored: false, offlineMs: 0, version: this.app?.version || null });
    return id;
  }

  _exists(id) {
    try { return this.fs.existsSync(this._folder(id)); } catch (_) { return false; }
  }

  _flushEarly() {
    const early = this.early;
    this.early = [];
    for (const [ev, fields, t] of early) this.append(ev, fields, t);
  }

  // Ajoute un événement. Ne lève jamais d'erreur.
  append(ev, fields = {}, at = null) {
    try {
      if (typeof ev !== 'string' || !EVENT_PATTERN.test(ev)) return null;
      const t = Number.isFinite(at) ? at : this.now();
      if (!this.current) {
        if (this.early.length < EARLY_LIMIT) this.early.push([ev, fields, t]);
        return null;
      }
      const cur = this.current;
      const event = { ...clean(fields && typeof fields === 'object' ? fields : {}), v: FORMAT, seq: ++cur.seq, t, ev, boot: this.boot };
      cur.events.push(event);
      if (this.dir) {
        try {
          this.fs.mkdirSync(this._folder(cur.id), { recursive: true });
          this.fs.appendFileSync(path.join(this._folder(cur.id), 'journal.jsonl'), JSON.stringify(event) + '\n');
          if (this.lastError) this.lastError = null;
        } catch (error) { this._fail(error); }
      }
      return event;
    } catch (_) { return null; }
  }

  // Prénom et table d'une personne, gardés hors des lignes du journal.
  person(personId, { name, tableId } = {}) {
    const cur = this.current;
    if (!cur || !personId) return;
    const row = { name: String(name || '').slice(0, 40), tableId: tableId == null ? null : String(tableId) };
    const before = cur.meta.roster[personId];
    if (before && before.name === row.name && before.tableId === row.tableId) return;
    cur.meta.roster[personId] = row;
    this._writeMeta();
  }

  table(tableId, { name, individual } = {}) {
    const cur = this.current;
    if (!cur || tableId == null) return;
    const row = { name: String(name || '').slice(0, 40), individual: !!individual };
    const before = cur.meta.tables[tableId];
    if (before && before.name === row.name && before.individual === row.individual) return;
    cur.meta.tables[tableId] = row;
    this._writeMeta();
  }

  // Clôture : événement final, résumé et heure de fin. La soirée suivante
  // s'ouvre avec start().
  close({ by = 'staff-reset', fields = {}, summarize = null } = {}) {
    const cur = this.current;
    if (!cur) return null;
    this.append('evening.closed', { ...fields, by });
    cur.meta.endedAt = this.now();
    let summary = null;
    try { summary = summarize ? summarize({ meta: cur.meta, events: cur.events }) : null; }
    catch (error) { this._fail(error); }
    if (this.dir) {
      this._writeMeta();
      if (summary) {
        try {
          const target = path.join(this._folder(cur.id), 'summary.json');
          this.fs.writeFileSync(`${target}.tmp`, JSON.stringify(summary));
          this.fs.renameSync(`${target}.tmp`, target);
        } catch (error) { this._fail(error); }
      }
    } else this.memory.set(cur.id, { meta: cur.meta, events: cur.events, summary });
    this.current = null;
    return { id: cur.id, summary };
  }

  // État de l'instantané de soirée : l'identifiant suffit pour reprendre.
  snapshot() {
    return this.current ? { id: this.current.id, startedAt: this.current.meta.startedAt } : null;
  }

  // Soirée en cours ou archivée : { meta, events, truncated, corrupt, current }.
  read(id) {
    if (this.current && id === this.current.id) {
      return { meta: this.current.meta, events: this.current.events.slice(), truncated: false, corrupt: 0, current: true };
    }
    if (!validId(id)) return null;
    const kept = this.memory.get(id);
    if (kept) return { meta: kept.meta, events: kept.events.slice(), truncated: false, corrupt: 0, current: false, summary: kept.summary };
    if (!this.dir) return null;
    try {
      const folder = this._folder(id);
      if (!this.fs.existsSync(path.join(folder, 'meta.json'))) return null;
      const meta = JSON.parse(this.fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'));
      const file = path.join(folder, 'journal.jsonl');
      const parsed = this.fs.existsSync(file) ? parseLines(this.fs.readFileSync(file, 'utf8')) : { events: [], truncated: false, corrupt: 0 };
      return { meta, ...parsed, current: false };
    } catch (_) { return null; }
  }

  // Soirées connues, la plus récente d'abord.
  list() {
    const rows = [];
    const seen = new Set();
    const add = (id, meta, extra = {}) => {
      if (seen.has(id)) return;
      seen.add(id);
      rows.push({ id, startedAt: meta?.startedAt || null, endedAt: meta?.endedAt || null,
        people: Object.keys(meta?.roster || {}).length, current: id === this.id, ...extra });
    };
    if (this.current) add(this.current.id, this.current.meta, { events: this.current.events.length });
    for (const [id, kept] of this.memory) add(id, kept.meta, { events: kept.events.length });
    if (this.dir) {
      let names = [];
      try { names = this.fs.readdirSync(this.dir); } catch (_) { names = []; }
      for (const id of names) {
        if (!validId(id) || seen.has(id)) continue;
        try {
          const meta = JSON.parse(this.fs.readFileSync(path.join(this._folder(id), 'meta.json'), 'utf8'));
          add(id, meta);
        } catch (_) { /* dossier incomplet : ignoré */ }
      }
    }
    return rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }
}

module.exports = { EveningJournal, newEveningId, validEveningId: validId, parseLines, cleanFields: clean };
