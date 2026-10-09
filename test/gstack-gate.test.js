'use strict';
// Porte gstack (.claude/hooks/gstack-gate.js et son hook git pre-push) :
// modification refusée sans compétence gstack lancée dans la session ; envoi
// refusé par git tant que le commit n'a pas exactement le contenu d'une
// relecture /review terminée et convergée ; écriture par l'API GitHub refusée
// dans ce dépôt. Un faux gstack et un faux journal de relecture remplacent les
// vrais ; les dépôts de test ignorent la configuration git de la machine.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..', '.claude', 'hooks');
const GATE = path.join(HOOKS, 'gstack-gate.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'porte-gstack-'));
const home = path.join(work, 'home');
const empty = path.join(work, 'vide');
const project = path.join(work, 'projet avec espace');
const reviews = path.join(work, 'journal.txt');
const gitConfig = path.join(work, 'gitconfig');
fs.writeFileSync(gitConfig, '');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')} : ${r.stderr}`);
  return r.stdout.trim();
}

// Faux gstack : quelques compétences et un gstack-review-read qui rend le journal préparé.
const gstack = path.join(home, '.claude', 'skills', 'gstack');
fs.mkdirSync(path.join(gstack, 'bin'), { recursive: true });
fs.writeFileSync(path.join(gstack, 'SKILL.md'), '---\nname: gstack\n---\n');
for (const skill of ['investigate', 'review', 'qa', 'retro', 'learn', 'gstack-upgrade']) {
  fs.mkdirSync(path.join(gstack, skill), { recursive: true });
  fs.writeFileSync(path.join(gstack, skill, 'SKILL.md'), `---\nname: ${skill}\n---\n`);
}
fs.writeFileSync(path.join(gstack, 'bin', 'gstack-review-read'),
  '#!/usr/bin/env bash\ncat "$FAUX_JOURNAL"\nexit "${FAUX_JOURNAL_CODE:-0}"\n');
fs.mkdirSync(empty, { recursive: true });

// Dépôt du projet (chemin avec espace) avec la porte, un dépôt distant nu et un worktree lié.
fs.mkdirSync(path.join(project, '.claude', 'hooks'), { recursive: true });
fs.copyFileSync(GATE, path.join(project, '.claude', 'hooks', 'gstack-gate.js'));
git(work, 'init', '-q', project);
fs.writeFileSync(path.join(project, 'server.js'), '// app\n');
git(project, 'add', '-A');
git(project, 'commit', '-qm', 'depart');
const remote = path.join(work, 'distant.git');
git(work, 'init', '-q', '--bare', remote);
git(project, 'remote', 'add', 'origin', 'git@github.com:Exemple/Projet.git');
git(project, 'remote', 'add', 'essai', remote);
const hooksDir = path.join(project, '.git', 'hooks');
fs.mkdirSync(hooksDir, { recursive: true });
fs.copyFileSync(path.join(HOOKS, 'pre-push'), path.join(hooksDir, 'pre-push'));
fs.chmodSync(path.join(hooksDir, 'pre-push'), 0o755);
const linked = path.join(work, 'worktree lié');
git(project, 'worktree', 'add', '-q', linked, '-b', 'liee');

