'use strict';
// Chaîne d'approvisionnement et workflows GitHub, en lecture statique (sur le
// modèle du test de parité de RetroGemini) : une régression de ces règles se
// voit dans la suite hors ligne, avant même la CI. Détail et raisons :
// SECURITY.md. Aucun réseau, aucune dépendance : lecture ligne à ligne de
// fichiers YAML écrits avec une indentation de deux espaces.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8').replace(/\r\n/g, '\n');
const WORKFLOWS = fs.readdirSync(path.join(root, '.github', 'workflows')).filter(name => /\.ya?ml$/.test(name)).sort();
const workflow = name => read(`.github/workflows/${name}`);
const indent = line => line.search(/\S/);

// Blocs d'un niveau donné : { key, start, lines } pour chaque clé indentée de `depth`.
function blocks(lines, depth, from = 0, to = lines.length) {
  const found = [];
  for (let i = from; i < to; i++) {
    const match = new RegExp(`^ {${depth}}([\\w-]+):`).exec(lines[i]);
    if (!match) continue;
    let end = i + 1;
    while (end < to && (lines[end].trim() === '' || lines[end].trim().startsWith('#') || indent(lines[end]) > depth)) end++;
    found.push({ key: match[1], start: i, lines: lines.slice(i, end) });
  }
  return found;
}
// Jobs d'un workflow : clés de deux espaces sous « jobs: ».
function jobs(name) {
  const lines = workflow(name).split('\n');
  const start = lines.indexOf('jobs:');
  assert.ok(start >= 0, `${name} : jobs absents`);
  return blocks(lines, 2, start + 1);
}
// Étapes d'un job : chaque « - » de premier niveau sous « steps: ».
function steps(job) {
  const start = job.lines.findIndex(line => /^ {4}steps:\s*$/.test(line));
  if (start < 0) return [];
  const found = [];
  for (let i = start + 1; i < job.lines.length; i++) {
    if (!/^ {6}- /.test(job.lines[i])) continue;
    let end = i + 1;
    while (end < job.lines.length && !/^ {6}- /.test(job.lines[end]) && (job.lines[end].trim() === '' || indent(job.lines[end]) > 6)) end++;
    found.push(job.lines.slice(i, end).join('\n'));
  }
  return found;
}
const usesLines = () => WORKFLOWS.flatMap(name => workflow(name).split('\n')
  .map((line, index) => ({ name, number: index + 1, line }))
  .filter(({ line }) => /^\s*(?:-\s+)?uses:\s*\S/.test(line)));

