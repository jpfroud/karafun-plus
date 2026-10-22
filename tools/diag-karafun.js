'use strict';
// Diagnostic KaraFun : KaraFun répond-il depuis l'adresse Internet de ce
// serveur ? Lit UNE fois la page de télécommande (https://www.karafun.com/<code>/,
// premier domaine de la file) avec les en-têtes et le délai de la file, la
// classe avec le code de la file (classifyDiscovery de karafun.js), puis
// affiche six mesures et un verdict. N'écrit aucun fichier (rien dans data/
// ni journal/), n'ouvre aucun WebSocket et ne crée aucun pont KaraFun.
//
// Budget : KaraFun ne répond qu'aux 20 à 40 premières pages de chaque heure
// pleine pour une même adresse Internet (www.karafun.com et www.karafun.fr
// confondus). Cette lecture y compte, mais la file n'en sait rien (elle n'est
// pas notée dans data/karafun-pages.json) : ne pas lancer l'outil en boucle.
//
// Codes de sortie :
//   0  KaraFun répond normalement à ce serveur : la migration peut continuer.
//   1  KaraFun refuse ce serveur (401, 403, 429 ou défi anti-robot) : ne pas
//      déplacer la file.
//   2  non concluant (code inconnu, site en panne, page inattendue, réseau
//      coupé, délai dépassé), usage incorrect ou erreur inattendue.
//
// Lancements :
//   - sur le VPS, même avant le compose (entrypoint de node:22-bookworm-slim
//     gardé ; <propriétaire> : compte GitHub du dépôt, celui de l'image de #22) :
//       docker run --rm ghcr.io/<propriétaire>/karafun-plus:<version> node tools/diag-karafun.js <code>
//   - depuis un clone avec Node 22 :
//       npm ci --omit=dev
//       node tools/diag-karafun.js <code>
const { CHALLENGE, DISCOVERY_HEADERS, classifyDiscovery, retryAfterAt } = require('../karafun');

const USAGE = [
  'Usage : node tools/diag-karafun.js <code de télécommande KaraFun>',
  'Aucune page lue : le code doit contenir au moins un chiffre.',
];
const HOUR_NEXT = 'la file attendrait l\'heure pleine suivante';
const NO_ANSWER = {
  timeout: 'aucune réponse (délai dépassé)',
  network: 'aucune réponse (réseau coupé ou site injoignable)',
};
const VERDICTS = {
  refused: (status, challenge) => `KaraFun refuse ce serveur (HTTP ${status}, défi anti-robot ${challenge ? 'oui' : 'non'}). ` +
    'Ne déplace pas la file. Relance ce diagnostic une seule fois, au moins une heure plus tard : ' +
    'un second refus confirme que KaraFun bloque l\'adresse de ce serveur. Ne cherche pas à contourner ce refus.',
  'unknown-code': status => `non concluant. KaraFun répond (HTTP ${status}) sans page de télécommande pour ce code : ` +
    'vérifie le code affiché dans KaraFun et que sa télécommande est activée, puis relance.',
  http: status => `non concluant. Le site KaraFun répond mal (HTTP ${status}) : relance plus tard.`,
  'bad-page': () => 'non concluant. Page de télécommande KaraFun inattendue : la file ne saurait pas la lire non plus. Relance plus tard.',
  network: () => 'non concluant. Site KaraFun injoignable depuis ce serveur : vérifie sa connexion Internet et son adresse IPv4 sortante.',
  timeout: () => 'non concluant. Le site KaraFun ne répond pas à temps : relance plus tard.',
};

// En-tête d'une réponse, sans jamais lever : null si les en-têtes manquent
// ou sont illisibles.
function readHeader(headers, name) {
  if (headers == null || typeof headers.get !== 'function') return null;
  try { return headers.get(name); } catch { return null; }
}

// Valeur venue du site, affichable sans risque : caractères ASCII visibles
// seulement, 120 au plus.
function printable(value) {
  if (value == null) return 'absent';
  const text = String(value).replace(/[^\x20-\x7e]/gu, '?').trim().slice(0, 120);
  return text || 'absent';
}

