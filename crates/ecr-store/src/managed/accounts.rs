//! `accounts.toml`: the accounts ecr holds, and turning them into files.
//!
//! One direction only. This file is written by `ecr account` and read by the
//! renderers; nothing reads it to answer what mail exists, which is still the
//! maildir's job. That is what lets managed mode be switched off by a single
//! line in `settings.toml` without anything having to be undone.

use super::render::{self, Layout};
use super::Outcome;
use crate::error::{Error, Result};
use crate::packages::Packages;
use crate::paths::Env;
use ecr_core::doctor::ConfigKind;
use ecr_core::managed::ManagedAccounts;
use std::path::{Path, PathBuf};

const HEADER: &str = "\
# The accounts ecr manages.
#
# Written by `ecr account add|edit|remove`, and read by `ecr account apply`,
# which is what turns it into the configuration mbsync, msmtp and notmuch read.
# Editing it by hand is fine — but those commands rewrite the whole file, so
# comments you add here do not survive one.
#
# Nothing here decides what mail exists. An account is a directory under the
# maildir root, the same as it has always been, so an account described here and
# never synced is one ecr will tell you is missing rather than one it pretends
# to have.
";

#[derive(Debug, Clone)]
pub struct Accounts {
    pub path: PathBuf,
    pub accounts: ManagedAccounts,
}

impl Accounts {
    pub fn path_in(env: &Env) -> PathBuf {
        env.config_dir.join("ecr").join("accounts.toml")
    }

    pub fn load(env: &Env) -> Result<Self> {
        Self::load_from(&Self::path_in(env))
    }

    /// A file that is not there is no accounts, which is the state a machine is
    /// in before the first `ecr account add`. A file that is there and cannot be
    /// read is an error and stays one: silently continuing with no accounts
    /// would regenerate every config file as empty, and the reader's mail would
    /// stop syncing because of a typo.
    pub fn load_from(path: &Path) -> Result<Self> {
        let accounts = match std::fs::read_to_string(path) {
            Ok(text) => toml::from_str::<ManagedAccounts>(&text).map_err(|err| {
                Error::Managed(format!("{} could not be read: {err}", path.display()))
            })?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => ManagedAccounts::default(),
            Err(err) => return Err(Error::Io(err)),
        };

        Ok(Self {
            path: path.to_path_buf(),
            accounts,
        })
    }

