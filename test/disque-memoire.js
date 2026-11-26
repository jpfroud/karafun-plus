'use strict';
/*
 * Disque en mémoire des essais de la réparation des journaux (plan du
 * 8 novembre, A4 et A7, « Disque ») : evening-journal.test.js le reprend, et
 * le harnais `vm` d'evening-stats-routes.test.js peut le reprendre. Module
 * d'aide des essais, sans essai à lui : test/run-offline.js ne le lance pas,
 * et le kit, qui exclut test/, ne le livre pas.
 *
 * Il n'a que les onze méthodes que la réparation emploie (A4, « Trace et
 * contraintes ») : existsSync, readFileSync, writeFileSync (chemin ou
 * descripteur), appendFileSync, renameSync, unlinkSync, mkdirSync (rend le
 * premier dossier créé, comme Node), readdirSync (des noms seulement),
 * openSync (fichier en 'wx', créé vide et refusé s'il existe, avec EEXIST ;
 * dossier en lecture), fsyncSync et closeSync, qui ne changent aucun contenu.
 * Toute autre méthode de fs lève « méthode non simulée : … » au lieu
 * d'atteindre le vrai disque. Les dossiers sont réels (un fichier ne s'écrit
 * que dans un dossier qui existe), les contenus sont des Buffer : une copie
 * se compare octet pour octet.
 *
 * - `syncs` : synchronisations, dans l'ordre ({ chemin, dossier }), chemins
 *   relatifs à la racine, séparés par « / » ;
 * - `ops` : chaque appel ({ op, chemin }), sauf existsSync et closeSync, pour
 *   compter les lectures ;
 * - `crochet(op, chemin, info)` : appelé avant chaque appel noté dans `ops`
 *   (op parmi read, write, append, rename, unlink, mkdir, readdir, open,
 *   sync) ; s'il rend un code (« EIO ») ou une erreur, l'appel échoue ainsi,
 *   sans rien changer. existsSync et closeSync n'y passent pas : le crochet
 *   ne les fait jamais échouer ;
 * - `arretApres(n)` : arrêt brutal simulé après la n-ième écriture (création
 *   de dossier ou de fichier, écriture, ajout, renommage, retrait) : le disque
 *   est relevé (`releve`), puis chaque appel noté dans `ops` lève ESTOP ;
 *   existsSync rend alors false, et closeSync ferme encore ;
 * - `instantane()`, puis disqueMemoire({ depuis }) : un disque neuf qui
 *   reprend ce relevé (redémarrage après l'arrêt) ;
 * - `enMemoire` : par défaut, tout chemin est en mémoire ; avec une liste de
 *   dossiers de la racine (['data', 'journal'] pour le harnais `vm` du
 *   serveur, racine = le dépôt), seuls ces dossiers le sont : les autres
 *   chemins (pages, package.json) vont au vrai disque, et une méthode non
 *   simulée n'est refusée que sur eux.
 */
const path = require('node:path');
const realFs = require('node:fs');

const METHODES = ['existsSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync',
  'mkdirSync', 'readdirSync', 'openSync', 'fsyncSync', 'closeSync'];
const TEXTE_METHODES = `${METHODES.slice(0, -1).join(', ')} et ${METHODES.at(-1)}`;

function erreur(code, syscall, chemin) {
  return Object.assign(new Error(`${code}: ${syscall} '${chemin}'`), { code, syscall, path: chemin });
}

