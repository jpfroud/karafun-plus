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
| Correctifs mineurs | Fusion automatique, seulement quand la branche exige des contrôles et qu'ils sont verts ; jamais pour une version majeure, Timefold ou Socket.IO | `.github/workflows/dependabot-auto-merge.yml` |
| Code | CodeQL (JavaScript, Java, Python, workflows), requêtes `security-extended`, chaque PR et chaque lundi | `.github/workflows/codeql.yml` |
| Dépendances ajoutées par une PR | Revue des dépendances : refus d'une version vulnérable (gravité moyenne ou plus) | `.github/workflows/securite.yml` |
| Dépendances de production | `npm audit --omit=dev --audit-level=high` | `.github/workflows/securite.yml` |
| Dépôt et image | Trivy : dépendances, secrets, `Dockerfile`, image construite ; refus d'une faille élevée ou critique corrigeable | `.github/workflows/securite.yml` |
| Image déjà publiée | Trivy sur `ghcr.io/jpfroud/karafun-plus:latest` chaque lundi : un échec demande une nouvelle release | `.github/workflows/securite.yml` |
| Workflows | zizmor (injections, droits, déclencheurs, caches) et actionlint | `.github/workflows/securite.yml`, `.github/workflows/ci.yml` |
| Bonnes pratiques | OpenSSF Scorecard chaque semaine | `.github/workflows/scorecard.yml` |
| Rotation | Bilan avant/après d'une vraie soirée pour toute PR qui touche Timefold ou l'ordonnanceur | `.github/workflows/bilan-timefold.yml` |
| Régressions de ces règles | `node test/workflows.test.js` (suite hors ligne) | `test/workflows.test.js` |

## Chaîne d'approvisionnement

- **Actions épinglées par SHA complet**, avec la version en commentaire ;
  Dependabot met les deux à jour ensemble. Un tag `@v4` peut être déplacé par
  son propriétaire, un SHA non.
- **Jetons au moindre droit** : chaque workflow déclare ses `permissions`, les
  droits d'écriture ne sont donnés qu'aux jobs qui publient ou téléversent un
  rapport. Aucune extraction n'y garde les identifiants git, sauf le job
  `publier` de la release, qui envoie le tag.
- **Aucune expression `${{ }}` dans un script** : les valeurs passent par `env:`.
- **Aucun script d'installation npm** (`npm ci --ignore-scripts`) dans la CI et
  l'image : aucune dépendance n'en a besoin.
- **Publication sans cache** : le kit et l'image d'une release sont construits
  à neuf, jamais à partir d'un cache écrit par une autre exécution.
- **Images de base et Caddy épinglés par empreinte** (`Dockerfile`,
  `deploy/compose.yaml`), mis à jour par Dependabot.
- **Chaque release porte** l'empreinte SHA-256 du kit, l'empreinte de l'image,
  deux SBOM CycloneDX (dépendances npm de production et optimiseur Java) et des
  attestations de provenance Sigstore pour le kit, les SBOM et l'image.

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
  privilèges ; `caddy` garde seulement l'écoute des ports 80 et 443.
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
  protocole KaraFun, pas une mise à jour automatique (Dependabot ignore ces
  versions majeures).
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
4. **Branches → main** : exiger une PR, les contrôles « Tests OK » (ou
   `offline-tests`, `linux` et `image`) et les branches à jour ; sans contrôle
   exigé, la fusion automatique de Dependabot reste désactivée.
5. **Actions → General** : « Workflow permissions » en lecture seule
   (« Read repository contents and packages permissions »).
