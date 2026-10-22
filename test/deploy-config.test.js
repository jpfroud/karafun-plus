'use strict';
// Image Docker et fichiers du VPS (issue #29), en lecture statique : Dockerfile,
// .dockerignore, deploy/compose.yaml, deploy/Caddyfile, deploy/.env.example,
// scripts de deploy/ et test/verifier-deploiement.sh. Les valeurs attendues
// sont recopiées de la spécification, jamais lues dans les fichiers vérifiés.
// Aucun Docker ici : la construction et le déploiement réels sont vérifiés par
// test/verifier-deploiement.sh (Linux). Les contrôles git (attributs, modes,
// fichiers ignorés) sont sautés sans dépôt.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8');
const manifest = JSON.parse(read('livrable.json').replace(/^﻿/, ''));
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
  // celles du Caddyfile passées à caddy par compose.yaml.
  const compose = read('deploy/compose.yaml');
  const composeVars = [...compose.matchAll(/\$\{([A-Z_]+):\?à renseigner dans deploy\/\.env\}/g)].map(m => m[1]);
  assert.equal([...compose.matchAll(/\$\{/g)].length, composeVars.length, 'variable de compose.yaml sans « :?à renseigner »');
  assert.deepEqual([...new Set(composeVars)].sort(), Object.keys(values).sort(), 'variables de compose.yaml');
  const caddyVars = [...new Set([...read('deploy/Caddyfile').matchAll(/\{\$([A-Z_]+)\}/g)].map(m => m[1]))].sort();
  assert.deepEqual(caddyVars, ['ACME_EMAIL', 'BAR_PASSWORD_HASH', 'BAR_USER', 'HOTE_BAR', 'HOTE_CLIENTS']);
  for (const name of caddyVars) {
    assert.match(compose, new RegExp(`^      ${name}: \\$\\{${name}:\\?`, 'm'), `${name} non passé à caddy`);
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

  for (const [file, status] of [['deploy/.env', 0], ['deploy/sauvegardes/x.tar.gz', 0], ['deploy/.env.example', 1]]) {
    assert.equal(git(['check-ignore', '-q', file]).status, status, `git check-ignore -q ${file}`);
  }
});
