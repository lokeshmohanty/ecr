use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotmuchConfig {
    pub database_path: Option<PathBuf>,
    pub mail_root: Option<PathBuf>,
    pub primary_email: Option<String>,
    pub other_email: Vec<String>,
    pub user_name: Option<String>,
    pub exclude_tags: Vec<String>,
    pub new_tags: Vec<String>,
}

impl NotmuchConfig {
    pub fn parse(text: &str) -> Self {
        let mut cfg = NotmuchConfig::default();
        let mut section = String::new();

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
                continue;
            }
            if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
                section = name.trim().to_ascii_lowercase();
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim();

            match (section.as_str(), key.as_str()) {
                ("database", "path") => cfg.database_path = Some(PathBuf::from(value)),
                ("database", "mail_root") => cfg.mail_root = Some(PathBuf::from(value)),
                ("user", "primary_email") => cfg.primary_email = non_empty(value),
                ("user", "other_email") => cfg.other_email = split_list(value),
                ("user", "name") => cfg.user_name = non_empty(value),
                ("search", "exclude_tags") => cfg.exclude_tags = split_list(value),
                ("new", "tags") => cfg.new_tags = split_list(value),
                _ => {}
            }
        }
        cfg
    }

    pub fn effective_mail_root(&self) -> Option<&PathBuf> {
        self.mail_root.as_ref().or(self.database_path.as_ref())
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MbsyncConfig {
    pub maildir_stores: BTreeMap<String, MaildirStore>,
    pub channels: BTreeMap<String, Channel>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MaildirStore {
    pub path: Option<PathBuf>,
    pub inbox: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Channel {
    pub far: Option<String>,
    pub near: Option<String>,
}

impl Channel {
    pub fn near_store(&self) -> Option<&str> {
        self.near.as_deref().map(strip_store_ref)
    }
}

fn strip_store_ref(value: &str) -> &str {
    value
        .trim()
        .trim_matches(':')
        .split(':')
        .next()
        .unwrap_or("")
}

enum Block {
    MaildirStore(String),
    Channel(String),
    Other,
}

impl MbsyncConfig {
    pub fn parse(text: &str) -> Self {
        let mut cfg = MbsyncConfig::default();
        let mut block = Block::Other;

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (keyword, rest) = match line.split_once(char::is_whitespace) {
                Some((k, r)) => (k, r.trim()),
                None => (line, ""),
            };

            match keyword.to_ascii_lowercase().as_str() {
                "maildirstore" => {
                    block = Block::MaildirStore(rest.to_string());
                    cfg.maildir_stores.entry(rest.to_string()).or_default();
                }
                "channel" => {
                    block = Block::Channel(rest.to_string());
                    cfg.channels.entry(rest.to_string()).or_default();
                }
                "imapaccount" | "imapstore" | "group" => block = Block::Other,
                "path" => {
                    if let Block::MaildirStore(name) = &block {
                        if let Some(store) = cfg.maildir_stores.get_mut(name) {
                            store.path = Some(PathBuf::from(rest));
                        }
                    }
                }
                "inbox" => {
                    if let Block::MaildirStore(name) = &block {
                        if let Some(store) = cfg.maildir_stores.get_mut(name) {
                            store.inbox = Some(PathBuf::from(rest));
                        }
                    }
                }
                "far" => {
                    if let Block::Channel(name) = &block {
                        if let Some(channel) = cfg.channels.get_mut(name) {
                            channel.far = Some(rest.to_string());
                        }
                    }
                }
                "near" => {
                    if let Block::Channel(name) = &block {
                        if let Some(channel) = cfg.channels.get_mut(name) {
                            channel.near = Some(rest.to_string());
                        }
                    }
                }
                _ => {}
            }
        }
        cfg
    }

    pub fn channel_maildir(&self, channel: &str) -> Option<&PathBuf> {
        let store = self.channels.get(channel)?.near_store()?;
        self.maildir_stores.get(store)?.path.as_ref()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MsmtpConfig {
    pub accounts: BTreeMap<String, MsmtpAccount>,
    pub default_account: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MsmtpAccount {
    pub from: Option<String>,
    pub user: Option<String>,
}

impl MsmtpConfig {
    pub fn parse(text: &str) -> Self {
        let mut cfg = MsmtpConfig::default();
        let mut current: Option<String> = None;

        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (keyword, rest) = match line.split_once(char::is_whitespace) {
                Some((k, r)) => (k, r.trim()),
                None => (line, ""),
            };

            match keyword.to_ascii_lowercase().as_str() {
                "account" => {
                    if let Some((alias, target)) = rest.split_once(':') {
                        let alias = alias.trim();
                        let target = target.trim();
                        if alias == "default" {
                            cfg.default_account = Some(target.to_string());
                        }
                        current = Some(target.to_string());
                    } else {
                        cfg.accounts.entry(rest.to_string()).or_default();
                        current = Some(rest.to_string());
                    }
                }
                "from" => {
                    if let Some(name) = &current {
                        cfg.accounts.entry(name.clone()).or_default().from = non_empty(rest);
                    }
                }
                "user" => {
                    if let Some(name) = &current {
                        cfg.accounts.entry(name.clone()).or_default().user = non_empty(rest);
                    }
                }
                _ => {}
            }
        }
        cfg
    }

    pub fn account_for_address(&self, address: &str) -> Option<&str> {
        self.accounts
            .iter()
            .find(|(_, a)| a.from.as_deref() == Some(address) || a.user.as_deref() == Some(address))
            .map(|(name, _)| name.as_str())
    }
}

fn non_empty(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(';')
        .flat_map(|part| part.split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE_NOTMUCH: &str = r#"
# Generated by Home Manager.

[database]
path=/home/alice/.local/share/Mail

[maildir]
synchronize_flags=true

[new]
ignore=.uidvalidity;.mbsyncstate
tags=new;unread

[search]
exclude_tags=deleted;spam;trash

[user]
name=Lokesh Mohanty
other_email=
primary_email=alice@example.com
"#;

    #[test]
    fn parses_the_live_notmuch_config() {
        let cfg = NotmuchConfig::parse(LIVE_NOTMUCH);
        assert_eq!(
            cfg.database_path,
            Some(PathBuf::from("/home/alice/.local/share/Mail"))
        );
        assert_eq!(cfg.primary_email.as_deref(), Some("alice@example.com"));
        assert_eq!(cfg.user_name.as_deref(), Some("Lokesh Mohanty"));
        assert_eq!(cfg.exclude_tags, vec!["deleted", "spam", "trash"]);
        assert_eq!(cfg.new_tags, vec!["new", "unread"]);
        assert!(cfg.other_email.is_empty());
    }

    #[test]
    fn mail_root_falls_back_to_database_path() {
        let cfg = NotmuchConfig::parse(LIVE_NOTMUCH);
        assert_eq!(
            cfg.effective_mail_root(),
            Some(&PathBuf::from("/home/alice/.local/share/Mail"))
        );
    }

    #[test]
    fn explicit_mail_root_wins_over_database_path() {
        let cfg = NotmuchConfig::parse(
            "[database]\npath=/var/lib/notmuch\nmail_root=/home/alice/Mail\n",
        );
        assert_eq!(
            cfg.effective_mail_root(),
            Some(&PathBuf::from("/home/alice/Mail"))
        );
    }

    const LIVE_ISYNCRC: &str = r#"
# Generated by Home Manager.

IMAPAccount main
AuthMechs XOAUTH2
Host imap.gmail.com
Port 993
User alice@example.com

IMAPStore main-remote
Account main

MaildirStore main-local
Inbox /home/alice/.local/share/Mail/main/Inbox
Path /home/alice/.local/share/Mail/main/
SubFolders Verbatim

Channel main
Create Near
Expunge Both
Far :main-remote:
Near :main-local:
Patterns *
"#;

    #[test]
    fn parses_the_live_isyncrc() {
        let cfg = MbsyncConfig::parse(LIVE_ISYNCRC);
        assert_eq!(cfg.channels.len(), 1);
        assert!(cfg.channels.contains_key("main"));
        assert_eq!(
            cfg.maildir_stores["main-local"].path,
            Some(PathBuf::from("/home/alice/.local/share/Mail/main/"))
        );
    }

    #[test]
    fn channel_resolves_through_its_near_store() {
        let cfg = MbsyncConfig::parse(LIVE_ISYNCRC);
        assert_eq!(
            cfg.channel_maildir("main"),
            Some(&PathBuf::from("/home/alice/.local/share/Mail/main/"))
        );
    }

    #[test]
    fn account_keywords_do_not_leak_into_the_maildir_store() {
        let cfg = MbsyncConfig::parse(LIVE_ISYNCRC);
        assert_eq!(cfg.maildir_stores.len(), 1);
        assert!(!cfg.maildir_stores.contains_key("main"));
    }

    const LIVE_MSMTP: &str = r#"
# Generated by Home Manager.
account main
auth xoauth2
from alice@example.com
host smtp.gmail.com
user alice@example.com
account default : main
"#;

    #[test]
    fn parses_the_live_msmtp_config() {
        let cfg = MsmtpConfig::parse(LIVE_MSMTP);
        assert_eq!(cfg.default_account.as_deref(), Some("main"));
        assert_eq!(
            cfg.accounts["main"].from.as_deref(),
            Some("alice@example.com")
        );
    }

    #[test]
    fn finds_the_account_serving_an_address() {
        let cfg = MsmtpConfig::parse(LIVE_MSMTP);
        assert_eq!(
            cfg.account_for_address("alice@example.com"),
            Some("main")
        );
        assert_eq!(cfg.account_for_address("nobody@example.com"), None);
    }
}
