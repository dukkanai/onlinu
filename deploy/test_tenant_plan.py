"""Pure plan tests: no Docker, network calls, credentials or deployment."""
import base64
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

spec = importlib.util.spec_from_file_location("tenant_plan", Path(__file__).with_name("tenant_plan.py"))
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


def fixture(tenant="restaurant-a", port=18080):
    return {"tenantId": tenant, "runtimeImage": "registry.example/onlinu@sha256:" + "a" * 64,
            "postgresImage": "postgres@sha256:" + "b" * 64, "httpPort": port,
            "publicOrigin": "https://" + tenant + ".example.invalid",
            "platformIssuer": "https://platform.example.invalid",
            "platformPublicKey": base64.b64encode(bytes(range(32))).decode()}


class TenantPlanTests(unittest.TestCase):
    def test_deterministic_pure_plan_and_input_preserved(self):
        config = fixture()
        original = copy.deepcopy(config)
        a = planner.plan_tenant(config)
        b = planner.plan_tenant(dict(reversed(list(config.items()))))
        self.assertEqual(a, b)
        self.assertEqual(config, original)
        self.assertFalse(a["executable"])
        self.assertEqual(a["runtime"]["httpBinding"]["host"], "127.0.0.1")
        self.assertEqual(a["postgres"]["publishedPorts"], [])
        self.assertFalse(a["postgres"]["runtimeRole"]["superuser"])
        self.assertTrue(a["postgres"]["runtimeRole"]["createdb"])
        self.assertNotIn("docker.sock", json.dumps(a))

    def test_two_tenants_have_disjoint_owned_resources(self):
        a, b = planner.plan_fleet([fixture("restaurant-b", 18081), fixture()])
        self.assertEqual(a["tenantId"], "restaurant-a")
        for field in ("projectName", "planDigest"):
            self.assertNotEqual(a[field], b[field])
        self.assertNotEqual(a["postgres"]["volume"], b["postgres"]["volume"])
        self.assertNotEqual(a["runtime"]["mediaVolume"], b["runtime"]["mediaVolume"])
        self.assertTrue(set(a["runtime"]["secretReferences"].values()).isdisjoint(b["runtime"]["secretReferences"].values()))
        self.assertTrue(set(a["networks"].values()).isdisjoint(b["networks"].values()))

    def test_changes_produce_new_review_digest(self):
        base = planner.plan_tenant(fixture())["planDigest"]
        for field, value in (("httpPort", 18081), ("runtimeImage", "registry.example/onlinu@sha256:" + "c" * 64),
                             ("publicOrigin", "https://changed.example.invalid")):
            config = fixture()
            config[field] = value
            self.assertNotEqual(base, planner.plan_tenant(config)["planDigest"])

    def test_credential_or_executor_fields_rejected(self):
        for field in ("password", "apiKey", "env", "volumes", "command", "dockerSocket", "hostPath"):
            config = fixture()
            config[field] = "PRIVATE_MARKER"
            with self.assertRaises(planner.PlanError) as caught:
                planner.plan_tenant(config)
            self.assertNotIn("PRIVATE_MARKER", str(caught.exception))

    def test_invalid_ids_ports_and_images_rejected(self):
        cases = {"tenantId": ["../x", "", "UPPER", "a" * 65, "-bad", "a\n", None],
                 "httpPort": [True, "18080", 80, 65536, -1],
                 "runtimeImage": ["onlinu:latest", "https://host/x@sha256:" + "a" * 64,
                                  "../x@sha256:" + "a" * 64, "x@sha256:" + "a" * 63]}
        for field, values in cases.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    config = fixture(); config[field] = value
                    with self.assertRaises(planner.PlanError):
                        planner.plan_tenant(config)

    def test_origins_and_public_key_validated(self):
        for value in ("http://a.example", "https://user:PRIVATE_MARKER@a.example", "https://a.example/path",
                      "https://a.example?token=PRIVATE_MARKER", "https://127.0.0.1", "https://localhost",
                      "https://a.example:8080", "https://a.example\\evil", "https://a..example", "https://a.example\n"):
            config = fixture(); config["publicOrigin"] = value
            with self.subTest(value=value), self.assertRaises(planner.PlanError) as caught:
                planner.plan_tenant(config)
            self.assertNotIn("PRIVATE_MARKER", str(caught.exception))
        for value in ("", "PRIVATE_MARKER", base64.b64encode(bytes(31)).decode(), None):
            config = fixture(); config["platformPublicKey"] = value
            with self.assertRaises(planner.PlanError):
                planner.plan_tenant(config)

    def test_fleet_rejects_duplicate_names_ports_and_origins(self):
        for field in ("tenantId", "httpPort", "publicOrigin"):
            a, b = fixture(), fixture("restaurant-b", 18081)
            b[field] = a[field]
            with self.subTest(field=field), self.assertRaises(planner.PlanError):
                planner.plan_fleet([a, b])
        for value in ([], {}, [fixture()] * 1001):
            with self.assertRaises(planner.PlanError):
                planner.plan_fleet(value)

    def test_cli_is_bounded_and_rejects_duplicate_json_keys(self):
        path = str(Path(__file__).with_name("tenant_plan.py"))
        for raw in (b'{"secret":"PRIVATE_MARKER"', b'[{"tenantId":"a","tenantId":"b"}]', b'x' * (planner.MAX_INPUT_BYTES + 1), b'[' * 2000 + b']' * 2000):
            result = subprocess.run([sys.executable, path], input=raw, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b"")
            self.assertNotIn(b"PRIVATE_MARKER", result.stderr)
            self.assertNotIn(b"Traceback", result.stderr)
        result = subprocess.run([sys.executable, path], input=json.dumps([fixture()]).encode(), capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)[0]["tenantId"], "restaurant-a")


if __name__ == "__main__":
    unittest.main()
