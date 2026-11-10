'use strict';
// Veille des versions (scripts/veille-versions.js), sans réseau : les réponses de
// endoflife.date, du registre npm et de GitHub sont simulées, sur le modèle de
// leurs réponses réelles du 6 novembre 2026. Le premier test lit les vrais
// fichiers du dépôt : un changement de leur forme se voit ici, pas le lundi.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { versionsEnService, comparer, alertesCycle, alertesOutil, parutionsNpm, parutionsGithub, cyclesLus, corpsIssue, veille, CYCLES, OUTILS, MARQUE } = require('../scripts/veille-versions');

const cycle = id => CYCLES.find(c => c.id === id);
const outil = id => OUTILS.find(o => o.id === id);
const AUJOURDHUI = '2026-11-06';
const EN_SERVICE = { node: '26', debian: 'trixie', java: '25', maven: '3.10', ubuntu: '26.04', playwright: '1.64.1', actionlint: '1.7.12', trivy: '0.76.1', zizmor: '1.32.0' };
const NODE = [
  { name: '27', releaseDate: '2027-04-22', isLts: false, ltsFrom: '2027-10-20', isEol: false, eolFrom: '2030-04-30', isMaintained: false },
  { name: '26', releaseDate: '2026-05-05', isLts: true, ltsFrom: '2026-10-28', isEol: false, eolFrom: '2029-04-30', isMaintained: true },
  { name: '25', releaseDate: '2025-10-15', isLts: false, ltsFrom: null, isEol: true, eolFrom: '2026-06-01', isMaintained: false },
];
const TEMURIN = [
  { name: '27', releaseDate: '2026-09-22', isLts: false, ltsFrom: null, isEol: false, eolFrom: '2027-03-23', isMaintained: true },
  { name: '25', releaseDate: '2025-09-22', isLts: true, ltsFrom: null, isEol: false, eolFrom: '2031-09-30', isMaintained: true },
];
const DEBIAN = [
  { name: '13', codename: 'Trixie', releaseDate: '2025-08-09', isLts: false, isEol: false, eolFrom: '2030-06-30', isMaintained: true },
  { name: '12', codename: 'Bookworm', releaseDate: '2023-06-10', isLts: false, isEol: false, eolFrom: '2028-06-30', isMaintained: true },
];
const MAVEN = [
  { name: '3.10', codename: null, releaseDate: '2026-09-27', isLts: false, isEol: false, eolFrom: null, isMaintained: true },
  { name: '3.9', codename: null, releaseDate: '2023-01-31', isLts: false, isEol: false, eolFrom: null, isMaintained: true },
];
const UBUNTU = [
  { name: '26.10', releaseDate: '2026-10-15', isLts: false, isEol: false, eolFrom: '2027-07-01', isMaintained: true },
  { name: '26.04', releaseDate: '2026-04-23', isLts: true, isEol: false, eolFrom: '2031-05-29', isMaintained: true },
];
const alertes = (id, sorties, enService = EN_SERVICE, jour = AUJOURDHUI) => alertesCycle(cycle(id), enService, sorties, jour);

test('V1 les versions en service se lisent dans les vrais fichiers du dépôt', () => {
  const lues = versionsEnService();
  assert.deepEqual(Object.keys(lues).sort(), Object.keys(EN_SERVICE).sort());
  for (const nom of ['node', 'java']) assert.match(lues[nom], /^\d+$/, nom);
  assert.match(lues.debian, /^[a-z]+$/);
  assert.match(lues.maven, /^\d+\.\d+$/);
  assert.match(lues.ubuntu, /^\d+\.\d+$/);
  for (const nom of ['playwright', 'actionlint', 'trivy', 'zizmor']) assert.match(lues[nom], /^\d+\.\d+\.\d+$/, nom);
  assert.throws(() => versionsEnService(() => 'rien ici'), /Dockerfile : version introuvable/);
});

