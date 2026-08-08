//! The accounts ecr holds itself, when it is managing the configuration.
//!
//! This is an *input*. What an account **is** stays what it has always been — a
//! directory under the maildir root, found by `discovery::accounts` — and
//! nothing here is consulted at read time. An account described here and never
//! synced does not exist yet, which is the honest answer and the one that keeps
//! `ecr doctor`, reply identities and the sidebar working exactly as they did.
//!
//! The provider presets are the whole reason this beats asking four questions:
//! Gmail's folders are not called what anyone would guess, and the difference
//! between an account that syncs and one that silently misses half its mail is
//! `Patterns` excluding `[Gmail]/All Mail`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedAccounts {
    /// Where every account's maildir lives.
    ///
    /// This is the one place the root is *chosen*. It is written into the
    /// generated notmuch config as `database.path` and read back out of there by
    /// `MailPaths` like any other, so the rule that the maildir root comes from
    /// notmuch — never from a guess, never from `dirs::data_dir()` — still holds
    /// with nothing about it special-cased for managed mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maildir: Option<std::path::PathBuf>,
    /// The name on the `From:` line, when no account overrides it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// notmuch's `search.exclude_tags`.
    ///
    /// Carried here rather than fixed in the renderer because it decides what
    /// *every* query in ecr returns, and it is the kind of thing a reader has
    /// already tuned — a setup with `trash` in this list and a generated config
    /// without it is one where deleted mail silently reappears in every search.
    /// The mail index is built against it too.
    #[serde(default = "default_exclude_tags")]
    pub exclude_tags: Vec<String>,
    /// Keyed by the directory name under the maildir root, which is the id
    /// every other part of ecr already calls an account by.
    #[serde(default, rename = "account")]
    pub accounts: BTreeMap<String, ManagedAccount>,
}

fn default_exclude_tags() -> Vec<String> {
    vec!["deleted".into(), "spam".into()]
}

impl Default for ManagedAccounts {
    fn default() -> Self {
        Self {
            maildir: None,
            name: None,
            exclude_tags: default_exclude_tags(),
            accounts: BTreeMap::new(),
        }
    }
}

impl ManagedAccounts {
    pub fn is_empty(&self) -> bool {
        self.accounts.is_empty()
    }

