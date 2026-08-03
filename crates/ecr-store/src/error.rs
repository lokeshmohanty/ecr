use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("no {kind} configuration found (looked in: {})", .searched.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", "))]
    ConfigNotFound {
        kind: &'static str,
        searched: Vec<PathBuf>,
    },

    #[error("{path}: {message}")]
    ConfigParse { path: PathBuf, message: String },

    #[error("notmuch database.path is not set in {path}")]
    NoDatabasePath { path: PathBuf },

    #[error("maildir root {path} does not exist")]
    MaildirMissing { path: PathBuf },

    #[error("`{tool}` was not found on PATH")]
    ToolMissing { tool: &'static str },

    #[error("`{tool}` failed: {stderr}")]
    ToolFailed { tool: &'static str, stderr: String },

    #[error("no message with id {id}")]
    MessageNotFound { id: String },

    #[error("no part {part} in message {id}")]
    PartNotFound { id: String, part: u32 },

    #[error("could not parse message {id}: {message}")]
    MessageParse { id: String, message: String },

    #[error("invalid tag {tag:?}: {reason}")]
    InvalidTag { tag: String, reason: &'static str },

    #[error("no msmtp account named {account}")]
    UnknownSendAccount { account: String },

    #[error("cannot send this draft: {reason}")]
    InvalidDraft { reason: String },

    #[error("{path:?} is not a file ecr will read: {reason}")]
    UnsafePath { path: String, reason: &'static str },

    #[error("{0}")]
    Oauth(String),

    #[error("mail index: {0}")]
    Index(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// The index is a cache, so nothing it does is ever reported to a reader: the
/// error exists to be logged and fallen back from. Flattening SQLite's own
/// error into a string keeps rusqlite out of this crate's public surface.
impl From<rusqlite::Error> for Error {
    fn from(err: rusqlite::Error) -> Self {
        Error::Index(err.to_string())
    }
}
