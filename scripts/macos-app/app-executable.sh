#!/bin/sh

APP_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TERMINAL_LAUNCHER="$APP_ROOT/Resources/terminal-launcher.sh"
STATE_FILE="$HOME/Library/Application Support/crontab-ui/crontabs/.desktop-server.json"

existing_tty="$(/usr/bin/osascript <<'APPLESCRIPT' 2>/dev/null || true
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      try
        if custom title of t is "Crontab UI" then
          set selected of t to true
          set index of w to 1
          activate
          return tty of t
        end if
      end try
    end repeat
  end repeat
end tell
return ""
APPLESCRIPT
)"

if [ -n "$existing_tty" ] && [ -f "$STATE_FILE" ]; then
  old_pid="$(/usr/bin/sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$STATE_FILE" | /usr/bin/head -n 1)"
  if [ -n "$old_pid" ] && /bin/kill -0 "$old_pid" 2>/dev/null; then
    /bin/kill -TERM "$old_pid" 2>/dev/null || true
    i=0
    while /bin/kill -0 "$old_pid" 2>/dev/null && [ "$i" -lt 30 ]; do
      /bin/sleep 0.1
      i=$((i + 1))
    done
    if /bin/kill -0 "$old_pid" 2>/dev/null; then
      /bin/kill -KILL "$old_pid" 2>/dev/null || true
    fi
  fi
fi

if [ -n "$existing_tty" ]; then
  /usr/bin/osascript - "$TERMINAL_LAUNCHER" "$existing_tty" <<'APPLESCRIPT'
on run argv
  set launcherPath to item 1 of argv
  set targetTty to item 2 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        try
          if tty of t is targetTty then
            set selected of t to true
            set index of w to 1
            activate
            repeat 100 times
              if busy of t is false then exit repeat
              delay 0.1
            end repeat
            do script quoted form of launcherPath in t
            set custom title of t to "Crontab UI"
            set title displays custom title of t to true
            return
          end if
        end try
      end repeat
    end repeat
  end tell
end run
APPLESCRIPT
  exit 0
fi

/usr/bin/osascript - "$TERMINAL_LAUNCHER" <<'APPLESCRIPT'
on run argv
  set launcherPath to item 1 of argv
  tell application "Terminal"
    activate
    set crontabTab to do script quoted form of launcherPath
    set custom title of crontabTab to "Crontab UI"
    set title displays custom title of crontabTab to true
  end tell
end run
APPLESCRIPT
