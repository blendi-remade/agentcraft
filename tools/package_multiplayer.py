#!/usr/bin/env python3
"""Package the built client mod without server state or local credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--jar', type=Path, required=True)
parser.add_argument('--fabric-api', type=Path, required=True)
parser.add_argument('--polymer', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
with zipfile.ZipFile(args.jar) as jar:
    metadata = json.loads(jar.read('fabric.mod.json'))
    if metadata['id'] != 'agentcraft':
        raise SystemExit('Expected the built AgentCraft mod jar.')
with zipfile.ZipFile(args.fabric_api) as jar:
    if json.loads(jar.read('fabric.mod.json'))['id'] != 'fabric-api':
        raise SystemExit('Expected a Fabric API jar.')
with zipfile.ZipFile(args.polymer) as jar:
    if json.loads(jar.read('fabric.mod.json'))['id'] != 'polymer-bundled':
        raise SystemExit('Expected a Polymer bundled jar.')
args.out.mkdir(parents=True, exist_ok=True)
mod = args.out / 'agentcraft-codex-multiplayer.jar'
shutil.copy2(args.jar, mod)
pack = {
    'formatVersion': 1,
    'components': [
        {'uid': 'net.minecraft', 'version': '26.3', 'important': True},
        {'uid': 'net.fabricmc.fabric-loader', 'version': '0.19.5'},
    ],
}
instance = '''[General]
InstanceType=OneSix
name=AgentCraft - Multiplayer Studio
iconKey=default
AutomaticJava=true
OverrideJavaLocation=false
OverrideJavaArgs=true
JvmArgs=-Dagentcraft.autoworld=0 -Dagentcraft.mute=0 -Dagentcraft.focus=1 -Dagentcraft.dev=0
OverrideMemory=true
MinMemAlloc=512
MaxMemAlloc=4096
'''
instructions = '''AgentCraft - Multiplayer Studio

Minecraft Java 26.3 / Fabric Loader 0.19.5 / Java 25.

Prism Launcher: Add Instance, import this ZIP, then launch the new profile.
Join the Minecraft server address supplied by the host.

Existing Fabric 26.3 installation: copy agentcraft-codex-multiplayer.jar
and the included Fabric API and Polymer jars from the ZIP's .minecraft/mods directory
into your own mods directory, then restart Minecraft. Disable AgentCraft's
singleplayer auto-world with JVM argument -Dagentcraft.autoworld=0.

Only the host/coding player needs this modded client. Guests can join with plain Java Minecraft 26.3.
The server needs Polymer to project studio blocks/items into vanilla equivalents.
No Foreman URL, provider credentials, API keys, or server world files are
included in this client package. The host runs Foreman with Codex, Claude,
or a mixed team and controls repository access, permissions and merge decisions.
Choose providers, models and reasoning in the coding owner's in-game Team setup.
Claude uses API authentication by default; the host can explicitly enable a
personal Claude subscription login with --use-claude-login.
'''
archive_path = args.out / 'AgentCraft-Codex-Multiplayer.zip'
with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('instance.cfg', instance)
    archive.writestr('mmc-pack.json', json.dumps(pack, indent=2) + '\n')
    archive.writestr('INSTALL.txt', instructions)
    archive.write(mod, '.minecraft/mods/' + mod.name)
    archive.write(args.fabric_api, '.minecraft/mods/' + args.fabric_api.name)
    archive.write(args.polymer, '.minecraft/mods/' + args.polymer.name)
    archive.write(Path(__file__).resolve().parents[1] / 'LICENSE', 'LICENSE')
(args.out / 'INSTALL.txt').write_text(instructions)
hashes = []
for file in [mod, archive_path]:
    digest = hashlib.sha256(file.read_bytes()).hexdigest()
    hashes.append(digest + '  ' + file.name)
    print(file, file.stat().st_size, digest)
(args.out / 'SHA256SUMS').write_text('\n'.join(hashes) + '\n')
