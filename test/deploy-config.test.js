'use strict';
// Image Docker et fichiers du VPS (issue #29), en lecture statique : Dockerfile,
// .dockerignore, deploy/compose.yaml, deploy/Caddyfile, deploy/.env.example,
// scripts de deploy/ et test/verifier-deploiement.sh. Les valeurs attendues
// sont recopiées de la spécification, jamais lues dans les fichiers vérifiés.
// Aucun Docker ici : la construction et le déploiement réels sont vérifiés par
// test/verifier-deploiement.sh (Linux). Les contrôles git (attributs, modes,
// fichiers ignorés) sont sautés sans dépôt. D6 lance les deux scripts de
// deploy/ (bash, hors Windows) avec un faux docker qui simule l'état du
// service app ; D7 lance le vérificateur avec de faux docker, curl et ip
// jusqu'à un échec de préparation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8');
const manifest = JSON.parse(read('livrable.json').replace(/^\uFEFF/, ''));
const DEPLOY = ['deploy/compose.yaml', 'deploy/Caddyfile', 'deploy/.env.example', 'deploy/sauvegarde.sh', 'deploy/restauration.sh'];
const VERIFIER = 'test/verifier-deploiement.sh';
const FIXTURE = 'test/fixtures/compose.essai-caddy.yaml';
// Fichiers où vivent les commandes du VPS (forme unique, jamais --entrypoint).
const COMMAND_FILES = [...DEPLOY, VERIFIER];
const OWNER = 'jpfroud';
const IMAGE = `ghcr.io/${OWNER}/karafun-plus`;

// Instructions d'un Dockerfile : lignes continuées par « \ » jointes, commentaires
// et lignes vides ignorés. { op, args, stage } avec stage = index du FROM.
function instructions(text) {
  const out = [];
  let current = null;
  let stage = -1;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const continued = line.endsWith('\\');
    const body = continued ? line.slice(0, -1).trimEnd() : line;
    current = current === null ? body : `${current} ${body}`;
    if (continued) continue;
    const match = /^(\S+)\s*(.*)$/.exec(current);
    const op = match[1].toUpperCase();
    if (op === 'FROM') stage++;
    out.push({ op, args: match[2], stage });
    current = null;
  }
  return out;
}
const dockerfile = instructions(read('Dockerfile'));
const finalStage = Math.max(...dockerfile.map(i => i.stage));
const inStage = (stage, op) => dockerfile.filter(i => i.stage === stage && i.op === op);
const stageNamed = name => dockerfile.find(i => i.op === 'FROM' && i.args.endsWith(` AS ${name}`)).stage;
// COPY : options --x=y, sources, destination (dernier mot).
function copyParts(args) {
  const words = args.split(/\s+/);
  const flags = Object.fromEntries(words.filter(w => w.startsWith('--')).map(w => w.slice(2).split('=')));
  const paths = words.filter(w => !w.startsWith('--'));
  return { flags, sources: paths.slice(0, -1), dest: paths.at(-1) };
}
const workdir = stage => path.posix.normalize(inStage(stage, 'WORKDIR').at(-1).args);