test('V2 une nouvelle LTS alerte ; une version non LTS, même plus récente, jamais', () => {
  assert.deepEqual(alertes('node', NODE), [], 'Node 27 pas encore LTS');
  assert.deepEqual(alertes('java', TEMURIN), [], 'Temurin 27 non LTS');
  assert.deepEqual(alertes('ubuntu', UBUNTU), [], 'Ubuntu 26.10 non LTS');
  const devenue = [{ ...NODE[0], releaseDate: '2027-04-22', isLts: true, ltsFrom: '2027-10-20' }, ...NODE.slice(1)];
  const [alerte, ...reste] = alertes('node', devenue, EN_SERVICE, '2027-10-25');
  assert.deepEqual(reste, []);
  assert.equal(alerte.cle, 'node:27');
  assert.equal(alerte.raison, 'nouvelle LTS');
  assert.equal(alerte.enService, '26');
  assert.equal(alerte.propose, '27');
  // Annoncée comme LTS mais pas encore sortie : pas d'alerte tant qu'elle n'est pas parue.
  assert.deepEqual(alertes('node', devenue, EN_SERVICE, '2027-04-01'), []);
  // Une ligne non LTS en service enfreint la règle, même si rien de plus récent n'est paru.
  const nonLts = [{ ...NODE[0], isMaintained: true }, NODE[1]];
  assert.deepEqual(alertes('node', nonLts, { ...EN_SERVICE, node: '27' }, '2027-05-01').map(a => [a.cle, a.enService, a.propose, a.raison]),
    [['node:hors-lts:27', '27', '26', 'pas une LTS']]);
});

test('V3 Debian se reconnaît à son nom de code, Maven compare 3.10 à 3.9 comme des nombres', () => {
  assert.deepEqual(alertes('debian', DEBIAN), []);
  const suivante = [{ name: '14', codename: 'Forky', releaseDate: '2026-11-01', isLts: false, isEol: false, eolFrom: '2032-06-30', isMaintained: true }, ...DEBIAN];
  assert.deepEqual(alertes('debian', suivante).map(a => [a.cle, a.enService, a.propose, a.raison]), [['debian:14', '13', '14', 'nouvelle version stable']]);
  assert.deepEqual(alertes('maven', MAVEN), [], '3.10 est plus récente que 3.9');
  assert.deepEqual(alertes('maven', MAVEN, { ...EN_SERVICE, maven: '3.9' }).map(a => a.cle), ['maven:3.10']);
  assert.ok(comparer('3.10', '3.9') > 0);
  assert.ok(comparer('1.7.12', '1.7.9') > 0);
  assert.equal(comparer('26.04', '26.04'), 0);
});

test('V4 une fin de support proche alerte, la version sans remplaçant compris', () => {
  const proche = [{ ...NODE[1], eolFrom: '2027-04-30' }];
  assert.deepEqual(alertes('node', proche, EN_SERVICE, '2026-10-01'), [], '211 jours : trop tôt');
  const [fin] = alertes('node', proche, EN_SERVICE, '2026-11-01');
  assert.equal(fin.cle, 'node:fin:26');
  assert.equal(fin.raison, 'fin de support le 2027-04-30');
  const [finie] = alertes('node', [{ ...NODE[1], isEol: true }]);
  assert.equal(finie.raison, 'plus maintenue');
  assert.notEqual(finie.cle, fin.cle, 'autre clé : la fin effective prévient de nouveau');
  assert.deepEqual(alertes('maven', [{ ...MAVEN[0], isMaintained: false }]).map(a => a.raison), ['plus maintenue']);
  assert.deepEqual(alertes('maven', MAVEN), [], 'sans date de fin connue : pas d’alerte');
});

