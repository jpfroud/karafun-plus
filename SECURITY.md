# Politique de sécurité

## Signaler une faille

Ne pas ouvrir d'issue publique. Utiliser le signalement privé de GitHub :
**Security → Report a vulnerability**, ou directement
https://github.com/jpfroud/karafun-plus/security/advisories/new. Décrire la
version touchée (page du bar, carte « Mise à jour »), le mode (kit Windows ou
serveur Linux), les étapes pour reproduire et l'impact. Ne joindre ni code de
télécommande KaraFun, ni clé du bar, ni export de soirée avec des prénoms.

Le mainteneur répond dans le fil du signalement, corrige dans une nouvelle
release, puis publie l'avis de sécurité une fois la correction disponible.

## Versions maintenues

Seule la **dernière release** reçoit les correctifs. Une version plus ancienne
reste installable par le retour à une version précédente (carte
« Mise à jour », `DEPLOIEMENT-SERVEUR.md`, section 17) pour contourner un
défaut, jamais comme solution durable. Une release retirée pour une faille est
marquée « Pre-release » sur GitHub : l'agent de mise à jour du VPS ne la propose
plus et refuse de l'installer.

## Ce qui est automatisé

| Domaine | Mise en place | Où |
|---|---|---|
| Dépendances npm, Maven, actions, images Docker | Dependabot chaque lundi, alertes de sécurité aussitôt ; délai de 7 jours avant d'adopter une nouvelle version (une version piégée est souvent retirée entre-temps) | `.github/dependabot.yml` |
| Nouvelles LTS, fins de support, outils hors Dependabot | Veille chaque lundi : une seule issue, assignée au propriétaire du dépôt (ci-dessous) | `.github/workflows/veille-versions.yml` |
| Correctifs mineurs | Fusion automatique, seulement quand la branche exige « Tests OK » et « Sécurité OK » et qu'ils sont verts, et que GitHub a créé et signé chaque commit de la PR pour Dependabot (sinon la fusion est retirée) ; jamais pour une version majeure, l'optimiseur (Timefold et ses autres dépendances Maven : bilan avant/après exigé), Socket.IO et sa pile (Engine.IO, ws, xmlhttprequest-ssl), une image du `Dockerfile` dont le diff change autre chose que ses empreintes ni les actions GitHub, que la publication exécute avec ses droits d'écriture | `.github/workflows/dependabot-auto-merge.yml` |
| Code | CodeQL (JavaScript, Java, Python, workflows), requêtes `security-extended`, chaque PR et chaque lundi | `.github/workflows/codeql.yml` |
| Dépendances ajoutées par une PR | Revue des dépendances : refus d'une version vulnérable (gravité moyenne ou plus) | `.github/workflows/securite.yml` |
| Dépendances de production | `npm audit --omit=dev --audit-level=high` | `.github/workflows/securite.yml` |
| Dépôt et image | Trivy : dépendances, secrets, `Dockerfile`, image construite ; refus d'une faille élevée ou critique corrigeable | `.github/workflows/securite.yml` |
| Image déjà publiée | Trivy sur `ghcr.io/jpfroud/karafun-plus:latest` chaque lundi : un échec demande une nouvelle release | `.github/workflows/securite.yml` |
| Workflows | zizmor (injections, droits, déclencheurs, caches) et actionlint | `.github/workflows/securite.yml`, `.github/workflows/ci.yml` |
| Bonnes pratiques | OpenSSF Scorecard chaque semaine | `.github/workflows/scorecard.yml` |
| Rotation | Bilan avant/après d'une vraie soirée pour toute PR qui touche Timefold ou l'ordonnanceur | `.github/workflows/bilan-timefold.yml` |
| Régressions de ces règles | `node test/workflows.test.js` (suite hors ligne) | `test/workflows.test.js` |

## Règle de la dernière LTS

Le dépôt reste sur la dernière LTS de ses outils (décision du mainteneur, 6 novembre 2026).

| Outil | Version visée | Où elle se lit |
|---|---|---|
| Node.js, Java (Temurin), Ubuntu de la CI | dernière LTS | `Dockerfile`, workflows |
| Debian des images, Maven de l'image | dernière version stable (pas de LTS) | `Dockerfile` |
| Playwright, Trivy, zizmor, actionlint | dernière version parue depuis 7 jours | workflows |

- **Qui prévient.** Chaque lundi, le workflow « Veille des versions » signale une
  nouvelle version de ce tableau, une ligne en service hors LTS ou une fin de support
  à moins de 180 jours : une seule issue, assignée au propriétaire du dépôt (GitHub
  envoie alors une notification), mise à jour avec un message à chaque alerte nouvelle,
  fermée seule quand tout est à jour ; fermée à la main, elle revient le lundi suivant
  tant que l'alerte tient. Il lit endoflife.date, le registre npm et les releases
  GitHub. Une source illisible fait échouer l'exécution, et GitHub prévient alors par
  e-mail : le silence ne veut jamais dire « tout est à jour ». GitHub coupe les tâches
  planifiées d'un dépôt public après 60 jours sans activité, en l'annonçant par
  e-mail : les réactiver.
