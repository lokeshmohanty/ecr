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
| Push | A maildir watcher, plus an IMAP IDLE connection ecr holds itself for managed accounts — no imapnotify, no supervisor |
| Sending | Direct SMTP for a managed account; msmtp for a self-managed one |
| Message previews | The first line of each message under its subject, filled behind the server |
| Account setup | `ecr account add` or the Accounts tab, when ecr manages the configuration |
| Signed and encrypted mail | Verified and opened through your own `gpg`. ecr keeps no keys of its own |
| A send queue | Everything sent goes through it, so undo is the default rather than a feature to find |

## What is missing, and where it is going

| | Status |
|---|---|
| **Filters and rules** | **Here**, for a managed setup. Rules live in `accounts.toml`, are edited on the Accounts tab, and are rendered into the `post-new` hook. They run top to bottom against new mail only |
| **Signatures** | **Here**, per account and per alias. An alias with an empty signature has deliberately none rather than inheriting |
| **Multiple identities and aliases per account** | **Here**. A reply goes out as the address it was addressed to, the composer picks where there is a choice, and the server refuses a `From:` the account does not own |
| **Templates and canned replies** | **Here**. Named in the settings file with an optional subject; the composer offers them as chips. Inserting one *appends*, because somebody who has typed half a reply and then reaches for a template means to add to it |
| **Send later, undo send** | **Here**, and they were one feature all along: everything goes through a queue in `~/.local/state/ecr/outbox`, held ten seconds by default. Undo is deleting a file. A send that failed because the laptop was in a tunnel stays there with its reason, backing off, rather than being lost. Snooze is still missing |
| **Address book and autocomplete** | **Here**. `ecr account sync-dav` fetches CardDAV into a vdir and those contacts join completion, after the addresses gathered from mail rather than above them |
| **Calendar and invitations** | **Here**. An invitation is rendered where the message is — summary, time, location, organiser — a cancellation says so, and accept/decline/tentative sends a conforming `METHOD:REPLY`. A reply to one occurrence of a repeating event needs a `RECURRENCE-ID` and is refused without one, because a reply without it answers the whole series |
| **Junk handling** | Partly. A `spam` tag exists and is excluded from search; there is no classifier and no *report as spam* |
| **Folder management** | Partly. Tags and folders are kept in step: a `pre-new` hook files `deleted` into Trash and `spam` into Junk, and archiving moves a message out of the inbox folder — so archiving and deleting in ecr now reach the *server* on the next sync, which they did not before. Gmail is the exception and deliberately so: its archive is `[Gmail]/All Mail`, a copy of every message ecr does not sync, so there is nowhere to file to and archiving stays local. Creating, renaming and subscribing to IMAP folders is still mbsync's job |
| **Marks reaching the server** | `read`, `flagged` and `replied` always did — notmuch keeps them as maildir flags and mbsync sends them. `archive` and `delete` had no flag to live in and stopped at a local tag; they file now, and `ecr doctor` says which of the two states an account is in rather than leaving it to be discovered |
| **Unified inbox** | **Here**. An *All inboxes* row is pinned above the accounts, carrying its own count. Per-account colouring is deliberately absent: the palette's three accents mean proved, owed and blocking, and spending them on identity makes every row look like a status it does not have |
| **Vacation responder** | **Here**, for a managed setup. `ecr account vacation on`. It will not answer mailing lists, bounces, other autoresponders, your own addresses, mail you were only Bcc'd on, or the same person twice in a week — that refusal list is the feature, and it is what a responder without one costs everybody you are subscribed with |
| **OpenPGP** | **Here** for reading, through your own `gpg`. Signatures are verified and encrypted mail is opened, with six states rather than a padlock — `unknown` is the ordinary condition of mail from a stranger and is not shown as broken. ecr keeps no keys: GnuPG already has the keyring, the agent and your web of trust, and a second copy of a private key is a worse thing than a missing feature. Signing and encrypting outgoing mail is here too — three toggles in the composer, shown only when the server has a gpg. S/MIME is missing |
| **Read receipts** | Deliberately missing. Requesting one is a tracker with a standards document |
| **Offline** | Partly, and the browser is the least of it — the desktop and Android clients hold a server address rather than a cache, so an unreachable server means no mail there whatever the browser does. The browser client now **boots** without a network and shows its own account of the outage rather than the browser's error page. It caches the application and deliberately no mail: a cached thread list looks current and is not, and every API response is somebody's mail written to disk in the browser profile. Reading mail offline is the desktop and Android clients' job — their server is on the same device and its maildir is local |
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
