#!/usr/bin/env bash
# Builds a throwaway mail setup from fixtures/ and prints the env needed to
# run the server against it. Never touches the real maildir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="${1:-/tmp/ecr-demo}"

# Only ever remove a directory this script created, so pointing it at a path
# that holds anything else fails loudly instead of deleting it.
if [ -e "$DEMO" ] && [ ! -e "$DEMO/.ecr-demo" ]; then
  echo "refusing to overwrite $DEMO: not a demo directory this script created" >&2
  exit 1
fi
rm -rf "$DEMO"
mkdir -p "$DEMO"
touch "$DEMO/.ecr-demo"
mkdir -p "$DEMO"/Mail/main/{Inbox,Archive,Sent}/{cur,new,tmp}
mkdir -p "$DEMO"/.config/{notmuch/default/hooks,msmtp}

for source in "$ROOT"/fixtures/maildir/cur "$ROOT"/fixtures/mime; do
  for file in "$source"/*.eml; do
    [ -e "$file" ] || continue
    cp "$file" "$DEMO/Mail/main/Inbox/cur/$(basename "${file%.eml}"):2,"
  done
done

cat > "$DEMO/.config/notmuch/default/config" <<EOF
[database]
path=$DEMO/Mail

[user]
name=Demo User
primary_email=test@example.com

[new]
tags=unread;inbox

[search]
exclude_tags=deleted;spam

# List-Id is not a searchable prefix in stock notmuch, so the sidebar's mailing
# list rows would match nothing without this. Defining it here is what lets the
# fixture database exercise them.
[index]
header.List=List-Id
EOF

cat > "$DEMO/.config/notmuch/default/hooks/post-new" <<'EOF'
#!/bin/sh
notmuch tag --batch <<TAGS
+main -- tag:new
-new -- tag:new
TAGS
EOF
chmod +x "$DEMO/.config/notmuch/default/hooks/post-new"

cat > "$DEMO/.config/isyncrc" <<EOF
IMAPAccount main
User test@example.com

IMAPStore main-remote
Account main

MaildirStore main-local
Inbox $DEMO/Mail/main/Inbox
Path $DEMO/Mail/main/

Channel main
Far :main-remote:
Near :main-local:
EOF

cat > "$DEMO/.config/msmtp/config" <<EOF
account main
from test@example.com
account default : main
EOF

NOTMUCH_CONFIG="$DEMO/.config/notmuch/default/config" notmuch new --quiet

# Whatever serves this directory must be run with NOTMUCH_CONFIG, NOTMUCH_PROFILE
# and MBSYNCRC *stripped* — `env -u NOTMUCH_CONFIG -u NOTMUCH_PROFILE -u MBSYNCRC`
# — and not merely with HOME and XDG_CONFIG_HOME pointed here.
#
# `ecr_store::paths` puts the env var ahead of the XDG path, correctly: someone
# who exports NOTMUCH_CONFIG means it. But the dev shell exports it, so a suite
# that only overrides HOME inherits the developer's *real* config, indexes their
# real maildir and renders it. That is how `just visual` came to compare 31
# baselines against a live inbox — every state differing, none of it about the
# UI — and `just verify-marks` writes tags, so the same gap could have tagged
# real mail.

echo "demo mail root: $DEMO/Mail"
echo "run the server with:"
echo "  HOME=$DEMO XDG_CONFIG_HOME=$DEMO/.config cargo run -p ecr-cli -- serve --bind 127.0.0.1:8099"
