use crate::auth::TokenStore;
use crate::events::EventBus;
use ecr_core::revision::Revision;
use ecr_store::NotmuchStore;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<NotmuchStore>,
    pub tokens: Arc<RwLock<TokenStore>>,
    pub events: EventBus,
    pub read_only: bool,
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
            written: Arc::new(RwLock::new(None)),
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
