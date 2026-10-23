#!/usr/bin/env bash
# Vérification d'une image construite (Linux, Docker) : 38 contrôles V01 à V38.
# L'image elle-même (utilisateur, commande, fichiers livrés, Java), ses refus
# de démarrer, une démo en mode serveur, une soirée arrêtée par SIGTERM puis
# reprise dans un nouveau conteneur, et le rejeu Timefold de la soirée de
# référence, refait dans l'image et comparé au Java de cette machine.
# Conteneurs et volumes nommés verif-image-<pid>, retirés à la fin, même en
# échec ou interrompu. Aucune connexion au vrai KaraFun : la démo parle au faux
# KaraFun de l'image, la soirée n'a pas de code de télécommande.
#   bash test/verifier-image.sh <image>
# CI (job image) : bash test/verifier-image.sh karafun-plus:verif
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage : bash test/verifier-image.sh <image>" >&2
  exit 2
fi
IMAGE=$1
# realpath, pas cd && pwd : avec CDPATH exporté, cd écrit le dossier trouvé.
RACINE=$(realpath -- "$(dirname -- "$0")/..")
SOURCE=https://github.com/jpfroud/karafun-plus
SOIREE=test/fixtures/soiree-2026-10-15-anonyme.json

prerequis() { echo "ÉCHEC prérequis : $1" >&2; exit 1; }
for commande in docker curl node java git; do
  command -v "$commande" > /dev/null 2>&1 || prerequis "commande absente : $commande"
done
docker info > /dev/null 2>&1 || prerequis "Docker ne répond pas (docker info)."
VERSION_NODE=$(node -v)
[[ $VERSION_NODE == v22.* ]] || prerequis "Node 22 attendu, trouvé $VERSION_NODE"
# Première ligne de java --version (stdout ; JAVA_TOOL_OPTIONS s'annonce sur stderr).
LIGNE_JAVA=$(java --version 2> /dev/null | sed -n 1p) || LIGNE_JAVA=''
MOTIF_JAVA='^(openjdk|java) 21([. ]|$)'
[[ $LIGNE_JAVA =~ $MOTIF_JAVA ]] || prerequis "Java 21 attendu sur cette machine pour le rejeu de référence, trouvé « $LIGNE_JAVA »"
# solver/bridge.js préfère solver-runtime/bin/java près du code au Java du PATH.
[ ! -e "$RACINE/solver-runtime" ] \
  || prerequis "solver-runtime/ existe à la racine du dépôt ; le rejeu de référence n'utiliserait pas le Java de cette machine. Le déplacer puis relancer."
docker image inspect "$IMAGE" > /dev/null 2>&1 || prerequis "image introuvable : $IMAGE"

