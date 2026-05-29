#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

rm -rf build/icon.iconset
mkdir -p build/icon.iconset

echo "==> rendering 1024x1024 PNG via Node"
node scripts/generate-icon.js

SRC=build/icon-1024.png
if [[ ! -f "$SRC" ]]; then
  echo "ERROR: $SRC not produced" >&2
  exit 1
fi

echo "==> resizing via sips"
for s in 16 32 64 128 256 512; do
  sips -z "$s" "$s" "$SRC" --out "build/icon-${s}.png" >/dev/null
done

echo "==> assembling iconset"
cp build/icon-16.png   build/icon.iconset/icon_16x16.png
cp build/icon-32.png   build/icon.iconset/icon_16x16@2x.png
cp build/icon-32.png   build/icon.iconset/icon_32x32.png
cp build/icon-64.png   build/icon.iconset/icon_32x32@2x.png
cp build/icon-128.png  build/icon.iconset/icon_128x128.png
cp build/icon-256.png  build/icon.iconset/icon_128x128@2x.png
cp build/icon-256.png  build/icon.iconset/icon_256x256.png
cp build/icon-512.png  build/icon.iconset/icon_256x256@2x.png
cp build/icon-512.png  build/icon.iconset/icon_512x512.png
cp "$SRC"              build/icon.iconset/icon_512x512@2x.png

echo "==> building .icns via iconutil"
iconutil -c icns build/icon.iconset -o build/icon.icns

rm -f build/icon.png
cp build/icon-512.png build/icon.png

echo "Done. build/icon.icns and build/icon.png ready."
