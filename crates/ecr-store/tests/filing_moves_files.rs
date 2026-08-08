//! Filing, against a real notmuch database and real files on disk.
//!
//! `filing.rs`'s unit tests pin the *queries* — which is where the dangerous
//! mistakes live, because a `not tag:inbox` that forgets to exclude sent mail
//! sweeps an entire mailbox into the archive. What they cannot show is whether
//! those queries, handed to notmuch, select the files anybody meant, and
//! whether the move that follows leaves the message somewhere ecr can still
//! find it.
//!
//! That gap is the whole reason this file exists. A query can be perfect and
//! the feature still broken: notmuch's `path:` is relative to the database
//! root, the maildir has three subdirectories and only one of them is `cur/`,
//! and a rename that keeps the wrong part of the filename corrupts mbsync's
//! idea of the folder. None of that is visible from a string.

use ecr_core::message::{MessageId, TagOp};
use ecr_store::paths::{Env, MailPaths};
use ecr_store::settings::ServerSettings;
use std::path::Path;

/// A maildir with one account and a couple of folders, indexed by notmuch.
struct Fixture {
    _home: tempfile::TempDir,
    paths: std::sync::Arc<MailPaths>,
    notmuch: ecr_store::Notmuch,
}

fn maildir(root: &Path, relative: &str) {
    for leaf in ["cur", "new", "tmp"] {
        std::fs::create_dir_all(root.join(relative).join(leaf)).unwrap();
    }
}

/// Writes a message into a folder's `cur/`, answering where it landed.
fn deliver(root: &Path, folder: &str, name: &str, subject: &str) -> std::path::PathBuf {
    let path = root.join(folder).join("cur").join(name);
    std::fs::write(
        &path,
        format!(
            "From: someone@example.org\r\n\
             To: me@example.com\r\n\
             Subject: {subject}\r\n\
             Message-ID: <{subject}@example.org>\r\n\
             Date: Wed, 01 Apr 2026 12:00:00 +0000\r\n\
             \r\n\
             body\r\n"
        ),
    )
    .unwrap();
    path
}

impl Fixture {
    fn new() -> Option<Self> {
        // notmuch is the machine's own; a shell without it cannot run this.
        ecr_store::tools::find("notmuch")?;

        let home = tempfile::tempdir().ok()?;
        let root = home.path().join("Mail");
        // The provider's own folder names, not generic ones. Outlook's trash is
        // `Deleted Items` and its junk is `Junk Email`; a fixture that invents
        // `Trash` watches an empty directory while the move lands somewhere
        // else entirely, and reports the feature broken when it worked.
        for folder in [
            "main/Inbox",
            "main/Archive",
            "main/Deleted Items",
            "main/Junk Email",
            "main/Sent Items",
        ] {
            maildir(&root, folder);
        }

        let config = home.path().join(".config/notmuch/default");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(
            config.join("config"),
            format!("[database]\npath={}\n[new]\ntags=new\n", root.display()),
        )
        .unwrap();

        let paths = std::sync::Arc::new(
            MailPaths::with(&Env::rooted_at(home.path()), &ServerSettings::default()).ok()?,
        );
        let notmuch = ecr_store::Notmuch::new(std::sync::Arc::clone(&paths));

        Some(Self {
            _home: home,
            paths,
            notmuch,
        })
    }

    fn root(&self) -> &Path {
        &self.paths.maildir_root
    }
}

fn outlook_accounts() -> ecr_core::managed::ManagedAccounts {
    use ecr_core::managed::{Auth, ManagedAccount, Provider};

    let mut accounts = ecr_core::managed::ManagedAccounts::default();
    accounts.accounts.insert(
        "main".into(),
        ManagedAccount::new("me@example.com", Provider::Outlook, Auth::oauth("main")),
    );
    accounts
}

