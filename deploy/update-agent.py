#!/usr/bin/env python3
"""Two fixed operations: install the latest stable karafun-plus release, or
reinstall one earlier (or later) published stable release chosen by the bar.

Runs on the Docker host, never in the application container. The inputs from
that container are a UUID receipt and, for a chosen release, a version number
(vX.Y.Z) that this agent checks against the fixed repository: a stable,
complete release, at least MIN_VERSION. No command, repository, image or
digest crosses the channel. Configuration, archives and recovery records stay
in a separate, private directory owned by the operator. The agent also
publishes, at most hourly, the list of installable releases for the bar page.
"""
import argparse
import contextlib
import datetime as dt
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import urllib.request
import urllib.parse
import urllib.error
import uuid

# Raised at each agent change that a reinstall from an older checkout must not
# undo (install-update-agent.sh refuses to replace this agent by an older one).
AGENT_VERSION = 2
REPOSITORY = "jpfroud/karafun-plus"
IMAGE = "ghcr.io/" + REPOSITORY
VERSION = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
TERMINAL = {"succeeded", "failed", "rolled-back"}
MAX_JSON = 2 * 1024 * 1024
# First release whose application holds the maintenance lock and answers the
# start-up checks of healthy(): an older one could never be verified.
MIN_VERSION = (3, 1, 2)
# Installable releases published for the bar page, newest first.
CATALOGUE_SIZE = 10
CATALOGUE_REFRESH = 3600
CATALOGUE_RETRY = 600
PUBLISHED_AT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z")
# The only GitHub API requests the agent makes, all on the fixed repository.
CATALOGUE_PATH = "releases?per_page=30"
GITHUB_PATH = re.compile(r"releases/latest|" + re.escape(CATALOGUE_PATH) + r"|releases/tags/v[0-9]+\.[0-9]+\.[0-9]+")


class UpdateError(Exception):
    """A deliberately non-secret message, safe for the staff page."""


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def numbers(version):
    return tuple(map(int, version[1:].split(".")))


def atomic_bytes(path, value, mode=0o600):
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
            # Mode set on the open file, never by path: the IPC directory is
            # writable by the container, which could swap the name for a link.
            # Without os.fchmod (Windows test runs, Python < 3.13; never a
            # production host), the mode stays the one os.open applied.
            if hasattr(os, "fchmod"):
                os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
        if hasattr(os, "O_DIRECTORY"):
            directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()


def atomic_json(path, value, mode=0o600):
    atomic_bytes(path, json.dumps(value, ensure_ascii=False).encode("utf-8"), mode)


def read_json(path, limit=MAX_JSON):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) |
                         getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise UpdateError("Fichier de mise à jour invalide.")
        return json.loads(stream.read(limit + 1))


def release_info(payload):
    if not isinstance(payload, dict):
        raise UpdateError("La publication de la version n'est pas reconnue.")
    version = payload.get("tag_name", "")
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise UpdateError("La dernière version publiée n'est pas une version stable reconnue.")
    if payload.get("draft") is not False or payload.get("prerelease") is not False:
        raise UpdateError("La version n'est pas une release stable publiée.")
    published_assets = payload.get("assets")
    if not isinstance(published_assets, list) or not isinstance(payload.get("body"), str):
        raise UpdateError("La publication de la version n'est pas terminée.")
    assets = {item.get("name") for item in published_assets
              if isinstance(item, dict) and isinstance(item.get("size"), int) and item["size"] > 0}
    if not {"KIT-BAR-KARAFUN.zip", "KIT-BAR-KARAFUN.zip.sha256"}.issubset(assets):
        raise UpdateError("La publication de la version n'est pas terminée.")
    body = payload.get("body") or ""
    blocks = re.findall(r"<!-- image-docker -->(.*?)<!-- /image-docker -->", body, re.S)
    if len(blocks) != 1 or f"{IMAGE}:{version}" not in blocks[0]:
        raise UpdateError("L'image publiée n'est pas confirmée par la release.")
    digests = re.findall(re.escape(IMAGE) + r"@(sha256:[0-9a-f]{64})(?![0-9a-f])", blocks[0])
    if len(digests) != 1:
        raise UpdateError("L'empreinte de l'image publiée est absente ou ambiguë.")
    return version, digests[0]


