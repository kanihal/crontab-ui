#!/bin/sh

APP_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TERMINAL_LAUNCHER="$APP_ROOT/Resources/terminal-launcher.sh"

/usr/bin/osascript - "$TERMINAL_LAUNCHER" <<'APPLESCRIPT'
on run argv
  set launcherPath to item 1 of argv
  tell application "Terminal"
    activate
    do script quoted form of launcherPath
  end tell
end run
APPLESCRIPT
