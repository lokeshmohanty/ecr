//! The loop that has to close: accounts in, accounts out.
//!
//! `ecr account add` writes `accounts.toml`; the renderers turn it into
//! configuration; `MailPaths` resolves that configuration; the *existing*
//! parsers read it; and `discovery::accounts` answers what accounts exist. If
//! any link in that chain drifts, an account the reader added is one ecr cannot
//! see — and every symptom of that is somewhere else entirely: no mail, a
//! doctor failure about a maildir, a reply from the wrong address.
//!
//! So this test does not inspect a rendered file. It renders, applies, and then
//! asks ecr what it can see, exactly the way the server does.

use ecr_core::doctor::ConfigSource;
use ecr_core::managed::{Auth, Endpoint, ManagedAccount, ManagedAccounts, Provider};
use ecr_store::managed::accounts::{apply, Accounts};
use ecr_store::packages::Packages;
use ecr_store::paths::{Env, MailPaths};
use ecr_store::settings::ServerSettings;
use ecr_store::{discovery, managed};
use std::path::Path;

fn managed_packages() -> Packages {
    Packages::parse(
        "[packages.notmuch]\nmanagement = \"ecr\"\n\
         [packages.mbsync]\nmanagement = \"ecr\"\n\
         [packages.msmtp]\nmanagement = \"ecr\"\n",
    )
}

fn three_accounts(home: &Path) -> ManagedAccounts {
    let mut accounts = ManagedAccounts {
        maildir: Some(home.join(".local/share/mail")),
        ..Default::default()
    };

    let mut personal =
        ManagedAccount::new("alice@gmail.com", Provider::Gmail, Auth::oauth("personal"));
    personal.name = Some("Alice Example".into());
    personal.primary = true;
    accounts.accounts.insert("personal".into(), personal);

    accounts.accounts.insert(
        "work".into(),
        ManagedAccount::new("alice@corp.example", Provider::Outlook, Auth::oauth("work")),
    );

    let mut other = ManagedAccount::new(
        "alice@example.net",
        Provider::Generic,
        Auth::Command {
            command: vec!["pass".into(), "show".into(), "mail/other".into()],
        },
    );
    other.imap = Some(Endpoint::implicit_tls("imap.example.net", 993));
    other.smtp = Some(Endpoint::starttls("smtp.example.net", 587));
    accounts.accounts.insert("other".into(), other);

    accounts
}

/// Applies a managed setup into a rooted home and answers what ecr sees.
fn set_up(home: &Path) -> MailPaths {
    let env = Env::rooted_at(home);
    let accounts = Accounts {
        path: Accounts::path_in(&env),
        accounts: three_accounts(home),
    };
    accounts.save().unwrap();

    let reloaded = Accounts::load_from(&accounts.path).unwrap();
    assert!(reloaded.problems().is_empty(), "{:?}", reloaded.problems());

    let layout = reloaded.layout(&env).unwrap();
    apply(&reloaded.accounts, &layout, &managed_packages()).unwrap();

    MailPaths::with_packages(&env, &ServerSettings::default(), &managed_packages()).unwrap()
}

#[test]
fn every_managed_account_is_discovered_with_its_address_channel_and_sender() {
    let home = tempfile::tempdir().unwrap();
    let paths = set_up(home.path());

    let found = discovery::accounts(&paths);
    let ids: Vec<&str> = found.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(ids, vec!["other", "personal", "work"]);

    for account in &found {
        assert!(
            account.can_sync(),
            "{} has no mbsync channel: {account:?}",
            account.id
        );
        assert!(
            account.can_send(),
            "{} has no msmtp account: {account:?}",
            account.id
        );
        assert!(
            account.address.is_some(),
            "{} has no address, so replies cannot pick an identity",
            account.id
        );
    }

    let personal = found.iter().find(|a| a.id.as_str() == "personal").unwrap();
    assert_eq!(personal.address.as_deref(), Some("alice@gmail.com"));
    assert_eq!(personal.mbsync_channel.as_deref(), Some("personal"));
    assert_eq!(personal.msmtp_account.as_deref(), Some("personal"));
}