PREFIXE="verif-image-$$"
TMP=$(mktemp -d)
COMPTE=0
ID=''
LIBELLE=''
SIGNALE=0
URLS=(-e KARAOKE_PUBLIC_URL=https://clients.exemple.fr -e KARAOKE_STAFF_URL=https://bar.exemple.fr)
PORTS=(-p 127.0.0.1::3000 -p 127.0.0.1::3001)
VOLUMES=(-v "$PREFIXE-data:/app/data" -v "$PREFIXE-journal:/app/journal")

nettoyer() {
  local code=$? nom
  trap - EXIT INT TERM
  set +e
  # Commande en échec hors d'un contrôle (set -e) : signalée, code 1.
  if [ "$code" != 0 ] && [ "$SIGNALE" = 0 ] && [ "$code" != 130 ] && [ "$code" != 143 ]; then
    echo "ÉCHEC ${ID:-préparation} $LIBELLE : commande en échec (code $code)" >&2
    code=1
  fi
  while IFS= read -r nom; do
    [[ $nom == "$PREFIXE-"* ]] || continue
    if [ "$code" != 0 ]; then
      echo "--- journaux de $nom (200 dernières lignes) ---" >&2
      docker logs --tail 200 "$nom" >&2
    fi
    docker rm -f -v "$nom" > /dev/null 2>&1
  done < <(docker ps -a --filter "name=$PREFIXE-" --format '{{.Names}}' 2> /dev/null)
  docker volume rm -f "$PREFIXE-data" "$PREFIXE-journal" > /dev/null 2>&1
  rm -rf "$TMP"
  exit "$code"
}
trap nettoyer EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

controle() { ID=$1; LIBELLE=$2; }
ok() { COMPTE=$((COMPTE + 1)); echo "OK  $ID $LIBELLE"; }
echec() { SIGNALE=1; echo "ÉCHEC $ID $LIBELLE : $1" >&2; exit 1; }
# Requêtes directes, jamais par un proxy de l'environnement.
requete() { curl --noproxy '*' -sS --max-time 10 "$@"; }
# port_hote <conteneur> <port> : 127.0.0.1:<port de l'hôte> publié par Docker.
port_hote() {
  local adresse
  adresse=$(docker port "$1" "$2/tcp" 2> /dev/null | sed -n '/^127\.0\.0\.1:[0-9]*$/p' | sed -n 1p)
  [ -n "$adresse" ] && echo "$adresse"
}
# attendre <secondes> <commande…> : vrai dès que la commande réussit (essai toutes les 0,5 s).
attendre() {
  local fin=$((SECONDS + $1))
  shift
  until "$@" > /dev/null 2>&1; do
    [ "$SECONDS" -lt "$fin" ] || return 1
    sleep 0.5
  done
}
statut_est() { [ "$(requete -o /dev/null -w '%{http_code}' --max-time 2 "$2" 2> /dev/null)" = "$1" ]; }
# attendre_http <secondes> <code HTTP> <adresse>
attendre_http() { attendre "$1" statut_est "$2" "$3"; }
# État de la page du bar (JSON), avec la clé du bar.
etat_bar() { requete -f "http://$BAR/api/staff/state?key=$KEY"; }
# champ_json <expression de d> : valeur lue dans le JSON de l'entrée (texte tel quel, sinon JSON).
champ_json() {
  node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const v = new Function("d", "return (" + process.argv[1] + ");")(d);
process.stdout.write(typeof v === "string" ? v : String(JSON.stringify(v)));
' "$1"
}
JS_COMMUN='const fs = require("fs");
const faute = texte => { console.log(texte); process.exit(1); };
const entree = () => JSON.parse(fs.readFileSync(0, "utf8"));
const lire = fichier => JSON.parse(fs.readFileSync(fichier, "utf8"));
const meme = (a, b) => JSON.stringify(a) === JSON.stringify(b);
'
# verifier_json <script> <arguments…> : contrôle par node (premier défaut affiché).
verifier_json() {
  local script=$1 detail
  shift
  detail=$(node -e "$JS_COMMUN$script" "$@" 2>&1) || echec "$detail"
}
# Sortie de docker logs (stdout et stderr) dans un fichier.
journaux() { docker logs "$1" > "$2" 2>&1; }
# sans_cle <fichier de journaux> : ni la clé du bar ni un lien staff?key=.
sans_cle() {
  ! grep -qF -- "$KEY" "$1" || echec "la clé du bar apparaît dans docker logs"
  ! grep -qF 'staff?key=' "$1" || echec "un lien staff?key= apparaît dans docker logs"
}
# empreinte <clé> : début du SHA-256, comme le journal du serveur.
empreinte() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 8))' "$1"; }
ligne_au_journal() { journaux "$1" "$TMP/attente.log" && grep -qE "$2" "$TMP/attente.log"; }
# arreter <conteneur> : docker stop -t 20, puis code de sortie 0 exigé.
arreter() {
  local sortie
  docker stop -t 20 "$1" > /dev/null || echec "docker stop $1 en échec"
  sortie=$(docker inspect -f '{{.State.ExitCode}}' "$1")
  [ "$sortie" = 0 ] || echec "code de sortie $sortie, attendu 0 (137 : arrêt forcé par SIGKILL)"
}
# refus <message attendu> <options de docker run…> : refus de démarrer en 30 s,
# code 1, stderr exactement le message.
REFUS=0
refus() {
  local attendu=$1 code=0
  shift
  REFUS=$((REFUS + 1))
  timeout 30 docker run --rm --name "$PREFIXE-refus$REFUS" "$@" "$IMAGE" > "$TMP/refus.out" 2> "$TMP/refus.err" || code=$?
  [ "$code" = 1 ] || echec "code $code, attendu 1 (124 : toujours en marche après 30 s) ; stderr : $(head -c 300 "$TMP/refus.err")"
  [ "$(cat "$TMP/refus.err")" = "$attendu" ] || echec "stderr : $(head -c 300 "$TMP/refus.err")"
}
# Contrôle du JSON d'un rejeu (fichier, jar attendu facultatif).
verifier_rejeu() {
  verifier_json '
const r = lire(process.argv[1]), t = r.timefold;
if (!t) faute("rejeu sans Timefold");
if (!(t.asked > 0)) faute("timefold.asked = " + t.asked + ", attendu au moins 1");
if (t.ok !== t.asked) faute("timefold.ok = " + t.ok + " pour " + t.asked + " demandes");
if (t.failed !== 0) faute("timefold.failed = " + t.failed);
if (t.ceiling !== 0) faute("timefold.ceiling = " + t.ceiling + " (plafond de temps atteint)");
if (t.moves !== 20000) faute("timefold.moves = " + t.moves + ", attendu 20000");
if (process.argv[2] && r.jar !== process.argv[2]) faute("jar = " + r.jar + ", attendu " + process.argv[2]);
' "$@"
}

INSPECT=$(docker image inspect "$IMAGE")

# ---------------------------------------------------------------- V01
controle V01 'utilisateur node'
UTILISATEUR=$(champ_json 'd[0].Config.User' <<< "$INSPECT")
[ "$UTILISATEUR" = node ] || echec "User = « $UTILISATEUR », attendu node"
ok

# ---------------------------------------------------------------- V02
controle V02 "point d'entrée"
POINT=$(champ_json 'd[0].Config.Entrypoint' <<< "$INSPECT")
[ "$POINT" = '["docker-entrypoint.sh"]' ] || echec "Entrypoint = $POINT, attendu [\"docker-entrypoint.sh\"] (celui de node:22-bookworm-slim)"
COMMANDE_IMAGE=$(champ_json 'd[0].Config.Cmd' <<< "$INSPECT")
[ "$COMMANDE_IMAGE" = '["node","server.js","--no-open"]' ] || echec "Cmd = $COMMANDE_IMAGE, attendu [\"node\",\"server.js\",\"--no-open\"]"
ok

# ---------------------------------------------------------------- V03
controle V03 'ports et volumes déclarés'
verifier_json '
const c = entree()[0].Config;
const ports = Object.keys(c.ExposedPorts || {}).sort(), volumes = Object.keys(c.Volumes || {}).sort();
if (!meme(ports, ["3000/tcp", "3001/tcp"])) faute("ports déclarés : " + (ports.join(", ") || "aucun") + ", attendu 3000/tcp et 3001/tcp");
if (!meme(volumes, ["/app/data", "/app/journal"])) faute("volumes déclarés : " + (volumes.join(", ") || "aucun") + ", attendu /app/data et /app/journal");
' <<< "$INSPECT"
ok

