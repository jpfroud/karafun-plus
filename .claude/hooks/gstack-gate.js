#!/usr/bin/env node
'use strict';
// Porte gstack du projet.
//
// Hooks Claude Code (.claude/settings.json) :
//   node .claude/hooks/gstack-gate.js skill    PostToolUse Skill : note la compétence gstack lancée
//   node .claude/hooks/gstack-gate.js prompt   UserPromptSubmit : note une commande /compétence tapée
//   node .claude/hooks/gstack-gate.js edit     PreToolUse Edit|Write|MultiEdit|NotebookEdit
//   node .claude/hooks/gstack-gate.js github   PreToolUse des outils GitHub qui écrivent des fichiers
// Hook git, installé par gstack-session-start.sh comme .git/hooks/pre-push :
//   node .claude/hooks/gstack-gate.js pre-push <dépôt distant> <adresse>   (références sur l'entrée standard)
//
// edit : refuse de modifier un fichier du dépôt tant qu'aucune compétence
// gstack n'a été lancée dans la session (les sous-agents partagent la session
// de l'agent principal).
// pre-push : pour un envoi lancé par Claude Code (CLAUDECODE=1), le dernier
// commit envoyé sur chaque branche ou étiquette (le contenu envoyé) doit avoir
// exactement l'arbre d'une relecture gstack /review terminée et convergée
// (journal de relecture de gstack) ; les commits intermédiaires ne sont pas
// comparés (choix du gérant). C'est git qui appelle ce contrôle : l'écriture
// de la commande (git -C, alias, worktree lié…) n'y change rien, et les envois
// tapés par l'utilisateur ne sont pas concernés. Un commit déjà présent sur le
// serveur et une suppression passent.
// github : refuse l'écriture de fichiers dans ce dépôt par l'API GitHub, qui
// contournerait le contrôle de l'envoi.
//
// Les compétences notées sont gardées dans .gstack/porte/ (ignoré par git,
// non modifiable par les outils d'édition). GSTACK_GATE=off coupe la porte :
// décision de l'utilisateur seulement. Un hook Claude Code en erreur laisse
// passer (règle de Claude Code) ; le hook git refuse l'envoi tant que la
// relecture ne peut pas être vérifiée.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODE = process.argv[2] || '';
const HOME = process.env.HOME || os.homedir();

// Compétences d'administration de gstack : elles ne valent pas parcours.
const ADMIN_SKILLS = new Set(['gstack-upgrade', 'upgrade', 'setup-browser-cookies', 'setup-deploy', 'setup-gbrain',
  'sync-gbrain', 'context-save', 'context-restore', 'learn', 'plan-tune', 'retro', 'landing-report',
  'open-gstack-browser', 'connect-chrome', 'benchmark-models', 'unfreeze', 'skillify']);
// Seule la relecture /review de gstack vaut feu vert : ses passes annexes
// (adversarial-review, design-review-lite) et la télémétrie de /ship non.
const REVIEW_SKILLS = new Set(['review']);
// Fichiers du dépôt modifiables sans compétence : rapport local, données,
// traces de gstack (sauf l'état de la porte elle-même).
const FREE_PATHS = [/^RAPPORT-TEST\.md$/i, /^\.gstack\/(?!porte(\/|$))/i, /^data\//i, /^journal\//i, /^node_modules\//i];
// Outils GitHub qui écrivent directement dans le dépôt distant.
const GITHUB_WRITES = new Set(['mcp__github__push_files', 'mcp__github__create_or_update_file', 'mcp__github__delete_file']);
// Délai de gstack-review-read, qui calcule l'empreinte du contenu.
const REVIEW_READ_MS = 45000;

const ROUTES = 'défaut signalé → investigate ; fonctionnalité à préciser → spec (plan à challenger → plan-eng-review) ; ' +
  'parcours dans l\'application → qa ; sécurité → cso ; état du code → health ; documentation → document-release';

function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function deny(reason) {
  out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

// Lit l'entrée standard sans jamais attendre une entrée restée ouverte.
function readStdin() {
  return new Promise(resolve => {
    let data = '';
    const timer = setTimeout(() => { process.stdin.destroy(); resolve(data); }, 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

function parseEvent(text) {
  try { return text.trim() ? JSON.parse(text) : {}; } catch { return null; }
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

// Même liste que le mode équipe officiel (gstack-team-init) ; GSTACK_ROOT
// relatif se lit depuis le dossier courant, comme dans les scripts shell.
function gstackDir() {
  const candidates = [process.env.GSTACK_ROOT ? path.resolve(process.env.GSTACK_ROOT) : '',
    ...['.claude/skills/gstack', '.codex/skills/gstack', '.factory/skills/gstack', '.kiro/skills/gstack',
      '.config/opencode/skills/gstack', '.slate/skills/gstack', '.cursor/skills/gstack', '.openclaw/skills/gstack',
      '.hermes/skills/gstack', '.gbrain/skills/gstack', '.copilot/skills/gstack', '.gstack/repos/gstack']
      .map(c => path.join(HOME, c))];
  return candidates.find(dir => dir && isDir(path.join(dir, 'bin'))) || '';
}

function projectDir(event) {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || (event && event.cwd) || process.cwd());
}

function realpath(p) {
  try { return fs.realpathSync.native(p); } catch {}
  // Fichier pas encore créé : résoudre son dossier parent existant.
  const parent = path.dirname(p);
  if (parent === p) return p;
  return path.join(realpath(parent), path.basename(p));
}

// Chemin relatif au dépôt (barres obliques), ou null hors du dépôt.
function insideProject(file, root) {
  const rel = path.relative(realpath(root), realpath(file));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function stateFile(event) {
  const id = String((event && event.session_id) || 'sans-session').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  return path.join(projectDir(event), '.gstack', 'porte', `${id}.json`);
}

// Nom de compétence gstack (« investigate », « gstack:qa », « /review »…) ou ''.
function gstackSkill(raw) {
  const given = String(raw || '').trim().replace(/^\//, '').split(/\s/)[0];
  const name = given.replace(/^gstack[:-](?=.)/, '');
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name) || ADMIN_SKILLS.has(name) || ADMIN_SKILLS.has(given)) return '';
  const dir = gstackDir();
  if (!dir) return '';
  const skillFile = name === 'gstack' ? path.join(dir, 'SKILL.md') : path.join(dir, name, 'SKILL.md');
  return fs.existsSync(skillFile) ? name : '';
}

function recordedSkills(event) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(event), 'utf8'));
    return (Array.isArray(state && state.skills) ? state.skills : [])
      .filter(entry => entry && typeof entry.skill === 'string' && gstackSkill(entry.skill));
  } catch { return []; }
}

function record(event, name, source) {
  const file = stateFile(event);
  const skills = recordedSkills(event);
  skills.push({ skill: name, at: new Date().toISOString(), source, agent: (event && event.agent_id) || null });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ skills: skills.slice(-50) }, null, 2));
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

