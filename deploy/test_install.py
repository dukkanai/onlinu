"""Installer safety checks; no Docker daemon, image loads, or deployments used."""
import argparse
import base64
from contextlib import contextmanager, redirect_stderr
import importlib.util
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location("astracalls_install", Path(__file__).with_name("install.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTestCase(unittest.TestCase):
    def setUp(self):
        # Every external command must be explicitly mocked by its test.
        patcher = mock.patch.object(installer, "run", side_effect=AssertionError("Unexpected external command"))
        self.run = patcher.start()
        self.addCleanup(patcher.stop)


class ReservedPortsTests(InstallerTestCase):
    def test_stopped_container_host_bindings_remain_reserved(self):
        containers = [{
            "State": {"Running": False},
            "HostConfig": {"PortBindings": {
                "8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18080"}],
                "50000/udp": [{"HostIp": "0.0.0.0", "HostPort": "55000"}],
            }},
            "NetworkSettings": {"Ports": None},
        }]
        self.assertEqual(installer.reserved_ports(containers), {18080, 55000})

    def test_dynamic_ports_are_read_from_network_settings(self):
        containers = [{
            "HostConfig": {"PortBindings": {"8080/tcp": [{"HostPort": "0"}]}},
            "NetworkSettings": {"Ports": {
                "8080/tcp": [{"HostIp": "0.0.0.0", "HostPort": "32791"},
                             {"HostIp": "::", "HostPort": "32791"}],
                "50000/udp": [{"HostPort": "32792"}],
            }},
        }]
        ports = installer.reserved_ports(containers)
        self.assertTrue({32791, 32792}.issubset(ports))

    def test_ranges_null_bindings_and_empty_host_ports(self):
        containers = [{
            "HostConfig": {"PortBindings": {
                "8000/tcp": [{"HostPort": "18000-18002"}],
                "8001/tcp": None,
                "8002/udp": [{"HostPort": ""}, {}],
            }},
            "NetworkSettings": {"Ports": None},
        }, {}]
        self.assertEqual(installer.reserved_ports(containers), {18000, 18001, 18002})

    def test_only_the_requested_project_is_excluded(self):
        containers = [
            {"Config": {"Labels": {"com.docker.compose.project": "astracalls-owned"}},
             "HostConfig": {"PortBindings": {"80/tcp": [{"HostPort": "18080"}]}}},
            {"Config": {"Labels": {"com.docker.compose.project": "other-service"}},
             "HostConfig": {"PortBindings": {"80/tcp": [{"HostPort": "18081"}]}}},
        ]
        self.assertEqual(installer.reserved_ports(containers, "astracalls-owned"), {18081})

    def test_unlabelled_container_ports_remain_reserved_when_excluding_a_project(self):
        containers = [{
            "Config": {"Labels": None},
            "HostConfig": {"PortBindings": {"80/tcp": [{"HostPort": "18082"}]}},
        }]
        self.assertEqual(installer.reserved_ports(containers, "astracalls-owned"), {18082})


@contextmanager
def occupied_port(kind):
    """Hold a real loopback socket for protocol-specific collision checks."""
    with socket.socket(socket.AF_INET, kind) as sock:
        sock.bind(("127.0.0.1", 0))
        if kind == socket.SOCK_STREAM:
            sock.listen(1)
        yield sock.getsockname()[1]


