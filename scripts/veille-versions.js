'use strict';
// Veille des versions (workflow « Veille des versions », chaque lundi) : compare
// les outils du dépôt à leurs dernières versions et tient une seule issue GitHub
// à jour. Règle et raisons : SECURITY.md, « Règle de la dernière LTS ».
//
//   node scripts/veille-versions.js               tient l'issue à jour
//                                                 (GITHUB_REPOSITORY, GITHUB_TOKEN)
//   node scripts/veille-versions.js --simulation  affiche seulement les alertes
//
// Sources : API de endoflife.date (Node, Temurin, Ubuntu, Debian, Maven), registre
// npm (Playwright), releases GitHub (Trivy, zizmor, actionlint). Une source
// illisible fait échouer le script, donc le workflow : le silence ne veut jamais
// dire « tout est à jour ». Seuls des numéros de version et des dates validés,
// venus de ces sources, entrent dans l'issue.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// Assez tôt pour monter sans urgence, hors soirée.
const JOURS_AVANT_FIN = 180;
// Même délai que Dependabot (.github/dependabot.yml) : une version piégée a le
// temps d'être retirée avant d'arriver ici.
const JOURS_DELAI = 7;
const MARQUE = '<!-- veille-versions -->';
const VERSION = /^\d+(?:\.\d+)*$/;
// AAAA-MM-JJ, avec ou sans heure : une vraie date, jamais un texte qui commence comme une date.
const dateLisible = valeur => typeof valeur === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\S*)?$/.test(valeur) && !Number.isNaN(Date.parse(valeur.slice(0, 10)));

// Dernière LTS pour Node, Temurin et Ubuntu ; dernière version stable pour
// Debian et Maven, qui n'ont pas de LTS.
const CYCLES = [
  { id: 'node', nom: 'Node.js', produit: 'nodejs', lts: true },
  { id: 'java', nom: 'Java (Temurin)', produit: 'eclipse-temurin', lts: true },
  { id: 'ubuntu', nom: 'Ubuntu (CI)', produit: 'ubuntu', lts: true },
  { id: 'debian', nom: 'Debian (images)', produit: 'debian', lts: false },
  { id: 'maven', nom: 'Maven (image)', produit: 'apache-maven', lts: false },
];
// Outils épinglés dans les workflows, que Dependabot ne voit pas.
const OUTILS = [
  { id: 'playwright', nom: 'Playwright', paquet: 'playwright', lien: 'https://github.com/microsoft/playwright/releases' },
  { id: 'trivy', nom: 'Trivy', depot: 'aquasecurity/trivy' },
  { id: 'zizmor', nom: 'zizmor', depot: 'zizmorcore/zizmor' },
  { id: 'actionlint', nom: 'actionlint', depot: 'rhysd/actionlint' },
];

function lu(fichier, motif, lire) {
  const trouve = motif.exec(lire(fichier));
  if (!trouve) throw new Error(`${fichier} : version introuvable (${motif})`);
  return trouve[1];
}