test('V5 une version en service inconnue ou une réponse illisible fait échouer, jamais taire', () => {
  assert.throws(() => alertes('node', NODE.slice(2)), /version en service 26 inconnue/);
  assert.throws(() => alertes('debian', MAVEN), /version en service trixie inconnue/);
  for (const reponse of [null, {}, { result: {} }, { result: { releases: [] } }, { result: { releases: 'x' } }]) {
    assert.throws(() => cyclesLus(reponse, 'nodejs'), /réponse inattendue/, JSON.stringify(reponse));
  }
  const bon = { name: '26', releaseDate: '2026-05-05', isLts: true, isEol: false, isMaintained: true, eolFrom: '2029-04-30' };
  const lire = cycle => cyclesLus({ result: { releases: [cycle] } }, 'nodejs');
  assert.equal(lire(bon).length, 1);
  assert.equal(lire({ ...bon, eolFrom: null }).length, 1, 'sans date de fin connue');
  // Un nom de version ou une date qui n'en est pas un n'entre jamais dans l'issue.
  assert.throws(() => lire({ ...bon, name: '26<img src=x>' }), /cycle illisible/);
  assert.throws(() => lire({ ...bon, releaseDate: 'bientôt' }), /cycle illisible/);
  for (const eolFrom of ['2026-13-99', '2029-04-30 texte libre', ['2029-04-30 texte libre'], 20290430]) {
    assert.throws(() => lire({ ...bon, eolFrom }), /cycle illisible/, JSON.stringify(eolFrom));
  }
  // Un champ renommé ferait taire les alertes : échec, jamais « tout est à jour ».
  for (const champ of ['isLts', 'isEol', 'isMaintained', 'eolFrom']) {
    const { [champ]: _, ...sans } = bon;
    assert.throws(() => lire(sans), /cycle illisible/, champ);
  }
  assert.throws(() => alertes('node', [{ ...NODE[1], isLts: false }]), /aucune version LTS parue/);
  for (const reponse of [{}, { time: {} }, { versions: {} }]) {
    assert.throws(() => parutionsNpm(reponse, 'playwright'), /réponse inattendue/, JSON.stringify(reponse));
  }
  assert.throws(() => parutionsGithub({ message: 'rate limit' }, 'aquasecurity/trivy'), /réponse inattendue/);
  assert.throws(() => alertesOutil(outil('trivy'), EN_SERVICE, [], AUJOURDHUI), /aucune parution/);
});

test('V6 un outil hors Dependabot alerte après 7 jours, comme le délai de Dependabot', () => {
  const npm = parutionsNpm({ time: { created: '2011-01-01T00:00:00Z', modified: '2026-11-05T00:00:00Z', '1.64.1': '2026-10-14T00:00:00Z',
    '1.65.0': '2026-11-05T18:00:00Z', '1.66.0-alpha-1': '2026-10-01T00:00:00Z' },
  versions: { '1.64.1': {}, '1.65.0': {}, '1.66.0-alpha-1': {} } }, 'playwright');
  assert.deepEqual(npm.map(p => p.version), ['1.64.1', '1.65.0'], 'ni préversion ni champs du registre');
  // `time` garde les versions retirées : c'est le cas que le délai de 7 jours doit écarter.
  const retirees = parutionsNpm({ time: { '1.64.1': '2026-10-14T00:00:00Z', '1.65.0': '2026-10-15T00:00:00Z', '1.66.0': '2026-10-16T00:00:00Z' },
    versions: { '1.64.1': {}, '1.65.0': { deprecated: 'à ne plus utiliser' } } }, 'playwright');
  assert.deepEqual(retirees.map(p => p.version), ['1.64.1'], 'ni retirée ni dépréciée');
  assert.deepEqual(alertesOutil(outil('playwright'), EN_SERVICE, npm, AUJOURDHUI), [], '1 jour : trop tôt');
  assert.deepEqual(alertesOutil(outil('playwright'), EN_SERVICE, npm, '2026-11-11'), [], '6 jours : trop tôt');
  const [alerte] = alertesOutil(outil('playwright'), EN_SERVICE, npm, '2026-11-12');
  assert.equal(alerte.cle, 'playwright:1.65.0');
  assert.equal(alerte.lien, 'https://github.com/microsoft/playwright/releases');
  const github = parutionsGithub([
    { tag_name: 'v0.77.0', published_at: '2026-10-01T00:00:00Z', draft: true, prerelease: false },
    { tag_name: 'v0.78.0-rc1', published_at: '2026-10-01T00:00:00Z', draft: false, prerelease: true },
    { tag_name: 'canari', published_at: '2026-10-01T00:00:00Z', draft: false, prerelease: false },
    { tag_name: 'v0.76.2', published_at: '2026-10-20T00:00:00Z', draft: false, prerelease: false },
    { tag_name: 'v0.76.0', published_at: '2026-10-14T00:00:00Z', draft: false, prerelease: false },
  ], 'aquasecurity/trivy');
  assert.deepEqual(github.map(p => p.version), ['0.76.2', '0.76.0']);
  assert.deepEqual(alertesOutil(outil('trivy'), EN_SERVICE, github, AUJOURDHUI).map(a => [a.cle, a.enService, a.propose]), [['trivy:0.76.2', '0.76.1', '0.76.2']]);
  assert.deepEqual(alertesOutil(outil('trivy'), { ...EN_SERVICE, trivy: '0.76.2' }, github, AUJOURDHUI), [], 'déjà à jour');
});

