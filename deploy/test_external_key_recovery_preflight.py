"""Synthetic metadata only: no DB, archive, keyring, network or backup operations."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("external_key_recovery_preflight.py")
spec = importlib.util.spec_from_file_location("external_key_recovery_preflight", SCRIPT)
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def fixture():
    common = {"version": 1, "cryptoMode": "external-v1", "storeId": "synthetic-store",
              "databaseName": "synthetic_main", "schemaName": "public"}
    manifest = dict(common, kind=recovery.MANIFEST_KIND, stateVersion=1, envelopes=[
        {"version": 1, "storeId": common["storeId"], "purpose": purpose,
         "dataKeyId": data_key, "wrappingKeyId": "retained-old"}
        for purpose, data_key in recovery.DATA_KEYS.items()])
    target = dict(common, kind=recovery.TARGET_KIND, availableWrappingKeyIds=["current-new", "retained-old"])
    return manifest, target


class ExternalKeyRecoveryPreflightTests(unittest.TestCase):
    def assert_rejected(self, manifest, target):
        with self.assertRaises(recovery.RecoveryPreflightError):
            recovery.compare_recovery_metadata(manifest, target)

    def test_historical_generation_is_compatible_when_retained_and_inputs_unchanged(self):
        manifest, target = fixture()
        before = copy.deepcopy((manifest, target))
        result = recovery.compare_recovery_metadata(manifest, target)
        self.assertEqual((manifest, target), before)
        self.assertEqual(result["status"], "declarations-compatible")
        self.assertFalse(result["executable"])
        self.assertFalse(result["restoreVerified"])
        self.assertIn("key-bytes-and-custody", result["notVerified"])
        self.assertIn("media-and-cross-resource-consistency", result["notVerified"])
        self.assertIn("business-data-and-sequences", result["notVerified"])
        self.assertIn("independent-off-host-recovery", result["notVerified"])
        self.assertNotIn(manifest["storeId"], json.dumps(result))
        manifest["envelopes"].reverse()
        target["availableWrappingKeyIds"].reverse()
        self.assertEqual(recovery.compare_recovery_metadata(manifest, target), result)

    def test_current_only_inventory_cannot_recover_old_generation(self):
        manifest, target = fixture()
        target["availableWrappingKeyIds"] = ["current-new"]
        self.assert_rejected(manifest, target)

    def test_same_key_names_cannot_establish_correct_key_material(self):
        # There deliberately is no key-byte input or authenticated result.
        result = recovery.compare_recovery_metadata(*fixture())
        self.assertIn("envelope-and-payload-authentication", result["notVerified"])
        self.assertIn("declaration-authenticity", result["notVerified"])
        self.assertFalse(result["restoreVerified"])

    def test_relocated_database_schema_or_store_refused_without_rewriting(self):
        for field, changed in (("storeId", "another-store"), ("databaseName", "onlinu_restore_abcdef"),
                               ("schemaName", "other_schema"), ("databaseName", "SYNTHETIC_main")):
            with self.subTest(field=field, changed=changed):
                manifest, target = fixture()
                target[field] = changed
                before = copy.deepcopy((manifest, target))
                self.assert_rejected(manifest, target)
                self.assertEqual((manifest, target), before)

    def test_exact_top_level_contract_excludes_secrets_and_execution_inputs(self):
        for side in (0, 1):
            for field in ("key", "keys", "keyring", "password", "nonce", "ciphertext", "archivePath",
                          "databaseURL", "command", "restore", "StoreId"):
                with self.subTest(side=side, field=field):
                    inputs = fixture()
                    inputs[side][field] = "PRIVATE_MARKER"
                    self.assert_rejected(*inputs)
            for field in list(fixture()[side]):
                inputs = fixture()
                del inputs[side][field]
                self.assert_rejected(*inputs)

    def test_versions_and_mode_are_exact_not_bool_float_or_padded(self):
        for side in (0, 1):
            for version in (True, False, 0, 2, 1.0, "1", None, []):
                inputs = fixture()
                inputs[side]["version"] = version
                self.assert_rejected(*inputs)
            for field, value in (("cryptoMode", "legacy"), ("cryptoMode", " external-v1"),
                                 ("kind", recovery.TARGET_KIND if side == 0 else recovery.MANIFEST_KIND)):
                inputs = fixture()
                inputs[side][field] = value
                self.assert_rejected(*inputs)
        for version in (True, 1.0, 2, "1"):
            manifest, target = fixture()
            manifest["stateVersion"] = version
            self.assert_rejected(manifest, target)

    def test_identifier_contract_matches_runtime_ascii_bounds(self):
        for field, limit, allowed in (("storeId", 80, "0A_b-c"), ("databaseName", 63, "_9A_b"),
                                      ("schemaName", 63, "0_PUBLIC")):
            for value in (allowed, "A" * limit):
                manifest, target = fixture()
                manifest[field] = target[field] = value
                if field == "storeId":
                    for envelope in manifest["envelopes"]:
                        envelope["storeId"] = value
                recovery.compare_recovery_metadata(manifest, target)
            for value in ("", "A" * (limit + 1), "é", "عربي", "bad.name", "bad name", "a\n", [], None, 1):
                manifest, target = fixture()
                manifest[field] = target[field] = value
                self.assert_rejected(manifest, target)
        for value in ("_store", "-store"):
            manifest, target = fixture()
            manifest["storeId"] = target["storeId"] = value
            self.assert_rejected(manifest, target)

    def test_envelopes_require_complete_exact_purposes_and_store_identity(self):
        for envelopes in (None, {}, [], fixture()[0]["envelopes"][:1], fixture()[0]["envelopes"] * 2):
            manifest, target = fixture()
            manifest["envelopes"] = envelopes
            self.assert_rejected(manifest, target)
        for field, value in (("version", True), ("version", 2), ("storeId", "other"),
                             ("purpose", "payment-secrets"), ("purpose", []), ("purpose", "other"),
                             ("dataKeyId", "payment-dek-v1"), ("dataKeyId", "order-dek-v2"),
                             ("wrappingKeyId", "current-new")):
            manifest, target = fixture()
            manifest["envelopes"][0][field] = value
            self.assert_rejected(manifest, target)
        for field in list(recovery.ENVELOPE_FIELDS):
            manifest, target = fixture()
            del manifest["envelopes"][0][field]
            self.assert_rejected(manifest, target)
        for field in ("key", "nonce", "ciphertext", "Version"):
            manifest, target = fixture()
            manifest["envelopes"][0][field] = "PRIVATE_MARKER"
            self.assert_rejected(manifest, target)

    def test_key_inventory_matches_runtime_bounds_and_refuses_duplicates(self):
        for value in (None, {}, [], ["retained-old"] * 2, ["retained-old"] + [f"key-{n}" for n in range(16)],
                      ["retained-old", ""], ["retained-old", "_key"], ["retained-old", "A" * 65],
                      ["retained-old", "A\n"], ["retained-old", []]):
            manifest, target = fixture()
            target["availableWrappingKeyIds"] = value
            self.assert_rejected(manifest, target)
        manifest, target = fixture()
        target["availableWrappingKeyIds"] = ["retained-old"] + [f"key-{n}" for n in range(15)]
        recovery.compare_recovery_metadata(manifest, target)
        for value in ("A" * 64, "0A_b-c"):
            manifest, target = fixture()
            target["availableWrappingKeyIds"] = [value]
            for envelope in manifest["envelopes"]:
                envelope["wrappingKeyId"] = value
            recovery.compare_recovery_metadata(manifest, target)

    def test_json_parser_rejects_duplicates_unknown_constants_and_malformed_bytes(self):
        for raw in (b'', b'[]', b'null', b'{} {}', b'{"a":1,"a":2}',
                    b'{"storeId":1,"store\\u0049d":2}', b'{"a":{"b":1,"b":2}}',
                    b'{"a":NaN}', b'{"a":Infinity}', b'{"a":-Infinity}', b'{"a":"\xff"}',
                    b'{' + b' ' * recovery.MAX_DOCUMENT_BYTES + b'}',
                    b'[' * 2000 + b']' * 2000):
            with self.subTest(raw=raw[:40]), self.assertRaises(recovery.RecoveryPreflightError):
                recovery.parse_document(raw)
        for document in fixture():
            self.assertEqual(recovery.parse_document(json.dumps(document).encode()), document)

    def test_explicit_files_are_bounded_regular_files_not_links_or_devices(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            regular = root / "metadata.json"
            regular.write_bytes(json.dumps(fixture()[0]).encode())
            self.assertEqual(recovery.read_document(regular), fixture()[0])
            linked = root / "link"
            linked.symlink_to(regular)
            big = root / "oversized"
            big.write_bytes(b" " * (recovery.MAX_DOCUMENT_BYTES + 1))
            rejected = [root, linked, big, root / "missing"]
            if hasattr(os, "mkfifo"):
                fifo = root / "fifo"
                os.mkfifo(fifo)
                rejected.append(fifo)
            for path in rejected:
                with self.subTest(path=path.name), self.assertRaises(recovery.RecoveryPreflightError):
                    recovery.read_document(path)

    def test_cli_only_reads_explicit_metadata_and_emits_no_declared_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest, target = fixture()
            paths = [root / "manifest.json", root / "target.json"]
            for path, document in zip(paths, (manifest, target)):
                path.write_text(json.dumps(document))
            before = {path: path.read_bytes() for path in paths}
            # Ambient application/DB settings are intentionally irrelevant.
            environment = dict(os.environ, WACALLS_CRYPTO_KEYRING="PRIVATE_MARKER",
                               WACALLS_PG_URL="PRIVATE_MARKER", PGHOST="PRIVATE_MARKER")
            result = subprocess.run([sys.executable, str(SCRIPT), *map(str, paths)],
                                    env=environment, capture_output=True, text=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(json.loads(result.stdout)["restoreVerified"])
            self.assertEqual(result.stderr, "")
            self.assertNotIn("PRIVATE_MARKER", result.stdout)
            self.assertEqual({path: path.read_bytes() for path in paths}, before)
            self.assertEqual(set(root.iterdir()), set(paths))

    def test_cli_rejects_secret_fields_and_paths_without_echo_or_traceback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bad = root / "PRIVATE_MARKER.json"
            bad.write_text('{"key":"PRIVATE_MARKER"}')
            for args in ([str(bad), str(bad)], [str(bad / "PRIVATE_MARKER"), str(bad)], ["PRIVATE_MARKER"]):
                result = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True,
                                        text=True, timeout=5)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("PRIVATE_MARKER", result.stderr)
                self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