    /// In the order they are rendered and offered: insertion is alphabetical by
    /// id, because a `BTreeMap` is what keeps a regenerated file byte-identical.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &ManagedAccount)> {
        self.accounts.iter()
    }

    pub fn enabled(&self) -> impl Iterator<Item = (&String, &ManagedAccount)> {
        self.accounts.iter().filter(|(_, a)| a.enabled)
    }

    /// The account whose address goes in the notmuch config's `primary_email`
    /// and which msmtp answers to as `default`.
    pub fn primary(&self) -> Option<(&String, &ManagedAccount)> {
        self.accounts
            .iter()
            .find(|(_, a)| a.enabled && a.primary)
            .or_else(|| self.enabled().next())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedAccount {
    pub address: String,
    /// The display name on the `From:` line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub provider: Provider,
    pub auth: Auth,
    /// Set only when this account does not take its provider's endpoints.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imap: Option<Endpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smtp: Option<Endpoint>,
    /// Overrides on top of the provider's folder names. Absent keys take the
    /// preset's.
    #[serde(default, skip_serializing_if = "Folders::is_empty")]
    pub folders: Folders,
    /// mbsync `Patterns`. Empty takes the provider's, which is not the same as
    /// matching nothing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub patterns: Vec<String>,
    /// Where a folder that appears on one side is created on the other.
    #[serde(default = "create_near")]
    pub create: Sides,
    /// Where a message marked deleted is actually removed.
    #[serde(default)]
    pub expunge: Sides,
    /// Where a folder that disappears from one side is removed from the other.
    #[serde(default)]
    pub remove: Sides,
    /// A CA bundle for mbsync, where the system's own is not where it looks.
    /// Carried across on import rather than dropped: a missing one is a TLS
    /// failure on every channel, out of a config that reads as complete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub certificate_file: Option<std::path::PathBuf>,
    /// Whether this account's identity is the default one.
    #[serde(default)]
    pub primary: bool,
    /// A disabled account keeps its configuration and stops being synced or
    /// rendered. Deleting an account is a separate act, and one that has to
    /// answer what happens to its mail.
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

impl ManagedAccount {
    pub fn new(address: impl Into<String>, provider: Provider, auth: Auth) -> Self {
        Self {
            address: address.into(),
            name: None,
            provider,
            auth,
            imap: None,
            smtp: None,
            folders: Folders::default(),
            patterns: Vec::new(),
            create: create_near(),
            expunge: Sides::default(),
            remove: Sides::default(),
            certificate_file: None,
            primary: false,
            enabled: true,
        }
    }

    pub fn imap(&self) -> Option<Endpoint> {
        self.imap.clone().or_else(|| self.provider.imap())
    }

    pub fn smtp(&self) -> Option<Endpoint> {
        self.smtp.clone().or_else(|| self.provider.smtp())
    }

    pub fn folder(&self, role: FolderRole) -> Option<String> {
        self.folders
            .get(role)
            .cloned()
            .or_else(|| self.provider.folders().get(role).cloned())
    }

    pub fn patterns(&self) -> Vec<String> {
        if self.patterns.is_empty() {
            self.provider.patterns()
        } else {
            self.patterns.clone()
        }
    }

    /// The OAuth profile behind this account, if it authenticates that way.
    pub fn oauth_profile(&self) -> Option<&str> {
        match &self.auth {
            Auth::Oauth { profile } => Some(profile),
            Auth::Command { .. } => None,
        }
    }

    /// What ecr can say about this account before anything has been tried.
    ///
    /// Rendering a configuration that cannot work and letting mbsync report it
    /// is the worse failure: it arrives as a sync error naming a host, minutes
    /// later, rather than as an answer to what was just typed.
    pub fn problems(&self, id: &str) -> Vec<String> {
        let mut out = Vec::new();

        if !is_a_directory_name(id) {
            out.push(format!(
                "{id:?} is a directory name under the maildir root, so it cannot be empty, \
                 start with a dot, or contain a slash"
            ));
        }
        if !self.address.contains('@') {
            out.push(format!("{:?} is not an email address", self.address));
        }
        if self.imap().is_none() {
            out.push(format!(
                "the {} provider has no built-in IMAP host, so this account needs an explicit one",
                self.provider
            ));
        }
        if self.smtp().is_none() {
            out.push(format!(
                "the {} provider has no built-in SMTP host, so this account needs an explicit one",
                self.provider
            ));
        }
        if let Auth::Command { command } = &self.auth {
            if command.is_empty() {
                out.push("the password command is empty".to_string());
            }
        }
        if let Auth::Oauth { profile } = &self.auth {
            if profile.is_empty() {
                out.push("the OAuth profile has no name".to_string());
            }
        }
        out
    }
}

/// A maildir under the root, and a notmuch `path:` prefix. Neither tolerates a
/// separator, and a leading dot hides the account from `discovery::accounts`
/// altogether — which reads as the account not having been added.
fn is_a_directory_name(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('.')
        && !id.contains('/')
        && !id.contains('\\')
        && id.chars().all(|c| !c.is_control())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Gmail,
    Outlook,
    Fastmail,
    /// Everything else: the endpoints have to be given.
    Generic,
}

impl std::fmt::Display for Provider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Provider::Gmail => "gmail",
            Provider::Outlook => "outlook",
            Provider::Fastmail => "fastmail",
            Provider::Generic => "generic",
        })
    }
}

impl std::str::FromStr for Provider {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "gmail" | "google" => Ok(Provider::Gmail),
            "outlook" | "microsoft" | "office365" | "hotmail" => Ok(Provider::Outlook),
            "fastmail" => Ok(Provider::Fastmail),
            "generic" | "imap" | "other" => Ok(Provider::Generic),
            other => Err(format!(
                "unknown provider {other:?}; known providers: gmail, outlook, fastmail, generic"
            )),
        }
    }
}

