# Déployer la file karaoké sur un serveur Linux

Ce fichier est livré dans l'image (`/app/DEPLOIEMENT-SERVEUR.md`) et dans le kit (`karaoke-bar/DEPLOIEMENT-SERVEUR.md`).

Ce guide installe la file karaoké sur un VPS Linux loué chez OVHcloud, sous Docker, derrière Caddy en HTTPS. Le kit Windows reste le secours. Les blocs `bash` se tapent sur le serveur, les blocs `powershell` sur un PC Windows d'administration.

Valeurs à remplacer dans les commandes :

| Valeur | Sens |
|---|---|
| `<IPv4 du VPS>` | adresse IPv4 du serveur (section 3) |
| `<ancienne IPv4>` | adresse IPv4 que donnait le nom des QR avant la bascule |
| `<utilisateur OVH>` | compte de connexion donné par OVHcloud à la livraison du VPS |
| `<code>` | code affiché par la Télécommande de KaraFun |
| `vX.Y.Z` | version à installer (tag de la release) |
| `vA.B.C` | version précédente, pour un retour en arrière |
| `AAAAMMJJ` | date du jour, dans le nom d'une archive |
| `<nom de l'archive>` | nom d'un fichier de `deploy/sauvegardes/` |
| `<dossier karaoke-bar du kit>` | dossier `karaoke-bar` du kit Windows décompressé |

## 1. Vue d'ensemble

```text
Téléphones des clients --HTTPS--> clients.exemple.fr --> caddy --> app:3001
Gérants --HTTPS et mot de passe--> bar.exemple.fr    --> caddy --> app:3000
Administrateur --tunnel SSH--> 127.0.0.1:3000 de l'hôte -------> app:3000
Port 3001 : jamais publié. Pare-feu ufw : 22, 80 et 443 (443 aussi en UDP).
PC du bar (Windows) : KaraFun et sa Télécommande, comme avant.
```

Le serveur fait tourner deux conteneurs, décrits par `deploy/compose.yaml`. `caddy` reçoit tout le trafic d'Internet et obtient les certificats de Let's Encrypt. `app` est la file elle-même, en mode serveur.

Le nom des clients (`clients.exemple.fr` dans ce guide) mène au port clients 3001. Le nom de la page du bar (`bar.exemple.fr`) mène au port 3000, derrière un mot de passe demandé par Caddy en plus de la clé du bar. Le port 3000 est aussi publié sur `127.0.0.1:3000` de l'hôte, pour le tunnel SSH de l'administrateur. Le port 3001 n'est jamais publié. Le pare-feu n'ouvre que 22, 80 et 443 (443 aussi en UDP).

Une seule file à la fois : jamais le kit Windows en même temps que le serveur. Deux files se disputeraient la Télécommande de KaraFun, et leurs soirées divergeraient.

La file pilote KaraFun par Internet. KaraFun et sa Télécommande restent sur le PC du bar : rien n'y change.

## 2. Avant de commencer

Il te faut :

- un compte OVHcloud et un domaine dont la zone DNS est chez OVHcloud ;
- un PC Windows d'administration, avec PowerShell et le client OpenSSH de Windows ;
- une release `vX.Y.Z` publiée (kit Windows et image `ghcr.io/jpfroud/karafun-plus:vX.Y.Z`), voir `.github/RELEASE.md` dans le dépôt.

**Hôte des QR imprimés.** Le champ « Adresse publique HTTPS » de la page du bar donne l'adresse des QR déjà imprimés. Son hôte, sans `https://`, devient `HOTE_CLIENTS` : les QR imprimés continueront d'y mener. Dans ce guide : `clients.exemple.fr`.

**Hôte du bar.** `HOTE_BAR` de `deploy/.env` est un nom nouveau, réservé à la page du bar. Nom proposé : `bar.exemple.fr`.

**Noms d'essai.** Pour une bascule depuis le PC Windows, le serveur tourne d'abord sous deux noms d'essai : `essai.exemple.fr` (clients) et `essai-bar.exemple.fr` (bar). Les vrais noms ne changent de cible qu'à l'étape 6 de la section 12.

**Clé SSH.** Sur le PC d'administration, dans PowerShell :

```powershell
ssh-keygen -t ed25519 -C "karafun-plus-vps"
```

Accepte le fichier proposé et choisis une phrase de passe. La clé privée `id_ed25519` ne quitte jamais ce PC.