test('W1 chaque action est épinglée par un SHA complet et sa version', () => {
  const lines = usesLines();
  assert.ok(lines.length > 20, 'lignes uses: trouvées');
  for (const { name, number, line } of lines) {
    if (/uses:\s*\.\//.test(line)) continue;
    assert.match(line, /uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(\.\d+){0,2}\s*$/,
      `${name}:${number} : action non épinglée par SHA avec sa version en commentaire : ${line.trim()}`);
  }
  // Une seule révision pour toute la famille codeql-action (init, analyze, upload-sarif).
  const codeql = new Set(lines.map(({ line }) => /github\/codeql-action\/[\w-]+@([0-9a-f]{40}) # (\S+)/.exec(line))
    .filter(Boolean).map(match => `${match[1]} ${match[2]}`));
  assert.equal(codeql.size, 1, `révisions de codeql-action : ${[...codeql].join(', ')}`);
  // Même SHA, même version annoncée, partout.
  const versions = new Map();
  for (const { line } of lines) {
    const match = /uses:\s*([\w.-]+\/[\w./-]+)@([0-9a-f]{40}) # (\S+)/.exec(line);
    if (!match) continue;
    const seen = versions.get(match[2]);
    assert.ok(!seen || seen === match[3], `SHA ${match[2]} annoncé ${seen} et ${match[3]}`);
    versions.set(match[2], match[3]);
  }
});

test('W2 jetons au moindre droit', () => {
  for (const name of WORKFLOWS) {
    const text = workflow(name);
    const top = /^permissions:(.*)$/m.exec(text);
    assert.ok(top, `${name} : permissions: absentes au niveau du workflow`);
    const value = top[1].trim();
    if (value) {
      assert.ok(['{}', 'read-all'].includes(value), `${name} : permissions du workflow « ${value} »`);
    } else {
      const lines = text.split('\n');
      const start = lines.findIndex(line => line.startsWith('permissions:'));
      for (let i = start + 1; i < lines.length && /^ {2}\S/.test(lines[i]); i++) {
        assert.match(lines[i], /^ {2}[\w-]+: (read|none)$/, `${name} : droit d'écriture au niveau du workflow : ${lines[i].trim()}`);
      }
    }
    assert.doesNotMatch(text, /\bwrite-all\b/, `${name} : write-all`);
  }
  // Droits d'écriture : seulement là où ils servent, même suivis d'un
  // commentaire ; jamais en ligne (« permissions: { … } ») dans un job.
  for (const name of WORKFLOWS) {
    for (const job of jobs(name)) {
      const inline = job.lines.find(line => /^ {4}permissions:/.test(line) && !/^ {4}permissions:\s*(\{\})?\s*(#.*)?$/.test(line));
      assert.ok(!inline, `${name}/${job.key} : permissions en ligne : ${inline}`);
    }
  }
  const writes = WORKFLOWS.flatMap(name => jobs(name).flatMap(job => job.lines
    .filter(line => /^ {6}[\w-]+:\s*write\b/.test(line)).map(line => `${name}/${job.key}/${line.trim().split(':')[0]}`))).sort();
  assert.deepEqual(writes, [
    'codeql.yml/analyze/security-events',
    'dependabot-auto-merge.yml/fusion/contents',
    'dependabot-auto-merge.yml/fusion/pull-requests',
    'release.yml/image/packages',
    'release.yml/publier/attestations',
    'release.yml/publier/contents',
    'release.yml/publier/id-token',
    'release.yml/publier/packages',
    'scorecard.yml/analysis/id-token',
    'scorecard.yml/analysis/security-events',
    'securite.yml/image-publiee/security-events',
    'securite.yml/trivy-depot/security-events',
    'securite.yml/trivy-image/security-events',
    'veille-versions.yml/veille/issues',
  ], 'droits d’écriture des jobs');
});

test('W3 déclencheurs, extraction du code et expressions', () => {
  for (const name of WORKFLOWS) {
    const text = workflow(name);
    assert.doesNotMatch(text, /^\s*workflow_run:/m, `${name} : workflow_run`);
    if (/^\s*pull_request_target:/m.test(text)) {
      // Seule exception : la fusion des correctifs de Dependabot, sans le code de la PR.
      assert.equal(name, 'dependabot-auto-merge.yml', `${name} : pull_request_target`);
      assert.doesNotMatch(text, /actions\/checkout|pull_request\.head\.(?:sha|ref)|github\.head_ref/, `${name} : code de la PR extrait`);
      assert.match(text, /github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'/, `${name} : PR de Dependabot seulement`);
    }
    // Aucune expression ${{ }} dans un script : les valeurs passent par env.
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
      if (!run) return;
      const script = [run[2]];
      if (/^[|>]/.test(run[2])) {
        for (let j = index + 1; j < lines.length && (lines[j].trim() === '' || indent(lines[j]) > run[1].length); j++) script.push(lines[j]);
      }
      assert.ok(!script.join('\n').includes('${{'), `${name}:${index + 1} : expression \${{ }} dans un script run:`);
    });
    // Identifiants git jamais gardés après l'extraction, même pour le tag d'une release.
    for (const job of jobs(name)) {
      for (const step of steps(job).filter(step => /uses:\s*actions\/checkout@/.test(step))) {
        assert.match(step, /persist-credentials:\s*false/, `${name}/${job.key} : checkout sans persist-credentials: false`);
      }
    }
  }
});

test('W3b le tag d’une release est envoyé avec un identifiant limité à son étape', () => {
  const tag = steps(jobs('release.yml').find(job => job.key === 'publier'))
    .find(step => /- name: Creer le tag apres validation/.test(step));
  assert.ok(tag, 'étape du tag absente');
  assert.match(tag, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(tag, /\$env:GIT_CONFIG_KEY_0 = 'http\.https:\/\/github\.com\/\.extraheader'/);
  assert.match(tag, /\$env:GIT_CONFIG_VALUE_0 = "AUTHORIZATION: basic \$basic"/);
  assert.doesNotMatch(read('.github/zizmor.yml'), /artipacked/, 'plus aucune exception artipacked');
});

test('W4 chaque job a un délai maximal', () => {
  for (const name of WORKFLOWS) {
    for (const job of jobs(name)) {
      assert.ok(job.lines.some(line => /^ {4}timeout-minutes: \d+$/.test(line)), `${name}/${job.key} : timeout-minutes absent`);
    }
  }
});

test('W5 publication sans cache et avec provenance', () => {
  const release = workflow('release.yml');
  for (const forbidden of [/^\s+cache:/m, /cache-from:/, /cache-to:/, /actions\/cache@/]) {
    assert.doesNotMatch(release, forbidden, `release.yml : cache ${forbidden}`);
  }
  assert.match(release, /no-cache: true/, 'image publiée construite sans cache de couches');
  // setup-node active seul un cache npm (packageManager de package.json) :
  // jamais dans la publication ni dans un job qui construit l'image.
  for (const name of WORKFLOWS) {
    for (const job of jobs(name)) {
      if (name !== 'release.yml' && !job.lines.some(line => /docker\/build-push-action@/.test(line))) continue;
      for (const step of steps(job).filter(step => /uses:\s*actions\/setup-node@/.test(step))) {
        assert.match(step, /package-manager-cache: false/, `${name}/${job.key} : setup-node sans package-manager-cache: false`);
        assert.doesNotMatch(step, /^\s+cache:/m, `${name}/${job.key} : cache npm`);
      }
    }
  }
  for (const step of ['npm sbom --omit dev --sbom-format cyclonedx', 'org.cyclonedx:cyclonedx-maven-plugin:makeBom',
    'actions/attest-build-provenance@', 'push-to-registry: true', 'KIT-BAR-KARAFUN.zip.sigstore.json']) {
    assert.ok(release.includes(step), `release.yml : ${step}`);
  }
  // RELEASE.md donne le délai pour relancer « publier » : celui des fichiers construits.
  assert.deepEqual([...new Set([...release.matchAll(/retention-days: (\d+)/g)].map(match => match[1]))], ['1']);
  assert.match(read('.github/RELEASE.md'), /relancer le job `publier` dans les 24 heures la refait/);
  // Les extensions Maven lancées en ligne de commande prennent leur version dans le POM.
  const pom = read('solver/pom.xml');
  for (const file of ['Dockerfile', ...WORKFLOWS.map(name => `.github/workflows/${name}`)]) {
    for (const [, plugin] of read(file).matchAll(/((?:org\.codehaus\.mojo|org\.cyclonedx):[\w-]+-maven-plugin)(:\d[\w.-]*)?:[\w-]+/g)) {
      assert.ok(pom.includes(`<artifactId>${plugin.split(':')[1]}</artifactId>`), `${file} : ${plugin} sans version dans solver/pom.xml`);
    }
    assert.doesNotMatch(read(file), /-maven-plugin:\d/, `${file} : version d'extension Maven en ligne de commande`);
  }
  // npm sans scripts d'installation dans la CI et l'image.
  for (const file of ['Dockerfile', ...WORKFLOWS.map(name => `.github/workflows/${name}`)]) {
    for (const [command] of read(file).matchAll(/npm ci[^\n]*/g)) {
      assert.match(command, /--ignore-scripts/, `${file} : ${command}`);
    }
  }
});

test('W6 Dependabot suit chaque écosystème avec un délai', () => {
  const text = read('.github/dependabot.yml');
  const updates = text.split(/\n(?=  - package-ecosystem:)/).slice(1);
  const covered = updates.map(block => {
    const ecosystem = /package-ecosystem: "([\w-]+)"/.exec(block)[1];
    const directory = /directory: "([^"]+)"/.exec(block)[1];
    assert.match(block, /cooldown:\n\s+default-days: \d+/, `${ecosystem} : cooldown absent`);
    assert.match(block, /schedule:\n\s+interval: "(daily|weekly)"/, `${ecosystem} : calendrier`);
    return `${ecosystem} ${directory}`;
  }).sort();
  assert.deepEqual(covered, ['docker /', 'docker-compose /deploy', 'github-actions /', 'maven /solver', 'npm /']);
  // Chaque manifeste du dépôt est suivi.
  for (const manifest of ['package-lock.json', 'solver/pom.xml', 'Dockerfile', 'deploy/compose.yaml']) {
    assert.ok(fs.existsSync(path.join(root, manifest)), manifest);
  }
  assert.match(text, /timefold:\n\s+patterns:\n\s+- "ai\.timefold\.solver:\*"/, 'Timefold dans un groupe à part');
  for (const name of ['socket.io-client', 'socket.io']) {
    assert.match(text, new RegExp(`dependency-name: "${name.replace('.', '\\.')}"\\n\\s+update-types: \\["version-update:semver-major"\\]`),
      `${name} : version majeure ignorée (protocole KaraFun)`);
  }
  // Règle de la dernière LTS : montées écartées, empreintes gardées, un seul Java.
  const docker = updates.find(block => /package-ecosystem: "docker"\n/.test(block));
  for (const name of ['node', 'eclipse-temurin']) {
    assert.match(docker, new RegExp(`dependency-name: "${name}"\\n\\s+update-types: \\["version-update:semver-major"\\]`), `${name} : version majeure écartée`);
  }
  assert.match(docker, /dependency-name: "maven"\n\s+update-types: \["version-update:semver-major", "version-update:semver-minor", "version-update:semver-patch"\]/, 'maven : Java dans l’étiquette, lu comme un correctif');
  const java = /^ {6}java:\n((?: {8}.*\n)+)/m.exec(docker);
  assert.ok(java, 'groupe java absent');
  assert.match(java[1], /patterns:\n\s+- "maven"\n\s+- "eclipse-temurin"/, 'Maven et Temurin ensemble');
  assert.doesNotMatch(java[1], /update-types/, 'une empreinte seule sortirait du groupe');
  // Labels par défaut de Dependabot, qu'il crée lui-même : des labels absents le font se plaindre.
  assert.doesNotMatch(text, /^\s+labels:/m, 'aucun label réglé');
  const merge = workflow('dependabot-auto-merge.yml');
  assert.match(merge, /version-update:semver-patch \| version-update:semver-minor\)/, 'seuls les correctifs mineurs fusionnent seuls');
  assert.match(merge, /\*ai\.timefold\*/, 'Timefold jamais fusionné automatiquement');
  assert.match(merge, /EMPREINTE_SEULE: \$\{\{ steps\.images\.outputs\.seule \}\}/, 'preuve du diff transmise à la décision');
  assert.ok(merge.indexOf('- name: Comparer les images') < merge.indexOf('- name: Décider'), 'la preuve avant la décision');
  assert.match(merge, /if \[ "\$ECOSYSTEM" = github_actions \]; then\n\s+decision=relire/, 'actions GitHub jamais fusionnées automatiquement');
  assert.match(merge, /\*socket\.io\*/, 'Socket.IO jamais fusionné automatiquement');
  for (const pattern of [/\*engine\.io\*/, /\*,ws,\*/, /\*,xmlhttprequest-ssl,\*/]) {
    assert.match(merge, pattern, `pile du protocole KaraFun jamais fusionnée automatiquement : ${pattern}`);
  }
  assert.match(merge, /required_status_checks/, 'fusion seulement derrière des contrôles exigés');
  assert.match(merge, /for controle in 'Tests OK' 'Sécurité OK'; do/, 'fusion seulement si Tests OK et Sécurité OK sont exigés');
  assert.match(merge, /gh pr merge --auto --merge "\$PR_URL"/);
  // Chaque commit, pas seulement le premier lu par fetch-metadata.
  assert.match(merge, /pulls\/\$NUMBER\/commits" --paginate/, 'chaque commit de la PR vérifié');
  assert.match(merge, /\.author\.login != "dependabot\[bot\]" or \.committer\.login != "web-flow" or \.commit\.verification\.verified != true/,
    'commit créé et signé par GitHub pour Dependabot');
  assert.match(merge, /gh pr merge --disable-auto "\$PR_URL"/, 'fusion retirée après un commit d’un autre auteur');
  assert.match(merge, /etat=\$\(gh pr view "\$PR_URL" --json autoMergeRequest/, 'erreur de l’API visible avant le retrait');
  // Une PR non fusionnée automatiquement dit toujours pourquoi, contrôles exigés manquants compris.
  assert.match(merge, /- name: Expliquer la relecture nécessaire\n\s+if: github\.event\.action == 'opened' && !\(steps\.decision\.outputs\.decision == 'fusion' && steps\.protection\.outputs\.protegee == 'oui'\)/);
  assert.match(merge, /if: always\(\) && !\(steps\.decision\.outputs\.decision == 'fusion' && steps\.protection\.outputs\.protegee == 'oui'\)/,
    'fusion retirée dès que les règles ne la permettent plus, même après un échec');
  assert.match(merge, /types: \[opened, synchronize, reopened\]/, 'revérifiée à chaque nouveau commit');
});

// Script « run: | » d'une étape nommée, sans son indentation.
function stepScript(name, title) {
  for (const job of jobs(name)) {
    const step = steps(job).find(text => text.split('\n')[0].trim() === `- name: ${title}`);
    if (!step) continue;
    const lines = step.split('\n');
    const start = lines.findIndex(line => /^ {8}run: \|$/.test(line));
    assert.ok(start >= 0, `${name} : « ${title} » sans bloc run: |`);
    return lines.slice(start + 1).map(line => line.slice(10)).join('\n');
  }
  throw new Error(`${name} : étape « ${title} » absente`);
}
const bash = process.platform !== 'win32' && spawnSync('bash', ['-c', 'true']).status === 0;
// Sorties « clé=valeur » d'une étape (fichier GITHUB_OUTPUT).
const outputs = file => Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(line => line.includes('='))
  .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
// L'étape « Décider » exécutée avec ces variables (vides si absentes) : ses sorties.
function decide(env) {
  const script = stepScript('dependabot-auto-merge.yml', 'Décider');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'decider-'));
  try {
    const output = path.join(directory, 'output');
    const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { encoding: 'utf8', env: {
      PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
      UPDATE_TYPE: '', DEPENDENCIES: '', ECOSYSTEM: '', PREVIOUS: '', NEW: '', COMMITS: '', ...env } });
    assert.equal(run.status, 0, run.stderr);
    return outputs(output);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('W6b la décision de fusion de Dependabot, exécutée', { skip: bash ? false : 'bash absent' }, () => {
  const ok = { UPDATE_TYPE: 'version-update:semver-patch', ECOSYSTEM: 'npm_and_yarn', DEPENDENCIES: 'qrcode', COMMITS: 'oui' };
  assert.equal(decide(ok).decision, 'fusion');
  assert.equal(decide({ ...ok, UPDATE_TYPE: 'version-update:semver-minor' }).decision, 'fusion');
  assert.equal(decide({ ...ok, DEPENDENCIES: 'ws-wrapper, aws-sdk' }).decision, 'fusion', 'ws seul, jamais ws-wrapper');
  for (const change of [{ COMMITS: 'non' }, { COMMITS: '' }, { UPDATE_TYPE: 'version-update:semver-major' }, { UPDATE_TYPE: '' },
    { DEPENDENCIES: 'ws, qrcode' }, { DEPENDENCIES: 'engine.io-client' }, { DEPENDENCIES: 'socket.io-client' },
    { DEPENDENCIES: 'xmlhttprequest-ssl' }, { ECOSYSTEM: 'github_actions' }]) {
    assert.equal(decide({ ...ok, ...change }).decision, 'relire', JSON.stringify(change));
  }
  assert.equal(decide({ ...ok, DEPENDENCIES: 'ai.timefold.solver:timefold-solver-core' }).decision, 'timefold');
  assert.equal(decide({ ...ok, DEPENDENCIES: 'ai.timefold.solver:timefold-solver-core', COMMITS: 'non' }).decision, 'relire');
  for (const dependency of ['com.fasterxml.jackson.core:jackson-databind', 'org.slf4j:slf4j-simple', 'org.apache.maven.plugins:maven-shade-plugin']) {
    assert.equal(decide({ ...ok, ECOSYSTEM: 'maven', DEPENDENCIES: dependency }).decision, 'timefold', `${dependency} : l’optimiseur, bilan exigé`);
  }
  assert.equal(decide({ ...ok, ECOSYSTEM: 'maven', DEPENDENCIES: 'org.slf4j:slf4j-simple', COMMITS: 'non' }).decision, 'relire');
  // Dockerfile : seule la preuve du diff (étape « Comparer les images ») laisse fusionner seul.
  const docker = { ECOSYSTEM: 'docker', DEPENDENCIES: 'node', COMMITS: 'oui' };
  // Formes réelles d'une empreinte seule, relevées sur des PR publiques le 6 novembre 2026 :
  // « from `abc` to `def` », sans ancienne étiquette ; un type calculé majeur dans un groupe.
  for (const cas of [{ PREVIOUS: '', NEW: '26-trixie-slim' }, { DEPENDENCIES: 'maven, eclipse-temurin', UPDATE_TYPE: 'version-update:semver-major', PREVIOUS: '`047a82f`', NEW: '3.10-eclipse-temurin-25' }]) {
    const { decision, raison } = decide({ ...docker, ...cas, EMPREINTE_SEULE: 'oui' });
    assert.equal(decision, 'fusion', JSON.stringify(cas));
    assert.match(raison, /nouvelle empreinte/);
  }
  // Sans cette preuve, jamais de fusion seule, même classée en correctif (#48, 3.9-eclipse-temurin-26
  // lu comme 3.9.26) ou avec la même étiquette annoncée dans le message.
  const correctif = { ...ok, ECOSYSTEM: 'docker' };
  for (const cas of [{ ...correctif, UPDATE_TYPE: 'version-update:semver-minor', DEPENDENCIES: 'maven', PREVIOUS: '3.9-eclipse-temurin-21', NEW: '3.9-eclipse-temurin-26' },
    { ...correctif, DEPENDENCIES: 'eclipse-temurin, maven', PREVIOUS: '25-jdk', NEW: '27-jdk' },
    { ...correctif, DEPENDENCIES: 'node', PREVIOUS: '26-trixie-slim', NEW: '27-trixie-slim' },
    { ...correctif, DEPENDENCIES: 'node', PREVIOUS: '', NEW: '' },
    { ...correctif, DEPENDENCIES: 'mirror.gcr.io/library/maven', PREVIOUS: '3.10-eclipse-temurin-25', NEW: '3.10-eclipse-temurin-26' },
    { ...correctif, DEPENDENCIES: 'une-autre-image', PREVIOUS: '1.0.0', NEW: '1.0.1' },
    { ...docker, PREVIOUS: '26-trixie-slim', NEW: '26-trixie-slim' }]) {
    for (const EMPREINTE_SEULE of ['', 'non']) {
      const { decision, raison } = decide({ ...cas, EMPREINTE_SEULE });
      assert.equal(decision, 'relire', JSON.stringify({ ...cas, EMPREINTE_SEULE }));
      assert.match(raison, /dernière LTS/);
    }
  }
  assert.equal(decide({ ...docker, EMPREINTE_SEULE: 'oui', COMMITS: 'non' }).decision, 'relire', 'la preuve ne couvre pas un commit d’un autre auteur');
  assert.equal(decide({ ...docker, EMPREINTE_SEULE: 'oui', DEPENDENCIES: 'node, socket.io' }).decision, 'relire', 'ni la pile Socket.IO');
  // Caddy (compose.yaml) ne passe pas par cette preuve : ses règles ne changent pas. Une nouvelle
  // empreinte y porte la version des deux côtés, « from 2.11.7 to 2.11.7 » (vraies PR publiques, novembre 2026).
  assert.equal(decide({ ...correctif, ECOSYSTEM: 'docker_compose', DEPENDENCIES: 'caddy', PREVIOUS: '2.11.8', NEW: '2.11.9' }).decision, 'fusion', 'Caddy : correctif ordinaire');
  assert.equal(decide({ ECOSYSTEM: 'docker_compose', DEPENDENCIES: 'caddy', COMMITS: 'oui', PREVIOUS: '2.11.8', NEW: '2.11.8' }).decision, 'fusion', 'Caddy : nouvelle empreinte, même version lue');
  assert.equal(decide({ ECOSYSTEM: 'docker_compose', DEPENDENCIES: 'caddy', COMMITS: 'oui', PREVIOUS: '', NEW: '2.11.8', EMPREINTE_SEULE: 'oui' }).decision, 'relire', 'Caddy : version illisible, à relire');
  assert.match(decide({ ...ok, COMMITS: 'non' }).raison, /autre auteur/);
});

const jq = bash && spawnSync('jq', ['--version']).status === 0;

test('W6c la fusion automatique n’est activée que si main exige « Tests OK » et « Sécurité OK »', { skip: jq ? false : 'bash ou jq absent' }, () => {
  const script = stepScript('dependabot-auto-merge.yml', 'Vérifier que la branche exige la CI');
  // gh api <chemin> --jq <filtre> : réponse simulée de l'API, filtrée par jq comme le fait gh.
  const fakeGh = [
    '#!/usr/bin/env bash',
    '[ "$1" = api ] && [ "$3" = --jq ] || exit 2',
    'case "$2" in */rules/branches/*) corps=$FAUX_REGLES ;; */branches/*) corps=$FAUX_BRANCHE ;; *) exit 2 ;; esac',
    '[ "$corps" = 404 ] && { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }',
    'printf "%s" "$corps" | jq -r "$4"',
  ].join('\n') + '\n';
  const protection = (contexts, checks = []) => JSON.stringify({ name: 'main', protected: contexts.length + checks.length > 0,
    protection: { required_status_checks: { contexts, checks: checks.map(context => ({ context, app_id: 15368 })) } } });
  const rules = contexts => JSON.stringify([{ type: 'deletion' },
    ...(contexts.length ? [{ type: 'required_status_checks', parameters: { required_status_checks: contexts.map(context => ({ context })) } }] : [])]);
  const protegee = (branche, regles) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'protection-'));
    try {
      fs.writeFileSync(path.join(directory, 'gh'), fakeGh, { mode: 0o755 });
      const output = path.join(directory, 'output');
      const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { encoding: 'utf8', env: {
        PATH: `${directory}${path.delimiter}${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(directory, 'summary'),
        GITHUB_REPOSITORY: 'proprietaire/depot', BASE: 'main', FAUX_BRANCHE: branche, FAUX_REGLES: regles } });
      assert.equal(run.status, 0, run.stderr);
      return fs.readFileSync(output, 'utf8').trim();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  };
  assert.equal(protegee(protection(['Tests OK', 'Sécurité OK']), rules([])), 'protegee=oui');
  assert.equal(protegee(protection([], ['Tests OK', 'Sécurité OK']), '404'), 'protegee=oui', 'contrôles liés à une application');
  assert.equal(protegee(protection([]), rules(['Sécurité OK', 'Tests OK'])), 'protegee=oui', 'ensemble de règles');
  assert.equal(protegee(protection(['Tests OK']), rules(['Sécurité OK'])), 'protegee=oui', 'protection et règles réunies');
  for (const [branche, regles, cas] of [[protection(['Tests OK']), rules([]), 'sans « Sécurité OK »'],
    [protection([]), rules(['Sécurité OK']), 'sans « Tests OK »'], ['404', '404', 'aucune protection lisible'],
    [protection(['Tests OK', 'Sécurité OK (pull_request)']), rules([]), 'nom voisin'], [protection([]), rules([]), 'branche non protégée']]) {
    assert.equal(protegee(branche, regles), 'protegee=non', cas);
  }
});

test('W6f seule une nouvelle empreinte dans le Dockerfile compte comme preuve, exécuté', { skip: jq ? false : 'bash ou jq absent' }, () => {
  const script = stepScript('dependabot-auto-merge.yml', 'Comparer les images');
  // gh api <chemin> --paginate --jq <filtre> : fichiers simulés de la PR 7, filtrés par jq
  // comme le fait gh. Un autre chemin ou d'autres options : refus, donc aucune preuve.
  const fakeGh = [
    '#!/usr/bin/env bash',
    '[ "$#" = 5 ] && [ "$1" = api ] && [ "$2" = repos/proprietaire/depot/pulls/7/files ] && [ "$3" = --paginate ] && [ "$4" = --jq ] || exit 2',
    '[ "$FAUX_FICHIERS" = panne ] && { echo "gh: Server Error (HTTP 500)" >&2; exit 1; }',
    // « brut:… » : sortie rendue telle quelle, sans jq, pour une réponse que l'étape ne sait pas lire.
    '[ "${FAUX_FICHIERS#brut:}" != "$FAUX_FICHIERS" ] && { printf "%s\\n" "${FAUX_FICHIERS#brut:}"; exit 0; }',
    'printf "%s" "$FAUX_FICHIERS" | jq -r "$5"',
  ].join('\n') + '\n';
  // Sorties de l'étape, et si elle a publié un ::warning::.
  const comparer = (fichiers, env = {}) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'images-'));
    try {
      fs.writeFileSync(path.join(directory, 'gh'), fakeGh, { mode: 0o755 });
      const output = path.join(directory, 'output');
      const run = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script], { encoding: 'utf8', env: {
        PATH: `${directory}${path.delimiter}${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'proprietaire/depot', NUMBER: '7',
        FAUX_FICHIERS: typeof fichiers === 'string' ? fichiers : JSON.stringify(fichiers), ...env } });
      assert.equal(run.status, 0, run.stderr);
      return { ...outputs(output), avertissement: /^::warning::/m.test(run.stdout) };
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  };
  // Diff lu : « oui » ou « non », sans cause ni avertissement.
  const seule = fichiers => {
    const { seule: verdict, ...reste } = comparer(fichiers);
    assert.deepEqual(reste, { avertissement: false }, `diff lu, rien d’autre attendu que seule=${verdict}`);
    return verdict;
  };
  const a = `@sha256:${'a'.repeat(64)}`, b = `@sha256:${'b'.repeat(64)}`;
  // Patch tel que l'API le rend : des blocs @@ avec leurs lignes de contexte, que l'étape doit
  // ignorer ; les lignes écrites à la main reçoivent un bloc et une ligne de contexte.
  const fichier = (lignes, plus = {}) => ({ filename: 'Dockerfile', status: 'modified',
    patch: (lignes[0]?.startsWith('@@') ? lignes : ['@@ -1,4 +1,4 @@', ' # contexte', ...lignes]).join('\n'), ...plus });
  // Les vraies lignes FROM du Dockerfile avec une nouvelle empreinte, comme Dependabot
  // les propose : un bloc par ligne changée, avec ses trois voisines de chaque côté.
  const dockerfile = read('Dockerfile').split('\n');
  const FROM = dockerfile.map((ligne, index) => ({ ligne, numero: index + 1 })).filter(({ ligne }) => /^FROM /.test(ligne));
  const empreinte = /@sha256:[0-9a-f]{64}(?![0-9a-f])/;
  const neuve = ligne => ligne.replace(empreinte, b);
  for (const { ligne } of FROM) assert.ok(empreinte.test(ligne) && neuve(ligne) !== ligne, `ligne FROM sans empreinte à changer : ${ligne}`);
  const image = nom => FROM.filter(({ ligne }) => new RegExp(`^FROM (?:--platform=\\S+ )?${nom}:`).test(ligne));
  const contexte = (debut, fin) => dockerfile.slice(Math.max(0, debut), fin).map(ligne => ` ${ligne}`);
  const bloc = ({ ligne, numero }) => {
    const avant = contexte(numero - 4, numero - 1), apres = contexte(numero, numero + 3);
    const debut = numero - avant.length, taille = avant.length + 1 + apres.length;
    return [`@@ -${debut},${taille} +${debut},${taille} @@`, ...avant, `-${ligne}`, `+${neuve(ligne)}`, ...apres];
  };
  const blocs = froms => froms.flatMap(from => bloc(from));
  assert.ok(image('node').length && image('maven').length && image('eclipse-temurin').length, 'Node, Maven et Temurin dans le Dockerfile');
  const node = blocs(image('node')), java = blocs([...image('maven'), ...image('eclipse-temurin')]);
  for (const [cas, lignes] of [['Node, toutes ses lignes', node], ['groupe java, Maven et Temurin', java], ['toutes les images', blocs(FROM)],
    ...FROM.map(from => [`une seule ligne : ${from.ligne}`, bloc(from)])]) {
    assert.equal(seule([fichier(lignes)]), 'oui', cas);
  }
  // Le faux gh contrôle le chemin : la même réponse demandée pour une autre PR ne prouve rien.
  assert.equal(comparer([fichier(node)], { NUMBER: '8' }).seule, 'inconnu', 'chemin de l’API d’une autre PR');
  for (const [cas, fichiers] of Object.entries({
    'autre étiquette de Node': [fichier([`-FROM node:26-trixie-slim${a}`, `+FROM node:27-trixie-slim${b}`])],
    'autre Java dans l’étiquette de Maven, seconde image du groupe': [fichier([`-FROM eclipse-temurin:25-jdk${a} AS jre`, `+FROM eclipse-temurin:25-jdk${b} AS jre`,
      `-FROM maven:3.10-eclipse-temurin-25${a} AS s`, `+FROM maven:3.10-eclipse-temurin-27${b} AS s`])],
    'autre image': [fichier([`-FROM node:26-trixie-slim${a}`, `+FROM exemple/node:26-trixie-slim${b}`])],
    'empreinte retirée': [fichier([`-FROM node:26-trixie-slim${a}`, '+FROM node:26-trixie-slim'])],
    'empreinte courte': [fichier([`-FROM node:26-trixie-slim${a}`, '+FROM node:26-trixie-slim@sha256:abc'])],
    'étape renommée': [fichier([`-FROM node:26-trixie-slim${a} AS deps`, `+FROM node:26-trixie-slim${b} AS autre`])],
    'plateforme changée': [fichier([`-FROM node:26-trixie-slim${a}`, `+FROM --platform=linux/386 node:26-trixie-slim${b}`])],
    'lignes échangées': [fichier([`-FROM node:26-trixie-slim${a}`, `-FROM eclipse-temurin:25-jdk${a} AS jre`, `+FROM eclipse-temurin:25-jdk${b} AS jre`, `+FROM node:26-trixie-slim${b}`])],
    'ligne ajoutée': [fichier([...node, '+RUN echo ajout'])],
    'ligne retirée': [fichier([...node, '-USER node'])],
    'une autre instruction avec une empreinte': [fichier([`-RUN installe${a}`, `+RUN installe${b}`])],
    'FROM sans étiquette': [fichier([`-FROM node${a}`, `+FROM node${b}`])],
    'autre fichier en plus': [fichier(node), fichier(['-a', '+b'], { filename: 'package.json' })],
    'autre fichier en plus, sans diff (binaire)': [fichier(node), { filename: 'docs/plan.png', status: 'added' }],
    'autre fichier seul': [fichier(node, { filename: 'autre/Dockerfile' })],
    'Dockerfile renommé': [fichier(node, { status: 'renamed' })],
    'Dockerfile créé': [fichier(node, { status: 'added' })],
  })) assert.equal(seule(fichiers), 'non', cas);
  // Diff non lu : la vraie cause et un avertissement, jamais de fusion seule, même
  // classée en correctif, ni la raison d'un diff lu dans le commentaire de la PR.
  assert.match(workflow('dependabot-auto-merge.yml'), /CAUSE_DIFF: \$\{\{ steps\.images\.outputs\.cause \}\}/, 'cause transmise à « Décider »');
  for (const [cas, fichiers, motif] of [['API en panne', 'panne', /API GitHub en échec/], ['aucun fichier', [], /aucun fichier/],
    ['réponse que jq ne lit pas', 'brut:{"filename": tronqué', /illisible par jq/],
    ['diff absent, trop grand', [{ filename: 'Dockerfile', status: 'modified' }], /diff du Dockerfile absent/]]) {
    const sortie = comparer(fichiers);
    assert.equal(sortie.seule, 'inconnu', cas);
    assert.match(sortie.cause, motif, cas);
    assert.ok(sortie.avertissement, `${cas} : ::warning:: absent`);
    const { decision, raison } = decide({ UPDATE_TYPE: 'version-update:semver-patch', ECOSYSTEM: 'docker', DEPENDENCIES: 'node', COMMITS: 'oui',
      EMPREINTE_SEULE: sortie.seule, CAUSE_DIFF: sortie.cause });
    assert.equal(decision, 'relire', cas);
    assert.ok(raison.includes(sortie.cause), `${cas} : ${raison}`);
    assert.doesNotMatch(raison, /non limité|dernière LTS/, `${cas} : raison d’un diff lu`);
  }
});

