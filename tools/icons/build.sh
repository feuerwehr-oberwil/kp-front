#!/usr/bin/env bash
# Rasterize the SVG icon masters in this dir to the PWA PNGs in public/icons/.
# Requires rsvg-convert (brew install librsvg). Run from the repo root: bash tools/icons/build.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/../../public/icons"

rsvg-convert -w 192 -h 192 "$here/appicon-rounded.svg"  -o "$out/icon-192.png"
rsvg-convert -w 512 -h 512 "$here/appicon-rounded.svg"  -o "$out/icon-512.png"
rsvg-convert -w 512 -h 512 "$here/appicon-maskable.svg" -o "$out/icon-maskable-512.png"
rsvg-convert -w 180 -h 180 "$here/appicon-apple.svg"    -o "$out/apple-touch-icon.png"
echo "icons rebuilt → $out"
