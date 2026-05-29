#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Crontab UI"
BUNDLE_ID="com.crontabui.app"
VERSION="$(node -p "require(process.argv[1]).version" "$ROOT_DIR/package.json")"
DIST_DIR="$ROOT_DIR/dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
PAYLOAD_DIR="$RESOURCES_DIR/app"
ICON_SRC="$ROOT_DIR/build/icon.icns"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: macOS app bundles can only be built on macOS." >&2
  exit 1
fi

if [[ ! -f "$ICON_SRC" ]]; then
  echo "==> build/icon.icns missing; generating icon"
  bash "$ROOT_DIR/scripts/generate-icon.sh"
fi

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$PAYLOAD_DIR"

cp "$ROOT_DIR/scripts/macos-app/app-executable.sh" "$MACOS_DIR/$APP_NAME"
cp "$ROOT_DIR/scripts/macos-app/terminal-launcher.sh" "$RESOURCES_DIR/terminal-launcher.sh"
cp "$ROOT_DIR/scripts/macos-app/server-launcher.js" "$RESOURCES_DIR/server-launcher.js"
cp "$ICON_SRC" "$RESOURCES_DIR/icon.icns"
chmod +x "$MACOS_DIR/$APP_NAME" "$RESOURCES_DIR/terminal-launcher.sh" "$RESOURCES_DIR/server-launcher.js"

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

rsync -a --delete \
  "$ROOT_DIR/app.js" \
  "$ROOT_DIR/crontab.js" \
  "$ROOT_DIR/restore.js" \
  "$ROOT_DIR/routes.js" \
  "$ROOT_DIR/package.json" \
  "$ROOT_DIR/package-lock.json" \
  "$ROOT_DIR/bin" \
  "$ROOT_DIR/config" \
  "$ROOT_DIR/middleware" \
  "$ROOT_DIR/public" \
  "$ROOT_DIR/views" \
  "$PAYLOAD_DIR/"

(
  cd "$PAYLOAD_DIR"
  npm ci --omit=dev --ignore-scripts
)

echo "Built $APP_DIR"
