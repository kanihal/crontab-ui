#!/usr/bin/env bash
set -u

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PAYLOAD="$APP_ROOT/Resources/app"
SERVER_LAUNCHER="$APP_ROOT/Resources/server-launcher.js"
DATA_DIR="$HOME/Library/Application Support/crontab-ui/crontabs"

find_node() {
  local candidate

  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

NODE_BIN="$(find_node || true)"

echo "Crontab UI"
echo "=========="

if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js was not found."
  echo "Install Node.js 20 or newer, then open Crontab UI again."
  echo
  echo "Recommended: https://nodejs.org/"
  exit 1
fi

if ! "$NODE_BIN" -e "const major = Number(process.versions.node.split('.')[0]); process.exit(major >= 20 ? 0 : 1);"; then
  echo "Found Node at $NODE_BIN, but Crontab UI requires Node.js 20 or newer."
  echo "Installed version: $("$NODE_BIN" -v)"
  exit 1
fi

mkdir -p "$DATA_DIR/logs"

echo "Node: $("$NODE_BIN" -v) ($NODE_BIN)"
echo "Data: $DATA_DIR"
echo "Press Ctrl+C or close this Terminal window to stop Crontab UI."
echo

cd "$APP_PAYLOAD" || exit 1
exec "$NODE_BIN" "$SERVER_LAUNCHER"