/// Doctor reads an account's OAuth profile out of the `PassCmd` ecr rendered.
/// It is the only link between an account and the token that syncs it, and it
/// is a string parsed out of a config file.
#[test]
fn the_oauth_profile_survives_from_the_account_file_to_discovery() {
    let home = tempfile::tempdir().unwrap();
    let paths = set_up(home.path());

    let found = discovery::accounts(&paths);
    let work = found.iter().find(|a| a.id.as_str() == "work").unwrap();
    let other = found.iter().find(|a| a.id.as_str() == "other").unwrap();

    assert_eq!(
        discovery::oauth_profile(&paths, work).as_deref(),
        Some("work")
    );
    // A password command is not an OAuth profile, and must not be read as one.
    assert_eq!(discovery::oauth_profile(&paths, other), None);
}

#[test]
fn the_managed_files_are_what_resolution_picks() {
    let home = tempfile::tempdir().unwrap();
    let paths = set_up(home.path());

    for config in [&paths.notmuch, &paths.mbsync, &paths.msmtp] {
        assert_eq!(
            config.source,
            ConfigSource::Managed,
            "{} resolved to {:?}",
            config.kind,
            config.path
        );
        assert!(config.path.as_ref().unwrap().starts_with(home.path()));
    }

    assert_eq!(paths.maildir_root, home.path().join(".local/share/mail"));
    assert_eq!(paths.database_path, paths.maildir_root);
    assert!(paths.post_new_hook().is_some(), "the hook is not installed");
}

/// The reader's own configuration keeps existing. Managed mode outranks it,
/// reads nothing from it, and — the part that matters — leaves it on disk.
#[test]
fn a_self_managed_config_is_outranked_rather_than_replaced() {
    let home = tempfile::tempdir().unwrap();
    let theirs = home.path().join(".config/notmuch/default/config");
    std::fs::create_dir_all(theirs.parent().unwrap()).unwrap();
    std::fs::write(&theirs, "[database]\npath=/srv/their-mail\n").unwrap();

    let paths = set_up(home.path());

    assert_eq!(paths.notmuch.source, ConfigSource::Managed);
    assert_eq!(
        std::fs::read_to_string(&theirs).unwrap(),
        "[database]\npath=/srv/their-mail\n",
        "managed mode edited a file it does not own"
    );
    assert!(paths.notmuch.shadowed.contains(&theirs));
}

/// Switching managed mode off has to be one line, with nothing to undo.
#[test]
fn turning_management_off_goes_straight_back_to_the_readers_own_config() {
    let home = tempfile::tempdir().unwrap();
    let theirs = home.path().join(".config/notmuch/default/config");
    std::fs::create_dir_all(theirs.parent().unwrap()).unwrap();
    std::fs::write(&theirs, "[database]\npath=/srv/their-mail\n").unwrap();
    set_up(home.path());

    let paths = MailPaths::with_packages(
        &Env::rooted_at(home.path()),
        &ServerSettings::default(),
        &Packages::default(),
    )
    .unwrap();

    assert_eq!(paths.notmuch.source, ConfigSource::Xdg);
    assert_eq!(
        paths.maildir_root,
        std::path::PathBuf::from("/srv/their-mail")
    );
}

/// Per package, not all at once: someone with a working mbsync setup and no
/// msmtp at all is the ordinary case, and they must be able to hand ecr one
/// without the other.
#[test]
fn one_package_can_be_managed_while_another_is_not() {
    let home = tempfile::tempdir().unwrap();
    let env = Env::rooted_at(home.path());

    let accounts = Accounts {
        path: Accounts::path_in(&env),
        accounts: three_accounts(home.path()),
    };
    let layout = accounts.layout(&env).unwrap();

    let only_notmuch_and_msmtp = Packages::parse(
        "[packages.notmuch]\nmanagement = \"ecr\"\n[packages.msmtp]\nmanagement = \"ecr\"\n",
    );
    apply(&accounts.accounts, &layout, &only_notmuch_and_msmtp).unwrap();

    // Their own isyncrc, left entirely alone.
    std::fs::write(
        home.path().join(".config/isyncrc"),
        format!(
            "MaildirStore theirs\nPath {}/personal/\n\nChannel theirs\nNear :theirs:\n",
            layout.maildir_root.display()
        ),
    )
    .unwrap();

    let paths = MailPaths::with_packages(&env, &ServerSettings::default(), &only_notmuch_and_msmtp)
        .unwrap();

    assert_eq!(paths.notmuch.source, ConfigSource::Managed);
    assert_eq!(paths.msmtp.source, ConfigSource::Managed);
    assert_eq!(paths.mbsync.source, ConfigSource::Xdg);
    assert!(
        !layout.isyncrc().exists(),
        "an unmanaged package was written"
    );

    // And the accounts still resolve, through their channel rather than ecr's.
    let found = discovery::accounts(&paths);
    let personal = found.iter().find(|a| a.id.as_str() == "personal").unwrap();
    assert_eq!(personal.mbsync_channel.as_deref(), Some("theirs"));
}