test('W6d le commentaire d’une PR de Dependabot non fusionnée, exécuté', { skip: bash ? false : 'bash absent' }, () => {
  const script = stepScript('dependabot-auto-merge.yml', 'Expliquer la relecture nécessaire');
  const comment = (DECISION, RAISON = '') => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'commentaire-'));
    try {
      // gh pr comment <url> --body <texte> : le texte est gardé tel quel.
      fs.writeFileSync(path.join(directory, 'gh'), '#!/usr/bin/env bash\nprintf "%s" "$5" > "$SORTIE"\n', { mode: 0o755 });
      const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { encoding: 'utf8', env: {
        PATH: `${directory}${path.delimiter}${process.env.PATH}`, SORTIE: path.join(directory, 'corps'),
        PR_URL: 'https://github.com/proprietaire/depot/pull/1', DECISION, RAISON } });
      assert.equal(run.status, 0, run.stderr);
      return fs.readFileSync(path.join(directory, 'corps'), 'utf8');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  };
  assert.match(comment('fusion'), /^\*\*Fusion automatique non activée\*\* : `main` n'exige pas les contrôles « Tests OK » et « Sécurité OK »/);
  assert.match(comment('timefold'), /optimiseur \(`solver\/`\).*« Bilan Timefold »/);
  assert.match(comment('relire', 'version majeure'), /^\*\*Fusion automatique désactivée\*\* \(version majeure\)\. .*télécommande KaraFun\.$/);
});