# ---------------------------------------------------------------- V04
controle V04 "variables de l'image"
verifier_json '
const env = entree()[0].Config.Env || [];
const valeurs = nom => env.filter(e => e.startsWith(nom + "=")).map(e => e.slice(nom.length + 1));
const attendu = { KARAOKE_MODE: "server", KARAOKE_BIND: "0.0.0.0", KARAOKE_PUBLIC_BIND: "0.0.0.0",
  KARAOKE_CLIENT_IP_HEADER: "x-real-ip", TZ: "Europe/Paris" };
for (const [nom, valeur] of Object.entries(attendu)) {
  if (!meme(valeurs(nom), [valeur])) faute(nom + " = " + (valeurs(nom).join(" ; ") || "absente") + ", attendu " + valeur);
}
for (const nom of ["KARAOKE_PUBLIC_URL", "KARAOKE_STAFF_URL", "KARAOKE_STAFF_KEY_FILE", "KARAOKE_TRUSTED_PROXIES", "KARAOKE_SOLVER_JVM_ARGS"]) {
  if (valeurs(nom).length) faute(nom + " fixée dans l\u2019image (réglage du déploiement)");
}
' <<< "$INSPECT"
ok

# ---------------------------------------------------------------- V05
controle V05 'contrôle de santé déclaré'
verifier_json '
const h = entree()[0].Config.Healthcheck;
const test = (h && h.Test || []).join(" ");
if (!test.includes("127.0.0.1:3001/healthz")) faute("HEALTHCHECK sans 127.0.0.1:3001/healthz : " + (test || "aucun"));
' <<< "$INSPECT"
ok

# ---------------------------------------------------------------- V06
controle V06 'étiquettes OCI'
REVISION=$(git -C "$RACINE" rev-parse HEAD 2>&1) || echec "git rev-parse HEAD : $REVISION"
verifier_json '
const l = entree()[0].Config.Labels || {}, n = "org.opencontainers.image.";
const [source, revision] = process.argv.slice(1);
if (l[n + "source"] !== source) faute(n + "source = " + l[n + "source"] + ", attendu " + source);
if (l[n + "revision"] !== revision) faute(n + "revision = « " + l[n + "revision"] + " », attendu " + revision + " (git rev-parse HEAD)");
for (const k of ["version", "created"]) if (!l[n + k]) faute(n + k + " vide");
' "$SOURCE" "$REVISION" <<< "$INSPECT"
ok

# ---------------------------------------------------------------- V07
controle V07 'build-info.json'
docker run --rm --name "$PREFIXE-info" "$IMAGE" cat /app/build-info.json > "$TMP/build-info.json" 2> "$TMP/info.err" \
  || echec "lecture de /app/build-info.json en échec : $(head -c 300 "$TMP/info.err")"
verifier_json '
const l = entree()[0].Config.Labels || {}, n = "org.opencontainers.image.";
const info = lire(process.argv[1]), revision = process.argv[2];
if (info.version !== l[n + "version"]) faute("version = " + info.version + ", étiquette " + l[n + "version"]);
if (info.commit !== revision) faute("commit = « " + info.commit + " », attendu " + revision);
if (info.builtAt !== l[n + "created"]) faute("builtAt = " + info.builtAt + ", étiquette created " + l[n + "created"]);
' "$TMP/build-info.json" "$REVISION" <<< "$INSPECT"
ok