function onSkill(event) {
  const input = (event && event.tool_input) || {};
  const name = gstackSkill(input.skill || input.command || input.name);
  if (!name) return;
  try { record(event, name, 'Skill'); } catch (e) {
    // Sans trace, la porte des modifications refuserait sans fin : le dire.
    out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext:
      `Porte gstack : impossible de noter la compétence ${name} (${e.message}). Les modifications du dépôt resteront refusées ; le signaler à l'utilisateur.` } });
  }
}

function onPrompt(event) {
  const prompt = String((event && event.prompt) || '').trim();
  const m = /^\/([A-Za-z0-9:_-]+)/.exec(prompt);
  const name = m && gstackSkill(m[1]);
  if (name) record(event, name, 'commande');
}

function onEdit(event) {
  const input = (event && event.tool_input) || {};
  const target = input.file_path || input.notebook_path || input.path;
  if (!target) return;
  const root = projectDir(event);
  const file = path.resolve((event && event.cwd) || root, String(target));
  const rel = insideProject(file, root);
  if (rel === null || FREE_PATHS.some(re => re.test(rel))) return;
  if (/^\.gstack\/porte(\/|$)/i.test(rel)) {
    deny('L\'état de la porte gstack (.gstack/porte/) ne se modifie pas : lancer une compétence gstack avec l\'outil Skill.');
    return;
  }
  if (!gstackDir()) {
    deny('gstack est obligatoire dans ce dépôt mais n\'est pas installé : lancer bash .claude/hooks/install-gstack.sh ' +
      '(installation acceptée par l\'utilisateur), puis redémarrer l\'agent. Le dire à l\'utilisateur.');
    return;
  }
  if (recordedSkills(event).length) return;
  deny(`Modification de ${rel} refusée : aucune compétence gstack n'a encore été lancée dans cette session. ` +
    `Choisir celle qui convient à la demande et la lancer avec l'outil Skill (${ROUTES}), ` +
    'en l\'annonçant en une ligne, puis reprendre la modification. /review reste exigé avant l\'envoi (git push).');
}

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
}

// « propriétaire/dépôt » d'une adresse GitHub, en minuscules, ou ''.
function githubRepo(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : '';
}

function onGithub(event) {
  const tool = (event && event.tool_name) || '';
  if (!GITHUB_WRITES.has(tool)) return;
  const input = (event && event.tool_input) || {};
  const origin = githubRepo(git(['remote', 'get-url', 'origin'], projectDir(event)).stdout);
  const target = input.owner && input.repo ? `${input.owner}/${input.repo}`.toLowerCase() : '';
  if (!origin || !target || target !== origin) return; // autre dépôt : pas concerné
  deny('Dans ce dépôt, les fichiers partent par git push : son hook pre-push vérifie la relecture gstack /review ' +
    'du contenu exact. Écrire directement par l\'API GitHub la contournerait.');
}