test('W6e seuls les commits que GitHub a signés pour Dependabot laissent la fusion automatique, exécuté', { skip: jq ? false : 'bash ou jq absent' }, () => {
  const script = stepScript('dependabot-auto-merge.yml', 'Vérifier chaque commit de la PR');
  // gh api <chemin> --paginate --jq <filtre> : commits simulés, filtrés par jq comme le fait gh.
  const fakeGh = [
    '#!/usr/bin/env bash',
    '[ "$1" = api ] && [ "$2" = repos/proprietaire/depot/pulls/7/commits ] && [ "$3" = --paginate ] && [ "$4" = --jq ] || exit 2',
    'printf "%s" "$FAUX_COMMITS" | jq -r "$5"',
  ].join('\n') + '\n';
  // Comme l'API les rend : un commit de Dependabot a pour committer « GitHub
  // <noreply@github.com> » (compte web-flow) et la signature de GitHub.
  const commit = (sha, author, committer, verified) => ({ sha, author: author && { login: author },
    committer: committer && { login: committer }, commit: { verification: { verified, reason: verified ? 'valid' : 'unsigned' } } });
  const dependabot = commit('a1', 'dependabot[bot]', 'web-flow', true);
  const verdict = commits => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'commits-'));
    try {
      fs.writeFileSync(path.join(directory, 'gh'), fakeGh, { mode: 0o755 });
      const output = path.join(directory, 'output');
      const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], { encoding: 'utf8', env: {
        PATH: `${directory}${path.delimiter}${process.env.PATH}`, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'proprietaire/depot',
        NUMBER: '7', FAUX_COMMITS: JSON.stringify(commits) } });
      assert.equal(run.status, 0, run.stderr);
      return fs.readFileSync(output, 'utf8').trim();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  };
  assert.equal(verdict([dependabot]), 'dependabot=oui');
  assert.equal(verdict([dependabot, commit('b2', 'dependabot[bot]', 'web-flow', true)]), 'dependabot=oui', 'rebase par Dependabot');
  for (const [other, cas] of [[commit('c3', 'dependabot[bot]', 'mainteneur', true), 'auteur Dependabot, signé par un autre compte'],
    [commit('d4', 'mainteneur', 'web-flow', true), '« Update branch » ou modification dans l’interface web'],
    [commit('e5', 'dependabot[bot]', 'web-flow', false), 'non signé'],
    [commit('f6', null, null, true), 'auteur et committer inconnus de GitHub']]) {
    assert.equal(verdict([dependabot, other]), 'dependabot=non', cas);
  }
});

