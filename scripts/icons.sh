#!/usr/bin/env bash
# Regenerate every raster icon from figures/logo.svg.
#
# The SVG is the source of truth. Nothing here should ever be edited by hand:
# the desktop icons, the README mark and the Android launcher bitmaps all come
# out of the same two files, so the app cannot end up wearing three different
# logos on three platforms.
#
# The Android *adaptive* icon is not generated — it is a pair of vector
# drawables under shell/android/overlay, carrying the same geometry in Android's
# own XML. Only the pre-API-26 fallback bitmaps are rasterised here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v rsvg-convert > /dev/null; then
  echo "rsvg-convert is not on PATH; enter the dev shell with \`nix develop\`" >&2
  exit 1
fi

render() { # svg size out
  mkdir -p "$(dirname "$3")"
  rsvg-convert -w "$2" -h "$2" "$1" -o "$3"
}

# Tauri reads these four names out of shell/tauri.conf.json, and the Nix desktop
# package installs them into hicolor.
render figures/logo.svg 32 shell/icons/32x32.png
render figures/logo.svg 128 shell/icons/128x128.png
render figures/logo.svg 256 'shell/icons/128x128@2x.png'
render figures/logo.svg 512 shell/icons/icon.png

# The web app manifest's icons, so the browser client can be installed.
#
# Two purposes and they are not interchangeable. `any` is drawn as given, so it
# keeps logo.svg's own rounded corners; `maskable` is drawn inside whatever
# shape the platform picks, so it comes from the full-bleed variant with the
# artwork inset to the safe zone. Shipping only one means either a squircle
# inside a circle or a logo with its corners cut off.
render figures/logo.svg 192 web/public/icons/icon-192.png
render figures/logo.svg 512 web/public/icons/icon-512.png
render figures/logo-maskable.svg 512 web/public/icons/maskable-512.png

# The README's header mark, at 2x for HiDPI.
render figures/logo.svg 160 figures/logo.png

# Android's pre-26 launcher bitmaps. API 26 and up take the adaptive icon in
# mipmap-anydpi-v26 instead; minSdk is 28, so in practice every current device
# uses the vectors and these exist for the manifest to resolve against.
android=shell/android/overlay/app/src/main/res
for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  density="${pair%%:*}"
  size="${pair##*:}"
  render figures/logo.svg "$size" "$android/mipmap-$density/ic_launcher.png"
  render figures/logo-round.svg "$size" "$android/mipmap-$density/ic_launcher_round.png"
  render figures/logo-mono.svg "$size" "$android/mipmap-$density/ic_launcher_foreground.png"
done

echo "icons regenerated from figures/logo.svg"