**Contrôle** : `Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"` affiche une seule ligne, qui commence par `ssh-ed25519` et finit par `karafun-plus-vps`.

## 3. Créer le VPS chez OVHcloud

Commande un VPS « VPS-1 » sur `www.ovhcloud.com` (2 vCores, 4 Go de mémoire, 40 Go de disque). Choisis une localisation en France, et le système Debian 12 ou Ubuntu 24.04. Ne prends aucune option.

Après la livraison, l'espace client d'OVHcloud liste le serveur dans « Serveurs Privés Virtuels », avec son adresse IPv4 : c'est `<IPv4 du VPS>`. L'e-mail de livraison donne le compte de connexion, `<utilisateur OVH>` (souvent `debian` ou `ubuntu`), et son mot de passe.

**Contrôle** : « Serveurs Privés Virtuels » montre le VPS démarré avec `<IPv4 du VPS>`, et tu as `<utilisateur OVH>` et son mot de passe.

## 4. Première connexion, clé SSH et mises à jour

Depuis PowerShell, pose ta clé publique sur le serveur. Le mot de passe de l'e-mail est demandé une dernière fois. À la première connexion, SSH montre l'empreinte du serveur : réponds `yes`.

```powershell
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub" | ssh <utilisateur OVH>@<IPv4 du VPS> "umask 077; mkdir -p ~/.ssh; tr -d '\r' >> ~/.ssh/authorized_keys"
ssh <utilisateur OVH>@<IPv4 du VPS>
```

La seconde commande ouvre une session sans le mot de passe de l'e-mail : seule la phrase de passe de la clé est demandée. Si le serveur exige un nouveau mot de passe, choisis-le.

Sur le serveur, mets le système à jour, installe les mises à jour de sécurité automatiques et règle le fuseau horaire :

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
sudo timedatectl set-timezone Europe/Paris
```

À la question de `dpkg-reconfigure`, réponds oui (« Yes »). Si le fichier `/var/run/reboot-required` existe, redémarre par `sudo reboot`, puis reconnecte-toi.

**Contrôle** : `timedatectl` affiche `Time zone: Europe/Paris`, et `apt-config dump APT::Periodic::Unattended-Upgrade` affiche `APT::Periodic::Unattended-Upgrade "1";`.

## 5. Utilisateur d'administration et SSH sans mot de passe

Crée le compte `karaoke`, qui fera tout le reste. Son mot de passe ne sert qu'à `sudo` : choisis-en un long, gardé dans un gestionnaire de mots de passe.

```bash
sudo adduser --comment "" karaoke
sudo usermod -aG sudo karaoke
sudo install -d -m 700 -o karaoke -g karaoke /home/karaoke/.ssh
sudo install -m 600 -o karaoke -g karaoke ~/.ssh/authorized_keys /home/karaoke/.ssh/authorized_keys
```

Ferme ensuite toute connexion par mot de passe, et tout compte autre que `karaoke` :

```bash
sudo tee /etc/ssh/sshd_config.d/00-karafun-plus.conf > /dev/null <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers karaoke
EOF
sudo sshd -t && sudo systemctl restart ssh
```

Le serveur SSH garde la première valeur lue pour chaque réglage. Le fichier `00-karafun-plus.conf` passe donc avant `50-cloud-init.conf`, que l'image du VPS peut contenir et qui peut permettre les mots de passe.

**Garde la première session ouverte** jusqu'à la fin de l'essai. Dans une nouvelle fenêtre PowerShell, ouvre une session `karaoke`, puis tape `sudo -v` : le mot de passe de `karaoke` est demandé.

```powershell
ssh karaoke@<IPv4 du VPS>
```

Ferme cette session, puis essaie l'ancien compte : SSH doit répondre `Permission denied (publickey).`.

```powershell
ssh <utilisateur OVH>@<IPv4 du VPS>
```

Seulement alors, ferme la première session. Toutes les commandes suivantes se tapent dans une session `karaoke`.

**Contrôle** : `sudo sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|allowusers) '` affiche `permitrootlogin no`, `passwordauthentication no`, `kbdinteractiveauthentication no` et `allowusers karaoke`.

## 6. Pare-feu

ufw n'ouvre que SSH (22), HTTP (80) et HTTPS (443, aussi en UDP pour HTTP/3) :

