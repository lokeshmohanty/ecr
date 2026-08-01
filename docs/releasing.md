# Releasing

How a release is cut, what CI produces, and what has to be true first.

## Versioning

Semantic versioning. One version number for the whole workspace, set in
`[workspace.package]` in the root `Cargo.toml` and mirrored in
`shell/tauri.conf.json` and `web/package.json`.

Before v1.0.0 the HTTP API and the settings file format may change in a minor
release. Both freeze at v1.0.0. The roadmap in the [README](../README.md#roadmap)
carries the markers for what each release must contain.

## Cutting a release

Everything is driven by an annotated tag matching `v*`. There is no manual
artifact building.

```bash
just check                              # the gate — must be green
$EDITOR CHANGELOG.md                    # move Unreleased into a dated section
just release-version 0.2.0              # bumps Cargo.toml, tauri.conf.json, package.json
git commit -am "Release 0.2.0"
git tag -a v0.2.0 -m "Release 0.2.0"
git push origin main v0.2.0
```

The tag starts `.github/workflows/release.yml`, which:

1. Re-runs the full test suite. A tag does not skip verification.
2. Builds each artifact on its native runner.
3. Computes `SHA256SUMS` across all of them.
4. Creates a **draft** GitHub release with the `CHANGELOG.md` section for that
   version as the body.
5. Publishes the crates to crates.io, in dependency order.

The release is left as a draft on purpose. Download at least one artifact and run
it before pressing publish — CI proves the build succeeded, not that it works.

## Artifacts

| Artifact | Built on | Contents |
|---|---|---|
| `ecr-x86_64-unknown-linux-gnu.tar.gz` | `ubuntu-latest` | the `ecr` binary and the built web client |
| `ecr-aarch64-unknown-linux-gnu.tar.gz` | `ubuntu-24.04-arm` | as above, for arm64 |
| `ecr_<version>_amd64.deb` | `ubuntu-latest` | desktop client, via `tauri build` |
| `ecr_<version>_amd64.AppImage` | `ubuntu-latest` | desktop client, self-contained |
| `ecr-<version>.apk` | `ubuntu-latest` | Android client |
| `SHA256SUMS` | `ubuntu-latest` | checksums for everything above |

The `.deb` and AppImage are built on `ubuntu-22.04` deliberately: glibc is
forward-compatible, not backward, so building on the oldest supported runner is
what makes the artifact work on newer distributions.

### Nix

The flake exposes `packages.ecr`, `packages.ecr-desktop` and
`nixosModules.default`. Nothing is uploaded for these — a flake is consumed from
the git tag directly:

```bash
nix run github:lokeshmohanty/ecr/v0.2.0
```

`nix flake check` runs in CI on every push, so a tag that builds is a tag Nix
users can consume.

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

The APK is built by `tauri android build` on `ubuntu-latest`, with the Android
SDK and NDK installed by the workflow rather than carried in the flake — it is a
large closure and nothing else needs it.

**Signing.** If the `ANDROID_KEYSTORE`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` secrets are set, the APK is signed
with them. If they are not, the workflow builds an unsigned APK and says so in
the release notes. An unsigned APK installs fine by sideloading; it cannot go to
Play Store, and its signature will not match a later signed build, so users would
have to uninstall before upgrading. Set the secrets before the first APK anyone
actually installs.

Generate a keystore once and keep it somewhere you will not lose it — losing it
means every existing install must be removed by hand before it can be upgraded:

```bash
keytool -genkey -v -keystore ecr.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias ecr
base64 -w0 ecr.jks    # the value for the ANDROID_KEYSTORE secret
```

## iOS

The iOS job compiles on `macos-latest` and produces an unsigned build. It exists
to catch bitrot, not to ship: `-CODE_SIGNING_ALLOWED=NO` means the output cannot
be installed on a device.

Making it shippable needs, in order:

1. An Apple Developer Program membership (currently $99/year). There is no free
   path to distributing an iOS app to other people.
2. A distribution certificate and a provisioning profile, held as repository
   secrets along with an App Store Connect API key.
3. A signing and upload step in the iOS job.

The client would also need to be told it cannot host a server: `ecr-server`
shells out to `notmuch`, `mbsync` and `msmtp`, none of which exist on iOS. An iOS
build is a thin client pointing at a server elsewhere, and its first-run
experience has to say so rather than offering a `doctor` that can never pass.

This is tracked as a v1.0.0 item and is not close.

## Checklist

Before tagging:

- [ ] `just check` green on a clean tree
- [ ] `just check-all` run against real mail at least once since the last release
- [ ] `CHANGELOG.md` has a section for this version, and it names user-visible
      changes rather than commits
- [ ] Roadmap markers in `README.md` reflect what actually shipped
- [ ] `just deny` clean — no new licence entered the tree unnoticed
- [ ] Version bumped in all three manifests
- [ ] The migration path is documented if the settings file or API changed

After the workflow finishes:

- [ ] Download one artifact per platform and run it
- [ ] `sha256sum -c SHA256SUMS` passes
- [ ] Publish the draft
- [ ] Open a `## [Unreleased]` section in `CHANGELOG.md`
