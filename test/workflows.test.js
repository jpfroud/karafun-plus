'use strict';
// Chaîne d'approvisionnement et workflows GitHub, en lecture statique (sur le
// modèle du test de parité de RetroGemini) : une régression de ces règles se
// voit dans la suite hors ligne, avant même la CI. Détail et raisons :
// SECURITY.md. Aucun réseau, aucune dépendance : lecture ligne à ligne de
// fichiers YAML écrits avec une indentation de deux espaces.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
  // Droits d'écriture : seulement là où ils servent.
  const writes = WORKFLOWS.flatMap(name => jobs(name).flatMap(job => job.lines
    .filter(line => /^ {6}[\w-]+: write$/.test(line)).map(line => `${name}/${job.key}/${line.trim().split(':')[0]}`))).sort();
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
    // Identifiants git jamais gardés après l'extraction, sauf pour envoyer le tag d'une release.
    for (const job of jobs(name)) {
      for (const step of steps(job).filter(step => /uses:\s*actions\/checkout@/.test(step))) {
        const kept = /persist-credentials:\s*true/.test(step);
        if (name === 'release.yml' && job.key === 'publier') assert.ok(kept, 'publier garde ses identifiants pour le tag');
        else assert.match(step, /persist-credentials:\s*false/, `${name}/${job.key} : checkout sans persist-credentials: false`);
      }
    }
  }
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
  for (const step of ['npm sbom --omit dev --sbom-format cyclonedx', 'org.cyclonedx:cyclonedx-maven-plugin:makeBom',
    'actions/attest-build-provenance@', 'push-to-registry: true', 'KIT-BAR-KARAFUN.zip.sigstore.json']) {
    assert.ok(release.includes(step), `release.yml : ${step}`);
  }
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
  const merge = workflow('dependabot-auto-merge.yml');
  assert.match(merge, /version-update:semver-patch \| version-update:semver-minor\)/, 'seuls les correctifs mineurs fusionnent seuls');
  assert.match(merge, /\*ai\.timefold\*/, 'Timefold jamais fusionné automatiquement');
  assert.match(merge, /\*socket\.io\*/, 'Socket.IO jamais fusionné automatiquement');
  assert.match(merge, /required_status_checks/, 'fusion seulement derrière des contrôles exigés');
  assert.match(merge, /gh pr merge --auto --merge "\$PR_URL"/);
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
  assert.match(securite, /cron: '\d+ \d+ \* \* 1'/, 'veille hebdomadaire');
  assert.match(workflow('scorecard.yml'), /publish_results: true/);
  assert.match(workflow('bilan-timefold.yml'), /--avant "\$AVANT" --solveur --cles/, 'bilan avant/après avec Timefold et clés anonymes');
  for (const file of ['SECURITY.md', '.github/CODEOWNERS', '.github/pull_request_template.md', '.github/zizmor.yml']) {
    assert.ok(fs.existsSync(path.join(root, ...file.split('/'))), `${file} absent`);
  }
  assert.match(read('SECURITY.md'), /security\/advisories\/new/, 'SECURITY.md : signalement privé');
});

test('W8 images du VPS et du Dockerfile épinglées par empreinte', () => {
  const compose = read('deploy/compose.yaml');
  const images = [...compose.matchAll(/^\s+image: (.+)$/gm)].map(match => match[1].trim());
  assert.deepEqual(images.map(image => image.replace(/@sha256:[0-9a-f]{64}$/, '')), [
    'caddy:2.11.8', 'ghcr.io/jpfroud/karafun-plus:${KARAFUN_PLUS_VERSION:?à renseigner dans deploy/.env}',
  ]);
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
  assert.match(compose, /cap_add:\n\s+- NET_BIND_SERVICE/);
});
