#!/usr/bin/env bash
# Installe gstack s'il manque. gstack est obligatoire dans ce dépôt et
# l'utilisateur a demandé qu'il s'installe tout seul : le hook SessionStart de
# Claude Code lance ce script, et tout autre agent le lance lui-même au début
# de sa session (voir AGENTS.md).
#
#   bash .claude/hooks/install-gstack.sh [claude|codex]
#
# Sans effet si gstack est déjà prêt pour cet agent. Code 0 : gstack est prêt
# et la sortie standard donne son dossier. Code 1 : la raison est sur la
# sortie d'erreur, le détail dans ~/.gstack/installation-auto.log.
#
# GSTACK_AUTO_INSTALL=0 : vérification seule, rien n'est installé.
# GSTACK_REPO_URL : autre dépôt que l'officiel (miroir, tests).
# GSTACK_INSTALL_BUDGET_SEC : durée maximale (570 s par défaut).

AGENT="${1:-claude}"
case "$AGENT" in claude|codex) ;; *) echo "Agent inconnu : $AGENT (claude ou codex)." >&2; exit 1 ;; esac

REPO_URL="${GSTACK_REPO_URL:-https://github.com/garrytan/gstack.git}"
TARGET="$HOME/.claude/skills/gstack"   # emplacement officiel, Codex compris
STATE="$HOME/.gstack"
LOG="$STATE/installation-auto.log"
LOCK="$STATE/installation-auto.lock"

# Même résolution que check-gstack.sh et que le mode équipe officiel.
find_gstack() {
  local candidate
  for candidate in "${GSTACK_ROOT:-}" "$HOME/.claude/skills/gstack" "$HOME/.codex/skills/gstack" \
    "$HOME/.factory/skills/gstack" "$HOME/.kiro/skills/gstack" "$HOME/.config/opencode/skills/gstack" \
    "$HOME/.slate/skills/gstack" "$HOME/.cursor/skills/gstack" "$HOME/.openclaw/skills/gstack" \
    "$HOME/.hermes/skills/gstack" "$HOME/.gbrain/skills/gstack" "$HOME/.gstack/repos/gstack"; do
    if [ -n "$candidate" ] && [ -d "$candidate/bin" ]; then printf '%s\n' "$candidate"; return 0; fi
  done
  return 1
}

# Codex ne voit gstack que si ses compétences gstack-* sont installées (même
# test que .codex/hooks/gstack-route.ps1), même quand GSTACK_ROOT désigne la
# source.
ready() {
  local dir
  dir="$(find_gstack)" || return 1
  if [ "$AGENT" = codex ] && [ ! -f "${CODEX_HOME:-$HOME/.codex}/skills/gstack-review/SKILL.md" ]; then
    return 1
  fi
  printf '%s\n' "$dir"
}

# Une installation en cours (verrou de moins de 15 minutes) : son dossier a
# déjà bin/ mais setup n'est pas fini, gstack n'est pas encore prêt.
installing() { [ -d "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; }

fail() { echo "$*" >&2; exit 1; }

# Le hook de démarrage est coupé au bout de 600 s : coupé en plein setup, il
# laisserait un gstack cloné (avec bin/) qui passerait pour installé. Le
# téléchargement et setup s'arrêtent donc d'eux-mêmes avant, et l'échec est
# traité normalement.
BUDGET="${GSTACK_INSTALL_BUDGET_SEC:-570}"
bounded() {
  local left=$((BUDGET - SECONDS))
  [ "$left" -gt 0 ] || return 124
  if command -v timeout >/dev/null 2>&1; then timeout "$left" "$@"; else "$@"; fi
}

# Garde la dernière installation ratée pour diagnostic, hors du dossier des
# compétences (sinon Claude Code la prendrait pour une compétence).
set_aside() { rm -rf "$STATE"/gstack.incomplet-*; mv "$1" "$STATE/gstack.incomplet-$(date +%s)"; }

installing || { ready && exit 0; }
[ "${GSTACK_AUTO_INSTALL:-1}" = 0 ] && fail "installation automatique désactivée (GSTACK_AUTO_INSTALL=0)."
command -v git >/dev/null 2>&1 || fail "git est introuvable."
command -v bun >/dev/null 2>&1 ||
  fail "bun est requis par gstack mais introuvable : l'installer depuis https://bun.sh, puis relancer l'agent."

# Deux sessions qui démarrent ensemble : la seconde attend la première. Un
# verrou de plus de 15 minutes vient d'une installation tuée en route (délai
# du hook dépassé) : il est retiré.
mkdir -p "$STATE" || fail "impossible de créer $STATE."
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null; continue; fi
  if [ "$waited" -ge "${GSTACK_LOCK_WAIT_SEC:-300}" ]; then
    fail "une autre installation de gstack est en cours ($LOCK) ; si elle est interrompue, supprimer ce dossier."
  fi
  sleep 2; waited=$((waited + 2))
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
ready && exit 0

{ echo; echo "== $(date -u '+%Y-%m-%dT%H:%M:%SZ') : installation de gstack pour $AGENT"; } >>"$LOG"

dir="$(find_gstack)"
cloned=""
if [ -z "$dir" ]; then
  # Un dossier sans bin/ est un reste d'installation interrompue.
  if [ -e "$TARGET" ]; then set_aside "$TARGET" || fail "dossier $TARGET inutilisable."; fi
  mkdir -p "$(dirname "$TARGET")"
  # Téléchargé hors du dossier des compétences : Claude Code n'y voit jamais
  # de gstack à moitié cloné.
  partial="$STATE/gstack.telechargement-$$"
  bounded git clone --depth 1 --single-branch "$REPO_URL" "$partial" >>"$LOG" 2>&1 || {
    code=$?; rm -rf "$partial"
    [ "$code" = 124 ] && fail "téléchargement de gstack trop long (plus de $BUDGET s, voir $LOG) ; il sera repris à la prochaine session."
    fail "téléchargement de gstack impossible depuis $REPO_URL (voir $LOG)."
  }
  mv "$partial" "$TARGET" || fail "impossible de placer gstack dans $TARGET."
  dir="$TARGET"; cloned=1
fi

# Commandes officielles : mode équipe pour Claude Code, noms gstack-* pour Codex.
if [ "$AGENT" = codex ]; then set -- --host codex --prefix; else set -- --team; fi
# Session web Claude Code : Chromium est déjà installé, setup ne le
# télécharge pas (le hook de démarrage indique son chemin à gstack).
skip_browser="${GSTACK_SKIP_PLAYWRIGHT:-0}"
if [ "${CLAUDE_CODE_REMOTE:-}" = true ] && [ -x "${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}/chromium" ]; then
  skip_browser=1
fi
( cd "$dir" && GSTACK_SKIP_PLAYWRIGHT="$skip_browser" bounded bash ./setup "$@" </dev/null ) >>"$LOG" 2>&1
code=$?
if [ "$code" != 0 ]; then
  # Le dépôt contient déjà bin/ : sans ce retrait, gstack passerait pour
  # installé et la session suivante ne réessaierait pas.
  [ -n "$cloned" ] && set_aside "$dir"
  [ "$code" = 124 ] && fail "installation de gstack trop longue (plus de $BUDGET s, voir $LOG) ; elle sera reprise à la prochaine session."
  fail "installation de gstack échouée (code $code, voir $LOG)."
fi
ready || fail "gstack installé mais introuvable pour $AGENT (voir $LOG)."