# ---------------------------------------------------------------- V08
controle V08 'fichiers livrés'
# Contrôle fait dans le conteneur (uid de l'image), listes de livrable.json.
VUE=$(docker run --rm --name "$PREFIXE-fichiers" "$IMAGE" node -e "$JS_COMMUN"'
const path = require("path");
const m = JSON.parse(process.argv[1]), app = "/app";
const attendu = [...new Set(m.commun.map(e => e.split("/")[0])), "build-info.json", "node_modules", "solver-runtime",
  "LICENCES-JAVA", "data", "journal"].sort();
const vus = fs.readdirSync(app).sort();
const absents = attendu.filter(e => !vus.includes(e)), enTrop = vus.filter(e => !attendu.includes(e));
if (absents.length || enTrop.length) faute("/app : absents " + (absents.join(", ") || "aucun") + " ; en trop " + (enTrop.join(", ") || "aucun"));
for (const e of m.commun) if (!fs.existsSync(path.join(app, e))) faute("fichier de « commun » absent : " + e);
const solveur = fs.readdirSync(path.join(app, "solver")).sort();
if (!meme(solveur, ["bridge.js", "karafun-solver.jar"])) faute("/app/solver : " + solveur.join(", ") + ", attendu bridge.js et karafun-solver.jar");
for (const e of ["start-evening.js", "stop.js", ...m.windows]) if (fs.existsSync(path.join(app, e))) faute("fichier du kit Windows livré : " + e);
for (const e of ["solver-runtime/bin/java", "LICENCES-JAVA/THIRD-PARTY.txt", "LICENCES-JAVA/licenses.xml", "LICENCES-JAVA/textes",
  "node_modules/qrcode", "node_modules/socket.io", "node_modules/socket.io-client"]) {
  if (!fs.existsSync(path.join(app, e))) faute("absent de l\u2019image : " + e);
}
if (!fs.readdirSync(path.join(app, "LICENCES-JAVA/textes")).length) faute("LICENCES-JAVA/textes vide");
for (const d of ["data", "journal"]) {
  const s = fs.statSync(path.join(app, d)), mode = (s.mode & 0o777).toString(8);
  if (!s.isDirectory() || mode !== "700" || s.uid !== process.getuid()) faute(d + " : mode " + mode + ", uid " + s.uid + ", attendu 700 à l\u2019uid du conteneur " + process.getuid());
  const contenu = fs.readdirSync(path.join(app, d));
  if (contenu.length) faute(d + " non vide : " + contenu.join(", "));
}
' "$(cat "$RACINE/livrable.json")" 2>&1) || echec "$VUE"
ok

# ---------------------------------------------------------------- V09
controle V09 "Java 21 de l'image"
code=0
docker run --rm --name "$PREFIXE-java" "$IMAGE" /app/solver-runtime/bin/java --version > "$TMP/java.out" 2> "$TMP/java.err" || code=$?
[ "$code" = 0 ] || echec "java --version : code $code, $(head -c 300 "$TMP/java.err")"
LIGNE=$(sed -n 1p "$TMP/java.out")
[[ $LIGNE =~ $MOTIF_JAVA ]] || echec "java --version : « $LIGNE », attendu openjdk 21"
ok

# ---------------------------------------------------------------- V10
controle V10 'modules Java'
docker run --rm --name "$PREFIXE-modules" "$IMAGE" /app/solver-runtime/bin/java --list-modules > "$TMP/modules.out" 2> "$TMP/modules.err" \
  || echec "java --list-modules en échec : $(head -c 300 "$TMP/modules.err")"
MODULES=$(sed 's/@.*//' "$TMP/modules.out" | sed '/^$/d' | sort | tr '\n' ' ')
[ "$MODULES" = 'java.base java.logging java.management java.xml jdk.management jdk.unsupported ' ] \
  || echec "modules : ${MODULES% }, attendu java.base java.logging java.management java.xml jdk.management jdk.unsupported"
ok

# ---------------------------------------------------------------- V11
controle V11 "Timefold dans l'image"
code=0
docker run --rm --name "$PREFIXE-fumee" -v "$RACINE/test:/app/test:ro" "$IMAGE" \
  node test/portable-solver-smoke.js solver-runtime/bin/java solver/karafun-solver.jar > "$TMP/fumee.out" 2> "$TMP/fumee.err" || code=$?
[ "$code" = 0 ] && [ "$(cat "$TMP/fumee.out")" = 'Timefold embarqué : calcul de la file confirmé.' ] \
  || echec "code $code, stdout : $(head -c 200 "$TMP/fumee.out") ; stderr : $(head -c 300 "$TMP/fumee.err")"
ok

# ---------------------------------------------------------------- V12
controle V12 'refus sans adresse obligatoire'
refus "Impossible de démarrer : KARAOKE_PUBLIC_URL manque : indique l’adresse HTTPS des QR clients, par exemple https://chant.exemple.fr." \
  -e KARAOKE_STAFF_URL=https://bar.exemple.fr
refus "Impossible de démarrer : KARAOKE_STAFF_URL manque : indique l’adresse HTTPS de la page du bar, par exemple https://bar.exemple.fr." \
  -e KARAOKE_PUBLIC_URL=https://clients.exemple.fr
ok

# ---------------------------------------------------------------- V13
controle V13 "refus d'une adresse clients en http"
refus 'Impossible de démarrer : KARAOKE_PUBLIC_URL invalide : Une adresse accessible depuis Internet doit utiliser HTTPS.' \
  -e KARAOKE_PUBLIC_URL=http://clients.exemple.fr -e KARAOKE_STAFF_URL=https://bar.exemple.fr
ok

# ---------------------------------------------------------------- V14
controle V14 "refus d'une clé du bar trop courte"
printf 'abcdefghij\n' > "$TMP/cle-courte"
chmod 644 "$TMP/cle-courte"
refus 'Impossible de démarrer : La clé de KARAOKE_STAFF_KEY_FILE doit compter au moins 22 caractères parmi A-Z, a-z, 0-9, - et _.' \
  "${URLS[@]}" -v "$TMP/cle-courte:/run/cle-du-bar:ro" -e KARAOKE_STAFF_KEY_FILE=/run/cle-du-bar
ok

# ---------------------------------------------------------------- V15
controle V15 '/healthz du bar'
KEY=$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("base64url"))')
printf '%s\n' "$KEY" > "$TMP/cle-du-bar"
chmod 644 "$TMP/cle-du-bar"
DEMO=$PREFIXE-demo
docker run -d --init --name "$DEMO" "${PORTS[@]}" "${URLS[@]}" -v "$TMP/cle-du-bar:/run/cle-du-bar:ro" \
  -e KARAOKE_STAFF_KEY_FILE=/run/cle-du-bar "$IMAGE" node server.js --server --demo --no-open --song-seconds 30 > /dev/null
BAR=$(port_hote "$DEMO" 3000) || echec "port 3000 non publié sur 127.0.0.1"
CLI=$(port_hote "$DEMO" 3001) || echec "port 3001 non publié sur 127.0.0.1"
attendre_http 30 200 "http://$BAR/healthz" || echec "pas de réponse 200 de BAR/healthz en 30 s"
CORPS=$(requete "http://$BAR/healthz")
[ "$CORPS" = ok ] || echec "BAR/healthz : « $CORPS », attendu ok"
ok

# ---------------------------------------------------------------- V16
controle V16 '/healthz du port clients'
REPONSE=$(requete -w '\n%{http_code}' "http://$CLI/healthz") || echec "CLI/healthz en échec"
[ "$REPONSE" = $'ok\n200' ] || echec "CLI/healthz : $(tr '\n' ' ' <<< "$REPONSE"), attendu ok et 200"
for cible in "$BAR" "$CLI"; do
  s=$(requete -I -o /dev/null -w '%{http_code}' "http://$cible/healthz") || s="curl $?"
  [ "$s" = 200 ] || echec "HEAD http://$cible/healthz : $s, attendu 200"
done
ok

# ---------------------------------------------------------------- V17
controle V17 'GET / refusé sans redirection'
for cible in "$BAR" "$CLI"; do
  s=$(requete -D "$TMP/v17.h" -o "$TMP/v17.b" -w '%{http_code}' "http://$cible/") || echec "GET http://$cible/ en échec"
  [ "$s" = 403 ] || echec "GET http://$cible/ : HTTP $s, attendu 403"
  [ "$(cat "$TMP/v17.b")" = 'Scanne le QR code de ta table.' ] || echec "GET http://$cible/ : « $(head -c 200 "$TMP/v17.b") »"
  ! grep -qi '^location:' "$TMP/v17.h" || echec "GET http://$cible/ : en-tête Location présent"
