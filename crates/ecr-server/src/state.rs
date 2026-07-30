use crate::auth::TokenStore;
use crate::events::EventBus;
use ecr_store::NotmuchStore;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<NotmuchStore>,
    pub tokens: Arc<RwLock<TokenStore>>,
    pub events: EventBus,
    pub read_only: bool,
}

impl AppState {
    pub fn new(store: Arc<NotmuchStore>, tokens: TokenStore, read_only: bool) -> Self {
        Self {
            store,
            tokens: Arc::new(RwLock::new(tokens)),
            events: EventBus::new(),
            read_only,
        }
    }

    pub async fn requires_auth(&self) -> bool {
        !self.tokens.read().await.is_empty()
    }
}