// Réseau simulé : réponses par adresse, écritures notées.
function reseau({ issues = [], reponses = {}, refus = null, assignees = [{ login: 'proprietaire' }] } = {}) {
  const ecritures = [];
  const table = {
    'https://endoflife.date/api/v1/products/nodejs/': { result: { releases: NODE } },
    'https://endoflife.date/api/v1/products/eclipse-temurin/': { result: { releases: TEMURIN } },
    'https://endoflife.date/api/v1/products/ubuntu/': { result: { releases: UBUNTU } },
    'https://endoflife.date/api/v1/products/debian/': { result: { releases: DEBIAN } },
    'https://endoflife.date/api/v1/products/apache-maven/': { result: { releases: MAVEN } },
    'https://registry.npmjs.org/playwright': { time: { '1.64.1': '2026-10-14T00:00:00Z' }, versions: { '1.64.1': {} } },
    'https://api.github.com/repos/aquasecurity/trivy/releases?per_page=30': [{ tag_name: 'v0.76.1', published_at: '2026-10-21T00:00:00Z' }],
    'https://api.github.com/repos/zizmorcore/zizmor/releases?per_page=30': [{ tag_name: 'v1.32.0', published_at: '2026-11-02T00:00:00Z' }],
    'https://api.github.com/repos/rhysd/actionlint/releases?per_page=30': [{ tag_name: 'v1.7.12', published_at: '2026-03-30T00:00:00Z' }],
    ...reponses,
  };
  const appel = async (url, options = {}) => {
    if (options.method) {
      if (refus && url.endsWith(refus)) return { ok: false, status: 500, json: async () => ({}) };
      ecritures.push({ url: url.replace('https://api.github.com/repos/proprietaire/depot', ''), methode: options.method, corps: JSON.parse(options.body), entetes: options.headers });
      return { ok: true, status: 201, json: async () => ({ number: 7, assignees }) };
    }
    if (url.includes('/repos/proprietaire/depot/issues?')) return { ok: true, status: 200, json: async () => issues };
    if (!(url in table)) throw new Error(`adresse inattendue : ${url}`);
    const reponse = table[url];
    if (typeof reponse === 'number') return { ok: false, status: reponse, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => reponse };
  };
  return { appel, ecritures };
}
const FICHIERS = {
  Dockerfile: 'FROM maven:3.10-eclipse-temurin-25@sha256:a AS s\nFROM eclipse-temurin:25-jdk@sha256:b AS j\nFROM node:26-trixie-slim@sha256:c\n',
  '.github/workflows/ci.yml': 'runs-on: ubuntu-26.04\nrun: npm install --global playwright@1.64.1\nrhysd/actionlint:1.7.12@sha256:d\n',
  '.github/workflows/securite.yml': `TRIVY_VERSION: v0.76.1\n      - uses: zizmorcore/zizmor-action@${'a'.repeat(40)} # v0.8.1\n        with:\n          # version fixée\n          version: 1.32.0\n`,
};
const lancer = (filet, jour = AUJOURDHUI) => veille({ appel: filet.appel, lire: f => FICHIERS[f], aujourdHui: jour, depot: 'proprietaire/depot', jeton: 'jeton-essai', journal: () => {} });
const NOUVELLE_TRIVY = { 'https://api.github.com/repos/aquasecurity/trivy/releases?per_page=30': [{ tag_name: 'v0.76.2', published_at: '2026-10-20T00:00:00Z' }] };
const NOUVEAU_ZIZMOR = { 'https://api.github.com/repos/zizmorcore/zizmor/releases?per_page=30': [{ tag_name: 'v1.33.0', published_at: '2026-10-01T00:00:00Z' }] };

test('V7 tout à jour et aucune issue : aucune écriture', async () => {
  const filet = reseau();
  const { alertes: vues, action } = await lancer(filet);
  assert.deepEqual(vues, []);
  assert.equal(action, 'rien à faire');
  assert.deepEqual(filet.ecritures, []);
});