// Code de sortie et ligne Verdict selon le classement de la file.
function verdict(found, challenge) {
  if (found.kind === undefined) return [0, 'KaraFun répond normalement à ce serveur. La migration peut continuer.'];
  if (!Object.hasOwn(VERDICTS, found.kind)) throw new Error('Classement de la page KaraFun inconnu.');
  return [found.kind === 'refused' ? 1 : 2, VERDICTS[found.kind](found.status, challenge)];
}

function retryAfterLine(found, value, now) {
  const refused = found.kind === 'refused';
  if (value == null) return refused ? `absent (${HOUR_NEXT})` : 'absent';
  if (!refused) return printable(value);
  const end = retryAfterAt(value, now);
  if (end == null) return `${printable(value)} (ignoré par la file : elle attendrait l'heure pleine suivante)`;
  return `${printable(value)} (la file attendrait ${Math.round((end - now) / 1000)} s avant de relire la page)`;
}

async function runDiag(args, {
  base = 'https://www.karafun.com', // premier domaine de la file
  timeoutMs = 10000, // même délai que la file
  out = line => process.stdout.write(`${line}\n`),
  err = line => process.stderr.write(`${line}\n`),
} = {}) {
  const code = args.join('').replace(/\D/g, '');
  if (!code) {
    for (const line of USAGE) err(line);
    return 2;
  }
  const url = new URL(base);
  out(`Diagnostic KaraFun : une seule lecture de la page de télécommande sur ${url.host}, sans WebSocket, sans rien écrire dans data/.`);
  out('Attention : cette lecture compte dans la limite horaire de KaraFun pour l\'adresse Internet de ce serveur ' +
    '(KaraFun ne répond qu\'aux 20 à 40 premières pages de chaque heure pleine, www.karafun.com et www.karafun.fr confondus). ' +
    'La file n\'en est pas informée et peut en lire jusqu\'à 12 de plus dans la même heure. Ne lance pas cet outil en boucle.');

  // Même lecture que la file (karafun.js, _discover) : une seule requête.
  const host = url.hostname;
  let response, html, found;
  try {
    response = await fetch(`${base}/${code}/`, { headers: { ...DISCOVERY_HEADERS }, signal: AbortSignal.timeout(timeoutMs) });
    html = String(await response.text());
  } catch (error) {
    found = { host, kind: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network' };
  }
  found ??= classifyDiscovery(host, response, html);

  const answered = found.kind !== 'timeout' && found.kind !== 'network';
  const headers = answered ? response.headers ?? null : null;
  const challenge = answered && !found.keys.Settings && CHALLENGE.test(html);
  const now = Date.now();
  const retryAfter = readHeader(headers, 'retry-after');
  const [exitCode, text] = verdict(found, challenge);

  out(`Statut HTTP : ${answered ? found.status : NO_ANSWER[found.kind]}`);
  out(`Retry-After : ${answered ? retryAfterLine(found, retryAfter, now) : 'aucune réponse'}`);
  out(`Défi anti-robot : ${answered ? (challenge ? 'oui' : 'non') : 'non vérifié (aucune réponse)'}`);
  out(`Page de télécommande valide : ${found.settings != null ? 'oui' : 'non'}`);
  out(`En-tête server : ${answered ? printable(readHeader(headers, 'server')) : 'aucune réponse'}`);
  out(`En-tête via : ${answered ? printable(readHeader(headers, 'via')) : 'aucune réponse'}`);
  out(`Verdict : ${text}`);
  return exitCode;
}

// Jamais rejetée : une erreur inattendue donne une ligne (son nom seulement,
// jamais son message, qui peut contenir l'adresse lue, donc le code) et 2.
async function main(args, options = {}) {
  try {
    return await runDiag(args, options);
  } catch (error) {
    const err = options.err ?? (line => process.stderr.write(`${line}\n`));
    err(`Diagnostic interrompu : erreur inattendue (${error?.name}).`);
    return 2;
  }
}

module.exports = { runDiag, main };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