const baseEnv = { HOME: home, USERPROFILE: home, FAUX_JOURNAL: reviews, GSTACK_ROOT: '', GSTACK_GATE: '' };
function gate(mode, event, env = {}) {
  const r = spawnSync(process.execPath, [GATE, mode], {
    input: typeof event === 'string' ? event : JSON.stringify({ cwd: project, ...event }),
    encoding: 'utf8',
    env: { ...gitEnv, ...baseEnv, CLAUDE_PROJECT_DIR: project, ...env },
  });
  assert.strictEqual(r.status, 0, `la porte ne doit jamais échouer (${mode}) : ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const decision = reply => reply && reply.hookSpecificOutput && reply.hookSpecificOutput.permissionDecision;
const reason = reply => (reply && reply.hookSpecificOutput && reply.hookSpecificOutput.permissionDecisionReason) || '';
const edit = (session, file, env) => gate('edit', { session_id: session, tool_name: 'Edit', tool_input: { file_path: file } }, env);
const skill = (session, name) => gate('skill', { session_id: session, tool_name: 'Skill', tool_input: { skill: name, args: 'x' } });

// 1. Modification refusée tant qu'aucune compétence gstack n'a été lancée.
let reply = edit('s1', path.join(project, 'server.js'));
assert.strictEqual(decision(reply), 'deny', 'modification sans compétence gstack');
assert.match(reason(reply), /server\.js/);
assert.match(reason(reply), /investigate/);
assert.match(reason(reply), /outil Skill/);
reply = gate('edit', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: 'public/nouveau.html' } });
assert.strictEqual(decision(reply), 'deny', 'chemin relatif dans le dépôt, fichier pas encore créé');
reply = gate('edit', { session_id: 's1', tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(project, 'a.ipynb') } });
assert.strictEqual(decision(reply), 'deny', 'carnet du dépôt');
assert.strictEqual(decision(edit('s1', path.join(project, '..config.js'))), 'deny', 'un nom commençant par « .. » reste dans le dépôt');

// Hors dépôt, rapport local, données et traces gstack : jamais bloqués.
for (const file of [path.join(work, 'brouillon.js'), path.join(project, 'RAPPORT-TEST.md'),
  path.join(project, '.gstack', 'qa-reports', 'r.md'), path.join(project, 'data', 'soiree.json')]) {
  assert.strictEqual(edit('s1', file), null, `${file} ne doit pas être bloqué`);
}
// L'état de la porte ne se déverrouille pas en l'écrivant soi-même.
reply = gate('edit', { session_id: 's1', tool_name: 'Write', tool_input: { file_path: path.join(project, '.gstack', 'porte', 's1.json') } });
assert.strictEqual(decision(reply), 'deny', 'état de la porte protégé');
fs.mkdirSync(path.join(project, '.gstack', 'porte'), { recursive: true });
fs.writeFileSync(path.join(project, '.gstack', 'porte', 'forge.json'), JSON.stringify({ skills: [{}, { skill: 'simplify' }, { skill: 42 }] }));
assert.strictEqual(decision(edit('forge', path.join(project, 'server.js'))), 'deny', 'des entrées forgées ne comptent pas');

// Compétences étrangères à gstack ou d'administration (sous tous leurs noms) : ne comptent pas.
for (const name of ['simplify', 'retro', 'gstack:learn', 'gstack-upgrade', 'gstack:gstack-upgrade', '../../etc']) skill('s1', name);
gate('prompt', { session_id: 's1', prompt: '/learn quelque chose' });
assert.strictEqual(decision(edit('s1', path.join(project, 'server.js'))), 'deny', 'compétence hors parcours acceptée');

// 2. Une compétence gstack lancée : la session (sous-agents compris) peut modifier.
skill('s1', 'investigate');
assert.strictEqual(edit('s1', path.join(project, 'server.js')), null, 'modification après investigate');
assert.strictEqual(gate('edit', { session_id: 's1', agent_id: 'sous-agent', tool_name: 'MultiEdit',
  tool_input: { file_path: path.join(project, 'scheduler.js') } }), null, 'sous-agent de la même session');
const state = JSON.parse(fs.readFileSync(path.join(project, '.gstack', 'porte', 's1.json'), 'utf8'));
assert.deepStrictEqual(state.skills.map(s => s.skill), ['investigate'], 'seule la compétence gstack est notée');
assert.strictEqual(decision(edit('s2', path.join(project, 'server.js'))), 'deny', 'une autre session repart de zéro');
skill('s2', 'gstack:qa');
assert.strictEqual(edit('s2', path.join(project, 'server.js')), null, 'nom préfixé gstack:');
skill('s4', 'gstack');
assert.strictEqual(edit('s4', path.join(project, 'server.js')), null, 'routeur gstack (SKILL.md à la racine)');

// Commande tapée par l'utilisateur (/qa, /review…) : compte aussi.
gate('prompt', { session_id: 's3', prompt: 'bonjour, corrige le bug' });
assert.strictEqual(decision(edit('s3', path.join(project, 'server.js'))), 'deny', 'une demande ordinaire ne compte pas');
gate('prompt', { session_id: 's3', prompt: '/investigate la file se bloque' });
assert.strictEqual(edit('s3', path.join(project, 'server.js')), null, 'commande /investigate');

// Trace impossible à écrire : l'agent en est averti au lieu de tourner en rond.
const blocked = path.join(work, 'bloque');
fs.mkdirSync(blocked);
fs.writeFileSync(path.join(blocked, '.gstack'), 'un fichier, pas un dossier');
reply = gate('skill', { session_id: 'x', tool_name: 'Skill', tool_input: { skill: 'review' } }, { CLAUDE_PROJECT_DIR: blocked });
assert.strictEqual(reply.hookSpecificOutput.hookEventName, 'PostToolUse');
assert.match(reply.hookSpecificOutput.additionalContext, /impossible de noter la compétence review/);

// gstack absent : refus avec l'installateur du projet ; GSTACK_ROOT relatif lu depuis le dossier courant.
reply = edit('s1', path.join(project, 'server.js'), { HOME: empty, USERPROFILE: empty });
assert.strictEqual(decision(reply), 'deny');
assert.match(reason(reply), /install-gstack\.sh/);
const relRoot = spawnSync(process.execPath, [GATE, 'edit'], { cwd: path.dirname(gstack), encoding: 'utf8',
  input: JSON.stringify({ session_id: 's1', cwd: project, tool_name: 'Edit', tool_input: { file_path: path.join(project, 'server.js') } }),
  env: { ...gitEnv, ...baseEnv, HOME: empty, USERPROFILE: empty, GSTACK_ROOT: 'gstack', CLAUDE_PROJECT_DIR: project } });
assert.strictEqual(relRoot.stdout.trim(), '', 'GSTACK_ROOT relatif résolu depuis le dossier courant');

// 3. Écriture par l'API GitHub : refusée pour le dépôt d'origin, libre ailleurs.
for (const tool of ['mcp__github__push_files', 'mcp__github__create_or_update_file', 'mcp__github__delete_file']) {
  reply = gate('github', { session_id: 's', tool_name: tool, tool_input: { owner: 'exemple', repo: 'PROJET', branch: 'x' } });
  assert.strictEqual(decision(reply), 'deny', `${tool} vers ce dépôt`);
  assert.match(reason(reply), /git push/);
  assert.strictEqual(gate('github', { session_id: 's', tool_name: tool, tool_input: { owner: 'autre', repo: 'depot' } }), null, `${tool} vers un autre dépôt`);
}
assert.strictEqual(gate('github', { session_id: 's', tool_name: 'mcp__github__create_pull_request', tool_input: { owner: 'exemple', repo: 'projet' } }), null,
  'une PR reprend une branche déjà envoyée, donc déjà contrôlée');

// 4. Envoi (hook git pre-push) : seul l'arbre exact d'une relecture terminée et convergée passe.
const headTree = git(project, 'rev-parse', 'HEAD^{tree}');
const row = (extra = {}) => JSON.stringify({ skill: 'review', status: 'clean', issues_found: 0, completed: true, converged: true,
  wtree: headTree, review_binding: { state: 'verified', start_wtree: headTree, end_wtree: headTree },
  review_freshness: { status: 'CURRENT' }, ...extra });
const journal = (...rows) => fs.writeFileSync(reviews, `${rows.join('\n') || 'NO_REVIEWS'}\n---CONFIG---\nfalse\n---HEAD---\nabc\n---WTREE---\nW\n---TREE---\nT\n---DIRTY---\nfalse\n`);
const head = git(project, 'rev-parse', 'HEAD');
const zeros = '0'.repeat(40);
function prePush(lines, env = {}, cwd = project) {
  return spawnSync(process.execPath, [GATE, 'pre-push', 'essai', remote], { cwd, input: lines, encoding: 'utf8',
    env: { ...gitEnv, ...baseEnv, CLAUDECODE: '1', ...env } });
}
const pushLine = `refs/heads/master ${head} refs/heads/master ${zeros}\n`;

journal();
let r = prePush(pushLine);
assert.strictEqual(r.status, 1, 'aucune relecture : refus');
assert.match(r.stderr, /aucune relecture gstack/);
assert.strictEqual(prePush(pushLine, { CLAUDECODE: '' }).status, 0, 'envoi tapé par l\'utilisateur : pas concerné');
assert.strictEqual(prePush(`(delete) ${zeros} refs/heads/vieille ${head}\n`).status, 0, 'suppression de branche');
assert.strictEqual(prePush('').status, 0, 'rien à envoyer');

journal(row());
assert.strictEqual(prePush(pushLine).status, 0, 'relecture terminée sur l\'arbre exact');
for (const [extra, why] of [
  [{ converged: false }, 'non convergée'],
  [{ completed: false }, 'inachevée'],
  [{ review_binding: { state: 'changed', start_wtree: 'W0', end_wtree: headTree } }, 'contenu modifié pendant la relecture'],
  [{ review_binding: { state: 'uncaptured', start_wtree: headTree, end_wtree: headTree } }, 'sans capture de départ'],
  [{ wtree: 'f'.repeat(40), review_binding: { state: 'verified', start_wtree: 'f'.repeat(40), end_wtree: 'f'.repeat(40) } }, 'autre contenu'],
  [{ skill: 'ship' }, '/ship ne remplace pas /review'],
  [{ skill: 'adversarial-review' }, 'une passe adverse seule ne suffit pas'],
]) {
  journal(row(extra));
  r = prePush(pushLine);
  assert.strictEqual(r.status, 1, `refus attendu : ${why}`);
  assert.match(r.stderr, /envoi refusé/);
}
journal(row({ status: 'issues_found', issues_found: 2, review_freshness: { status: 'UNVERIFIED' } }));
r = prePush(pushLine);
assert.strictEqual(r.status, 0, 'relecture terminée avec remarques : envoi accepté');
assert.match(r.stderr, /remarques non résolues/);
journal(row());
r = prePush(pushLine, { FAUX_JOURNAL_CODE: '1' });
assert.strictEqual(r.status, 1, 'journal illisible : refus');
assert.match(r.stderr, /journal de relecture gstack est illisible/);
assert.strictEqual(prePush(pushLine, { HOME: empty, USERPROFILE: empty }).status, 1, 'gstack absent : refus');
assert.strictEqual(prePush(pushLine, { GSTACK_GATE: 'off' }).status, 0, 'GSTACK_GATE=off');

// Vrai git push : quelle que soit l'écriture de la commande, c'est git qui appelle la porte.
// Ces cas couvrent un envoi non relu fait par mégarde par Claude Code, pas un
// contournement voulu : git push --no-verify, une référence refs/remotes locale
// forgée, CLAUDECODE absent, GSTACK_GATE=off ou la porte modifiée dans la copie
// de travail passent. La vraie barrière est la protection de branche de GitHub.
function push(args, env = {}, cwd = project) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...gitEnv, ...baseEnv, CLAUDECODE: '1', ...env } });
}
journal();
r = push(['push', 'essai', 'HEAD:refs/heads/a']);
assert.notStrictEqual(r.status, 0, 'git -C "<chemin avec espace>" push sans relecture');
assert.match(r.stderr, /Porte gstack : envoi refusé/);
assert.notStrictEqual(spawnSync('git', ['push', 'essai', 'HEAD:refs/heads/b'], { cwd: project, encoding: 'utf8',
  env: { ...gitEnv, ...baseEnv, CLAUDECODE: '1' } }).status, 0, 'git push depuis le dossier');
git(project, 'config', 'alias.envoi', 'push');
assert.notStrictEqual(push(['envoi', 'essai', 'HEAD:refs/heads/c']).status, 0, 'alias git');
fs.writeFileSync(path.join(linked, 'nouveau.js'), '1\n');
git(linked, 'add', '-A');
git(linked, 'commit', '-qm', 'travail lié');
assert.notStrictEqual(push(['push', 'essai', 'liee'], {}, linked).status, 0, 'worktree lié');
assert.strictEqual(push(['push', 'essai', 'HEAD:refs/heads/d'], { CLAUDECODE: '' }).status, 0, 'envoi de l\'utilisateur');
journal(row());
assert.strictEqual(push(['push', 'essai', 'HEAD:refs/heads/e']).status, 0, 'envoi après relecture du contenu exact');
git(project, 'fetch', '-q', 'essai');
git(project, 'tag', 'v9.9.9');
journal();
assert.strictEqual(push(['push', 'essai', 'v9.9.9']).status, 0, 'étiquette d\'un commit déjà sur le serveur');
fs.writeFileSync(path.join(project, 'server.js'), '// app modifiée après relecture\n');
git(project, 'commit', '-qam', 'après relecture');
journal(row());
assert.notStrictEqual(push(['push', 'essai', 'HEAD:refs/heads/e']).status, 0, 'commit postérieur à la relecture');

// 5. Entrées invalides et coupure par l'utilisateur : les hooks Claude Code ne bloquent jamais.
assert.strictEqual(edit('zz', path.join(project, 'server.js'), { GSTACK_GATE: 'off' }), null, 'GSTACK_GATE=off');
assert.strictEqual(gate('edit', '{pas du json'), null);
assert.strictEqual(gate('edit', ''), null);
assert.strictEqual(gate('inconnu', { session_id: 's1' }), null);

// Entrée standard laissée ouverte (lancement à la main) : la porte ne l'attend pas.
const started = Date.now();
const open = spawnSync(process.execPath, ['-e', `
  const c = require('child_process').spawn(process.execPath, [${JSON.stringify(GATE)}, 'edit'], { stdio: ['pipe', 'ignore', 'ignore'] });
  c.on('exit', code => process.exit(code));`], { encoding: 'utf8', timeout: 20000 });
assert.strictEqual(open.status, 0);
assert.ok(Date.now() - started < 10000, 'la porte attend une entrée qui ne se ferme pas');

// 6. Les réglages du projet déclarent la porte sur les bons événements.
const settings = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude', 'settings.json'), 'utf8')).hooks;
const command = (list, matcher) => (list || []).filter(e => e.matcher === matcher).flatMap(e => e.hooks.map(h => h.command)).join(' ');
assert.match(command(settings.PreToolUse, 'Edit|Write|MultiEdit|NotebookEdit'), /gstack-gate\.js" edit$/);
const githubMatcher = settings.PreToolUse.find(e => /gstack-gate\.js" github$/.test(e.hooks[0].command)).matcher.split('|');
assert.deepStrictEqual(githubMatcher.sort(), [...['mcp__github__create_or_update_file', 'mcp__github__delete_file', 'mcp__github__push_files']].sort());
assert.ok(!settings.PreToolUse.some(e => e.matcher && e.matcher.split('|').includes('Bash')), 'plus d\'analyse du texte des commandes Bash');
assert.match(command(settings.PostToolUse, 'Skill'), /gstack-gate\.js" skill$/);
assert.match(settings.UserPromptSubmit[0].hooks.map(h => h.command).join(' '), /gstack-gate\.js" prompt/);
assert.match(command(settings.PreToolUse, 'Skill'), /check-gstack\.sh/);
assert.match(fs.readFileSync(path.join(HOOKS, 'pre-push'), 'utf8'), /Porte gstack karafun-plus/, 'marque reconnue par l\'installateur');

// 7. Regression: M2-3 (seconde relecture) — la liste des dossiers où chercher
//    gstack existe en quatre copies (porte, garde-fou des compétences, hook de
//    démarrage, installateur) : une copie oubliée lors d'un ajout ferait
//    refuser les compétences ou réinstaller gstack alors qu'il est présent.
//    Les quatre listes doivent rester identiques, dans le même ordre.
{
  const read = name => fs.readFileSync(path.join(HOOKS, name), 'utf8');
  const shellList = name => {
    const loop = /for candidate in ((?:[^;]|\\\n)*?); do/.exec(read(name));
    assert.ok(loop, `${name} : boucle « for candidate in … » introuvable`);
    return [...loop[1].matchAll(/"([^"]*)"/g)].map(m => m[1].replace(/^\$HOME\//, '').replace(/^\$\{GSTACK_ROOT:-\}$/, 'GSTACK_ROOT'));
  };
  const gate = /function gstackDir\(\) \{([\s\S]*?)\n\}/.exec(read('gstack-gate.js'));
  assert.ok(gate, 'gstack-gate.js : gstackDir() introuvable');
  const gateList = ['GSTACK_ROOT', ...[.../\.\.\.\[([^\]]*)\]/.exec(gate[1])[1].matchAll(/'([^']*)'/g)].map(m => m[1])];
  assert.match(gate[1], /process\.env\.GSTACK_ROOT \?[^,]*,\s*\.\.\.\[/, 'gstack-gate.js : GSTACK_ROOT en premier');
  assert.ok(gateList.length >= 13 && gateList.includes('.claude/skills/gstack'), `liste de la porte lue : ${gateList.join(', ')}`);
  for (const name of ['check-gstack.sh', 'gstack-session-start.sh', 'install-gstack.sh']) {
    assert.deepStrictEqual(shellList(name), gateList, `${name} : même liste de dossiers gstack que gstack-gate.js`);
  }
}

fs.rmSync(work, { recursive: true, force: true });
console.log('Porte gstack : modification sans compétence gstack, envoi sans relecture /review du contenu exact et écriture GitHub directe refusés OK');