// Lignes du journal de relecture de la branche courante (gstack-review-read).
function reviewRows(gstack, cwd) {
  const bash = process.env.CLAUDE_CODE_GIT_BASH_PATH || 'bash';
  const r = spawnSync(bash, [path.join(gstack, 'bin', 'gstack-review-read')], { cwd, encoding: 'utf8', timeout: REVIEW_READ_MS });
  if (r.status !== 0 || !r.stdout || !r.stdout.includes('---CONFIG---')) {
    throw new Error((r.stderr || (r.error && r.error.message) || `code ${r.status}`).trim().split('\n').pop());
  }
  const rows = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line === '---CONFIG---') break;
    if (line.startsWith('{')) { try { rows.push(JSON.parse(line)); } catch {} }
  }
  return rows;
}

// Relecture terminée, convergée et liée par gstack à l'arbre « tree ».
function reviewedTree(row, tree) {
  const b = row && row.review_binding;
  return REVIEW_SKILLS.has(row.skill) && row.completed === true && row.converged === true && row.wtree === tree &&
    !!b && b.state === 'verified' && b.start_wtree === tree && b.end_wtree === tree;
}

function onPrePush(stdin) {
  if (process.env.CLAUDECODE !== '1') return 0; // envoi de l'utilisateur : pas concerné
  const cwd = process.cwd();
  const refuse = message => {
    process.stderr.write(`\nPorte gstack : envoi refusé, ${message}\n` +
      'Lancer la compétence gstack review (outil Skill) et la mener jusqu\'à son journal de relecture, commiter exactement ' +
      'le contenu relu, puis renvoyer : seul le dernier commit envoyé sur chaque branche est comparé. ' +
      'Si la porte se trompe, le dire à l\'utilisateur : lui seul peut la couper (GSTACK_GATE=off).\n\n');
    return 1;
  };
  const updates = stdin.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 4);
  const pending = [];
  // git ne donne que le dernier commit de chaque référence envoyée : c'est lui
  // qui est comparé, pas les commits intermédiaires (choix du gérant).
  for (const [localRef, localSha] of updates) {
    if (/^0+$/.test(localSha)) continue; // suppression d'une branche ou d'une étiquette
    // Déjà sur le serveur (étiquette d'une version publiée, branche à jour) : rien de nouveau.
    const known = git(['for-each-ref', '--contains', localSha, '--count=1', '--format=%(refname)', 'refs/remotes'], cwd);
    if (known.status === 0 && known.stdout.trim()) continue;
    const tree = git(['rev-parse', `${localSha}^{tree}`], cwd);
    if (tree.status !== 0) return refuse(`arbre introuvable pour ${localRef}.`);
    pending.push({ ref: localRef, tree: tree.stdout.trim() });
  }
  if (!pending.length) return 0;
  const gstack = gstackDir();
  if (!gstack) return refuse('gstack est obligatoire mais n\'est pas installé (bash .claude/hooks/install-gstack.sh).');
  let rows;
  try { rows = reviewRows(gstack, cwd); } catch (e) {
    return refuse(`le journal de relecture gstack est illisible (${e.message}).`);
  }
  const notes = [];
  for (const { ref, tree } of pending) {
    const done = rows.filter(row => reviewedTree(row, tree));
    if (!done.length) {
      return refuse(rows.some(row => REVIEW_SKILLS.has(row.skill))
        ? `le dernier commit envoyé (${ref}) n'a pas exactement le contenu d'une relecture gstack terminée et convergée.`
        : `aucune relecture gstack n'a été faite sur cette branche (${ref}).`);
    }
    const last = done[done.length - 1];
    if (!(last.review_freshness && last.review_freshness.status === 'CURRENT') && (last.status !== 'clean' || last.issues_found > 0)) {
      notes.push(`${ref} : relecture terminée avec des remarques non résolues (statut ${last.status || 'inconnu'}, ` +
        `${last.issues_found || 0} remarque(s)) ; les signaler à l'utilisateur.`);
    }
  }
  if (notes.length) process.stderr.write(`Porte gstack : ${notes.join(' ')}\n`);
  return 0;
}

(async () => {
  if (String(process.env.GSTACK_GATE || '').toLowerCase() === 'off') return;
  const stdin = await readStdin();
  if (MODE === 'pre-push') {
    try { process.exitCode = onPrePush(stdin); } catch (e) {
      process.stderr.write(`\nPorte gstack : envoi refusé, contrôle impossible (${e && e.message}).\n\n`);
      process.exitCode = 1;
    }
    return;
  }
  const event = parseEvent(stdin);
  if (!event) return;
  if (MODE === 'skill') onSkill(event);
  else if (MODE === 'prompt') onPrompt(event);
  else if (MODE === 'edit') onEdit(event);
  else if (MODE === 'github') onGithub(event);
})().catch(e => {
  // Hook Claude Code : une erreur interne ne bloque jamais l'agent.
  process.stderr.write(`gstack-gate (${MODE}) : ${e && e.message}\n`);
});