/// The one that cannot be reasoned about from a query string: a message tagged
/// `deleted` has to end up as a *file* in the trash folder, and notmuch has to
/// still know where it is afterwards.
#[tokio::test]
async fn a_deleted_message_ends_up_in_the_trash_folder() {
    let Some(fixture) = Fixture::new() else {
        eprintln!("notmuch is not installed; skipping");
        return;
    };

    deliver(fixture.root(), "main/Inbox", "1700000001.a:2,S", "doomed");
    fixture.notmuch.index_new().await.unwrap();

    fixture
        .notmuch
        .tag(&[TagOp::new(MessageId(format!("{}@example.org", "doomed"))).adding("deleted")])
        .await
        .unwrap();

    let filed = ecr_store::filing::run(&fixture.paths, &fixture.notmuch, &outlook_accounts())
        .await
        .unwrap();
    assert_eq!(filed.moved, 1, "{:?}", filed.problems);

    let trash: Vec<_> = std::fs::read_dir(fixture.root().join("main/Deleted Items/cur"))
        .unwrap()
        .flatten()
        .collect();
    assert_eq!(trash.len(), 1, "the message is not in the trash");

    // And the inbox no longer holds it — a copy in both is the failure a
    // rename exists to prevent.
    assert_eq!(
        std::fs::read_dir(fixture.root().join("main/Inbox/cur"))
            .unwrap()
            .count(),
        0,
        "the message was copied rather than moved"
    );
}

/// The flags are not decoration. `:2,S` says the message has been read, and
/// losing it on the way to another folder marks a whole mailbox unread — the
/// most visible possible way to get a move wrong.
#[tokio::test]
async fn the_maildir_flags_survive_being_filed() {
    let Some(fixture) = Fixture::new() else {
        return;
    };

    deliver(
        fixture.root(),
        "main/Inbox",
        "1700000002.b,U=17:2,S",
        "flagged",
    );
    fixture.notmuch.index_new().await.unwrap();
    fixture
        .notmuch
        .tag(&[TagOp::new(MessageId(format!("{}@example.org", "flagged"))).adding("deleted")])
        .await
        .unwrap();

    ecr_store::filing::run(&fixture.paths, &fixture.notmuch, &outlook_accounts())
        .await
        .unwrap();

    let name = std::fs::read_dir(fixture.root().join("main/Deleted Items/cur"))
        .unwrap()
        .flatten()
        .next()
        .expect("nothing in the trash")
        .file_name()
        .to_string_lossy()
        .into_owned();

    assert!(name.ends_with(":2,S"), "the flags were lost: {name}");
    // And the UID that belonged to the *old* folder is gone, as the isync
    // manual requires of any client that moves a message between maildirs.
    assert!(
        !name.contains(",U="),
        "the old folder's UID came along: {name}"
    );
}

/// Running twice must move nothing the second time. The hook runs on every
/// sync, and a message renamed on each one is a file whose mtime changes for
/// ever — which the delivery watcher reads as new mail arriving, repeatedly.
#[tokio::test]
async fn filing_the_same_mail_twice_is_a_no_op() {
    let Some(fixture) = Fixture::new() else {
        return;
    };

    deliver(fixture.root(), "main/Inbox", "1700000003.c:2,S", "once");
    fixture.notmuch.index_new().await.unwrap();
    fixture
        .notmuch
        .tag(&[TagOp::new(MessageId(format!("{}@example.org", "once"))).adding("deleted")])
        .await
        .unwrap();

    let accounts = outlook_accounts();
    let first = ecr_store::filing::run(&fixture.paths, &fixture.notmuch, &accounts)
        .await
        .unwrap();
    assert_eq!(first.moved, 1);

    // The database has to be told where things went before the second pass, the
    // same way the `pre-new` hook is followed by `notmuch new`.
    fixture.notmuch.index_new().await.unwrap();

    let second = ecr_store::filing::run(&fixture.paths, &fixture.notmuch, &accounts)
        .await
        .unwrap();
    assert_eq!(second.moved, 0, "it moved the same message twice");
}

