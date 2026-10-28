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
| `gstack-session-start.sh` | `SessionStart` | installe gstack s'il manque (ci-dessous) et le hook git `pre-push` de la porte |
| `gstack-session-start.sh` | `UserPromptSubmit` | ajoute la table de routage ci-dessus à chaque demande |
| `check-gstack.sh` | `PreToolUse` sur `Skill` | garde-fou officiel du mode équipe : refuse les compétences sans gstack |
| `gstack-gate.js` | `PostToolUse` sur `Skill`, `UserPromptSubmit` | note les compétences gstack lancées (outil `Skill` ou commande `/investigate` tapée) |
| `gstack-gate.js` | `PreToolUse` sur `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | refuse toute modification du dépôt tant qu'aucune compétence gstack n'a été lancée dans la session (sous-agents compris) ; `RAPPORT-TEST.md`, `.gstack/` (sauf `.gstack/porte/`, l'état de la porte), `data/`, `journal/` et `node_modules/` restent libres |
| `pre-push` (hook git) | `git push` lancé par Claude Code (`CLAUDECODE=1`) | refuse l'envoi si le dernier commit envoyé sur une branche ou une étiquette n'a pas exactement l'arbre d'une relecture `/review` terminée et convergée (journal de relecture de gstack, `gstack-review-read`) ; les commits intermédiaires ne sont pas comparés ; un commit déjà présent sur le serveur, une étiquette de version déjà publiée et une suppression passent ; une relecture terminée avec des remarques laisse passer, à signaler à l'utilisateur |
| `gstack-gate.js` | `PreToolUse` sur l'écriture de fichiers par l'API GitHub | refuse `push_files`, `create_or_update_file` et `delete_file` vers ce dépôt : les fichiers partent par `git push` |

Le hook `pre-push` est copié dans le dossier des hooks du dépôt (`.git/hooks/`, commun aux worktrees) au démarrage de chaque session, sauf si un autre hook `pre-push` existe ou si `core.hooksPath` est réglé (le message de démarrage le signale). C'est git qui l'appelle : l'écriture de la commande (`git -C`, alias, worktree lié) n'y change rien, et les `git push` tapés par l'utilisateur ou lancés par Codex ne sont pas concernés. Les modifications faites par une commande `Bash` (redirection, `sed`) échappent à la porte des modifications, pas à celle de l'envoi. La porte guide l'agent ; ce n'est pas une barrière de sécurité : le journal de relecture repose sur ce que déclare la relecture. Le hook `pre-push` protège contre un envoi non relu fait **par mégarde** par Claude Code, pas contre un contournement voulu : `git push --no-verify`, une référence `refs/remotes/…` locale forgée (le commit paraît « déjà sur le serveur »), `CLAUDECODE` absent de l'environnement, `GSTACK_GATE=off`, ou une modification de la porte elle-même dans la copie de travail la font passer. La vraie barrière est la protection de branche de GitHub (relecture et CI exigées avant fusion). `GSTACK_GATE=off` dans l'environnement de Claude Code coupe la porte : décision réservée à l'utilisateur. Relancer `gstack-team-init required` réécrit `check-gstack.sh` et `.claude/settings.json` : rajouter ensuite les autres hooks. Tests : `bash test/gstack-session-hook.test.sh`, `node test/gstack-gate.test.js` et `test/gstack-hook.test.ps1` (lancés par la CI).

**Verrou `freeze` de gstack et travail en parallèle** : `investigate` pose un verrou de modification global (`~/.gstack/freeze-dir.txt`) sur le dossier étudié. Avec plusieurs agents en parallèle dans des worktrees, le premier verrou bloque les autres ; choisir alors un verrou commun avec `/freeze` (décision de l'utilisateur) et le retirer avec `/unfreeze` à la fin.

**Au début de chaque session, quel que soit l'agent**, s'assurer que gstack est installé avant tout changement de code. L'utilisateur a donné son accord pour l'installer automatiquement :

- Claude Code : son hook `SessionStart` (`.claude/hooks/gstack-session-start.sh`) lance `install-gstack.sh` si gstack manque ;
- Codex : le hook `SessionStart` de `.codex/hooks.json` signale `GSTACK_MISSING` ; lancer alors `bash .claude/hooks/install-gstack.sh codex` depuis la racine du dépôt (Git Bash sous Windows), puis faire redémarrer Codex ;
- tout autre agent : lancer lui-même `bash .claude/hooks/install-gstack.sh` (code 0 et dossier affiché : gstack est prêt).

gstack prêt (`GSTACK_OK`) : suivre le parcours ci-dessus. Échec de l'installation : le dire tout de suite à l'utilisateur avec la raison affichée (git ou bun manquant, réseau…), faire les vérifications équivalentes et ne jamais prétendre avoir exécuté une compétence.

Dans Codex, les compétences sont installées sous les noms `gstack-*` par `setup --host codex --prefix` (c'est ce que lance `install-gstack.sh codex`). Choisir la compétence en début de tâche et noter dans le rapport celle qui a réellement été appliquée. Les hooks Claude Code du projet installent gstack s'il manque et rappellent ce parcours à chaque demande. Le hook Codex de `.codex/hooks.json` vérifie gstack au démarrage et rappelle ce parcours à chaque demande ; après clonage, l'examiner et l'approuver dans `/hooks`. Il se termine sans bloquer Codex en cas d'erreur. Ce rappel ne prouve pas qu'une compétence a été exécutée : `gstack-review` reste exigé par cette consigne avant livraison.

Pour tout changement qui touche la file, les duos, les présences ou les tables : ajouter des tests de régression ciblés, lancer la suite hors ligne avec `node test/run-offline.js`, puis vérifier dans l'interface concernée. Ne pas utiliser la session KaraFun réelle pour les tests destructifs ; la simulation locale est prévue à cet effet. Mettre à jour `RAPPORT-TEST.md` avec les résultats observés et les limites.

**Bilan avant/après sur une vraie soirée** (demande de l'utilisateur du 16 octobre 2026) : tout changement de la rotation ou des temps d'attente (choix du passage, tours, dettes, duos, présences, `QueueScore.java`, statistiques d'attente) est jugé sur les statistiques d'une soirée réelle, pas sur les seuls tests.

- Rejouer la dernière soirée exportée fournie par l'utilisateur (bouton « Exporter » des statistiques), sinon la copie anonymisée `test/fixtures/soiree-2026-10-15-anonyme.json` : `node test/rejeu-soiree.js <export.json> --avant <commit de départ de la branche> --solveur`. L'ordonnanceur de l'ancienne version (révision git extraite à part dans `.git/karafun-rejeu`, son jar Timefold construit par Maven) et celui de la version de travail rejouent la même soirée dans les mêmes conditions ; les deux sont mesurés par `evening-stats.js` d'aujourd'hui. Avec Timefold, comme au bar ; sans Timefold, les deux versions peuvent donner le même ordre alors qu'elles diffèrent au bar. Ce qu'apporte Timefold lui-même : `--avant . --solveur --solveur-avant sans` (même code, sans puis avec). Les déplacements et « Priorité » du bar (et leurs annulations) ne sont rejoués qu'avec `--gestes`, à leur heure et à la même place de la file rejouée : à ajouter pour un changement qui touche ces gestes, sur une soirée qui en contient (sinon le bilan n'en dit rien). Fidélité : la version de la soirée, avec Timefold, doit refaire l'ordre vécu (ligne « ordre vécu refait » du bilan) ; sinon, le dire et lire le bilan avec prudence. Timefold y est limité en mouvements (20 000 par décision, `--mouvements`), pas en temps : le bilan est le même sur toute machine, même chargée ; une ligne « ATTENTION Timefold arrêté au plafond » demande de le relancer sur une machine libre.
- Donner à l'utilisateur, dans la réponse, le bilan chiffré : titres chantés ; attente par titre (moyenne, médiane, 9 sur 10, plus longue, titres à 45 et 60 min) ; plus longue attente sans monter sur scène ; équilibre des passages (indice de Jain sur les passages par heure de présence, part la plus haute et la plus basse, jamais passés) ; anomalies (attente plus longue que le plus long tour, quelqu'un vu deux fois, prêt tout un tour sans passer) ; personnes qui y perdent et qui y gagnent ; titres dont l'attente change de 5 min ou plus. La colonne « réel » (soirée vécue, gestes du bar compris) sert de repère ; le verdict compare avant et après.
- Un changement qui déséquilibre les passages (Jain en baisse, des gens qui passent plus que d'autres, quelqu'un qui perd un passage ou attend nettement plus) n'est pas bon, même si une autre attente baisse : le dire, et ne le livrer qu'avec l'accord explicite de l'utilisateur.
- Reporter le bilan dans `RAPPORT-TEST.md` et dans la PR avec les clés S01… et T1… (option `--cles` de l'outil) : jamais de prénom ni de nom de table dans le dépôt, public. La sortie avec prénoms reste hors du dépôt.

**Cohérence des deux modes** : la file tourne en mode PC (kit Windows, lanceurs `.bat`) ou en mode serveur (`--server` ou `KARAOKE_MODE=server`, image Docker derrière Caddy).

- Un texte qui parle du PC, des `.bat`, du Wi-Fi local, de `localhost` ou d'une clé qui change à chaque démarrage a sa variante serveur : `app.mode === 'server'` dans la page, `SERVER` dans `server.js`, `DEPLOIEMENT-SERVEUR.md` dans les documents.
- Un texte du mode PC ne change qu'avec son test, et ce changement est signalé dans le résumé : `test/startup-port.test.js`, `test/staff-ui-coverage.test.js`, `test/server-table-routes.test.js`, `test/kcs-connection.test.js`, `test/kcs-protocol.test.js`, `test/kcs-ratelimit.test.js`, `test/cli-persistence.test.js`, `test/server-mode.test.js`, `test/server-mode-startup.test.js`.
- Une règle « deux modes » a un test dans chaque mode.
- Toucher une variable `KARAOKE_*`, une option de `server.js`, `deploy/`, le `Dockerfile` ou `livrable.json` met à jour `DEPLOIEMENT-SERVEUR.md` (`test/documentation.test.js` le vérifie en partie).
- Aucun nom d'hôte ni adresse réels dans le dépôt : `exemple.fr` et les adresses de documentation.
- CI Windows et Linux vertes, job `image` compris, avant toute fusion.

## Health Stack

- test: node test/run-offline.js

