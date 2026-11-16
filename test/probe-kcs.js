'use strict';
// Diagnostic ponctuel : lecture seule, aucun ajout ni commande de lecture. La page de
// télécommande se lit et se classe comme la file la lit (karafun.js, _discover, comme
// tools/diag-karafun.js) : premier domaine de la file, mêmes en-têtes, même délai,
// classifyDiscovery. Le canal de la télécommande actuelle s'ouvre ensuite comme dans la
// file, par KcsTransport (kcs-transport.js : WebSocket de Node, sous-protocole, réponses aux
// battements de KaraFun), pendant 12 s ; ses messages s'affichent et restent dans
// journal/kcs-probe.json (.github/RELEASE.md, essai de la télécommande).
// Codes de sortie : 0 WebSocket ouvert et au moins un message de KaraFun ; 1 WebSocket en
// échec (impossible à créer, jamais ouvert, aucun message, ou fermé par un refus de
// KaraFun, 4210 ou 44xx comme pour la file) ; 2 rien d'essayé : usage, page que la file
// refuse ou qui ne répond pas (aucun WebSocket ouvert), ou page sans adresse KCS, que la
// file lit par le protocole historique (Socket.IO), sans le WebSocket de Node : rien à
// sonder ici.
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
  let ouvert = false, refus = null, fini = false;
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
    if (refus !== null) console.error(`Essai en échec : KaraFun a refusé l'adresse KCS (fermeture ${refus} : session finie, KaraFun fermé ou code changé).`);
    else if (!ouvert) console.error('Essai en échec : WebSocket jamais ouvert.');
    else if (!messages.length) console.error('Essai en échec : aucun message de KaraFun.');
    else console.log(`Essai réussi : WebSocket ouvert, ${messages.length} message${messages.length > 1 ? 's' : ''} de KaraFun.`);
    process.exitCode = refus === null && ouvert && messages.length ? 0 : 1;
  };
  canal.on('open', () => { ouvert = true; console.log('WebSocket ouvert'); });
  canal.on('message', message => { messages.push(message); console.log(JSON.stringify(message)); });
  canal.on('transport-error', message => console.error(`Erreur : ${message}`));
  // Le canal se ferme seul après 10 s sans message une fois ouvert.
  canal.on('stale', () => { console.error('KaraFun ne répond plus : canal fermé.'); finir(); });
  canal.on('close', ({ code: fermeture }) => {
    console.error(`WebSocket fermé par KaraFun (code ${fermeture}).`);
    if (urlRejected(fermeture)) refus = fermeture;
    finir();
  });
})();
