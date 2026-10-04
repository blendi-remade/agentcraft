#!/bin/bash
# One-time Steam Deck setup for AgentCraft. Everything goes into your home folder; nothing needs
# sudo or touches the read-only SteamOS root. Safe to run again.
#   1. Java 25 (Temurin) and Node 22 into ~/.local/opt, unless suitable ones are already installed
#   2. Controlify (controller support) + YetAnotherConfigLib into mod/run/mods, from Modrinth
#   3. A Steam library entry "AgentCraft" that runs tools/steamdeck/launch.sh
# Afterwards: tools/steamdeck/art.sh adds library artwork (optional).
# --no-steam skips step 3 (e.g. when the library entry already exists).
set -eu
NO_STEAM=0
[ "${1:-}" = --no-steam ] && NO_STEAM=1
ROOT=$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)
OPT="$HOME/.local/opt"
mkdir -p "$OPT"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

# 1. Java 25
if [ -n "${JAVA_HOME:-}" ] && "$JAVA_HOME/bin/java" -version 2>&1 | grep -q 'version "25'; then
  say "Java 25: $JAVA_HOME"
elif [ -x "$OPT/jdk-25/bin/java" ]; then
  say "Java 25: $OPT/jdk-25"
else
  say "Downloading Temurin Java 25 into $OPT/jdk-25"
  mkdir -p "$OPT/jdk-25"
  curl -fsSL "https://api.adoptium.net/v3/binary/latest/25/ga/linux/x64/jdk/hotspot/normal/eclipse" \
    | tar xz -C "$OPT/jdk-25" --strip-components=1
fi

# Node 22+
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
  say "Node: $(command -v node) ($(node --version))"
elif [ -x "$OPT/node-22/bin/node" ]; then
  say "Node: $OPT/node-22"
else
  V=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c \
    "import json,sys; print(next(r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v22.')))")
  say "Downloading Node $V into $OPT/node-22"
  curl -fsSL "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz" | tar xJ -C "$OPT"
  rm -rf "$OPT/node-22" && mv "$OPT/node-$V-linux-x64" "$OPT/node-22"
fi

# 2. Controlify + YACL for the Minecraft version the mod targets (verified against Modrinth's sha512)
MC=$(sed -n 's/^minecraft_version=//p' "$ROOT/mod/gradle.properties")
say "Controller support for Minecraft $MC (Controlify + YetAnotherConfigLib)"
mkdir -p "$ROOT/mod/run/mods"
python3 - "$ROOT/mod/run/mods" "$MC" <<'PY'
import hashlib, json, os, sys, urllib.parse, urllib.request
dest, mc = sys.argv[1], sys.argv[2]
for project in ("controlify", "yacl"):
    q = urllib.parse.urlencode({"loaders": '["fabric"]', "game_versions": json.dumps([mc])})
    versions = json.load(urllib.request.urlopen(f"https://api.modrinth.com/v2/project/{project}/version?{q}"))
    if not versions:
        sys.exit(f"no {project} build for Minecraft {mc} on Modrinth yet")
    f = next((f for f in versions[0]["files"] if f["primary"]), versions[0]["files"][0])
    path = os.path.join(dest, f["filename"])
    if os.path.exists(path):
        print(f"    {f['filename']} (already there)"); continue
    for old in os.listdir(dest):  # drop older builds of the same mod
        if old.startswith({"controlify": "controlify-", "yacl": "yet_another_config_lib"}[project]):
            os.remove(os.path.join(dest, old))
    data = urllib.request.urlopen(f["url"]).read()
    if hashlib.sha512(data).hexdigest() != f["hashes"]["sha512"]:
        sys.exit(f"checksum mismatch for {f['filename']}")
    open(path, "wb").write(data)
    print(f"    {f['filename']}")
PY

# 3. Steam library entry
chmod +x "$ROOT/tools/steamdeck/launch.sh" "$ROOT/tools/steamdeck/art.sh"
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"
cat > "$APPS/agentcraft-steamdeck.desktop" <<DESKTOP
[Desktop Entry]
Name=AgentCraft
Comment=Claude agents in a Minecraft studio
Exec=$ROOT/tools/steamdeck/launch.sh
Icon=$ROOT/mod/src/main/resources/assets/agentcraft/icon.png
Terminal=false
Type=Application
NoDisplay=true
DESKTOP
if [ "$NO_STEAM" = 1 ]; then
  say "Skipping the Steam library entry (--no-steam)"
elif command -v steamos-add-to-steam >/dev/null && pgrep -x steam >/dev/null; then
  say "Adding AgentCraft to your Steam library"
  steamos-add-to-steam "$APPS/agentcraft-steamdeck.desktop"
else
  say "Steam isn't running: add $APPS/agentcraft-steamdeck.desktop as a non-Steam game yourself"
fi

say "Done. In Steam: AgentCraft > controller settings > Templates > Gamepad, then launch it."
say "Optional artwork: tools/steamdeck/art.sh"
