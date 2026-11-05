"""Host updater regressions. No Docker, GitHub, SSH or real evening is used."""
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import unittest
from unittest.mock import MagicMock, patch
import uuid

SPEC = importlib.util.spec_from_file_location(
    "update_agent", Path(__file__).resolve().parents[1] / "deploy" / "update-agent.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
OLD = "a" * 40
NEW = "b" * 40
HASH = "sha256:" + "c" * 64
OLD_IMAGE = "sha256:" + "d" * 64
CONTAINER = "e" * 64
ARCHIVE = "sauvegardes/karafun-plus-20260101-000000Z.tar.gz"


def release(version="v1.1.0"):
    return {"tag_name": version, "draft": False, "prerelease": False,
            "assets": [{"name": name, "size": 12} for name in
                       ["KIT-BAR-KARAFUN.zip", "KIT-BAR-KARAFUN.zip.sha256"]],
            "body": ("<!-- image-docker -->\n" + MODULE.IMAGE + ":" + version +
                     "\n" + MODULE.IMAGE + "@" + HASH + "\n<!-- /image-docker -->")}


class FakeAgent(MODULE.Agent):
    def __init__(self, directory):
        root = Path(directory)
        (root / "repo/deploy/maintenance").mkdir(parents=True)
        super().__init__(root / "repo", root / "private")
        (self.deploy / ".env").write_text("KARAFUN_PLUS_VERSION=v1.0.0\nKEY=literal-secret\n")
        self.receipt = str(uuid.uuid4())
        MODULE.atomic_json(self.ipc / "request.json", {"id": self.receipt, "createdAt": MODULE.now()})
        self.payload = release()
        self.commands = []
        self.phases = []
        self.fail = None
        self.remote_digest = HASH
        self.revision = NEW
        self.running = True
        self.candidate_env = "KARAFUN_PLUS_VERSION=\nKEY=\n"
        self.origin = "https://github.com/" + MODULE.REPOSITORY + ".git"
        self.dirty = ""
        # Answers per GitHub path (latest release otherwise), versions whose
        # start-up checks fail, and the version label of the pulled image.
        self.payloads = {}
        self.github_paths = []
        self.unhealthy = set()
        self.image_version = "v1.1.0"

    def status(self, phase, message):
        self.phases.append(phase)
        super().status(phase, message)

    def github(self, path="releases/latest"):
        self.github_paths.append(path)
        if self.fail == "github":
            raise MODULE.UpdateError("Version inaccessible.")
        return self.payloads.get(path, self.payload)

    def public_health(self):
        if self.fail == "proxy" and "KARAFUN_PLUS_VERSION=v1.1.0" in (self.deploy / ".env").read_text():
            raise MODULE.UpdateError("Proxy non prêt.")
        if self.fail in {"staff-auth-200", "staff-auth-403"} and "KARAFUN_PLUS_VERSION=v1.1.0" in (self.deploy / ".env").read_text():
            with (self.deploy / ".env").open("a") as configuration:
                configuration.write("KARAOKE_PUBLIC_URL=https://clients.exemple.fr\nKARAOKE_STAFF_URL=https://bar.exemple.fr\n")
            public = MagicMock()
            public.__enter__.return_value = public
            public.geturl.return_value = "https://clients.exemple.fr/healthz"
            public.status, public.read.return_value = 200, b"ok"

            def https(url, **kwargs):
                if url.endswith("/staff"):
                    if self.fail == "staff-auth-403":
                        raise urllib.error.HTTPError(url, 403, "Forbidden", {}, None)
                    return public
                return public

            with patch.object(MODULE.urllib.request, "urlopen", side_effect=https):
                MODULE.Agent.public_health(self)

    def command(self, arguments, timeout=120, data=None):
        self.commands.append(list(arguments))
        if arguments[:4] == ["git", "remote", "get-url", "origin"]:
            return self.origin
        if arguments[:3] == ["git", "status", "--porcelain"]:
            return self.dirty
        if arguments[:2] == ["git", "fetch"]:
            return ""
        if arguments[:2] == ["git", "rev-parse"]:
            return OLD if arguments[-1] == "HEAD" else NEW
        if arguments[:2] == ["git", "show"]:
            return self.candidate_env
        if arguments[:2] == ["git", "checkout"]:
            if self.fail == "install" and arguments[-1] == NEW:
                raise MODULE.UpdateError("Installation refusée.")
            return ""
        if arguments[:3] == ["docker", "buildx", "imagetools"]:
            return json.dumps({"digest": self.remote_digest})
        if arguments[:2] == ["docker", "pull"]:
            if self.fail == "pull":
                raise MODULE.UpdateError("Téléchargement refusé.")
            return ""
        if arguments[:3] == ["docker", "image", "inspect"]:
            return json.dumps([{"Config": {"Labels": {
                "org.opencontainers.image.revision": self.revision,
                "org.opencontainers.image.version": self.image_version}}}])
        if arguments[:2] == ["docker", "inspect"]:
            return json.dumps([{"Image": OLD_IMAGE, "State": {"Running": self.running}}])
        if arguments[0] == "bash":
            if self.fail == "backup":
                raise MODULE.UpdateError("Sauvegarde refusée.")
            (self.deploy / "sauvegardes").mkdir(exist_ok=True)
            (self.deploy / ARCHIVE).write_bytes(b"private snapshot")
            return "Sauvegarde écrite : " + ARCHIVE + " (12K)"
        if arguments[:2] == ["docker", "compose"]:
            if "ps" in arguments:
                return CONTAINER
            if "exec" in arguments and self.fail in {"health", "rollback-health"}:
                version = arguments[-1]
                if version == "v1.1.0" or self.fail == "rollback-health":
                    raise MODULE.UpdateError("Contrôle refusé.")
            if "exec" in arguments and arguments[-1] in self.unhealthy:
                raise MODULE.UpdateError("Contrôle refusé.")
            if "run" in arguments:
                if self.fail == "restore":
                    raise MODULE.UpdateError("Restauration refusée.")
                if data is None or not hasattr(data, "read"):
                    raise AssertionError("Archive must be streamed, never interpolated into a shell")
                if data.read() != b"private snapshot":
                    raise AssertionError("Wrong snapshot")
            return ""
        raise AssertionError("Unexpected command: " + repr(arguments))

    def result(self):
        return MODULE.read_json(self.ipc / "status.json")


class EveningAgent(FakeAgent):
    """Real temporary volume/archive bytes, with Docker and networking mocked."""
    def __init__(self, directory):
        super().__init__(directory)
        self.volume = Path(directory) / "volume"
        for name, content in {
                "data/soiree-a.json": json.dumps({"tables": ["T1", "T2"],
                    "order": ["S03", "S01", "S02"], "next": "S03",
                    "songs": {"S01": [11, 12], "S02": [21], "S03": [31]},
                    "duet": ["S01", "S02"], "onStage": 7}).encode(),
                "data/staff-key": b"private staff key",
                "data/photos/portrait.bin": bytes(range(256)),
                "data/soirees/2026-01-01_2000_abcd/events.jsonl": b'{"ev":"stage.started","queueId":7}\n',
                "journal/serveur-2026-01-01.log": b"existing journal\n"}.items():
            file = self.volume / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(content)
        self.flush_at_stop = None
        self.change_candidate = False
        self.old_starts = []
        self.terminal_trees = []

    def tree(self):
        return {file.relative_to(self.volume).as_posix(): file.read_bytes()
                for file in self.volume.rglob("*") if file.is_file()}

    def status(self, phase, message):
        if phase in MODULE.TERMINAL:
            self.terminal_trees.append(self.tree())
        super().status(phase, message)

    def command(self, arguments, timeout=120, data=None):
        compose = arguments[:2] == ["docker", "compose"]
        if compose and "stop" in arguments and self.flush_at_stop:
            flush, self.flush_at_stop = self.flush_at_stop, None
            flush()
        if arguments[0] == "bash" and self.fail != "backup":
            self.commands.append(list(arguments))
            (self.deploy / "sauvegardes").mkdir(exist_ok=True)
            with tarfile.open(self.deploy / ARCHIVE, "w:gz") as archive:
                for directory in ["data", "journal"]:
                    archive.add(self.volume / directory, arcname=directory)
            return "Sauvegarde écrite : " + ARCHIVE + " (12K)"
        if compose and "run" in arguments:
            self.commands.append(list(arguments))
            if not hasattr(data, "read"):
                raise AssertionError("Recovery must stream its archive")
            with tarfile.open(fileobj=io.BytesIO(data.read()), mode="r:gz") as archive:
                files = {item.name: archive.extractfile(item).read()
                         for item in archive.getmembers() if item.isfile()}
            for file in self.volume.rglob("*"):
                if file.is_file():
                    file.unlink()
            for name, content in files.items():
                file = self.volume / name
                if not file.resolve().is_relative_to(self.volume.resolve()):
                    raise AssertionError("Unexpected path in test archive")
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(content)
            return ""
        output = super().command(arguments, timeout, data)
        if compose and "up" in arguments and arguments[-1] == "app":
            if str(self.private / "new-image.json") in arguments:
                if self.change_candidate:
                    (self.volume / "data/soiree-a.json").write_bytes(b"candidate incompatible state")
                    (self.volume / "data/candidate-only.json").write_bytes(b"candidate migration")
            else:
                self.old_starts.append(self.tree())
        return output


class ReleaseValidation(unittest.TestCase):
    def test_stable_release_is_recognized(self):
        self.assertEqual(MODULE.release_info(release()), ("v1.1.0", HASH))

    def test_prerelease_draft_or_shell_version_are_refused(self):
        for changes in [{"draft": True}, {"prerelease": True}, {"tag_name": "v1.2.0-beta"},
                        {"tag_name": "v1.2.0;touch evil"}, {"tag_name": "v01.2.0"}]:
            with self.subTest(changes=changes):
                payload = release()
                payload.update(changes)
                with self.assertRaises(MODULE.UpdateError):
                    MODULE.release_info(payload)

    def test_partial_release_or_ambiguous_digest_are_refused(self):
        cases = [dict(release(), assets=[]), dict(release(), body="no digest"),
                 dict(release(), body=release()["body"] * 2),
                 dict(release(), body=release()["body"].replace(MODULE.IMAGE, "ghcr.io/elsewhere/app")),
                 dict(release(), body=42), dict(release(), assets=None), None]
        for payload in cases:
            with self.subTest(payload=payload):
                with self.assertRaises(MODULE.UpdateError):
                    MODULE.release_info(payload)

    def test_json_file_limit_and_non_regular_input(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / "request.json"
            file.write_text("x" * 5000)
            with self.assertRaises(MODULE.UpdateError):
                MODULE.read_json(file, 4096)


class UpdateLifecycle(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.agent = FakeAgent(self.temporary.name)
        self.sleeper = patch.object(MODULE.time, "sleep")
        self.sleeper.start()
        self.addCleanup(self.sleeper.stop)

    def test_success_preserves_request_and_stops_before_backup(self):
        self.agent.execute()
        result = self.agent.result()
        self.assertEqual(result["phase"], "succeeded")
        self.assertEqual(result["currentVersion"], "v1.1.0")
        self.assertEqual(result["requestId"], self.agent.receipt)
        self.assertEqual(self.agent.phases, ["checking", "downloading", "backing-up", "installing", "verifying", "succeeded"])
        self.assertTrue((self.agent.ipc / "request.json").is_file())
        self.assertFalse(self.agent.transaction_file.exists())
        commands = self.agent.commands
        backup_index = next(i for i, command in enumerate(commands) if command[0] == "bash")
        self.assertIn("stop", commands[backup_index - 1])
        self.assertIn("KEY=literal-secret", (self.agent.deploy / ".env").read_text())
        public = (self.agent.ipc / "status.json").read_text()
        self.assertNotIn("literal-secret", public)

    def test_same_release_or_older_release_never_restarts(self):
        for version in ["v1.0.0", "v0.9.9"]:
            self.agent.payload = release(version)
            self.agent.execute()
            self.assertEqual(self.agent.result()["phase"], "succeeded")
            self.assertEqual(self.agent.commands, [])

    def test_duplicate_receipt_does_not_restart_twice(self):
        self.agent.execute()
        count = len(self.agent.commands)
        self.agent.execute()
        self.assertEqual(len(self.agent.commands), count)

    def test_network_pull_digest_revision_env_origin_and_dirty_fail_without_stopping(self):
        for name, value in [("fail", "github"), ("fail", "pull"), ("remote_digest", OLD_IMAGE),
                            ("revision", OLD), ("candidate_env", "UNEXPECTED=\n"),
                            ("origin", "https://evil.invalid/app"), ("dirty", " M server.js")]:
            with self.subTest(name=name, value=value), tempfile.TemporaryDirectory() as directory:
                agent = FakeAgent(directory)
                setattr(agent, name, value)
                agent.execute()
                self.assertEqual(agent.result()["phase"], "failed")
                self.assertFalse(any("stop" in command for command in agent.commands))
                self.assertFalse(agent.transaction_file.exists())

    def test_backup_failure_restarts_old_version_without_restoring_data(self):
        self.agent.fail = "backup"
        self.agent.execute()
        self.assertEqual(self.agent.result()["phase"], "rolled-back")
        self.assertFalse(any("run" in command for command in self.agent.commands))
        self.assertEqual(self.agent.result()["currentVersion"], "v1.0.0")

    def test_install_and_health_failure_restore_data_before_old_start(self):
        for fault in ["install", "health", "proxy", "staff-auth-200", "staff-auth-403"]:
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                agent = FakeAgent(directory)
                agent.fail = fault
                agent.execute()
                self.assertEqual(agent.result()["phase"], "rolled-back")
                restore_index = next(i for i, command in enumerate(agent.commands) if "run" in command)
                self.assertIn("up", agent.commands[restore_index + 1])
                self.assertEqual((agent.deploy / ".env").read_text(), "KARAFUN_PLUS_VERSION=v1.0.0\nKEY=literal-secret\n")

    def test_reboot_after_backup_recovers_before_new_request(self):
        self.agent.private.mkdir()
        self.agent.current, self.agent.target = "v1.0.0", "v1.1.0"
        self.agent.request_id = self.agent.receipt
        transaction = self.agent.begin(NEW, MODULE.IMAGE + "@" + HASH)
        self.agent.backup(transaction)
        transaction["changed"] = True
        MODULE.atomic_json(self.agent.transaction_file, transaction)
        self.agent.commands.clear()
        self.agent.execute()
        self.assertEqual(self.agent.result()["phase"], "rolled-back")
        self.assertTrue(any("run" in command for command in self.agent.commands))
        self.assertFalse(any(command[:2] == ["docker", "pull"] for command in self.agent.commands))

    def test_recovery_images_are_durable_before_transaction_is_committed(self):
        self.agent.private.mkdir()
        self.agent.current, self.agent.target = "v1.0.0", "v1.1.0"
        self.agent.request_id = self.agent.receipt
        durable_writes = []
        original_write = MODULE.atomic_bytes

        def record_durable_write(path, value, mode=0o600):
            original_write(path, value, mode)
            durable_writes.append(path.name)

        with patch.object(MODULE, "atomic_bytes", side_effect=record_durable_write):
            self.agent.begin(NEW, MODULE.IMAGE + "@" + HASH)
        self.assertEqual(durable_writes, ["env.before", "old-image.json", "new-image.json", "transaction.json"])
        self.assertEqual(MODULE.read_json(self.agent.private / "old-image.json"),
                         {"services": {"app": {"image": OLD_IMAGE}}})
        self.assertEqual(MODULE.read_json(self.agent.private / "new-image.json"),
                         {"services": {"app": {"image": MODULE.IMAGE + "@" + HASH}}})

    def test_reboot_after_committed_success_never_restores_new_writes(self):
        self.agent.private.mkdir()
        self.agent.current, self.agent.target = "v1.0.0", "v1.1.0"
        self.agent.request_id = self.agent.receipt
        transaction = self.agent.begin(NEW, MODULE.IMAGE + "@" + HASH)
        transaction["outcome"] = {"phase": "succeeded", "message": "Installée.", "currentVersion": "v1.1.0"}
        MODULE.atomic_json(self.agent.transaction_file, transaction)
        self.agent.commands.clear()
        self.agent.execute()
        self.assertEqual(self.agent.result()["phase"], "succeeded")
        self.assertEqual(self.agent.commands, [])
        self.assertFalse(self.agent.transaction_file.exists())

    def test_failed_rollback_keeps_maintenance_and_transaction_for_retry(self):
        self.agent.fail = "rollback-health"
        with self.assertRaises(MODULE.UpdateError):
            self.agent.execute()
        self.assertEqual(self.agent.result()["phase"], "verifying")
        self.assertTrue(self.agent.transaction_file.exists())
        self.agent.fail = None
        self.agent.execute()
        self.assertEqual(self.agent.result()["phase"], "rolled-back")

    def test_stopped_service_is_not_started_by_an_update_request(self):
        self.agent.running = False
        self.agent.execute()
        self.assertEqual(self.agent.result()["phase"], "failed")
        self.assertFalse(any("up" in command or "stop" in command for command in self.agent.commands))

    def test_no_request_is_no_operation(self):
        (self.agent.ipc / "request.json").unlink()
        self.agent.execute()
        self.assertEqual(self.agent.commands, [])
        self.assertEqual(self.agent.phases, [])

    def test_untrusted_request_cannot_supply_command_url_or_version(self):
        MODULE.atomic_json(self.agent.ipc / "request.json", {
            "id": self.agent.receipt, "createdAt": MODULE.now(), "version": "v99.0.0", "command": "whoami"})
        with self.assertRaises(MODULE.UpdateError):
            self.agent.execute()
        self.assertEqual(self.agent.commands, [])


class EveningPreservation(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.agent = EveningAgent(self.temporary.name)
        sleeper = patch.object(MODULE.time, "sleep")
        sleeper.start()
        self.addCleanup(sleeper.stop)

    def test_success_preserves_all_evening_files_including_final_stop_flush(self):
        initial = self.agent.tree()
        final = dict(initial)
        final["data/soiree-a.json"] = initial["data/soiree-a.json"].replace(b'"onStage": 7', b'"onStage": 8')
        final["journal/serveur-2026-01-01.log"] += b"graceful stop\n"

        def flush():
            for name in ["data/soiree-a.json", "journal/serveur-2026-01-01.log"]:
                (self.agent.volume / name).write_bytes(final[name])

        self.agent.flush_at_stop = flush
        self.agent.execute()
        self.assertEqual(self.agent.result()["phase"], "succeeded")
        self.assertEqual(self.agent.tree(), final)
        with tarfile.open(self.agent.deploy / ARCHIVE, "r:gz") as archive:
            saved = {item.name: archive.extractfile(item).read()
                     for item in archive.getmembers() if item.isfile()}
        self.assertEqual(saved, final, "Snapshot must include the last graceful-stop write")
        self.assertEqual(self.agent.terminal_trees, [final])
        self.assertFalse(any("run" in command for command in self.agent.commands),
                         "A successful update must not restore an older snapshot")

    def test_failed_candidate_restores_every_byte_before_old_app_and_unlock(self):
        before = self.agent.tree()
        self.agent.change_candidate = True
        self.agent.fail = "health"
        self.agent.execute()
        self.assertEqual(self.agent.result()["phase"], "rolled-back")
        self.assertEqual(self.agent.tree(), before)
        self.assertEqual(self.agent.old_starts, [before],
                         "Old app must see all original data before it starts")
        self.assertEqual(self.agent.terminal_trees, [before],
                         "Writes unlock only once the evening is fully restored")

    def test_interrupted_install_restores_the_same_evening_before_recovery_unlock(self):
        before = self.agent.tree()
        self.agent.private.mkdir()
        self.agent.current, self.agent.target = "v1.0.0", "v1.1.0"
        self.agent.request_id = self.agent.receipt
        transaction = self.agent.begin(NEW, MODULE.IMAGE + "@" + HASH)
        self.agent.backup(transaction)
        self.agent.change_candidate = True
        self.agent.install(transaction)
        self.assertNotEqual(self.agent.tree(), before, "Candidate changed its volume before interruption")
        self.agent.commands.clear()
        self.agent.execute()
        self.assertEqual(self.agent.result()["phase"], "rolled-back")
        self.assertEqual(self.agent.tree(), before)
        self.assertEqual(self.agent.old_starts, [before])
        self.assertEqual(self.agent.terminal_trees, [before])
        self.assertFalse(any(command[:2] == ["docker", "pull"] for command in self.agent.commands))

    def test_committed_outcome_recovery_never_overwrites_new_evening_activity(self):
        self.agent.private.mkdir()
        self.agent.current, self.agent.target = "v1.0.0", "v1.1.0"
        self.agent.request_id = self.agent.receipt
        transaction = self.agent.begin(NEW, MODULE.IMAGE + "@" + HASH)
        self.agent.backup(transaction)
        self.agent.install(transaction)
        transaction["outcome"] = {"phase": "succeeded", "message": "Installée.", "currentVersion": "v1.1.0"}
        MODULE.atomic_json(self.agent.transaction_file, transaction)
        (self.agent.volume / "data/new-activity.json").write_bytes(b"new songs accepted after success")
        after_success = self.agent.tree()
        self.agent.commands.clear()
        self.agent.execute()
        self.assertEqual(self.agent.result()["phase"], "succeeded")
        self.assertEqual(self.agent.tree(), after_success)
        self.assertEqual(self.agent.commands, [])
        self.assertEqual(self.agent.terminal_trees, [after_success])


def choosing(agent, version="v3.1.3", installed="v3.2.0", request_id=None):
    """The bar chose `version` while `installed` runs (target.json, then request)."""
    (agent.deploy / ".env").write_text(f"KARAFUN_PLUS_VERSION={installed}\nKEY=literal-secret\n")
    MODULE.atomic_json(agent.ipc / "target.json", {"requestId": request_id or agent.receipt, "version": version})
    agent.payloads["releases/tags/" + version] = release(version)
    agent.image_version = version
    return agent


class ChosenVersion(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.agent = choosing(FakeAgent(self.temporary.name))
        sleeper = patch.object(MODULE.time, "sleep")
        sleeper.start()
        self.addCleanup(sleeper.stop)

    def test_older_release_is_installed_with_backup_and_checks(self):
        self.agent.execute()
        result = self.agent.result()
        self.assertEqual(result["phase"], "succeeded")
        self.assertEqual((result["currentVersion"], result["targetVersion"]), ("v3.1.3", "v3.1.3"))
        self.assertEqual(self.agent.github_paths, ["releases/tags/v3.1.3"], "jamais la dernière version à la place du choix")
        self.assertEqual(self.agent.phases, ["checking", "downloading", "backing-up", "installing", "verifying", "succeeded"])
        self.assertIn("KARAFUN_PLUS_VERSION=v3.1.3\n", (self.agent.deploy / ".env").read_text())
        self.assertIn(["git", "checkout", "--detach", NEW], self.agent.commands)
        self.assertTrue(any(command[0] == "bash" for command in self.agent.commands), "sauvegarde avant installation")
        health = [command for command in self.agent.commands if "exec" in command]
        self.assertEqual(health[-1][-1], "v3.1.3", "la version choisie passe les contrôles de démarrage")
        self.assertFalse(self.agent.transaction_file.exists())

    def test_the_installed_release_is_never_restarted(self):
        choosing(self.agent, version="v3.2.0")
        self.agent.execute()
        self.assertEqual(self.agent.result()["phase"], "succeeded")
        self.assertEqual(self.agent.commands, [])

    def test_a_chosen_release_failing_its_checks_brings_back_the_running_one(self):
        self.agent.unhealthy = {"v3.1.3"}
        self.agent.execute()
        result = self.agent.result()
        self.assertEqual(result["phase"], "rolled-back")
        self.assertEqual(result["currentVersion"], "v3.2.0")
        self.assertEqual((self.agent.deploy / ".env").read_text(), "KARAFUN_PLUS_VERSION=v3.2.0\nKEY=literal-secret\n")
        restore = next(i for i, command in enumerate(self.agent.commands) if "run" in command)
        self.assertIn("up", self.agent.commands[restore + 1], "données remises avant le redémarrage de la version en service")
        self.assertEqual(self.agent.commands[-1][-1], "v3.2.0", "la version en service repasse les contrôles")

    def test_unreadable_or_unsupported_choice_fails_without_any_command(self):
        cases = [lambda r: {"requestId": r, "version": "v3.1.1"},
                 lambda r: {"requestId": r, "version": "v3.1.3-rc.1"},
                 lambda r: {"requestId": r, "version": "latest"},
                 lambda r: {"requestId": r, "version": "v3.1.3;touch evil"},
                 lambda r: {"requestId": r, "version": ["v3.1.3"]},
                 lambda r: {"requestId": r, "version": "v3.1.3", "image": "ghcr.io/elsewhere/app"},
                 lambda r: {"requestId": "not-a-uuid", "version": "v3.1.3"},
                 lambda r: {"requestId": r.upper(), "version": "v3.1.3"},
                 lambda r: [r, "v3.1.3"], lambda r: "{", lambda r: "x" * 5000]
        for number, case in enumerate(cases):
            with self.subTest(case=number), tempfile.TemporaryDirectory() as directory:
                agent = choosing(FakeAgent(directory))
                content = case(agent.receipt)
                (agent.ipc / "target.json").write_text(content if isinstance(content, str) else json.dumps(content))
                agent.execute()
                self.assertEqual(agent.result()["phase"], "failed", "le gérant est libéré avec un échec")
                self.assertEqual(agent.commands, [])
                self.assertEqual(agent.github_paths, [])
                self.assertFalse(agent.transaction_file.exists())

    def test_choice_left_by_an_earlier_request_is_ignored(self):
        choosing(self.agent, request_id=str(uuid.uuid4()))
        (self.agent.deploy / ".env").write_text("KARAFUN_PLUS_VERSION=v1.0.0\nKEY=literal-secret\n")
        self.agent.image_version = "v1.1.0"
        self.agent.execute()
        self.assertEqual(self.agent.github_paths, ["releases/latest"])
        self.assertEqual(self.agent.result()["currentVersion"], "v1.1.0")

    def test_withdrawn_or_mismatched_release_is_refused_before_stopping(self):
        for payload in [dict(release("v3.1.3"), prerelease=True), dict(release("v3.1.3"), draft=True),
                        release("v3.2.0"), dict(release("v3.1.3"), body="image retirée")]:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as directory:
                agent = choosing(FakeAgent(directory))
                agent.payloads["releases/tags/v3.1.3"] = payload
                agent.execute()
                self.assertEqual(agent.result()["phase"], "failed")
                self.assertFalse(any("stop" in command for command in agent.commands))

    def test_older_release_may_need_fewer_settings_but_never_more(self):
        self.agent.candidate_env = "KARAFUN_PLUS_VERSION=\n"
        self.agent.execute()
        self.assertEqual(self.agent.result()["phase"], "succeeded")
        self.assertIn("KEY=literal-secret", (self.agent.deploy / ".env").read_text(), "réglage gardé pour la suite")
        for name, candidate in [("plus de réglages", "KARAFUN_PLUS_VERSION=\nKEY=\nNEW=\n"),
                                ("mise à jour avec moins de réglages", "KARAFUN_PLUS_VERSION=\n")]:
            with self.subTest(name), tempfile.TemporaryDirectory() as directory:
                agent = choosing(FakeAgent(directory))
                if name.startswith("mise à jour"):
                    choosing(agent, version="v3.3.0")
                agent.candidate_env = candidate
                agent.execute()
                self.assertEqual(agent.result()["phase"], "failed")
                self.assertFalse(any("stop" in command for command in agent.commands))

    def test_latest_update_still_requires_the_same_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            agent = FakeAgent(directory)
            agent.candidate_env = "KARAFUN_PLUS_VERSION=\n"
            agent.execute()
            self.assertEqual(agent.result()["phase"], "failed")


class VersionCatalogue(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.agent = FakeAgent(self.temporary.name)
        self.agent.private.mkdir()
        self.published = []
        for version in ["v3.3.0", "v3.2.1", "v3.2.0", "v3.1.4", "v3.1.3", "v3.1.3", "v3.1.2", "v3.1.1", "v3.0.0"]:
            item = dict(release(version), published_at="2026-10-26T15:04:05Z")
            self.published.append(item)
        self.published[0]["draft"] = True
        self.published[1]["prerelease"] = True
        self.published[3]["body"] = "publication interrompue"
        self.published[4]["published_at"] = "hier"
        self.published += [None, "v9.9.9", {"tag_name": "v9.9.9"}]
        self.agent.payloads["releases?per_page=30"] = self.published

    def test_lists_complete_stable_releases_from_the_minimum_newest_first(self):
        self.assertEqual(self.agent.catalogue(), [
            {"version": "v3.2.0", "publishedAt": "2026-10-26T15:04:05Z"},
            {"version": "v3.1.3", "publishedAt": None},
            {"version": "v3.1.2", "publishedAt": "2026-10-26T15:04:05Z"}])
        self.agent.payloads["releases?per_page=30"] = [release(f"v3.{minor}.0") for minor in range(2, 20)]
        self.assertEqual([item["version"] for item in self.agent.catalogue()],
                         [f"v3.{minor}.0" for minor in range(19, 9, -1)])
        self.agent.payloads["releases?per_page=30"] = {"message": "rate limited"}
        with self.assertRaises(MODULE.UpdateError):
            self.agent.catalogue()

    def test_refresh_is_hourly_and_retried_ten_minutes_after_a_failure(self):
        file = self.agent.ipc / "versions.json"
        self.assertTrue(self.agent.refresh_catalogue())
        written = MODULE.read_json(file)
        self.assertEqual(set(written), {"checkedAt", "versions"})
        self.assertEqual([item["version"] for item in written["versions"]], ["v3.2.0", "v3.1.3", "v3.1.2"])
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o660, "lisible par le conteneur, jamais par les autres")
        self.assertFalse(self.agent.refresh_catalogue(), "une lecture par heure au plus")
        self.assertEqual(self.agent.github_paths, ["releases?per_page=30"])
        two_hours_ago = time.time() - 7200
        MODULE.atomic_json(file, dict(written, checkedAt=dt.datetime.fromtimestamp(two_hours_ago, dt.timezone.utc).isoformat()), 0o660)
        os.utime(self.agent.private / "catalogue-attempt", (two_hours_ago, two_hours_ago))
        self.agent.fail = "github"
        before = file.read_bytes()
        with self.assertRaises(MODULE.UpdateError):
            self.agent.refresh_catalogue()
        self.assertEqual(file.read_bytes(), before, "la liste précédente reste en place")
        self.assertFalse(self.agent.refresh_catalogue(), "pas de nouvel essai avant dix minutes")
        self.assertEqual(len(self.agent.github_paths), 2)

    def test_unreadable_list_left_in_the_shared_folder_is_replaced(self):
        file = self.agent.ipc / "versions.json"
        for content in ["{", "[]", json.dumps({"checkedAt": 42, "versions": []}), "x" * 20000]:
            with self.subTest(content=content[:20]):
                file.write_text(content)
                (self.agent.private / "catalogue-attempt").unlink(missing_ok=True)
                self.assertTrue(self.agent.refresh_catalogue())
                self.assertEqual(len(MODULE.read_json(file)["versions"]), 3)

    def test_tick_handles_the_request_first_and_never_fails_for_the_list(self):
        order = []
        with patch.object(self.agent, "execute", side_effect=lambda: order.append("execute")), \
                patch.object(self.agent, "refresh_catalogue", side_effect=OSError("disque plein")), \
                patch("sys.stderr", new_callable=io.StringIO) as stderr:
            self.agent.tick()
        self.assertEqual(order, ["execute"])
        self.assertIn("liste des versions", stderr.getvalue())
        self.assertNotIn("disque plein", stderr.getvalue())

    def test_tick_leaves_the_list_alone_while_a_recovery_is_pending(self):
        refreshed = []
        with patch.object(self.agent, "execute", side_effect=MODULE.UpdateError("Récupération.")), \
                patch.object(self.agent, "refresh_catalogue", side_effect=lambda: refreshed.append(True)):
            with self.assertRaises(MODULE.UpdateError):
                self.agent.tick()
        self.assertEqual(refreshed, [])


class SharedFolderWrites(unittest.TestCase):
    @unittest.skipUnless(hasattr(os, "fchmod"), "fchmod absent de ce Python Windows")
    def test_mode_is_set_on_the_open_file_never_by_path(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "status.json"
            with patch.object(MODULE.os, "chmod", side_effect=AssertionError("chmod par chemin")):
                MODULE.atomic_json(target, {"phase": "idle"}, 0o660)
            self.assertEqual(MODULE.read_json(target), {"phase": "idle"})
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o660)


class SystemBoundaries(unittest.TestCase):
    def test_github_requests_only_fixed_paths_of_the_official_repository(self):
        with tempfile.TemporaryDirectory() as temporary:
            agent = FakeAgent(temporary)
            for path in ["releases/tags/v3.1.3;rm", "releases/tags/../../other/repo", "releases?per_page=100",
                         "releases/tags/v3.1", "../../orgs/evil", ""]:
                with self.subTest(path=path), patch.object(MODULE.urllib.request, "urlopen") as http:
                    with self.assertRaises(MODULE.UpdateError):
                        MODULE.Agent.github(agent, path)
                    http.assert_not_called()
            response = MagicMock()
            response.__enter__.return_value = response
            response.geturl.return_value = "https://api.github.com/repos/jpfroud/karafun-plus/releases/tags/v3.1.3"
            response.read.return_value = json.dumps(release("v3.1.3")).encode()
            with patch.object(MODULE.urllib.request, "urlopen", return_value=response) as http:
                MODULE.Agent.github(agent, "releases/tags/v3.1.3")
                self.assertEqual(http.call_args.args[0].full_url,
                                 "https://api.github.com/repos/jpfroud/karafun-plus/releases/tags/v3.1.3")
            missing = urllib.error.HTTPError("https://api.github.com", 404, "Not Found", {}, None)
            with patch.object(MODULE.urllib.request, "urlopen", side_effect=missing):
                with self.assertRaises(MODULE.UpdateError) as error:
                    MODULE.Agent.github(agent, "releases/tags/v3.1.3")
                self.assertIn("pas publiée", str(error.exception))
            limited = urllib.error.HTTPError("https://api.github.com", 403, "rate limited", {}, None)
            with patch.object(MODULE.urllib.request, "urlopen", side_effect=limited):
                with self.assertRaises(MODULE.UpdateError) as error:
                    MODULE.Agent.github(agent)
                self.assertIn("momentanément inaccessible", str(error.exception))

    def test_public_health_verifies_tls_origin_status_and_body(self):
        with tempfile.TemporaryDirectory() as temporary:
            agent = FakeAgent(temporary)
            (agent.deploy / ".env").write_text("KARAOKE_PUBLIC_URL=https://clients.exemple.fr\nKARAOKE_STAFF_URL=https://bar.exemple.fr\n")
            response = MagicMock()
            response.__enter__.return_value = response
            response.geturl.return_value = "https://clients.exemple.fr/healthz"
            response.status = 200
            response.read.return_value = b"ok"
            def https(url, **kwargs):
                if url.endswith("/staff"):
                    raise urllib.error.HTTPError(url, 401, "Unauthorized", {"WWW-Authenticate": 'Basic realm="bar"'}, None)
                return response

            with patch.object(MODULE.urllib.request, "urlopen", side_effect=https) as http:
                MODULE.Agent.public_health(agent)
                self.assertEqual(http.call_args.kwargs["timeout"], 5)
                self.assertNotIn("context", http.call_args.kwargs)  # default verified TLS
            for change, value in [("status", 503), ("redirect", "https://other.exemple.fr/healthz"), ("body", b"error")]:
                response.status = 200
                response.geturl.return_value = "https://clients.exemple.fr/healthz"
                response.read.return_value = b"ok"
                if change == "status":
                    response.status = value
                elif change == "redirect":
                    response.geturl.return_value = value
                else:
                    response.read.return_value = value
                with patch.object(MODULE.urllib.request, "urlopen", side_effect=https):
                    with self.assertRaises(MODULE.UpdateError):
                        MODULE.Agent.public_health(agent)

    def test_github_http_is_bounded_and_rejects_network_invalid_json_or_redirect(self):
        with tempfile.TemporaryDirectory() as temporary:
            agent = FakeAgent(temporary)
            response = MagicMock()
            response.__enter__.return_value = response
            response.geturl.return_value = "https://api.github.com/repos/jpfroud/karafun-plus/releases/latest"
            response.read.return_value = json.dumps(release()).encode()
            with patch.object(MODULE.urllib.request, "urlopen", return_value=response) as http:
                self.assertEqual(MODULE.Agent.github(agent)["tag_name"], "v1.1.0")
                self.assertEqual(http.call_args.kwargs["timeout"], 20)
                response.read.assert_called_with(MODULE.MAX_JSON + 1)
            for body in [b"bad json", b"x" * (MODULE.MAX_JSON + 1)]:
                response.read.return_value = body
                with patch.object(MODULE.urllib.request, "urlopen", return_value=response):
                    with self.assertRaises(MODULE.UpdateError):
                        MODULE.Agent.github(agent)
            response.geturl.return_value = "http://evil.invalid/releases/latest"
            with patch.object(MODULE.urllib.request, "urlopen", return_value=response):
                with self.assertRaises(MODULE.UpdateError):
                    MODULE.Agent.github(agent)
            with patch.object(MODULE.urllib.request, "urlopen", side_effect=OSError("secret")):
                with self.assertRaises(MODULE.UpdateError) as error:
                    MODULE.Agent.github(agent)
                self.assertNotIn("secret", str(error.exception))

    def test_command_timeout_and_nonzero_exit_do_not_expose_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            agent = FakeAgent(temporary)
            with patch.object(MODULE.subprocess, "run", side_effect=subprocess.TimeoutExpired("docker", 1)):
                with self.assertRaises(MODULE.UpdateError):
                    MODULE.Agent.command(agent, ["docker", "ps"], timeout=1)
            result = subprocess.CompletedProcess(["docker"], 1, b"private-key", b"password")
            with patch.object(MODULE.subprocess, "run", return_value=result):
                with self.assertRaises(MODULE.UpdateError) as error:
                    MODULE.Agent.command(agent, ["docker", "ps"])
                self.assertNotIn("password", str(error.exception))
                self.assertNotIn("private-key", str(error.exception))

    def test_health_checks_maintenance_storage_solver_and_version_not_karafun(self):
        with tempfile.TemporaryDirectory() as temporary:
            agent = FakeAgent(temporary)
            agent.healthy("v1.0.0", None)
            command = agent.commands[-1]
            script = command[command.index("-e") + 1]
            self.assertIn("s.update?.busy!==true", script)
            self.assertIn("r.persistence!=='ok'", script)
            self.assertIn("r.solver!=='available'", script)
            self.assertNotIn("r.ok", script)
            self.assertNotIn("r.karafun", script)


if __name__ == "__main__":
    unittest.main(verbosity=2)
