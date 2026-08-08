//! Turning accounts into the files the mail tools read.
//!
//! Every function here is pure: accounts in, text out, no I/O. What makes them
//! trustworthy is not that they look right but that
//! `tests/managed_round_trip.rs` feeds each one back through the *existing*
//! parsers — `MbsyncConfig::parse`, `MsmtpConfig::parse`, `NotmuchConfig::parse`
//! — and asserts `discovery::accounts` finds exactly the accounts that went in.
//! A renderer that drifts from what ecr can read fails there, rather than as
//! mail that quietly does not sync.

use ecr_core::managed::{Auth, FolderRole, ManagedAccount, ManagedAccounts, Tls};
use std::path::Path;

/// Where the generated files go, and where the mail they describe lives.
#[derive(Debug, Clone)]
pub struct Layout {
    pub maildir_root: std::path::PathBuf,
    pub managed_dir: std::path::PathBuf,
}

impl Layout {
    pub fn isyncrc(&self) -> std::path::PathBuf {
        isyncrc(&self.managed_dir)
    }

    pub fn msmtp(&self) -> std::path::PathBuf {
        msmtp_config(&self.managed_dir)
    }

    pub fn notmuch(&self) -> std::path::PathBuf {
        notmuch_config(&self.managed_dir)
    }

    pub fn post_new(&self) -> std::path::PathBuf {
        post_new_hook(&self.managed_dir)
    }

    pub fn account_dir(&self, id: &str) -> std::path::PathBuf {
        self.maildir_root.join(id)
    }
}

// Free functions as well as methods, because path resolution has to name these
// files before it knows where the mail is — that answer comes out of the notmuch
// config, which is one of them. Two copies of these joins would be one rename
// away from managed mode writing where nothing looks.

pub fn isyncrc(managed_dir: &Path) -> std::path::PathBuf {
    managed_dir.join("isyncrc")
}

pub fn msmtp_config(managed_dir: &Path) -> std::path::PathBuf {
    managed_dir.join("msmtp").join("config")
}

pub fn notmuch_config(managed_dir: &Path) -> std::path::PathBuf {
    managed_dir.join("notmuch").join("config")
}

/// `MailPaths::post_new_hook` looks for `hooks/post-new` beside the notmuch
/// config, so this is not a choice — it is where notmuch will look.
pub fn post_new_hook(managed_dir: &Path) -> std::path::PathBuf {
    managed_dir.join("notmuch").join("hooks").join("post-new")
}

pub fn mbsync(accounts: &ManagedAccounts, layout: &Layout) -> String {
    let mut out = String::new();

    for (id, account) in accounts.enabled() {
        let Some(imap) = account.imap() else { continue };
        let dir = layout.account_dir(id);

        out.push_str(&format!("IMAPAccount {id}\n"));
        out.push_str(&format!("Host {}\n", imap.host));
        out.push_str(&format!("Port {}\n", imap.port));
        out.push_str(&format!("User {}\n", account.address));
        out.push_str(&format!(
            "PassCmd \"{}\"\n",
            escape(&account.auth.password_command())
        ));
        out.push_str(&format!("AuthMechs {}\n", account.auth.mechanism()));
        out.push_str(&format!("TLSType {}\n", imap_tls(imap.tls)));
        if let Some(bundle) = &account.certificate_file {
            out.push_str(&format!("CertificateFile {}\n", bundle.display()));
        }
        out.push('\n');

        out.push_str(&format!("IMAPStore {id}-remote\nAccount {id}\n\n"));

        // The trailing slash matters: mbsync treats a `Path` without one as a
        // prefix on the folder name rather than a directory. `Inbox` is set
        // explicitly because a MaildirStore's default is `~/Maildir`, which
        // would put this account's inbox somewhere ecr never looks.
        out.push_str(&format!("MaildirStore {id}-local\n"));
        out.push_str(&format!("Path {}/\n", dir.display()));
        out.push_str(&format!("Inbox {}/Inbox\n", dir.display()));
        // Gmail's folders are `[Gmail]/Sent Mail`, with the separator inside the
        // name. Verbatim keeps them as directories with that name; the default
        // would turn each one into a nested directory and change every
        // `path:` query the sidebar builds.
        out.push_str("SubFolders Verbatim\n\n");

        out.push_str(&format!("Channel {id}\n"));
        out.push_str(&format!("Far :{id}-remote:\n"));
        out.push_str(&format!("Near :{id}-local:\n"));
        out.push_str(&format!("Patterns {}\n", patterns(account)));
        out.push_str(&format!("Create {}\n", account.create.as_mbsync()));
        out.push_str(&format!("Expunge {}\n", account.expunge.as_mbsync()));
        out.push_str(&format!("Remove {}\n", account.remove.as_mbsync()));
        out.push_str("SyncState *\n");
        // Without this every message arrives dated when it was fetched, so a
        // first sync lands the whole mailbox on today and the list is useless
        // until the next delivery.
        out.push_str("CopyArrivalDate yes\n\n");
    }

    out.trim_end().to_string()
}