const perl = bash && spawnSync('perl', ['-v']).status === 0;

const python = process.platform === 'win32' ? 'python' : 'python3';
const pythonPresent = spawnSync(python, ['--version']).status === 0;

test('W5b les notes d’une release donnent l’image, son empreinte et ses versions de Node et de Java, exécuté', { skip: perl ? false : 'bash ou perl absent' }, async t => {
  // Versions lues avant le tag (rien n'est publié sans elles), écrites dans le bloc que lit l'agent du VPS.
  const etapes = steps(jobs('release.yml').find(job => job.key === 'publier'));
  const publier = etapes.map(step => step.split('\n')[0].trim());
  const lecture = publier.indexOf('- name: Lire les versions de Node et de Java');
  assert.ok(lecture >= 0 && lecture < publier.indexOf('- name: Creer le tag apres validation, si publication manuelle'), 'versions lues avant le tag');
  // Elles passent aux notes par la sortie de cette étape : un nom changé publierait une ligne vide.
  const id = (/^ {8}id: (\S+)$/m.exec(etapes[lecture]) || [])[1];
  assert.ok(id, '« Lire les versions » sans id');
  assert.ok(workflow('release.yml').includes(`VERSIONS: \${{ steps.${id}.outputs.versions }}`), 'versions transmises aux notes');
  // Étape exécutée dans un RUNNER_TEMP neuf, qui sert aussi de copie du dépôt : son Dockerfile
  // (celui du dépôt, sauf autre texte), fichiers de versions et faux programmes (gh, docker) éventuels.
  const executer = (titre, { env = {}, fichiers = {}, faux = {}, dockerfile = read('Dockerfile') } = {}) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
    try {
      const dossier = path.join(directory, 'versions');
      fs.mkdirSync(dossier);
      fs.writeFileSync(path.join(directory, 'Dockerfile'), dockerfile);
      for (const [plateforme, contenu] of Object.entries(fichiers)) fs.writeFileSync(path.join(dossier, plateforme), contenu);
      for (const [programme, script] of Object.entries(faux)) fs.writeFileSync(path.join(directory, programme), script, { mode: 0o755 });
      const output = path.join(directory, 'output');
      const notes = path.join(directory, 'notes-publiees.md');
      fs.writeFileSync(output, '');
      const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stepScript('release.yml', titre)], { cwd: directory, encoding: 'utf8', env: {
        ...env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: directory, GITHUB_OUTPUT: output, SORTIE: notes } });
      return { status: run.status, stderr: run.stderr, stdout: run.stdout, sorties: outputs(output), notes: fs.existsSync(notes) ? fs.readFileSync(notes, 'utf8') : '',
        versions: Object.fromEntries(fs.readdirSync(dossier).map(nom => [nom, fs.readFileSync(path.join(dossier, nom), 'utf8')])) };
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  };
  // Versions majeures des étiquettes du Dockerfile (node:<n>-…, eclipse-temurin:<n>-…) : les
  // versions des images simulées suivent la LTS en service.
  const majeure = image => {
    const trouvees = new Set([...read('Dockerfile').matchAll(new RegExp(`^FROM (?:--platform=\\S+ )?${image}:(\\d+)-`, 'gm'))].map(match => Number(match[1])));
    assert.equal(trouvees.size, 1, `version majeure de ${image} dans le Dockerfile : ${[...trouvees].join(', ') || 'aucune'}`);
    return [...trouvees][0];
  };
  const n = majeure('node'), j = majeure('eclipse-temurin');
  // Job image : versions lues dans l'image vérifiée. Faux docker : les vraies sorties de node et de Temurin.
  const docker = ['#!/usr/bin/env bash', 'case "$*" in',
    '  "run --rm karafun-plus:verif node --version") printf "%s\\n" "$FAUX_NODE" ;;',
    '  "run --rm karafun-plus:verif /app/solver-runtime/bin/java --version") printf "%s\\n" "$FAUX_JAVA" ;;',
    '  *) exit 2 ;;', 'esac'].join('\n') + '\n';
  const temurin = version => [`openjdk ${version} 2026-10-20 LTS`, `OpenJDK Runtime Environment Temurin-${version}+8 (build ${version}+8-LTS)`,
    `OpenJDK 64-Bit Server VM Temurin-${version}+8 (build ${version}+8-LTS, mixed mode)`].join('\n');
  const noter = (node, java, dockerfile) => executer('Noter les versions de Node et de Java', { faux: { docker }, dockerfile,
    env: { SUFFIXE: 'arm64', FAUX_NODE: node, FAUX_JAVA: java } });
  const note = noter(`v${n}.13.0`, temurin(`${j}.0.5`));
  assert.equal(note.status, 0, note.stderr);
  assert.deepEqual(note.versions, { arm64: `v${n}.13.0 ${j}.0.5+8-LTS\n` });
  // Première version d'une LTS : Java l'écrit sans « .0.0 ».
  const premiere = noter(`v${n}.0.0`, temurin(`${j}`));
  assert.equal(premiere.status, 0, premiere.stderr);
  assert.deepEqual(premiere.versions, { arm64: `v${n}.0.0 ${j}+8-LTS\n` });
  // Versions illisibles, ou dont la version majeure n'est pas celle du Dockerfile : rien n'est noté.
  const dockerfile = read('Dockerfile');
  const deuxNode = dockerfile.replace(/^(FROM node:)(\d+)-/m, (_, debut, version) => `${debut}${Number(version) + 2}-`);
  assert.notEqual(deuxNode, dockerfile, 'image finale node:<n>- dans le Dockerfile');
  for (const [cas, node, java, autre] of [['Java sans sa ligne « (build …) »', `v${n}.13.0`, temurin(`${j}.0.5`).split('\n')[0]],
    ['Node sans « v »', `${n}.13.0`, temurin(`${j}.0.5`)], ['Java muet', `v${n}.13.0`, ''],
    ['autre Node majeur', `v${n + 2}.0.0`, temurin(`${j}.0.5`)],
    ['Node voisin', `v${n}0.1.0`, temurin(`${j}.0.5`)], ['autre Java majeur', `v${n}.13.0`, temurin(`${j + 1}.0.1`)],
    ['Java voisin', `v${n}.13.0`, temurin(`${j}0.0.1`)],
    ['deux versions de Node dans le Dockerfile', `v${n}.13.0`, temurin(`${j}.0.5`), deuxNode],
    ['Dockerfile sans Temurin', `v${n}.13.0`, temurin(`${j}.0.5`), dockerfile.replace(/^FROM eclipse-temurin:.*\n/m, '')]]) {
    const refus = noter(node, java, autre);
    assert.equal(refus.status, 1, `${cas} : ${refus.stderr}`);
    assert.deepEqual(refus.versions, {}, `${cas} : aucun fichier de versions`);
  }
  const versions = fichiers => executer('Lire les versions de Node et de Java', { fichiers });
  const memes = versions({ amd64: note.versions.arm64, arm64: note.versions.arm64 });
  assert.equal(memes.status, 0, memes.stderr);
  const dansImage = `Node.js \`v${n}.13.0\`, Java \`${j}.0.5+8-LTS\``;
  assert.equal(memes.sorties.versions, dansImage);
  assert.doesNotMatch(memes.stdout, /::warning::/);
  const differentes = versions({ amd64: note.versions.arm64, arm64: `v${n}.12.0 ${j}.0.5+8-LTS\n` });
  assert.equal(differentes.sorties.versions, `${dansImage} (linux/amd64) ; Node.js \`v${n}.12.0\`, Java \`${j}.0.5+8-LTS\` (linux/arm64)`);
  assert.match(differentes.stdout, /^::warning::/m);
  for (const fausses of [{ amd64: note.versions.arm64 }, { amd64: note.versions.arm64, arm64: `v${n}.13.0\n` },
    { amd64: `v${n}.13.0 \`${j}\`\n`, arm64: note.versions.arm64 }, { amd64: `v${n}.13.0 ${j}.0.5+8-LTS en trop\n`, arm64: note.versions.arm64 }]) {
    assert.equal(versions(fausses).status, 1, `versions refusées : ${JSON.stringify(fausses)}`);
  }
  // gh release view <tag> --json body --jq .body : notes actuelles ; gh release edit <tag> --notes-file <f> : notes publiées.
  const gh = ['#!/usr/bin/env bash', 'case "$*" in',
    '  "release view $RELEASE_TAG --json body --jq .body") printf "%s\\n" "$FAUSSES_NOTES" ;;',
    '  "release edit $RELEASE_TAG --notes-file "*) cp "$5" "$SORTIE" ;;',
    '  *) exit 2 ;;', 'esac'].join('\n') + '\n';
  const image = 'ghcr.io/jpfroud/karafun-plus', empreinte = 'c'.repeat(64);
  const generees = '## What’s Changed\n* docker(deps): bump node from `5adad64` to `1b2c3d4`';
  const ancien = `<!-- image-docker -->\n- Empreinte : \`${image}@sha256:${'d'.repeat(64)}\`\n<!-- /image-docker -->\n\n`;
  const publiees = [];
  for (const avant of [generees, ancien + generees]) {
    const { status, stderr, notes } = executer('Ajouter l\'image aux notes de la release', { faux: { gh }, env: { RELEASE_TAG: 'v9.9.9',
      EMPREINTE: `sha256:${empreinte}`, VERSIONS: memes.sorties.versions, FAUSSES_NOTES: avant } });
    assert.equal(status, 0, stderr);
    // Mêmes contrôles que release_info() de deploy/update-agent.py.
    const blocs = [...notes.matchAll(/<!-- image-docker -->([\s\S]*?)<!-- \/image-docker -->/g)].map(match => match[1]);
    assert.equal(blocs.length, 1, 'un seul bloc de l’image');
    assert.ok(blocs[0].includes(`${image}:v9.9.9`), 'étiquette de la version');
    assert.deepEqual([...blocs[0].matchAll(/ghcr\.io\/jpfroud\/karafun-plus@(sha256:[0-9a-f]{64})(?![0-9a-f])/g)].map(match => match[1]), [`sha256:${empreinte}`]);
    assert.ok(blocs[0].includes(`- Dans l'image : ${dansImage}\n`), blocs[0]);
    assert.ok(notes.endsWith(`${generees}\n`), 'notes générées gardées après le bloc');
    publiees.push(notes);
  }
  // Les mêmes notes lues par le vrai release_info() de l'agent du VPS.
  await t.test('lues par release_info() de deploy/update-agent.py', { skip: pythonPresent ? false : `${python} absent` }, () => {
    const lecteur = 'import importlib.util, json, sys\n'
      + 'spec = importlib.util.spec_from_file_location("agent", "deploy/update-agent.py")\n'
      + 'agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)\n'
      + 'assets = [{"name": nom, "size": 1} for nom in ("KIT-BAR-KARAFUN.zip", "KIT-BAR-KARAFUN.zip.sha256")]\n'
      + 'print(json.dumps(agent.release_info({"tag_name": "v9.9.9", "draft": False, "prerelease": False, "body": sys.stdin.read(), "assets": assets})))\n';
    for (const notes of publiees) {
      const lu = spawnSync(python, ['-c', lecteur], { cwd: root, input: notes, encoding: 'utf8' });
      assert.equal(lu.status, 0, lu.stderr);
      assert.deepEqual(JSON.parse(lu.stdout), ['v9.9.9', `sha256:${empreinte}`]);
    }
  });
});

