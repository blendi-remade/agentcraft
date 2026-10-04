#!/usr/bin/env python3
"""Install a verified AgentCraft jar into an existing managed Fabric server.

Does not restart the server or write to its world. Configuration and the
existing control script are backed up before the new launch wiring is saved.
"""
import argparse
from datetime import datetime
import hashlib
import json
from pathlib import Path
import shutil
import sys
import zipfile
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--server-root', type=Path, required=True)
parser.add_argument('--jar', type=Path, required=True)
parser.add_argument('--polymer', type=Path, help='Polymer bundled jar; required unless already installed')
parser.add_argument('--owner-uuid', required=True)
parser.add_argument('--owner-name')
parser.add_argument('--repository', type=Path, required=True)
parser.add_argument('--foreman-port', type=int, default=7878)
parser.add_argument('--studio-x', type=int, default=12288)
parser.add_argument('--studio-y', type=int, default=200)
parser.add_argument('--studio-z', type=int, default=12288)
parser.add_argument('--test-offline', action='store_true')
args = parser.parse_args()
uuid.UUID(args.owner_uuid)
if not 1 <= args.foreman_port <= 65535: sys.exit('Invalid Foreman port.')
server = args.server_root.resolve()
polymer = args.polymer or next((server / 'mods').glob('polymer-bundled-*.jar'), None)
if polymer is None: sys.exit('Polymer is required for vanilla guests; supply --polymer.')
with zipfile.ZipFile(polymer) as dependency:
    if json.loads(dependency.read('fabric.mod.json'))['id'] != 'polymer-bundled':
        sys.exit('Expected a Polymer bundled jar.')
project = Path(__file__).resolve().parents[1]
controller = server / 'control.py'
if not controller.is_file():
    sys.exit('Expected the existing managed server control.py.')
node = shutil.which('node')
if not node:
    sys.exit('Node.js is required for the Foreman.')
codex = shutil.which('codex')
if not codex:
    sys.exit('A signed-in Codex CLI is required for the studio.')
with zipfile.ZipFile(args.jar) as jar:
    if json.loads(jar.read('fabric.mod.json'))['id'] != 'agentcraft':
        sys.exit('Expected an AgentCraft mod jar.')
old = controller.read_text()
needle = "server = subprocess.Popen([JAVA, '-Xms512M', '-Xmx3G', '-XX:+UseG1GC',"
new_needle = "server = subprocess.Popen([JAVA, *runtime_args, '-Xms512M', '-Xmx3G', '-XX:+UseG1GC',"
if needle not in old and new_needle not in old:
    sys.exit('Unexpected server controller format; preserved without edits.')
bootstrap = '''# AgentCraft runtime bootstrap (optional; only loaded on server start).
    runtime_args = []
    runtime_file = ROOT / 'agentcraft-runtime.json'
    if runtime_file.exists():
        cfg = json.loads(runtime_file.read_text())
        runtime_args = cfg['jvmArgs']
        launch_env = os.environ.copy()
        launch_env['JAVA_HOME'] = str(pathlib.Path(JAVA).parent.parent)
        launch_args = [cfg['node'], cfg['launcher'], 'launch', '--backend', 'codex',
            '--no-game', '--no-wait', '--home', str(ROOT / 'agentcraft-state'),
            '--profile', cfg.get('foremanProfile', 'minecraft'), '--port', str(cfg['foremanPort']),
            '--repo', cfg['repository'], '--foreman-arg', '--codex-path',
            '--foreman-arg', cfg['codex']]
        if cfg.get('ownerName'):
            launch_args.extend(['--foreman-arg', '--user-name', '--foreman-arg', cfg['ownerName']])
        with open(ROOT / 'agentcraft-launch.log', 'a') as launch_log:
            result = subprocess.run(launch_args, cwd=cfg['project'], env=launch_env,
                stdout=launch_log, stderr=subprocess.STDOUT)
        if result.returncode:
            raise RuntimeError('AgentCraft Foreman startup failed; see agentcraft-launch.log')
    '''
if needle in old:
    updated = old.replace(needle, bootstrap + new_needle, 1)
else:
    start = old.index('# AgentCraft runtime bootstrap')
    end = old.index(new_needle, start)
    updated = old[:start] + bootstrap + old[end:]
compile(updated, str(controller), 'exec')
stamp = datetime.now().strftime('%Y-%m-%d_%H-%M-%S-%f')
backup = server / 'backups' / ('agentcraft-install-' + stamp)
backup.mkdir(parents=True)
for name in ['control.py', 'agentcraft-runtime.json']:
    source = server / name
    if source.exists():
        shutil.copy2(source, backup / name)
jvm_args = [
    '-Dagentcraft.foreman.enabled=true',
    '-Dagentcraft.foreman.port=' + str(args.foreman_port),
    '-Dagentcraft.owner.uuid=' + args.owner_uuid,
    '-Dagentcraft.studio.x=' + str(args.studio_x),
    '-Dagentcraft.studio.y=' + str(args.studio_y),
    '-Dagentcraft.studio.z=' + str(args.studio_z),
]
if args.test_offline:
    jvm_args.append('-Dagentcraft.owner.allowOffline=true')
config = {
    'jvmArgs': jvm_args, 'node': node, 'codex': codex,
    'launcher': str(project / 'tools/mac.mjs'), 'project': str(project),
    'repository': str(args.repository.resolve()),
    'foremanPort': args.foreman_port, 'ownerName': args.owner_name,
    'foremanProfile': 'server-' + hashlib.sha256(str(server).encode()).hexdigest()[:12],
}
target = server / 'mods/agentcraft-codex-multiplayer.jar'
if target.exists():
    shutil.copy2(target, backup / target.name)
temporary = target.with_suffix('.jar.tmp')
shutil.copy2(args.jar, temporary)
temporary.replace(target)
polymer_target = server / 'mods' / polymer.name
if polymer.resolve() != polymer_target.resolve():
    if polymer_target.exists(): shutil.copy2(polymer_target, backup / polymer_target.name)
    shutil.copy2(polymer, polymer_target)
controller.write_text(updated)
(server / 'agentcraft-runtime.json').write_text(json.dumps(config, indent=2) + '\n')
receipt = {
    'installedAt': datetime.now().isoformat(), 'server': str(server),
    'jar': str(target), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
    'configurationBackup': str(backup), 'restartPerformed': False,
    'offlineTest': args.test_offline,
}
(backup / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2))
