"""Guard tests only. Docker is a fake executable; no image or container is run."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'integration' / 'runtime-image-smoke.sh'
SHA = 'a' * 40


class RuntimeImageGuardTests(unittest.TestCase):
    def run_guard(self, mode, actions='true', image=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / 'docker'
            log = root / 'commands'
            fake.write_text('''#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
if [[ "$1 $2" == "container inspect" && "$FAKE_MODE" == existing ]]; then exit 0; fi
if [[ "$2" == inspect ]]; then exit 1; fi
if [[ "$1" == create ]]; then exit 1; fi
exit 0
''')
            fake.chmod(0o700)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                       FAKE_LOG=str(log), FAKE_MODE=mode, GITHUB_ACTIONS=actions,
                       GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1', GITHUB_SHA=SHA,
                       RUNNER_TEMP=str(root))
            result = subprocess.run(['bash', str(SCRIPT), image or 'onlinu-runtime-smoke:' + SHA],
                                    env=env, capture_output=True, text=True, timeout=10)
            return result, log.read_text().splitlines() if log.exists() else []

    def test_refuses_non_actions_context_before_docker(self):
        result, commands = self.run_guard('existing', actions='false')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(commands, [])

    def test_refuses_unexpected_image_before_docker(self):
        result, commands = self.run_guard('existing', image='arbitrary:latest')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(commands, [])

    def test_preexisting_container_is_never_removed(self):
        result, commands = self.run_guard('existing')
        self.assertEqual(result.returncode, 2)
        self.assertTrue(any(c.startswith('container inspect ') for c in commands))
        self.assertFalse(any(c.startswith(('rm ', 'volume rm ', 'network rm ')) for c in commands))

    def test_failed_container_creation_cleans_only_owned_resources(self):
        result, commands = self.run_guard('create-fails')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('volume rm onlinu-image-smoke-123-1-media', commands)
        self.assertIn('network rm onlinu-image-smoke-123-1-network', commands)
        self.assertFalse(any(c.startswith('rm ') for c in commands))
        self.assertFalse(any(c.startswith(('run ', 'start ', 'exec ')) for c in commands))


if __name__ == '__main__':
    unittest.main()