/// The catastrophic one, against a real database. Sent mail, drafts and
/// everything already filed all lack `inbox`, so a naive archive rule sweeps
/// the entire mailbox into the archive on its first run — and nobody can put
/// that back.
#[tokio::test]
async fn archiving_leaves_everything_outside_the_inbox_alone() {
    let Some(fixture) = Fixture::new() else {
        return;
    };

    // In the inbox and no longer tagged `inbox`: this one should move.
    deliver(fixture.root(), "main/Inbox", "1700000004.d:2,S", "archived");
    // Already elsewhere, and equally lacking `inbox`: these must not.
    deliver(
        fixture.root(),
        "main/Deleted Items",
        "1700000005.e:2,S",
        "binned",
    );
    deliver(
        fixture.root(),
        "main/Junk Email",
        "1700000006.f:2,S",
        "spammy",
    );

    fixture.notmuch.index_new().await.unwrap();
    // Nothing is tagged `inbox`, which is the worst case for the rule.

    let filed = ecr_store::filing::run(&fixture.paths, &fixture.notmuch, &outlook_accounts())
        .await
        .unwrap();

    assert_eq!(filed.moved, 1, "{:?}", filed.problems);
    assert_eq!(
        std::fs::read_dir(fixture.root().join("main/Archive/cur"))
            .unwrap()
            .count(),
        1
    );
    for folder in ["main/Deleted Items", "main/Junk Email"] {
        assert_eq!(
            std::fs::read_dir(fixture.root().join(folder).join("cur"))
                .unwrap()
                .count(),
            1,
            "{folder} was swept into the archive"
        );
    }
}

/// A message that is still in the inbox stays there. Obvious, and the thing a
/// query with a stray `not` gets exactly backwards.
#[tokio::test]
async fn mail_still_in_the_inbox_is_not_touched() {
    let Some(fixture) = Fixture::new() else {
        return;
    };

    deliver(fixture.root(), "main/Inbox", "1700000007.g:2,S", "keeper");
    fixture.notmuch.index_new().await.unwrap();
    fixture
        .notmuch
        .tag(&[TagOp::new(MessageId(format!("{}@example.org", "keeper"))).adding("inbox")])
        .await
        .unwrap();

    let filed = ecr_store::filing::run(&fixture.paths, &fixture.notmuch, &outlook_accounts())
        .await
        .unwrap();

    assert_eq!(filed.moved, 0, "{:?}", filed.problems);
    assert_eq!(
        std::fs::read_dir(fixture.root().join("main/Inbox/cur"))
            .unwrap()
            .count(),
        1
    );
}

/// Gmail has nowhere to archive to — `[Gmail]/All Mail` is a copy of every
/// message and ecr deliberately does not sync it — so filing must move nothing
/// for it rather than inventing a destination.
#[tokio::test]
async fn gmail_archives_nothing_because_there_is_nowhere_to_put_it() {
    use ecr_core::managed::{Auth, ManagedAccount, Provider};

    let Some(fixture) = Fixture::new() else {
        return;
    };
    deliver(fixture.root(), "main/Inbox", "1700000008.h:2,S", "gmailish");
    fixture.notmuch.index_new().await.unwrap();

    let mut accounts = ecr_core::managed::ManagedAccounts::default();
    accounts.accounts.insert(
        "main".into(),
        ManagedAccount::new("me@gmail.com", Provider::Gmail, Auth::oauth("main")),
    );

    let filed = ecr_store::filing::run(&fixture.paths, &fixture.notmuch, &accounts)
        .await
        .unwrap();

    assert_eq!(filed.moved, 0);
    assert_eq!(
        std::fs::read_dir(fixture.root().join("main/Inbox/cur"))
            .unwrap()
            .count(),
        1,
        "a Gmail message was filed somewhere ecr made up"
    );
}