impl Provider {
    pub const ALL: [Provider; 4] = [
        Provider::Gmail,
        Provider::Outlook,
        Provider::Fastmail,
        Provider::Generic,
    ];

    /// Which `ecr oauth` provider backs this one, if any. Fastmail and a generic
    /// IMAP host authenticate with a password, which ecr does not store — a
    /// command that prints one is what they get.
    pub fn oauth_provider(&self) -> Option<&'static str> {
        match self {
            Provider::Gmail => Some("gmail"),
            Provider::Outlook => Some("microsoft"),
            Provider::Fastmail | Provider::Generic => None,
        }
    }

    pub fn imap(&self) -> Option<Endpoint> {
        match self {
            Provider::Gmail => Some(Endpoint::implicit_tls("imap.gmail.com", 993)),
            Provider::Outlook => Some(Endpoint::implicit_tls("outlook.office365.com", 993)),
            Provider::Fastmail => Some(Endpoint::implicit_tls("imap.fastmail.com", 993)),
            Provider::Generic => None,
        }
    }

    /// STARTTLS on 587 for the two OAuth providers, because that is the port
    /// their documentation and every other client agree on; Fastmail publishes
    /// 465, which is implicit TLS.
    pub fn smtp(&self) -> Option<Endpoint> {
        match self {
            Provider::Gmail => Some(Endpoint::starttls("smtp.gmail.com", 587)),
            Provider::Outlook => Some(Endpoint::starttls("smtp.office365.com", 587)),
            Provider::Fastmail => Some(Endpoint::implicit_tls("smtp.fastmail.com", 465)),
            Provider::Generic => None,
        }
    }

    pub fn folders(&self) -> Folders {
        match self {
            // Gmail's archive is `[Gmail]/All Mail`, which is deliberately not
            // named here: it holds a copy of every message in the account, so
            // syncing it doubles the maildir and gives notmuch two files per
            // message. Archiving in Gmail is the *absence* of the inbox label,
            // and that is what removing `inbox` already expresses.
            Provider::Gmail => Folders {
                inbox: Some("Inbox".into()),
                sent: Some("[Gmail]/Sent Mail".into()),
                drafts: Some("[Gmail]/Drafts".into()),
                trash: Some("[Gmail]/Trash".into()),
                junk: Some("[Gmail]/Spam".into()),
                archive: None,
            },
            Provider::Outlook => Folders {
                inbox: Some("Inbox".into()),
                sent: Some("Sent Items".into()),
                drafts: Some("Drafts".into()),
                trash: Some("Deleted Items".into()),
                junk: Some("Junk Email".into()),
                archive: Some("Archive".into()),
            },
            Provider::Fastmail | Provider::Generic => Folders {
                inbox: Some("INBOX".into()),
                sent: Some("Sent".into()),
                drafts: Some("Drafts".into()),
                trash: Some("Trash".into()),
                junk: Some("Spam".into()),
                archive: Some("Archive".into()),
            },
        }
    }

    pub fn patterns(&self) -> Vec<String> {
        match self {
            // `All Mail` for the reason above; `Important` and `Starred` are
            // views of mail that is already in another folder, so syncing them
            // is the same duplication in miniature.
            Provider::Gmail => vec![
                "*".into(),
                "![Gmail]/All Mail".into(),
                "![Gmail]/Important".into(),
                "![Gmail]/Starred".into(),
            ],
            _ => vec!["*".into()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub tls: Tls,
}

impl Endpoint {
    pub fn implicit_tls(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            tls: Tls::Implicit,
        }
    }

    pub fn starttls(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            tls: Tls::StartTls,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tls {
    /// TLS from the first byte: IMAPS on 993, SMTPS on 465.
    Implicit,
    StartTls,
    /// Plaintext. Only ever a deliberate choice for a server on the same
    /// machine, and named as plainly as that.
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Auth {
    /// The XOAUTH2 that `ecr oauth token <profile>` prints.
    Oauth { profile: String },
    /// A command that prints a password on stdout — `pass show`, `secret-tool`,
    /// or anything else. ecr never stores the password itself.
    Command { command: Vec<String> },
}

impl Auth {
    pub fn oauth(profile: impl Into<String>) -> Self {
        Auth::Oauth {
            profile: profile.into(),
        }
    }

    /// What mbsync's `PassCmd` and msmtp's `passwordeval` are given.
    pub fn password_command(&self) -> String {
        match self {
            Auth::Oauth { profile } => format!("ecr oauth token {profile}"),
            Auth::Command { command } => command.join(" "),
        }
    }

    pub fn mechanism(&self) -> &'static str {
        match self {
            Auth::Oauth { .. } => "XOAUTH2",
            Auth::Command { .. } => "PLAIN",
        }
    }
}

/// How far a creation, a deletion or an expunge travels.
///
/// `Near` is the local maildir, `Far` is the server. The distinction is the
/// whole of mbsync's safety model, and ecr's defaults sit at the cautious end of
/// it: [`ManagedAccount::create`] is `Near`, so a folder appearing on the server
/// is fetched but ecr never creates one *on* the server; [`ManagedAccount::expunge`]
/// and [`ManagedAccount::remove`] are `None`, because ecr expresses deletion as
/// a tag and never unlinks a message file, so nothing local is waiting to
/// propagate and a reader who has not asked for deletions to cross the network
/// should not find out that they do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sides {
    #[default]
    None,
    Near,
    Far,
    Both,
}

impl Sides {
    /// mbsync spells these with a capital.
    pub fn as_mbsync(&self) -> &'static str {
        match self {
            Sides::None => "None",
            Sides::Near => "Near",
            Sides::Far => "Far",
            Sides::Both => "Both",
        }
    }

    /// What an imported config said, if it said anything ecr understands.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "none" => Some(Sides::None),
            "near" | "slave" => Some(Sides::Near),
            "far" | "master" => Some(Sides::Far),
            "both" => Some(Sides::Both),
            _ => None,
        }
    }
}

