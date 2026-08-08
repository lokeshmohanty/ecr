//! The server's half of a settings file written in TypeScript.
//!
//! `data/settings.generated.toml` is produced by `toToml` in
//! `web/src/state/settings/toml.ts` and pinned there by
//! `web/src/state/settings/fixture.test.ts`. There is no shared schema between
//! the two languages — the file is generated from `PREFERENCE_DOCS` — so this is
//! what stops the generator from moving somewhere `packages.rs` cannot follow.
//!
//! The failure being prevented is a quiet one: a `[packages.*]` section the
//! server cannot parse reads as every package being self-managed, which is
//! managed mode switching itself off with nothing on screen to say so.

use ecr_core::doctor::ConfigKind;
use ecr_store::packages::{Management, Packages};

const GENERATED: &str = ecr_store::packages::DEFAULT_SETTINGS;

#[test]
fn the_generated_settings_file_parses() {
    let packages = Packages::parse(GENERATED);

    for kind in [ConfigKind::Notmuch, ConfigKind::Mbsync, ConfigKind::Msmtp] {
        assert_eq!(
            packages.management(kind),
            Management::SelfManaged,
            "a fresh settings file must leave {kind} alone"
        );
    }
    assert!(!packages.any_managed());
}

/// The switch has to survive the round trip it is actually made through: the
/// settings page edits one value and leaves every other byte of the file alone.
#[test]
fn a_package_switched_to_ecr_in_the_generated_file_is_read_back() {
    let switched = GENERATED.replacen(
        "[packages.mbsync]\nmanagement = \"self\"",
        "[packages.mbsync]\nmanagement = \"ecr\"",
        1,
    );
    assert_ne!(switched, GENERATED, "the fixture no longer has that shape");

    let packages = Packages::parse(&switched);
    assert!(packages.is_managed(ConfigKind::Mbsync));
    assert!(!packages.is_managed(ConfigKind::Msmtp));
    assert!(packages.any_managed());
}
