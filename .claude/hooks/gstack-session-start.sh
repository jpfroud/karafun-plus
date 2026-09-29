#!/usr/bin/env bash
# Démarrage de session d'un agent (Claude Code par .claude/settings.json ;
# tout autre agent peut le lancer lui-même, voir AGENTS.md) : vérifie que
# gstack est installé et rappelle le parcours obligatoire du projet.
#
# Il n'installe et ne télécharge rien : installer gstack reste une décision
# de l'utilisateur. Il ne bloque jamais le démarrage (code de sortie 0) ; le
# hook PreToolUse check-gstack.sh refuse ensuite les compétences si gstack
# manque.
#
#   bash .claude/hooks/gstack-session-start.sh [NomDeLÉvénement]

EVENT="${1:-SessionStart}"
case "$EVENT" in SessionStart|UserPromptSubmit) ;; *) EVENT=SessionStart ;; esac

# Le JSON de l'événement (entrée standard) n'est pas lu : un agent qui lance
# ce script sans fermer son entrée le bloquerait jusqu'à son délai.

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

RULES="Parcours obligatoire du projet : investigate pour un défaut, qa pour les parcours navigateur, review avant livraison. Après toute modification de la file, des duos, des présences ou des tables : node test/run-offline.js, puis consigner le résultat dans RAPPORT-TEST.md."
if [ -n "$GSTACK_DIR" ]; then
  MESSAGE="GSTACK_OK : gstack est installé ($GSTACK_DIR). $RULES"
else
  MESSAGE="GSTACK_MISSING : gstack est obligatoire dans ce dépôt mais n'est pas installé. Le signaler tout de suite à l'utilisateur, avant tout changement de code, avec la commande d'installation officielle : git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup --team (Codex : ./setup --host codex --prefix), puis redémarrer l'agent. Ne pas l'installer sans son accord. Sans gstack, faire les vérifications équivalentes et ne jamais prétendre avoir exécuté une compétence. $RULES"
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
