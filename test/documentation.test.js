'use strict';
// Documents de la file (issue #30) : guide du serveur Linux
// (DEPLOIEMENT-SERVEUR.md) et variantes serveur des autres documents.
// Lit les fichiers du dépôt. Seules exceptions, hors du dépôt, dans un
// dossier d'essai temporaire préparé par test/dossier-reparation.js : les
// commandes node du §18 de DEPLOIEMENT-SERVEUR.md (réparation des soirées,
// plan du 8 novembre, A6), lancées par node sans leur préfixe, et, hors de
// Windows, la partie grep d'« Envoyer une soirée au développeur », par sh.
// Hors de Windows aussi, dans un dossier temporaire vide : les blocs bash du
// §18 qui lancent tar ou retirent un morceau, par bash, avec un faux docker
// qui note ses appels, et leur garde de l'identifiant.
// Aucun serveur, aucun port, jamais le vrai KaraFun.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const dossierReparation = require('./dossier-reparation');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8').replace(/\r\n/g, '\n');
const exists = file => fs.existsSync(path.join(root, ...file.split('/')));
const flat = text => text.replace(/\s+/g, ' ');

const GUIDE = 'DEPLOIEMENT-SERVEUR.md';
const DOCS = ['README.md', 'GUIDE-BAR.md', 'LISEZMOI.txt', 'CONTEXTE-REPRISE.md', '.github/RELEASE.md', 'AGENTS.md', 'SECURITY.md', 'CONTRIBUTING.md', GUIDE];
// Variables du mode serveur et de l'exploitation (épopée #18), et
// KARAOKE_REPAIR, qui coupe la réparation des soirées dans les deux modes
// (plan du 8 novembre, A6).
const CONTRAT = ['KARAOKE_MODE', 'KARAOKE_BIND', 'KARAOKE_PUBLIC_BIND', 'KARAOKE_PUBLIC_URL', 'KARAOKE_STAFF_URL',
  'KARAOKE_STAFF_KEY_FILE', 'KARAOKE_CLIENT_IP_HEADER', 'KARAOKE_TRUSTED_PROXIES', 'KARAOKE_SOLVER_JVM_ARGS', 'KARAOKE_UPDATE_DIR',
  'KARAOKE_REPAIR'];
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
// Formes uniques des commandes ponctuelles (décision T3 de l'épopée #18).
const DIAGNOSTIC = `docker run --rm ${IMAGE}:vX.Y.Z node tools/diag-karafun.js <code>`;
const LIEN = 'docker compose exec app node server.js --print-staff-url';
const ROTATION = 'docker compose exec app node server.js --rotate-staff-key';
// Réparation des soirées (§18, plan du 8 novembre, A6). « Couper la
// réparation », dans l'ordre : la ligne posée dans .env, le contrôle, puis
// son retrait.
const COUPURE = [
  "printf '\\nKARAOKE_REPAIR=off\\n' >> .env",
  'docker compose up -d app',
  "docker compose logs --no-log-prefix app | grep 'Réparation des soirées'",
  "sed -i '/^KARAOKE_REPAIR=/d' .env",
];
// Commandes node de « Revenir à l'original d'une soirée découpée » et de
// « Refaire une réparation en échec » ([option, code]). Chacune vérifie
// d'abord l'identifiant (validEveningId d'evening-journal.js), sans « ! »,
// « $ » ni accent grave, ses chaînes entre apostrophes droites : la même
// ligne passe telle quelle dans bash et dans PowerShell.
const VERIFIE_ID = "const ok=require('./evening-journal').validEveningId(process.argv[1]);if(ok===false){console.error('Identifiant de soirée invalide : '+process.argv[1]+' (forme 2026-11-06_2040_ab12). Rien ne change.');process.exit(1)}";
const NODE_18 = {
  controle: ['-p', `${VERIFIE_ID}require('./data/soirees-originales/'+process.argv[1]+'/1/meta.json').endedAt`],
  liste: ['-e', `${VERIFIE_ID}const fs=require('fs'),id=process.argv[1],v=require('./evening-journal').validEveningId;for(const n of fs.readdirSync('data/soirees')){if(n===id||v(n)===false)continue;let m=null;try{m=JSON.parse(fs.readFileSync('data/soirees/'+n+'/meta.json','utf8'))}catch(e){}if(m&&m.split&&m.split.from===id)console.log(n)}`],
  recopie: ['-e', `${VERIFIE_ID}const fs=require('fs'),id=process.argv[1],o='data/soirees-originales/'+id+'/1/',d='data/soirees/'+id+'/';for(const n of ['journal.jsonl','meta.json'])fs.copyFileSync(o+n,d+n);if(fs.existsSync(o+'summary.json'))fs.copyFileSync(o+'summary.json',d+'summary.json');else fs.rmSync(d+'summary.json',{force:true});console.log(id+' : original recopié')`],
  ok: ['-e', `${VERIFIE_ID}const fs=require('fs'),f='data/soirees/.bornage.json',id=process.argv[1],x=JSON.parse(fs.readFileSync(f,'utf8'));x.checked[id]='ok';fs.writeFileSync(f+'.tmp',JSON.stringify(x));fs.renameSync(f+'.tmp',f);console.log(id+' : ok dans '+f)`],
  retrait: ['-e', `${VERIFIE_ID}const fs=require('fs'),f='data/soirees/.bornage.json',id=process.argv[1],x=JSON.parse(fs.readFileSync(f,'utf8'));if(typeof x.checked[id]==='undefined'){console.error(id+' absent de '+f+' : rien ne change.');process.exitCode=1}else{delete x.checked[id];fs.writeFileSync(f+'.tmp',JSON.stringify(x));fs.renameSync(f+'.tmp',f);console.log(id+' retiré de '+f+' : refait au prochain démarrage.')}`],
};
// Sur le serveur, application arrêtée : un conteneur ponctuel de app, sans
// port ni seconde file, comme deploy/sauvegarde.sh ; application en marche :
// docker compose exec. Sur le PC : node\node.exe, dans le dossier karaoke-bar.
const RUN_REPARATION = 'docker compose run --rm --no-deps -T app';
const EXEC_APP = 'docker compose exec -T app';
const bashNode = (prefix, [option, code]) => `${prefix} node ${option} "${code}" "$id"`;
const pcNode = ([option, code]) => `node\\node.exe ${option} "${code}" $id`;
// Garde de tar et du retrait d'un morceau (un morceau est aussi une soirée),
// en tête de leur propre ligne : une vérification sur une ligne à part
// n'arrêterait pas la suivante, collée avec elle. Elle admet la forme de
// validEveningId (ID_PATTERN d'evening-journal.js), sinon écrit le message
// des commandes node et ne lance rien. bash : [[:digit:]], toujours les dix
// chiffres, quand une plage [0-9] de regcomp peut suivre la locale ;
// PowerShell : -cmatch, sensible à la casse, [0-9], car \d y prend tout
// chiffre Unicode, et \z, car $ y admet un saut de ligne final.
const MOTIF_BASH = '^[[:digit:]]{4}-[[:digit:]]{2}-[[:digit:]]{2}_[[:digit:]]{4}_[[:digit:]abcdef]{4}$';
const MOTIF_PS = '^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}_[0-9a-f]{4}\\z';
const messageGarde = variable => `Identifiant de soirée invalide : $${variable} (forme 2026-11-06_2040_ab12). Rien ne change.`;
const gardeBash = (variable, commande) => `if [[ $${variable} =~ ${MOTIF_BASH} ]]; then ${commande}; else echo "${messageGarde(variable)}" >&2; fi`;
const gardePs = (variable, commande) => `if ($${variable} -cmatch '${MOTIF_PS}') { ${commande} } else { throw "${messageGarde(variable)}" }`;
// Retrait d'un morceau (« Revenir à l'original », étape 4), après
// morceau=<morceau> ; archive d'« Envoyer une soirée au développeur », que
// umask 077 crée lisible par son seul propriétaire.
const RETRAIT_BASH = gardeBash('morceau', `${RUN_REPARATION} rm -r "data/soirees/$morceau"`);
const RETRAIT_PC = gardePs('morceau', 'Remove-Item -Recurse "data\\soirees\\$morceau"');
const TAR_BASH = gardeBash('id', `(umask 077; ${EXEC_APP} tar -czf - -C /app "data/soirees/$id" "data/soirees-originales/$id" > ~/soiree-"$id".tar.gz)`);
const TAR_PC = gardePs('id', 'tar.exe -czf "$HOME\\soiree-$id.tar.gz" "data/soirees/$id" "data/soirees-originales/$id"');
// Lignes de docker compose run du §18, seconde exception de J4 (« Jamais »).
const RUN_18 = [...['controle', 'liste', 'recopie', 'ok', 'retrait'].map(name => bashNode(RUN_REPARATION, NODE_18[name])), RETRAIT_BASH];
// « Envoyer une soirée au développeur », sur le serveur puis sur le PC.
const ENVOI = [
  `${EXEC_APP} sh -c 'grep -hE "^[^ ]+ (Réparation|Fin de soirée)" /app/journal/serveur-*.log' | grep -v 'Clé du bar' > ~/envoi.txt`,
  bashNode(EXEC_APP, NODE_18.liste),
  TAR_BASH,
];
const ENVOI_PC = [
  "Select-String -Path journal\\serveur-*.log -Encoding UTF8 -Pattern '^\\S+ (Réparation|Fin de soirée)' | ForEach-Object { $_.Line } | Where-Object { $_ -notmatch 'Clé du bar' } | Set-Content -Path $HOME\\envoi.txt -Encoding UTF8",
  pcNode(NODE_18.liste),
  TAR_PC,
];
// Lignes des commandes node du §18, retirées du texte que lisent J3 et J5 :
// leurs « ./ » sont des modules de l'application, et leurs « a.b », du
// JavaScript, jamais un hôte.
const LIGNES_NODE_18 = new Set([...Object.values(NODE_18).flatMap(command => [bashNode(RUN_REPARATION, command), pcNode(command)]),
  bashNode(EXEC_APP, NODE_18.liste)]);