function disqueMemoire({ racine = path.resolve(path.sep, 'memoire'), depuis = null, enMemoire = null } = {}) {
  const files = new Map(depuis ? [...depuis.files].map(([p, b]) => [p, Buffer.from(b)]) : []);
  const dirs = new Set(depuis ? depuis.dirs : [racine]);
  const fds = new Map();
  let prochainFd = 100;
  let ecritures = 0;
  const etat = { syncs: [], ops: [], crochet: null, arret: null, releve: null, arrete: false };

  const relatif = chemin => path.relative(racine, String(chemin)).split(path.sep).join('/');
  const zones = Array.isArray(enMemoire) ? enMemoire.map(rel => path.join(racine, ...String(rel).split('/'))) : null;
  // Chemin tenu par le disque en mémoire (toujours, sans `enMemoire`).
  const tenu = chemin => typeof chemin !== 'string' || !zones ||
    zones.some(zone => chemin === zone || chemin.startsWith(zone + path.sep));
  // Les parents de la racine existent toujours.
  const estDossier = chemin => dirs.has(chemin) || (racine.startsWith(chemin) && (chemin === path.parse(racine).root ||
    racine[chemin.length] === path.sep));
  const parentExiste = chemin => estDossier(path.dirname(chemin));
  const enfants = dossier => {
    const prefixe = dossier.endsWith(path.sep) ? dossier : dossier + path.sep;
    const noms = new Set();
    for (const chemin of [...files.keys(), ...dirs]) {
      if (chemin.startsWith(prefixe) && chemin.length > prefixe.length) noms.add(chemin.slice(prefixe.length).split(path.sep)[0]);
    }
    return [...noms].sort();
  };

  function appel(op, chemin, info = {}) {
    if (etat.arrete) throw erreur('ESTOP', op, chemin);
    etat.ops.push({ op, chemin: relatif(chemin) });
    if (etat.crochet) {
      const echec = etat.crochet(op, relatif(chemin), info);
      if (echec instanceof Error) throw echec;
      if (typeof echec === 'string') throw erreur(echec, op, chemin);
    }
  }
  // Après chaque écriture : arrêt brutal simulé.
  function ecrite() {
    ecritures++;
    if (etat.arret !== null && ecritures >= etat.arret) {
      etat.releve = instantane();
      etat.arrete = true;
    }
  }
  function instantane() {
    return { files: new Map([...files].map(([p, b]) => [p, Buffer.from(b)])), dirs: new Set(dirs) };
  }
  const contenu = data => (Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data)));

  const methodes = {
    existsSync(chemin) {
      if (etat.arrete) return false;
      return files.has(chemin) || estDossier(chemin);
    },
    readFileSync(chemin, options) {
      if (typeof chemin === 'number') throw new Error('readFileSync sur un descripteur : non simulé.');
      appel('read', chemin);
      if (estDossier(chemin)) throw erreur('EISDIR', 'read', chemin);
      if (!files.has(chemin)) throw erreur('ENOENT', 'open', chemin);
      const encodage = typeof options === 'string' ? options : options?.encoding;
      const buffer = files.get(chemin);
      return encodage ? buffer.toString(encodage) : Buffer.from(buffer);
    },
    writeFileSync(cible, data) {
      if (typeof cible === 'number') {
        const fd = fds.get(cible);
        if (!fd || fd.dossier) throw erreur('EBADF', 'write', String(cible));
        appel('write', fd.chemin, { descripteur: true });
        files.set(fd.chemin, contenu(data));
        ecrite();
        return;
      }
      appel('write', cible);
      if (!parentExiste(cible)) throw erreur('ENOENT', 'open', cible);
      if (estDossier(cible)) throw erreur('EISDIR', 'open', cible);
      files.set(cible, contenu(data));
      ecrite();
    },
    appendFileSync(chemin, data) {
      appel('append', chemin);
      if (!parentExiste(chemin)) throw erreur('ENOENT', 'open', chemin);
      if (estDossier(chemin)) throw erreur('EISDIR', 'open', chemin);
      files.set(chemin, Buffer.concat([files.get(chemin) || Buffer.alloc(0), contenu(data)]));
      ecrite();
    },
    renameSync(de, vers) {
      appel('rename', de, { vers: relatif(vers) });
      if (!files.has(de)) throw erreur('ENOENT', 'rename', de);
      if (!parentExiste(vers)) throw erreur('ENOENT', 'rename', vers);
      if (estDossier(vers)) throw erreur('EISDIR', 'rename', vers);
      files.set(vers, files.get(de));
      files.delete(de);
      ecrite();
    },
    unlinkSync(chemin) {
      appel('unlink', chemin);
      if (estDossier(chemin)) throw erreur('EISDIR', 'unlink', chemin);
      if (!files.has(chemin)) throw erreur('ENOENT', 'unlink', chemin);
      files.delete(chemin);
      ecrite();
    },
    mkdirSync(chemin, options = {}) {
      appel('mkdir', chemin);
      if (files.has(chemin)) throw erreur('EEXIST', 'mkdir', chemin);
      if (estDossier(chemin)) {
        if (options.recursive) return undefined;
        throw erreur('EEXIST', 'mkdir', chemin);
      }
      const manquants = [];
      for (let d = chemin; !estDossier(d); d = path.dirname(d)) {
        if (files.has(d)) throw erreur('ENOTDIR', 'mkdir', d);
        manquants.unshift(d);
        if (path.dirname(d) === d) break;
      }
      if (manquants.length > 1 && !options.recursive) throw erreur('ENOENT', 'mkdir', chemin);
      for (const d of manquants) dirs.add(d);
      ecrite();
      return options.recursive ? manquants[0] : undefined;
    },
    readdirSync(chemin, options) {
      if (options && typeof options === 'object' && options.withFileTypes) nonSimulee('readdirSync', chemin);
      appel('readdir', chemin);
      if (files.has(chemin)) throw erreur('ENOTDIR', 'scandir', chemin);
      if (!estDossier(chemin)) throw erreur('ENOENT', 'scandir', chemin);
      return enfants(chemin);
    },
    openSync(chemin, flags = 'r') {
      appel('open', chemin, { flags });
      const lecture = flags === 'r' || flags === realFs.constants.O_RDONLY ||
        flags === (realFs.constants.O_RDONLY | (realFs.constants.O_DIRECTORY || 0));
      if (lecture) {
        if (estDossier(chemin)) { const fd = prochainFd++; fds.set(fd, { chemin, dossier: true }); return fd; }
        if (!files.has(chemin)) throw erreur('ENOENT', 'open', chemin);
        const fd = prochainFd++; fds.set(fd, { chemin, dossier: false }); return fd;
      }
      if (flags !== 'wx') throw new Error(`openSync en « ${flags} » : non simulé (seulement 'wx' et la lecture).`);
      if (!parentExiste(chemin)) throw erreur('ENOENT', 'open', chemin);
      if (files.has(chemin) || estDossier(chemin)) throw erreur('EEXIST', 'open', chemin);
      files.set(chemin, Buffer.alloc(0));
      ecrite();
      const fd = prochainFd++;
      fds.set(fd, { chemin, dossier: false });
      return fd;
    },
    fsyncSync(fd) {
      const ouvert = fds.get(fd);
      if (!ouvert) throw erreur('EBADF', 'fsync', String(fd));
      appel('sync', ouvert.chemin, { dossier: ouvert.dossier });
      etat.syncs.push({ chemin: relatif(ouvert.chemin), dossier: ouvert.dossier });
    },
    closeSync(fd) {
      if (!fds.has(fd)) throw erreur('EBADF', 'close', String(fd));
      fds.delete(fd);
    },
  };

  function nonSimulee(methode, chemin) {
    throw new Error(`méthode non simulée : fs.${methode}("${relatif(chemin)}"). Le disque en mémoire n'a que ${TEXTE_METHODES} (A4, « Trace et contraintes ») : réécris l'appel avec elles.`);
  }
  // Hors des dossiers `enMemoire`, chaque appel va au vrai disque ; un
  // descripteur est suivi par le disque qui l'a ouvert.
  const vrais = new Set();
  const route = (nom, methode) => (cible, ...rest) => {
    if (typeof cible === 'number') {
      if (vrais.has(cible)) { if (nom === 'closeSync') vrais.delete(cible); return realFs[nom](cible, ...rest); }
      return methode(cible, ...rest);
    }
    if (tenu(cible)) return methode(cible, ...rest);
    const out = realFs[nom](cible, ...rest);
    if (nom === 'openSync') vrais.add(out);
    return out;
  };
  const routees = Object.fromEntries(Object.entries(methodes).map(([nom, methode]) => [nom, route(nom, methode)]));
  const fs = new Proxy(routees, {
    get(cible, nom) {
      if (Object.hasOwn(cible, nom)) return cible[nom];
      if (nom === 'constants') return realFs.constants;
      if (typeof nom === 'string' && typeof realFs[nom] === 'function') {
        return (chemin, ...rest) => (tenu(chemin) ? nonSimulee(nom, chemin) : realFs[nom](chemin, ...rest));
      }
      return realFs[nom];
    },
  });

  const absolu = rel => path.join(racine, ...String(rel).split('/'));
  return {
    fs, racine, etat, absolu,
    get syncs() { return etat.syncs; },
    get ops() { return etat.ops; },
    set crochet(fonction) { etat.crochet = fonction; },
    arretApres(n) { etat.arret = n; ecritures = 0; etat.releve = null; etat.arrete = false; },
    get releve() { return etat.releve; },
    instantane,
    // Préparation des essais, hors crochet et hors compte.
    ecrire(rel, data) {
      const chemin = absolu(rel);
      for (let d = path.dirname(chemin); !estDossier(d); d = path.dirname(d)) dirs.add(d);
      files.set(chemin, contenu(data));
    },
    dossier(rel) { const chemin = absolu(rel); for (let d = chemin; !estDossier(d); d = path.dirname(d)) dirs.add(d); },
    lire: rel => files.get(absolu(rel))?.toString('utf8'),
    octets: rel => files.get(absolu(rel)),
    existe: rel => files.has(absolu(rel)) || dirs.has(absolu(rel)),
    // Fichiers sous `rel` (chemins relatifs à la racine), triés.
    fichiers(rel = '') {
      const base = rel ? absolu(rel) + path.sep : racine + path.sep;
      return [...files.keys()].filter(p => p.startsWith(base)).map(relatif).sort();
    },
    // Contenus sous `rel`, chemin relatif → texte.
    contenus(rel = '') { return new Map(this.fichiers(rel).map(p => [p, files.get(absolu(p)).toString('utf8')])); },
    compte: (op, filtre = () => true) => etat.ops.filter(o => o.op === op && filtre(o.chemin)).length,
  };
}

module.exports = { disqueMemoire, METHODES, TEXTE_METHODES };
