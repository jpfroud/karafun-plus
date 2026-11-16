'use strict';
// Diagnostic ponctuel : lecture seule, aucun ajout ni commande de lecture. La page de
// télécommande se lit et se classe comme la file la lit (karafun.js, _discover, comme
// tools/diag-karafun.js) : premier domaine de la file, mêmes en-têtes, même délai,
// classifyDiscovery. Le canal de la télécommande actuelle s'ouvre ensuite comme dans la
// file, par KcsTransport (kcs-transport.js : WebSocket de Node, sous-protocole, réponses aux
// battements de KaraFun), pendant 12 s, et ses messages et ses coupures se jugent comme dans
// la file (karafun.js, _openKcs) : core.AuthenticatedEvent, le code accepté ;
// remote.AppLeftEvent, KaraFun fermé ou sa télécommande désactivée (le serveur KCS répond
// encore, avec son dernier état) ; Error, une erreur de KaraFun ; fermeture par KaraFun, ou
// 10 s sans message (KcsTransport ferme alors le canal), une connexion perdue (lost).
// Les messages s'affichent. Lancée depuis la racine du dépôt, la sonde les garde aussi dans
// journal/kcs-probe.json ; dans le conteneur de l'essai de .github/RELEASE.md (docker run
// --rm, rien de monté sur /app/journal), ce fichier part avec le conteneur : les messages ne
// restent qu'à l'écran.
// Codes de sortie : 0 WebSocket ouvert, code accepté par KaraFun et canal tenu les 12 s, sans
// AppLeftEvent ni Error ; 1 WebSocket en échec (impossible à créer, jamais ouvert, aucun
// message, code jamais accepté, AppLeftEvent, Error, ou fermé par KaraFun ou muet avant la fin
// des 12 s : refus, 4210 ou 44xx comme pour la file, ou connexion perdue, même après le code
// accepté) ; 2 rien d'essayé : usage, page que la file refuse ou qui ne répond pas (aucun
// WebSocket ouvert), ou page sans adresse KCS, que la file lit par le protocole historique
// (Socket.IO), sans le WebSocket de Node : rien à sonder ici.
// Cette lecture compte dans la limite horaire de KaraFun : ne pas lancer la sonde en boucle.
const fs = require('fs');
const { KaraFunBridge, DISCOVERY_HEADERS, classifyDiscovery, urlRejected } = require('../karafun');
const { KcsTransport } = require('../kcs-transport');

const DUREE_MS = 12000;
const RAISONS = {
  refused: 'KaraFun refuse cette adresse Internet (401, 403, 429 ou défi anti-robot)',
  'unknown-code': 'code inconnu ou KaraFun fermé',
  http: 'erreur HTTP de KaraFun',
  'bad-page': 'page changée, ou adresse KCS que la file refuse',
  timeout: 'aucune réponse (délai dépassé)',
  network: 'aucune réponse (réseau coupé ou site injoignable)',
};

