# Développement de la file karaoké

Ce projet utilise [gstack](https://github.com/garrytan/gstack) pour les changements de code. **Chaque demande commence par le choix d'une commande gstack**, annoncé en une ligne avant de la lancer ; personne ne devrait avoir à écrire « utilise gstack » :

| La demande porte sur… | Commande |
|---|---|
| un défaut signalé, « pourquoi X » | `investigate` |
| une fonctionnalité à préciser | `spec` (un plan à challenger : `plan-eng-review`) |
| un parcours à essayer dans l'application | `qa` (`qa-only` pour un simple constat) |
| une modification écrite, avant commit, push ou PR | `review` |
| la sécurité | `cso` |
| l'état du code | `health` |
| la documentation après un changement | `document-release` |

Dans Codex, ces compétences s'appellent `gstack-investigate`, `gstack-review`, etc. Si aucune ne convient (simple question), écrire « aucune commande gstack : <raison> » ; ne jamais passer ce choix sous silence. En cas d'indisponibilité d'une compétence, le signaler et faire la vérification équivalente ; ne jamais prétendre l'avoir exécutée.

**Application par les hooks de Claude Code** (`.claude/settings.json`, sur le modèle de [RetroGemini](https://github.com/republique-et-canton-de-geneve/RetroGemini)) :

| Hook | Événement | Rôle |
|---|---|---|
| `gstack-session-start.sh` | `SessionStart` | installe gstack s'il manque (ci-dessous) |
| `gstack-session-start.sh` | `UserPromptSubmit` | ajoute la table de routage ci-dessus à chaque demande |
| `check-gstack.sh` | `PreToolUse` sur `Skill` | garde-fou officiel du mode équipe : refuse les compétences sans gstack |
| `gstack-gate.js` | `PostToolUse` sur `Skill`, `UserPromptSubmit` | note les compétences gstack lancées (outil `Skill` ou commande `/investigate` tapée) |
| `gstack-gate.js` | `PreToolUse` sur `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | refuse toute modification du dépôt tant qu'aucune compétence gstack n'a été lancée dans la session (sous-agents compris) ; `RAPPORT-TEST.md`, `.gstack/`, `data/` et `journal/` restent libres |
| `gstack-gate.js` | `PreToolUse` sur `Bash` (`git push`, `gh pr create`) et les envois GitHub | refuse l'envoi tant qu'une relecture `review` n'a pas été menée à son terme sur le contenu exact du dépôt (journal de relecture de gstack, `gstack-review-read`) ; une relecture terminée avec des remarques laisse passer, à signaler à l'utilisateur |

Les modifications faites par une commande `Bash` (redirection, `sed`) échappent à la porte des modifications, pas à celle de l'envoi. `GSTACK_GATE=off` dans l'environnement de Claude Code coupe la porte : décision réservée à l'utilisateur. Un changement de ces hooks s'applique à la session suivante (Claude Code les lit au démarrage). Relancer `gstack-team-init required` réécrit `check-gstack.sh` et `.claude/settings.json` : rajouter ensuite les autres hooks. Tests : `bash test/gstack-session-hook.test.sh` et `node test/gstack-gate.test.js` (aussi lancés par la CI).

**Au début de chaque session, quel que soit l'agent**, s'assurer que gstack est installé avant tout changement de code. L'utilisateur a donné son accord pour l'installer automatiquement :

- Claude Code : son hook `SessionStart` (`.claude/hooks/gstack-session-start.sh`) lance `install-gstack.sh` si gstack manque ;
- Codex : le hook `SessionStart` de `.codex/hooks.json` signale `GSTACK_MISSING` ; lancer alors `bash .claude/hooks/install-gstack.sh codex` depuis la racine du dépôt (Git Bash sous Windows), puis faire redémarrer Codex ;
- tout autre agent : lancer lui-même `bash .claude/hooks/install-gstack.sh` (code 0 et dossier affiché : gstack est prêt).

gstack prêt (`GSTACK_OK`) : suivre le parcours ci-dessus. Échec de l'installation : le dire tout de suite à l'utilisateur avec la raison affichée (git ou bun manquant, réseau…), faire les vérifications équivalentes et ne jamais prétendre avoir exécuté une compétence.

Dans Codex, les compétences sont installées sous les noms `gstack-*` par `setup --host codex --prefix` (c'est ce que lance `install-gstack.sh codex`). Choisir la compétence en début de tâche et noter dans le rapport celle qui a réellement été appliquée. Les hooks Claude Code du projet installent gstack s'il manque et rappellent ce parcours à chaque demande. Le hook Codex de `.codex/hooks.json` vérifie gstack au démarrage et rappelle ce parcours à chaque demande ; après clonage, l'examiner et l'approuver dans `/hooks`. Il se termine sans bloquer Codex en cas d'erreur. Ce rappel ne prouve pas qu'une compétence a été exécutée : `gstack-review` reste exigé par cette consigne avant livraison.

Pour tout changement qui touche la file, les duos, les présences ou les tables : ajouter des tests de régression ciblés, lancer la suite hors ligne avec `node test/run-offline.js`, puis vérifier dans l'interface concernée. Ne pas utiliser la session KaraFun réelle pour les tests destructifs ; la simulation locale est prévue à cet effet. Mettre à jour `RAPPORT-TEST.md` avec les résultats observés et les limites.

## Health Stack

- test: node test/run-offline.js