test('D1 Dockerfile et contrat', () => {
  assert.deepEqual(dockerfile.filter(i => i.op === 'FROM').map(i => i.args), [
    '--platform=$BUILDPLATFORM maven:3.9-eclipse-temurin-21 AS solveur',
    'eclipse-temurin:21-jdk AS jre',
    '--platform=$BUILDPLATFORM node:22-bookworm-slim AS deps',
    'node:22-bookworm-slim',
  ], 'bases et étapes');

  // Environnement de l'image : exactement ces cinq variables, aucune URL ni clé.
  const envs = dockerfile.filter(i => i.op === 'ENV');
  assert.equal(envs.length, 1, 'une seule instruction ENV');
  assert.equal(envs[0].stage, finalStage, 'ENV dans l’étape finale');
  assert.deepEqual(Object.fromEntries(envs[0].args.split(/\s+/).map(pair => pair.split('='))), {
    KARAOKE_MODE: 'server',
    KARAOKE_BIND: '0.0.0.0',
    KARAOKE_PUBLIC_BIND: '0.0.0.0',
    KARAOKE_CLIENT_IP_HEADER: 'x-real-ip',
    TZ: 'Europe/Paris',
  });
  for (const stage of [stageNamed('deps'), finalStage]) {
    assert.deepEqual(inStage(stage, 'ARG').map(i => i.args), ['VERSION', 'COMMIT', 'BUILT_AT'], `ARG de l’étape ${stage}`);
  }
  const text = read('Dockerfile');
  for (const frozen of ['KARAOKE_PUBLIC_URL', 'KARAOKE_STAFF_URL', 'KARAOKE_STAFF_KEY', 'KARAOKE_TRUSTED_PROXIES', 'staff-key', 'key=', 'data/']) {
    assert.ok(!text.includes(frozen), `« ${frozen} » figé dans le Dockerfile`);
  }

  const labels = Object.fromEntries([...inStage(finalStage, 'LABEL').map(i => i.args).join(' ')
    .matchAll(/([\w.-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
  assert.deepEqual(labels, {
    'org.opencontainers.image.title': 'karafun-plus',
    'org.opencontainers.image.source': `https://github.com/${OWNER}/karafun-plus`,
    'org.opencontainers.image.licenses': 'Unlicense',
    'org.opencontainers.image.version': '${VERSION}',
    'org.opencontainers.image.revision': '${COMMIT}',
    'org.opencontainers.image.created': '${BUILT_AT}',
  });

  const jre = stageNamed('jre');
  const jlink = inStage(jre, 'RUN').map(i => /jlink --add-modules (\S+)/.exec(i.args)).find(Boolean);
  assert.ok(jlink, 'jlink dans l’étape jre');
  assert.deepEqual(jlink[1].split(','), ['java.base', 'java.xml', 'java.logging', 'java.management', 'jdk.management', 'jdk.unsupported']);

  // Utilisateur node après la dernière copie : le code reste à root.
  const final = dockerfile.filter(i => i.stage === finalStage);
  const user = final.findIndex(i => i.op === 'USER');
  assert.deepEqual(final.filter(i => i.op === 'USER').map(i => i.args), ['node']);
  assert.ok(final.every((i, n) => !['COPY', 'ADD', 'RUN'].includes(i.op) || n < user), 'COPY ou RUN après USER node');
  assert.ok(final.every(i => i.op !== 'COPY' || !/--chown|--chmod/.test(i.args)), 'COPY avec --chown ou --chmod');
  assert.deepEqual(final.filter(i => i.op === 'VOLUME').map(i => JSON.parse(i.args)), [['/app/data', '/app/journal']]);
  assert.deepEqual(final.filter(i => i.op === 'EXPOSE').map(i => i.args), ['3000 3001']);
  assert.deepEqual(final.filter(i => i.op === 'HEALTHCHECK').map(i => i.args), [
    '--interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "-e", "fetch(\'http://127.0.0.1:3001/healthz\').then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))"]',
  ]);
  assert.equal(dockerfile.filter(i => i.op === 'ENTRYPOINT').length, 0, 'ENTRYPOINT propre à l’image');
  assert.deepEqual(final.filter(i => i.op === 'CMD').map(i => JSON.parse(i.args)), [['node', 'server.js', '--no-open']]);
  assert.equal(final.at(-1).op, 'CMD', 'CMD en dernier');

  for (const file of ['Dockerfile', '.dockerignore', ...COMMAND_FILES, FIXTURE]) {
    assert.ok(!read(file).includes('<propriétaire>'), `« <propriétaire> » laissé dans ${file}`);
  }
  // Aucun caractère invisible (BOM, espace insécable ou de largeur nulle) :
  // un éditeur peut l'effacer sans le montrer. Écrire \uFEFF, jamais le caractère.
  for (const file of ['Dockerfile', '.dockerignore', ...COMMAND_FILES, FIXTURE, 'test/deploy-config.test.js']) {
    const line = read(file).split('\n').findIndex(l => /[\uFEFF\u00A0\u202F\u200B-\u200D\u2060]/.test(l));
    assert.equal(line, -1, `caractère invisible dans ${file}, ligne ${line + 1}`);
  }

  // Formes uniques des commandes ponctuelles (en-tête de deploy/compose.yaml).
  const FORMS = {
    '--print-staff-url': 'docker compose exec app node server.js --print-staff-url',
    '--rotate-staff-key': 'docker compose exec app node server.js --rotate-staff-key',
    'diag-karafun': `docker run --rm ${IMAGE}:<version> node tools/diag-karafun.js <code>`,
  };
  const header = read('deploy/compose.yaml').split('\n');
  for (const line of [
    `# Lien de la page du bar : ${FORMS['--print-staff-url']}`,
    `# Nouvelle clé du bar : ${FORMS['--rotate-staff-key']}`,
    '#   puis docker compose restart app',
    `# Diagnostic KaraFun : ${FORMS['diag-karafun']}`,
  ]) assert.ok(header.includes(line), `ligne absente de deploy/compose.yaml : ${line}`);
  for (const file of COMMAND_FILES) {
    const lines = read(file).split(/\r?\n/);
    assert.ok(lines.every(line => !line.includes('--entrypoint')), `--entrypoint dans ${file}`);
    for (const [mark, form] of Object.entries(FORMS)) {
      for (const line of lines.filter(l => l.includes(mark))) {
        assert.ok(line.includes(form), `commande d’une autre forme dans ${file} : ${line.trim()}`);
      }
    }
  }
});

test('D2 chemins du solveur', t => {
  const solveur = stageNamed('solveur');
  const jre = stageNamed('jre');
  assert.equal(workdir(finalStage), '/app');
  const copies = inStage(finalStage, 'COPY').map(i => copyParts(i.args));
  const dest = parts => path.posix.join(workdir(finalStage), parts.dest);
  // Jar construit dans l'étape solveur, copié là où le pont le cherche.
  const jarCopy = copies.find(c => c.flags.from === 'solveur' && c.sources[0].endsWith('.jar'));
  assert.ok(jarCopy, 'COPY du jar depuis solveur');
  assert.equal(jarCopy.sources[0], path.posix.join(workdir(solveur), 'solver/target/karafun-solver.jar'));
  assert.ok(inStage(solveur, 'RUN').some(i => i.args.includes('test -s solver/target/karafun-solver.jar')), 'jar vérifié non vide');
  assert.equal(dest(jarCopy), '/app/solver/karafun-solver.jar');
  // Runtime jlink copié dans solver-runtime/.
  const runtimeCopy = copies.find(c => c.flags.from === 'jre');
  assert.ok(runtimeCopy, 'COPY du runtime depuis jre');
  assert.ok(inStage(jre, 'RUN').some(i => i.args.includes(`--output ${runtimeCopy.sources[0].replace(/\/$/, '')}`)), 'sortie de jlink copiée');
  assert.equal(dest(runtimeCopy), '/app/solver-runtime/');
  // Livrable à la racine de /app : solver/bridge.js y trouve ROOT = /app.
  const livrable = copies.find(c => c.flags.from === 'deps');
  assert.deepEqual([livrable.sources, dest(livrable)], [['/livrable/'], '/app/']);
  assert.ok(manifest.commun.includes('solver/bridge.js'), 'solver/bridge.js dans commun');

  // Le vrai solver/bridge.js, copié dans une arborescence de /app sous Linux :
  // jar et Java choisis aux chemins des COPY (Java du PATH sans runtime).
  const choose = withRuntime => {
    const app = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'image-solveur-')), 'app');
    t.after(() => fs.rmSync(path.dirname(app), { recursive: true, force: true }));
    const at = posix => path.join(app, ...posix.replace(/^\/app\/?/, '').split('/').filter(Boolean));
    fs.mkdirSync(path.join(app, 'solver'), { recursive: true });
    fs.copyFileSync(path.join(root, 'solver', 'bridge.js'), path.join(app, 'solver', 'bridge.js'));
    fs.writeFileSync(at(dest(jarCopy)), 'jar');
    if (withRuntime) {
      fs.mkdirSync(path.join(at(dest(runtimeCopy)), 'bin'), { recursive: true });
      fs.writeFileSync(path.join(at(dest(runtimeCopy)), 'bin', 'java'), '');
    }
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    try {
      const { TimefoldBridge } = require(path.join(app, 'solver', 'bridge.js'));
      const bridge = new TimefoldBridge({ env: {} });
      return { jar: bridge.jar, java: bridge.java, expected: { jar: at(dest(jarCopy)), java: path.join(at(dest(runtimeCopy)), 'bin', 'java') } };
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  };
  const image = choose(true);
  assert.equal(image.jar, image.expected.jar, 'jar de l’image');
  assert.equal(image.java, image.expected.java, 'Java du runtime de l’image');
  assert.equal(choose(false).java, 'java', 'sans runtime, le pont prendrait le Java du PATH');
});

// Règles d'un .dockerignore selon Docker : motif nettoyé (sans « / » final),
// « * » dans un seul segment, dernière règle applicable gagnante, une règle
// qui vise un dossier vaut pour son contenu.
function dockerignored(rules, file) {
  let excluded = false;
  for (const rule of rules) {
    const negated = rule.startsWith('!');
    const pattern = path.posix.normalize(negated ? rule.slice(1) : rule).replace(/\/$/, '');
    const regex = new RegExp(`^${pattern.split('/').map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('/')}$`);
    const segments = file.split('/');
    if (segments.some((_, n) => regex.test(segments.slice(0, n + 1).join('/')))) excluded = !negated;
  }
  return excluded;
}

test('D3 .dockerignore = livrable.json', () => {
  const text = read('.dockerignore');
  const isDir = entry => fs.statSync(path.join(root, ...entry.split('/'))).isDirectory();
  const expected = [
    '# Liste blanche alignée sur livrable.json (test/deploy-config.test.js).',
    '*',
    '!livrable.json',
    '!scripts/preparer-livrable.js',
    '!solver/pom.xml',
    '!solver/src/',
    '# livrable.json « commun »',
    ...manifest.commun.map(entry => `!${entry}${isDir(entry) ? '/' : ''}`),
  ];
  assert.deepEqual(text.replace(/\n$/, '').split('\n'), expected, 'commun, dans l’ordre, dossiers avec « / »');

  const rules = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  assert.equal(rules[0], '*', 'première règle « * »');
  // Fichiers envoyés à Docker : tout commun, les sources du solveur et la préparation.
  const expand = entry => (isDir(entry)
    ? fs.readdirSync(path.join(root, ...entry.split('/'))).flatMap(name => expand(`${entry}/${name}`)) : [entry]);
  for (const file of [...manifest.commun.flatMap(expand), 'livrable.json', 'scripts/preparer-livrable.js', 'solver/pom.xml', ...expand('solver/src')]) {
    assert.ok(!dockerignored(rules, file), `fichier livré absent du contexte : ${file}`);
  }
  for (const copy of dockerfile.filter(i => i.op === 'COPY' && !/--from=/.test(i.args))) {
    for (const source of copyParts(copy.args).sources.filter(s => s !== '.')) {
      assert.ok(!dockerignored(rules, source), `source de COPY exclue : ${source}`);
    }
  }
  // Rien de privé ni du kit Windows.
  for (const file of ['data/staff-key', 'data/soirees/x/journal.jsonl', 'journal/x.log', '.env', 'deploy/.env',
    'deploy/sauvegardes/x.tar.gz', 'test/run-offline.js', '.git/config', 'node_modules/qrcode/package.json',
    'solver/target/karafun-solver.jar', 'solver-runtime/bin/java', 'build-info.json',
    ...manifest.windows.flatMap(expand)]) {
    assert.ok(dockerignored(rules, file), `fichier envoyé à Docker : ${file}`);
  }
});

test('D4 .env.example et mot de passe', () => {
  const lines = read('deploy/.env.example').split('\n').filter(l => l && !l.startsWith('#'));
  const env = lines.map(l => /^([A-Z_]+)=(.*)$/.exec(l)).map(m => (assert.ok(m, 'ligne KEY=valeur'), [m[1], m[2]]));
  const values = Object.fromEntries(env);
  assert.deepEqual(env.map(([key]) => key), ['KARAFUN_PLUS_VERSION', 'HOTE_CLIENTS', 'HOTE_BAR', 'KARAOKE_PUBLIC_URL',
    'KARAOKE_STAFF_URL', 'ACME_EMAIL', 'BAR_USER', 'BAR_PASSWORD_HASH'], 'clés de deploy/.env.example');
  assert.equal(values.HOTE_CLIENTS, 'clients.exemple.fr');
  assert.equal(values.HOTE_BAR, 'bar.exemple.fr');
  assert.equal(values.KARAOKE_PUBLIC_URL, `https://${values.HOTE_CLIENTS}`);
  assert.equal(values.KARAOKE_STAFF_URL, `https://${values.HOTE_BAR}`);
  assert.equal(values.BAR_PASSWORD_HASH, '\'$2a$14$remplacer.par.l.empreinte.produite.par.caddy.hash.password\'');
  assert.ok(read('deploy/.env.example').split('\n').some(l => l.startsWith('#') && l.includes('docker run --rm -it caddy:2 caddy hash-password')),
    'commande d’empreinte au clavier');

  // Variables : celles de .env.example, ni plus ni moins, dans compose.yaml ;
  // environnement de chaque service exactement celui de la section 3 (celles
  // du Caddyfile à caddy, les deux origines à app, aucune valeur en clair).
  const compose = read('deploy/compose.yaml');
  const composeVars = [...compose.matchAll(/\$\{([A-Z_]+):\?à renseigner dans deploy\/\.env\}/g)].map(m => m[1]);
  assert.equal([...compose.matchAll(/\$\{/g)].length, composeVars.length, 'variable de compose.yaml sans « :?à renseigner »');
  assert.deepEqual([...new Set(composeVars)].sort(), Object.keys(values).sort(), 'variables de compose.yaml');
  const composeLines = compose.split('\n');
  const environment = service => {
    const start = composeLines.indexOf(`  ${service}:`);
    assert.ok(start >= 0, `service ${service} absent de deploy/compose.yaml`);
    const end = composeLines.findIndex((line, n) => n > start && /^ {0,2}\S/.test(line));
    const block = composeLines.slice(start + 1, end < 0 ? undefined : end);
    const from = block.indexOf('    environment:');
    assert.ok(from >= 0, `environment absent du service ${service}`);
    const entries = [];
    for (const line of block.slice(from + 1)) {
      if (!line.startsWith('      ')) break;
      entries.push(line.trim());
    }
    return entries;
  };
  const required = name => `${name}: \${${name}:?à renseigner dans deploy/.env}`;
  const caddyVars = [...new Set([...read('deploy/Caddyfile').matchAll(/\{\$([A-Z_]+)\}/g)].map(m => m[1]))].sort();
  assert.deepEqual(caddyVars, ['ACME_EMAIL', 'BAR_PASSWORD_HASH', 'BAR_USER', 'HOTE_BAR', 'HOTE_CLIENTS']);
  assert.deepEqual(environment('caddy'), ['ACME_EMAIL', 'HOTE_CLIENTS', 'HOTE_BAR', 'BAR_USER', 'BAR_PASSWORD_HASH'].map(required),
    'environnement de caddy');
  assert.deepEqual(environment('app'), ['KARAOKE_PUBLIC_URL', 'KARAOKE_STAFF_URL'].map(required), 'environnement de app');
  // Le vérificateur retire de son environnement chaque réglage de .env.example
  // (sinon une valeur du shell primerait sur son .env d'essai).
  const unset = /^unset ((?:[^\n]*\\\n)*[^\n]*)$/m.exec(read(VERIFIER));
  assert.ok(unset, `ligne unset absente de ${VERIFIER}`);
  const unsetNames = unset[1].split(/[\s\\]+/).filter(Boolean);
  for (const key of Object.keys(values)) {
    assert.ok(unsetNames.includes(key), `${key} non retiré de l’environnement par ${VERIFIER}`);
  }

  for (const file of [...COMMAND_FILES, FIXTURE, 'Dockerfile']) {
    const text = read(file);
    assert.ok(!/\$2[aby]?\$\d\d\$[./A-Za-z0-9]{53}(?![./A-Za-z0-9])/.test(text), `empreinte bcrypt réelle dans ${file}`);
    assert.ok(!text.includes('--plaintext'), `mot de passe en argument (--plaintext) dans ${file}`);
    for (const [name] of text.matchAll(/[a-z0-9-]+(\.[a-z0-9-]+)*\.(fr|com|net|org|eu)\b/gi)) {
      assert.ok(/(^|\.)exemple\.fr$|^(www\.)?karafun\.com$|^github\.com$/i.test(name), `nom d’hôte réel dans ${file} : ${name}`);
    }
  }
  for (const file of ['deploy/Caddyfile', 'deploy/.env.example']) {
    assert.ok(!/spotify/i.test(read(file)), `Spotify dans ${file}`);
  }
});

test('D5 attributs git et modes', t => {
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0) { t.skip('dépôt git absent'); return; }
  const lf = ['Dockerfile', '.dockerignore', ...DEPLOY, VERIFIER];
  const attrs = git(['check-attr', 'eol', '--', ...lf]);
  assert.equal(attrs.status, 0, attrs.stderr);
  assert.deepEqual(attrs.stdout.trim().split('\n'), lf.map(file => `${file}: eol: lf`));

  const index = git(['ls-files', '-s', '--', 'deploy', VERIFIER]);
  assert.equal(index.status, 0, index.stderr);
  const modes = Object.fromEntries(index.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [, mode, file] = /^(\d+) \S+ \d+\t(.+)$/.exec(line);
    return [file, mode];
  }));
  assert.deepEqual(modes, {
    'deploy/.env.example': '100644',
    'deploy/Caddyfile': '100644',
    'deploy/compose.yaml': '100644',
    'deploy/restauration.sh': '100755',
    'deploy/sauvegarde.sh': '100755',
    [VERIFIER]: '100644',
  }, 'fichiers versionnés et modes');

  // deploy/.env.example est suivi : sans --no-index, git ne le compare pas aux
  // règles et répond 1 même sans « !.env.example » dans .gitignore.
  for (const args of [['deploy/.env'], ['deploy/sauvegardes/x.tar.gz']]) {
    assert.equal(git(['check-ignore', '-q', ...args]).status, 0, `git check-ignore -q ${args.join(' ')}`);
  }
  const example = ['--no-index', 'deploy/.env.example'];
  assert.equal(git(['check-ignore', '-q', ...example]).status, 1, `git check-ignore -q ${example.join(' ')}`);
});

// Faux docker des scripts de deploy/ : état du service app dans $FAKE_STATE
// (running, restarting ou exited), chaque appel noté dans $FAKE_LOG avec l'état
// du moment, « compose run » rejoué sur $FAKE_APP à la place de /app.
// FAKE_RUN_FAIL=1 fait échouer tout « compose run » ; tar ou sh, seulement
// celui de cette commande (copie de sauvegarde.sh ou remplacement).
// FAKE_RUN_OUT=journal : la copie de sauvegarde.sh ne contient que journal/.
// FAKE_START_FAIL=1 : start et up échouent sans changer l'état. « compose
// run » tourne sous umask 022, comme dans un conteneur.
const FAKE_DOCKER = [
  '#!/usr/bin/env bash',
  'set -u',
  'etat=$(cat "$FAKE_STATE")',
  'printf \'%s|%s\\n\' "$etat" "$*" >> "$FAKE_LOG"',
  '[ "$1" = compose ] || exit 99',
  'shift',
  'case $1 in',
  '  ps)',
  '    while [ "$#" -gt 0 ]; do',
  '      if [ "$1" = --status ] && [ "${2:-}" = "$etat" ]; then echo 0123456789ab; break; fi',
  '      shift',
  '    done ;;',
  '  stop) echo exited > "$FAKE_STATE" ;;',
  '  start | up) [ -z "${FAKE_START_FAIL:-}" ] || exit 1; echo running > "$FAKE_STATE" ;;',
  '  run)',
  '    case ${FAKE_RUN_FAIL:-} in 1 | "$6") exit 1 ;; esac',
  '    umask 022',
  '    if [ "${FAKE_RUN_OUT:-}" = journal ] && [ "$6" = tar ]; then exec tar -czf - -C "$FAKE_APP" journal; fi',
  '    shift 5 # run --rm --no-deps -T app',
  '    if [ "$1" = sh ] && [ "$2" = -c ]; then exec sh -c "${3//\\/app/$FAKE_APP}"; fi',
  '    args=()',
  '    for a in "$@"; do args+=("${a//\\/app/$FAKE_APP}"); done',
  '    exec "${args[@]}" ;;',
  '  *) exit 99 ;;',
  'esac',
  '',
].join('\n');

test('D6 scripts de deploy/ (faux docker)', { skip: process.platform === 'win32' && 'scripts bash du VPS (Linux)' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-scripts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = (...parts) => path.join(dir, ...parts);
  for (const sub of ['bin', 'deploy', 'archives', 'src/data', 'src/journal']) fs.mkdirSync(at(sub), { recursive: true });
  fs.writeFileSync(at('bin', 'docker'), FAKE_DOCKER, { mode: 0o755 });
  for (const script of ['sauvegarde.sh', 'restauration.sh']) {
    fs.copyFileSync(path.join(root, 'deploy', script), at('deploy', script));
    fs.chmodSync(at('deploy', script), 0o755);
  }
  fs.writeFileSync(at('src', 'data', 'staff-key'), 'restauree\n');
  fs.writeFileSync(at('src', 'journal', 'j.log'), 'ligne\n');
  fs.writeFileSync(at('src', 'LICENSE'), 'licence\n');
  // Dossiers 0755, comme dans une archive faite sous Windows.
  for (const sub of ['data', 'journal']) fs.chmodSync(at('src', sub), 0o755);
  // -P garde « data/../LICENSE » dans le nom (archive piégée).
  const tar = (archive, ...entries) => {
    const r = spawnSync('tar', ['-czPf', at('archives', archive), '-C', at('src'), ...entries], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return at('archives', archive);
  };
  const archive = tar('a.tar.gz', 'data', 'journal');
  const lines = text => text.split('\n').filter(Boolean);
  const mode = (...parts) => (fs.statSync(at(...parts)).mode & 0o777).toString(8);
  // Lance un script dans un état neuf : app (data/ et journal/ en 0755,
  // data/staff-key « ancienne »), sauvegardes/ vide, service app dans l'état
  // donné ; before() prépare le reste juste avant le lancement.
  const run = (script, { state, args = [], input = '', env = {}, before }) => {
    fs.rmSync(at('app'), { recursive: true, force: true });
    fs.rmSync(at('deploy', 'sauvegardes'), { recursive: true, force: true });
    fs.mkdirSync(at('app', 'data'), { recursive: true });
    fs.mkdirSync(at('app', 'journal'));
    for (const sub of ['data', 'journal']) fs.chmodSync(at('app', sub), 0o755);
    fs.writeFileSync(at('app', 'data', 'staff-key'), 'ancienne\n');
    fs.writeFileSync(at('state'), `${state}\n`);
    fs.writeFileSync(at('calls.log'), '');
    if (before) before();
    const r = spawnSync('bash', [at('deploy', script), ...args], {
      cwd: at('deploy'), input, encoding: 'utf8',
      env: { ...process.env, PATH: `${at('bin')}${path.delimiter}${process.env.PATH}`,
        FAKE_STATE: at('state'), FAKE_LOG: at('calls.log'), FAKE_APP: at('app'), ...env },
    });
    const calls = lines(fs.readFileSync(at('calls.log'), 'utf8')).map(line => {
      const [during, command] = line.split('|');
      return { during, command: command.split(' ').slice(0, 2).join(' ') };
    });
    return { ...r, calls, state: fs.readFileSync(at('state'), 'utf8').trim() };
  };
  const backups = () => (fs.existsSync(at('deploy', 'sauvegardes')) ? fs.readdirSync(at('deploy', 'sauvegardes')) : []);
  const written = /^Sauvegarde écrite : sauvegardes\/karafun-plus-[0-9]{8}-[0-9]{6}Z\.tar\.gz \(.+\)$/;

  // App en boucle de redémarrage (restarting) : Docker la relancerait pendant
  // la copie ou le remplacement des données. Elle compte comme en marche.
  let r = run('sauvegarde.sh', { state: 'restarting' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map(c => `${c.command} (${c.during})`),
    ['compose ps (restarting)', 'compose stop (restarting)', 'compose run (exited)', 'compose start (exited)'], 'sauvegarde, app en redémarrage');
  assert.equal(lines(r.stdout).length, 3);
  assert.equal(lines(r.stdout)[0], 'Arrêt de la file karaoké le temps de la copie.');
  assert.match(lines(r.stdout)[1], written);
  assert.equal(lines(r.stdout)[2], 'File karaoké relancée.');

  r = run('restauration.sh', { state: 'restarting', args: [archive], input: 'RESTAURER\n' });
  assert.equal(r.status, 0, r.stderr);
  const firstRun = r.calls.findIndex(c => c.command === 'compose run');
  assert.ok(firstRun > 0 && r.calls.slice(0, firstRun).some(c => c.command === 'compose stop'), 'restauration, app en redémarrage non arrêtée');
  assert.deepEqual(r.calls.filter(c => c.command === 'compose run').map(c => c.during), ['exited', 'exited'], 'données copiées ou remplacées pendant que app tourne');
  const out = lines(r.stdout);
  assert.deepEqual([out.length, ...out.slice(0, 4), ...out.slice(5)], [7, `Les données actuelles seront remplacées par ${archive}.`,
    'Tape RESTAURER pour confirmer : ', 'Arrêt de la file karaoké.', 'Sauvegarde de l\'état actuel avant restauration :',
    `Restauration terminée depuis ${archive}.`, 'File karaoké relancée.']);
  assert.match(out[4], written);
  assert.equal(fs.readFileSync(at('app', 'data', 'staff-key'), 'utf8'), 'restauree\n', 'données restaurées');
  assert.equal(r.state, 'running', 'app relancée');
  // Dossiers 0755 de l'archive refermés par le chmod 700 final.
  assert.deepEqual([mode('app', 'data'), mode('app', 'journal')], ['700', '700'], 'droits de data/ et journal/ après restauration');

  // Chemin relatif avec CDPATH exporté : « cd » y écrit le dossier trouvé, qui
  // ne doit pas entrer dans le chemin absolu de l'archive.
  fs.mkdirSync(at('deploy', 'arch'), { recursive: true });
  fs.copyFileSync(archive, at('deploy', 'arch', 'a.tar.gz'));
  r = run('restauration.sh', { state: 'running', args: ['arch/a.tar.gz'], input: 'RESTAURER\n', env: { CDPATH: '.' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(lines(r.stdout).includes('Restauration terminée depuis arch/a.tar.gz.'), r.stdout);
  assert.equal(fs.readFileSync(at('app', 'data', 'staff-key'), 'utf8'), 'restauree\n', 'données restaurées (CDPATH)');

  // App arrêtée ou jamais créée (VPS neuf, bascule) : aucun arrêt, sauvegarde
  // imbriquée sans relance, puis up -d (section 7, étape 5 : « Dès ici, trap »).
  r = run('restauration.sh', { state: 'exited', args: [archive], input: 'RESTAURER\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map(c => c.command), ['compose ps', 'compose ps', 'compose run', 'compose run', 'compose up'], 'restauration, app arrêtée');
  assert.equal(lines(r.stdout).length, 6, r.stdout);
  assert.ok(!r.stdout.includes('Arrêt de la file karaoké'), r.stdout);
  assert.equal(lines(r.stdout).at(-1), 'File karaoké relancée.');
  assert.equal(fs.readFileSync(at('app', 'data', 'staff-key'), 'utf8'), 'restauree\n', 'données restaurées (app arrêtée)');
  assert.equal(r.state, 'running', 'app non lancée après une restauration sur VPS neuf');

  // Copie en échec : rien de partiel gardé, app relancée, code non nul.
  r = run('sauvegarde.sh', { state: 'running', env: { FAKE_RUN_FAIL: '1' } });
  assert.notEqual(r.status, 0);
  assert.deepEqual(backups(), [], 'archive partielle gardée');
  assert.deepEqual(r.calls.map(c => c.command), ['compose ps', 'compose stop', 'compose run', 'compose start']);
  assert.equal(lines(r.stdout).at(-1), 'File karaoké relancée.');
  assert.equal(r.state, 'running');

  // Copie sans data/ : refus, rien de gardé, app relancée.
  r = run('sauvegarde.sh', { state: 'running', env: { FAKE_RUN_OUT: 'journal' } });
  assert.equal(r.status, 1);
  assert.equal(lines(r.stderr).at(-1), 'Sauvegarde refusée : l\'archive ne contient pas data/.');
  assert.deepEqual(backups(), [], 'archive sans data/ ou partielle gardée');
  assert.equal(lines(r.stdout).at(-1), 'File karaoké relancée.');
  assert.equal(r.state, 'running');

  // Archive du même horodatage déjà là : refus avant tout appel à docker,
  // archive existante intacte (faux date).
  const stamp = '20261023-120000Z';
  fs.mkdirSync(at('bin-date'));
  fs.writeFileSync(at('bin-date', 'date'), `#!/usr/bin/env bash\necho ${stamp}\n`, { mode: 0o755 });
  const existing = `sauvegardes/karafun-plus-${stamp}.tar.gz`;
  r = run('sauvegarde.sh', {
    state: 'running',
    env: { PATH: [at('bin-date'), at('bin'), process.env.PATH].join(path.delimiter) },
    before: () => { fs.mkdirSync(at('deploy', 'sauvegardes')); fs.writeFileSync(at('deploy', existing), 'ancienne archive\n'); },
  });
  assert.deepEqual([r.status, r.stderr.trim(), r.stdout, r.calls], [1, `Sauvegarde refusée : ${existing} existe déjà.`, '', []]);
  assert.equal(fs.readFileSync(at('deploy', existing), 'utf8'), 'ancienne archive\n', 'archive existante remplacée');
  assert.deepEqual(backups(), [path.basename(existing)]);

  // Relance en échec : code 1, jamais « File karaoké relancée. ».
  r = run('sauvegarde.sh', { state: 'running', env: { FAKE_START_FAIL: '1' } });
  assert.equal(r.status, 1, 'sauvegarde : code 0 alors que la file reste arrêtée');
  assert.ok(!r.stdout.includes('File karaoké relancée.'), r.stdout);
  assert.equal(r.state, 'exited');
  r = run('restauration.sh', { state: 'running', args: [archive], input: 'RESTAURER\n', env: { FAKE_START_FAIL: '1' } });
  assert.equal(r.status, 1, 'restauration : code 0 alors que la file reste arrêtée');
  assert.ok(!r.stdout.includes('File karaoké relancée.'), r.stdout);
  assert.ok(lines(r.stdout).includes(`Restauration terminée depuis ${archive}.`), r.stdout);
  assert.equal(r.state, 'exited');

  // Sauvegarde de sécurité en échec : rien n'est remplacé, app relancée.
  r = run('restauration.sh', { state: 'running', args: [archive], input: 'RESTAURER\n', env: { FAKE_RUN_FAIL: 'tar' } });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(at('app', 'data', 'staff-key'), 'utf8'), 'ancienne\n', 'données remplacées sans sauvegarde de sécurité');
  assert.equal(r.calls.filter(c => c.command === 'compose run').length, 1, 'remplacement lancé après une sauvegarde en échec');
  assert.ok(!r.stdout.includes('Restauration terminée'), 'succès annoncé sans sauvegarde de sécurité');
  assert.equal(lines(r.stdout).at(-1), 'File karaoké relancée.');
  assert.equal(r.state, 'running');

  // Remplacement en échec : code non nul, aucun succès annoncé, sauvegarde de
  // sécurité gardée.
  r = run('restauration.sh', { state: 'running', args: [archive], input: 'RESTAURER\n', env: { FAKE_RUN_FAIL: 'sh' } });
  assert.notEqual(r.status, 0);
  assert.ok(!r.stdout.includes('Restauration terminée'), 'succès annoncé après un remplacement en échec');
  assert.equal(backups().filter(f => /^karafun-plus-[0-9]{8}-[0-9]{6}Z\.tar\.gz$/.test(f)).length, 1, 'sauvegarde de sécurité absente');

  // Archives refusées avant toute question : aucun appel à docker.
  const refused = 'Archive refusée : elle doit contenir data/ et seulement data/ et journal/.';
  const unreadable = at('archives', 'illisible.tar.gz');
  fs.writeFileSync(unreadable, 'pas une archive\n');
  const piege = tar('piege.tar.gz', 'data', 'data/../LICENSE');
  assert.ok(lines(spawnSync('tar', ['-tzf', piege], { encoding: 'utf8' }).stdout).includes('data/../LICENSE'), 'archive piégée sans data/../LICENSE');
  for (const [file, message] of [[tar('journal.tar.gz', 'journal'), refused], [tar('hors.tar.gz', 'data', 'journal', 'LICENSE'), refused],
    [piege, refused], [unreadable, `Archive illisible : ${unreadable}`]]) {
    r = run('restauration.sh', { state: 'running', args: [file] });
    assert.deepEqual([r.status, lines(r.stderr).at(-1), r.stdout, r.calls], [1, message, '', []], `refus de ${path.basename(file)}`);
    assert.equal(fs.readFileSync(at('app', 'data', 'staff-key'), 'utf8'), 'ancienne\n');
  }
  // Nombre d'arguments et archive absente (section 7, étapes 1 et 2).
  r = run('restauration.sh', { state: 'running' });
  assert.deepEqual([r.status, r.stderr.trim(), r.stdout, r.calls],
    [2, 'Usage : ./restauration.sh sauvegardes/karafun-plus-AAAAMMJJ-HHMMSSZ.tar.gz', '', []], 'sans argument');
  const absent = at('archives', 'absente.tar.gz');
  r = run('restauration.sh', { state: 'running', args: [absent] });
  assert.deepEqual([r.status, r.stderr.trim(), r.stdout, r.calls], [1, `Archive introuvable : ${absent}`, '', []], 'archive absente');

  // Sans confirmation (stdin fermé, autre réponse, ligne non terminée) : rien
  // ne change, aucun appel à docker.
  for (const input of ['', 'non\n', 'RESTAURER']) {
    r = run('restauration.sh', { state: 'running', args: [archive], input });
    assert.deepEqual([r.status, lines(r.stdout).at(-1), r.calls], [1, 'Restauration annulée : rien n\'a changé.', []], `réponse ${JSON.stringify(input)}`);
    assert.equal(fs.readFileSync(at('app', 'data', 'staff-key'), 'utf8'), 'ancienne\n');
  }
});

// Faux outils du vérificateur : prérequis satisfaits (ports libres, adresse
// externe), « docker run » de caddy hash-password en échec comme une limite de
// Docker Hub. Appels à docker notés dans $FAKE_LOG.
const VERIFIER_TOOLS = {
  docker: [
    '#!/usr/bin/env bash',
    'printf \'%s\\n\' "$*" >> "$FAKE_LOG"',
    'case "$1 ${2:-}" in',
    '  "compose version" | "info "* | "image inspect" | "tag "* | "image rm") exit 0 ;;',
    '  "run "*) echo "docker: toomanyrequests: You have reached your pull rate limit." >&2; exit 125 ;;',
    '  *) exit 99 ;;',
    'esac',
  ],
  curl: ['#!/usr/bin/env bash', 'exit 7'],
  ip: ['#!/usr/bin/env bash', 'echo "192.0.2.1 via 192.0.2.254 dev eth0 src 192.0.2.2 uid 0"'],
};

test('D7 vérificateur : cause d’un échec de préparation visible (faux docker)', { skip: process.platform === 'win32' && 'vérificateur bash (Linux)' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const [name, body] of Object.entries(VERIFIER_TOOLS)) fs.writeFileSync(path.join(bin, name), `${body.join('\n')}\n`, { mode: 0o755 });
  const log = path.join(dir, 'calls.log');
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_LOG: log };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync('bash', [path.join(root, ...VERIFIER.split('/')), 'karafun-plus:essai'], { encoding: 'utf8', env });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.split('\n').includes('ÉCHEC préparation : empreinte de caddy hash-password illisible'), r.stderr);
  // Le journal des commandes est effacé avec le dossier temporaire : sa fin
  // doit être montrée, sinon la cause (ici Docker Hub) est perdue.
  assert.match(r.stderr, /toomanyrequests/, 'cause de l’échec absente de stderr');
  // Étiquette d'essai retirée en dernier.
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const tag = calls.find(c => c.startsWith(`tag karafun-plus:essai ${IMAGE}:essai-`));
  assert.ok(tag, `étiquette d’essai absente : ${calls.join(' ; ')}`);
  assert.equal(calls.at(-1), `image rm ${tag.split(' ').at(-1)}`, 'étiquette d’essai non retirée');
});
