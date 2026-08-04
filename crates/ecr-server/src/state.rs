use crate::auth::TokenStore;
use crate::events::EventBus;
use ecr_core::revision::Revision;
use ecr_store::NotmuchStore;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<NotmuchStore>,
    pub tokens: Arc<RwLock<TokenStore>>,
    pub events: EventBus,
    pub read_only: bool,
    /// Where the tokens came from, so they can be re-read. `None` when they
    /// were handed over directly, which is every test but the one below.
    token_path: Option<PathBuf>,
    /// What the token file looked like when it was last read.
    token_seen: Arc<RwLock<Option<Stamp>>>,
    /// The revision this server's own last tag write left behind. See
    /// `own_write`.
    written: Arc<RwLock<Option<Revision>>>,
}

impl AppState {
    pub fn new(store: Arc<NotmuchStore>, tokens: TokenStore, read_only: bool) -> Self {
        Self {
            store,
            tokens: Arc::new(RwLock::new(tokens)),
            events: EventBus::new(),
            read_only,
            token_path: None,
            token_seen: Arc::new(RwLock::new(None)),
            written: Arc::new(RwLock::new(None)),
        }
    }

    /// Names the file the tokens were read from, so a token issued while this
    /// server is running is one it will accept.
    pub fn with_token_file(mut self, path: PathBuf) -> Self {
        self.token_seen = Arc::new(RwLock::new(changed_at(&path)));
        self.token_path = Some(path);
        self
    }

    /// Re-reads the token store when the file has moved under it.
    ///
    /// `ecr token new` is a *different process*: it writes the file and exits,
    /// and a server holding the copy it read at startup goes on refusing the
    /// token that command just printed. The client reports *the server refused
    /// that token* about a token that is perfectly valid, and nothing on either
    /// side connects the two — the fix is to restart a server nobody has any
    /// reason to suspect.
    ///
    /// The mtime is what bounds the work: an ordinary request pays one `stat`
    /// and the file is read only when it has actually changed.
    ///
    /// A read that fails is kept rather than adopted. `TokenStore::save`
    /// truncates before it writes, so a request landing in that window sees a
    /// partial file — and taking a parse error for an empty store would turn
    /// authentication off on a running server at the exact moment someone is
    /// issuing a token.
    pub async fn refresh_tokens(&self) {
        let Some(path) = &self.token_path else { return };

        let found = changed_at(path);
        if *self.token_seen.read().await == found {
            return;
        }

        match TokenStore::load(path) {
            Ok(loaded) => {
                *self.tokens.write().await = loaded;
                *self.token_seen.write().await = found;
            }
            Err(error) => tracing::warn!(
                path = %path.display(),
                %error,
                "could not re-read the token store; keeping the tokens already loaded"
            ),
        }
    }

    pub async fn requires_auth(&self) -> bool {
        !self.tokens.read().await.is_empty()
    }

    /// Remembers what a tag write left the database at. notmuch synchronises
    /// maildir flags, so dropping `unread` renames the file — which the
    /// delivery watcher sees, and would otherwise announce as new mail.
    pub async fn note_own_write(&self, revision: &Revision) {
        *self.written.write().await = Some(revision.clone());
    }

    /// Whether the database still stands exactly where this server's own last
    /// write left it, meaning nothing has been delivered since.
    pub async fn own_write(&self, observed: &Revision) -> bool {
        self.written.read().await.as_ref() == Some(observed)
    }
}

/// The length as well as the mtime, because mtime granularity is a property of
/// the filesystem rather than of Linux: a second write inside the same tick is
/// invisible where that tick is a whole second, and `ecr token new` twice in a
/// row is an ordinary thing to do.
type Stamp = (SystemTime, u64);

/// `None` for a file that is not there, which is a state the token store has:
/// it does not exist until the first token is issued, and deleting it is how a
/// server is put back to serving everyone.
fn changed_at(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}