const horsNode18 = lines => lines.filter(line => !LIGNES_NODE_18.has(line.trim()));
// Commandes du guide (J9 de l'issue #30, J9-14 avec --bcrypt-cost 10 depuis
// #29), dans l'ordre.
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
  DIAGNOSTIC,
  'git checkout vX.Y.Z',
  'chmod 600 .env',
  'docker run --rm -it caddy:2 caddy hash-password --bcrypt-cost 10',
  'docker compose up -d',
  'docker compose exec app node -e "fetch(\'http://127.0.0.1:3000/readyz\').then(r => r.text()).then(t => console.log(t))"',
  'tar.exe -czf karafun-plus-pc-AAAAMMJJ.tar.gz data',
  './restauration.sh sauvegardes/karafun-plus-pc-AAAAMMJJ.tar.gz',
  LIEN,
  ROTATION,
  './sauvegarde.sh',
  './restauration.sh sauvegardes/<nom de l\'archive>',
  'docker compose restart app',
  'docker compose stop app',
  'tar.exe -xzf <nom de l\'archive> data',
  'docker compose exec -T app du -sh /app/journal',
  'docker compose exec -T app find /app/journal -maxdepth 1 -type f -mtime +90 -print -delete',
  ...COUPURE,
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
// Domaines de premier niveau repérés hors URL : tous ceux de deux lettres
// (pays), sauf les extensions de fichier du guide, et les génériques courants
// ou ceux d'un bar et d'une ville (un vrai nom en .paris ou .bar ne doit pas passer).
const TLD = ['[a-z]{2}', 'com', 'org', 'net', 'info', 'biz', 'app', 'dev', 'cloud', 'ovh', 'xyz', 'site', 'online', 'tech',
  'bar', 'pub', 'fun', 'club', 'paris', 'bzh', 'live', 'events', 'music', 'pro', 'shop', 'store', 'top', 'cafe',
  'restaurant', 'party', 'karaoke', 'space', 'world'];
