# TODOS

Travail reporté par les relectures de plan (gstack `autoplan`), avec son contexte. Les décisions viennent de `docs/designs/retours-2026-11-08.md`.

## Statistiques

### Découper ou rattacher une soirée à la main dans /stats

**What:** Dans la page des statistiques, « Séparer la soirée ici » et « Rattacher à la soirée précédente ».

**Why:** La réparation automatique ne coupe qu'aux frontières de 8 h du matin. Deux soirées le même jour, ou un après-midi privatisé suivi d'une soirée, restent dans un seul journal.

**Context:** Proposé et reporté par la relecture du 9 novembre 2026 (X4). La réparation automatique (`EveningJournal.repair`, lot A4 du plan) garde l'original dans `data/soirees-originales/` ; un outil manuel devra réutiliser ce découpage (lignes reportées, identifiants déterministes, écritures `.tmp` puis renommage) plutôt que d'en écrire un second. Risque : une chirurgie manuelle des archives, à réserver au bar. Il doit aussi rattacher une soirée découpée alors qu'elle était en cours : sa copie d'origine n'a pas la suite, et le retour à l'original (DEPLOIEMENT-SERVEUR, §18) ne la couvre pas.

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026 (règle de bornage et réparation).

### Une règle de bornage nouvelle repart des originaux

**What:** Si la règle de bornage change (règle v2 de `data/soirees/.bornage.json`), la réparation repart des copies d'origine de `data/soirees-originales/<id>/`, jamais des morceaux déjà découpés par la règle v1.

**Why:** Recouper des morceaux v1 empilerait des lignes reportées sur des lignes reportées. Une soirée remise d'origine à la main (DEPLOIEMENT-SERVEUR, §18, marquée `'ok'`) doit aussi être recoupée depuis son original.

**Context:** Reporté par la relecture CEO du 9 novembre 2026 (S10.3) : aucune règle v2 n'est prévue. L'index (`rule: 'v1'`) et `meta.split` (`from`, `part`, génération) disent déjà quelle règle a coupé chaque morceau (lot A4 du plan). Garder les identifiants des morceaux v1 quand leurs coupures ne changent pas, pour ne pas casser les liens des archives. L'outil manuel X4, plus haut, suit le même principe.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026.

### Script d'export des indicateurs de résultat

**What:** Un script qui lit les exports des soirées et donne, soirée par soirée : la part des invitations de duo expirées sans réponse, le délai entre l'arrivée d'une personne et son premier titre demandé, le nombre de Battles proposées et de duos ouverts, et le nombre de « Pas prêt ».

**Why:** L'avant/après du plan du 8 novembre se mesure en pixels et en mots. Ces indicateurs disent si les pages servent mieux le bar : moins d'invitations perdues, un premier titre demandé plus tôt, plus de duos et de Battles.

