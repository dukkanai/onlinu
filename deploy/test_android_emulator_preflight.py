import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('emulator_preflight', Path(__file__).resolve().parents[1] / 'integration/android-emulator-preflight.py')
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class EmulatorPreflightTests(unittest.TestCase):
    def test_absent_emulator_and_images_are_diagnostics_not_successful_execution(self):
        with tempfile.TemporaryDirectory(prefix='onlinu-sdk-read-') as temp:
            root = Path(temp)
            with patch.object(preflight.subprocess, 'run') as command:
                report = preflight.inspect_sdk(root, root / 'missing-kvm')
            command.assert_not_called()
            self.assertFalse(report['emulatorInstalled'])
            self.assertFalse(report['deviceStarted'])
            self.assertFalse(report['installedOrChangedAnything'])
            self.assertFalse(report['runtimeAcceptance'])
            self.assertEqual(report['installedX86Images'], [])
            self.assertEqual(list(root.iterdir()), [])

    def test_only_installed_supported_image_metadata_is_reported(self):
        with tempfile.TemporaryDirectory(prefix='onlinu-sdk-read-') as temp:
            root = Path(temp)
            for abi in ['x86_64', 'arm64-v8a']:
                directory = root / f'system-images/android-35/google_apis/{abi}'
                directory.mkdir(parents=True)
                (directory / 'source.properties').write_text(f'Pkg.Path = system-images;android-35;google_apis;{abi}\n')
                (directory / 'system.img').write_bytes(b'synthetic image marker')
            report = preflight.inspect_sdk(root, root / 'missing-kvm')
            self.assertEqual(report['installedX86Images'], ['system-images;android-35;google_apis;x86_64'])
            (root / 'system-images/android-35/google_apis/x86_64/source.properties').write_text('SystemImage.Abi=x86_64\n')
            self.assertEqual(preflight.inspect_sdk(root, root / 'missing-kvm')['installedX86Images'], report['installedX86Images'])

    def test_no_default_or_foreign_context_is_admitted(self):
        with patch.dict(preflight.os.environ, {}, clear=True):
            with self.assertRaises(ValueError):
                preflight.main()
