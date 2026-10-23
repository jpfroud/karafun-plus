'use strict';
// Documents de la file (issue #30) : guide du serveur Linux
// (DEPLOIEMENT-SERVEUR.md) et variantes serveur des autres documents.
// Lecture seule des fichiers du dépôt, rien n'est lancé.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8').replace(/\r\n/g, '\n');
const exists = file => fs.existsSync(path.join(root, ...file.split('/')));
const flat = text => text.replace(/\s+/g, ' ');

const GUIDE = 'DEPLOIEMENT-SERVEUR.md';
const DOCS = ['README.md', 'GUIDE-BAR.md', 'LISEZMOI.txt', 'CONTEXTE-REPRISE.md', '.github/RELEASE.md', 'AGENTS.md', GUIDE];
// Variables du mode serveur et de l'exploitation (épopée #18).
const CONTRAT = ['KARAOKE_MODE', 'KARAOKE_BIND', 'KARAOKE_PUBLIC_BIND', 'KARAOKE_PUBLIC_URL', 'KARAOKE_STAFF_URL',
  'KARAOKE_STAFF_KEY_FILE', 'KARAOKE_CLIENT_IP_HEADER', 'KARAOKE_TRUSTED_PROXIES', 'KARAOKE_SOLVER_JVM_ARGS'];
const TITRE = '# Déployer la file karaoké sur un serveur Linux';
const PLAN = [
  'Vue d\'ensemble', 'Avant de commencer', 'Créer le VPS chez OVHcloud', 'Première connexion, clé SSH et mises à jour',
  'Utilisateur d\'administration et SSH sans mot de passe', 'Pare-feu', 'Installer Docker',
  'Diagnostic KaraFun depuis le serveur', 'Noms d\'hôtes chez OVHcloud', 'Fichiers du serveur et secrets',
  'Premier démarrage', 'Bascule depuis un PC Windows', 'Lien de la page du bar', 'Ouverture du bar chaque soir',
  'Spotify', 'Sauvegarde et restauration', 'Mise à jour et retour à la version précédente',
  'Vérifications et dépannage', 'Retour arrière vers le kit Windows', 'Données personnelles et accès',
].map((title, i) => `## ${i + 1}. ${title}`);
// Compte GitHub du dépôt, celui de l'image (Dockerfile, .github/RELEASE.md).
const PROPRIETAIRE = 'jpfroud';
const IMAGE = `ghcr.io/${PROPRIETAIRE}/karafun-plus`;
const RUN_EXCEPTION = 'docker compose run --rm app node server.js --rotate-staff-key';
// Formes uniques des commandes du guide (J9 de l'issue #30), dans l'ordre.
const COMMANDES = [
  'sudo apt full-upgrade -y',
  'Get-Content "$env:USERPROFILE\\.ssh\\id_ed25519.pub" | ssh <utilisateur OVH>@<IPv4 du VPS> "umask 077; mkdir -p ~/.ssh; tr -d \'\\r\' >> ~/.ssh/authorized_keys"',
  'sudo adduser --comment "" karaoke',
  'sudo tee /etc/ssh/sshd_config.d/00-karafun-plus.conf > /dev/null <<\'EOF\'',
  'sudo sshd -t && sudo systemctl restart ssh',
  'sudo ufw default deny incoming',
  'sudo ufw allow 443/udp',
  'sudo ufw enable',
  'URIs: https://download.docker.com/linux/$ID',
  'sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
  `docker run --rm ${IMAGE}:vX.Y.Z node tools/diag-karafun.js <code>`,
  'git checkout vX.Y.Z',
  'chmod 600 .env',
  'docker run --rm -it caddy:2 caddy hash-password',
  'docker compose up -d',
  'docker compose exec app node -e "fetch(\'http://127.0.0.1:3000/readyz\').then(r => r.text()).then(t => console.log(t))"',
  'tar.exe -czf karafun-plus-pc-AAAAMMJJ.tar.gz data',
  './restauration.sh sauvegardes/karafun-plus-pc-AAAAMMJJ.tar.gz',
  'docker compose exec app node server.js --print-staff-url',
  'docker compose exec app node server.js --rotate-staff-key',
  './sauvegarde.sh',
  './restauration.sh sauvegardes/<nom de l\'archive>',
  'docker compose restart app',
  'docker compose stop app',
  'tar.exe -xzf <nom de l\'archive> data',
  'docker compose exec -T app du -sh /app/journal',
  'docker compose exec -T app find /app/journal -maxdepth 1 -type f -mtime +90 -print -delete',
  RUN_EXCEPTION,
  'ssh -N -L 3000:127.0.0.1:3000 karaoke@<IPv4 du VPS>',
];
// Les neuf tests du mode PC et du mode serveur que la règle de AGENTS.md nomme.
const TESTS_DEUX_MODES = ['test/startup-port.test.js', 'test/staff-ui-coverage.test.js', 'test/server-table-routes.test.js',
  'test/kcs-connection.test.js', 'test/kcs-protocol.test.js', 'test/kcs-ratelimit.test.js', 'test/cli-persistence.test.js',
  'test/server-mode.test.js', 'test/server-mode-startup.test.js'];
