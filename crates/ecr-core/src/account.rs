use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct AccountId(pub String);

impl AccountId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for AccountId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for AccountId {
    fn from(s: &str) -> Self {
        AccountId(s.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub id: AccountId,
    pub display_name: String,
    pub maildir_path: PathBuf,
    pub address: Option<String>,
    pub mbsync_channel: Option<String>,
    pub msmtp_account: Option<String>,
    pub folders: Vec<Folder>,
}

impl Account {
    pub fn tag_query(&self) -> String {
        format!("tag:{}", self.id)
    }

    pub fn path_query(&self) -> String {
        format!("path:\"{}/**\"", self.id)
    }

    pub fn folder(&self, name: &str) -> Option<&Folder> {
        self.folders.iter().find(|f| f.name == name)
    }

    pub fn can_sync(&self) -> bool {
        self.mbsync_channel.is_some()
    }

    pub fn can_send(&self) -> bool {
        self.msmtp_account.is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderKind {
    Inbox,
    Sent,
    Drafts,
    Trash,
    Junk,
    Archive,
    Other,
}

impl FolderKind {
    pub fn classify(name: &str) -> Self {
        let leaf = name.rsplit('/').next().unwrap_or(name);
        match leaf.to_ascii_lowercase().as_str() {
            "inbox" => FolderKind::Inbox,
            "sent" | "sent mail" | "sent items" => FolderKind::Sent,
            "drafts" | "draft" => FolderKind::Drafts,
            "trash" | "deleted items" | "bin" => FolderKind::Trash,
            "junk" | "spam" => FolderKind::Junk,
            "archive" | "all mail" => FolderKind::Archive,
            _ => FolderKind::Other,
        }
    }

    pub fn sort_rank(&self) -> u8 {
        match self {
            FolderKind::Inbox => 0,
            FolderKind::Drafts => 1,
            FolderKind::Sent => 2,
            FolderKind::Archive => 3,
            FolderKind::Junk => 4,
            FolderKind::Trash => 5,
            FolderKind::Other => 6,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    pub name: String,
    pub relative_path: String,
    pub kind: FolderKind,
}

impl Folder {
    pub fn new(account: &AccountId, relative_path: impl Into<String>) -> Self {
        let relative_path = relative_path.into();
        let name = relative_path.clone();
        Self {
            kind: FolderKind::classify(&name),
            relative_path: format!("{account}/{relative_path}"),
            name,
        }
    }

    pub fn query(&self) -> String {
        format!("path:\"{}/**\"", self.relative_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_query_is_recursive_and_quoted() {
        let folder = Folder::new(&AccountId::from("main"), "Inbox");
        assert_eq!(folder.query(), "path:\"main/Inbox/**\"");
    }

    #[test]
    fn folder_names_with_spaces_stay_quoted() {
        let folder = Folder::new(&AccountId::from("main"), "General Payments");
        assert_eq!(folder.query(), "path:\"main/General Payments/**\"");
    }

    #[test]
    fn gmail_style_nested_folders_classify_on_the_leaf() {
        assert_eq!(FolderKind::classify("[Gmail]/Sent Mail"), FolderKind::Sent);
        assert_eq!(
            FolderKind::classify("[Gmail]/All Mail"),
            FolderKind::Archive
        );
        assert_eq!(FolderKind::classify("Swiggy"), FolderKind::Other);
    }

    #[test]
    fn classification_is_case_insensitive() {
        assert_eq!(FolderKind::classify("INBOX"), FolderKind::Inbox);
        assert_eq!(FolderKind::classify("Junk"), FolderKind::Junk);
    }
}