class ChoosePortTests(InstallerTestCase):
    def test_tcp_listener_rejects_both_http_and_media(self):
        with occupied_port(socket.SOCK_STREAM) as port:
            for media in (False, True):
                with self.subTest(media=media), self.assertRaises(installer.InstallError):
                    installer.choose_port(port, 8080, 9000, "127.0.0.1", set(), media=media)

    def test_udp_listener_rejects_media(self):
        with occupied_port(socket.SOCK_DGRAM) as port:
            with self.assertRaises(installer.InstallError):
                installer.choose_port(port, 50000, 60000, "127.0.0.1", set(), media=True)

    def test_http_does_not_require_the_udp_port(self):
        with occupied_port(socket.SOCK_DGRAM) as port:
            # An unrelated process can hold TCP at the randomly selected UDP
            # port; skip only that host-dependent case.
            if not installer.socket_available("127.0.0.1", port):
                self.skipTest("The randomly selected UDP port also has a TCP owner")
            reserved = set()
            self.assertEqual(installer.choose_port(port, 8080, 9000, "127.0.0.1", reserved), port)
            self.assertEqual(reserved, {port})

    def test_explicit_reserved_port_fails_without_socket_probe(self):
        with mock.patch.object(installer, "socket_available") as available:
            with self.assertRaises(installer.InstallError):
                installer.choose_port(18080, 8080, 9000, "127.0.0.1", {18080})
            available.assert_not_called()

    def test_http_and_media_cannot_select_the_same_number(self):
        reserved = set()
        with mock.patch.object(installer, "socket_available", return_value=True) as available:
            self.assertEqual(installer.choose_port(18080, 8080, 9000, "127.0.0.1", reserved), 18080)
            with self.assertRaises(installer.InstallError):
                installer.choose_port(18080, 50000, 60000, "127.0.0.1", reserved, media=True)
            available.assert_called_once_with("127.0.0.1", 18080, False)

    def test_automatic_selection_skips_reserved_and_busy_ports(self):
        reserved = {18080}
        with mock.patch.object(installer, "socket_available", side_effect=[False, True]) as available:
            chosen = installer.choose_port(None, 18080, 18084, "127.0.0.1", reserved, media=True)
        self.assertEqual(chosen, 18082)
        self.assertEqual(reserved, {18080, 18082})
        self.assertEqual(available.call_args_list, [
            mock.call("127.0.0.1", 18081, True), mock.call("127.0.0.1", 18082, True),
        ])

    def test_exhausted_range_fails_without_changing_reservations(self):
        reserved = {18080}
        with mock.patch.object(installer, "socket_available", return_value=False):
            with self.assertRaises(installer.InstallError):
                installer.choose_port(None, 18080, 18083, "127.0.0.1", reserved)
        self.assertEqual(reserved, {18080})


class ArgumentTests(InstallerTestCase):
    def parse(self, *args):
        with mock.patch.object(sys, "argv", ["install.py", *args]), redirect_stderr(io.StringIO()):
            return installer.parse_args()

    def test_defaults_and_explicit_options(self):
        defaults = self.parse()
        self.assertEqual(defaults.name, "portable")
        self.assertIsNone(defaults.http_port)
        self.assertIsNone(defaults.media_port)
        parsed = self.parse("--name", "team-2", "--dir", "/tmp/test-instance", "--http-port", "18080",
                            "--media-port", "55000", "--public-ip", "192.0.2.50", "--http-bind", "127.0.0.1",
                            "--media-bind", "0.0.0.0", "--public-url", "https://calls.example.com")
        self.assertEqual((parsed.name, parsed.http_port, parsed.media_port), ("team-2", 18080, 55000))
        self.assertEqual(parsed.public_ip, "192.0.2.50")
        self.assertEqual(parsed.public_url, "https://calls.example.com")

    def test_names_have_safe_and_bounded_syntax(self):
        for name in ("a", "0", "team-2", "a" * 40):
            with self.subTest(valid=name):
                self.assertEqual(self.parse("--name", name).name, name)
        for name in ("", "Team", "team_one", "../other", "-team", "a" * 41, "team;id"):
            with self.subTest(invalid=name), self.assertRaises(SystemExit) as caught:
                self.parse("--name=" + name)
            self.assertEqual(caught.exception.code, 2)

    def test_ipv4_values_and_invalid_addresses(self):
        for address in ("127.0.0.1", "0.0.0.0", "192.0.2.20", "255.255.255.255"):
            with self.subTest(valid=address):
                self.assertEqual(installer.validate_ip(address), address)
        for address in ("::1", "localhost", "256.0.0.1", "127.0.0.01", "1.2.3", ""):
            with self.subTest(invalid=address), self.assertRaises(argparse.ArgumentTypeError):
                installer.validate_ip(address)

    def test_ports_must_be_unprivileged_valid_integers(self):
        self.assertEqual(installer.validate_port("1024"), 1024)
        self.assertEqual(installer.validate_port("65535"), 65535)
        for port in ("1023", "65536", "-1", "abc", "80/tcp", ""):
            with self.subTest(port=port), self.assertRaises(argparse.ArgumentTypeError):
                installer.validate_port(port)

    def test_public_url_rejects_credentials_and_env_syntax(self):
        for url in ("http://calls.example.com", "https://user:pass@calls.example.com",
                    "https://calls.example.com/#fragment", "https://calls.example.com/$VALUE",
                    "https://calls.example.com/a b", "https://"):
            with self.subTest(url=url), self.assertRaises(SystemExit) as caught:
                self.parse("--public-url", url)
            self.assertEqual(caught.exception.code, 2)


