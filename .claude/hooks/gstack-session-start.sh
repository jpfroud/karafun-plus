#!/usr/bin/env bash
# Hook de Claude Code (.claude/settings.json) ; tout autre agent peut le
# lancer lui-même, voir AGENTS.md.
#
#   bash .claude/hooks/gstack-session-start.sh [SessionStart|UserPromptSubmit]
#
# SessionStart : installe gstack s'il manque (install-gstack.sh, demandé par
# l'utilisateur) puis rappelle le parcours obligatoire du projet.
# UserPromptSubmit : à chaque demande, sans rien installer, donne la table de
# routage des commandes gstack et exige d'annoncer celle qui est choisie (sur
# le modèle de RetroGemini). Ne bloque jamais l'agent (code de sortie 0) : les
# blocages viennent de check-gstack.sh (compétences refusées sans gstack) et de
# gstack-gate.js (modification sans compétence gstack, envoi sans relecture).

EVENT="${1:-SessionStart}"
case "$EVENT" in SessionStart|UserPromptSubmit) ;; *) EVENT=SessionStart ;; esac

# Le JSON de l'événement (entrée standard) n'est pas lu : un agent qui lance
# ce script sans fermer son entrée le bloquerait jusqu'à son délai.

HOOKS_DIR="$(cd "$(dirname "$0")" && pwd)"

# Même résolution que check-gstack.sh et que le mode équipe officiel.
GSTACK_DIR=""
for candidate in "${GSTACK_ROOT:-}" "$HOME/.claude/skills/gstack" "$HOME/.codex/skills/gstack" \
  "$HOME/.factory/skills/gstack" "$HOME/.kiro/skills/gstack" "$HOME/.config/opencode/skills/gstack" \
  "$HOME/.slate/skills/gstack" "$HOME/.cursor/skills/gstack" "$HOME/.openclaw/skills/gstack" \
  "$HOME/.hermes/skills/gstack" "$HOME/.gbrain/skills/gstack" "$HOME/.gstack/repos/gstack"; do
  if [ -z "$GSTACK_DIR" ] && [ -n "$candidate" ] && [ -d "$candidate/bin" ]; then
    GSTACK_DIR="$candidate"
  fi
done

# Installation lancée par une autre session et pas encore finie : bin/ existe
# déjà, mais gstack n'est prêt qu'à la fin de setup. install-gstack.sh attend
# alors son verrou (même chemin et même délai de péremption).
LOCK="$HOME/.gstack/installation-auto.lock"
in_progress() { [ -d "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; }

INSTALLED=""
REASON=""
if [ "$EVENT" = SessionStart ] && { [ -z "$GSTACK_DIR" ] || in_progress; }; then
  ERRORS="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/gstack-installation-$$")"
  GSTACK_DIR="$(bash "$HOOKS_DIR/install-gstack.sh" claude 2>"$ERRORS" </dev/null | tail -n 1)"
  REASON="$(tail -n 1 "$ERRORS" 2>/dev/null)"
  rm -f "$ERRORS"
  [ -n "$GSTACK_DIR" ] && [ -d "$GSTACK_DIR/bin" ] && INSTALLED=1 || GSTACK_DIR=""
fi

# Session web : gstack se sert du Chromium déjà installé.
CHROMIUM="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}/chromium"
if [ "$EVENT" = SessionStart ] && [ "${CLAUDE_CODE_REMOTE:-}" = true ] && [ -n "${CLAUDE_ENV_FILE:-}" ] &&
   [ -z "${GSTACK_CHROMIUM_PATH:-}" ] && [ -x "$CHROMIUM" ]; then
  printf 'export GSTACK_CHROMIUM_PATH=%q\n' "$CHROMIUM" >>"$CLAUDE_ENV_FILE"
fi

# Table de routage : courte, elle est ajoutée à chaque demande.
ROUTING="Avant d'agir, choisir la commande gstack adaptée à cette demande, l'annoncer en une ligne et la lancer avec l'outil Skill : défaut signalé ou « pourquoi X » → investigate ; fonctionnalité à préciser → spec (plan à challenger → plan-eng-review) ; parcours dans l'application → qa (qa-only pour un simple constat) ; modification écrite, avant commit, push ou PR → review ; sécurité → cso ; état du code → health ; documentation après un changement → document-release. Si aucune ne convient (simple question), écrire « aucune commande gstack : <raison> » ; ne jamais passer ce choix sous silence. Les hooks refusent toute modification du dépôt tant qu'aucune compétence gstack n'a été lancée dans la session, puis git push et la PR sans relecture review terminée sur le contenu exact."
RULES="Parcours obligatoire du projet : investigate pour un défaut, qa pour les parcours navigateur, review avant livraison. Après toute modification de la file, des duos, des présences ou des tables : node test/run-offline.js, puis consigner le résultat dans RAPPORT-TEST.md."
RETRY="L'utilisateur a donné son accord : pour réessayer, lancer bash .claude/hooks/install-gstack.sh puis redémarrer l'agent. En attendant, faire les vérifications équivalentes et ne jamais prétendre avoir exécuté une compétence."
if [ "$EVENT" = UserPromptSubmit ]; then
  if [ -n "$GSTACK_DIR" ]; then
    MESSAGE="gstack : $ROUTING $RULES"
  else
    MESSAGE="GSTACK_MISSING : gstack est obligatoire mais pas installé. Le dire à l'utilisateur avant tout changement de code. $RETRY $RULES"
  fi
elif [ -n "$INSTALLED" ]; then
  MESSAGE="GSTACK_OK : gstack vient d'être installé automatiquement ($GSTACK_DIR). $ROUTING $RULES"
elif [ -n "$GSTACK_DIR" ]; then
  MESSAGE="GSTACK_OK : gstack est installé ($GSTACK_DIR). $ROUTING $RULES"
else
  MESSAGE="GSTACK_MISSING : gstack est obligatoire dans ce dépôt et son installation automatique a échoué : ${REASON:-raison inconnue}. Le dire tout de suite à l'utilisateur, avant tout changement de code. $RETRY $RULES"
fi

json_escape() {
  local text="$1"
  text="${text//\\/\\\\}"
  text="${text//\"/\\\"}"
  text="${text//$'\n'/ }"
  text="${text//$'\r'/ }"
  text="${text//$'\t'/ }"
  printf '%s' "$text"
}

printf '{"hookSpecificOutput":{"hookEventName":"%s","additionalContext":"%s"}}\n' \
  "$EVENT" "$(json_escape "$MESSAGE")"
exit 0
