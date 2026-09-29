#!/usr/bin/env bash
# Hooks Claude Code du projet : vérification de gstack au démarrage (sans
# jamais rien installer) et refus des compétences si gstack manque.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
START="$ROOT/.claude/hooks/gstack-session-start.sh"
CHECK="$ROOT/.claude/hooks/check-gstack.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "ÉCHEC : $*" >&2; exit 1; }

# Lit hookSpecificOutput.<champ> dans un JSON (échoue si le JSON est invalide).
field() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(String(j.hookSpecificOutput[process.argv[1]]))' "$1"; }

run_start() { printf '%s' '{"hook_event_name":"SessionStart","source":"startup"}' | env -u GSTACK_ROOT HOME="$1" bash "$START"; }
run_check() { printf '%s' '{"tool_name":"Skill"}' | env -u GSTACK_ROOT HOME="$1" bash "$CHECK" 2>/dev/null; }

# 1. gstack absent : rappel non bloquant, rien n'est créé ni téléchargé.
empty="$WORK/vide"; mkdir -p "$empty"
out="$(run_start "$empty")" || fail "le démarrage ne doit jamais échouer"
[ "$(printf '%s' "$out" | field hookEventName)" = "SessionStart" ] || fail "événement SessionStart attendu"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_MISSING' || fail "absence de gstack non signalée"
printf '%s' "$out" | field additionalContext | grep -q "Ne pas l'installer sans son accord" || fail "consigne d'accord absente"
[ -z "$(ls -A "$empty")" ] || fail "le hook de démarrage ne doit rien installer"
out="$(run_check "$empty")"; code=$?
[ "$code" = "2" ] || fail "les compétences doivent être refusées sans gstack (code $code)"
[ "$(printf '%s' "$out" | field permissionDecision)" = "deny" ] || fail "refus PreToolUse attendu"

# 2. Installation Claude Code, Codex ou dépôt migré : tout est accepté.
for dir in .claude/skills/gstack .codex/skills/gstack .gstack/repos/gstack; do
  home="$WORK/home-${dir//\//_}"; mkdir -p "$home/$dir/bin"
  out="$(run_start "$home")" || fail "démarrage ($dir)"
  printf '%s' "$out" | field additionalContext | grep -q "^GSTACK_OK : gstack est installé ($home/$dir)" || fail "gstack non trouvé dans $dir"
  [ "$(run_check "$home")" = "{}" ] || fail "compétences refusées alors que gstack est dans $dir"
done

# 3. Chemin avec guillemets et barres obliques inverses : JSON toujours valide
#    (noms interdits par Windows : vérifié ailleurs).
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *) odd="$WORK/a\"b\\c"; mkdir -p "$odd/.claude/skills/gstack/bin"
     run_start "$odd" | field additionalContext | grep -q 'GSTACK_OK' || fail "JSON invalide pour un chemin inhabituel" ;;
esac

# 4. GSTACK_ROOT explicite et événement inconnu ramené à SessionStart.
custom="$WORK/custom"; mkdir -p "$custom/bin"
out="$(printf '{}' | HOME="$empty" GSTACK_ROOT="$custom" bash "$START" Autre)"
[ "$(printf '%s' "$out" | field hookEventName)" = "SessionStart" ] || fail "événement par défaut"
printf '%s' "$out" | field additionalContext | grep -q "($custom)" || fail "GSTACK_ROOT ignoré"

# 5. Lancé à la main par un agent dont l'entrée standard reste ouverte : le
#    hook ne l'attend pas (auparavant bloqué jusqu'au délai de l'agent).
# Regression: ISSUE-001 — hook de démarrage bloqué par une entrée standard ouverte
# Found by /review on 2026-09-29
# Report: .gstack/qa-reports/run-20260929T220650Z/qa-report-127.0.0.1-2026-09-29.md
started=$(date +%s)
out="$(HOME="$empty" bash "$START" < <(sleep 20))" || fail "démarrage avec entrée ouverte"
[ $(( $(date +%s) - started )) -lt 10 ] || fail "le hook attend une entrée standard qui ne se ferme pas"
printf '%s' "$out" | field additionalContext | grep -q '^GSTACK_MISSING' || fail "sortie invalide avec entrée ouverte"

# 6. Les réglages du projet enregistrent bien les deux hooks.
SETTINGS="$ROOT/.claude/settings.json"
command -v cygpath >/dev/null 2>&1 && SETTINGS="$(cygpath -w "$SETTINGS")"
node -e '
const s = require(process.argv[1]);
const start = s.hooks.SessionStart?.[0]?.hooks?.[0]?.command || "";
const pre = s.hooks.PreToolUse?.find(e => e.matcher === "Skill")?.hooks?.[0]?.command || "";
if (!start.includes("gstack-session-start.sh") || !pre.includes("check-gstack.sh")) process.exit(1);
' "$SETTINGS" || fail "hooks absents de .claude/settings.json"

echo "Hooks gstack Claude Code : vérification au démarrage sans installation, refus des compétences sans gstack OK"