// Hôtes permis dans le guide (un sous-domaine aussi) ; IPv4 permises en plus
// des bases des blocs CIDR du contrat (DEFAULT_TRUSTED_PROXIES de server.js).
const HOTES = ['exemple.fr', 'github.com', 'ghcr.io', 'karafun.com', 'karafun.fr', 'spotify.com', 'docker.com',
  'letsencrypt.org', 'ovhcloud.com', 'containerd.io'];
const IPV4 = ['127.0.0.1', '0.0.0.0', '1.1.1.1', '8.8.8.8'];
// Premiers segments qui ne sont pas des chemins du dépôt : données, journaux,
// produits de construction, état local.
const HORS_DEPOT = new Set(['data', 'journal', 'node_modules', 'coverage', '.git', '.gstack', 'node', 'solver-runtime',
  'LICENCES-JAVA', 'karaoke-bar', 'sauvegardes']);
const chemin_exempte = target => target === 'deploy/.env' || /^deploy\/sauvegardes(\/|$)/.test(target);

// Lignes des blocs de code (``` éventuellement indentés) et texte sans eux.
function split(text) {
  const code = [];
  const rest = [];
  let inside = false;
  text.split('\n').forEach((line, index) => {
    if (/^\s*```/.test(line)) { inside = !inside; return; }
    (inside ? code : rest).push({ line, number: index + 1 });
  });
  return { code, rest };
}
// Texte courant : sans blocs de code ni lignes de tableau.
function prose(text) {
  return split(text).rest.map(entry => entry.line).filter(line => !line.trim().startsWith('|')).join('\n');
}

const guide = read(GUIDE);
const manifest = JSON.parse(read('livrable.json'));

test('J1 plan du guide serveur', () => {
  const lines = split(guide).rest.map(entry => entry.line);
  const first = lines.find(line => line.trim() !== '');
  const titles = lines.filter(line => /^## /.test(line));
  const message = `${GUIDE} : sections attendues dans cet ordre`;
  assert.equal(first, TITRE, message);
  assert.deepEqual(titles, PLAN, message);
});

test('J2 guide livré dans l\'image et le kit', () => {
  const ignore = read('.dockerignore').split('\n');
  const message = `${GUIDE} doit être dans « commun » de livrable.json et dans .dockerignore`;
  assert.ok(manifest.commun.includes(GUIDE), message);
  assert.ok(!manifest.windows.includes(GUIDE), message);
  assert.ok(ignore.includes(`!${GUIDE}`), message);
});

test('J3 noms du contrat', () => {
  for (const file of DOCS) {
    for (const [name] of read(file).matchAll(/\bKARAOKE_[A-Z0-9_]*[A-Z0-9]\b/g)) {
      assert.ok(CONTRAT.includes(name), `${file} : variable hors contrat ${name}`);
    }
  }
  const tableRows = guide.split('\n').filter(line => line.trim().startsWith('|'));
  for (const [, key] of read('deploy/.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) {
    assert.ok(tableRows.some(row => row.includes(`\`${key}\``)), `${GUIDE} : réglage ${key} de deploy/.env.example non décrit`);
  }
  const server = read('server.js');
  const options = new Set([...server.matchAll(/--([a-z][a-z0-9-]*)/g), ...server.matchAll(/\barg\('([a-z][a-z0-9-]*)'/g)]
    .map(match => `--${match[1]}`));
  for (const [, list] of guide.matchAll(/node server\.js((?:[ \t]+--[a-z][a-z0-9-]*)+)/g)) {
    for (const option of list.trim().split(/\s+/)) {
      assert.ok(options.has(option), `${GUIDE} : option ${option} absente de server.js`);
    }
  }
  for (const [, raw] of guide.matchAll(/(?<![\w./~-])((?:deploy|tools|scripts)\/[\w./-]*)/g)) {
    const target = raw.replace(/[.,;:]+$/, '');
    if (chemin_exempte(target)) continue;
    assert.ok(exists(target), `${GUIDE} : chemin absent ${target}`);
  }
});