- **Ce que Dependabot fait.** Il propose chaque nouvelle empreinte de la ligne en
  service, 7 jours après sa publication, Maven et Temurin dans une seule PR. Ces PR
  fusionnent seules une fois la CI verte, si le diff lu par l'API ne change que des
  empreintes dans les lignes `FROM` du `Dockerfile` : leur message, lui, ne montre pas
  l'étiquette (« from `abc` to `def` »). Une empreinte Temurin est un correctif de la
  JVM, sans bilan avant/après : la CI rejoue la soirée de référence avec Timefold dans
  l'image construite, et rien n'arrive au bar sans une publication, décidée à la main.
  Dependabot ne reconnaît pas les LTS (il proposait Node 25 et Java 26, #48 à #50) : ses
  montées de Node, de Temurin et de Maven sont écartées (`ignore`), et la fusion
  automatique refuse toute autre étiquette de ces images.
- **Comment monter.** D'un seul tenant, dans une PR : `Dockerfile`, CI, tests et
  documents ; le test W11 de `test/workflows.test.js` refuse une montée partielle.
  Java : bilan avant/après d'une vraie soirée (`AGENTS.md`). Node : essai réel de la
  télécommande KaraFun, car Socket.IO 2.x change de moteur. Laisser passer le délai
  de 7 jours, sauf faille à corriger.
- **Exception.** Socket.IO reste en 2.x (ci-dessous). Une migration se traite à part.

## Chaîne d'approvisionnement

- **Actions épinglées par SHA complet**, avec la version en commentaire ;
  Dependabot met les deux à jour ensemble. Un tag `@v4` peut être déplacé par
  son propriétaire, un SHA non.
- **Jetons au moindre droit** : chaque workflow déclare ses `permissions`, les
  droits d'écriture ne sont donnés qu'aux jobs qui publient ou téléversent un
  rapport. Aucune extraction ne garde les identifiants git
  (`persist-credentials: false`) : l'étape qui envoie le tag d'une publication
  manuelle pose les siens dans son seul environnement. Le job `publier` se sert
  pourtant du même jeton ailleurs (connexion au registre d'images, release,
  attestations) : ce sont l'épinglage de ses actions par SHA et ses droits
  limités qui le protègent.
- **Aucune expression `${{ }}` dans un script** : les valeurs passent par `env:`.
- **Aucun script d'installation npm** (`npm ci --ignore-scripts`) dans la CI et
  l'image : aucune dépendance n'en a besoin.
- **Publication sans cache** : le kit et l'image d'une release sont construits
  à neuf, jamais à partir d'un cache écrit par une autre exécution.
- **Images de base et Caddy épinglés par empreinte** (`Dockerfile`,
  `deploy/compose.yaml`), mis à jour par Dependabot.
- **Chaque release porte** l'empreinte SHA-256 du kit, l'empreinte de l'image,
  deux SBOM CycloneDX (dépendances npm de production et optimiseur Java) et des
  attestations de provenance Sigstore pour le kit, les SBOM et l'image. Les SBOM
  ne listent ni Node.js, ni le Java intégré, ni les paquets Debian de l'image :
  Trivy analyse l'image elle-même.

Vérifier un kit téléchargé (GitHub CLI) :

```bash
gh attestation verify KIT-BAR-KARAFUN.zip --repo jpfroud/karafun-plus
```

Vérifier l'image d'une version :

```bash
gh attestation verify oci://ghcr.io/jpfroud/karafun-plus:vX.Y.Z --repo jpfroud/karafun-plus
```

## Image et serveur

- L'application tourne sous l'utilisateur `node`, son code appartient à root.
  L'image ne contient ni npm, ni npx, ni yarn.
- Sur le VPS, `app` et `caddy` tournent sans capacité Linux ni élévation de
  privilèges ; `caddy` garde seulement l'écoute des ports 80 et 443 et la
  lecture de son `Caddyfile` monté depuis l'hôte (`DAC_OVERRIDE`, déjà parmi
  les droits par défaut de Docker : l'agent de mise à jour l'écrit en 0660). Ce
  `deploy/compose.yaml` vient avec les versions publiées après la v3.2.0 (voir
  les risques acceptés pour un retour à une version plus ancienne).
- L'agent de mise à jour tourne sur l'hôte. Le conteneur ne lui transmet qu'un
  identifiant de demande et, pour une version choisie, son numéro : l'agent
  vérifie ce numéro sur le dépôt officiel, avec l'empreinte de son image.

## Risques connus et acceptés