// Versions en service, lues dans le dépôt : les tests W10 et W11 de
// test/workflows.test.js garantissent qu'il n'y en a qu'une de chaque.
function versionsEnService(lire = fichier => fs.readFileSync(path.join(ROOT, fichier), 'utf8').replace(/\r\n/g, '\n')) {
  return {
    node: lu('Dockerfile', /\bnode:(\d+)-\w+-slim@/, lire),
    debian: lu('Dockerfile', /\bnode:\d+-(\w+)-slim@/, lire),
    java: lu('Dockerfile', /\beclipse-temurin:(\d+)-jdk@/, lire),
    maven: lu('Dockerfile', /\bmaven:(\d+\.\d+)-eclipse-temurin-\d+@/, lire),
    ubuntu: lu('.github/workflows/ci.yml', /runs-on: ubuntu-(\d+\.\d+)\b/, lire),
    playwright: lu('.github/workflows/ci.yml', /playwright@(\d+\.\d+\.\d+)/, lire),
    actionlint: lu('.github/workflows/ci.yml', /rhysd\/actionlint:(\d+\.\d+\.\d+)@/, lire),
    trivy: lu('.github/workflows/securite.yml', /TRIVY_VERSION: v(\d+\.\d+\.\d+)/, lire),
    zizmor: lu('.github/workflows/securite.yml', /zizmor-action@[0-9a-f]{40}[^\n]*\n\s+with:\n(?:\s+#.*\n)*\s+version: (\d+\.\d+\.\d+)\s*$/m, lire),
  };
}

function comparer(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const ecart = (x[i] || 0) - (y[i] || 0);
    if (ecart) return ecart;
  }
  return 0;
}
const joursEntre = (de, a) => Math.floor((Date.parse(a.slice(0, 10)) - Date.parse(de.slice(0, 10))) / 86400000);

// Réponse de GET /api/v1/products/<produit>/ : tous les champs lus ici doivent être là
// et valides. Un champ renommé ferait sinon taire les alertes, puis fermer l'issue.
function cyclesLus(reponse, produit) {
  const sorties = reponse && reponse.result && reponse.result.releases;
  if (!Array.isArray(sorties) || !sorties.length) throw new Error(`endoflife.date, ${produit} : réponse inattendue`);
  for (const s of sorties) {
    const lisible = typeof s.name === 'string' && VERSION.test(s.name) && dateLisible(s.releaseDate)
      && typeof s.isLts === 'boolean' && typeof s.isEol === 'boolean' && typeof s.isMaintained === 'boolean'
      && (s.eolFrom === null || dateLisible(s.eolFrom));
    if (!lisible) throw new Error(`endoflife.date, ${produit} : cycle illisible`);
  }
  return sorties;
}

function alertesCycle(cycle, enService, sorties, aujourdHui) {
  const voulue = enService[cycle.id];
  // Le Dockerfile nomme Debian par son nom de code (trixie), jamais par son numéro.
  const courante = sorties.find(s => cycle.id === 'debian' ? String(s.codename).toLowerCase() === voulue : s.name === voulue);
  if (!courante) throw new Error(`endoflife.date, ${cycle.produit} : version en service ${voulue} inconnue`);
  const derniere = sorties.filter(s => s.releaseDate <= aujourdHui && (!cycle.lts || s.isLts)).map(s => s.name).sort(comparer).pop();
  // Aucune LTS lue : le sens du champ a changé, ce n'est pas « tout est à jour ».
  if (!derniere) throw new Error(`endoflife.date, ${cycle.produit} : aucune version ${cycle.lts ? 'LTS ' : ''}parue`);
  const alerte = (cle, raison) => ({ cle: `${cycle.id}:${cle}`, outil: cycle.nom, enService: courante.name, propose: derniere, raison,
    lien: `https://endoflife.date/${cycle.produit}` });
  const alertes = [];
  if (comparer(derniere, courante.name) > 0) alertes.push(alerte(derniere, cycle.lts ? 'nouvelle LTS' : 'nouvelle version stable'));
  if (cycle.lts && !courante.isLts) alertes.push(alerte(`hors-lts:${courante.name}`, 'pas une LTS'));
  // Deux clés : la fin effective prévient de nouveau après la fin annoncée.
  if (courante.isEol || !courante.isMaintained) {
    alertes.push(alerte(`eol:${courante.name}`, 'plus maintenue'));
  } else if (courante.eolFrom && joursEntre(aujourdHui, courante.eolFrom) <= JOURS_AVANT_FIN) {
    alertes.push(alerte(`fin:${courante.name}`, `fin de support le ${courante.eolFrom.slice(0, 10)}`));
  }
  return alertes;
}

// Parutions d'un paquet npm : champ `time` du registre, sans les préversions. Il garde
// aussi les versions retirées, absentes de `versions`, celles que le délai doit écarter.
function parutionsNpm(reponse, paquet) {
  if (!reponse || !reponse.time || !reponse.versions || typeof reponse.time !== 'object' || typeof reponse.versions !== 'object') {
    throw new Error(`npm, ${paquet} : réponse inattendue`);
  }
  return Object.entries(reponse.time)
    .filter(([version, date]) => /^\d+\.\d+\.\d+$/.test(version) && dateLisible(date) && reponse.versions[version] && !reponse.versions[version].deprecated)
    .map(([version, date]) => ({ version, date }));
}

// Parutions d'un dépôt GitHub : releases publiées, sans brouillons ni préversions.
function parutionsGithub(reponse, depot) {
  if (!Array.isArray(reponse)) throw new Error(`GitHub, ${depot} : réponse inattendue`);
  return reponse.filter(r => !r.draft && !r.prerelease && /^v?\d+\.\d+\.\d+$/.test(String(r.tag_name)) && dateLisible(r.published_at))
    .map(r => ({ version: r.tag_name.replace(/^v/, ''), date: r.published_at }));
}

function alertesOutil(outil, enService, parutions, aujourdHui) {
  if (!parutions.length) throw new Error(`${outil.nom} : aucune parution lue`);
  const voulue = enService[outil.id];
  const derniere = parutions.filter(p => joursEntre(p.date, aujourdHui) >= JOURS_DELAI).map(p => p.version).sort(comparer).pop();
  if (!derniere || comparer(derniere, voulue) <= 0) return [];
  return [{ cle: `${outil.id}:${derniere}`, outil: outil.nom, enService: voulue, propose: derniere, raison: 'nouvelle version',
    lien: outil.lien || `https://github.com/${outil.depot}/releases` }];
}

const titreIssue = alertes => `Veille des versions : ${alertes.length} remontée${alertes.length > 1 ? 's' : ''} à faire`;

function corpsIssue(alertes) {
  return [
    MARQUE,
    `<!-- cles: ${alertes.map(a => a.cle).join(' ')} -->`,
    'La veille des versions a trouvé de quoi remonter. Règle : « Règle de la dernière LTS » de `SECURITY.md`.',
    '',
    '| Outil | En service | Proposé | Raison |',
    '|---|---|---|---|',
    ...alertes.map(a => `| [${a.outil}](${a.lien}) | ${a.enService} | ${a.propose} | ${a.raison} |`),
    '',
    'Une montée change d\'un seul tenant le `Dockerfile`, la CI, les tests et les documents : le test W11 de `test/workflows.test.js` refuse une montée partielle. Pour Java et Node, joindre le bilan avant/après ; pour Node, essayer aussi la télécommande KaraFun.',
    '',
    'Cette issue se met à jour chaque lundi et se ferme seule quand tout est à jour. Les notes vont en commentaire : ce texte est réécrit.',
  ].join('\n');
}
const lignesAlertes = alertes => alertes.map(a => `- ${a.outil} : ${a.raison}, ${a.enService} en service, ${a.propose} proposé`).join('\n');

async function lireJson(appel, url, options = {}) {
  const reponse = await appel(url, { ...options, signal: AbortSignal.timeout(30000) });
  if (!reponse.ok) throw new Error(`${options.method || 'GET'} ${url} : HTTP ${reponse.status}`);
  return reponse.json();
}

// Toutes les alertes du moment. `appel` : fetch ; `aujourdHui` : AAAA-MM-JJ.
async function alertesDuJour({ appel, lire, aujourdHui, entetesGithub = {} }) {
  const enService = versionsEnService(lire);
  const alertes = [];
  for (const cycle of CYCLES) {
    const reponse = await lireJson(appel, `https://endoflife.date/api/v1/products/${cycle.produit}/`);
    alertes.push(...alertesCycle(cycle, enService, cyclesLus(reponse, cycle.produit), aujourdHui));
  }
  for (const outil of OUTILS) {
    const parutions = outil.paquet
      ? parutionsNpm(await lireJson(appel, `https://registry.npmjs.org/${outil.paquet}`), outil.paquet)
      : parutionsGithub(await lireJson(appel, `https://api.github.com/repos/${outil.depot}/releases?per_page=30`, { headers: entetesGithub }), outil.depot);
    alertes.push(...alertesOutil(outil, enService, parutions, aujourdHui));
  }
  return alertes;
}

// Ouvre, met à jour ou ferme l'issue. Un message seulement quand une alerte est
// nouvelle : GitHub prévient alors l'assigné, sans bruit les autres semaines.
async function tenirIssue({ appel, depot, entetesGithub, alertes }) {
  const api = (chemin, { methode, corps } = {}) => lireJson(appel, `https://api.github.com/repos/${depot}${chemin}`, methode
    ? { method: methode, headers: { ...entetesGithub, 'Content-Type': 'application/json' }, body: JSON.stringify(corps) }
    : { headers: entetesGithub });
  const ouvertes = await api(`/issues?state=open&creator=${encodeURIComponent('github-actions[bot]')}&per_page=100`);
  if (!Array.isArray(ouvertes)) throw new Error('GitHub, issues ouvertes : réponse inattendue');
  const issue = ouvertes.find(i => !i.pull_request && String(i.body).includes(MARQUE));
  if (!alertes.length) {
    if (!issue) return 'rien à faire';
    await api(`/issues/${issue.number}/comments`, { methode: 'POST', corps: { body: 'Tout est à jour.' } });
    await api(`/issues/${issue.number}`, { methode: 'PATCH', corps: { state: 'closed', state_reason: 'completed' } });
    return `issue #${issue.number} fermée`;
  }
  const corps = corpsIssue(alertes);
  if (!issue) {
    const creee = await api('/issues', { methode: 'POST', corps: { title: titreIssue(alertes), body: corps, assignees: [depot.split('/')[0]] } });
    // GitHub écarte sans rien dire un assigné refusé : l'échec est alors le seul avertissement.
    if (!Array.isArray(creee.assignees) || !creee.assignees.length) throw new Error(`issue #${creee.number} ouverte sans assigné : GitHub ne préviendra personne`);
    return `issue #${creee.number} ouverte`;
  }
  if (issue.body === corps) return `issue #${issue.number} inchangée`;
  // Le message d'abord : s'il échoue, le corps garde ses clés et le lundi suivant le renvoie.
  const connues = new Set((/<!-- cles: (.*?) -->/.exec(issue.body) || [, ''])[1].split(' '));
  const nouvelles = alertes.filter(a => !connues.has(a.cle));
  if (nouvelles.length) await api(`/issues/${issue.number}/comments`, { methode: 'POST', corps: { body: `Nouveau :\n\n${lignesAlertes(nouvelles)}` } });
  await api(`/issues/${issue.number}`, { methode: 'PATCH', corps: { title: titreIssue(alertes), body: corps } });
  return `issue #${issue.number} mise à jour`;
}

async function veille({ appel = fetch, lire, aujourdHui = new Date().toISOString().slice(0, 10), depot, jeton, simulation = false, journal = console.log }) {
  const entetesGithub = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'karafun-plus-veille',
    ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) };
  const alertes = await alertesDuJour({ appel, lire, aujourdHui, entetesGithub });
  journal(alertes.length ? lignesAlertes(alertes) : 'Tout est à jour.');
  if (simulation) return { alertes, action: 'simulation' };
  const action = await tenirIssue({ appel, depot, entetesGithub, alertes });
  journal(`Veille des versions : ${action}.`);
  return { alertes, action };
}

if (require.main === module) {
  const simulation = process.argv.includes('--simulation');
  const depot = process.env.GITHUB_REPOSITORY, jeton = process.env.GITHUB_TOKEN;
  if (!simulation && !(depot && jeton)) {
    console.error('GITHUB_REPOSITORY et GITHUB_TOKEN sont requis, sauf avec --simulation.');
    process.exit(2);
  }
  veille({ depot, jeton, simulation }).catch(erreur => {
    console.error(`::error::Veille des versions impossible : ${erreur.message}`);
    process.exitCode = 1;
  });
}

module.exports = { versionsEnService, comparer, alertesCycle, alertesOutil, parutionsNpm, parutionsGithub, cyclesLus, corpsIssue, veille, CYCLES, OUTILS, MARQUE };
