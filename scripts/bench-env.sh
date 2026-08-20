#!/usr/bin/env bash
# A demo maildir with enough mail in it to measure against.
#
# `demo-env.sh` builds six threads, which is the right size for a baseline and
# useless for a stopwatch: a list that fits on screen never virtualises, never
# scrolls, and never shows what holding `j` costs. This is the same setup with
# a few thousand generated messages behind it.
#
#   scripts/bench-env.sh /tmp/ecr-bench 2000
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="${1:-/tmp/ecr-bench}"
COUNT="${2:-2000}"

"$ROOT/scripts/demo-env.sh" "$DEMO" > /dev/null

CUR="$DEMO/Mail/main/Inbox/cur"

# Spread over a year so the list has day headings in it, and vary the subject
# length so the date column measurement has something to chew on. Every tenth
# message answers the one before it, so threads of more than one exist.
python3 - "$CUR" "$COUNT" <<'PY'
import sys, os, random
cur, count = sys.argv[1], int(sys.argv[2])
random.seed(7)

WORDS = """quarterly review deployment pipeline invoice renewal standup notes
patch series regression triage release candidate onboarding schedule incident
postmortem migration rollout budget approval interview feedback""".split()

base = 1_745_000_000
for i in range(count):
    when = base + i * 900
    subject = " ".join(random.sample(WORDS, random.randint(2, 9)))
    parent = f"<bench-{i - 1}@example.com>" if i % 10 else None
    headers = [
        f"From: Sender {i % 37} <sender{i % 37}@example.com>",
        "To: test@example.com",
        f"Subject: {subject}",
        f"Message-Id: <bench-{i}@example.com>",
        f"Date: {__import__('email.utils', fromlist=['x']).formatdate(when)}",
        "MIME-Version: 1.0",
        'Content-Type: text/html; charset=utf-8',
    ]
    if parent:
        headers.append(f"In-Reply-To: {parent}")
        headers.append(f"References: {parent}")

    # Every fifth message is the kind real mail is full of: a marketing layout
    # of nested tables and inline styles, tens of kilobytes of it. A benchmark
    # over nothing but short notes measures a mailbox nobody has.
    if i % 5 == 0:
        rows = "".join(
            f'<tr><td style="padding:8px;border:1px solid #ddd;font-family:Arial">'
            f'{" ".join(random.sample(WORDS, 6))}</td>'
            f'<td style="padding:8px;background:#f4f4f4">{" ".join(random.sample(WORDS, 4))}</td></tr>'
            for _ in range(120)
        )
        body = f'<table width="600" cellpadding="0" cellspacing="0">{rows}</table>'
    else:
        body = "".join(
            f"<p>{' '.join(random.sample(WORDS, 8))}</p>" for _ in range(random.randint(2, 12))
        )
    raw = "\r\n".join(headers) + "\r\n\r\n" + f"<html><body><h1>{subject}</h1>{body}</body></html>\r\n"
    with open(os.path.join(cur, f"bench-{i}:2,"), "w") as handle:
        handle.write(raw)
print(f"wrote {count} messages", file=sys.stderr)
PY

env -u NOTMUCH_CONFIG -u NOTMUCH_PROFILE -u MBSYNCRC \
  NOTMUCH_CONFIG="$DEMO/.config/notmuch/default/config" notmuch new --quiet

echo "$DEMO"