test('J4 commandes dangereuses', () => {
  const forbidden = [/--entrypoint/, /KARAFUN_PLUS_VERSION\s*=\s*latest/, /PasswordAuthentication\s+yes/i,
    /ufw\s+allow\b.*\b300[01]\b/, /--plaintext/];
  guide.split('\n').forEach((line, index) => {
    const message = `${GUIDE} : commande dangereuse ligne ${index + 1} : ${line.trim()}`;
    if (/down -v|docker compose run/.test(line) && line.trim() !== RUN_EXCEPTION) {
      assert.match(line, /\bjamais\b/i, message);
    }
    for (const pattern of forbidden) assert.doesNotMatch(line, pattern, message);
  });
});

test('J5 aucune donnée privée', () => {
  const allowedHost = host => HOTES.some(name => host === name || host.endsWith(`.${name}`));
  const bases = [...read('server.js').match(/DEFAULT_TRUSTED_PROXIES = '([^']+)'/)[1].split(',')]
    .map(entry => entry.split('/')[0]);
  const allowedIp = ip => IPV4.includes(ip) || bases.includes(ip);
  const fail = excerpt => `${GUIDE} : donnée privée possible : ${excerpt}`;
  const hosts = [];
  for (const [, host] of guide.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/:?#`'"<>)\]]+)/gi)) hosts.push(host);
  const tld = 'fr|com|org|net|io|eu|be|ch|de|uk|lu|it|es|nl|ca|us|info|biz|app|dev|cloud|ovh|me|co|xyz|site|online|tech';
  for (const [host] of guide.matchAll(new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${tld})\\b`, 'gi'))) hosts.push(host);
  for (const host of hosts) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue;
    assert.ok(allowedHost(host.toLowerCase()), fail(host));
  }
  for (const [ip] of guide.matchAll(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?!\d|\.\d)/g)) assert.ok(allowedIp(ip), fail(ip));
  for (const pattern of [/key=[A-Za-z0-9_-]{16,}/, /\$2[aby]?\$\d\d\$[./A-Za-z0-9]{53}/, /(?<![\w.])\d{5,}(?!\w)/]) {
    const found = guide.match(pattern);
    assert.equal(found, null, fail(found && found[0]));
  }
});

test('J6 liens et chemins cités', () => {
  for (const file of DOCS.filter(name => name !== 'LISEZMOI.txt')) {
    const text = read(file);
    const message = target => `${file} : lien ou chemin cité absent ${target}`;
    for (const [, raw] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), raw.replace(/#.*$/, '')));
      assert.ok(exists(target), message(target));
    }
    for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
      if (!span.includes('/') || /[\s<>*…${}|]/.test(span) || /^(\/|~|\.\.?\/|[a-z][a-z0-9+.-]*:)/i.test(span)) continue;
      const target = span.replace(/#.*$/, '').replace(/:\d+(-\d+)?$/, '');
      const first = target.split('/')[0];
      if (HORS_DEPOT.has(first) || !exists(first) || chemin_exempte(target)) continue;
      assert.ok(exists(target), message(target));
    }
  }
});

test('J7 règle des deux modes', () => {
  const text = read('AGENTS.md');
  const start = text.indexOf('**Cohérence des deux modes**');
  const message = 'AGENTS.md : règle de cohérence des deux modes absente ou incomplète';
  assert.ok(start >= 0, message);
  const end = text.indexOf('\n## ', start);
  const rule = text.slice(start, end < 0 ? undefined : end);
  for (const needed of [GUIDE, 'livrable.json', ...TESTS_DEUX_MODES]) assert.ok(rule.includes(needed), message);
});

test('J8 variantes serveur des documents', () => {
  const expect = (file, text, needed) => assert.ok(flat(text).includes(flat(needed)), `${file} : variante serveur absente : ${needed}`);
  for (const file of DOCS.filter(name => name !== GUIDE)) {
    const text = read(file);
    expect(file, text, GUIDE);
    for (const name of ['Tests Windows', 'Release Windows']) {
      assert.ok(!text.includes(name), `${file} : ancien nom de workflow : ${name}`);
    }
  }
  const bar = read('GUIDE-BAR.md');
  const heading = '### Sur un serveur Linux (VPS)';
  assert.equal(bar.split('\n').filter(line => line === heading).length, 1, `GUIDE-BAR.md : variante serveur absente : ${heading}`);
  for (const needed of [
    'Avec le kit Windows, la clé privée',
    'Sur un serveur Linux, l\'arrêt se fait par `docker compose stop app` et la clé ne change pas (DEPLOIEMENT-SERVEUR.md, sections 13 et 18).',
    'tandis que le serveur 3001 refuse les pages et commandes du bar',
    'Avec le kit Windows, le port 3001 écoute sur `127.0.0.1`, et le domaine et le tunnel publics restent à configurer :',
    'Sur un serveur Linux, Caddy sert le domaine (voir « Sur un serveur Linux (VPS) » plus bas).',
    'Avec le kit Windows, pour piloter',
    'Sur un serveur Linux, la clé reste la même jusqu\'à son renouvellement (DEPLOIEMENT-SERVEUR.md, section 13).',
  ]) expect('GUIDE-BAR.md', bar, needed);
  const lisezmoi = read('LISEZMOI.txt');
  assert.ok(lisezmoi.split('\n').includes('SUR UN SERVEUR LINUX'), 'LISEZMOI.txt : variante serveur absente : SUR UN SERVEUR LINUX');
  for (const needed of [
    'docker compose exec app node server.js --print-staff-url et ne change pas au redémarrage. Arrêt : docker compose stop app.',
    'Avec le kit, le port 3000 du bar ne doit pas être publié ; sur un serveur, depuis Internet, la page du bar ne passe que par Caddy (HTTPS et mot de passe du bar) ; l\'administrateur garde le tunnel SSH (DEPLOIEMENT-SERVEUR.md).',
  ]) expect('LISEZMOI.txt', lisezmoi, needed);
  const contexte = read('CONTEXTE-REPRISE.md');
  for (const needed of [
    '## Déploiement serveur Linux (octobre 2026)',
    'Avec le kit Windows, pour la 4G/5G, il faut un **domaine HTTPS stable et un tunnel nommé** vers `http://127.0.0.1:3001` uniquement.',
    'sur un serveur Linux, depuis Internet, la page du bar ne passe que par Caddy, en HTTPS et derrière le mot de passe du bar ; l\'administrateur garde le tunnel SSH vers `127.0.0.1:3000` (`DEPLOIEMENT-SERVEUR.md`).',
  ]) expect('CONTEXTE-REPRISE.md', contexte, needed);
});

test('J9 commandes clés du guide', () => {
  const lines = new Set(split(guide).code.map(entry => entry.line.trim()));
  for (const command of COMMANDES) assert.ok(lines.has(command), `${GUIDE} : commande attendue absente : ${command}`);
});

test('J10 phrases du guide', () => {
  for (const sentence of prose(guide).split(/(?<=[.!?;:])\s+/)) {
    const words = sentence.split(/\s+/).filter(Boolean);
    assert.ok(words.length <= 40, `${GUIDE} : phrase de ${words.length} mots : ${words.slice(0, 8).join(' ')}`);
  }
});
