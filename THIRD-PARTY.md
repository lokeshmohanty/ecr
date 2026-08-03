# Third-party notices

`ecr` itself is dual-licensed under [MIT](LICENSE-MIT) or [GPL-3.0-or-later](COPYING). This file records what else ships in, or is required by, a build,
and what each of those things obliges us to do.

Regenerate the dependency audit with:

```bash
just licenses      # cargo-license over the workspace, license-checker over web
```

## Bundled fonts — SIL Open Font License 1.1

Three webfonts are compiled into `web/dist` and therefore into every artifact we
distribute: the browser bundle, the `.deb`, the AppImage, the Android APK and the
desktop binary. OFL-1.1 requires that the licence travel with the font, so the
full text of each is kept in [`licenses/fonts/`](licenses/fonts/) and copied into
the built site at `/licenses/fonts/` by `web/vite.config.ts`.

| Font | Copyright | Licence |
|---|---|---|
| Space Grotesk | 2020 The Space Grotesk Project Authors | [OFL-1.1](licenses/fonts/space-grotesk-OFL-1.1.txt) |
| Nunito | 2014 The Nunito Project Authors | [OFL-1.1](licenses/fonts/nunito-OFL-1.1.txt) |
| Cascadia Code | Google Inc. / Microsoft Corporation | [OFL-1.1](licenses/fonts/cascadia-code-OFL-1.1.txt) |

OFL-1.1 also reserves the font names. A fork that *modifies* any of these font
files must rename them; using them unmodified, as we do, carries no such
obligation.

## Bundled SQLite — public domain, compiled in

`ecr-store` keeps a mail index in SQLite, and takes `rusqlite`'s `bundled`
feature: the SQLite amalgamation is compiled from C source into `ecr` rather
than linked against whatever the host provides. It is therefore *in* every
binary we distribute.

SQLite is released into the public domain by its authors and asks nothing of a
distributor — no notice, no attribution, no licence text to carry. It is named
here because a C library compiled into a shipped binary is exactly the kind of
thing this file exists to account for, not because it obliges anything.
`libsqlite3-sys`, the crate carrying the amalgamation and the bindings, is
MIT and is counted in the table below.

Bundling rather than linking is a deliberate choice: it keeps the tarball, the
`.deb` and the AppImage free of a `libsqlite3` dependency for a user to
satisfy, and it fixes the SQLite version the index is tested against rather
than inheriting whatever the host ships.

## External programs — GPL, invoked but not linked

`ecr-store` drives three GPL programs by running them as separate processes and
speaking to them over argv, stdin/stdout and the filesystem:

| Program | Licence | Invoked from |
|---|---|---|
| `notmuch` | GPL-3.0-or-later | `crates/ecr-store/src/notmuch/mod.rs` |
| `mbsync` (isync) | GPL-2.0-or-later | `crates/ecr-store/src/mbsync.rs` |
| `msmtp` | GPL-3.0-or-later | `crates/ecr-store/src/msmtp.rs` |

Running a GPL program as a subprocess does not make the caller a derivative work,
so this imposes no licence obligation on `ecr`. We do not link `libnotmuch`, we do
not redistribute any of these binaries, and we do not embed their source.

> **Still a deliberate choice, no longer a licensing one.** Now that `ecr`
> offers GPL-3.0-or-later, linking `libnotmuch` would no longer force a
> relicensing — GPL into GPL is fine. It is still not done: `ecr` speaks to
> notmuch as a subprocess, and `deny.toml` keeps the dependency tree
> permissive-only by choice, so a GPL crate entering it still fails CI. Moving
> to `libnotmuch` is a design change to weigh on its own merits, not something a
> dependency update should slip in.
>
> The mail index is shaped by that subprocess model. It is fed by parsing the
> output of `notmuch show` and `notmuch search`, which is why it carries headers
> rather than reading Xapian, and why `notmuch` remains the only writer of mail
> state. The obvious faster design — open the database through `libnotmuch` — is
> the one thing above.

## System libraries — dynamically linked

The desktop shell links WebKitGTK, GTK 3 and libsoup (LGPL-2.1 / LGPL-2.0 / BSD)
dynamically, through Tauri. LGPL permits dynamic linking from a GPL program provided the user can substitute their own build of the library,
which dynamic linking satisfies. No LGPL source is redistributed.

## Rust dependencies

518 crates (excluding build-only dependencies), all usable under a permissive
licence. `deny.toml` holds a closed allowlist and fails CI if anything outside it
appears.

| Licence | Crates |
|---|---|
| Apache-2.0 OR MIT | 312 |
| MIT | 125 |
| Apache-2.0 OR MIT OR Zlib | 20 |
| Unicode-3.0 | 18 |
| MIT OR Unlicense | 7 |
| MPL-2.0 | 6 |
| Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT | 5 |
| ISC | 3 |
| BSD-3-Clause | 3 |
| Apache-2.0 | 3 |
| other permissive combinations | 16 |

No crate is copyleft-only. Two crates (`r-efi`) offer LGPL-2.1-or-later as one
arm of a three-way choice; we take the MIT arm, as `deny.toml` records by not
allowing LGPL at all.

Three of these carry obligations worth naming:

**MPL-2.0** (`cssparser`, `cssparser-macros`, `selectors`, `dtoa-short`,
`option-ext`) is file-level copyleft: modifications *to those files* must be
published under MPL-2.0. We consume all five unmodified as registry crates, so
the obligation is satisfied by this notice and by the source remaining available
at each crate's repository.

**Unicode-3.0** (the ICU crates, `unicode-ident`) requires its notice be
reproduced in distributions that include the data. The text is at
<https://www.unicode.org/license.txt> and travels with each crate's source.

**CC0-1.0** (`notify`) is a public-domain dedication and asks nothing of us. It
is named here only so the table above does not look like an omission.

**CDLA-Permissive-2.0** (`webpki-root-certs`) covers Mozilla's CA certificate
set, which arrives through reqwest's platform verifier now that `ecr oauth`
speaks TLS. It is a licence for *data*, not code: it permits use and
redistribution with no obligation to publish anything in return, and states
that it imposes no conditions on software that merely uses the data. Shipping
the certificates is what any TLS client does.

## Web dependencies

Six runtime packages ship in the bundle:

| Package | Licence |
|---|---|
| `solid-js` | MIT |
| `@solidjs/router` | MIT |
| `smol-toml` | BSD-3-Clause |
| `@fontsource-variable/space-grotesk` | OFL-1.1 (see above) |
| `@fontsource-variable/nunito` | OFL-1.1 (see above) |
| `@fontsource-variable/cascadia-code` | OFL-1.1 (see above) |

Build-time packages (Vite, Tailwind, Vitest, Playwright, TypeScript) are MIT,
Apache-2.0 or ISC and are not redistributed.

## Mail fixtures

Every `.eml` under `fixtures/` is synthetic and written for this repository. All
addresses are `@example.com` per RFC 2606. No real message, and no real person's
address, is included.
