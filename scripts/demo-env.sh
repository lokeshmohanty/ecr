#!/usr/bin/env bash
# Builds a throwaway mail setup from fixtures/ and prints the env needed to
# run ecr-server against it. Never touches the real maildir.
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

echo "demo mail root: $DEMO/Mail"
echo "run the server with:"
echo "  HOME=$DEMO XDG_CONFIG_HOME=$DEMO/.config cargo run -p ecr-server -- serve --bind 127.0.0.1:8099"
