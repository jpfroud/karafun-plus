# Publier une version : kit Windows et image Docker

Après fusion : **Actions → Release → Run workflow**, branche `main`, version neuve comme `v0.1.0`. Jobs : `tests` (et les SBOM), `kit-windows` (ZIP testé, SHA-256), `image` (linux/amd64 et linux/arm64, vérifiée par `test/verifier-image.sh`), `publier` (tag, étiquettes, release, empreinte dans les notes, puis SBOM et attestations de provenance). Un échec ne publie rien, sauf une attestation, faite en dernier : la release reste complète et installable, relancer le job `publier` dans les 24 heures la refait (le kit, les SBOM et l'empreinte de l'image construits ne sont gardés qu'un jour) ; plus tard, relancer tout le workflow avec la même version reconstruit le kit et l'image, avec une nouvelle empreinte. Un tag `v*` envoyé déclenche aussi le workflow ; une version d'un autre commit est refusée ; une relance remplace fichiers, étiquettes et empreinte. La publication est construite sans aucun cache, à partir de dépendances téléchargées à neuf.

**Kit Windows.** Télécharger l'archive depuis la page **Releases** du dépôt, vérifier son empreinte avec `Get-FileHash KIT-BAR-KARAFUN.zip -Algorithm SHA256`, puis copier le ZIP sur le PC du bar. Avec GitHub CLI, `gh attestation verify KIT-BAR-KARAFUN.zip --repo jpfroud/karafun-plus` vérifie aussi qu'il sort de ce workflow (attestation jointe : `KIT-BAR-KARAFUN.zip.sigstore.json`). Après extraction, double-cliquer sur `KaraFun Plus.exe`. KaraFun doit être installé séparément. Le JAR Timefold, Node.js et Java 25 sont inclus dans le kit ; les notices se trouvent sous `LICENCES-JAVA/`, `node/LICENSE` et `solver-runtime/legal/`.

**Image Docker.** `ghcr.io/jpfroud/karafun-plus:vX.Y.Z`. `latest` suit la plus haute version sans suffixe ; le serveur fixe `KARAFUN_PLUS_VERSION` dans `deploy/.env` (voir `DEPLOIEMENT-SERVEUR.md`). Provenance : `gh attestation verify oci://ghcr.io/jpfroud/karafun-plus:vX.Y.Z --repo jpfroud/karafun-plus`.

**SBOM.** Chaque release joint `karafun-plus-vX.Y.Z-npm.cdx.json` (dépendances npm de production) et `karafun-plus-vX.Y.Z-solveur.cdx.json` (optimiseur Java), au format CycloneDX.

Avec l'agent hôte installé, les gérants utilisent **Plus → Mise à jour → Vérifier et mettre à jour**,
en un clic hors soirée, ou avec confirmation pendant une soirée. La même carte propose aussi
d'**installer une autre version publiée**, en général la précédente, quand une nouvelle version pose problème.
Les tables, les chansons et l'ordre adopté sont conservés ;
l'agent ne traite qu'une release stable entièrement publiée avec son empreinte d'image ;
il sauvegarde, vérifie le démarrage et remet l'état précédent si l'installation échoue.
Les instructions de première installation et la procédure manuelle restent dans le guide serveur.

**Retirer une version défectueuse ou vulnérable.** La marquer « Pre-release » sur la page de la release :
l'agent ne la propose plus au retour à une version précédente et refuse de l'installer ; `latest`
de GitHub l'ignore aussi. Publier ensuite une version corrigée.

**Veille.** Le workflow « Sécurité » analyse chaque lundi l'image `latest` publiée : s'il échoue, une faille
corrigeable touche la version installée sur les serveurs. Fusionner les PR de Dependabot en attente
(images de base, dépendances), puis publier une nouvelle version : la carte « Mise à jour » l'installera.
Le workflow « Veille des versions » ouvre chaque lundi une issue quand une nouvelle LTS paraît ou qu'une fin de support
approche : la montée se fait dans une PR d'un seul tenant (`SECURITY.md`, « Règle de la dernière LTS »).

**Une seule fois :**

1. https://github.com/users/jpfroud/packages/container/karafun-plus/settings : « Change visibility » → « Public » (irréversible) ; « Manage Actions access » : `karafun-plus` en « Write ».
2. Après `docker logout ghcr.io`, `docker manifest inspect ghcr.io/jpfroud/karafun-plus:vX.Y.Z` liste les deux plateformes.
3. `main` protégée : exiger « Tests OK » et « Sécurité OK ». Les autres réglages de sécurité du dépôt (alertes et correctifs Dependabot, analyse des secrets, signalement privé, fusion automatique) sont listés dans `SECURITY.md`.
