#!/bin/bash
# Draw Minecraft-style library artwork for the "AgentCraft" Steam shortcut and install it into
# Steam's grid folder. Run after install.sh has added the shortcut. Needs Pillow: uses uv if you
# have it, otherwise the system python3 must have PIL.
set -eu
ROOT=$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)
STEAM="$HOME/.local/share/Steam"

# Find the shortcut's app id in each Steam account's shortcuts.vdf (binary VDF).
found=0
for vdf in "$STEAM"/userdata/*/config/shortcuts.vdf; do
  [ -f "$vdf" ] || continue
  appid=$(python3 - "$vdf" <<'PY'
import re, struct, sys
d = open(sys.argv[1], 'rb').read()
for m in re.finditer(rb'\x01(?:AppName|appname)\x00AgentCraft\x00', d):
    j = d.rfind(b'\x02appid\x00', 0, m.start())
    if j >= 0: print(struct.unpack('<I', d[j + 7:j + 11])[0]); break
PY
)
  [ -n "$appid" ] || continue
  grid="$(dirname "$vdf")/grid"
  mkdir -p "$grid"
  if command -v uv >/dev/null; then
    uv run -q --with pillow python "$ROOT/tools/steamdeck/art.py" "$grid" "$appid"
  else
    python3 "$ROOT/tools/steamdeck/art.py" "$grid" "$appid"
  fi
  echo "Artwork installed for app $appid in $grid"
  found=1
done
[ "$found" = 1 ] || { echo "No \"AgentCraft\" shortcut found. Run tools/steamdeck/install.sh first." >&2; exit 1; }
echo "Leave and reopen the library (or restart Steam) to see it."