```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

`ufw enable` prévient que les connexions SSH peuvent être coupées : réponds `y`, le port 22 est déjà ouvert.

Attention, Docker contourne ufw : un port publié par un conteneur reste joignable même si ufw le ferme. C'est pourquoi `deploy/compose.yaml` ne publie, pour `app`, que `127.0.0.1:3000:3000`. Ne le remplace jamais par `3000:3000`, et ne publie jamais le port 3001.

**Contrôle** : `sudo ufw status` liste `22/tcp`, `80/tcp`, `443/tcp` et `443/udp` en `ALLOW`, avec leurs lignes `(v6)`, et rien d'autre.

## 7. Installer Docker

Docker vient de son dépôt officiel, dont la clé de signature est posée à part :

```bash
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
. /etc/os-release
sudo curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $VERSION_CODENAME
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker karaoke
```

`. /etc/os-release` donne `$ID` (`debian` ou `ubuntu`) et `$VERSION_CODENAME` (`bookworm` ou `noble`) : les mêmes commandes servent aux deux systèmes. Ferme la session puis reconnecte-toi, pour que le groupe `docker` compte.

Le groupe `docker` vaut un accès administrateur au serveur : seul `karaoke` doit y être.

**Contrôle** : `getent group docker` finit par `:karaoke`, sans autre compte, et `docker compose version` répond sans `sudo`.

## 8. Diagnostic KaraFun depuis le serveur

Avant tout le reste, puis le jour de la bascule, vérifie que KaraFun accepte l'adresse du serveur. Active la Télécommande de KaraFun sur le PC du bar et lis son code. Puis, sur le serveur :

```bash
 docker run --rm ghcr.io/jpfroud/karafun-plus:vX.Y.Z node tools/diag-karafun.js <code>
echo "Code de sortie : $?"
```

L'espace en tête de la première ligne la garde hors de l'historique de `bash` (réglage `HISTCONTROL=ignoreboth` des comptes Debian et Ubuntu) : le code n'y reste pas. L'outil lit une seule fois la page de la Télécommande, n'écrit rien et finit par une ligne `Verdict`. Si Docker répond `unauthorized`, l'image n'est pas encore publique : voir « Une seule fois » dans `.github/RELEASE.md`.

| Code de sortie | Que faire |
|---|---|
| `0` | KaraFun répond normalement à ce serveur : continue. |
| `1` | KaraFun refuse ce serveur : ne déplace pas la file. Relance une seule fois, au moins une heure plus tard. Ne cherche jamais à contourner ce refus. |
| `2` | Non concluant : suis la ligne `Verdict` (code à vérifier, site en panne, réseau coupé). |

Ne lance jamais l'outil en boucle : chaque lecture compte dans la limite horaire que KaraFun applique à l'adresse du serveur.

**Contrôle** : `Code de sortie : 0`, après la ligne `Verdict : KaraFun répond normalement à ce serveur. La migration peut continuer.`

## 9. Noms d'hôtes chez OVHcloud

Dans l'espace client d'OVHcloud, ouvre ton domaine, onglet « Zone DNS ». Chaque nom de la file y est une entrée de type A, créée par « Ajouter une entrée ». Choisis le sous-domaine, la cible `<IPv4 du VPS>`, et un « TTL » « Personnalisé » de 300 secondes.

Nouvelle installation : crée les entrées A de `HOTE_CLIENTS` et de `HOTE_BAR` (sous-domaines `clients` et `bar` de ce guide).

Bascule depuis le PC Windows :

1. Tout de suite : crée les entrées A des noms d'essai, `essai` et `essai-bar`.
2. Au moins 24 heures avant la bascule : sur l'entrée actuelle du nom des QR, « Modifier l'entrée », puis « TTL » « Personnalisé » à 300.
3. À l'étape 6 de la section 12 : change la cible du nom des QR pour `<IPv4 du VPS>`, et crée l'entrée A de `HOTE_BAR` si elle manque.
4. Au même moment, retire pour ces noms toute entrée AAAA ou CNAME, et tout DynHost. Ces libellés de suppression et le menu « DynHost » n'ont pas été vérifiés : cherche-les sur la ligne de l'entrée.
5. Une fois les noms en place, ajoute pour chacun une entrée CAA : drapeau `0`, étiquette `issue`, valeur `letsencrypt.org`. Seul Let's Encrypt pourra alors leur délivrer un certificat.
6. Sept jours après la bascule : remets le « TTL » de ces entrées à 3600.

N'interroge jamais un nom avant de l'avoir créé, ni par un navigateur, ni par `ping` ou `nslookup`. La réponse « nom absent » resterait en mémoire chez les résolveurs DNS, parfois plusieurs heures.

**Contrôle** : dans PowerShell, `Resolve-DnsName essai.exemple.fr -Type A` (ou chaque nom créé) donne `<IPv4 du VPS>`.

## 10. Fichiers du serveur et secrets

Dans la session `karaoke`, récupère les fichiers de déploiement de la version voulue, puis prépare `deploy/.env` :

```bash
sudo apt install -y git nano
cd ~
git clone https://github.com/jpfroud/karafun-plus.git
cd karafun-plus
git checkout vX.Y.Z
cd deploy
cp .env.example .env
chmod 600 .env
docker run --rm -it caddy:2 caddy hash-password
nano .env
docker compose config --quiet
```

`caddy hash-password` demande deux fois le mot de passe du bar : tape-le, il ne s'affiche pas. Ne le passe jamais en argument : il resterait dans l'historique. La commande affiche une empreinte qui commence par `$2a$14$`. Colle-la dans `BAR_PASSWORD_HASH`, entre apostrophes.

Remplis les huit réglages de `.env` avant le premier démarrage :

| Réglage | Valeur |
|---|---|
| `KARAFUN_PLUS_VERSION` | le tag de la release, `vX.Y.Z`, jamais `latest` |
| `HOTE_CLIENTS` | l'hôte des QR imprimés, `clients.exemple.fr` ; en bascule, d'abord `essai.exemple.fr` ; ne le change plus une fois les QR imprimés |
| `HOTE_BAR` | l'hôte de la page du bar, `bar.exemple.fr` ; en bascule, d'abord `essai-bar.exemple.fr` |
| `KARAOKE_PUBLIC_URL` | `https://` suivi de `HOTE_CLIENTS`, sans `/` final |
| `KARAOKE_STAFF_URL` | `https://` suivi de `HOTE_BAR`, sans `/` final |
| `ACME_EMAIL` | ton adresse e-mail, pour Let's Encrypt, en un seul mot : avec le texte d'exemple, Caddy refuse sa configuration (`wrong argument count`) |
| `BAR_USER` | le nom que le navigateur demande avant la page du bar, `bar` par défaut |
| `BAR_PASSWORD_HASH` | l'empreinte de `caddy hash-password`, entre apostrophes (elle contient des `$`) |