(async () => {
  const code = process.argv[2];
  if (!code) {
    console.error('Usage : node test/probe-kcs.js <code de la télécommande KaraFun>');
    process.exit(2);
  }
  const base = new KaraFunBridge().bases[0]; // premier domaine de la file
  let found;
  try {
    const response = await fetch(`${base}/${code}/`, { headers: { ...DISCOVERY_HEADERS }, signal: AbortSignal.timeout(10000) });
    found = classifyDiscovery(new URL(base).hostname, response, String(await response.text()));
  } catch (error) {
    found = { kind: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network' };
  }
  if (!found.settings) {
    console.error(`Page de télécommande inutilisable (${RAISONS[found.kind] || found.kind}) : aucun WebSocket ouvert.`);
    process.exit(2);
  }
  if (!found.settings.kcs_url) {
    console.error('Page sans adresse KCS : la file passerait par le protocole historique (Socket.IO), sans le WebSocket de Node. '
      + 'Rien à sonder ici : aucun WebSocket ouvert.');
    process.exit(2);
  }
  let canal;
  try { canal = new KcsTransport(found.settings.kcs_url); }
  catch (error) {
    // Comme pour la file : WebSocket absent (Node trop ancien) ou adresse refusée.
    console.error(`Essai en échec : WebSocket impossible à créer (${error.message}).`);
    process.exit(1);
  }
  const messages = [];
  // Ce qu'en dirait la file (karafun.js, _openKcs) : code accepté, KaraFun parti, erreur de
  // KaraFun, adresse refusée, ou connexion perdue avant la fin de l'essai (coupure).
  let ouvert = false, accepte = false, parti = false, erreur = null, refus = null, coupure = null, fini = false;
  const minuteur = setTimeout(() => finir(), DUREE_MS);
  const finir = () => {
    if (fini) return;
    fini = true;
    clearTimeout(minuteur);
    canal.close();
    // Une fermeture à laquelle KaraFun ne répond pas n'est pas attendue plus de 3 s.
    setTimeout(() => process.exit(), 3000).unref();
    // Un journal non écrit ne change pas le verdict : les messages sont déjà affichés.
    try {
      fs.mkdirSync('journal', { recursive: true });
      fs.writeFileSync('journal/kcs-probe.json', JSON.stringify(messages, null, 2));
    } catch (error) { console.error(`journal/kcs-probe.json non écrit (${error.code || error.message}).`); }
    const nombre = `${messages.length} message${messages.length > 1 ? 's' : ''}`;
    // Un seul verdict, dont suit le code de sortie : 0 pour « Essai réussi » seulement.
    let echec = null;
    if (refus !== null) echec = `KaraFun a refusé l'adresse KCS (fermeture ${refus} : session finie, KaraFun fermé ou code changé).`;
    else if (!ouvert) echec = 'WebSocket jamais ouvert.';
    else if (parti) echec = 'KaraFun est fermé ou sa télécommande a été désactivée (remote.AppLeftEvent), comme la file l\'afficherait.';
    else if (erreur !== null) echec = `KaraFun a répondu par une erreur (${erreur}).`;
    else if (!messages.length) echec = 'aucun message de KaraFun.';
    else if (!accepte) echec = `code jamais accepté par KaraFun (aucun core.AuthenticatedEvent en ${nombre}).`;
    else if (coupure !== null) echec = `${coupure} avant la fin des ${DUREE_MS / 1000} s ; la file y verrait une connexion perdue et se reconnecterait.`;
    if (echec === null) console.log(`Essai réussi : WebSocket ouvert, code accepté par KaraFun (core.AuthenticatedEvent), canal tenu ${DUREE_MS / 1000} s, ${nombre} de KaraFun.`);
    else console.error(`Essai en échec : ${echec}`);
    process.exitCode = echec === null ? 0 : 1;
  };
  canal.on('open', () => { ouvert = true; console.log('WebSocket ouvert'); });
  canal.on('message', message => {
    messages.push(message);
    console.log(JSON.stringify(message));
    if (message.type === 'core.AuthenticatedEvent') accepte = true;
    // La sonde n'envoie que les réponses aux battements : une Error de KaraFun n'est jamais attendue.
    else if (message.type === 'Error') erreur ??= message.payload?.message || message.payload?.type || 'erreur inconnue';
    // KaraFun fermé : la file ferme alors le canal (karafun.js), la sonde s'arrête aussi.
    else if (message.type === 'remote.AppLeftEvent') { parti = true; finir(); }
  });
  canal.on('transport-error', message => console.error(`Erreur : ${message}`));
  // Le canal se ferme seul après 10 s sans message une fois ouvert : connexion perdue pour la
  // file (karafun.js, 'stale'), même après le code accepté.
  canal.on('stale', () => {
    console.error('KaraFun ne répond plus : canal fermé.');
    coupure = 'KaraFun ne répond plus, canal fermé';
    finir();
  });
  // Fermé par KaraFun avant la fin de l'essai (la sonde ferme elle-même le canal au bout des
  // 12 s) : adresse refusée, ou connexion perdue pour la file (karafun.js, 'close'), qui se
  // reconnecte, même après le code accepté.
  canal.on('close', ({ code: fermeture }) => {
    console.error(`WebSocket fermé par KaraFun (code ${fermeture}).`);
    if (urlRejected(fermeture)) refus = fermeture;
    else coupure = `KaraFun a fermé le canal (code ${fermeture})`;
    finir();
  });
})();
