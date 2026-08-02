#!/usr/bin/env bash
# Regenerate the images F-Droid shows on the app's page.
#
# F-Droid reads `metadata/en-US/` straight out of this repository, so the images
# have to be committed files rather than something built at release time. They
# are still *generated*: the icon comes from figures/logo.svg and the
# screenshots from the visual-regression baselines, so the page cannot end up
# advertising a version of the UI that no longer exists.
#
# Re-run this after `just visual --approve` changes what the client looks like.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v rsvg-convert > /dev/null; then
  echo "rsvg-convert is not on PATH; enter the dev shell with \`nix develop\`" >&2
  exit 1
fi

OUT=metadata/en-US/images
SHOTS="$OUT/phoneScreenshots"
mkdir -p "$SHOTS"

rsvg-convert -w 512 -h 512 figures/logo.svg -o "$OUT/icon.png"
rsvg-convert -w 1024 -h 500 figures/feature-graphic.svg -o "$OUT/featureGraphic.png"

# The phone states, in the order someone meeting the app should see them. Every
# one is a real render at a real device's CSS viewport, against the fixture
# maildir — never anybody's actual mail.
i=1
for shot in 16-mobile-list 17-mobile-detail 24-mobile-sidebar 26-mobile-compose 28-mobile-actions; do
  source="screenshots/visual/baseline/$shot.png"
  if [ ! -f "$source" ]; then
    echo "missing baseline $source; run \`just visual\` first" >&2
    exit 1
  fi
  cp "$source" "$(printf '%s/%02d-%s.png' "$SHOTS" "$i" "${shot#*-}")"
  i=$((i + 1))
done

echo "store metadata images regenerated into $OUT"
