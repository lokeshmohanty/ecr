+++
title = "Releasing"
description = "How a release is cut, what CI produces, and what has to be true first."
weight = 6
+++

## Versioning

Semantic versioning. One version number for the whole workspace, set in
`[workspace.package]` in the root `Cargo.toml` and mirrored in
`shell/tauri.conf.json` and `web/package.json`.

Before v1.0.0 the HTTP API and the settings file format may change in a minor
release. Both freeze at v1.0.0. The roadmap in the [README](https://github.com/lokeshmohanty/ecr/blob/main/README.md#roadmap)
carries the markers for what each release must contain.

## Cutting a release

Everything is driven by an annotated tag matching `v*`. There is no manual
artifact building.

```bash
just release            # asks major/minor/patch and does all of it
just release patch      # the same, with the question answered
just release patch dry  # the plan and the notes, changing nothing
```

It refuses to start unless the tree is clean, on `main`, level with
`origin/main`, and the tag is free both locally and on the remote. Then it
shows the `## [Unreleased]` section — that text *is* the release body, so it is
read before anything runs, and an empty one is a hard stop. A `patch` carrying
an `Added`, `Changed` or `Removed` section asks again: the number is the only
warning a consumer gets before `nix flake update` moves them onto it.

After a confirmation it runs the gate, writes the release, and asks once more
before the push, because the push is the publication. Say no and it tells you
both how to finish and how to abandon; nothing has left the machine yet.

`ECR_RELEASE_SKIP_CHECK=1` skips `just check` and `just deny`. It says so
loudly, and it is a bad idea for the reason below: the tag is the gate.

What the recipe does, if you would rather do it by hand:

```bash
just check && just deny                 # the gate — must be green
$EDITOR CHANGELOG.md                    # move Unreleased into a dated section,
                                        # and point the link refs at the new tag
just release-version 0.2.0              # bumps Cargo.toml, tauri.conf.json, package.json
git commit -am "Release 0.2.0"
git tag -a v0.2.0 -m "Release 0.2.0"
$EDITOR CHANGELOG.md                    # reopen an empty ## [Unreleased], after the tag
git commit -am "Open the changelog for the next release"
git push origin main v0.2.0
```

The tag starts `.github/workflows/release.yml`, which:

1. Re-runs fmt, lint and both test suites. A tag does not skip verification.
2. Builds each artifact on its native runner.
3. Computes `SHA256SUMS` across all of them.
4. **Publishes** a GitHub release with the `CHANGELOG.md` section for that
   version as the body.
5. Publishes the crates to crates.io, in dependency order.

Nothing is left to press. Pushing the tag is the decision to release; a draft
is invisible to anyone without write access, so one left unpublished is a
release that silently never happened — which is what became of v0.2.0.

The gate is therefore the tag, not the publish. Everything before step 4 has to
be green for it to run at all, so `just check` on a clean tree is what stands
between a mistake and the public — verify before tagging, not after. Smoke-test
the artifacts once they are up; a bad one is withdrawn with a patch release,
which is what everyone who already downloaded it needs regardless.

## Artifacts

| Artifact | Built on | Contents |
|---|---|---|
| `ecr-x86_64-unknown-linux-gnu.tar.gz` | `ubuntu-22.04` | the `ecr` binary, the built web client, a man page, bash/zsh/fish completions and a systemd user unit |
| `ecr-aarch64-unknown-linux-gnu.tar.gz` | `ubuntu-22.04-arm` | as above, for arm64 |
| `ecr_<version>_amd64.deb` | `ubuntu-22.04` | desktop client, via `tauri build` |
| `ecr_<version>_amd64.AppImage` | `ubuntu-22.04` | desktop client, self-contained |
| `ecr-<version>.apk` | `ubuntu-latest` | Android client, for sideloading |
| `ecr-<version>.aab` | `ubuntu-latest` | the same build in the only format Play accepts |
| `SHA256SUMS` | `ubuntu-latest` | checksums for everything above |

The tarballs, `.deb` and AppImage are built on `ubuntu-22.04` deliberately:
glibc is forward-compatible, not backward, so building on the oldest supported
runner is what makes the artifacts work on newer distributions.

### Nix

The flake exposes `packages.{ecr,ecr-web,ecr-desktop}`, `nixosModules.default`
and `homeManagerModules.default`. No artifact is uploaded for these — a flake is
consumed from git directly.

Two channels are published, and the tag is what moves the stable one:

| Channel | Ref | Moved by |
|---|---|---|
| release | `github:lokeshmohanty/ecr/release` | the `release-branch` job, after every artifact for the tag has built |
| main | `github:lokeshmohanty/ecr` | every push to `main` |

The `release-branch` job fast-forwards `release` to the tagged commit. It is a
fast-forward rather than a force push on purpose: releases only move forward, so
a push that would rewrite history means the tag is wrong, and failing loudly is
the right answer. It runs after `tarball`, `desktop` and `android`: a tag whose build fails must
never become what everyone's `nix flake update` pulls.

It runs beside the `publish` job rather than after it. The flake is consumed
from git, not from an artifact, and the tag is already immutable.

`nix flake check` and `nix build .#ecr .#ecr-web .#ecr-desktop` run in CI on
every push, and CI pushes the results to `lokeshmohanty.cachix.org`, which
`flake.nix` advertises as a substituter. That cache is what makes the main
channel usable: without it every `nix flake update` is a full rebuild of the
server and the client. It needs a `CACHIX_AUTH_TOKEN` secret; without it the
push step is skipped and CI still passes, which is also what happens for pull
requests from forks.

See [installing.md](@/installing.md) for the consumer's side of this.

### crates.io

Published in dependency order, because each crate's path dependencies carry
explicit versions that must already exist on the registry:

```
ecr-core → ecr-store → ecr-server → ecr-cli
```

`shell` sets `publish = false`; a Tauri app is not useful as a crate.

This needs a `CARGO_REGISTRY_TOKEN` secret. Without it the job is skipped and the
rest of the release still completes.

## Android

The APK and AAB are built by `tauri android build` on `ubuntu-latest`, with the
Android SDK and NDK installed by the workflow rather than carried in the flake —
it is a large closure and nothing else needs it.

**The overlay is not optional.** `shell/gen/` is generated, gitignored and
regenerated by `cargo tauri android init --ci` on every run, so nothing edited
inside it survives. Everything this app needs that Tauri's template does not
provide lives in `shell/android/overlay/` and is copied over the generated tree
by `scripts/android-overlay.sh`, which runs after every `init` in both
workflows and in `just android`. It carries:

- the **network security config**. This is the one that matters. The gradle
  template sets `usesCleartextTraffic` false for release builds and true only
  for debug, and `just android` builds debug — so an APK that reaches
  `http://host:8383` throughout development cannot reach it at all once CI
  publishes a release build. ecr talks to a server the user runs at an address
  they type in, which can hold no public-CA certificate, so cleartext is
  permitted deliberately.
- the **launcher icon**, as an adaptive icon with a monochrome layer for Android
  13 themed icons. Without it the app ships wearing the Tauri logo.
- **backup and data-extraction rules**. The bearer token lives in the webview's
  localStorage and `allowBackup` defaults to true.
- the removal of the template's **AndroidTV** leanback entries.

- the **`mailto:` intent filter** and `POST_NOTIFICATIONS`, both of which are
  features the app implements rather than permissions it hoards.

The script asks who wrote the manifest in `gen/` before comparing anything: a
marker string in the overlay's own copy. Byte-comparing against the overlay is
not enough, because editing the overlay leaves `gen/` holding the *previous*
version of it, which matches neither the overlay nor upstream and would warn on
every build for no reason. When the marker is absent the file came from Tauri,
and it is diffed against `shell/android/upstream/AndroidManifest.xml` to catch
the template moving underneath an overlay that owns it outright. CI builds Android on every
push, so that warning surfaces there rather than at release time. When it fires:
review the diff, fold anything new into the overlay, and re-record the upstream
copy.

**Signing.** If the `ANDROID_KEYSTORE`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` secrets are set, the APK is signed
with them. If they are not, the workflow builds an unsigned APK and says so in
the release notes. An unsigned APK installs fine by sideloading; it cannot go to
Play Store, and its signature will not match a later signed build, so users would
have to uninstall before upgrading. Set the secrets before the first APK anyone
actually installs — v0.1.1 shipped before they were, and is unsigned.

The secrets alone are not what signs it. Tauri's generated
`app/build.gradle.kts` has no `signingConfigs` block and never reads
`keystore.properties`, so setting them used to write a file nothing consumed:
the workflow announced "APK will be signed." and produced
`app-universal-release-unsigned.apk` regardless. The signing config lives in
`shell/android/overlay/app/signing.gradle`, and `scripts/android-overlay.sh`
appends the `apply(from = …)` line that pulls it in — appended rather than
overlaid because the generated build file is a template full of substitutions.
Two gates keep that honest: CI builds a *release* APK signed with a throwaway
key on every push and fails if it comes out `-unsigned`, and the release job
refuses to ship an unsigned APK when the keystore secret is set.

Both are renamed before they are uploaded. Gradle names its output after the
*module*, so the APK and the AAB both arrive as `app-universal-release.*` —
which is what every other Android project's build is called too, and says
nothing about what the file is once it has left the release page. v0.2.2
shipped exactly that, beside four artifacts that do name themselves. The rename
happens after the `-unsigned` check, which is the assertion that name carries,
and it insists on finding exactly one of each: the build is universal rather
than split per ABI, so adding `--split-per-abi` later fails loudly here instead
of quietly collapsing three APKs into one name.

Generate a keystore once and keep it somewhere you will not lose it — losing it
means every existing install must be removed by hand before it can be upgraded:

```bash
keytool -genkey -v -keystore ecr.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias ecr
base64 -w0 ecr.jks    # the value for the ANDROID_KEYSTORE secret
```

Then set all four, so the alias and passwords match the ones just chosen:

```bash
gh secret set ANDROID_KEYSTORE < <(base64 -w0 ecr.jks)
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS          # `ecr`, from `-alias` above
gh secret set ANDROID_KEY_PASSWORD
```

**Where ecr's key actually is.** It was generated on 2026-08-03 — 4096-bit RSA,
alias `ecr`, valid to 2053 — and lives at `~/.local/share/ecr-signing/ecr.jks`,
outside the repository. The authoritative backup is in `pass`:

```bash
pass show android/ecr/keystore-base64 | tr -d '\n' | base64 -d > ecr.jks
pass show android/ecr/store-password
```

`android/ecr/key-password` and `android/ecr/key-alias` are there too. The store
and key passwords are deliberately identical: the keystore is PKCS12, which
supports only one password for both, and keytool *silently discards* a
different `-keypass` with a warning that is easy to miss — recording two
different values would mean gradle could not open the key.

A machine is not a backup. If `pass` and this machine are the same disk,
copy the store somewhere else as well.

### F-Droid

F-Droid builds and signs the app itself, from source, on its own infrastructure;
the APK it distributes is not the one CI produces here and carries a different
signature. Sideloaders cannot switch between the two without uninstalling.

The split is worth knowing:

- **This repository** carries the store page. `metadata/en-US/` holds the title,
  the descriptions and the images, and F-Droid reads it straight from the tag.
  Regenerate the images with `just store-metadata` — the icon comes from
  `figures/logo.svg` and the screenshots from the visual baselines, so the page
  cannot advertise a UI that no longer exists.
- **`fdroiddata`** carries the build recipe, which lives in F-Droid's own
  repository and is submitted as a merge request.
  `packaging/fdroid/dev.lokeshmohanty.ecr.yml` is the draft of that file, kept
  here so it stays next to the build it describes. It is not read from here.

Two things in the recipe are easy to get wrong: the web client has to be built
in `prebuild`, because `tauri::generate_context!` compiles it into the binary,
and `scripts/android-overlay.sh` has to run after `cargo tauri android init` or
the resulting APK cannot reach an http server and wears the Tauri logo. Run
`fdroid build dev.lokeshmohanty.ecr` locally before submitting; a recipe that
has never been run is a recipe that does not work.

`PRIVACY.md` is the policy the listing points at.

## Checklist

`just release` covers the mechanical half of this — the gate, the version in
all three manifests, the changelog section and its link refs. What is left is
what only a person can answer:

- [ ] `just check-all` run against real mail at least once since the last release
- [ ] The `## [Unreleased]` notes name user-visible changes rather than commits
- [ ] Roadmap markers in `README.md` reflect what actually shipped
- [ ] The migration path is documented if the settings file or API changed
- [ ] The number matches the change: a patch fixes, a minor adds or alters

After the workflow finishes — the release is already public by then:

- [ ] Download one artifact per platform and run it
- [ ] `sha256sum -c SHA256SUMS` passes
- [ ] Open a `## [Unreleased]` section in `CHANGELOG.md`
