# Publier une version : kit Windows et image Docker

Après fusion : **Actions → Release → Run workflow**, branche `main`, version neuve comme `v0.1.0`. Jobs : `tests`, `kit-windows` (ZIP testé, SHA-256), `image` (linux/amd64 et linux/arm64, vérifiée par `test/verifier-image.sh`), `publier` (tag, étiquettes, release, empreinte dans les notes). Un échec ne publie rien. Un tag `v*` envoyé déclenche aussi le workflow ; une version d'un autre commit est refusée ; une relance remplace fichiers, étiquettes et empreinte.

**Kit Windows.** Télécharger l'archive depuis la page **Releases** du dépôt, vérifier son empreinte avec `Get-FileHash KIT-BAR-KARAFUN.zip -Algorithm SHA256`, puis copier le ZIP sur le PC du bar. Après extraction, double-cliquer sur `KaraFun Plus.exe`. KaraFun doit être installé séparément. Le JAR Timefold, Node.js et Java 21 sont inclus dans le kit ; les notices se trouvent sous `LICENCES-JAVA/`, `node/LICENSE` et `solver-runtime/legal/`.

**Image Docker.** `ghcr.io/jpfroud/karafun-plus:vX.Y.Z`. `latest` suit la plus haute version sans suffixe ; le serveur fixe `KARAFUN_PLUS_VERSION` dans `deploy/.env` (voir `DEPLOIEMENT-SERVEUR.md`).

Avec l'agent hôte installé, les gérants utilisent **Plus → Mise à jour → Vérifier et mettre à jour**,
en un clic hors soirée, ou avec confirmation pendant une soirée. Les tables, les chansons et l'ordre adopté sont conservés ;
l'agent ne traite qu'une release stable entièrement publiée avec son empreinte d'image ;
il sauvegarde, vérifie le démarrage et remet l'état précédent si l'installation échoue.
Les instructions de première installation et la procédure manuelle restent dans le guide serveur.

**Une seule fois :**

1. https://github.com/users/jpfroud/packages/container/karafun-plus/settings : « Change visibility » → « Public » (irréversible) ; « Manage Actions access » : `karafun-plus` en « Write ».
2. Après `docker logout ghcr.io`, `docker manifest inspect ghcr.io/jpfroud/karafun-plus:vX.Y.Z` liste les deux plateformes.
3. `main` protégée : exiger `offline-tests`, `linux` et `image`.