test('W7 analyses de sécurité en place', () => {
  const codeql = workflow('codeql.yml');
  assert.match(codeql, /language: \[actions, java-kotlin, javascript-typescript, python\]/);
  assert.match(codeql, /queries: security-extended/);
  assert.match(codeql, /config-file: \.github\/codeql\/codeql-config\.yml/);
  assert.ok(fs.existsSync(path.join(root, '.github', 'codeql', 'codeql-config.yml')));
  const securite = workflow('securite.yml');
  for (const job of ['dependances', 'npm-audit', 'trivy-depot', 'trivy-image', 'image-publiee', 'workflows']) {
    assert.ok(jobs('securite.yml').some(found => found.key === job), `securite.yml : job ${job}`);
  }
  assert.match(securite, /npm audit --omit=dev --audit-level=high/);
  assert.equal((securite.match(/ignore-unfixed: true/g) || []).length, 3, 'trois contrôles Trivy bloquants');
  assert.equal((securite.match(/severity: HIGH,CRITICAL/g) || []).length, 3);
  assert.match(securite, /config: \.github\/zizmor\.yml/);
  assert.match(securite, /zizmor-action@[0-9a-f]{40} # v[\d.]+\n\s+with:\n(?:\s+#.*\n)*\s+version: \d+\.\d+\.\d+\n/, 'version de zizmor fixée');
  assert.match(securite, /cron: '\d+ \d+ \* \* 1'/, 'veille hebdomadaire');
  assert.match(workflow('scorecard.yml'), /publish_results: true/);
  const veille = workflow('veille-versions.yml');
  assert.match(veille, /cron: '\d+ \d+ \* \* 1'/, 'veille des versions chaque lundi');
  assert.match(veille, /GITHUB_TOKEN: \$\{\{ github\.token \}\}\n\s+run: node scripts\/veille-versions\.js\n/, 'jeton dans la seule étape du script');
  assert.match(veille, /concurrency:\n\s+group: veille-versions\n/, 'une seule exécution à la fois : une seule issue');
  assert.match(veille, /if: github\.ref == 'refs\/heads\/main'\n/, 'une autre branche fermerait l’issue à tort');
  assert.match(read('SECURITY.md'), /« Veille des versions »/, 'veille documentée');
  assert.match(workflow('bilan-timefold.yml'), /--avant "\$AVANT" --solveur --cles/, 'bilan avant/après avec Timefold et clés anonymes');
  // Fichier d'exceptions de Trivy, lu par défaut dans le dossier du dépôt.
  assert.ok(read('.trivyignore').split('\n').every(line => !line.trim() || line.startsWith('#') || /^(CVE|GHSA)-[\w-]+$/.test(line.trim())),
    '.trivyignore : un identifiant par ligne, raisons en commentaire');
  for (const file of ['SECURITY.md', '.github/CODEOWNERS', '.github/pull_request_template.md', '.github/zizmor.yml']) {
    assert.ok(fs.existsSync(path.join(root, ...file.split('/'))), `${file} absent`);
  }
  assert.match(read('SECURITY.md'), /security\/advisories\/new/, 'SECURITY.md : signalement privé');
});

test('W8 images du VPS et du Dockerfile épinglées par empreinte', () => {
  const compose = read('deploy/compose.yaml');
  const images = [...compose.matchAll(/^\s+image: (.+)$/gm)].map(match => match[1].trim());
  const tags = images.map(image => image.replace(/@sha256:[0-9a-f]{64}$/, ''));
  assert.equal(tags.length, 2, 'deux images');
  assert.match(tags[0], /^caddy:\d+\.\d+\.\d+$/, 'Caddy à une version exacte, que Dependabot relève avec son empreinte');
  assert.equal(tags[1], 'ghcr.io/jpfroud/karafun-plus:${KARAFUN_PLUS_VERSION:?à renseigner dans deploy/.env}');
  assert.match(images[0], /@sha256:[0-9a-f]{64}$/, 'Caddy épinglé par empreinte');
  // L'image de l'application est vérifiée par son empreinte publiée (agent de mise à jour).
  const lines = compose.split('\n');
  const services = blocks(lines, 2, lines.indexOf('services:') + 1);
  for (const service of ['caddy', 'app']) {
    const block = services.find(found => found.key === service);
    assert.ok(block, `service ${service} absent`);
    assert.ok(block.lines.some(line => line.trim() === '<<: *durci'), `${service} : sans capacités ni élévation de privilèges`);
  }
  assert.match(compose, /x-durci: &durci\n(?:\s+#.*\n)*\s+cap_drop:\n\s+- ALL\n\s+security_opt:\n\s+- no-new-privileges:true/);
  // Caddy, en root : les ports 80 et 443, et la lecture du Caddyfile monté
  // (0660 après un git checkout de l'agent). Rien d'autre, jamais DAC_READ_SEARCH.
  const caddy = services.find(found => found.key === 'caddy').lines.join('\n');
  const added = /^ {4}cap_add:\n((?: {6}- .+\n?)+)/m.exec(caddy);
  assert.ok(added, 'caddy : cap_add absent');
  assert.deepEqual(added[1].trim().split('\n').map(line => line.trim().replace(/^- /, '')), ['NET_BIND_SERVICE', 'DAC_OVERRIDE']);
  const app = services.find(found => found.key === 'app').lines.join('\n');
  assert.doesNotMatch(app, /cap_add:/, 'app : aucune capacité ajoutée');
  const settings = compose.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(settings, /DAC_READ_SEARCH|SYS_ADMIN|privileged:/);
});

test('W9 le contrôle exigé couvre chaque job et les scripts à tube échouent', () => {
  // « Tests OK » et « Sécurité OK » sont les contrôles exigés sur main : un
  // job absent de leurs needs pourrait échouer sans bloquer la fusion.
  const ci = jobs('ci.yml');
  const gate = ci.find(job => job.key === 'tests-ok');
  assert.ok(gate, 'ci.yml : job tests-ok absent');
  const needs = /^ {4}needs: \[([^\]]*)\]$/m.exec(gate.lines.join('\n'));
  assert.ok(needs, 'tests-ok : needs absent');
  assert.deepEqual(needs[1].split(',').map(name => name.trim()).sort(),
    ci.map(job => job.key).filter(key => key !== 'tests-ok').sort(), 'tests-ok : needs incomplet');
  assert.match(gate.lines.join('\n'), /^ {4}if: always\(\)$/m, 'tests-ok : lancé même après un échec');
  // « Sécurité OK » résume chaque analyse d'une PR, comme « Tests OK ».
  const security = jobs('securite.yml');
  const summary = security.find(job => job.key === 'securite-ok');
  assert.ok(summary, 'securite.yml : job securite-ok absent');
  const text = summary.lines.join('\n');
  assert.match(text, /^ {4}name: Sécurité OK$/m);
  assert.match(text, /^ {4}if: always\(\) && github\.event_name == 'pull_request'$/m);
  assert.deepEqual(/^ {4}needs: \[([^\]]*)\]$/m.exec(text)[1].split(',').map(name => name.trim()).sort(),
    security.map(job => job.key).filter(key => !['securite-ok', 'image-publiee'].includes(key)).sort(), 'securite-ok : needs incomplet');
  assert.doesNotMatch(workflow('securite.yml').split('\n').slice(0, 20).join('\n'), /paths:/, 'Sécurité tourne sur chaque PR');
  // Une analyse planifiée n'est jamais annulée par un envoi sur la même branche.
  for (const name of WORKFLOWS) {
    const text = workflow(name);
    if (!/^\s+schedule:/m.test(text) || !/^\s+cancel-in-progress: true$/m.test(text)) continue;
    assert.match(text, /^\s+group: .*\$\{\{ github\.event_name \}\}/m, `${name} : groupe de concurrence sans github.event_name`);
  }
  // Sans « shell: bash », un run: est lancé sans pipefail : « commande | tee »
  // réussit même quand la commande échoue.
  for (const name of WORKFLOWS) {
    const everywhere = /^defaults:\n {2}run:\n {4}shell: bash$/m.test(workflow(name));
    for (const job of jobs(name)) {
      const shell = everywhere || /^ {4}defaults:\n {6}run:\n {8}shell: bash$/m.test(job.lines.join('\n'));
      for (const step of steps(job)) {
        // run: sur une ligne, ou bloc « | », « > », « |- »…
        const run = /^ {6}(?:- )? {0,2}run:[ \t]*(.*)$/m.exec(step);
        if (!run) continue;
        const script = /^[|>]/.test(run[1]) ? step.slice(run.index + run[0].length) : run[1];
        if (!/\|\s*tee\b/.test(script)) continue;
        assert.ok(shell || /^ {8}shell: bash$/m.test(step), `${name}/${job.key} : « | tee » sans shell: bash (pipefail)`);
      }
    }
  }
});

test('W10 aucune installation hors fichier de verrouillage, sauf Playwright à version exacte', () => {
  // Exception déclarée à zizmor (adhoc-packages, .github/zizmor.yml) pour
  // ci.yml et release.yml : ce test la restreint à cette seule ligne.
  const adhoc = /\b(?:npm (?:install|i|add)\b|npx\b|pip3? install|pipx install|uv (?:pip|tool) install|uvx\b|yarn (?:add|global)|pnpm (?:add|dlx)|gem install|cargo install|go install|curl\b[^\n|]*\|\s*(?:ba)?sh|wget\b[^\n|]*\|\s*(?:ba)?sh)/;
  const allowed = /^\s*npm install --global playwright@\d+\.\d+\.\d+$/;
  let playwright = 0;
  for (const name of WORKFLOWS) {
    workflow(name).split('\n').forEach((line, index) => {
      if (/^\s*#/.test(line) || !adhoc.test(line)) return;
      assert.match(line, allowed, `${name}:${index + 1} : installation hors fichier de verrouillage : ${line.trim()}`);
      assert.ok(['ci.yml', 'release.yml'].includes(name), `${name}:${index + 1} : Playwright hors de ci.yml et release.yml`);
      playwright++;
    });
  }
  assert.equal(playwright, 2, 'Playwright installé par le job linux des tests et le job tests de la publication');
  const versions = new Set(WORKFLOWS.flatMap(name => [...workflow(name).matchAll(/playwright@(\d+\.\d+\.\d+)/g)].map(match => match[1])));
  assert.equal(versions.size, 1, `une seule version de Playwright : ${[...versions].join(', ')}`);
});

test('W11 une montée de version change tout le dépôt d’un seul tenant', () => {
  // Une montée partielle (PR de Dependabot sur la seule image, par exemple)
  // laisserait le Dockerfile, la CI, les tests et les documents sur deux versions.
  const one = (text, pattern, label) => {
    const found = new Set([...text.matchAll(pattern)].map(match => match[1]));
    assert.equal(found.size, 1, `${label} : ${[...found].join(', ') || 'introuvable'}`);
    return [...found][0];
  };
  const dockerfile = read('Dockerfile');
  const node = one(dockerfile, /\bnode:(\d+)-/g, 'Node du Dockerfile');
  const debian = one(dockerfile, /\bnode:\d+-(\w+)-slim@/g, 'Debian du Dockerfile');
  const java = one(dockerfile, /\beclipse-temurin[:-](\d+)/g, 'Java du Dockerfile, image Maven comprise');
  const all = WORKFLOWS.map(workflow).join('\n');
  assert.equal(one(all, /node-version: '(\d+)'/g, 'node-version des workflows'), node);
  assert.equal(one(all, /java-version: '(\d+)'/g, 'java-version des workflows'), java);
  one(all, /\bubuntu-(\d+\.\d+)/g, 'Ubuntu des workflows');
  one(all, /rhysd\/actionlint:(\d+\.\d+\.\d+)@/g, 'actionlint des workflows');
  assert.equal(/<maven\.compiler\.release>(\d+)</.exec(read('solver/pom.xml'))[1], java, 'solver/pom.xml');
  assert.equal(JSON.parse(read('package.json')).engines.node, `>=${node}`, 'package.json');
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].engines.node, `>=${node}`, 'package-lock.json');
  // Contrôles de la version réellement embarquée, dans l'image et le kit.
  const image = read('test/verifier-image.sh');
  assert.ok(image.includes(`$VERSION_NODE == v${node}.*`), 'test/verifier-image.sh : Node de cette machine');
  assert.ok(image.includes(`MOTIF_JAVA='^(openjdk|java) ${java}(`), 'test/verifier-image.sh : Java de l’image');
  assert.ok(read('test/verify-portable-kit.ps1').includes(`'^(openjdk|java) ${java}'`), 'test/verify-portable-kit.ps1 : Java du kit');
  // Textes : documents, messages et commentaires. Debian y est citée par son numéro (« Debian 13 »).
  const DEBIAN = { bookworm: '12', trixie: '13', forky: '14' };
  assert.ok(DEBIAN[debian], `numéro de Debian ${debian} à ajouter à W11`);
  const tag = (file, text) => {
    for (const [, version, name] of text.matchAll(/\bnode:(\d+)-(\w+)-slim\b/g)) {
      assert.equal(`${version}-${name}`, `${node}-${debian}`, `${file} : node:${version}-${name}-slim`);
    }
  };
  for (const file of ['README.md', 'CONTRIBUTING.md', 'CONTEXTE-REPRISE.md', 'DEPLOIEMENT-SERVEUR.md', 'KIT-BAR-LISEZMOI.txt',
    'GUIDE-BAR.md', 'LISEZMOI.txt', 'AGENTS.md', '.github/RELEASE.md', 'PREPARER-KIT-BAR.ps1', 'karafun.js', 'tools/diag-karafun.js',
    'test/verifier-image.sh', 'test/verify-portable-kit.ps1', 'test/fixtures/compose.essai-caddy.yaml']) {
    const text = read(file);
    for (const [, version] of text.matchAll(/\bNode(?:\.js)? (\d+)\b/g)) assert.equal(version, node, `${file} : Node ${version}`);
    for (const [, version] of text.matchAll(/\bJava (\d+)\b/g)) assert.equal(version, java, `${file} : Java ${version}`);
    for (const [, version] of text.matchAll(/\bDebian (\d+)\b/g)) assert.equal(version, DEBIAN[debian], `${file} : Debian ${version}`);
    tag(file, text);
  }
  // SECURITY.md garde des versions écartées (« Node 25 et Java 26 », #48 à #50) : seule l'étiquette
  // de l'image y est suivie (correctif de zlib).
  tag('SECURITY.md', read('SECURITY.md'));
});