class SettingsTests(InstallerTestCase):
    def read(self, content):
        with tempfile.TemporaryDirectory(prefix="astracalls-settings-test-") as directory:
            path = Path(directory) / ".env"
            path.write_text(content)
            return installer.read_settings(path)

    def test_simple_settings_allow_comments_empty_values_and_equals_in_values(self):
        self.assertEqual(self.read("# Private settings\n\nOPENAI_API_KEY=\nWACALLS_HTTP_PORT=18080\nVALUE=a=b\n"),
                         {"OPENAI_API_KEY": "", "WACALLS_HTTP_PORT": "18080", "VALUE": "a=b"})

    def test_duplicate_keys_are_rejected_even_if_values_match(self):
        for second_value in ("one", "two"):
            with self.subTest(second_value=second_value), self.assertRaises(installer.InstallError):
                self.read("WACALLS_API_KEY=one\nWACALLS_API_KEY=" + second_value + "\n")

    def test_shell_statements_and_malformed_keys_are_rejected(self):
        for content in ("export KEY=value\n", "KEY\n", " KEY=value\n", "lower=value\n", "1KEY=value\n"):
            with self.subTest(content=content), self.assertRaises(installer.InstallError):
                self.read(content)


class ReleaseSettingsTests(InstallerTestCase):
    release = {"version": "0.2.0", "images": {
        "app": {"tag": "astracalls-private/app:release-new"},
        "postgres": {"tag": "astracalls-private/postgres:release-new"},
    }}

    def new_settings(self, release=None):
        return installer.new_settings(release or self.release, public_ip="127.0.0.1", http_bind="127.0.0.1",
                                      media_bind="127.0.0.1", http_port=18080, media_port=55000, public_url=None)

    def test_meta_key_is_independent_base64_encoded_32_byte_random_value(self):
        first, second = self.new_settings(), self.new_settings()
        for settings in (first, second):
            key = settings["WACALLS_META_ENCRYPTION_KEY"]
            self.assertEqual(len(base64.b64decode(key, validate=True)), 32)
            self.assertNotIn("\n", key)
            self.assertEqual(settings["OPENAI_API_KEY"], "")
            self.assertEqual(settings["ASTRACALLS_VERSION"], "0.2.0")
            self.assertNotEqual(key, settings["WACALLS_API_KEY"])
        for name in ("WACALLS_META_ENCRYPTION_KEY", "WACALLS_API_KEY", "POSTGRES_PASSWORD"):
            self.assertNotEqual(first[name], second[name])

    def test_old_manifest_keeps_its_managed_files_and_settings_format(self):
        release = {**self.release, "version": "0.1.0"}
        self.assertEqual(installer.managed_files(release), installer.MANAGED)
        self.assertNotIn("WACALLS_META_ENCRYPTION_KEY", self.new_settings(release))
        self.assertIn("META.ar.md", installer.managed_files(self.release))

    def test_only_explicitly_supported_versions_are_allowed(self):
        for version in (None, "", "0.4.0", "0.3.0-other", "../0.3.0"):
            with self.subTest(version=version), self.assertRaises(installer.InstallError):
                installer.validate_release_version({"version": version})

    def test_restaurant_release_keeps_independent_meta_keys_and_versioned_docs(self):
        release = {**self.release, "version": "0.3.0"}
        installer.validate_release_version(release)
        self.assertEqual(installer.managed_files(release), installer.MANAGED + ("META.ar.md", "RESTAURANT.ar.md"))
        self.assertNotIn("RESTAURANT.ar.md", installer.managed_files(self.release))
        first, second = self.new_settings(release), self.new_settings(release)
        for settings in (first, second):
            self.assertEqual(settings["ASTRACALLS_VERSION"], "0.3.0")
            self.assertEqual(len(base64.b64decode(settings["WACALLS_META_ENCRYPTION_KEY"], validate=True)), 32)
            self.assertEqual(settings["OPENAI_API_KEY"], "")
        for name in ("WACALLS_META_ENCRYPTION_KEY", "WACALLS_API_KEY", "POSTGRES_PASSWORD"):
            self.assertNotEqual(first[name], second[name])

    def test_reinstall_keeps_key_and_missing_optional_key_without_generation(self):
        args = argparse.Namespace(http_port=None, media_port=None, public_ip=None,
                                  http_bind=None, media_bind=None, public_url=None)
        for include_key in (True, False):
            with self.subTest(include_key=include_key), tempfile.TemporaryDirectory(prefix="astracalls-reinstall-test-") as temporary:
                directory = Path(temporary) / "instance"
                payload = Path(temporary) / "payload"
                directory.mkdir()
                payload.mkdir()
                for name in installer.managed_files(self.release):
                    (directory / name).write_text("managed fixture " + name)
                    (payload / name).write_text("managed fixture " + name)
                settings = self.new_settings()
                if not include_key:
                    del settings["WACALLS_META_ENCRYPTION_KEY"]
                env_path = directory / ".env"
                env_path.write_text("".join(key + "=" + value + "\n" for key, value in settings.items()))
                env_path.chmod(0o600)
                before = env_path.read_bytes()
                marker = {"schema": 1, "version": "0.2.0", "project": "astracalls-test", "directory": str(directory),
                          "files": {name: installer.digest(directory / name) for name in installer.managed_files(self.release)}}
                (directory / ".installation.json").write_text(json.dumps(marker))
                with mock.patch.object(installer, "PAYLOAD", payload), \
                        mock.patch.object(installer, "container_info", return_value=[]), \
                        mock.patch.object(installer, "check_named_resources"), \
                        mock.patch.object(installer, "new_settings", side_effect=AssertionError("Reinstall must not generate settings")):
                    self.assertEqual(installer.validate_existing(directory, "astracalls-test", self.release, args), settings)
                self.assertEqual(env_path.read_bytes(), before)

    def test_installing_new_release_over_old_marker_is_not_an_implicit_upgrade(self):
        with tempfile.TemporaryDirectory(prefix="astracalls-upgrade-refusal-test-") as temporary:
            directory = Path(temporary)
            marker = {"schema": 1, "version": "0.1.0", "project": "astracalls-test", "directory": str(directory)}
            (directory / ".installation.json").write_text(json.dumps(marker))
            with self.assertRaisesRegex(installer.InstallError, "not an implicit upgrade"):
                installer.validate_existing(directory, "astracalls-test", self.release, argparse.Namespace())