pub fn msmtp(accounts: &ManagedAccounts) -> String {
    let mut out = String::from("defaults\nauth on\ntls on\n\n");

    for (id, account) in accounts.enabled() {
        let Some(smtp) = account.smtp() else { continue };

        out.push_str(&format!("account {id}\n"));
        out.push_str(&format!("host {}\n", smtp.host));
        out.push_str(&format!("port {}\n", smtp.port));
        out.push_str(&format!(
            "tls_starttls {}\n",
            if smtp.tls == Tls::StartTls {
                "on"
            } else {
                "off"
            }
        ));
        if smtp.tls == Tls::None {
            out.push_str("tls off\n");
        }
        // The bare address, never `Name <addr>`: msmtp's `from` is the envelope
        // sender it puts in `MAIL FROM`, and a display name there is not an
        // address. The name belongs on the `From:` header, which ecr's own
        // composer writes.
        out.push_str(&format!("from {}\n", account.address));
        out.push_str(&format!("user {}\n", account.address));
        out.push_str(&format!(
            "auth {}\n",
            match account.auth {
                Auth::Oauth { .. } => "xoauth2",
                Auth::Command { .. } => "plain",
            }
        ));
        out.push_str(&format!(
            "passwordeval {}\n\n",
            account.auth.password_command()
        ));
    }

    // Last, and only after every account block: msmtp reads this file top to
    // bottom, and `account default : main` names a block that has to exist by
    // the time it is read.
    if let Some((id, _)) = accounts.primary() {
        out.push_str(&format!("account default : {id}\n"));
    }

    out.trim_end().to_string()
}

pub fn notmuch(accounts: &ManagedAccounts, layout: &Layout) -> String {
    let mut out = String::new();

    out.push_str("[database]\n");
    out.push_str(&format!("path={}\n\n", layout.maildir_root.display()));

    out.push_str("[user]\n");
    if let Some((_, primary)) = accounts.primary() {
        if let Some(name) = primary.name.as_ref().or(accounts.name.as_ref()) {
            out.push_str(&format!("name={name}\n"));
        }
        out.push_str(&format!("primary_email={}\n", primary.address));

        let others: Vec<&str> = accounts
            .enabled()
            .map(|(_, a)| a.address.as_str())
            .filter(|a| *a != primary.address)
            .collect();
        if !others.is_empty() {
            out.push_str(&format!("other_email={};\n", others.join(";")));
        }
    }
    out.push('\n');

    // `new` rather than `inbox`: the hook below is what decides which of these
    // messages is in an inbox and which is in a Sent folder, and it can only do
    // that while they are still marked. Everything it does not claim is given
    // `inbox` on the way out, so a folder ecr has no opinion about still arrives
    // somewhere the reader will see it.
    out.push_str("[new]\n");
    out.push_str("tags=new;unread;\n");
    out.push_str("ignore=.mbsyncstate;.uidvalidity;.isyncuidmap.db;\n\n");

    out.push_str("[search]\n");
    out.push_str(&format!(
        "exclude_tags={};\n\n",
        accounts.exclude_tags.join(";")
    ));

    out.push_str("[maildir]\n");
    out.push_str("synchronize_flags=true\n\n");

    // Free on an empty database and a full `notmuch reindex '*'` afterwards, so
    // it is written from the start whether or not the sidebar's mailing lists
    // are wanted yet.
    out.push_str("[index]\n");
    out.push_str("header.List=List-Id\n");

    out
}