fn create_near() -> Sides {
    Sides::Near
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FolderRole {
    Inbox,
    Sent,
    Drafts,
    Trash,
    Junk,
    Archive,
}

impl FolderRole {
    pub const ALL: [FolderRole; 6] = [
        FolderRole::Inbox,
        FolderRole::Sent,
        FolderRole::Drafts,
        FolderRole::Trash,
        FolderRole::Junk,
        FolderRole::Archive,
    ];

    /// The tag the `post-new` hook puts on mail in this folder. `Inbox` is the
    /// one everything else is defined against, and it is `inbox` because that is
    /// what the sidebar's first row has always searched for.
    pub fn tag(&self) -> &'static str {
        match self {
            FolderRole::Inbox => "inbox",
            FolderRole::Sent => "sent",
            FolderRole::Drafts => "draft",
            FolderRole::Trash => "deleted",
            FolderRole::Junk => "spam",
            FolderRole::Archive => "archive",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folders {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drafts: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub junk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archive: Option<String>,
}

impl Folders {
    pub fn is_empty(&self) -> bool {
        FolderRole::ALL.iter().all(|r| self.get(*r).is_none())
    }

    pub fn get(&self, role: FolderRole) -> Option<&String> {
        match role {
            FolderRole::Inbox => self.inbox.as_ref(),
            FolderRole::Sent => self.sent.as_ref(),
            FolderRole::Drafts => self.drafts.as_ref(),
            FolderRole::Trash => self.trash.as_ref(),
            FolderRole::Junk => self.junk.as_ref(),
            FolderRole::Archive => self.archive.as_ref(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gmail() -> ManagedAccount {
        ManagedAccount::new("alice@gmail.com", Provider::Gmail, Auth::oauth("main"))
    }

    #[test]
    fn a_preset_supplies_the_endpoints_and_an_override_wins() {
        let mut account = gmail();
        assert_eq!(account.imap().unwrap().host, "imap.gmail.com");

        account.imap = Some(Endpoint::implicit_tls("imap.example.com", 993));
        assert_eq!(account.imap().unwrap().host, "imap.example.com");
    }

    #[test]
    fn a_generic_account_has_to_be_told_where_its_server_is() {
        let account = ManagedAccount::new(
            "me@example.com",
            Provider::Generic,
            Auth::Command {
                command: vec!["pass".into(), "show".into(), "mail".into()],
            },
        );

        let problems = account.problems("main");
        assert!(problems.iter().any(|p| p.contains("IMAP")), "{problems:?}");
        assert!(problems.iter().any(|p| p.contains("SMTP")), "{problems:?}");
    }

    /// Gmail's All Mail holds a copy of every message in the account. Syncing it
    /// doubles the maildir and gives notmuch two files for every message, which
    /// reads as duplicates in the thread list rather than as a sync setting.
    #[test]
    fn the_gmail_preset_excludes_the_folders_that_duplicate_every_message() {
        let patterns = gmail().patterns();
        assert!(patterns.contains(&"*".to_string()));
        assert!(patterns.iter().any(|p| p == "![Gmail]/All Mail"));
        assert_eq!(gmail().folder(FolderRole::Archive), None);
        assert_eq!(
            gmail().folder(FolderRole::Sent).as_deref(),
            Some("[Gmail]/Sent Mail")
        );
    }

    #[test]
    fn a_folder_override_lands_on_top_of_the_preset() {
        let mut account = gmail();
        account.folders.sent = Some("Sent".into());

        assert_eq!(account.folder(FolderRole::Sent).as_deref(), Some("Sent"));
        assert_eq!(
            account.folder(FolderRole::Trash).as_deref(),
            Some("[Gmail]/Trash")
        );
    }

    #[test]
    fn an_id_that_is_not_a_directory_name_is_refused() {
        for id in ["", ".hidden", "a/b", "with\\slash"] {
            assert!(
                !gmail().problems(id).is_empty(),
                "{id:?} was accepted as an account id"
            );
        }
        assert!(gmail().problems("main").is_empty());
    }

    #[test]
    fn oauth_renders_the_command_that_mints_a_token() {
        assert_eq!(
            Auth::oauth("main").password_command(),
            "ecr oauth token main"
        );
        assert_eq!(
            Auth::Command {
                command: vec!["pass".into(), "show".into(), "mail/fastmail".into()]
            }
            .password_command(),
            "pass show mail/fastmail"
        );
    }

    /// Deletion in ecr is a tag, and no message file is ever unlinked. A default
    /// that propagated deletes would therefore be propagating an intent nobody
    /// expressed.
    #[test]
    fn expunge_defaults_to_neither_side() {
        assert_eq!(Sides::default(), Sides::None);
        assert_eq!(Sides::default().as_mbsync(), "None");
    }

    #[test]
    fn the_primary_account_falls_back_to_the_only_one() {
        let mut accounts = ManagedAccounts::default();
        accounts.accounts.insert("work".into(), gmail());
        assert_eq!(accounts.primary().unwrap().0, "work");

        let mut personal = gmail();
        personal.primary = true;
        accounts.accounts.insert("personal".into(), personal);
        assert_eq!(accounts.primary().unwrap().0, "personal");
    }

    #[test]
    fn a_disabled_account_is_never_the_primary_one() {
        let mut accounts = ManagedAccounts::default();
        let mut off = gmail();
        off.enabled = false;
        off.primary = true;
        accounts.accounts.insert("aaa-off".into(), off);
        accounts.accounts.insert("bbb-on".into(), gmail());

        assert_eq!(accounts.primary().unwrap().0, "bbb-on");
    }

    #[test]
    fn providers_round_trip_through_their_names() {
        for provider in Provider::ALL {
            assert_eq!(
                provider.to_string().parse::<Provider>().unwrap(),
                provider,
                "{provider}"
            );
        }
        assert!("yahoo".parse::<Provider>().is_err());
    }
}
