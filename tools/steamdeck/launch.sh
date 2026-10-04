#!/bin/bash
# AgentCraft launcher for the Steam Deck, meant to be started by Steam (Game Mode or Desktop Mode).
# Starts the Foreman and the Fabric development client through tools/unix.mjs, then stays alive
# while the game runs so Steam keeps tracking it, and cleans up when the game closes.
# Backend: sim (free scripted team) unless AGENTCRAFT_BACKEND=claude.
set -u
ROOT=$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)
OPT="$HOME/.local/opt"
BACKEND=${AGENTCRAFT_BACKEND:-sim}

# Java 25 and Node 22: prefer JAVA_HOME / PATH, else the copies install.sh puts in ~/.local/opt.
[ -n "${JAVA_HOME:-}" ] || export JAVA_HOME="$OPT/jdk-25"
NODE=$(command -v node || true)
[ -x "$OPT/node-22/bin/node" ] && NODE="$OPT/node-22/bin/node"
export PATH="$(dirname "$NODE"):$PATH"
# No shared Gradle daemon: a daemon started outside Steam (e.g. from a terminal) would launch the
# game outside this Steam shortcut, so Game Mode would show it under the wrong app and controls.
export GRADLE_OPTS="-Dorg.gradle.daemon=false"

LOG="$ROOT/artifacts/logs/steamdeck-launch.log"
mkdir -p "$ROOT/artifacts/logs"
cd "$ROOT" || exit 1

{
  echo "=== $(date) launching backend=$BACKEND"
  "$NODE" tools/unix.mjs launch --backend "$BACKEND" "$@"
} >>"$LOG" 2>&1 || { echo "launch failed, see $LOG" >&2; exit 1; }

# Steam stops this script as soon as the game window closes, so clean up from a trap too.
cleanup() {
  trap - EXIT TERM INT HUP
  # The free sim team stops with the game; real (claude) agents keep working by design.
  if [ "$BACKEND" = sim ]; then
    "$NODE" tools/unix.mjs stop --profile sim --stop-daemon >>"$LOG" 2>&1
  else
    "$NODE" tools/unix.mjs stop --game --stop-daemon >>"$LOG" 2>&1
  fi
  echo "=== $(date) game closed" >>"$LOG"
  exit 0
}
trap cleanup EXIT TERM INT HUP

GAME_PID=$("$NODE" -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).pid)" \
  "$ROOT/artifacts/run/unix-game-$BACKEND.json" 2>/dev/null)
while [ -n "$GAME_PID" ] && kill -0 "$GAME_PID" 2>/dev/null; do sleep 2; done
cleanup