Les secrets du déploiement :

| Secret | Où il est | Règle |
|---|---|---|
| Mot de passe du bar | gestionnaire de mots de passe des gérants | jamais sur le serveur : seule son empreinte est dans `.env` |
| `deploy/.env` | serveur, en `chmod 600` | ignoré par git, jamais copié ailleurs |
| Clé du bar | `data/staff-key`, dans le volume des données | jamais écrite au journal, qui n'en garde que l'empreinte ; renouvelable (section 13) |
| Clé SSH privée | PC d'administration (`id_ed25519`) | protégée par sa phrase de passe |
| `data/`, `journal/`, archives | volumes du serveur et `deploy/sauvegardes/` | prénoms, QR secrets, jetons, code KaraFun et jeton Spotify : privés |

**Contrôle** : `docker compose config --quiet` n'affiche rien, `stat -c '%a' .env` affiche `600`, et `grep -c -e '<' -e remplacer .env` affiche `0`.

## 11. Premier démarrage

En bascule, `.env` porte encore les noms d'essai. Remplace alors ci-dessous `clients.exemple.fr` par `essai.exemple.fr`, et `bar.exemple.fr` par `essai-bar.exemple.fr`. Dans `~/karafun-plus/deploy` :

```bash
docker compose up -d
docker compose ps
docker compose logs --no-log-prefix app
docker compose logs caddy | grep -c 'certificate obtained successfully'
docker compose logs --no-log-prefix app | grep -c 'staff?key='
docker compose exec app node -e "fetch('http://127.0.0.1:3000/readyz').then(r => r.text()).then(t => console.log(t))"
./sauvegarde.sh
```

Résultats attendus, commande par commande :

- `docker compose ps` : `app` passe à `(healthy)` en une minute ; la seule flèche de sa ligne est `127.0.0.1:3000->3000/tcp`.
- Le journal de `app` contient les lignes `Mode` (`serveur`), `Fuseau horaire` (`Europe/Paris`) et `Clé du bar` (une empreinte, jamais la clé).
- Caddy a obtenu les certificats des deux hôtes : `2`.
- Aucun lien du bar au journal : `0`.
- `/readyz` répond `{"ok":false,"mode":"server","karafun":"no-code","solver":"available","persistence":"ok"}`. C'est normal : aucun code KaraFun n'est encore donné.
- `./sauvegarde.sh` arrête la file le temps de la copie, écrit `Sauvegarde écrite : sauvegardes/karafun-plus-AAAAMMJJ-HHMMSSZ.tar.gz (…)`, puis relance la file.