class InitEnvironmentTests(unittest.TestCase):
    script = Path(__file__).resolve().parents[1] / "scripts/init-env.sh"

    def test_new_private_environment_has_stable_meta_key_and_prints_no_credentials(self):
        with tempfile.TemporaryDirectory(prefix="astracalls-init-env-test-") as temporary:
            path = Path(temporary) / ".env"
            first = subprocess.run(["bash", str(self.script), str(path)], check=True, capture_output=True, text=True)
            settings = installer.read_settings(path)
            key = settings["WACALLS_META_ENCRYPTION_KEY"]
            self.assertEqual(len(base64.b64decode(key, validate=True)), 32)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            before = path.read_bytes()
            second = subprocess.run(["bash", str(self.script), str(path)], check=True, capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), before)
            for name in ("WACALLS_API_KEY", "POSTGRES_PASSWORD", "WACALLS_META_ENCRYPTION_KEY"):
                self.assertNotIn(settings[name], first.stdout + first.stderr + second.stdout + second.stderr)

    def test_existing_environment_is_not_backfilled_or_overwritten(self):
        with tempfile.TemporaryDirectory(prefix="astracalls-init-env-existing-test-") as temporary:
            path = Path(temporary) / ".env"
            path.write_text("# existing install\nWACALLS_META_ENCRYPTION_KEY=\n")
            before = path.read_bytes()
            subprocess.run(["bash", str(self.script), str(path)], check=True, capture_output=True, text=True)
            self.assertEqual(path.read_bytes(), before)


