# Développement de la file karaoké

Ce projet utilise [gstack](https://github.com/garrytan/gstack) pour les changements de code. Avant de modifier le comportement, choisir et appliquer le parcours adapté : `gstack-investigate` pour un bug, `gstack-spec` ou `gstack-plan-eng-review` pour une fonctionnalité à préciser, `gstack-qa` pour essayer l'application dans un navigateur, et `gstack-review` avant de livrer. Une modification simple peut commencer directement, mais elle passe aussi par `gstack-review` avant livraison. En cas d'indisponibilité d'une compétence, le signaler et faire la vérification équivalente ; ne jamais prétendre l'avoir exécutée.

**Au début de chaque session, quel que soit l'agent**, vérifier gstack avant tout changement de code : Claude Code le fait par son hook `SessionStart` (`.claude/hooks/gstack-session-start.sh`), Codex par le hook `SessionStart` de `.codex/hooks.json` ; tout autre agent lance lui-même `bash .claude/hooks/gstack-session-start.sh`. Réponse `GSTACK_OK` : suivre le parcours ci-dessus. Réponse `GSTACK_MISSING` : le dire tout de suite à l'utilisateur avec la commande d'installation affichée ; ne pas l'installer sans son accord.

Dans Codex, les compétences sont installées sous les noms `gstack-*` par `setup --host codex --prefix`. Choisir la compétence en début de tâche et noter dans le rapport celle qui a réellement été appliquée. Le hook Claude Code du projet vérifie que gstack est installé. Le hook Codex de `.codex/hooks.json` vérifie gstack au démarrage et rappelle ce parcours à chaque demande ; après clonage, l'examiner et l'approuver dans `/hooks`. Il se termine sans bloquer Codex en cas d'erreur. Ce rappel ne prouve pas qu'une compétence a été exécutée : `gstack-review` reste exigé par cette consigne avant livraison.

Pour tout changement qui touche la file, les duos, les présences ou les tables : ajouter des tests de régression ciblés, lancer la suite hors ligne avec `node test/run-offline.js`, puis vérifier dans l'interface concernée. Ne pas utiliser la session KaraFun réelle pour les tests destructifs ; la simulation locale est prévue à cet effet. Mettre à jour `RAPPORT-TEST.md` avec les résultats observés et les limites.

## Health Stack

- test: node test/run-offline.js