Depuis le PC Windows, dans PowerShell (`curl.exe`, pas l'alias `curl`) :

```powershell
curl.exe -s -o NUL -w "%{http_code}\n" https://clients.exemple.fr/healthz
curl.exe -s -o NUL -w "%{http_code}\n" https://clients.exemple.fr/staff
curl.exe -s -o NUL -w "%{http_code}\n" https://bar.exemple.fr/staff
curl.exe -s -o NUL -w "%{http_code}\n" -u bar https://bar.exemple.fr/staff
curl.exe -s -o NUL -w "%{http_code}\n" http://clients.exemple.fr/
curl.exe -s -o NUL -w "%{http_code}\n" --max-time 5 http://<IPv4 du VPS>:3000/healthz
curl.exe -s -o NUL -w "%{http_code}\n" --max-time 5 http://<IPv4 du VPS>:3001/healthz
```

Attendus, dans l'ordre : `200` (clients) ; `403` (`/staff` refusé aux clients) ; `401` (bar sans mot de passe) ; `200` (`-u bar`, mot de passe tapé) ; `308` (HTTP renvoyé vers HTTPS). Puis rien sur `:3000` ni sur `:3001` : `000`.

Aucun lien du bar aux gérants avant la bascule ; aucun code KaraFun sur le serveur avant la bascule, sauf pendant la démo de répétition, bar fermé, file du PC Windows arrêtée.

**Contrôle** : `app` est `(healthy)`, les deux comptes donnent `2` et `0`, et les sept `curl.exe` donnent `200`, `403`, `401`, `200`, `308`, `000`, `000`.

## 12. Bascule depuis un PC Windows

Bar fermé, une fois les sections 2 à 11 faites avec les noms d'essai. Compte une heure.

1. **Diagnostic.** Refais la section 8, et ne continue que sur `Code de sortie : 0`.
2. **Adresse des QR du PC.** Sur le PC Windows du kit, dans PowerShell :

   ```powershell
   Set-Location "<dossier karaoke-bar du kit>"
   $t = Get-Content -Raw -Encoding UTF8 data\tables.json | ConvertFrom-Json
   "$(@($t.tables).Count) tables, adresse $($t.baseUrl)"
   ```

   La réponse doit être `<n> tables, adresse https://clients.exemple.fr`. Note `<n>`. Si l'adresse diffère, arrête-toi : les QR imprimés ne mèneraient pas au serveur.
3. **Arrêt du kit.** Double-clique sur `ARRETER.bat`, et attends que la fenêtre de la file se ferme.
4. **Archive des données.** Toujours dans `<dossier karaoke-bar du kit>` :

   ```powershell
   tar.exe -czf karafun-plus-pc-AAAAMMJJ.tar.gz data
   Get-FileHash karafun-plus-pc-AAAAMMJJ.tar.gz -Algorithm SHA256
   scp karafun-plus-pc-AAAAMMJJ.tar.gz karaoke@<IPv4 du VPS>:karafun-plus/deploy/sauvegardes/
   ```

   Note l'empreinte SHA-256. L'archive ne contient que `data` : `journal`, avec ses prénoms, reste sur le PC.
5. **Ancienne file hors service.** Toujours dans le même dossier :

   ```powershell
   Rename-Item data "data-avant-serveur-AAAAMMJJ"
   ```

   Arrête aussi le tunnel ou le relais HTTPS du PC, et empêche-le de repartir au démarrage. Pour le service `cloudflared` du guide du bar, dans un PowerShell administrateur : `Stop-Service cloudflared`, puis `Set-Service cloudflared -StartupType Disabled`.
6. **DNS.** Change les cibles comme le disent les points 3 et 4 de la bascule, en section 9. Compte cinq minutes (TTL 300) : Caddy réessaie seul si le DNS n'a pas encore suivi.
7. **Restauration sur le serveur.** Dans `~/karafun-plus/deploy` :

   ```bash
   chmod 600 sauvegardes/karafun-plus-pc-AAAAMMJJ.tar.gz
   sha256sum sauvegardes/karafun-plus-pc-AAAAMMJJ.tar.gz
   nano .env
   ./restauration.sh sauvegardes/karafun-plus-pc-AAAAMMJJ.tar.gz
   docker compose up -d
   ```

   L'empreinte doit être celle de l'étape 4, en minuscules. Dans `.env`, mets les noms définitifs dans `HOTE_CLIENTS`, `HOTE_BAR`, `KARAOKE_PUBLIC_URL` et `KARAOKE_STAFF_URL`. `restauration.sh` demande de taper `RESTAURER`. Il sauvegarde l'état d'essai, remplace `data/` et `journal/`, puis relance la file.
8. **Vérifications.** Toujours sur le serveur :

   ```bash
   docker compose logs caddy | grep -c 'certificate obtained successfully'
   docker compose exec -T app stat -c '%a %U' /app/data /app/journal
   docker compose logs --no-log-prefix app | grep -E 'Soirée restaurée|Attention : data/tables.json|Impossible de démarrer'
   ```

   Attendus : `2`, pour les certificats des noms définitifs. Puis deux fois `700 node` : ne corrige jamais ces droits à la main. Enfin une seule ligne, `Soirée restaurée : <n> tables, …`, avec le même `<n>` qu'à l'étape 2. Une ligne `Attention : data/tables.json` ou `Impossible de démarrer` arrête la bascule : section 19.
9. **QR imprimé.** Wi-Fi coupé, en 4G/5G, scanne un QR **imprimé** : la page de sa table doit s'ouvrir.
10. **Ancien chemin fermé.** Sur le serveur :

    ```bash
    curl -fsS --max-time 10 --resolve clients.exemple.fr:443:<ancienne IPv4> https://clients.exemple.fr/healthz
    echo "Code de sortie : $?"
    ```

    Cette requête vers l'ancienne adresse doit échouer : code de sortie différent de `0`.

La restauration a remplacé `data/`, clé du bar d'essai comprise : donne maintenant le lien du bar aux gérants (section 13). KaraFun fermé, la page du bar finit sur « KaraFun fermé ou code changé : essais arrêtés ». C'est normal : à l'ouverture, suis la section 14.

En cas d'échec avant l'étape 6, remets `data` à son nom s'il le faut (`Rename-Item "data-avant-serveur-AAAAMMJJ" data`), relance le tunnel du PC, puis `DEMARRER.bat`. Après l'étape 6 : section 19.

**Contrôle** : le QR imprimé ouvre sa table en 4G/5G, et l'étape 10 affiche un code de sortie différent de `0`.

## 13. Lien de la page du bar

Sur le serveur, dans `~/karafun-plus/deploy` :

```bash
docker compose exec app node server.js --print-staff-url
```

La commande affiche `https://bar.exemple.fr/staff?key=<clé>`. Donne aux gérants le lien et le mot de passe du bar par deux canaux différents : par exemple le lien par message, le mot de passe de vive voix. Le navigateur demande d'abord `bar` et le mot de passe, puis la page s'ouvre. Le lien ne change pas au redémarrage.

Lien ou mot de passe divulgué : renouvelle la clé, puis redémarre la file, de préférence hors soirée.

```bash
docker compose exec app node server.js --rotate-staff-key
docker compose restart app
```

La file reprend sa soirée en quelques secondes. Redonne ensuite le nouveau lien, obtenu par la première commande de cette section : l'ancien répond « Réservé au bar ». Pour un mot de passe divulgué, refais aussi l'empreinte (section 10), remplace `BAR_PASSWORD_HASH` dans `.env`, puis lance `docker compose up -d`.

**Contrôle** : le lien ouvre la page du bar après le mot de passe ; après un renouvellement, l'ancien lien affiche « Réservé au bar ».

## 14. Ouverture du bar chaque soir

Sur le serveur, rien à lancer : la file reste allumée, nuit comprise. La file ne lance jamais KaraFun : il s'ouvre au PC du bar.

1. Sur le PC du bar, lance KaraFun et active sa Télécommande.
2. Ouvre la page du bar par son lien (section 13).
3. Si elle affiche « KaraFun fermé ou code changé : essais arrêtés », clique **une** fois sur « Reconnecter ». Si le code a changé, saisis-le dans « Plus » → « KaraFun », puis clique sur « Changer le code ».
4. Si elle affiche « KaraFun limite les essais jusqu’à … », attends sans cliquer : la file réessaie seule après l'heure indiquée.

**Contrôle** : `/readyz` (commande de la section 11) répond `"karafun":"connected"`, et la page du bar affiche « KaraFun connecté ».

## 15. Spotify

Rien n'est à déclarer chez Spotify : l'adresse de retour reste `http://127.0.0.1:3000/spotify/callback`. Le jeton, `data/spotify.json`, part avec `data/` : au quotidien, Spotify marche sans rien faire. La musique ne joue jamais sur le serveur : Spotify Connect la joue sur le PC du bar ou sur une enceinte.

Reconnexion, rare (pastille « Spotify non connecté ») : depuis le PC d'administration, sans kit lancé, ouvre le tunnel SSH. Le port 3000 de ce PC doit être libre.

```powershell
ssh -N -L 3000:127.0.0.1:3000 karaoke@<IPv4 du VPS>
```

Laisse cette fenêtre ouverte. Dans le navigateur de ce PC, ouvre `http://127.0.0.1:3000/staff?key=<clé>`, avec la clé du lien de la section 13. Puis « Plus », « Reconnecter Spotify ». Après le retour de Spotify, Ctrl+C dans la fenêtre PowerShell ferme le tunnel.

Sur un serveur neuf, sans soirée reprise d'un PC, la première connexion à Spotify passe par le même tunnel, avec le panneau Spotify décrit dans GUIDE-BAR.md.

**Contrôle** : la pastille Spotify de la page du bar redevient verte, « Spotify · » suivi du nom de l'appareil.

## 16. Sauvegarde et restauration

Jamais en soirée : la sauvegarde arrête la file le temps de la copie. Dans `~/karafun-plus/deploy` :

```bash
./sauvegarde.sh
```

Le script écrit `Sauvegarde écrite : sauvegardes/karafun-plus-AAAAMMJJ-HHMMSSZ.tar.gz (…)`, puis relance la file. Copie l'archive hors du serveur, depuis PowerShell :

```powershell
scp karaoke@<IPv4 du VPS>:karafun-plus/deploy/sauvegardes/<nom de l'archive> .
```

Pour remettre une archive en place :

```bash
./restauration.sh sauvegardes/<nom de l'archive>
```

Tape `RESTAURER` pour confirmer. Le script sauvegarde d'abord l'état actuel, remplace `data/` et `journal/`, puis relance la file. L'archive est privée : elle contient les prénoms, les QR secrets, la clé du bar et les jetons. Garde-la sur un disque protégé, jamais dans un message.

**Contrôle** : `ls -l sauvegardes/` montre l'archive en `-rw-------`, et sa copie est sur le PC.

## 17. Mise à jour et retour à la version précédente

Hors soirée, quand une release `vX.Y.Z` paraît :

```bash
cd ~/karafun-plus/deploy
./sauvegarde.sh
git fetch --tags
git checkout vX.Y.Z
diff <(grep -o '^[A-Z_]*=' .env | sort) <(grep -o '^[A-Z_]*=' .env.example | sort)
sed -i 's/^KARAFUN_PLUS_VERSION=.*/KARAFUN_PLUS_VERSION=vX.Y.Z/' .env
docker compose pull
docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/jpfroud/karafun-plus:vX.Y.Z
docker compose up -d
```

`diff` compare les clés de `.env` et de `.env.example` et ne doit rien afficher. Sinon, ajoute à `.env` le réglage nouveau, décrit par les notes de la release. Ne modifie que `.env` : les autres fichiers de `deploy/` suivent la version.

Compare l'empreinte affichée par `docker image inspect` à la ligne « Empreinte » des notes de la release (`ghcr.io/jpfroud/karafun-plus@sha256:…`). Si elles diffèrent, ne lance pas `docker compose up -d`.

Retour à la version précédente : les mêmes commandes, avec `vA.B.C` à la place de `vX.Y.Z`. Si la file refuse ensuite de démarrer, restaure l'archive faite juste avant la mise à jour (section 16).

**Contrôle** : `docker compose ps` montre `app` en `(healthy)`, et `docker compose logs --no-log-prefix app | grep '=== File karaoké'` affiche la version voulue.

## 18. Vérifications et dépannage

Dans `~/karafun-plus/deploy`, les commandes de tous les jours :

```bash
docker compose ps
docker compose restart app
docker compose stop app
df -h /
```

| Commande | Rôle |
|---|---|
| `docker compose ps` | état des conteneurs : `app` doit être `(healthy)` |
| `/readyz` (commande de la section 11) | état de KaraFun, du solveur et de la sauvegarde, sans secret |
| `docker compose restart app` | redémarre la file ; la soirée reprend |
| `docker compose stop app` | arrête la file ; la soirée est enregistrée |
| `df -h /` | place libre sur le disque |

Chaque mois, mesure le journal. Après une sauvegarde (section 16), retire ses fichiers de plus de 90 jours :

```bash
docker compose exec -T app du -sh /app/journal
docker compose exec -T app find /app/journal -maxdepth 1 -type f -mtime +90 -print -delete
```

**Caddy en panne** (pages injoignables, `caddy` arrêté dans `docker compose ps`) : la page du bar reste joignable par le tunnel de la section 15. `docker compose logs caddy` en donne la cause : `wrong argument count` y signale un `ACME_EMAIL` resté au texte d'exemple (section 10).

**`app` redémarre en boucle** (`Restarting` dans `docker compose ps`), le journal dit `Impossible de démarrer : data/staff-key ne contient pas une clé valable`, et `docker compose exec` échoue. Voici la seule exception permise : une commande ponctuelle écrit une clé neuve, puis s'arrête sans ouvrir de port.

```bash
docker compose run --rm app node server.js --rotate-staff-key
docker compose up -d
docker compose exec app node server.js --print-staff-url
```

Redonne ensuite le nouveau lien aux gérants (section 13). Une autre ligne `Impossible de démarrer : …` donne sa cause, le plus souvent un réglage de `.env` : corrige-le, puis lance `docker compose up -d`.

Jamais : `docker compose down -v` (il efface les volumes, donc la soirée et la clé), `docker compose run` hors de l'exception ci-dessus (seconde file), `node server.js` lancé en SSH (seconde file), publier `journal/` (il contient des prénoms).

**Contrôle** : `docker compose ps` montre `caddy` et `app` en marche, `app` en `(healthy)`, et `/readyz` répond.

## 19. Retour arrière vers le kit Windows

Bar fermé. Sur le serveur, dans `~/karafun-plus/deploy` :

```bash
docker compose stop app
./sauvegarde.sh
docker compose stop
```

La sauvegarde ne relance pas la file, déjà arrêtée. Note `<nom de l'archive>`. Puis, sur le PC Windows :

1. Télécharge le kit `vX.Y.Z` neuf, de la même version que le serveur. Vérifie son SHA-256 avec `Get-FileHash KIT-BAR-KARAFUN.zip -Algorithm SHA256`, puis décompresse-le entièrement.
2. Récupère l'archive, et n'en extrais que `data` :

   ```powershell
   Set-Location "<dossier karaoke-bar du kit>"
   scp karaoke@<IPv4 du VPS>:karafun-plus/deploy/sauvegardes/<nom de l'archive> .
   tar.exe -xzf <nom de l'archive> data
   ```

3. Remets la cible DNS du nom des QR sur `<ancienne IPv4>`, ou l'ancien CNAME ou DynHost. Relance ensuite le tunnel ou le relais du PC.
4. Double-clique sur `KaraFun Plus.exe`.

Sur le serveur enfin, retire les conteneurs. Les volumes restent, pour un nouvel essai : jamais l'option qui les efface.

```bash
docker compose down
```

Avec le kit Windows, ne relaie jamais le port du bar (3000) par un proxy HTTPS : en mode PC, un relais HTTPS installé sur la même machine fait paraître locale toute requête, et n'importe qui ouvrirait la page du bar.

**Contrôle** : un QR imprimé ouvre sa table en 4G/5G par le PC, et la page du bar du kit montre les tables de la soirée.

## 20. Données personnelles et accès

La file est hébergée en France, sur un VPS d'OVHcloud situé dans un centre de données français. Les prénoms et les heures de présence sont des données personnelles. Ils sont dans `data/` (soirées, statistiques), dans `journal/` (le journal du serveur et celui de KaraFun citent des prénoms), et dans chaque archive de `deploy/sauvegardes/` et ses copies. Informe les clients par une affiche, comme avec le kit.

| Qui | Accès |
|---|---|
| Clients | la page de leur table, par son QR ; jamais la page du bar |
| Gérants | la page du bar, par son lien et le mot de passe du bar |
| Administrateur (`karaoke`) | tout le serveur par sa clé SSH : `.env`, volumes, journaux, archives |
| OVHcloud | le disque du serveur, comme tout hébergeur |

Garde ces accès au plus juste. Quand un gérant s'en va, renouvelle la clé et le mot de passe du bar (section 13). Les journaux de plus de 90 jours se retirent par la commande de la section 18.