/// Drift is what nothing else in the system notices: `accounts.toml` was edited,
/// or an account was added on another machine, and the files the tools actually
/// read are still the old ones. Everything keeps working, against the old
/// accounts.
#[tokio::test]
async fn doctor_reports_managed_mode_and_notices_drift() {
    let home = tempfile::tempdir().unwrap();
    let env = Env::rooted_at(home.path());
    set_up(home.path());

    // Managed mode is only visible to doctor through the settings file, which is
    // where the switch lives for every other reader of it too.
    for kind in [
        ecr_core::doctor::ConfigKind::Notmuch,
        ecr_core::doctor::ConfigKind::Mbsync,
        ecr_core::doctor::ConfigKind::Msmtp,
    ] {
        ecr_store::packages::Packages::set_management(
            &env,
            kind,
            ecr_store::packages::Management::Ecr,
        )
        .unwrap();
    }

    let report = ecr_store::doctor::run_with(&env, &ServerSettings::default()).await;
    let check = |name: &str| {
        report
            .checks
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("no check named {name}; got {:?}", report.checks))
            .clone()
    };

    assert_eq!(check("managed config").detail, "notmuch, mbsync, msmtp");
    for name in ["managed notmuch", "managed mbsync", "managed msmtp"] {
        assert_eq!(
            check(name).status,
            ecr_core::doctor::CheckStatus::Ok,
            "{name}: {:?}",
            check(name)
        );
    }

    // A fourth account, added and not applied.
    let mut accounts = Accounts::load(&env).unwrap();
    accounts.accounts.accounts.insert(
        "later".into(),
        ManagedAccount::new("alice@later.example", Provider::Gmail, Auth::oauth("later")),
    );
    accounts.save().unwrap();

    let report = ecr_store::doctor::run_with(&env, &ServerSettings::default()).await;
    let mbsync = report
        .checks
        .iter()
        .find(|c| c.name == "managed mbsync")
        .unwrap();

    assert_eq!(mbsync.status, ecr_core::doctor::CheckStatus::Warn);
    assert!(mbsync.detail.contains("behind"), "{mbsync:?}");
    assert!(
        mbsync
            .hint
            .as_deref()
            .unwrap()
            .contains("ecr account apply"),
        "{mbsync:?}"
    );
}

#[test]
fn a_generated_file_that_was_edited_is_backed_up_on_the_next_apply() {
    let home = tempfile::tempdir().unwrap();
    let env = Env::rooted_at(home.path());
    set_up(home.path());

    let accounts = Accounts::load(&env).unwrap();
    let layout = accounts.layout(&env).unwrap();

    let edited = std::fs::read_to_string(layout.isyncrc()).unwrap() + "\nPatterns INBOX\n";
    std::fs::write(layout.isyncrc(), &edited).unwrap();

    let applied = apply(&accounts.accounts, &layout, &managed_packages()).unwrap();
    let isyncrc = applied.iter().find(|a| a.path == layout.isyncrc()).unwrap();

    let managed::Outcome::ReplacedAfterBackup(backup) = &isyncrc.outcome else {
        panic!("the edit was destroyed: {:?}", isyncrc.outcome);
    };
    assert_eq!(std::fs::read_to_string(backup).unwrap(), edited);
}

/// notmuch runs hooks from `database.hook_dir`, defaulting to
/// `<database.path>/.notmuch/hooks` — never the directory beside its config.
/// So writing `hooks/post-new` next to the generated config is only half the
/// job, and the missing half fails silently: `notmuch new` still indexes, mail
/// still arrives, and it simply never gets tagged `inbox`. Every pane that
/// starts from `tag:inbox` then stops at the last message tagged before
/// managed mode was switched on, which reads as sync having stopped.
#[test]
fn the_generated_config_points_notmuch_at_the_hooks_it_generated() {
    let home = tempfile::tempdir().unwrap();
    let paths = set_up(home.path());

    let config = paths
        .notmuch
        .path
        .as_ref()
        .expect("a managed notmuch config");
    let text = std::fs::read_to_string(config).unwrap();

    let hook_dir = text
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix("hook_dir="))
        .expect("the generated config names a hook_dir");

    assert!(
        Path::new(hook_dir).join("post-new").is_file(),
        "notmuch would run hooks from {hook_dir}, which has no post-new"
    );
}