/// The `post-new` hook: what turns a synced maildir into tagged mail.
///
/// Without it every message is `inbox` and nothing says which account or folder
/// it came from — `tag:main`, which is what the sidebar's account rows search
/// for, would match nothing at all.
pub fn post_new(accounts: &ManagedAccounts) -> String {
    let mut out = String::from("#!/bin/sh\n");
    out.push_str("set -eu\n\n");

    for (id, account) in accounts.enabled() {
        out.push_str(&format!("# {id} — {}\n", account.address));
        out.push_str(&format!(
            "notmuch tag +{id} -- tag:new and path:\"{id}/**\"\n"
        ));

        for role in FolderRole::ALL {
            let Some(folder) = account.folder(role) else {
                continue;
            };
            // Sent mail is not unread. It was written here, and a Sent folder
            // that arrives with an unread count is the first thing anyone
            // notices about a new setup.
            let unread = match role {
                FolderRole::Sent | FolderRole::Drafts => " -unread",
                _ => "",
            };
            out.push_str(&format!(
                "notmuch tag +{}{unread} -- tag:new and path:\"{id}/{folder}/**\"\n",
                role.tag()
            ));
        }
        out.push('\n');
    }

    out.push_str("# Anything no rule above claimed is still mail somebody has to see.\n");
    out.push_str("notmuch tag +inbox -- tag:new and not tag:sent and not tag:draft \\\n");
    out.push_str("    and not tag:deleted and not tag:spam and not tag:archive\n");
    out.push_str("notmuch tag -new -- tag:new\n");

    out
}