class ImageIdentityTests(InstallerTestCase):
    release = {"images": {
        "app": {"tag": "astracalls-private/app:release-a", "allowed_ids": ["sha256:app"]},
        "postgres": {"tag": "astracalls-private/postgres:release-b", "allowed_ids": ["sha256:postgres"]},
    }}

    def test_private_tag_collision_is_rejected_before_any_image_load(self):
        self.run.side_effect = [subprocess.CompletedProcess([], 0, stdout="sha256:foreign\n", stderr="")]
        with self.assertRaisesRegex(installer.InstallError, "No tags were replaced"):
            installer.load_images(self.release)
        self.run.assert_called_once_with(
            ["docker", "image", "inspect", "astracalls-private/app:release-a", "--format", "{{.Id}}"], check=False)

    def test_later_tag_collision_is_rejected_even_if_first_image_is_missing(self):
        self.run.side_effect = [
            subprocess.CompletedProcess([], 1, stdout="", stderr="missing image"),
            subprocess.CompletedProcess([], 0, stdout="sha256:foreign\n", stderr=""),
        ]
        with mock.patch.object(installer, "digest") as digest:
            with self.assertRaisesRegex(installer.InstallError, "No tags were replaced"):
                installer.load_images(self.release)
            digest.assert_not_called()
        self.assertEqual(self.run.call_count, 2)
        self.assertTrue(all(call.args[0][:3] == ["docker", "image", "inspect"] for call in self.run.call_args_list))


class NamedResourceTests(InstallerTestCase):
    project = "astracalls-example"
    targets = (
        ("volume", "astracalls-example_translation-postgres"),
        ("volume", "astracalls-example_translation-recordings"),
        ("network", "astracalls-example_default"),
        ("container", "astracalls-example-postgres-1"),
        ("container", "astracalls-example-astracalls-1"),
    )

    def inspect_result(self, present_kind, present_name, labels):
        def respond(command, *, check=True):
            self.assertFalse(check)
            self.assertEqual(command[0], "docker")
            self.assertEqual(command[2], "inspect")
            if command[1:4] == [present_kind, "inspect", present_name]:
                item = {"Config": {"Labels": labels}} if present_kind == "container" else {"Labels": labels}
                return subprocess.CompletedProcess(command, 0, stdout=json.dumps([item]), stderr="")
            return subprocess.CompletedProcess(command, 1, stdout="", stderr="not found")
        return respond

    def test_foreign_or_unlabelled_named_resources_are_rejected(self):
        for kind, name in self.targets:
            for labels in (None, {}, {"com.docker.compose.project": "another-project"}):
                with self.subTest(kind=kind, name=name, labels=labels):
                    self.run.side_effect = self.inspect_result(kind, name, labels)
                    with self.assertRaisesRegex(installer.InstallError, "not owned"):
                        installer.check_named_resources(self.project, existing=True)

    def test_new_installation_refuses_even_matching_project_labels(self):
        self.run.side_effect = self.inspect_result("volume", self.targets[0][1],
                                                 {"com.docker.compose.project": self.project})
        with self.assertRaises(installer.InstallError):
            installer.check_named_resources(self.project, existing=False)

    def test_existing_installation_accepts_its_owned_named_resources(self):
        for kind, name in self.targets:
            with self.subTest(kind=kind):
                self.run.side_effect = self.inspect_result(kind, name, {"com.docker.compose.project": self.project})
                installer.check_named_resources(self.project, existing=True)

    def test_absent_names_are_safe_for_a_new_installation(self):
        self.run.side_effect = None
        self.run.return_value = subprocess.CompletedProcess([], 1, stdout="", stderr="not found")
        installer.check_named_resources(self.project)
        self.assertEqual(self.run.call_count, len(self.targets))


if __name__ == "__main__":
    unittest.main()
