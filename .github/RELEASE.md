# Créer un kit Windows depuis GitHub

Après fusion des changements sur `main`, ouvrir **Actions → Release Windows → Run workflow**, choisir `main` et saisir une nouvelle version comme `v0.1.0`. Le workflow vérifie la suite hors ligne, construit Timefold et les notices des dépendances Java, crée un runtime Java 21 autonome, embarque Node.js et le lanceur Windows, puis extrait et teste le ZIP. Il crée ensuite le tag et publie `KIT-BAR-KARAFUN.zip` avec son fichier SHA-256. Aucun `git push` local n'est nécessaire pour cette première publication.

Pour les versions suivantes, le même workflow se déclenche aussi si un tag `v*` est envoyé au dépôt. Il refuse de réutiliser une version qui pointe sur un autre commit. Réexécuter un workflow pour le même commit conserve le tag et actualise les deux fichiers de la release.

Télécharger l'archive depuis la page **Releases** du dépôt, vérifier son empreinte avec `Get-FileHash KIT-BAR-KARAFUN.zip -Algorithm SHA256`, puis copier le ZIP sur le PC du bar. Après extraction, double-cliquer sur `KaraFun Plus.exe`. KaraFun doit être installé séparément. Le JAR Timefold, Node.js et Java 21 sont inclus dans le kit ; les notices se trouvent sous `LICENCES-JAVA/`, `node/LICENSE` et `solver-runtime/legal/`.
