"""Isolated packaging fixtures; run with python3 -m unittest tools/test_package_multiplayer.py."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile


class PackageMultiplayerTest(unittest.TestCase):
    def test_package_and_reject_wrong_polymer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name, mod_id in [('agent.jar', 'agentcraft'), ('fabric.jar', 'fabric-api'),
                                 ('polymer.jar', 'polymer-bundled'), ('wrong.jar', 'unrelated')]:
                with zipfile.ZipFile(root / name, 'w') as archive:
                    archive.writestr('fabric.mod.json', json.dumps({'id': mod_id}))
            command = [sys.executable, str(Path(__file__).with_name('package_multiplayer.py')),
                       '--jar', str(root / 'agent.jar'), '--fabric-api', str(root / 'fabric.jar')]
            rejected = subprocess.run(command + ['--polymer', str(root / 'wrong.jar'),
                                      '--out', str(root / 'rejected')], capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn('Polymer bundled', rejected.stderr)
            self.assertFalse((root / 'rejected').exists())
            subprocess.run(command + ['--polymer', str(root / 'polymer.jar'),
                           '--out', str(root / 'out')], capture_output=True, text=True, check=True)
            with zipfile.ZipFile(root / 'out/AgentCraft-Codex-Multiplayer.zip') as archive:
                self.assertEqual(set(archive.namelist()), {
                    'instance.cfg', 'mmc-pack.json', 'INSTALL.txt', 'LICENSE',
                    '.minecraft/mods/agentcraft-codex-multiplayer.jar',
                    '.minecraft/mods/fabric.jar', '.minecraft/mods/polymer.jar'})
            for line in (root / 'out/SHA256SUMS').read_text().splitlines():
                digest, name = line.split('  ')
                self.assertEqual(digest, hashlib.sha256((root / 'out' / name).read_bytes()).hexdigest())


if __name__ == '__main__':
    unittest.main()
