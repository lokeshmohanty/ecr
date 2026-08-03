#!/usr/bin/env bash
# Lay ecr's own Android files over the tree `cargo tauri android init` generates.
#
# shell/gen/ is disposable — it is gitignored, `just android` regenerates it when
# it is missing and CI regenerates it on every run — so nothing edited in place
# there survives. The manifest changes this app needs are not optional (see
# shell/android/overlay/app/src/main/AndroidManifest.xml for what they are and
# why), so they live in git as an overlay and are copied on top after every init.
#
# Idempotent: run it as often as you like.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEN="$ROOT/shell/gen/android"
OVERLAY="$ROOT/shell/android/overlay"
UPSTREAM="$ROOT/shell/android/upstream"

if [ ! -d "$GEN" ]; then
  echo "no shell/gen/android: run \`cargo tauri android init\` first" >&2
  exit 1
fi

# The overlay owns the manifest outright rather than patching it, which is only
# safe as long as we notice when Tauri's template changes underneath. Compare
# what init just wrote against the copy recorded when the overlay was written:
# a difference means the template moved and the overlay may be missing something
# new — a permission, a provider, an activity attribute.
#
# Ask who wrote the file in gen/ before comparing anything. This script runs on
# every build, not only after an init, so most of the time that file is one this
# script put there — and comparing *that* against upstream reports our own
# changes as Tauri's. Matching it against the current overlay byte for byte is
# not enough either: editing the overlay leaves gen/ holding the previous
# version of it, which matches neither side and warns for no reason.
#
# The marker is the honest question. Anything carrying it came from here.
MARKER="ecr's manifest."
generated="$GEN/app/src/main/AndroidManifest.xml"
recorded="$UPSTREAM/AndroidManifest.xml"
if [ -f "$generated" ] && [ -f "$recorded" ] && ! grep -qF "$MARKER" "$generated"; then
  if ! diff -q "$recorded" "$generated" > /dev/null 2>&1; then
    echo "warning: tauri's generated AndroidManifest.xml no longer matches" >&2
    echo "         shell/android/upstream/AndroidManifest.xml. Review the diff," >&2
    echo "         fold anything new into shell/android/overlay/, then re-record:" >&2
    echo >&2
    diff -u "$recorded" "$generated" >&2 || true
    echo >&2
    echo "         cp '$generated' '$recorded'" >&2
    echo >&2
  fi
fi

# `cp -r a/. b/` merges rather than nesting, and leaves everything the overlay
# does not mention alone.
#
# The launcher icon is part of this. Tauri's template ships its own logo as
# plain bitmaps and no adaptive icon at all; the overlay replaces the bitmaps
# and adds mipmap-anydpi-v26, so API 26 and up — which is every device, minSdk
# being 28 — get the vector adaptive icon with a monochrome layer for themed
# icons. Without the overlay the app wears the Tauri logo.
cp -r "$OVERLAY/." "$GEN/"

# `app/build.gradle.kts` is the one file the overlay cannot own: it is a
# Handlebars template and the generated copy carries substitutions — the
# identifier, the ABI list, the min SDK — that a static copy would freeze.
# Appending one line adds the signing config without owning anything, and the
# grep makes it idempotent for the runs where gen/ already carries it.
gradle="$GEN/app/build.gradle.kts"
apply_line='apply(from = "signing.gradle")'
if [ -f "$gradle" ] && ! grep -qF "$apply_line" "$gradle"; then
  printf '\n%s\n' "$apply_line" >> "$gradle"
fi

echo "android overlay applied to shell/gen/android"
