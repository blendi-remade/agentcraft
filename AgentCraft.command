#!/bin/sh
# AgentCraft Control: start everything from one place. Dashboard on http://127.0.0.1:8045
# (it starts the Foreman, and Minecraft when you ask it to). Ctrl+C stops it.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js 22+ is required: https://nodejs.org"; exit 1; }
if [ ! -d tools/node_modules/ws ]; then
  echo "Installing dependencies ..."
  npm ci --prefix tools --no-audit --no-fund || exit 1
fi
exec node tools/control.mjs "$@"