- **Socket.IO 2.x** : le client parle le protocole historique de la
  télécommande KaraFun ; le serveur sert seulement le faux KaraFun de la démo.
  `npm audit` y signale des alertes faibles (`cookie`, `debug`) et modérées
  (`parseuri`, déni de service par expression régulière) sans correctif dans
  la branche 2.x. L'adresse analysée par `parseuri` vient de la page officielle
  de KaraFun, lue en HTTPS. Une migration vers 4.x demande des essais du
  protocole KaraFun, pas une mise à jour automatique. Dependabot n'en propose plus
  chaque semaine, mais son `ignore` ne s'applique pas à ses mises à jour de
  sécurité (`update-types` ne concerne que les mises à jour de version, #52 et
  #53) : ces PR ne fusionnent jamais seules ; les fermer en renvoyant ici.
- **Retour à une version plus ancienne** : la version choisie revient avec
  son `deploy/compose.yaml`. Jusqu'à la v3.2.0, il n'avait ni `cap_drop`, ni
  `no-new-privileges`, ni Caddy épinglé : ces protections reviennent à la mise
  à jour suivante. Un conteneur compromis pourrait demander lui-même ce retour ;
  il ne choisit pourtant ni commande, ni image, ni dépôt, et l'agent n'installe
  qu'une release stable et complète, à partir de la v3.1.2. Une version
  vulnérable se retire en la marquant « Pre-release » : elle n'est plus
  installable. Quand assez de versions durcies seront publiées, relever
  `MIN_VERSION` dans `deploy/update-agent.py`, puis réinstaller l'agent.
- **Versions anciennes proposées au retour** : l'analyse hebdomadaire de Trivy
  ne porte que sur `latest`. Une version plus ancienne garde les failles
  corrigées depuis (la v3.2.0 embarque Jackson 2.19.2, sans entrée JSON
  extérieure dans l'optimiseur). Si une faille atteignable est corrigée, marquer
  les versions touchées « Pre-release » : elles ne sont plus proposées.
- **Fusions automatiques et workflows de `main`** : la fusion est activée avec
  le jeton du workflow ; GitHub ne relance alors ni « Tests », ni « CodeQL », ni
  « Sécurité » sur `main` pour ce commit. Ils ont tourné sur la PR, à jour avec
  `main`, et « CodeQL » et « Sécurité » repassent chaque lundi.
- **Accepter une faille signalée** : « Sécurité OK » refuse toute faille élevée
  ou critique corrigeable. Pour en accepter une (par exemple dans Socket.IO
  2.x, corrigée seulement dans une version majeure), l'ajouter à `.trivyignore`
  (son identifiant, précédé d'un commentaire avec la raison et la date de
  réexamen) dans une PR relue, et la consigner ici. `npm audit` n'a pas
  d'exception : corriger par `overrides` dans `package.json` ou, sans version
  corrigée dans la branche gardée, rendre l'étape `npm-audit` non bloquante
  dans une PR relue, avec sa raison ici.
- **Paquets Debian sans correctif publié** : Trivy les montre dans l'onglet
  Security sans bloquer ; ils arrivent avec les nouvelles empreintes de l'image
  de base proposées par Dependabot.
- **Outils d'agents dans les sessions de développement** : les hooks de
  `.claude/` installent gstack depuis son dépôt dans le conteneur éphémère de
  la session. Rien de cet outillage n'entre dans le kit ni dans l'image, et
  chaque changement passe par une PR relue sur une branche protégée.

## Réglages GitHub à activer une fois

Réservé au propriétaire du dépôt (Settings) :

1. **Code security** : Dependency graph, Dependabot alerts, Dependabot security
   updates, Secret scanning et Push protection, Private vulnerability reporting.
2. **Code scanning** : laisser CodeQL en configuration avancée (le workflow
   `codeql.yml`) ; désactiver « Default setup » s'il est actif.
3. **General → Pull Requests** : « Allow auto-merge » ; « Automatically delete
   head branches ».
4. **Branches → main** : exiger une PR, les contrôles « Tests OK » et
   « Sécurité OK », et les branches à jour ; sans ces deux contrôles exigés, la
   fusion automatique de Dependabot reste désactivée. Pour mettre à jour une PR
   de Dependabot, commenter `@dependabot rebase` : « Update branch » ajoute un
   commit de fusion d'un autre auteur, qui retire la fusion automatique. Seuls
   les commits que GitHub crée et signe pour Dependabot (committer « GitHub »,
   signature de la clé de GitHub) la gardent : un compte qui a le droit
   d'écriture ne peut pas en imiter un, mais il peut fusionner lui-même ;
   réserver ce droit au mainteneur. Pour CodeQL, ajouter dans
   un ruleset de `main` « Require code scanning results » (alertes élevées ou
   critiques).
5. **Actions → General** : « Workflow permissions » en lecture seule
   (« Read repository contents and packages permissions »).
6. **Rulesets → tags `v*`** : « Restrict updates » et « Restrict deletions »,
   sans « Restrict creations ». Un tag publié ne peut plus être déplacé vers un
   autre commit ni supprimé ; « Run workflow » crée le tag avec le jeton du
   workflow, qui ne peut pas contourner une règle et serait bloqué. Un tag
   envoyé publie une release depuis son commit, que l'agent du VPS installe
   ensuite comme dernière version : réserver le droit d'écriture au mainteneur
   (point 4).