fn patterns(account: &ManagedAccount) -> String {
    account
        .patterns()
        .iter()
        .map(|p| {
            // A space needs quoting for the obvious reason. Brackets need it for
            // a much quieter one: they are a character class in a pattern, so
            // `![Gmail]/Important` excludes a folder called `G/Important` and
            // Gmail's own is synced anyway — a duplicate copy of mail that is
            // already somewhere else, arriving with nothing to say why.
            //
            // The negation stays outside the quotes: `!"[Gmail]/All Mail"`.
            let needs_quoting = p.contains([' ', '[', ']', '"', '\\']);
            if !needs_quoting {
                return p.clone();
            }
            match p.strip_prefix('!') {
                Some(rest) => format!("!\"{}\"", escape(rest)),
                None => format!("\"{}\"", escape(p)),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn imap_tls(tls: Tls) -> &'static str {
    match tls {
        Tls::Implicit => "IMAPS",
        Tls::StartTls => "STARTTLS",
        Tls::None => "None",
    }
}

fn escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Whether a directory is a maildir ecr can already read.
pub fn is_maildir(dir: &Path) -> bool {
    dir.join("cur").is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::{MbsyncConfig, MsmtpConfig, NotmuchConfig};
    use ecr_core::managed::{Auth, Endpoint, Provider, Sides};
    use std::path::PathBuf;

    fn layout() -> Layout {
        Layout {
            maildir_root: PathBuf::from("/home/alice/.local/share/mail"),
            managed_dir: PathBuf::from("/home/alice/.config/ecr/managed"),
        }
    }

    fn accounts() -> ManagedAccounts {
        let mut accounts = ManagedAccounts {
            maildir: Some(layout().maildir_root),
            ..Default::default()
        };

        let mut main = ManagedAccount::new("alice@gmail.com", Provider::Gmail, Auth::oauth("main"));
        main.name = Some("Alice Example".into());
        main.primary = true;
        accounts.accounts.insert("main".into(), main);

        accounts.accounts.insert(
            "work".into(),
            ManagedAccount::new("alice@corp.example", Provider::Outlook, Auth::oauth("work")),
        );
        accounts
    }

    #[test]
    fn every_account_gets_a_channel_pointed_at_its_own_maildir() {
        let config = MbsyncConfig::parse(&mbsync(&accounts(), &layout()));

        assert_eq!(
            config.channel_maildir("main"),
            Some(&PathBuf::from("/home/alice/.local/share/mail/main/"))
        );
        assert_eq!(
            config
                .channel_imap_account("work")
                .and_then(|a| a.user.clone()),
            Some("alice@corp.example".into())
        );
    }

    /// The `PassCmd` is the only thing that tells doctor which OAuth profile
    /// backs an account, and it is read back with the same parser that reads a
    /// hand-written one.
    #[test]
    fn the_oauth_profile_survives_the_round_trip() {
        let config = MbsyncConfig::parse(&mbsync(&accounts(), &layout()));

        assert_eq!(
            config
                .channel_imap_account("main")
                .and_then(|a| a.oauth_profile()),
            Some("main")
        );
    }

    #[test]
    fn a_password_command_is_rendered_instead_of_a_token_command() {
        let mut accounts = accounts();
        accounts.accounts.get_mut("work").unwrap().auth = Auth::Command {
            command: vec!["pass".into(), "show".into(), "mail/work".into()],
        };

        let text = mbsync(&accounts, &layout());
        assert!(text.contains("PassCmd \"pass show mail/work\""), "{text}");
        assert!(text.contains("AuthMechs PLAIN"), "{text}");
    }

    /// Brackets are a character class in an mbsync pattern, so an unquoted
    /// `![Gmail]/Important` excludes a folder called `G/Important` and syncs
    /// Gmail's — a second copy of mail that is already elsewhere.
    #[test]
    fn every_bracketed_or_spaced_pattern_is_quoted_with_the_negation_outside() {
        let text = mbsync(&accounts(), &layout());
        assert!(
            text.contains(
                "Patterns * !\"[Gmail]/All Mail\" !\"[Gmail]/Important\" !\"[Gmail]/Starred\""
            ),
            "{text}"
        );
    }

    /// `from` is the envelope sender msmtp puts in `MAIL FROM`. A display name
    /// there is not an address — and `MsmtpConfig::parse` would read the whole
    /// string back as one, so the account's address would be wrong everywhere
    /// ecr shows it.
    #[test]
    fn msmtp_gets_the_bare_address_even_when_the_account_has_a_display_name() {
        let text = msmtp(&accounts());
        assert!(text.contains("from alice@gmail.com\n"), "{text}");
        assert!(!text.contains("Alice Example"), "{text}");

        let config = MsmtpConfig::parse(&text);
        assert_eq!(
            config.accounts.get("main").and_then(|a| a.from.clone()),
            Some("alice@gmail.com".into())
        );
    }

    #[test]
    fn a_disabled_account_is_not_rendered_at_all() {
        let mut accounts = accounts();
        accounts.accounts.get_mut("work").unwrap().enabled = false;

        let config = MbsyncConfig::parse(&mbsync(&accounts, &layout()));
        assert!(config.channels.contains_key("main"));
        assert!(!config.channels.contains_key("work"));
        assert!(!msmtp(&accounts).contains("alice@corp.example"));
    }

    #[test]
    fn expunge_is_written_as_chosen_and_defaults_to_neither_side() {
        let text = mbsync(&accounts(), &layout());
        assert!(text.contains("Expunge None"), "{text}");
        assert!(text.contains("Remove None"), "{text}");
        // A folder appearing on the server is fetched; ecr never creates one on
        // the server.
        assert!(text.contains("Create Near"), "{text}");

        let mut accounts = accounts();
        accounts.accounts.get_mut("main").unwrap().expunge = Sides::Both;
        assert!(mbsync(&accounts, &layout()).contains("Expunge Both"));
    }

    #[test]
    fn msmtp_names_an_account_per_maildir_and_a_default() {
        let config = MsmtpConfig::parse(&msmtp(&accounts()));

        assert_eq!(config.default_account.as_deref(), Some("main"));
        assert_eq!(
            config.accounts.get("work").and_then(|a| a.user.clone()),
            Some("alice@corp.example".into())
        );
        assert_eq!(
            config.account_for_address("alice@corp.example"),
            Some("work")
        );
    }

    #[test]
    fn oauth_sends_with_xoauth2_and_a_password_with_plain() {
        let text = msmtp(&accounts());
        assert!(text.contains("auth xoauth2"), "{text}");
        assert!(text.contains("passwordeval ecr oauth token main"), "{text}");
    }

    /// STARTTLS on 587 and implicit TLS on 465 are not interchangeable, and
    /// msmtp needs to be told which — `tls_starttls on` against port 465 hangs
    /// rather than failing.
    #[test]
    fn the_tls_mode_follows_the_port_it_was_chosen_with() {
        let mut accounts = accounts();
        accounts.accounts.get_mut("main").unwrap().smtp =
            Some(Endpoint::implicit_tls("smtp.example.com", 465));

        let text = msmtp(&accounts);
        assert!(text.contains("port 465"), "{text}");
        assert!(text.contains("tls_starttls off"), "{text}");
        // The other account still has its own.
        assert!(text.contains("port 587"), "{text}");
        assert!(text.contains("tls_starttls on"), "{text}");
    }

    #[test]
    fn notmuch_carries_the_root_the_accounts_chose_and_every_address() {
        let config = NotmuchConfig::parse(&notmuch(&accounts(), &layout()));

        assert_eq!(config.database_path, Some(layout().maildir_root));
        assert_eq!(config.primary_email.as_deref(), Some("alice@gmail.com"));
        assert_eq!(config.other_email, vec!["alice@corp.example"]);
        assert_eq!(config.user_name.as_deref(), Some("Alice Example"));
        assert!(config.new_tags.contains(&"new".to_string()));
    }

    #[test]
    fn the_generated_notmuch_config_indexes_the_list_header() {
        let text = notmuch(&accounts(), &layout());
        assert!(text.contains("header.List=List-Id"), "{text}");
        assert!(text.contains("synchronize_flags=true"), "{text}");
    }

    #[test]
    fn the_hook_starts_with_a_shebang_and_tags_by_account_then_folder() {
        let text = post_new(&accounts());

        assert!(text.starts_with("#!/bin/sh\n"), "{text}");
        assert!(
            text.contains("notmuch tag +main -- tag:new and path:\"main/**\""),
            "{text}"
        );
        assert!(
            text.contains(
                "notmuch tag +sent -unread -- tag:new and path:\"main/[Gmail]/Sent Mail/**\""
            ),
            "{text}"
        );
        // And it clears the marker, or the next run would retag everything.
        assert!(text.contains("notmuch tag -new -- tag:new"), "{text}");
    }

    /// The account tag has to be applied before `new` is cleared, or it matches
    /// nothing — the hook is one pass and the marker is what it selects on.
    #[test]
    fn the_hook_clears_the_new_marker_last() {
        let text = post_new(&accounts());
        let clears = text.find("tag -new").unwrap();

        assert!(text.find("tag +main").unwrap() < clears);
        assert!(text.find("tag +inbox").unwrap() < clears);
    }

    #[test]
    fn nothing_is_rendered_for_an_empty_account_list() {
        let empty = ManagedAccounts::default();
        assert_eq!(mbsync(&empty, &layout()), "");
        assert!(!msmtp(&empty).contains("account default"));
    }
}
