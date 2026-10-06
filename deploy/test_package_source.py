"""Public geography packaging must not broaden access to private runtime data."""
import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "package_release", Path(__file__).resolve().parents[1] / "scripts/package-release.py"
)
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class SourceGeographyTests(unittest.TestCase):
    def test_pinned_public_inputs_are_included(self):
        self.assertEqual(len(packager.PUBLIC_GEOGRAPHY_FILES), 6)
        for name in packager.PUBLIC_GEOGRAPHY_FILES:
            with self.subTest(name=name):
                self.assertTrue(packager.include_source(name))
                self.assertTrue((packager.PROJECT / name).is_file())

    def test_private_data_and_path_variants_stay_excluded(self):
        for name in (
            "data/production.db", "data/recordings/call.mp3",
            "data/saudi-geography/private.json", "data/saudi-geography/.env",
            "data/saudi-geography/key.pem", "data/saudi-geography/nested/regions_lite.json",
            "/data/saudi-geography/regions_lite.json",
            "data/saudi-geography/../regions_lite.json",
            "data/saudi-geography//regions_lite.json", "auth/session.json",
            ".env", ".env.production", "backups/database.sql",
        ):
            with self.subTest(name=name):
                self.assertFalse(packager.include_source(name))

    def test_only_exact_reviewed_bootstrap_sql_is_allowed(self):
        self.assertEqual(packager.PUBLIC_BOOTSTRAP_FILES, {'deploy/tenant-bootstrap.sql'})
        self.assertTrue(packager.include_source('deploy/tenant-bootstrap.sql'))
        for name in ('deploy/other.sql', 'deploy/tenant-bootstrap.sql.gz',
                     'deploy//tenant-bootstrap.sql', '/deploy/tenant-bootstrap.sql',
                     'deploy/../deploy/tenant-bootstrap.sql', 'backups/tenant-bootstrap.sql'):
            with self.subTest(name=name):
                self.assertFalse(packager.include_source(name))

    def test_ordinary_source_and_env_example_still_included(self):
        self.assertTrue(packager.include_source("cmd/server/restaurant_geography.go"))
        self.assertTrue(packager.include_source(".env.example"))


if __name__ == "__main__":
    unittest.main()