class Agent:
    def __init__(self, repo, state):
        self.repo = Path(repo).resolve()
        self.deploy = self.repo / "deploy"
        self.ipc = self.deploy / "maintenance"
        self.private = Path(state).resolve()
        self.transaction_file = self.private / "transaction.json"
        self.current = None
        self.target = None
        self.request_id = None

    def command(self, arguments, timeout=120, data=None):
        try:
            payload = {"stdin": data} if hasattr(data, "read") else {"input": data}
            result = subprocess.run(arguments, cwd=self.deploy, capture_output=True,
                                    timeout=timeout, check=False, **payload)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise UpdateError("Une commande de mise à jour n'a pas pu se terminer.") from error
        if result.returncode:
            # Docker/Git output can carry private configuration: never publish it.
            raise UpdateError("Une commande de mise à jour a échoué ; l'ancienne version est conservée.")
        return result.stdout.decode("utf-8", errors="replace").strip()

    def compose(self, *arguments, override=None, timeout=120, data=None):
        command = ["docker", "compose", "--env-file", str(self.deploy / ".env"),
                   "-f", str(self.deploy / "compose.yaml")]
        if override:
            command += ["-f", str(override)]
        return self.command(command + list(arguments), timeout, data)

    def status(self, phase, message):
        atomic_json(self.ipc / "status.json", {
            "requestId": self.request_id, "phase": phase,
            "targetVersion": self.target, "currentVersion": self.current,
            "message": message, "updatedAt": now(),
        }, 0o660)

    def github(self, path="releases/latest"):
        # Fixed repository; only three request shapes, the version already validated.
        if not GITHUB_PATH.fullmatch(path):
            raise UpdateError("Demande de version invalide.")
        request = urllib.request.Request(
            f"https://api.github.com/repos/{REPOSITORY}/{path}",
            headers={"Accept": "application/vnd.github+json", "User-Agent": "karafun-plus-updater"})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                destination = urllib.parse.urlsplit(response.geturl())
                if destination.scheme != "https" or destination.netloc != "api.github.com":
                    raise ValueError("unexpected redirect")
                raw = response.read(MAX_JSON + 1)
            if len(raw) > MAX_JSON:
                raise ValueError("large response")
            return json.loads(raw)
        except urllib.error.HTTPError as error:
            error.close()
            if error.code == 404 and path.startswith("releases/tags/"):
                raise UpdateError("Cette version n'est pas publiée sur le dépôt officiel.") from error
            raise UpdateError("Les versions publiées sont momentanément inaccessibles. Réessaie plus tard.") from error
        except (OSError, ValueError) as error:
            raise UpdateError("Les versions publiées sont momentanément inaccessibles. Réessaie plus tard.") from error

    def catalogue(self):
        """Installable releases, newest first: stable, complete, at least MIN_VERSION.

        A release withdrawn by the maintainer (draft, pre-release, image block
        removed) disappears from this list and is refused by chosen installs.
        """
        payload = self.github(CATALOGUE_PATH)
        if not isinstance(payload, list):
            raise UpdateError("La liste des versions publiées n'est pas reconnue.")
        found = {}
        for item in payload:
            try:
                version, _digest = release_info(item)
            except UpdateError:
                continue
            if numbers(version) < MIN_VERSION or version in found:
                continue
            published = item.get("published_at")
            found[version] = published if isinstance(published, str) and PUBLISHED_AT.fullmatch(published) else None
        ordered = sorted(found, key=numbers, reverse=True)[:CATALOGUE_SIZE]
        return [{"version": version, "publishedAt": found[version]} for version in ordered]

    def refresh_catalogue(self):
        """Publish versions.json for the bar page: hourly, retried 10 min after a failure."""
        file = self.ipc / "versions.json"
        attempt = self.private / "catalogue-attempt"
        moment = time.time()
        try:
            # Our own file, in a directory the container can write: read it bounded.
            previous = read_json(file, 16 * 1024)
            checked = dt.datetime.fromisoformat(previous["checkedAt"].replace("Z", "+00:00"))
            if 0 <= moment - checked.timestamp() < CATALOGUE_REFRESH:
                return False
        except (OSError, ValueError, TypeError, KeyError, AttributeError, UpdateError):
            pass
        try:
            if 0 <= moment - attempt.stat().st_mtime < CATALOGUE_RETRY:
                return False
        except FileNotFoundError:
            pass
        atomic_bytes(attempt, b"")
        atomic_json(file, {"checkedAt": now(), "versions": self.catalogue()}, 0o660)
        return True

    def chosen_version(self):
        """Release chosen by the bar for this request (target.json), None for the latest."""
        try:
            choice = read_json(self.ipc / "target.json", 4096)
        except FileNotFoundError:
            return None
        unreadable = UpdateError("Le choix de version est illisible : aucune installation n'a été faite.")
        # A choice naming another request is ignored whatever its shape: a file
        # left by an earlier request never blocks the next ones.
        owner = choice.get("requestId") if isinstance(choice, dict) else None
        if isinstance(owner, str) and owner.lower() != self.request_id:
            return None
        if not isinstance(choice, dict) or set(choice) != {"requestId", "version"}:
            raise unreadable
        try:
            owner = uuid.UUID(choice["requestId"])
        except (ValueError, TypeError, AttributeError):
            raise unreadable from None
        if str(owner) != choice["requestId"]:
            raise unreadable
        version = choice["version"]
        if not isinstance(version, str) or not VERSION.fullmatch(version):
            raise unreadable
        if numbers(version) < MIN_VERSION:
            raise UpdateError("Cette version est antérieure au service de mise à jour : utiliser la procédure manuelle.")
        return version

    def configured_version(self):
        values = re.findall(r"^KARAFUN_PLUS_VERSION=(v[0-9]+\.[0-9]+\.[0-9]+)\s*$",
                            (self.deploy / ".env").read_text(encoding="utf-8"), re.M)
        if len(values) != 1 or not VERSION.fullmatch(values[0]):
            raise UpdateError("La version installée n'est pas reconnue.")
        return values[0]

    def prepare(self, digest, chosen=False):
        self.status("downloading", "Téléchargement et vérification de la version…")
        origin = self.command(["git", "remote", "get-url", "origin"])
        if origin.rstrip("/").removesuffix(".git") not in {
                "https://github.com/" + REPOSITORY, "git@github.com:" + REPOSITORY}:
            raise UpdateError("Le dépôt installé ne correspond pas au dépôt officiel.")
        if self.command(["git", "status", "--porcelain", "--untracked-files=no"]):
            raise UpdateError("L'installation contient des changements locaux : intervention nécessaire.")
        self.command(["git", "fetch", "--no-tags", "origin",
                      f"refs/tags/{self.target}:refs/tags/{self.target}"], timeout=120)
        commit = self.command(["git", "rev-parse", f"refs/tags/{self.target}^{{commit}}"])
        if not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise UpdateError("La révision publiée n'est pas reconnue.")
        candidate_env = self.command(["git", "show", f"{commit}:deploy/.env.example"])
        existing_env = (self.deploy / ".env").read_text(encoding="utf-8")
        names = lambda text: set(re.findall(r"^([A-Z_][A-Z_0-9]*)=", text, re.M))
        wanted, present = names(candidate_env), names(existing_env)
        # A chosen release, older or newer, may need fewer settings: the extra
        # ones stay for the next update (after a return from vN to vN-2, vN-1
        # remains possible). The latest release keeps the original rule, the
        # same settings. Any missing setting needs the administrator first.
        if not wanted <= present or (wanted != present and not chosen):
            raise UpdateError("Cette version nécessite un réglage du serveur avant son installation.")
        image = IMAGE + "@" + digest
        remote = self.command(["docker", "buildx", "imagetools", "inspect", "--format",
                               "{{json .Manifest}}", IMAGE + ":" + self.target], timeout=120)
        if json.loads(remote).get("digest") != digest:
            raise UpdateError("L'empreinte de l'image diffère de celle de la release.")
        self.command(["docker", "pull", image], timeout=600)
        inspection = json.loads(self.command(["docker", "image", "inspect", image]))[0]
        labels = inspection.get("Config", {}).get("Labels", {})
        if labels.get("org.opencontainers.image.revision") != commit or labels.get(
                "org.opencontainers.image.version") != self.target:
            raise UpdateError("L'image téléchargée ne correspond pas à la révision publiée.")
        # Caddy épinglé par empreinte (versions publiées après la v3.2.0) : une
        # image absente est téléchargée ici, avant tout arrêt, et non pendant
        # l'installation ; déjà présente, elle sert telle quelle, sans Docker
        # Hub. Les versions plus anciennes gardent l'image locale.
        compose = self.command(["git", "show", f"{commit}:deploy/compose.yaml"])
        caddy = re.findall(r"^[ \t]+image:[ \t]*(caddy:[0-9][0-9A-Za-z.-]*@sha256:[0-9a-f]{64})[ \t]*$", compose, re.M)
        if len(caddy) > 1:
            raise UpdateError("Le fichier compose de cette version n'est pas reconnu.")
        if caddy:
            try:
                self.command(["docker", "image", "inspect", "--format", "{{.Id}}", caddy[0]])
            except UpdateError:
                self.command(["docker", "pull", caddy[0]], timeout=600)
        return commit, image

    def override(self, name, image):
        path = self.private / name
        # Both values come exclusively from validated Docker/GitHub output.
        # These files are required by crash recovery: make them durable before
        # committing the transaction that refers to them.
        atomic_json(path, {"services": {"app": {"image": image}}})
        return path

    def begin(self, commit, image):
        container = self.compose("ps", "--quiet", "app")
        if not re.fullmatch(r"[0-9a-f]{12,64}", container):
            raise UpdateError("La file doit être démarrée pour préparer sa mise à jour.")
        info = json.loads(self.command(["docker", "inspect", container]))[0]
        if not info.get("State", {}).get("Running"):
            raise UpdateError("La file n'est pas en marche ; aucune mise à jour n'a été faite.")
        old_image = info.get("Image", "")
        if not DIGEST.fullmatch(old_image):
            raise UpdateError("L'image installée n'est pas reconnue.")
        before = self.private / "env.before"
        atomic_bytes(before, (self.deploy / ".env").read_bytes())
        self.override("old-image.json", old_image)
        self.override("new-image.json", image)
        old_commit = self.command(["git", "rev-parse", "HEAD"])
        if not re.fullmatch(r"[0-9a-f]{40}", old_commit):
            raise UpdateError("La révision installée n'est pas reconnue.")
        transaction = {"requestId": self.request_id, "oldVersion": self.current,
                       "targetVersion": self.target,
                       "oldCommit": old_commit,
                       "newCommit": commit, "backup": None, "changed": False}
        atomic_json(self.transaction_file, transaction)
        return transaction

    def backup(self, transaction):
        self.status("backing-up", "Sauvegarde de la soirée avant installation…")
        # Stopping first prevents sauvegarde.sh from restarting the old process.
        self.compose("stop", "app")
        output = self.command(["bash", str(self.deploy / "sauvegarde.sh")], timeout=300)
        archives = re.findall(r"Sauvegarde écrite : (sauvegardes/karafun-plus-[0-9]{8}-[0-9]{6}Z\.tar\.gz) ", output)
        if len(archives) != 1 or not (self.deploy / archives[0]).is_file():
            raise UpdateError("La sauvegarde n'a pas été confirmée. Installation annulée.")
        transaction["backup"] = archives[0]
        atomic_json(self.transaction_file, transaction)

    def install(self, transaction):
        self.status("installing", "Installation de la nouvelle version…")
        transaction["changed"] = True
        atomic_json(self.transaction_file, transaction)
        self.command(["git", "checkout", "--detach", transaction["newCommit"]])
        env = self.deploy / ".env"
        text = env.read_text(encoding="utf-8")
        text, count = re.subn(r"^KARAFUN_PLUS_VERSION=.*$", "KARAFUN_PLUS_VERSION=" + self.target,
                             text, flags=re.M)
        if count != 1:
            raise UpdateError("La configuration de version est invalide.")
        atomic_bytes(env, text.encode("utf-8"))
        self.compose("up", "-d", "app", override=self.private / "new-image.json")
        self.compose("up", "-d", "--force-recreate", "caddy", override=self.private / "new-image.json")

    def public_health(self):
        configuration = (self.deploy / ".env").read_text(encoding="utf-8")

        def endpoint_for(variable, route):
            values = re.findall(r"^" + variable + r"=(\S+)\s*$", configuration, re.M)
            if len(values) != 1:
                raise UpdateError("L'adresse HTTPS du serveur n'est pas reconnue.")
            url = urllib.parse.urlsplit(values[0])
            if (url.scheme != "https" or not url.hostname or url.username or url.password
                    or url.path not in {"", "/"} or url.query or url.fragment):
                raise UpdateError("L'adresse HTTPS du serveur n'est pas reconnue.")
            return values[0].rstrip("/") + route

        endpoint = endpoint_for("KARAOKE_PUBLIC_URL", "/healthz")
        try:
            with urllib.request.urlopen(endpoint, timeout=5) as response:
                if response.geturl() != endpoint or response.status != 200 or response.read(100).strip() != b"ok":
                    raise ValueError("unhealthy proxy")
        except (OSError, ValueError) as error:
            raise UpdateError("L'accès HTTPS n'a pas passé le contrôle de démarrage.") from error
        private_endpoint = endpoint_for("KARAOKE_STAFF_URL", "/staff")
        try:
            with urllib.request.urlopen(private_endpoint, timeout=5):
                # A successful anonymous response means BasicAuth disappeared.
                raise UpdateError("La protection de la page des gérants n'est pas confirmée.")
        except urllib.error.HTTPError as error:
            try:
                challenge = error.headers.get("WWW-Authenticate", "")
                if error.code != 401 or error.geturl() != private_endpoint or not challenge.lower().startswith("basic "):
                    raise UpdateError("La protection de la page des gérants n'est pas confirmée.") from error
            finally:
                error.close()
        except OSError as error:
            raise UpdateError("La page HTTPS des gérants n'est pas accessible.") from error

    def healthy(self, version, override):
        # A closed KaraFun is normal during maintenance. Do not test ready.ok.
        program = """const fs=require('node:fs');(async()=>{
const key=fs.readFileSync('/app/data/staff-key','utf8').trim();
const base='http://127.0.0.1:3000';
const h=await fetch(base+'/healthz');
const r=await fetch(base+'/readyz').then(x=>x.json());
const s=await fetch(base+'/api/staff/state',{headers:{'x-staff-key':key}}).then(x=>x.json());
if(h.status!==200||r.mode!=='server'||r.persistence!=='ok'||r.solver!=='available'||s.app.version!==process.argv[1]||s.update?.busy!==true)process.exitCode=1;
})().catch(()=>process.exitCode=1);"""
        for attempt in range(20):
            try:
                self.compose("exec", "-T", "app", "node", "-e", program, version,
                             override=override, timeout=10)
                self.public_health()
                return
            except UpdateError:
                if attempt == 19:
                    raise UpdateError("La nouvelle version n'a pas passé les contrôles de démarrage.")
                time.sleep(3)

    def restore(self, transaction):
        self.status("verifying", "Retour automatique à la version précédente…")
        self.compose("stop", "app")
        self.command(["git", "checkout", "--detach", transaction["oldCommit"]])
        atomic_bytes(self.deploy / ".env", (self.private / "env.before").read_bytes())
        old = self.private / "old-image.json"
        if transaction["changed"]:
            backup = transaction.get("backup")
            if not backup or not re.fullmatch(r"sauvegardes/karafun-plus-[0-9]{8}-[0-9]{6}Z\.tar\.gz", backup):
                raise UpdateError("La sauvegarde de récupération n'est pas disponible.")
            # Our own archive, verified by sauvegarde.sh, in a private host folder.
            with (self.deploy / backup).open("rb") as archive:
                self.compose("run", "--rm", "--no-deps", "-T", "app", "sh", "-c",
                             "find /app/data /app/journal -mindepth 1 -delete && tar -xzf - -C /app && chmod 700 /app/data /app/journal",
                             override=old, timeout=300, data=archive)
        self.compose("up", "-d", "app", override=old)
        self.compose("up", "-d", "--force-recreate", "caddy", override=old)
        self.healthy(transaction["oldVersion"], old)
        self.current = transaction["oldVersion"]

    def finish(self, transaction, phase, message):
        # Commit the outcome BEFORE releasing the UI. A crash after a terminal
        # status must never cause a later timer to restore yesterday's data.
        transaction["outcome"] = {"phase": phase, "message": message,
                                  "currentVersion": self.current}
        atomic_json(self.transaction_file, transaction)
        self.status(phase, message)
        self.transaction_file.unlink()

    def execute(self):
        self.private.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.private, 0o700)
        if self.transaction_file.exists():
            transaction = read_json(self.transaction_file)
            self.request_id = transaction["requestId"]
            self.current, self.target = transaction["oldVersion"], transaction["targetVersion"]
            try:
                if transaction.get("outcome"):
                    outcome = transaction["outcome"]
                    self.current = outcome["currentVersion"]
                    self.finish(transaction, outcome["phase"], outcome["message"])
                    return
                self.restore(transaction)
                self.finish(transaction, "rolled-back", "L'ancienne version a été rétablie après une interruption.")
            except Exception:
                self.status("verifying", "Récupération en cours : une intervention technique est nécessaire.")
                raise
            return
        try:
            request = read_json(self.ipc / "request.json", 4096)
        except FileNotFoundError:
            return
        if not isinstance(request, dict):
            raise UpdateError("Demande de mise à jour invalide.")
        self.request_id = request.get("id")
        try:
            request_uuid = uuid.UUID(self.request_id)
            timestamp = dt.datetime.fromisoformat(request.get("createdAt", "").replace("Z", "+00:00"))
            valid = request_uuid.version == 4 and str(request_uuid) == self.request_id and timestamp.tzinfo is not None
        except (ValueError, TypeError, AttributeError):
            valid = False
        if set(request) != {"id", "createdAt"} or not valid:
            raise UpdateError("Demande de mise à jour invalide.")
        try:
            previous = read_json(self.ipc / "status.json", 4096)
        except FileNotFoundError:
            previous = {}
        if previous.get("requestId") == self.request_id and previous.get("phase") in TERMINAL:
            return
        transaction = None
        choice = None
        try:
            self.current = self.configured_version()
            choice = self.chosen_version()
            if choice:
                self.target = choice
                self.status("checking", "Vérification de la version choisie…")
                published, digest = release_info(self.github("releases/tags/" + choice))
                if published != choice:
                    raise UpdateError("La release publiée ne correspond pas à la version choisie.")
                if choice == self.current:
                    self.status("succeeded", "Cette version est déjà installée.")
                    return
            else:
                self.status("checking", "Recherche d'une version stable publiée…")
                self.target, digest = release_info(self.github())
                if numbers(self.target) <= numbers(self.current):
                    self.status("succeeded", "L'application est déjà à jour.")
                    return
            commit, image = self.prepare(digest, chosen=choice is not None)
            transaction = self.begin(commit, image)
            self.backup(transaction)
            self.install(transaction)
            self.status("verifying", "Vérification de la version choisie…" if choice else "Vérification de la nouvelle version…")
            self.healthy(self.target, self.private / "new-image.json")
            self.current = self.target
            self.finish(transaction, "succeeded", "Version choisie installée. La soirée est conservée." if choice
                        else "Mise à jour installée. La soirée est conservée.")
        except Exception as error:
            message = str(error) if isinstance(error, UpdateError) else "La mise à jour n'a pas pu se terminer."
            if transaction:
                try:
                    if transaction.get("outcome"):
                        raise UpdateError("Le résultat sera publié à la prochaine vérification.")
                    self.restore(transaction)
                    self.finish(transaction, "rolled-back", "Version choisie refusée : la version en service a été rétablie." if choice
                                else "Mise à jour annulée : l'ancienne version a été rétablie.")
                except Exception:
                    self.status("verifying", "Récupération en cours : une intervention technique est nécessaire.")
                    raise
            else:
                self.status("failed", message)

    def tick(self):
        """One timer run: the pending request first, then the list of versions."""
        self.execute()
        try:
            self.refresh_catalogue()
        except UpdateError as error:
            # Fixed, non-secret texts: the journal says why the list grows old.
            print("La liste des versions publiées n'a pas pu être actualisée : " + str(error), file=sys.stderr)
        except Exception:
            # Only a convenience for the bar page: keep the previous list.
            print("La liste des versions publiées n'a pas pu être actualisée.", file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.home() / "karafun-plus")
    parser.add_argument("--state", type=Path, default=Path.home() / ".local/state/karafun-plus-update")
    options = parser.parse_args()
    # Linux-only locking lives here so the orchestration can be tested on Windows.
    import fcntl
    options.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (options.state / "worker.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        Agent(options.repo, options.state).tick()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Keep details/configuration out of the system journal as well.
        print("La maintenance demande une nouvelle tentative ou une vérification technique.", file=sys.stderr)
        sys.exit(1)
