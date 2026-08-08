+++
title = "Parity"
description = "What ecr has, what it does not, and what is deliberately missing, against Thunderbird, Gmail and Outlook."
weight = 7
+++

A list of what a daily mail client is expected to do, and where ecr stands on
each. It exists so that "ecr cannot do X" has an answer that is either *yes, and
here is where it is planned* or *no, and here is why not* — rather than silence.

Nothing here is a promise about when. The ordering is by how much the absence is
felt, not by how hard it is.

## What is here

| | |
|---|---|
| Threaded conversations, search | notmuch's, which is the best of any client on this list. Any notmuch query works, and the sidebar is made of them |
| Tags, staged before writing | `Space` picks, `d`/`a`/`u`/`f`/`t` stage, `x` writes. What is about to happen is readable first, which no other client on this list does |
| Multiple accounts | Discovered from the maildir. Replies pick the identity from the message's tags, never the first account |
| Compose, reply, attachments | Labelled rows rather than a header buffer, vim editing throughout, attachments up to 25MB |
| HTML mail, safely | Sanitised server-side, remote images blocked until asked for, no script ever runs |
| Reading cursor | Motions, visual mode, `/` and `y` over the rendered message — over HTML as well as plain text |
| Saved searches | `S` names whatever the list is showing; they live on the device |
| Mailing lists | A sidebar section, gathered from `List-Id` headers |
| `mailto:` links | Registered on desktop and Android; a link anywhere opens a prefilled draft here |
| Themes | Ten presets, and a TOML file for your own |
| Phone | Swipe to archive or flag, long-press to select, an action bar, and a plain textarea composer because a soft keyboard is not a keyboard |
| Push | A maildir watcher, so mail delivered by anything appears without a poll |
| Account setup | `ecr account add` or the Accounts tab, when ecr manages the configuration |

## What is missing, and where it is going

| | Status |
|---|---|
| **Filters and rules** | Missing. notmuch's `post-new` hook is where these belong, and managed mode already generates one — rules would be entries in `accounts.toml` rendered into it |
| **Signatures** | Missing. Belongs with the account model, per identity |
| **Multiple identities and aliases per account** | Missing. `ManagedAccount` holds one address; send-as needs a list, and the composer needs a picker |
| **Templates and canned replies** | Missing |
| **Snooze, send later, undo send** | Missing, and all three are one feature: a send queue with a scheduled time. Undo send is a queue with a delay before it drains |
| **Address book and autocomplete** | Partly. Addresses are gathered from the mail already; real contacts arrive with CardDAV |
| **Calendar and invitations** | Missing. `text/calendar` parts are not rendered and RSVP does nothing. Planned over CalDAV, in process, with no external sync tool |
| **Junk handling** | Partly. A `spam` tag exists and is excluded from search; there is no classifier and no *report as spam* |
| **Folder management** | Missing. ecr tags; it cannot create, rename or subscribe to an IMAP folder, and cannot move a message between maildirs |
| **Unified inbox** | Partly. `tag:inbox` across accounts already is one, but there is no first-class row for it and no per-account colouring |
| **Vacation responder** | Missing, and probably belongs on the server rather than here |
| **PGP and S/MIME** | Missing. Verification before signing, if ever |
| **Read receipts** | Deliberately missing. Requesting one is a tracker with a standards document |
| **Offline** | Missing for the browser client. The desktop and Android clients hold a server address, not a cache — with no server reachable there is no mail |
| **Print and export** | Missing. The maildir is the export, and it is a better one than any client's |

## What is deliberately not planned

**Remote content by default.** Images load when asked for, per message. This is
the single most effective tracker in mail and turning it on by default is how
every other client on this list leaks that a message was opened.

**A rendering engine that runs sender code.** The message frame is sandboxed
without `allow-scripts`, and the reading cursor works by the *parent* reaching
into the document rather than by anything running inside it. No feature is worth
reversing that.

**Ads, sponsored rows, or a "focused" inbox that hides mail.** The query decides
what is on screen, and it is written down where you can read it.

**A cloud service.** ecr is a server you run. There is nowhere to send your mail
and no account to make.