done
# Par les ports publiés, le conteneur voit la passerelle du réseau Docker, jamais
# 127.0.0.1 : la boucle locale du conteneur est essayée de l'intérieur.
VUE=$(docker exec "$DEMO" node -e '
fetch("http://127.0.0.1:3000/", { redirect: "manual" }).then(async r => {
  const corps = await r.text();
  if (r.status !== 403 || r.headers.has("location") || corps !== "Scanne le QR code de ta table.") {
    console.log("HTTP " + r.status + (r.headers.has("location") ? ", en-tête Location présent" : "") + (corps ? ", « " + corps.slice(0, 100) + " »" : ""));
    process.exit(1);
  }
}, e => { console.log(e.message); process.exit(1); });' 2>&1) \
  || echec "GET http://127.0.0.1:3000/ dans le conteneur : ${VUE:-sans réponse} (la boucle locale ne doit donner aucun droit)"
ok

# ---------------------------------------------------------------- V18
controle V18 'arrêt par HTTP fermé'
s=$(requete -X POST -o "$TMP/v18.b" -w '%{http_code}' "http://$BAR/internal/shutdown") || echec "POST /internal/shutdown en échec"
[ "$s" = 404 ] && [ "$(cat "$TMP/v18.b")" = '{"error":"Introuvable"}' ] \
  || echec "POST BAR/internal/shutdown : HTTP $s, « $(head -c 200 "$TMP/v18.b") », attendu 404 {\"error\":\"Introuvable\"}"
ok

# ---------------------------------------------------------------- V19
controle V19 'démo prête'
demo_prete() { ETAT=$(etat_bar) && [ "$(champ_json 'd.karafun.demo === true && d.karafun.ready === true' <<< "$ETAT")" = true ]; }
attendre 30 demo_prete || echec "karafun.demo et karafun.ready pas vrais en 30 s"
ok

# ---------------------------------------------------------------- V20
controle V20 'clé du bar refusée sur le port clients'
s=$(requete -o /dev/null -w '%{http_code}' "http://$CLI/api/staff/state?key=$KEY") || echec "CLI/api/staff/state en échec"
[ "$s" = 403 ] || echec "CLI/api/staff/state avec la clé : HTTP $s, attendu 403"
ok

# ---------------------------------------------------------------- V21
controle V21 'en-têtes du mode serveur'
requete -D "$TMP/page-du-bar.h" -o /dev/null "http://$BAR/staff?key=$KEY" || echec "BAR/staff en échec"
requete -D "$TMP/port-clients.h" -o /dev/null "http://$CLI/" || echec "CLI/ en échec"
verifier_json '
const attendus = { "strict-transport-security": "max-age=31536000", "x-content-type-options": "nosniff",
  "x-frame-options": "DENY", "content-security-policy": "frame-ancestors \u0027none\u0027" };
for (const fichier of process.argv.slice(1)) {
  const lignes = fs.readFileSync(fichier, "utf8").split(/\r?\n/), nom = fichier.split("/").pop().replace(/\.h$/, "");
  for (const [entete, valeur] of Object.entries(attendus)) {
    const vus = lignes.filter(l => l.toLowerCase().startsWith(entete + ":")).map(l => l.slice(entete.length + 1).trim());
    if (!meme(vus, [valeur])) faute(nom + " : " + entete + " = " + (vus.join(" | ") || "absent") + ", attendu une fois " + valeur);
  }
}
' "$TMP/page-du-bar.h" "$TMP/port-clients.h"
ok

# ---------------------------------------------------------------- V22
controle V22 '/readyz sans secret'
attendre_http 30 200 "http://$BAR/readyz" || echec "BAR/readyz pas à 200 en 30 s"
s=$(requete -o "$TMP/v22.b" -w '%{http_code}|%{content_type}' "http://$BAR/readyz") || echec "BAR/readyz en échec"
[ "$s" = '200|application/json; charset=utf-8' ] || echec "BAR/readyz : $s, attendu 200 et application/json; charset=utf-8"
[ "$(cat "$TMP/v22.b")" = '{"ok":true,"mode":"server","karafun":"connected","solver":"off","persistence":"off"}' ] \
  || echec "BAR/readyz : $(head -c 300 "$TMP/v22.b")"
REPONSE=$(requete -w '\n%{http_code}' "http://$CLI/readyz") || echec "CLI/readyz en échec"
[ "$REPONSE" = $'Introuvable\n404' ] || echec "CLI/readyz : $(tr '\n' ' ' <<< "$REPONSE"), attendu Introuvable et 404"
ok

# ---------------------------------------------------------------- V23
controle V23 'faux KaraFun sur la boucle locale'
read -r IP _ <<< "$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$DEMO") "
[[ $IP =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || echec "adresse IP du conteneur introuvable"
REPONSE=$(requete --max-time 3 -w '\n%{http_code}' "http://$IP:3000/healthz") || echec "http://$IP:3000/healthz en échec"
[ "$REPONSE" = $'ok\n200' ] || echec "http://$IP:3000/healthz : $(tr '\n' ' ' <<< "$REPONSE")"
# Le refus ci-dessous ne prouve quelque chose que si le faux KaraFun écoute bien sur 127.0.0.1:4001.
docker exec "$DEMO" node -e 'fetch("http://127.0.0.1:4001/").then(() => process.exit(0), () => process.exit(1))' \
  || echec "faux KaraFun absent de 127.0.0.1:4001 dans le conteneur : le refus sur $IP:4001 ne prouverait rien"
code=0
requete --max-time 3 -o /dev/null "http://$IP:4001/" 2> /dev/null || code=$?
[ "$code" = 7 ] || echec "http://$IP:4001/ : curl code $code, attendu 7 (connexion refusée : faux KaraFun sur 127.0.0.1 seulement)"
ok

# ---------------------------------------------------------------- V24
controle V24 'conteneur sain'
sain() { [ "$(docker inspect -f '{{.State.Health.Status}}' "$DEMO")" = healthy ]; }
attendre 90 sain || echec "état $(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}sans contrôle de santé{{end}}' "$DEMO") après 90 s, attendu healthy"
ok

# ---------------------------------------------------------------- V25
controle V25 'journaux sans clé'
journaux "$DEMO" "$TMP/demo.log"
sans_cle "$TMP/demo.log"
! grep -qF 'Laisse cette fenêtre ouverte' "$TMP/demo.log" || echec "texte du mode PC « Laisse cette fenêtre ouverte » dans docker logs"
grep -qE '^Mode +: serveur$' "$TMP/demo.log" || echec "ligne « Mode : serveur » absente"
grep -qE '^Fuseau horaire +: Europe/Paris$' "$TMP/demo.log" || echec "ligne « Fuseau horaire : Europe/Paris » absente"
grep -qE "^Clé du bar +: empreinte $(empreinte "$KEY") \(KARAOKE_STAFF_KEY_FILE\)$" "$TMP/demo.log" \
  || echec "ligne « Clé du bar : empreinte <8 hex> (KARAOKE_STAFF_KEY_FILE) » absente ou d'une autre clé"
ok

# ---------------------------------------------------------------- V26
controle V26 'arrêt de la démo par SIGTERM'
arreter "$DEMO"
journaux "$DEMO" "$TMP/demo.log"
grep -qxF 'Arrêt de la file karaoké (signal SIGTERM).' "$TMP/demo.log" || echec "« Arrêt de la file karaoké (signal SIGTERM). » absent de docker logs"
docker rm -v "$DEMO" > /dev/null
ok

# ---------------------------------------------------------------- V27
controle V27 "mode serveur par la variable de l'image"
SOIREE1=$PREFIXE-soiree
# Sans argument : CMD de l'image, mode serveur par KARAOKE_MODE=server.
docker run -d --init --name "$SOIREE1" "${PORTS[@]}" "${URLS[@]}" "${VOLUMES[@]}" "$IMAGE" > /dev/null
BAR=$(port_hote "$SOIREE1" 3000) || echec "port 3000 non publié sur 127.0.0.1"
CLI=$(port_hote "$SOIREE1" 3001) || echec "port 3001 non publié sur 127.0.0.1"
attendre_http 30 200 "http://$BAR/healthz" || echec "pas de réponse 200 de BAR/healthz en 30 s"
attendre_http 30 200 "http://$CLI/healthz" || echec "pas de réponse 200 de CLI/healthz en 30 s"
s=$(requete -o "$TMP/v27.b" -w '%{http_code}' "http://$BAR/readyz") || echec "BAR/readyz en échec"
[ "$s" = 503 ] && [ "$(cat "$TMP/v27.b")" = '{"ok":false,"mode":"server","karafun":"no-code","solver":"available","persistence":"ok"}' ] \
  || echec "BAR/readyz : HTTP $s, $(head -c 300 "$TMP/v27.b")"
ok

# ---------------------------------------------------------------- V28
controle V28 'lien du bar'
code=0
docker exec "$SOIREE1" node server.js --print-staff-url > "$TMP/lien.out" 2> "$TMP/lien.err" || code=$?
[ "$code" = 0 ] || echec "--print-staff-url : code $code, $(head -c 300 "$TMP/lien.err")"
[ ! -s "$TMP/lien.err" ] || echec "--print-staff-url : stderr non vide : $(head -c 300 "$TMP/lien.err")"
MOTIF_LIEN='^https://bar\.exemple\.fr/staff\?key=([A-Za-z0-9_-]{22})$'
LIEN=$(cat "$TMP/lien.out")
[ "$(wc -l < "$TMP/lien.out")" = 1 ] && [[ $LIEN =~ $MOTIF_LIEN ]] \
  || echec "stdout de --print-staff-url sans la forme https://bar.exemple.fr/staff?key=<22 caractères A-Z, a-z, 0-9, - ou _>"
KEY=${BASH_REMATCH[1]}
DROITS=$(docker exec "$SOIREE1" stat -c '%a %U' /app/data/staff-key 2>&1) || echec "stat de data/staff-key : $DROITS"
[ "$DROITS" = '600 node' ] || echec "data/staff-key en « $DROITS », attendu 600 node"
attendre 10 ligne_au_journal "$SOIREE1" "^Clé du bar +: empreinte $(empreinte "$KEY") \(data/staff-key, créée à ce démarrage\)$" \
  || echec "ligne « Clé du bar : empreinte <8 hex> (data/staff-key, créée à ce démarrage) » absente ou d'une autre clé"
ok

# ---------------------------------------------------------------- V29
controle V29 'KaraFun jamais contacté'
ETAT=$(etat_bar) || echec "état du bar illisible avec la clé de --print-staff-url"
verifier_json '
const d = entree();
if (d.karafun.connected !== false || d.karafun.demo !== false) faute("karafun = " + JSON.stringify(d.karafun) + ", attendu connected et demo faux");
if (d.code !== "") faute("code KaraFun « " + d.code + " », attendu vide");
' <<< "$ETAT"
ok

# ---------------------------------------------------------------- V30
controle V30 'soirée créée'
# poster <adresse> <corps JSON> <fichier de réponse> : 200 exigé.
poster() {
  local s
  s=$(requete -o "$3" -w '%{http_code}' -H 'Content-Type: application/json' --data "$2" "$1") || echec "POST ${1%%\?*} en échec"
  [ "$s" = 200 ] || echec "POST ${1%%\?*} : HTTP $s, $(head -c 300 "$3")"
}
poster "http://$BAR/api/staff/table?key=$KEY" '{"id":"T1","headcount":2}' "$TMP/table.json"
ETAT=$(etat_bar) || echec "état du bar illisible"
ADRESSE_T1=$(champ_json '(d.tables.find(t => t.id === "T1") || {}).url' <<< "$ETAT")
MOTIF_T1='^https://clients\.exemple\.fr/t/T1/([A-Za-z0-9_-]{22})$'
[[ $ADRESSE_T1 =~ $MOTIF_T1 ]] || echec "adresse de T1 sans la forme https://clients.exemple.fr/t/T1/<accès> : « ${ADRESSE_T1:0:40}… »"
ACCES=${BASH_REMATCH[1]}
s=$(requete -o /dev/null -w '%{http_code}' "http://$CLI/t/T1/$ACCES") || echec "GET CLI/t/T1/<accès> en échec"
[ "$s" = 200 ] || echec "GET CLI/t/T1/<accès> : HTTP $s, attendu 200"
poster "http://$CLI/api/table/person" "{\"table\":\"T1\",\"access\":\"$ACCES\",\"name\":\"S01\"}" "$TMP/personne.json"
PERSONNE=$(champ_json 'd.id' < "$TMP/personne.json")
JETON=$(champ_json 'd.token' < "$TMP/personne.json")
CORPS=$(node -e 'const [access, personId, token] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ table: "T1", access, personId, token, song: { songId: 801, title: "Titre essai", artist: "Essai" } }));' \
  "$ACCES" "$PERSONNE" "$JETON")
poster "http://$CLI/api/table/song" "$CORPS" "$TMP/titre.json"
# soiree_presente <adresse de T1> <id de S01> : S01 dans people, son titre dans queue.
soiree_presente() {
  ETAT=$(etat_bar) || echec "état du bar illisible"
  verifier_json '
const d = entree(), [adresse, id] = process.argv.slice(1);
const t1 = d.tables.find(t => t.id === "T1");
if (!t1 || t1.url !== adresse) faute("adresse de T1 changée ou table absente");
if (!d.people.some(p => p.name === "S01" && p.id === id)) faute("S01 absent de people");
if (!d.queue.some(l => l.id === id || (l.ids || []).includes(id))) faute("titre de S01 absent de queue");
' "$1" "$2" <<< "$ETAT"
}
soiree_presente "$ADRESSE_T1" "$PERSONNE"
ok

# ---------------------------------------------------------------- V31
controle V31 'arrêt par SIGTERM journalisé'
# Son absence après l'arrêt ne prouve quelque chose que s'il existe pendant la marche.
docker exec "$SOIREE1" test -f /app/data/runtime-3000.json \
  || echec "data/runtime-3000.json absent pendant la marche : son absence après l'arrêt ne prouverait rien"
arreter "$SOIREE1"
# Clé créée dans data/staff-key (chemin du serveur) : absente de docker logs.
journaux "$SOIREE1" "$TMP/soiree.log"
sans_cle "$TMP/soiree.log"
COPIE=$TMP/copie
mkdir "$COPIE"
docker cp -q "$SOIREE1:/app/data" "$COPIE/data" || echec "docker cp de /app/data en échec"
docker cp -q "$SOIREE1:/app/journal" "$COPIE/journal" || echec "docker cp de /app/journal en échec"
SOIREE_ID=$(node -e "$JS_COMMUN"'
const racine = process.argv[1], dossier = racine + "/data/soirees";
if (fs.existsSync(racine + "/data/runtime-3000.json")) faute("data/runtime-3000.json laissé après l\u2019arrêt");
const soirees = fs.existsSync(dossier) ? fs.readdirSync(dossier).filter(s => fs.existsSync(dossier + "/" + s + "/journal.jsonl")) : [];
if (soirees.length !== 1) faute(soirees.length + " fichier(s) soirees/*/journal.jsonl, attendu 1");
const lignes = fs.readFileSync(dossier + "/" + soirees[0] + "/journal.jsonl", "utf8").trim().split("\n").map(l => JSON.parse(l));
const derniere = lignes[lignes.length - 1];
if (derniere.ev !== "app.stopped" || derniere.reason !== "SIGTERM") faute("dernière ligne du journal de soirée : " + derniere.ev + " (reason " + derniere.reason + "), attendu app.stopped (reason SIGTERM)");
const meta = lire(dossier + "/" + soirees[0] + "/meta.json");
if (meta.timezone !== "Europe/Paris") faute("meta.json : timezone " + meta.timezone + ", attendu Europe/Paris");
const journaux = fs.readdirSync(racine + "/journal").filter(f => /^serveur-.*\.log$/.test(f));
const vu = journaux.some(f => fs.readFileSync(racine + "/journal/" + f, "utf8").split("\n").some(l => l.endsWith(" Arrêt de la file karaoké (signal SIGTERM).")));
if (!vu) faute("« Arrêt de la file karaoké (signal SIGTERM). » absent de journal/serveur-*.log (" + (journaux.join(", ") || "aucun") + ")");
process.stdout.write(soirees[0]);
' "$COPIE" 2>&1) || echec "$SOIREE_ID"
ok

# ---------------------------------------------------------------- V32
controle V32 'clé écrite seulement dans data/staff-key'
TROUVES=$(grep -rlF -- "$KEY" "$COPIE" | sort) || TROUVES=''
[ "$TROUVES" = "$COPIE/data/staff-key" ] || echec "clé du bar trouvée dans : ${TROUVES//"$COPIE/"/} (attendu data/staff-key seul)"
ok

# ---------------------------------------------------------------- V33
controle V33 'redémarrage'
docker rm "$SOIREE1" > /dev/null
SOIREE2=$PREFIXE-soiree2
docker run -d --init --name "$SOIREE2" "${PORTS[@]}" "${URLS[@]}" "${VOLUMES[@]}" "$IMAGE" > /dev/null
BAR=$(port_hote "$SOIREE2" 3000) || echec "port 3000 non publié sur 127.0.0.1"
CLI=$(port_hote "$SOIREE2" 3001) || echec "port 3001 non publié sur 127.0.0.1"
attendre_http 30 200 "http://$BAR/healthz" || echec "pas de réponse 200 de BAR/healthz en 30 s"
attendre_http 30 200 "http://$CLI/healthz" || echec "pas de réponse 200 de CLI/healthz en 30 s"
code=0
docker exec "$SOIREE2" node server.js --print-staff-url > "$TMP/lien2.out" 2> "$TMP/lien2.err" || code=$?
[ "$code" = 0 ] || echec "--print-staff-url : code $code, $(head -c 300 "$TMP/lien2.err")"
[ "$(cat "$TMP/lien2.out")" = "$LIEN" ] || echec "lien du bar changé au redémarrage (nouvelle clé)"
attendre 10 ligne_au_journal "$SOIREE2" "^Clé du bar +: empreinte $(empreinte "$KEY") \(data/staff-key\)$" \
  || echec "ligne « Clé du bar : empreinte <8 hex> (data/staff-key) » absente ou d'une autre clé"
ok

# ---------------------------------------------------------------- V34
controle V34 'soirée restaurée'
soiree_presente "$ADRESSE_T1" "$PERSONNE"
SOIREES=$(docker exec "$SOIREE2" ls -A /app/data/soirees 2>&1) || echec "ls /app/data/soirees : $SOIREES"
[ "$SOIREES" = "$SOIREE_ID" ] || echec "dossiers de soirée : $(tr '\n' ' ' <<< "$SOIREES"), attendu $SOIREE_ID seul"
docker exec "$SOIREE2" cat "/app/data/soirees/$SOIREE_ID/journal.jsonl" > "$TMP/journal2.jsonl" 2> "$TMP/journal2.err" \
  || echec "lecture du journal de soirée : $(head -c 300 "$TMP/journal2.err")"
verifier_json '
const lignes = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(l => JSON.parse(l));
const arret = lignes.findIndex(l => l.ev === "app.stopped" && l.reason === "SIGTERM");
if (arret < 0) faute("app.stopped (SIGTERM) absent du journal repris");
if (!lignes.slice(arret + 1).some(l => l.ev === "app.started" && l.restored === true)) faute("aucun app.started restored === true après app.stopped");
' "$TMP/journal2.jsonl"
ok

# ---------------------------------------------------------------- V35
controle V35 'second arrêt'
arreter "$SOIREE2"
journaux "$SOIREE2" "$TMP/soiree2.log"
sans_cle "$TMP/soiree2.log"
ok

# ---------------------------------------------------------------- V36
controle V36 'rejeu de référence sur cette machine'
docker create --name "$PREFIXE-jar" "$IMAGE" > /dev/null
docker cp -q "$PREFIXE-jar:/app/solver/karafun-solver.jar" "$TMP/karafun-solver.jar" || echec "copie du jar de l'image en échec"
docker rm -v "$PREFIXE-jar" > /dev/null
code=0
(cd "$RACINE" && TZ=Europe/Paris node test/rejeu-soiree.js "$SOIREE" --libre --solveur "$TMP/karafun-solver.jar" --cles --court \
  --json "$TMP/rejeu-hote.json") > "$TMP/rejeu-hote.txt" 2>&1 || code=$?
[ "$code" = 0 ] || echec "rejeu en échec (code $code) : $(tail -n 5 "$TMP/rejeu-hote.txt")"
verifier_rejeu "$TMP/rejeu-hote.json"
ok

# ---------------------------------------------------------------- V37
controle V37 "rejeu dans l'image"
mkdir "$TMP/sortie"
chmod 777 "$TMP/sortie"
code=0
docker run --rm --name "$PREFIXE-rejeu" -v "$RACINE/test:/app/test:ro" -v "$RACINE/solver/src:/app/solver/src:ro" \
  -v "$TMP/sortie:/sortie" "$IMAGE" node test/rejeu-soiree.js "$SOIREE" --libre --solveur --cles --court \
  --json /sortie/rejeu-image.json > "$TMP/rejeu-image.txt" 2>&1 || code=$?
[ "$code" = 0 ] || echec "rejeu en échec (code $code) : $(tail -n 5 "$TMP/rejeu-image.txt")"
verifier_rejeu "$TMP/sortie/rejeu-image.json" /app/solver/karafun-solver.jar
ok

# ---------------------------------------------------------------- V38
controle V38 "mêmes décisions avec le Java de l'image"
verifier_json '
const hote = lire(process.argv[1]), image = lire(process.argv[2]);
const champs = [...new Set([...Object.keys(hote), ...Object.keys(image)])].filter(k => k !== "jar" && k !== "warnings").sort();
for (const k of champs) {
  if (JSON.stringify(hote[k]) !== JSON.stringify(image[k])) faute("le runtime de l\u2019image ne refait pas les décisions du Java de référence (champ " + k + ")");
}
' "$TMP/rejeu-hote.json" "$TMP/sortie/rejeu-image.json"
ok

[ "$COMPTE" = 38 ] || { ID=fin; LIBELLE=comptage; echec "$COMPTE contrôles réussis sur 38"; }
echo "Image vérifiée : 38 contrôles réussis ($IMAGE)."