**Context:** Reporté par la relecture CEO du 9 novembre 2026 (F10) ; la note finale au gérant les cite. Les événements existent déjà au journal : `duo.invited` et `duo.inviteExpired`, `person.joined` et `song.requested`, `battle.proposed`, `duo.openRequested`, `defer.requested`. Comparer les mêmes indicateurs sur les soirées d'avant et d'après la livraison, sans prénom (clés S… de l'export). Outil d'essai hors de `livrable.json`, comme `test/rejeu-soiree.js`, avec son test dans `test/run-offline.js`.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lots B et E du plan du 8 novembre 2026, et quelques soirées exportées après la livraison.

### Outil du mainteneur pour les soirées d'origine

**What:** Une commande du mainteneur qui refait un export anonymisé d'une soirée d'origine gardée dans `data/soirees-originales/<id>/<g>/` (`exportEvening` sur ses fichiers, sortie hors du dépôt), et qui peut faire le retour à l'original décrit au §18 de DEPLOIEMENT-SERVEUR.

**Why:** Après l'installation de la v3.3.0, seule la copie d'origine garde une soirée mélangée entière, et aucune page ne l'exporte. L'export et le retour à l'original se font alors à la main, sur des fichiers qui portent les prénoms.

**Context:** Reporté par la relecture CEO du 9 novembre 2026 (lot A, export de la soirée fusionnée des 6 et 7 novembre). La réparation (A4) garde chaque copie d'origine par génération, avec `copie-complete`. Le retour à l'original ne vaut que pour une soirée close quand sa copie a été prise (`endedAt` dans le `meta.json` de la copie) : une soirée coupée pendant qu'elle était en cours n'a pas, dans sa copie, les lignes écrites après la coupure ; elle se rattache par « Rattacher à la soirée précédente » (X4, plus haut). L'outil réutilise `exportEvening`, et le découpage d'un tel export reste celui de `test/rejeu-soiree.js --soiree` : aucun second découpeur. Il n'écrit jamais de prénom dans le dépôt.

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026 (réparation et copies d'origine).

## Page participant

### « Chercher un autre duo » depuis le message de refus

**What:** Dans le message « X ne chantera pas « titre » avec Y : « raison » », un bouton qui ouvre la demande de duo ouvert pour ce titre.

**Why:** Après un refus, l'invitant doit aujourd'hui repasser par le menu ⋯ du titre pour chercher un autre partenaire.

**Context:** Proposé et reporté par la relecture du 9 novembre 2026 (X5), pour garder la page aussi légère que possible (demande du gérant). Le flux existe déjà : bouton « Chercher un duo » du titre (`data-duet-open`) et sa confirmation.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P4
**Depends on:** Lots B et E du plan du 8 novembre 2026.

### Suivre un téléphone après plusieurs déplacements de table

**What:** Garder la liste des tables quittées par une personne, pas seulement son dernier déplacement (`movedFrom`), pour qu'un téléphone resté sur la première table la suive aussi après A → B → C.

**Why:** Dans le plan du 8 novembre (C3), ce téléphone oublie la personne et passe par le QR de reprise du bar.

**Context:** Cas accepté par la relecture n° 3 du 9 novembre 2026 (point 1.8) : deux déplacements de la même personne avant que son téléphone ne suive sont rares. `relocated` et `POST /api/table/person/follow` comparent `movedFrom.tableId` à la table présentée ; une liste courte des tables quittées, sauvegardée avec la soirée (`night-state.js`), suffirait. Les règles d'accès ne changent pas : jeton valable, accès de la table présentée tant qu'elle est ouverte, personnes parties ignorées.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P4
**Depends on:** Lot C du plan du 8 novembre 2026.

### Notifications sur un téléphone verrouillé (Web Push), après un comptage

**What:** D'abord, compter par soirée les téléphones qui ont autorisé les notifications, sans prénom ni identifiant dans le journal, et montrer ce nombre dans les statistiques. Ensuite, si ce nombre le justifie, envoyer les demandes et les messages de duo par Web Push (clés du serveur, abonnement par téléphone, envoi par le serveur), pour qu'ils arrivent aussi téléphone verrouillé ou page fermée.

**Why:** Le service worker du plan du 8 novembre (F2a) n'affiche une notification que tant que la page vit en arrière-plan (Chrome Android, ordinateurs). Un iPhone ne la reçoit que depuis l'écran d'accueil, et un téléphone verrouillé ne reçoit rien (F2b). Le gérant ne veut rater aucune demande.

**Context:** Reporté par la relecture CEO du 9 novembre 2026 (F2c) : infrastructure nouvelle (clés, abonnements, services de push des navigateurs), hors du rayon du plan. Le comptage dit d'abord si l'effort sert : sans téléphones qui autorisent, Web Push n'atteindrait personne. Points de départ : `public/sw.js` (F2a), `systemNotice` (`public/client.html:818-824`), `GUIDE-BAR.md:81` et `:97`. Mode serveur seulement : en mode PC, la page des chanteurs est en HTTP sur le Wi-Fi du bar, où le navigateur refuse notifications et push ; le dire pour les deux modes (AGENTS.md).

**Effort:** L (humain) / M (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot B du plan du 8 novembre 2026 (service worker, F2a), puis le comptage.

### Demandes d'une personne passée à une autre table

**What:** Sur la page d'une table, signaler les demandes (« Je suis là », invitations, votes) des personnes que ce téléphone gère et que le bar a déplacées vers une autre table.

**Why:** Après une scission, un téléphone qui gère des personnes des deux tables ne voit que les demandes de la page ouverte (plan du 8 novembre, C3) : la personne déplacée peut rater son « Je suis là ».

**Context:** Reporté par la relecture CEO du 9 novembre 2026 (section 11). Le message de C3 le dit, et « Ouvrir sa page » ouvre la page de l'autre table dans un nouvel onglet. Il faudrait que la page lise aussi l'état de l'autre table, avec le jeton copié par `follow`, et mette ses demandes dans `pendingActions()` (`client.html`).

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot C du plan du 8 novembre 2026.

### Refus motivé des demandes « Duo ? »

**What:** Une étape « Que dire à {from} ? » au refus d'une demande « Duo ? » (quelqu'un qui demande à chanter sur le titre d'une personne), avec des réponses toutes faites propres à ce cas, choisies par le gérant.

**Why:** Après le plan du 8 novembre, « Refuser » ouvre l'étape de la raison pour une invitation, mais refuse d'un appui une demande « Duo ? », dans la même fenêtre. Les trois réponses de G4 parlent de la chanson proposée (« Je ne la connais pas bien », « Trop dur pour moi ») et ne vont pas à un titre que la personne a choisi elle-même.

**Context:** Reporté par la relecture design du 10 novembre 2026 (M14). Le bouton « Duo ? » s'appelle « Proposer un duo à {name} » (`public/client.html:737`, `:2361`), et la demande n° 1 du gérant parle de « la personne qui invite ». Points de départ : l'étape `decline` de la fenêtre `#attention` (lot B3), `declineWhy` et `DECLINE_TEXT_MAX` (B1), le message `joinRefused` (`public/client.html:1084`), la ligne `duo.joinAnswered` (`lib/scheduler/duets.js:847`), et la règle du petit mot hors de la sauvegarde (F7, `snapshotNight`). Mêmes essais de fuite que le lot B4, et un code de raison qui ne change plus après la livraison.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P4
**Depends on:** Lot B du plan du 8 novembre 2026, et les réponses toutes faites choisies par le gérant.

## Bar

### « Annuler » exact d'un déplacement de personnes entre tables

**What:** Un bouton « Annuler » de quelques secondes après un déplacement, qui rend l'état exact d'avant (tables, groupes et historique de rotation).

**Why:** Aujourd'hui, défaire un déplacement se fait par un déplacement en sens inverse. La table d'origine revient alors comme une table nouvelle pour la rotation : son historique de groupe n'est pas restauré.

**Context:** Proposé (X2) puis reporté par la relecture du 9 novembre 2026. Il faut un instantané pris avant le déplacement (`lastGroup`, `roundGroups`, `firstCycle`, `recentGroups`, `tableServeCounts`, `groupDepartures`, reçus des titres envoyés). Il ne doit être rendu que si rien n'a bougé depuis (aucun passage, aucun autre geste), sur le modèle de l'annulation des changements manuels (`canUndoManualChange`).

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot C du plan du 8 novembre 2026. Revient dans le lot C avant la livraison si l'aller-retour du bilan C6 (cas 5) est refusé dans l'un des trois réglages, sans défaut du code en cause.

### Contrôle du protocole KaraFun

**What:** À la connexion, vérifier la version de KaraFun et les messages de sa télécommande. Une version ou un message inconnus font passer la file en mode manuel (envoi et lecture automatiques coupés), avec un bandeau au bar qui dit pourquoi.

**Why:** La file suit un protocole que KaraFun ne documente pas (Socket.IO 2.x). Une mise à jour de KaraFun qui le change ferait des envois faux ou perdus en pleine soirée, sans que le bar le sache.

**Context:** Reporté par la relecture CEO du 9 novembre 2026 (F11). Points de départ : `karafun.js` (`KaraFunBridge` et la détection des réglages pris en charge), `karafun-state.js` (`analyzeState`), les essais `test/kcs-protocol.test.js` et `test/kcs-connection.test.js`, et la règle d'AGENTS.md sur Socket.IO 2.x. Essais sur le faux KaraFun (`fake-karafun.js`) ; jamais d'essai destructif sur la vraie télécommande sans avoir vérifié son code actuel (CLAUDE.md). Même règle dans les deux modes.

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** rien dans le plan du 8 novembre 2026.

## Design

### Un `DESIGN.md` tiré d'`app.css`

**What:** Écrire `DESIGN.md` avec `/design-consultation`, à partir d'`app.css`, du `<style>` de `client.html` et du thème clair de `stats.html` : variables de `:root` et leurs rôles, composants (`.btn` et ses variantes, `.badge`, `.pill`, `.staff-alert` et ses formes, `.disclosure`, `.link-btn`, `.switch`, `.tab-badge`, `.cover`), cibles de 44 px, grille de 12 colonnes du bar.

**Why:** La relecture design du plan du 8 novembre a jugé ses classes contre `app.css`, faute de `DESIGN.md`. Les plans suivants pourront citer les jetons par leur nom, et une relecture vérifier un écart au lieu de le chercher.

**Context:** Reporté par la phase design d'autoplan du 10 novembre 2026 (P5.8) : le gérant ne veut plus de questions, et le plan est figé. D'ici là, la règle transversale « Vocabulaire visuel » du plan tient lieu de garde. Y entrent les formes ajoutées par les lots A à E : `staff-alert info`, `song-more`, la règle commune `a.btn`, les titres de repli de 44 px.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lots D et E du plan du 8 novembre 2026 (les formes nouvelles d'abord).

### Contraste des boutons principaux

**What:** Le texte blanc des boutons principaux (`.btn.primary`, app.css:24 : « ＋ Chanson », « Commencer », « Personne seule : QR individuel », « Rejoindre la Battle », et les nouveaux « Déplacer » de Détails et « Envoyer » de l'étape du refus…) et du repère `.badge.live` du bar (app.css:221) a un contraste de 3,0:1 sur `--accent` (#ff4fa3), sous les 4,5:1 demandés pour un texte de 16 px.

**Why:** C'est l'action principale de chaque écran, lue dans un bar sombre sur des téléphones souvent en luminosité basse ; le gérant veut une page qu'un enfant de 5 ans comprend.

**Context:** Mesuré par la phase design du 10 novembre 2026 (passe 6). Le plan figé ne change que la pastille d'onglet et les infos urgentes, passées au texte `var(--bg)` (règle « Contraste »). Deux formes possibles : texte `var(--bg)` sur le même rose (6,3:1), ou un rose plus sombre sous le texte blanc. L'une ou l'autre change l'aspect de toutes les pages que les habitués connaissent : captures avant/après à montrer au gérant avant de choisir.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Jalon 2 livré ; choix du gérant sur l'aspect.

## Sécurité

### Politique de sécurité complète des pages (CSP)

**What:** Ajouter `script-src` par empreinte, `style-src` et `img-src` à la politique de contenu des pages du bar, des tables, des statistiques et de l'impression.

**Why:** Seul `esc()` protège aujourd'hui des prénoms hostiles : un oubli exécuterait du script dans la page du bar, qui tient la clé. `base-uri 'none'` (plan du 8 novembre, règle « En-têtes de sécurité ») ne bloque que le détournement par `<base>`.

**Context:** Reporté par la relecture CEO du 9 novembre 2026, section 3 (S3.9). `server.js` pose les en-têtes dans `SERVER_HEADERS` (`server.js:277-278`), par `send()`. Chaque page n'a qu'un script en ligne (`client.html` charge aussi `/client-i18n.js`) ; `print.html` a une poignée d'événement en ligne à retirer (`onclick`). Recenser les styles en ligne et l'origine des pochettes (`coverUrl`, `server.js`) avant de fixer `style-src` et `img-src`. Tester les deux modes.

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** règles « Textes venus des clients ou du bar » et « En-têtes de sécurité » du plan du 8 novembre 2026.