// Extensions des fichiers cités par les documents : jamais un domaine visé.
const EXTENSIONS = new Set(['md', 'js', 'sh', 'py', 'gz', 'conf', 'exe', 'bat', 'zip', 'json', 'jsonl', 'yaml', 'txt', 'tar', 'log', 'html']);
// Tout autre mot pointé, quel que soit son dernier niveau (.studio), accents
// compris, sauf un membre de code : après « . », « / », « \ » ou « $ », ou
// suivi de « ( ».
const MOT_POINTE = /(?<![\p{L}\p{N}_.\/\\$-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+\p{L}{2,}(?![\p{L}\p{N}_(-])/gu;
// Chemins du dépôt repérés dans une commande citée entre accents graves.
const CHEMIN_DEPOT = /^(?:test|tools|scripts|deploy|solver|public|launcher|\.claude|\.github)\/[\w./-]+$/;
// Premiers segments qui ne sont pas des chemins du dépôt : données, journaux,
// produits de construction, état local.
const HORS_DEPOT = new Set(['data', 'journal', 'node_modules', 'coverage', '.git', '.gstack', 'node', 'solver-runtime',
  'LICENCES-JAVA', 'karaoke-bar', 'sauvegardes']);
const chemin_exempte = target => target === 'deploy/.env' || /^deploy\/sauvegardes(\/|$)/.test(target);
// Textes avec « / » qui ne sont pas des chemins : ports du pare-feu, fuseau,
// image d'un registre (premier segment en forme d'hôte), branche git.
const NON_CHEMIN = [/^\d+\/(tcp|udp)$/, /^Europe\//, /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i, /^fix\//];

// Lignes des blocs de code (``` éventuellement indentés) et texte sans eux.
function split(text) {
  const code = [];
  const rest = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { inside = !inside; continue; }
    (inside ? code : rest).push(line);
  }
  return { code, rest };
}
// Texte courant : sans blocs de code ni lignes de tableau.
function prose(text) {
  return split(text).rest.filter(line => !line.trim().startsWith('|')).join('\n');
}

const guide = read(GUIDE);
const manifest = JSON.parse(read('livrable.json'));
// Texte d'une section « ## N. » du guide, jusqu'à la suivante.
function section(n) {
  const start = guide.indexOf(`\n## ${n}. `);
  assert.ok(start >= 0, `${GUIDE} : section ${n} introuvable`);
  const end = guide.indexOf(`\n## ${n + 1}. `, start + 1);
  return guide.slice(start, end < 0 ? undefined : end);
}

test('J1 plan du guide serveur', () => {
  const lines = split(guide).rest;
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
  // Contrat encore lu par le code : une variable renommée dans server.js (ou
  // solver/bridge.js) sort du contrat des documents qui la citent.
  const code = read('server.js') + read('solver/bridge.js');
  const lue = CONTRAT.filter(name => new RegExp(`\\b${name}\\b`).test(code));
  for (const file of DOCS) {
    for (const [name] of read(file).matchAll(/\bKARAOKE_[A-Z0-9_]*[A-Z0-9]\b/g)) {
      assert.ok(lue.includes(name), `${file} : variable hors contrat ${name}`);
    }
  }
  // Chaque réglage a sa propre ligne : son nom en première cellule.
  const tableRows = guide.split('\n').filter(line => line.trim().startsWith('|'));
  for (const [, key] of read('deploy/.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) {
    const own = new RegExp(`^\\|\\s*\`${key}\`\\s*\\|`);
    assert.ok(tableRows.some(row => own.test(row.trim())), `${GUIDE} : réglage ${key} de deploy/.env.example non décrit`);
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
  // Les commandes du guide se tapent dans ~/karafun-plus/deploy : ./<script> y
  // est. Les « ./ » des commandes node du §18 sont des modules de l'application.
  for (const [, name] of horsNode18(split(guide).code).join('\n').matchAll(/(?<![\w./])\.\/([\w.-]+)/g)) {
    assert.ok(exists(`deploy/${name}`), `${GUIDE} : chemin absent deploy/${name}`);
  }
});

test('J4 commandes dangereuses', () => {
  const forbidden = [/--entrypoint/, /KARAFUN_PLUS_VERSION\s*=\s*latest/, /PasswordAuthentication\s+yes/i,
    /ufw\s+allow\b.*\b300[01]\b/, /--plaintext/];
  // Deux exceptions à docker compose run : la clé neuve (RUN_EXCEPTION) et les
  // commandes de la réparation des soirées du §18 (RUN_18), elles seules.
  guide.split('\n').forEach((line, index) => {
    const message = `${GUIDE} : commande dangereuse ligne ${index + 1} : ${line.trim()}`;
    if (/down -v|docker compose run/.test(line) && line.trim() !== RUN_EXCEPTION && !RUN_18.includes(line.trim())) {
      assert.match(line, /\bJamais\b/, message);
    }
    for (const pattern of forbidden) assert.doesNotMatch(line, pattern, message);
  });
});

test('J5 aucune donnée privée', () => {
  const allowedHost = host => HOTES.some(name => host === name || host.endsWith(`.${name}`));
  const declared = read('server.js').match(/DEFAULT_TRUSTED_PROXIES\s*=\s*['"`]([^'"`]+)['"`]/);
  assert.ok(declared, 'server.js : déclaration DEFAULT_TRUSTED_PROXIES introuvable (J5 du guide)');
  const bases = declared[1].split(',').map(entry => entry.trim().split('/')[0].toLowerCase());
  const allowedIp = ip => IPV4.includes(ip) || bases.includes(ip.toLowerCase());
  const fail = excerpt => `${GUIDE} : donnée privée possible : ${excerpt}`;
  // Sans les commandes node du §18, déclarées plus haut (NODE_18) : leurs
  // « process.argv » et « x.checked » sont du JavaScript.
  const text = horsNode18(guide.split('\n')).join('\n');
  const hosts = [];
  for (const [, host] of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/:?#`'"<>)\]]+)/gi)) hosts.push(host);
  for (const pattern of [new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLD.join('|')})\\b`, 'gi'), MOT_POINTE]) {
    for (const [host] of text.matchAll(pattern)) {
      if (!EXTENSIONS.has(host.split('.').pop().toLowerCase())) hosts.push(host);
    }
  }
  for (const host of hosts) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue;
    assert.ok(allowedHost(host.toLowerCase()), fail(host));
  }
  for (const [ip] of text.matchAll(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?!\d|\.\d)/g)) assert.ok(allowedIp(ip), fail(ip));
  // IPv6 : groupes hexadécimaux séparés par « : », hors port (127.0.0.1:3000:3000).
  for (const [ip] of text.matchAll(/(?<![\w:.])[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:.])/gi)) assert.ok(allowedIp(ip), fail(ip));
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
      // Commande citée : chacun de ses mots en forme de chemin du dépôt existe.
      if (/\s/.test(span)) {
        for (const word of span.split(/\s+/)) {
          if (CHEMIN_DEPOT.test(word) && !chemin_exempte(word)) assert.ok(exists(word.replace(/:\d+(-\d+)?$/, '')), message(word));
        }
        continue;
      }
      if (!span.includes('/') || /[<>*…${}|]/.test(span) || /^(\/|~|\.\.?\/|[a-z][a-z0-9+.-]*:)/i.test(span)) continue;
      const target = span.replace(/#.*$/, '').replace(/:\d+(-\d+)?$/, '');
      const first = target.split('/')[0];
      if (HORS_DEPOT.has(first) || chemin_exempte(target) || NON_CHEMIN.some(pattern => pattern.test(target))) continue;
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
  for (const file of DOCS) {
    const text = read(file);
    if (file !== GUIDE) expect(file, text, GUIDE);
    for (const name of ['Tests Windows', 'Release Windows']) {
      assert.ok(!flat(text).includes(name), `${file} : ancien nom de workflow : ${name}`);
    }
  }
  const bar = read('GUIDE-BAR.md');
  const heading = '### Sur un serveur Linux (VPS)';
  assert.equal(bar.split('\n').filter(line => line === heading).length, 1, `GUIDE-BAR.md : variante serveur absente : ${heading}`);
  for (const needed of [
    'Avec le kit Windows, la clé privée',
    'Sur un serveur Linux, la file reste allumée : rien à arrêter en fin de soirée. Pour l\'arrêter quand même, `docker compose stop app` ; la clé ne change pas (DEPLOIEMENT-SERVEUR.md, sections 13 et 18).',
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
  const final = '## Déploiement serveur Linux (octobre 2026)';
  assert.equal(contexte.split('\n').filter(line => /^## /.test(line)).at(-1), final,
    `CONTEXTE-REPRISE.md : variante serveur absente : ${final}`);
  for (const needed of [
    'Avec le kit Windows, pour la 4G/5G, il faut un **domaine HTTPS stable et un tunnel nommé** vers `http://127.0.0.1:3001` uniquement.',
    'sur un serveur Linux, depuis Internet, la page du bar ne passe que par Caddy, en HTTPS et derrière le mot de passe du bar ; l\'administrateur garde le tunnel SSH vers `127.0.0.1:3000` (`DEPLOIEMENT-SERVEUR.md`).',
  ]) expect('CONTEXTE-REPRISE.md', contexte, needed);
});

test('J9 commandes clés du guide', () => {
  const code = split(guide).code;
  const lines = new Set(code.map(line => line.trim()));
  for (const command of COMMANDES) assert.ok(lines.has(command), `${GUIDE} : commande attendue absente : ${command}`);
  // « Couper la réparation » : dans les blocs du §18 (plan du 8 novembre, A6).
  const lines18 = new Set(split(section(18)).code.map(line => line.trim()));
  for (const command of COUPURE) assert.ok(lines18.has(command), `${GUIDE} §18 : commande de « Couper la réparation » absente : ${command}`);
  // J9-11 garde son espace en tête : le code KaraFun reste hors de l'historique de bash.
  const diagnostic = ` ${DIAGNOSTIC}`;
  assert.ok(code.includes(diagnostic), `${GUIDE} : commande attendue absente : ${diagnostic}`);
  // Formes uniques : toute commande ponctuelle d'un bloc du guide, d'une
  // ligne de LISEZMOI.txt ou citée dans un document a la forme attendue.
  const ponctuelle = /--print-staff-url|--rotate-staff-key|diag-karafun\.js/;
  const formes = new Set([DIAGNOSTIC, LIEN, ROTATION, RUN_EXCEPTION]);
  const lignes = [...code.map(line => [GUIDE, line]), ...read('LISEZMOI.txt').split('\n').map(line => ['LISEZMOI.txt', line])];
  for (const file of DOCS) {
    for (const [, span] of read(file).matchAll(/`([^`\n]+)`/g)) if (/^docker /.test(span)) lignes.push([file, span]);
  }
  for (const [file, line] of lignes) {
    if (ponctuelle.test(line)) {
      assert.ok(formes.has(line.trim()), `${file} : forme de commande non unique : ${line.trim()} (formes permises : ${[...formes].join(' | ')})`);
    }
  }
});

test('J10 phrases du guide', () => {
  for (const sentence of prose(guide).split(/(?<=[.!?;:])\s+/)) {
    const words = sentence.split(/\s+/).filter(Boolean);
    assert.ok(words.length <= 40, `${GUIDE} : phrase de ${words.length} mots : ${words.slice(0, 8).join(' ')}`);
  }
});

test('J14 la règle des tags v* laisse la publication manuelle créer son tag', () => {
  // « Run workflow » crée le tag avec le jeton du workflow (github-actions[bot]),
  // qui ne peut pas contourner une règle : restreindre la création bloquerait
  // toute release manuelle. Un tag publié ne doit plus bouger ni disparaître.
  const rule = flat(read('SECURITY.md')).match(/6\. \*\*Rulesets → tags `v\*`\*\*.*?(?= \d\. \*\*|$)/);
  assert.ok(rule, 'SECURITY.md : réglage des tags v*');
  assert.match(rule[0], /« Restrict updates »/);
  assert.match(rule[0], /« Restrict deletions »/);
  assert.doesNotMatch(rule[0], /création[^.]*réservée|« Restrict creations » activ/);
  assert.match(read('.github/workflows/release.yml'), /git push origin "refs\/tags\/\$env:INPUT_VERSION"/, 'tag créé par le workflow');
});

test('J13 le guide donne l’âge au-delà duquel la page ignore la liste des versions', () => {
  const declared = read('server-update.js').match(/CATALOGUE_MAX_AGE_MS = (\d+) \* 3600 \* 1000;/);
  assert.ok(declared, 'server-update.js : CATALOGUE_MAX_AGE_MS en heures');
  assert.match(flat(read(GUIDE)), new RegExp(`Sans lecture réussie depuis ${declared[1]} heures, la liste disparaît de la page`));
});

test('J12 le guide ne prête pas aux anciens scripts le refus d’un agent plus ancien', () => {
  // Ce refus n'existe que dans les scripts publiés après la v3.2.0 : après un
  // retour à une version précédente, le dépôt contient l'ancien script.
  assert.match(flat(read(GUIDE)), /celui de la v3\.2\.0 ou d'avant ne le vérifie pas/);
  // Remède : les fichiers de la dernière release extraits à part, le dépôt
  // restant sur la version en service (sa révision sert au retour arrière).
  for (const file of ['install-update-agent.sh', 'update-agent.py']) {
    assert.match(read(GUIDE), new RegExp(`git show vX\\.Y\\.Z:deploy/${file.replace('.', '\\.')} > "\\$dossier/${file.replace('.', '\\.')}"`), file);
  }
  assert.doesNotMatch(flat(read(GUIDE)), /`git checkout` de son tag\) avant de relancer l'installation/);
  const installer = read('deploy/install-update-agent.sh');
  assert.match(installer, /source_file=\$\(realpath -- "\$\(dirname "\$0"\)\/update-agent\.py"\)/, 'agent pris à côté du script');
  assert.match(installer, /réinstallation refusée\. Lancer le script de la dernière release, extrait avec git show dans un dossier temporaire/);
});

test('J11 le guide cite la limite des retours en soirée de night-state.js', () => {
  const { FULL_RESTORE_SINCE } = require('../night-state');
  assert.ok(flat(read(GUIDE)).includes(`versions antérieures à la ${FULL_RESTORE_SINCE}`),
    `${GUIDE} §17 : citer FULL_RESTORE_SINCE (${FULL_RESTORE_SINCE}), la version sous laquelle un retour est refusé pendant une soirée`);
});

test('J15 une ligne de code citée dans un document montre toujours ce qu’il en dit', () => {
  // `fichier.js:ligne` dans un document : le code attendu à cette ligne, déclaré ici.
  const CITATIONS = { 'kcs-transport.js': /new WebSocket\(/ };
  for (const file of DOCS) {
    for (const [, cite, numero] of read(file).matchAll(/`([\w./-]+\.js):(\d+)`/g)) {
      assert.ok(CITATIONS[cite], `${file} : ${cite}:${numero} cité sans code attendu (le déclarer dans J15)`);
      assert.match(read(cite).split('\n')[Number(numero) - 1] || '', CITATIONS[cite], `${file} : ${cite}:${numero} ne montre plus ${CITATIONS[cite]}`);
    }
  }
});

test('J16 ce qu’aucun essai automatique n’ouvre, c’est le WebSocket de Node vers le vrai KaraFun', () => {
  // Un essai peut ouvrir le WebSocket de Node vers un faux KaraFun local (issue #59) : un document
  // qui dit qu'aucun essai ne l'ouvre précise « vers le vrai KaraFun ».
  for (const file of DOCS) {
    for (const [phrase] of flat(read(file)).matchAll(/aucun (?:test|essai) automatique n['’]ouvre[^.;]*/g)) {
      assert.match(phrase, /vers le vrai KaraFun/, `${file} : « ${phrase} » : un essai peut ouvrir ce WebSocket vers un faux KaraFun local`);
    }
  }
});

test('J17 la sonde de la télécommande ne promet pas un journal que le conteneur de l’essai efface', () => {
  // test/comparer-images.js fait lancer la sonde dans l'image par docker run --rm : rien n'étant
  // monté sur /app/journal (volume anonyme du Dockerfile, retiré avec le conteneur),
  // journal/kcs-probe.json part avec le conteneur, et l'en-tête de la sonde le dit.
  const essai = read('test/comparer-images.js').match(/const essaiKaraFun = [^;]+;/);
  assert.ok(essai, 'test/comparer-images.js : commande de l’essai de la télécommande (essaiKaraFun)');
  assert.match(essai[0], /docker run --rm /);
  const entete = flat(read('test/probe-kcs.js').split('\n').filter(ligne => ligne.startsWith('//')).map(ligne => ligne.slice(2)).join(' '));
  if (!/:\/app\/journal\b/.test(essai[0])) {
    assert.match(entete, /dans le conteneur de l'essai de \.github\/RELEASE\.md .*les messages ne restent qu'à l'écran/,
      'test/probe-kcs.js : dire que, dans le conteneur de l’essai, journal/kcs-probe.json part avec lui');
  }
});

test('J18 CONTEXTE-REPRISE.md cite les appels de l’automate Spotify tels que le code les fait', () => {
  // Relecture contradictoire du tour 5 (tour 2) : le document disait encore
  // `handled('battle')`, sans la scène vue, et ne parlait ni de « blind » ni
  // de la période propre à chaque scène. Un mainteneur qui le suivait
  // rouvrait l'attente de la Battle, relancée malgré le choix (mutation M16,
  // vue par test/battle-spotify.test.js).
  const code = read('server.js') + read('spotify.js');
  const doc = read('CONTEXTE-REPRISE.md');
  const cited = [...doc.matchAll(/`([^`\n]*\bhandled\([^`\n]*\))`/g)].map(match => match[1]);
  assert.ok(cited.length, 'CONTEXTE-REPRISE.md : appels de SpotifyAutomation#handled');
  for (const call of cited) assert.ok(code.includes(call), `CONTEXTE-REPRISE.md : appel absent du code : ${call}`);
  assert.ok(cited.includes("handled('battle', spotifyStage())"), 'CONTEXTE-REPRISE.md : attente de la Battle close avec la scène vue');
  assert.ok(cited.includes('handled(karaoke = this.phase, stage = undefined)'), 'CONTEXTE-REPRISE.md : période propre à une scène');
  assert.match(flat(doc), /`karaokeOutlook\(\)` rend « blind »/, 'CONTEXTE-REPRISE.md : alerte « Message de KaraFun illisible »');
});

// ---------------------------------------------------------------- réparation des soirées (A6)
// Plan du 8 novembre, A6, « Tests de cette documentation » : textes et
// commandes de la réparation des soirées du premier commit du jalon 1.

// Lignes d'état de la réparation (A4, « Coupure »), lues dans server.js :
// repairSwitch elle-même, rendue par un bac à sable vm, jamais recopiée ici.
function lignesEtat() {
  const source = read('server.js');
  const start = source.indexOf('\nfunction repairSwitch(');
  assert.ok(start >= 0, 'server.js : function repairSwitch introuvable');
  const end = source.indexOf('\n}\n', start);
  const line = env => vm.runInNewContext(`${source.slice(start, end + 2)}\nrepairSwitch(env).line`, { env });
  return { active: line({}), coupee: line({ KARAOKE_REPAIR: 'off' }) };
}

test('A6 : GUIDE-BAR, couper la réparation sur le PC : set KARAOKE_REPAIR=off, $env:KARAOKE_REPAIR = \'off\' et la ligne « coupée » mot pour mot, lue dans server.js ; le §18 montre les lignes « coupée » et « active »', () => {
  const etat = lignesEtat();
  assert.match(etat.coupee, /^Réparation des soirées : coupée \(KARAOKE_REPAIR=off\)\./);
  const bar = flat(read('GUIDE-BAR.md'));
  for (const needed of ['`set KARAOKE_REPAIR=off`', "`$env:KARAOKE_REPAIR = 'off'`", '`.\\DEMARRER.bat`', etat.coupee, etat.active]) {
    assert.ok(bar.includes(flat(needed)), `GUIDE-BAR.md : « Couper la réparation sur le PC » sans ${needed}`);
  }
  const s18 = flat(section(18));
  for (const needed of [etat.coupee, etat.active]) assert.ok(s18.includes(flat(needed)), `${GUIDE} §18 : ligne d'état absente : ${needed}`);
  // Textes que GUIDE-BAR cite de la réparation au démarrage, tels que le code
  // les écrit : note au bar d'une soirée en cours en échec (server.js), notes
  // d'une soirée close, refus d'un second lancement (start-evening.js).
  const server = read('server.js');
  const note = /\nconst REPAIR_FAILED_NOTE = ([^;]+);/.exec(server);
  assert.ok(note, 'server.js : REPAIR_FAILED_NOTE introuvable');
  const lanceur = read('start-evening.js');
  for (const [needed, source, from] of [[vm.runInNewContext(note[1]), server, null],
    [' : réparation impossible pour l’instant, réessayée au prochain démarrage.', server, 'server.js'],
    [' : réparation impossible, à vérifier : préviens le mainteneur.', server, 'server.js'],
    ['La file karaoké démarre déjà : la page du bar s’ouvrira dans un instant.', lanceur, 'start-evening.js'],
    ['La file karaoké tourne déjà : ouverture de la page du bar.', lanceur, 'start-evening.js']]) {
    if (from) assert.ok(source.includes(needed), `${from} n'écrit plus : ${needed}`);
    assert.ok(bar.includes(flat(needed)), `GUIDE-BAR.md : texte de la réparation au démarrage absent : ${needed}`);
  }
});

// Lignes d'échec d'une soirée (A4, « Lignes d'échec »), lues dans
// evening-journal.js : failureOf et failureLine elles-mêmes, avec les
// constantes qu'elles lisent, rendues par un bac à sable vm comme
// repairSwitch. Comme dans repair, une erreur de fichier est à refaire
// (retry) avant son dernier essai ; les autres sont notées failed aussitôt.
function lignesEchec() {
  const source = read('evening-journal.js');
  const declaration = head => {
    const start = source.indexOf(`\n${head}`);
    assert.ok(start >= 0, `evening-journal.js : ${head.trim()} introuvable`);
    const fin = head.startsWith('function ') ? '\n}\n' : ';\n';
    return source.slice(start, source.indexOf(fin, start) + fin.length);
  };
  const heads = ['const MAX_ATTEMPTS = ', 'const DATA_CODES = ', 'const CODE_PATTERN = ', 'const REFAIRE = ', 'const ENVOYER = ',
    'const plural = ', 'const renamesText = ', 'function failureOf(', 'function failureLine('];
  const { MAX_ATTEMPTS, failureOf, failureLine } = vm.runInNewContext(`${heads.map(declaration).join('')}\n({ MAX_ATTEMPTS, failureOf, failureLine })`);
  const id = '2026-11-06_2040_ab12';
  const lignes = [];
  for (const [code, step, renames] of [['ENOSPC', 'copie', 0], ['EROFS', 'copie', 0], ['EBUSY', 'journal', 3]]) {
    for (let essai = 1; essai <= MAX_ATTEMPTS; essai++) {
      const status = essai < MAX_ATTEMPTS ? 'retry' : 'failed';
      lignes.push({ status, ligne: failureLine(id, failureOf({ code }, step), essai, status, { name: 'Error' }, renames) });
    }
  }
  for (const [error, step] of [[{ code: 'BAD_JSON', repairFile: 'meta.json' }, 'lecture'], [new TypeError('x'), 'morceau 2']]) {
    lignes.push({ status: 'failed', ligne: failureLine(id, failureOf(error, step), 1, 'failed', { name: 'TypeError' }) });
  }
  return lignes;
}

test('A6 : §18, « Réparation des soirées » : ce que le guide dit des lignes d’échec vaut pour chaque forme de failureLine (evening-journal.js) : « essai 1 sur 3 » et « essai 2 sur 3 » finissent par « reprise au prochain démarrage », sans procédure ; une ligne « notée failed » finit par le titre d’une procédure du §18, et le guide ne prête de procédure qu’à elle', () => {
  const s18 = section(18);
  const start = s18.indexOf('\n### Réparation des soirées\n');
  assert.ok(start >= 0, `${GUIDE} §18 : « Réparation des soirées » introuvable`);
  const texte = flat(prose(s18.slice(start, s18.indexOf('\n### ', start + 1))));
  const where = `${GUIDE} §18, « Réparation des soirées »`;
  const titres = new Set(split(s18).rest.filter(line => line.startsWith('### ')).map(line => line.slice(4).trim()));
  const lignes = lignesEchec();
  assert.ok(lignes.some(({ status }) => status === 'retry') && lignes.some(({ status }) => status === 'failed'), 'formes retry et failed');
  for (const { status, ligne } of lignes) {
    if (status === 'retry') {
      // Rien à faire : la ligne ne renvoie à aucune procédure, et le guide
      // cite son essai et sa fin, tels que failureLine les écrit.
      assert.doesNotMatch(ligne, /§18/, `ligne à refaire sans procédure : ${ligne}`);
      const essai = /\bessai \d+ sur \d+/.exec(ligne);
      const fin = /\) : ([^():]+)\.$/.exec(ligne);
      assert.ok(essai && fin, `ligne à refaire : essai ou fin introuvable : ${ligne}`);
      for (const cite of [essai[0], fin[1]]) assert.ok(texte.includes(`« ${cite} »`), `${where} : « ${cite} » absent (${ligne})`);
    } else {
      assert.ok(ligne.includes('notée failed'), `ligne failed sans « notée failed » : ${ligne}`);
      const titre = /\(DEPLOIEMENT-SERVEUR §18, « ([^»]+) »\)\.$/.exec(ligne);
      assert.ok(titre && titres.has(titre[1]), `ligne failed : le titre d'une procédure du §18 en dernier : ${ligne}`);
    }
  }
  // La procédure à suivre n'est prêtée qu'aux lignes « notée failed » : une
  // ligne à refaire n'en nomme aucune.
  assert.ok(texte.includes('« notée failed »'), `${where} : « notée failed » absent`);
  for (const phrase of texte.split(/(?<=[.!?])\s+/)) {
    if (phrase.includes('procédure')) assert.ok(phrase.includes('« notée failed »'), `${where} : procédure prêtée à toute ligne d'échec : ${phrase}`);
  }
});

// Texte d'une sous-section « ### titre » de la section n du guide, jusqu'à la suivante.
function sousSection(n, titre) {
  const texte = section(n);
  const start = texte.indexOf(`\n### ${titre}\n`);
  assert.ok(start >= 0, `${GUIDE} §${n} : « ${titre} » introuvable`);
  const end = texte.indexOf('\n### ', start + 1);
  return texte.slice(start, end < 0 ? undefined : end);
}
// Blocs de code d'un texte du guide, dans l'ordre : { langue, lignes }, lignes rognées.
function blocs(texte) {
  const out = [];
  let bloc = null;
  for (const line of texte.split('\n')) {
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      if (bloc) { out.push(bloc); bloc = null; } else bloc = { langue: fence[1], lignes: [] };
    } else if (bloc) bloc.lignes.push(line.trim());
  }
  return out;
}
// Étapes numérotées d'un texte du guide : { numero, avant, prose, blocs },
// `avant` la prose qui précède le premier bloc, `prose` toute celle de
// l'étape, aplaties ; une ligne non indentée hors liste la termine.
function etapes(texte) {
  const out = [];
  let etape = null;
  let bloc = null;
  for (const line of texte.split('\n')) {
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (bloc) {
      if (fence) { etape.blocs.push(bloc); bloc = null; } else bloc.lignes.push(line.trim());
      continue;
    }
    const debut = /^(\d+)\. (.*)$/.exec(line);
    if (debut) { etape = { numero: Number(debut[1]), prose: [debut[2]], blocs: [] }; out.push(etape); continue; }
    if (!etape) continue;
    if (fence) { bloc = { langue: fence[1], lignes: [] }; etape.prose.push(''); continue; }
    if (line.trim() && !/^\s/.test(line)) { etape = null; continue; }
    etape.prose[etape.prose.length - 1] += ` ${line.trim()}`;
  }
  return out.map(({ numero, prose, blocs: liste }) => ({ numero, avant: flat(prose[0]).trim(), prose: flat(prose.join(' ')).trim(), blocs: liste }));
}

test('A6 : §18, « Couper la réparation », étape 4 : la ligne KARAOKE_REPAIR reste dans .env pendant l’installation de la version corrigée par « Installer cette version », qui admet un réglage en trop, et ne se retire, suivie de docker compose up -d app, qu’une fois app en (healthy) sur elle : tout retour automatique de l’agent remet le .env d’avant (env.before)', () => {
  // Ce que l'étape 4 tient de l'agent de mise à jour : begin() garde le .env
  // du moment, restore() le remet à tout retour automatique (contrôles en
  // échec, reprise après une coupure), et prepare() admet un réglage en trop
  // pour une version choisie, jamais pour la dernière. Le .env d'avant sans
  // la ligne relancerait la version en cause avec sa réparation.
  const agent = read('deploy/update-agent.py');
  for (const [motif, quoi] of [
    [/\n\s+before = self\.private \/ "env\.before"\n\s+atomic_bytes\(before, \(self\.deploy \/ "\.env"\)\.read_bytes\(\)\)\n/, 'begin() garde le .env du moment dans env.before'],
    [/\n\s+atomic_bytes\(self\.deploy \/ "\.env", \(self\.private \/ "env\.before"\)\.read_bytes\(\)\)\n/, 'restore() remet env.before'],
    [/\n\s+if not wanted <= present or \(wanted != present and not chosen\):\n\s+raise UpdateError\("Cette version nécessite un réglage du serveur avant son installation\."\)\n/,
      'prepare() : un réglage en trop admis pour une version choisie, jamais pour la dernière'],
  ]) assert.match(agent, motif, `deploy/update-agent.py : ${quoi}`);
  const liste = etapes(sousSection(18, 'Couper la réparation'));
  assert.deepEqual(liste.map(({ numero }) => numero), [1, 2, 3, 4, 5], `${GUIDE} §18, « Couper la réparation » : cinq étapes (plan, A6)`);
  const [, , trois, quatre] = liste;
  for (const needed of ['« Vérifier et mettre à jour » est refusé', '« Installer cette version » reste possible : une version choisie admet un réglage en trop.']) {
    assert.ok(trois.prose.includes(needed), `${GUIDE} §18, « Couper la réparation », étape 3 : ${needed}`);
  }
  const ou = `${GUIDE} §18, « Couper la réparation », étape 4`;
  assert.deepEqual(quatre.blocs.map(({ lignes }) => lignes), [["sed -i '/^KARAOKE_REPAIR=/d' .env", 'docker compose up -d app']],
    `${ou} : la ligne retirée, puis app recréée, une fois la version corrigée en service`);
  const installer = quatre.avant.indexOf('« Installer cette version »');
  const enService = quatre.avant.indexOf('`(healthy)`');
  assert.ok(installer >= 0 && enService > installer, `${ou} : « Installer cette version », puis app en (healthy), avant le retrait de la ligne : ${quatre.avant}`);
  // Rien ne fait retirer la ligne avant l'installation, par la nouvelle voie non plus.
  assert.doesNotMatch(quatre.avant.slice(0, installer), /\bretir|\bsed\b/, `${ou} : la ligne retirée avant « Installer cette version » : ${quatre.avant}`);
  assert.doesNotMatch(quatre.prose, /touche « Vérifier et mettre à jour »/, `${ou} : « Vérifier et mettre à jour » après le retrait de la ligne`);
  // Ni le guide ni TODOS.md ne font retirer la ligne avant la mise à jour.
  for (const file of [...DOCS, 'TODOS.md']) {
    const found = flat(read(file)).match(/retir\w*(?:[^.;]|\.(?=\w)){0,80} la ligne(?:[^.;]|\.(?=\w)){0,80}, puis (?:touche )?« (?:Vérifier et mettre à jour|Installer cette version) »/);
    assert.equal(found, null, `${file} : la ligne KARAOKE_REPAIR retirée avant une mise à jour : ${found}`);
  }
});

test('A6 : §17, « Procédure manuelle de maintenance » : la ligne KARAOKE_REPAIR de « Couper la réparation » reste dans .env jusqu’au contrôle de la version installée, puis se retire par l’étape 4 du §18, jamais avant docker compose up -d', () => {
  const texte = sousSection(17, 'Procédure manuelle de maintenance');
  const controle = texte.indexOf('**Contrôle**');
  assert.ok(controle >= 0, `${GUIDE} §17, « Procédure manuelle de maintenance » : **Contrôle** introuvable`);
  const phrases = part => flat(prose(part)).split(/(?<=[.!?])\s+/).filter(phrase => phrase.includes('`KARAOKE_REPAIR`'));
  const avant = phrases(texte.slice(0, controle));
  assert.ok(avant.length, `${GUIDE} §17 : la ligne KARAOKE_REPAIR citée avec le diff des clés`);
  for (const phrase of avant) {
    assert.doesNotMatch(phrase, /\bretire/, `${GUIDE} §17 : la ligne KARAOKE_REPAIR retirée avant le démarrage de la version : ${phrase}`);
    assert.match(phrase, /\bgarde-la\b/, `${GUIDE} §17 : la ligne KARAOKE_REPAIR gardée jusqu'au contrôle : ${phrase}`);
  }
  assert.ok(phrases(texte.slice(controle)).some(phrase => phrase.includes('l\'étape 4 de « Couper la réparation »')),
    `${GUIDE} §17 : après le contrôle, la ligne KARAOKE_REPAIR retirée par l'étape 4 de « Couper la réparation »`);
});

test('A6 : §18, commandes de la réparation : chaque node -e ou node -p sur une ligne, identifiant vérifié d’abord, sans « ! », « $ », accent grave ni guillemet double, la même dans bash (docker compose run ou exec) et dans PowerShell (node\\node.exe) ; aucune autre commande node', () => {
  const code = split(section(18)).code.map(line => line.trim());
  const lines = new Set(code);
  for (const line of [...RUN_18, ...ENVOI, ...ENVOI_PC, ...Object.values(NODE_18).map(pcNode), RETRAIT_PC, 'id=<id>', "$id = '<id>'",
    'morceau=<morceau>', "$morceau = '<morceau>'"]) {
    assert.ok(lines.has(line), `${GUIDE} §18 : commande attendue absente : ${line}`);
  }
  for (const line of code.filter(text => /\bnode(?:\\node\.exe)? -[ep] /.test(text))) {
    assert.ok(LIGNES_NODE_18.has(line), `${GUIDE} §18 : commande node non déclarée dans NODE_18 (documentation.test.js) : ${line}`);
  }
  for (const [name, [, js]] of Object.entries(NODE_18)) {
    assert.ok(js.startsWith(VERIFIE_ID), `${name} : vérifie d'abord l'identifiant`);
    assert.doesNotMatch(js, /[!$`"\n]/, `${name} : ni « ! », « $ », accent grave, guillemet double ni retour à la ligne`);
  }
});

// Gardes de tar et du retrait d'un morceau (MOTIF_BASH, MOTIF_PS) : un
// identifiant valable, puis ce que validEveningId refuse et qui en diffère
// d'un rien (casse, longueur, chemin, chiffres d'autres écritures, saut de
// ligne final, espace en tête).
const ID_ESSAI = '2026-11-06_2040_ab12';
const ESSAIS_ID = [ID_ESSAI, '', '..', '../x', `${ID_ESSAI}/..`, '2026-11-06_2040_AB12', `${ID_ESSAI}\n`, ` ${ID_ESSAI}`, `${ID_ESSAI}0`,
  '٢٠٢٦-11-06_2040_ab12', '２０２６-11-06_2040_ab12', '2026-11-06_2040_àb12', '2026-11-06_2040_ab1g'];
// Valeurs tapées à la place de <id> ou de <morceau>, toutes refusées ; null :
// le bloc collé tel quel, où id=<id> (morceau=<morceau>) est une erreur de
// syntaxe de bash, qui ne pose aucune valeur.
const REFUSES = [null, '', '..', '../x', '2026-11-06_2040_AB12'];
const remplir = (lignes, repere, valeur) => valeur === null ? lignes : lignes.map(line => line.replaceAll(repere, valeur));
const refusAttendu = valeur => `Identifiant de soirée invalide : ${valeur ?? ''} (forme 2026-11-06_2040_ab12). Rien ne change.`;
function dossierVide(t) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-garde-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  return dossier;
}
// Bloc bash du guide lancé comme collé dans un terminal : chaque ligne relue
// à part (eval), une erreur de syntaxe n'arrêtant pas les suivantes, sous
// umask 022, dans `dossier`, qui sert aussi de HOME. Un faux docker y note
// chaque appel, précédé du umask du moment, et écrit « docker-factice ».
function collerBash(lignes, dossier) {
  const trace = path.join(dossier, '.appels-docker');
  const script = 'umask 022\ndocker() { printf \'%s %s\\n\' "$(umask)" "$*" >> "$TRACE"; printf docker-factice; }\nfor ligne in "$@"; do eval "$ligne"; done';
  const r = spawnSync('bash', ['-c', script, 'bash', ...lignes], { cwd: dossier, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dossier, TRACE: trace } });
  const appels = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean) : [];
  fs.rmSync(trace, { force: true });
  return { err: r.stderr, appels };
}
// Réponse de la garde bash d'une ligne du guide pour chaque valeur : même
// réponse que validEveningId.
function gardeBashSuitValidEveningId(ligne, ou) {
  const { validEveningId } = require('../evening-journal');
  const garde = /^if \[\[ \$\w+ =~ (\S+) \]\]; then /.exec(ligne);
  assert.ok(garde, `${ou} : garde de l'identifiant absente en tête de ligne : ${ligne}`);
  const r = spawnSync('bash', ['-c', `for v in "$@"; do if [[ $v =~ ${garde[1]} ]]; then echo 1; else echo 0; fi; done`, 'bash', ...ESSAIS_ID],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.split('\n').filter(Boolean), ESSAIS_ID.map(v => (validEveningId(v) ? '1' : '0')), `${ou} : la garde suit validEveningId`);
}

test('A6 : §18, « Envoyer une soirée au développeur », bash : le bloc collé avec un identifiant vide, « .. », « ../x », en majuscules ou tel quel (id=<id>) ne lance jamais tar ni n’écrit d’archive, et dit « Identifiant de soirée invalide : … Rien ne change. » ; un identifiant valable lance tar une fois, sous umask 077 : archive lisible par son seul propriétaire ; la garde suit validEveningId',
  { skip: process.platform === 'win32' && 'bash (Linux) ; sous Windows, test/verify-portable-kit.ps1 essaie la garde PowerShell' }, t => {
    const ou = `${GUIDE} §18, « Envoyer une soirée au développeur »`;
    const bloc = blocs(sousSection(18, 'Envoyer une soirée au développeur')).find(({ langue }) => langue === 'bash');
    assert.ok(bloc, `${ou} : bloc bash introuvable`);
    for (const valeur of [...REFUSES, ID_ESSAI]) {
      const dossier = dossierVide(t);
      const { err, appels } = collerBash(remplir(bloc.lignes, '<id>', valeur), dossier);
      const tar = appels.filter(appel => / tar /.test(appel));
      const archives = fs.readdirSync(dossier).filter(name => name.startsWith('soiree-'));
      const cas = valeur === null ? 'bloc collé tel quel' : `id=${valeur}`;
      if (valeur !== ID_ESSAI) {
        assert.deepEqual(tar, [], `${ou}, ${cas} : tar lancé`);
        assert.deepEqual(archives, [], `${ou}, ${cas} : archive écrite`);
        assert.ok(err.includes(refusAttendu(valeur)), `${ou}, ${cas} : « ${refusAttendu(valeur)} » attendu\n${err}`);
        continue;
      }
      assert.deepEqual(tar, [`0077 compose exec -T app tar -czf - -C /app data/soirees/${ID_ESSAI} data/soirees-originales/${ID_ESSAI}`],
        `${ou}, ${cas} : tar une fois, sous umask 077`);
      assert.deepEqual(archives, [`soiree-${ID_ESSAI}.tar.gz`], `${ou}, ${cas} : archive`);
      const archive = path.join(dossier, archives[0]);
      assert.equal(fs.readFileSync(archive, 'utf8'), 'docker-factice', `${ou}, ${cas} : l'archive reçoit la sortie de tar`);
      assert.equal(fs.statSync(archive).mode & 0o777, 0o600, `${ou}, ${cas} : archive lisible par son seul propriétaire`);
    }
    gardeBashSuitValidEveningId(bloc.lignes.find(line => / tar /.test(line)), ou);
  });

test('A6 : §18, « Revenir à l’original d’une soirée découpée », étape 4, bash : le retrait collé avec un nom de morceau vide, « .. », « ../x », en majuscules ou tel quel (morceau=<morceau>) ne lance jamais rm, et dit « Identifiant de soirée invalide : … Rien ne change. » ; un nom valable retire ce seul morceau ; la garde suit validEveningId',
  { skip: process.platform === 'win32' && 'bash (Linux) ; sous Windows, test/verify-portable-kit.ps1 essaie la garde PowerShell' }, t => {
    const ou = `${GUIDE} §18, « Revenir à l'original d'une soirée découpée », étape 4`;
    const etape = etapes(sousSection(18, 'Revenir à l\'original d\'une soirée découpée')).find(({ numero }) => numero === 4);
    const bloc = etape?.blocs.find(({ langue }) => langue === 'bash');
    assert.ok(bloc, `${ou} : bloc bash introuvable`);
    for (const valeur of [...REFUSES, ID_ESSAI]) {
      const { err, appels } = collerBash(remplir(bloc.lignes, '<morceau>', valeur), dossierVide(t));
      const rm = appels.filter(appel => / rm /.test(appel));
      const cas = valeur === null ? 'bloc collé tel quel' : `morceau=${valeur}`;
      if (valeur !== ID_ESSAI) {
        assert.deepEqual(rm, [], `${ou}, ${cas} : rm lancé`);
        assert.ok(err.includes(refusAttendu(valeur)), `${ou}, ${cas} : « ${refusAttendu(valeur)} » attendu\n${err}`);
        continue;
      }
      assert.deepEqual(rm, [`0022 compose run --rm --no-deps -T app rm -r data/soirees/${ID_ESSAI}`], `${ou}, ${cas} : ce seul morceau retiré`);
    }
    gardeBashSuitValidEveningId(bloc.lignes.find(line => / rm /.test(line)), ou);
  });

test('A6 : §18, PowerShell : tar.exe d’« Envoyer une soirée au développeur » et Remove-Item d’un morceau ne partent que dans le if de leur garde, sur leur propre ligne : -cmatch, [0-9] et \\z, la forme de validEveningId, sinon throw « Identifiant de soirée invalide : … Rien ne change. »', () => {
  const { validEveningId } = require('../evening-journal');
  const s18 = section(18);
  const lignes = blocs(s18).filter(({ langue }) => langue === 'powershell').flatMap(({ lignes: l }) => l);
  const actions = lignes.filter(line => /\btar\.exe -czf\b|\bRemove-Item -Recurse\b/.test(line));
  assert.deepEqual(actions.filter(line => line !== TAR_PC && line !== RETRAIT_PC), [], `${GUIDE} §18 : tar.exe ou Remove-Item sans la garde de l'identifiant`);
  assert.deepEqual(actions, [RETRAIT_PC, TAR_PC], `${GUIDE} §18 : retrait d'un morceau, puis archive de l'envoi, une fois chacun`);
  const retrait = etapes(sousSection(18, 'Revenir à l\'original d\'une soirée découpée')).find(({ numero }) => numero === 4)
    ?.blocs.find(({ langue }) => langue === 'powershell');
  assert.deepEqual(retrait?.lignes, ["$morceau = '<morceau>'", RETRAIT_PC], `${GUIDE} §18, étape 4 : $morceau posé, puis le retrait gardé`);
  const envoi = blocs(sousSection(18, 'Envoyer une soirée au développeur')).find(({ langue }) => langue === 'powershell');
  assert.equal(envoi?.lignes[0], "$id = '<id>'", `${GUIDE} §18, « Envoyer une soirée au développeur » : $id posé d'abord`);
  // Chaque garde lue comme .NET la lit, traduite en JavaScript : -match et
  // -imatch ignorent la casse (drapeau i), -cmatch la garde ; \d y prend tout
  // chiffre Unicode (\p{Nd}) ; $ admet un saut de ligne final, \z non.
  for (const line of actions) {
    const garde = /^if \(\$\w+ -(c|i)?match '([^']*)'\) \{ /.exec(line);
    assert.ok(garde, `${GUIDE} §18 : garde PowerShell illisible : ${line}`);
    const traduit = garde[2].replace(/\\d/g, '\\p{Nd}').replace(/\$$/, '(?=\\n?$)').replace(/\\z$/, '$');
    const motif = new RegExp(traduit, garde[1] === 'c' ? 'u' : 'iu');
    for (const valeur of ESSAIS_ID) {
      assert.equal(motif.test(valeur), validEveningId(valeur), `${GUIDE} §18 : garde PowerShell et validEveningId différentes pour ${JSON.stringify(valeur)} : ${line}`);
    }
  }
});

// Fichiers d'un dossier, chemin relatif « / » → contenu.
function instantane(dir) {
  const out = {};
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, rel);
    if (fs.statSync(file).isFile()) out[rel.split(path.sep).join('/')] = fs.readFileSync(file, 'utf8');
  }
  return out;
}
// Dossier d'essai hors du dépôt, avec evening-journal.js et les deux modules
// qu'il charge, au dossier de l'application comme dans l'image et le kit.
function dossierEssai(t) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'karaoke-bar-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  for (const file of ['evening-journal.js', 'evening-bounds.js', 'evening-split.js']) fs.copyFileSync(path.join(root, file), path.join(dossier, file));
  return { dossier, ids: dossierReparation.preparerDossier(dossier) };
}

test('A6 : §18, commandes node lancées sans leur préfixe dans un dossier d’essai hors du dépôt : la liste écrit le seul morceau, la recopie remet l’original, l’entrée passe à ok, le retrait d’une entrée failed laisse les autres puis sort en code 1, l’index comparé en entier, règle comprise ; « ../x » et un identifiant vide : code 1, rien ne change', t => {
  // Les commandes telles que le §18 les écrit : chacune de NODE_18, une fois.
  const parsed = new Map();
  for (const line of split(section(18)).code.map(text => text.trim())) {
    const m = /^(?:docker compose (?:run --rm --no-deps -T|exec -T) app node|node\\node\.exe) (-[ep]) "([^"]*)" (?:"\$id"|\$id)$/.exec(line);
    if (m) parsed.set(`${m[1]} ${m[2]}`, [m[1], m[2]]);
  }
  const commande = name => {
    const found = parsed.get(NODE_18[name].join(' '));
    assert.ok(found, `${GUIDE} §18 : commande ${name} absente`);
    return found;
  };
  const { dossier, ids } = dossierEssai(t);
  const lancer = (name, id) => {
    const r = spawnSync(process.execPath, [...commande(name), id], { cwd: dossier, encoding: 'utf8', windowsHide: true });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const ok = out => ({ code: 0, out, err: '' });
  const soiree = rel => path.join(dossier, 'data', 'soirees', ...rel.split('/'));
  const copie = rel => path.join(dossier, 'data', 'soirees-originales', ids.decoupee, '1', rel);
  const index = () => fs.readFileSync(soiree('.bornage.json'), 'utf8');

  const avant = instantane(dossier);
  for (const name of Object.keys(NODE_18)) {
    for (const id of ['../x', '']) {
      assert.deepEqual(lancer(name, id), { code: 1, out: '',
        err: `Identifiant de soirée invalide : ${id} (forme 2026-11-06_2040_ab12). Rien ne change.\n` }, `${name} avec « ${id} »`);
      assert.deepEqual(instantane(dossier), avant, `${name} avec « ${id} » : dossier d'essai inchangé`);
    }
  }
  // Revenir à l'original : contrôle, liste, retrait du morceau, recopie, ok.
  const endedAt = JSON.parse(fs.readFileSync(copie('meta.json'), 'utf8')).endedAt;
  assert.ok(Number.isFinite(endedAt), 'copie close');
  assert.deepEqual(lancer('controle', ids.decoupee), ok(`${endedAt}\n`));
  assert.deepEqual(lancer('controle', ids.sansFin), ok('undefined\n'), 'copie sans endedAt');
  assert.deepEqual(lancer('liste', ids.decoupee), ok(`${ids.morceau}\n`), 'le seul morceau, jamais <id> ni « notes »');
  fs.rmSync(soiree(ids.morceau), { recursive: true });
  assert.deepEqual(lancer('recopie', ids.decoupee), ok(`${ids.decoupee} : original recopié\n`));
  for (const name of ['journal.jsonl', 'meta.json', 'summary.json']) {
    assert.equal(fs.readFileSync(soiree(`${ids.decoupee}/${name}`), 'utf8'), fs.readFileSync(copie(name), 'utf8'), `${name} recopié`);
  }
  // Index comparé en entier : sans sa règle (rule), il se lirait comme vide
  // (BAD_META), et la réparation recouperait la soirée remise à l'original.
  const indexAvant = JSON.parse(index());
  assert.equal(typeof indexAvant.rule, 'string', 'index d’essai avec sa règle');
  assert.equal(indexAvant.checked[ids.decoupee], 'split');
  assert.deepEqual(lancer('ok', ids.decoupee), ok(`${ids.decoupee} : ok dans data/soirees/.bornage.json\n`));
  assert.deepEqual(JSON.parse(index()), { ...indexAvant, checked: { ...indexAvant.checked, [ids.decoupee]: 'ok' } },
    'la règle et les autres entrées intactes');
  // Copie sans summary.json : celui du dernier morceau est retiré.
  fs.rmSync(copie('summary.json'));
  assert.deepEqual(lancer('recopie', ids.decoupee), ok(`${ids.decoupee} : original recopié\n`));
  assert.equal(fs.existsSync(soiree(`${ids.decoupee}/summary.json`)), false, 'copie sans summary.json : celui du dernier morceau retiré');
  // Refaire une réparation en échec : la seule entrée failed, puis code 1.
  const indexEchec = JSON.parse(index());
  const { [ids.enEchec]: echec, ...reste } = indexEchec.checked;
  assert.equal(echec.status, 'failed');
  assert.deepEqual(lancer('retrait', ids.enEchec), ok(`${ids.enEchec} retiré de data/soirees/.bornage.json : refait au prochain démarrage.\n`));
  assert.deepEqual(JSON.parse(index()), { ...indexEchec, checked: reste }, 'la règle et les autres entrées intactes');
  const apres = index();
  assert.deepEqual(lancer('retrait', ids.enEchec), { code: 1, out: '', err: `${ids.enEchec} absent de data/soirees/.bornage.json : rien ne change.\n` });
  assert.equal(index(), apres, 'index inchangé');
});

test('A6 : §18, « Envoyer une soirée au développeur » : la partie grep, lancée sur un journal d’essai, garde les lignes « Réparation » et « Fin de soirée : », écarte la ligne « Clé du bar » et une ligne où « Réparation » vient plus loin',
  { skip: process.platform === 'win32' && 'grep et sh (Linux) ; sous Windows, test/verify-portable-kit.ps1 lance le Select-String du §18' }, t => {
    const line = split(section(18)).code.map(text => text.trim()).find(text => text.startsWith(`${EXEC_APP} sh -c 'grep `));
    assert.equal(line, ENVOI[0], `${GUIDE} §18 : recherche d'« Envoyer une soirée au développeur »`);
    const [, inner, filter] = /^docker compose exec -T app sh -c '([^']*)' \| (grep -v '[^']*') > ~\/envoi\.txt$/.exec(line);
    const { dossier, ids } = dossierEssai(t);
    const r = spawnSync('sh', ['-c', `${inner.replace('/app/journal/', 'journal/')} | ${filter}`], { cwd: dossier, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n').filter(Boolean), ids.attendu);
  });

// Une soirée en échec avant sa copie (exception du calcul, BAD_META…) n'a
// pas de dossier dans data/soirees-originales/ : tar le signale et finit en
// erreur, l'archive gardant le reste ; les commandes du §18 restent celles
// d'ENVOI et d'ENVOI_PC.
test('A6 : §18, « Envoyer une soirée au développeur » : sans dossier de la soirée dans data/soirees-originales/, le guide dit que tar écrit « Cannot stat » et finit en erreur, l’archive gardant le reste, et tar.exe de même', () => {
  const s18 = section(18);
  const envoi = flat(prose(s18.slice(s18.indexOf('\n### Envoyer une soirée au développeur\n'))));
  for (const needed of ['n\'a pas de dossier dans `data/soirees-originales/`',
    '`tar` écrit alors « Cannot stat » pour lui et finit en erreur, mais l\'archive garde le reste.',
    '`tar.exe` le signale de même, sans gâter l\'archive.']) {
    assert.ok(envoi.includes(needed), `${GUIDE} §18, « Envoyer une soirée au développeur » : ${needed}`);
  }
});

// Étapes « shell: powershell » d'Actions qui lancent ce script (job
// offline-tests de ci.yml, kit de release.yml) : le lanceur finit par
// « if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE } »,
// et le code du dernier programme lancé devient celui de l'étape. Le second
// retrait du §18 sort en code 1, comme attendu, puis seules des cmdlets
// tournent : Invoke-Ligne18 rend ce code, puis remet $LASTEXITCODE à 0.
test('A6 : test/verify-portable-kit.ps1, commandes du §18 : Invoke-Ligne18 rend le code de node.exe, puis remet $LASTEXITCODE à 0 : le code 1 attendu du second retrait ne devient jamais celui de l’étape PowerShell de la CI', () => {
  const script = read('test/verify-portable-kit.ps1');
  const fonction = /\n( *)function Invoke-Ligne18\([^)]*\) \{\n([\s\S]*?)\n\1\}\n/.exec(script);
  assert.ok(fonction, 'test/verify-portable-kit.ps1 : function Invoke-Ligne18 introuvable');
  const lignes = fonction[2].split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const lu = lignes.indexOf('$code = $LASTEXITCODE');
  assert.ok(lu >= 0, 'Invoke-Ligne18 : code de node.exe gardé dans $code');
  assert.equal(lignes[lu + 1], '$global:LASTEXITCODE = 0', 'Invoke-Ligne18 : $LASTEXITCODE remis à 0 aussitôt lu');
  assert.match(lignes.at(-1), /^return \[pscustomobject\]@\{ Code = \$code; /, 'Invoke-Ligne18 rend le code gardé');
});

// Le script ne tourne que sous Windows : ses filtres des lignes du §18 sont
// relus ici, pour qu'une ligne changée dans le guide ne s'y perde pas.
test('A6 : test/verify-portable-kit.ps1 trouve dans le §18, une fois chacune, la ligne gardée du retrait d’un morceau, celle de tar.exe et le Select-String d’« Envoyer une soirée au développeur »', () => {
  const script = read('test/verify-portable-kit.ps1');
  const lignes18 = section(18).split('\n').map(line => line.trim());
  for (const [variable, attendue] of [['retirer', RETRAIT_PC], ['archiver', TAR_PC], ['envoi', ENVOI_PC[0]]]) {
    const filtre = new RegExp(`\\n\\s*\\$${variable} = @\\(\\$lignes18 \\| Where-Object \\{ (.*) \\}\\)\\n`).exec(script);
    assert.ok(filtre, `test/verify-portable-kit.ps1 : filtre $${variable} introuvable`);
    const conditions = [...filtre[1].matchAll(/\$_\.(StartsWith|Contains)\('([^']*)'\)/g)];
    assert.equal(filtre[1].split(' -and ').length, conditions.length, `test/verify-portable-kit.ps1 : filtre $${variable} fait de StartsWith et de Contains joints par -and`);
    const trouvees = lignes18.filter(line => conditions.every(([, how, text]) => (how === 'StartsWith' ? line.startsWith(text) : line.includes(text))));
    assert.deepEqual(trouvees, [attendue], `test/verify-portable-kit.ps1 : $${variable} trouve dans le §18 : ${trouvees.join(' | ')}`);
  }
});

test('A6 : le champ « Journal » du modèle d’issue « Défaut » nomme les lignes « Réparation » et « Fin de soirée » d’envoi.txt, sans la ligne « Clé du bar »', () => {
  const field = read('.github/ISSUE_TEMPLATE/defaut.yml').split('\n  - type: ').find(block => /^textarea\n\s+id: journal\n/.test(block));
  assert.ok(field, '.github/ISSUE_TEMPLATE/defaut.yml : champ journal introuvable');
  for (const needed of ['« Réparation »', '« Fin de soirée »', 'jamais la ligne « Clé du bar »', 'envoi.txt']) {
    assert.ok(flat(field).includes(needed), `.github/ISSUE_TEMPLATE/defaut.yml, champ « Journal » : ${needed}`);
  }
});

test('A6 : test/dossier-reparation.js : aide (code 0), option fausse ou dossier en trop (usage, code 2), dossier déjà préparé (une ligne, code 1)', t => {
  const run = argv => {
    const out = [], err = [];
    const code = dossierReparation.main(argv, { out: line => out.push(line), err: line => err.push(line) });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  for (const option of ['-h', '--help', '--aide']) assert.deepEqual(run([option]), { code: 0, out: dossierReparation.USAGE, err: '' });
  assert.deepEqual(run([]), { code: 2, out: '', err: dossierReparation.USAGE });
  assert.deepEqual(run(['--x']), { code: 2, out: '', err: `Option inconnue : --x\n\n${dossierReparation.USAGE}` });
  assert.deepEqual(run(['a', 'b']), { code: 2, out: '', err: `Un seul dossier attendu : b en trop\n\n${dossierReparation.USAGE}` });
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'dossier-reparation-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const first = run([dossier]);
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(Object.keys(JSON.parse(first.out)).sort(), ['autre', 'decoupee', 'enEchec', 'morceau', 'nonSoiree', 'sansFin']);
  const second = run([dossier]);
  assert.equal(second.code, 1);
  assert.match(second.err, /^[^\n]+ existe déjà : rien n'est écrit \(dossier d'essai sans data\/soirees attendu\)\.$/);
});

test('A6 : CONTEXTE-REPRISE.md, « Architecture utile » : bornage et réparation des soirées, avec les deux constantes d’evening-bounds.js et leurs valeurs, les marques du menu et d’où chacune vient, et chaque code stable de l’index avec ce qui le rend', () => {
  const { MORNING_HOUR, QUIET_MS } = require('../evening-bounds');
  const doc = read('CONTEXTE-REPRISE.md');
  const start = doc.indexOf('\n## Architecture utile\n');
  assert.ok(start >= 0, 'CONTEXTE-REPRISE.md : « Architecture utile » introuvable');
  const archi = flat(doc.slice(start, doc.indexOf('\n## ', start + 1)));
  for (const needed of ['`evening-bounds.js`', '`evening-split.js`', '`planSplit`', '`splitAt`', '`repair`', '`carried: true`',
    '`meta.split`', '`meta.karaoke`', '`data/soirees/.bornage.json`', '`data/soirees-originales/`', '`KARAOKE_REPAIR`',
    '« Réparation : »', '« Réparation des soirées : »', '« Couper la réparation »', '« Revenir à l\'original d\'une soirée découpée »',
    '« Refaire une réparation en échec »', '« Envoyer une soirée au développeur »',
    // Marques du menu de /stats : list() les tire de meta.split et de l'index.
    '« · séparée » d\'après `meta.split`', '« · à vérifier » d\'après l\'index']) {
    assert.ok(archi.includes(needed), `CONTEXTE-REPRISE.md, « Architecture utile » : ${needed}`);
  }
  assert.ok(archi.includes(`\`MORNING_HOUR\`, ${MORNING_HOUR} h`), `CONTEXTE-REPRISE.md : MORNING_HOUR vaut ${MORNING_HOUR} (evening-bounds.js)`);
  assert.ok(archi.includes(`\`QUIET_MS\`, ${QUIET_MS / 60000} min`), `CONTEXTE-REPRISE.md : QUIET_MS vaut ${QUIET_MS / 60000} min (evening-bounds.js)`);
  // Codes stables de l'index (A4, « Échecs ») : ceux des erreurs de données
  // (DATA_CODES d'evening-journal.js) et EXCEPTION, chacun suivi de ce qui le
  // rend (« `BAD_JSON`, un `meta.json` … »), jamais dans une simple liste.
  const codes = /\nconst DATA_CODES = new Set\(\[([^\]]*)\]\);/.exec(read('evening-journal.js'));
  assert.ok(codes, 'evening-journal.js : DATA_CODES introuvable');
  for (const code of [...[...codes[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map(m => m[1]), 'EXCEPTION']) {
    assert.match(archi, new RegExp(`\`${code}\`, [^\`]`), `CONTEXTE-REPRISE.md, « Architecture utile » : code ${code} sans ce qui le rend`);
  }
});

test('A6 : TODOS.md, « Essai à blanc de la réparation des soirées » : le docker run --rm de l’aperçu, sans compose, monte le volume Docker des données sous son nom, karafun-plus_karafun-data (name: de deploy/compose.yaml, puis la clé montée sur /app/data), et l’aperçu dit combien de soirées il a lues : un volume vide, créé par erreur, se lit « 0 soirée lue »', () => {
  const compose = read('deploy/compose.yaml');
  const projet = /^name: ([\w-]+)$/m.exec(compose);
  const cle = /^\s+- ([\w-]+):\/app\/data$/m.exec(compose);
  assert.ok(projet && cle, 'deploy/compose.yaml : name: et volume monté sur /app/data');
  const todos = read('TODOS.md');
  const start = todos.indexOf('\n### Essai à blanc de la réparation des soirées\n');
  assert.ok(start >= 0, 'TODOS.md : « Essai à blanc de la réparation des soirées » introuvable');
  const entree = flat(todos.slice(start, todos.indexOf('\n### ', start + 1)));
  const volume = `${projet[1]}_${cle[1]}`;
  assert.ok(entree.includes(`\`${volume}\``), `TODOS.md, « Essai à blanc… » : volume Docker ${volume} (docker run, sans compose, ne préfixe pas la clé ${cle[1]})`);
  assert.ok(entree.includes('« 0 soirée lue »'), 'TODOS.md, « Essai à blanc… » : l’aperçu dit combien de soirées il a lues (« 0 soirée lue »)');
});