    pub fn save(&self) -> Result<()> {
        let body = toml::to_string_pretty(&self.accounts)
            .map_err(|err| Error::Managed(format!("accounts could not be written: {err}")))?;

        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let staging = self.path.with_extension("toml.ecr-staging");
        std::fs::write(&staging, format!("{HEADER}\n{body}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&staging, &self.path)?;
        Ok(())
    }

    /// Whether every account is described well enough to render.
    pub fn problems(&self) -> Vec<String> {
        self.accounts
            .iter()
            .flat_map(|(id, account)| account.problems(id))
            .collect()
    }

    pub fn layout(&self, env: &Env) -> Result<Layout> {
        self.layout_at(&managed_dir(env))
    }

    /// The same, for a caller that already resolved where the generated files
    /// go — doctor has, out of the `MailPaths` it is reporting on, and reaching
    /// back to a process `Env` there would be the isolation gap this codebase
    /// keeps paying for.
    pub fn layout_at(&self, managed_dir: &Path) -> Result<Layout> {
        let maildir_root = self.accounts.maildir.clone().ok_or_else(|| {
            Error::Managed(format!(
                "{} names no maildir; add `maildir = \"…\"` at the top of it",
                self.path.display()
            ))
        })?;

        Ok(Layout {
            maildir_root,
            managed_dir: managed_dir.to_path_buf(),
        })
    }
}

pub fn managed_dir(env: &Env) -> PathBuf {
    env.config_dir.join("ecr").join("managed")
}

/// One file ecr would write.
#[derive(Debug, Clone)]
pub struct Rendered {
    pub kind: ConfigKind,
    pub path: PathBuf,
    pub body: String,
    /// notmuch's `post-new` hook is a second file for the same package, and the
    /// one that has to be executable.
    pub mode: u32,
}

impl Rendered {
    /// What is on disk now, against what would be written.
    pub fn state(&self) -> State {
        let Ok(text) = std::fs::read_to_string(&self.path) else {
            return State::Missing;
        };
        if text == super::render(&self.body, SOURCE) {
            State::Current
        } else if super::was_edited(&text) {
            State::EditedByHand
        } else {
            State::Stale
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Missing,
    /// Exactly what the accounts render to.
    Current,
    /// ecr wrote it, and the accounts have moved on since.
    Stale,
    /// Somebody edited it, so applying would move it aside first.
    EditedByHand,
}

const SOURCE: &str = "accounts.toml";

/// Every file managed mode would write, for the packages it has been given.
///
/// A package left self-managed renders nothing at all — not an empty file, not a
/// file with a comment in it. ecr owning a config is something the reader turned
/// on per tool, and a tool they did not name should find no trace of ecr having
/// considered it.
pub fn plan(accounts: &ManagedAccounts, layout: &Layout, packages: &Packages) -> Vec<Rendered> {
    let mut out = Vec::new();

    if packages.is_managed(ConfigKind::Notmuch) {
        out.push(Rendered {
            kind: ConfigKind::Notmuch,
            path: layout.notmuch(),
            body: render::notmuch(accounts, layout),
            mode: 0o600,
        });
        out.push(Rendered {
            kind: ConfigKind::Notmuch,
            path: layout.post_new(),
            body: render::post_new(accounts),
            mode: 0o700,
        });
    }
    if packages.is_managed(ConfigKind::Mbsync) {
        out.push(Rendered {
            kind: ConfigKind::Mbsync,
            path: layout.isyncrc(),
            body: render::mbsync(accounts, layout),
            mode: 0o600,
        });
    }
    if packages.is_managed(ConfigKind::Msmtp) {
        out.push(Rendered {
            kind: ConfigKind::Msmtp,
            path: layout.msmtp(),
            body: render::msmtp(accounts),
            mode: 0o600,
        });
    }

    out
}

#[derive(Debug, Clone)]
pub struct Applied {
    pub path: PathBuf,
    pub outcome: Outcome,
}

/// Writes the plan, and makes each account's maildir exist.
///
/// The directory matters as much as the files: `discovery::accounts` reads the
/// maildir root, so until a directory is there an account that has been added
/// and not yet synced does not exist, `ecr doctor` fails on `accounts`, and the
/// server refuses to start — over a setup where nothing is actually wrong. An
/// empty maildir is what mbsync would create on its first run anyway.
pub fn apply(
    accounts: &ManagedAccounts,
    layout: &Layout,
    packages: &Packages,
) -> Result<Vec<Applied>> {
    let mut applied = Vec::new();

    for (id, _) in accounts.enabled() {
        create_maildir(&layout.account_dir(id).join("Inbox"))?;
    }

    for rendered in plan(accounts, layout, packages) {
        let outcome =
            super::write_with_mode(&rendered.path, &rendered.body, SOURCE, rendered.mode)?;
        applied.push(Applied {
            path: rendered.path,
            outcome,
        });
    }

    Ok(applied)
}

fn create_maildir(dir: &Path) -> Result<()> {
    for leaf in ["cur", "new", "tmp"] {
        std::fs::create_dir_all(dir.join(leaf))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ecr_core::managed::{Auth, ManagedAccount, Provider};

    fn packages(text: &str) -> Packages {
        Packages::parse(text)
    }

    fn all_managed() -> Packages {
        packages(
            "[packages.notmuch]\nmanagement = \"ecr\"\n\
             [packages.mbsync]\nmanagement = \"ecr\"\n\
             [packages.msmtp]\nmanagement = \"ecr\"\n",
        )
    }

    fn fixture(home: &Path) -> (Accounts, Layout) {
        let mut accounts = ManagedAccounts {
            maildir: Some(home.join("mail")),
            ..Default::default()
        };
        let mut main = ManagedAccount::new("alice@gmail.com", Provider::Gmail, Auth::oauth("main"));
        main.primary = true;
        accounts.accounts.insert("main".into(), main);

        let env = Env::rooted_at(home);
        let accounts = Accounts {
            path: Accounts::path_in(&env),
            accounts,
        };
        let layout = accounts.layout(&env).unwrap();
        (accounts, layout)
    }

    #[test]
    fn accounts_round_trip_through_the_file() {
        let home = tempfile::tempdir().unwrap();
        let (accounts, _) = fixture(home.path());
        accounts.save().unwrap();

        let read = Accounts::load_from(&accounts.path).unwrap();
        assert_eq!(read.accounts, accounts.accounts);
        assert!(std::fs::read_to_string(&accounts.path)
            .unwrap()
            .contains("ecr account"));
    }

    #[test]
    fn an_absent_file_is_no_accounts_rather_than_an_error() {
        let accounts = Accounts::load_from(Path::new("/nonexistent/ecr/accounts.toml")).unwrap();
        assert!(accounts.accounts.is_empty());
    }

    /// Reading a broken file as "no accounts" would regenerate every config as
    /// empty, and the reader's mail would stop syncing because of a typo.
    #[test]
    fn a_broken_file_is_an_error_rather_than_an_empty_setup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("accounts.toml");
        std::fs::write(&path, "[account.main]\naddress = \n").unwrap();

        assert!(Accounts::load_from(&path).is_err());
    }

    #[test]
    fn a_self_managed_package_renders_nothing_at_all() {
        let home = tempfile::tempdir().unwrap();
        let (accounts, layout) = fixture(home.path());

        let only_mbsync = packages("[packages.mbsync]\nmanagement = \"ecr\"\n");
        let planned = plan(&accounts.accounts, &layout, &only_mbsync);

        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].path, layout.isyncrc());
    }

    #[test]
    fn applying_writes_every_managed_file_and_the_maildir() {
        let home = tempfile::tempdir().unwrap();
        let (accounts, layout) = fixture(home.path());

        let applied = apply(&accounts.accounts, &layout, &all_managed()).unwrap();

        assert_eq!(applied.len(), 4);
        assert!(layout.isyncrc().is_file());
        assert!(layout.msmtp().is_file());
        assert!(layout.notmuch().is_file());
        assert!(layout.post_new().is_file());
        assert!(render::is_maildir(
            &layout.account_dir("main").join("Inbox")
        ));
    }

    #[test]
    fn applying_twice_changes_nothing_the_second_time() {
        let home = tempfile::tempdir().unwrap();
        let (accounts, layout) = fixture(home.path());

        apply(&accounts.accounts, &layout, &all_managed()).unwrap();
        let again = apply(&accounts.accounts, &layout, &all_managed()).unwrap();

        assert!(
            again.iter().all(|a| a.outcome == Outcome::Unchanged),
            "{again:?}"
        );
    }

    #[test]
    fn the_state_of_each_file_is_reported_against_what_is_on_disk() {
        let home = tempfile::tempdir().unwrap();
        let (mut accounts, layout) = fixture(home.path());

        let before = plan(&accounts.accounts, &layout, &all_managed());
        assert!(before.iter().all(|r| r.state() == State::Missing));

        apply(&accounts.accounts, &layout, &all_managed()).unwrap();
        let current = plan(&accounts.accounts, &layout, &all_managed());
        assert!(current.iter().all(|r| r.state() == State::Current));

        // The accounts move on, and the files have not been applied yet.
        accounts.accounts.accounts.insert(
            "work".into(),
            ManagedAccount::new("alice@corp.example", Provider::Outlook, Auth::oauth("work")),
        );
        let stale = plan(&accounts.accounts, &layout, &all_managed());
        assert!(stale.iter().any(|r| r.state() == State::Stale), "{stale:?}");
    }

    #[test]
    fn a_hand_edited_file_is_reported_as_such_rather_than_as_stale() {
        let home = tempfile::tempdir().unwrap();
        let (accounts, layout) = fixture(home.path());
        apply(&accounts.accounts, &layout, &all_managed()).unwrap();

        let edited = std::fs::read_to_string(layout.isyncrc()).unwrap() + "Patterns *\n";
        std::fs::write(layout.isyncrc(), edited).unwrap();

        let planned = plan(&accounts.accounts, &layout, &all_managed());
        let isyncrc = planned.iter().find(|r| r.path == layout.isyncrc()).unwrap();
        assert_eq!(isyncrc.state(), State::EditedByHand);
    }

    #[test]
    fn an_account_file_with_no_maildir_says_so() {
        let home = tempfile::tempdir().unwrap();
        let env = Env::rooted_at(home.path());
        let accounts = Accounts {
            path: Accounts::path_in(&env),
            accounts: ManagedAccounts::default(),
        };

        let err = accounts.layout(&env).unwrap_err().to_string();
        assert!(err.contains("maildir"), "{err}");
    }
}