test('V8 une alerte ouvre une seule issue, assignée au propriétaire du dépôt', async () => {
  const filet = reseau({ reponses: NOUVELLE_TRIVY });
  const { action } = await lancer(filet);
  assert.equal(action, 'issue #7 ouverte');
  assert.equal(filet.ecritures.length, 1);
  const [{ url, methode, corps, entetes }] = filet.ecritures;
  assert.equal(url, '/issues');
  assert.equal(methode, 'POST');
  assert.deepEqual(corps.assignees, ['proprietaire']);
  assert.equal(corps.title, 'Veille des versions : 1 remontée à faire');
  assert.ok(corps.body.startsWith(MARQUE));
  assert.match(corps.body, /\| \[Trivy\]\(https:\/\/github\.com\/aquasecurity\/trivy\/releases\) \| 0\.76\.1 \| 0\.76\.2 \| nouvelle version \|/);
  assert.match(corps.body, /Règle de la dernière LTS/);
  assert.equal(entetes.Authorization, 'Bearer jeton-essai');
});

test('V9 issue ouverte : inchangée sans écriture, message seulement pour une alerte nouvelle', async () => {
  const [alerteTrivy] = alertesOutil(outil('trivy'), EN_SERVICE, [{ version: '0.76.2', date: '2026-10-20T00:00:00Z' }], AUJOURDHUI);
  const issue = { number: 3, body: corpsIssue([alerteTrivy]) };
  const autres = [{ number: 1, body: 'autre issue du robot' }, { number: 2, body: `${MARQUE} dans une PR`, pull_request: {} }];

  const meme = reseau({ issues: [...autres, issue], reponses: NOUVELLE_TRIVY });
  assert.equal((await lancer(meme)).action, 'issue #3 inchangée');
  assert.deepEqual(meme.ecritures, []);

  const plus = reseau({ issues: [...autres, issue], reponses: { ...NOUVELLE_TRIVY, ...NOUVEAU_ZIZMOR } });
  assert.equal((await lancer(plus)).action, 'issue #3 mise à jour');
  assert.deepEqual(plus.ecritures.map(e => [e.methode, e.url]), [['POST', '/issues/3/comments'], ['PATCH', '/issues/3']]);
  assert.match(plus.ecritures[0].corps.body, /^Nouveau :\n\n- zizmor : nouvelle version, 1\.32\.0 en service, 1\.33\.0 proposé$/);
  assert.equal(plus.ecritures[1].corps.title, 'Veille des versions : 2 remontées à faire');

  // Une alerte en moins : le corps change, sans message.
  const moins = reseau({ issues: [{ number: 3, body: plus.ecritures[1].corps.body }], reponses: NOUVELLE_TRIVY });
  assert.equal((await lancer(moins)).action, 'issue #3 mise à jour');
  assert.deepEqual(moins.ecritures.map(e => [e.methode, e.url]), [['PATCH', '/issues/3']]);
});

test('V10 tout à jour avec une issue ouverte : message puis fermeture', async () => {
  const [alerteTrivy] = alertesOutil(outil('trivy'), EN_SERVICE, [{ version: '0.76.2', date: '2026-10-20T00:00:00Z' }], AUJOURDHUI);
  const filet = reseau({ issues: [{ number: 3, body: corpsIssue([alerteTrivy]) }] });
  assert.equal((await lancer(filet)).action, 'issue #3 fermée');
  assert.deepEqual(filet.ecritures.map(e => [e.methode, e.url]), [['POST', '/issues/3/comments'], ['PATCH', '/issues/3']]);
  assert.deepEqual(filet.ecritures[1].corps, { state: 'closed', state_reason: 'completed' });
});

test('V11 une source en panne fait échouer sans rien écrire', async () => {
  const panne = reseau({ reponses: { 'https://endoflife.date/api/v1/products/debian/': 503 } });
  await assert.rejects(lancer(panne), /products\/debian\/ : HTTP 503/);
  assert.deepEqual(panne.ecritures, []);
  const limite = reseau({ reponses: { 'https://api.github.com/repos/rhysd/actionlint/releases?per_page=30': 403 } });
  await assert.rejects(lancer(limite), /rhysd\/actionlint.* : HTTP 403/);
  assert.deepEqual(limite.ecritures, []);
  // Liste des issues illisible : aucune écriture, sinon une seconde issue s'ouvrirait.
  const issues = reseau({ issues: { message: 'indisponible' }, reponses: NOUVELLE_TRIVY });
  await assert.rejects(lancer(issues), /issues ouvertes : réponse inattendue/);
  assert.deepEqual(issues.ecritures, []);
});

test('V12 --simulation n’écrit rien et le script refuse de tourner sans jeton', async () => {
  const filet = reseau({ reponses: NOUVELLE_TRIVY });
  const lignes = [];
  const { action, alertes: vues } = await veille({ appel: filet.appel, lire: f => FICHIERS[f], aujourdHui: AUJOURDHUI, simulation: true, journal: ligne => lignes.push(ligne) });
  assert.equal(action, 'simulation');
  assert.equal(vues.length, 1);
  assert.deepEqual(filet.ecritures, []);
  assert.match(lignes.join('\n'), /Trivy : nouvelle version, 0\.76\.1 en service, 0\.76\.2 proposé/);
  const { GITHUB_REPOSITORY, GITHUB_TOKEN, ...env } = process.env;
  const sans = spawnSync(process.execPath, [require.resolve('../scripts/veille-versions')], { encoding: 'utf8', env });
  assert.equal(sans.status, 2);
  assert.match(sans.stderr, /GITHUB_REPOSITORY et GITHUB_TOKEN sont requis/);
});

test('V13 une issue ouverte sans assigné fait échouer : personne ne serait prévenu', async () => {
  const filet = reseau({ reponses: NOUVELLE_TRIVY, assignees: [] });
  await assert.rejects(lancer(filet), /issue #7 ouverte sans assigné/);
});

test('V14 un message refusé laisse l’issue telle quelle : le lundi suivant le renvoie', async () => {
  const [alerteTrivy] = alertesOutil(outil('trivy'), EN_SERVICE, [{ version: '0.76.2', date: '2026-10-20T00:00:00Z' }], AUJOURDHUI);
  const issue = { number: 3, body: corpsIssue([alerteTrivy]) };
  const reponses = { ...NOUVELLE_TRIVY, ...NOUVEAU_ZIZMOR };
  const panne = reseau({ issues: [issue], reponses, refus: '/issues/3/comments' });
  await assert.rejects(lancer(panne), /HTTP 500/);
  assert.deepEqual(panne.ecritures, [], 'corps inchangé : les clés restent les anciennes');
  const lundiSuivant = reseau({ issues: [issue], reponses });
  await lancer(lundiSuivant);
  assert.deepEqual(lundiSuivant.ecritures.map(e => [e.methode, e.url]), [['POST', '/issues/3/comments'], ['PATCH', '/issues/3']]);
});

test('V15 du texte ajouté au-dessus du marqueur n’ouvre pas une seconde issue', async () => {
  const [alerteTrivy] = alertesOutil(outil('trivy'), EN_SERVICE, [{ version: '0.76.2', date: '2026-10-20T00:00:00Z' }], AUJOURDHUI);
  const filet = reseau({ issues: [{ number: 3, body: `Note du mainteneur\n\n${corpsIssue([alerteTrivy])}` }], reponses: NOUVELLE_TRIVY });
  assert.equal((await lancer(filet)).action, 'issue #3 mise à jour');
  assert.deepEqual(filet.ecritures.map(e => [e.methode, e.url]), [['PATCH', '/issues/3']]);
});

test('V16 un champ renommé par la source ne ferme jamais l’issue', async () => {
  const [alerteTrivy] = alertesOutil(outil('trivy'), EN_SERVICE, [{ version: '0.76.2', date: '2026-10-20T00:00:00Z' }], AUJOURDHUI);
  const sansLts = NODE.map(({ isLts, ...reste }) => reste);
  const filet = reseau({ issues: [{ number: 3, body: corpsIssue([alerteTrivy]) }], reponses: { 'https://endoflife.date/api/v1/products/nodejs/': { result: { releases: sansLts } } } });
  await assert.rejects(lancer(filet), /nodejs : cycle illisible/);
  assert.deepEqual(filet.ecritures, []);
});

test('V17 la version de zizmor se lit sous son action, pas sur un autre « version: »', () => {
  const lues = versionsEnService(fichier => fichier === '.github/workflows/securite.yml' ? `          version: 9.9.9\n${FICHIERS[fichier]}` : FICHIERS[fichier]);
  assert.equal(lues.zizmor, '1.32.0');
});
