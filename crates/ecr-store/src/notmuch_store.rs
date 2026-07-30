use crate::error::Result;
use crate::notmuch::Notmuch;
use crate::paths::MailPaths;
use crate::store::{BodyOptions, MailStore, ProgressSink};
use crate::{discovery, mbsync, msmtp};
use ecr_core::account::{Account, AccountId};
use ecr_core::doctor::Doctor;
use ecr_core::message::{
    Body, Message, MessageId, Part, PartId, Query, SyncReport, TagOp, Thread, ThreadId,
    ThreadSummary,
};
use ecr_core::revision::Revision;
use std::sync::Arc;
use std::time::Instant;

pub struct NotmuchStore {
    paths: Arc<MailPaths>,
    notmuch: Notmuch,
}

impl NotmuchStore {
    pub fn open() -> Result<Self> {
        Ok(Self::new(Arc::new(MailPaths::discover()?)))
    }

    pub fn new(paths: Arc<MailPaths>) -> Self {
        Self {
            notmuch: Notmuch::new(Arc::clone(&paths)),
            paths,
        }
    }

    pub fn paths(&self) -> &MailPaths {
        &self.paths
    }

    pub fn notmuch(&self) -> &Notmuch {
        &self.notmuch
    }

    fn channels_for(&self, accounts: &[AccountId]) -> Vec<String> {
        let discovered = discovery::accounts(&self.paths);
        discovered
            .into_iter()
            .filter(|a| accounts.is_empty() || accounts.contains(&a.id))
            .filter_map(|a| a.mbsync_channel)
            .collect()
    }
}

impl MailStore for NotmuchStore {
    async fn revision(&self) -> Result<Revision> {
        self.notmuch.revision().await
    }

    async fn accounts(&self) -> Result<Vec<Account>> {
        Ok(discovery::accounts(&self.paths))
    }

    async fn search_threads(&self, query: &Query) -> Result<Vec<ThreadSummary>> {
        self.notmuch.search_threads(query).await
    }

    async fn count(&self, query: &Query) -> Result<usize> {
        self.notmuch.count(query).await
    }

    async fn thread(&self, id: &ThreadId) -> Result<Thread> {
        self.notmuch.thread(id).await
    }

    async fn message(&self, id: &MessageId) -> Result<Message> {
        self.notmuch.message_with_parts(id).await
    }

    async fn body(&self, id: &MessageId, options: BodyOptions) -> Result<Body> {
        self.notmuch
            .body(id, options.format, options.allow_remote_resources)
            .await
    }

    async fn part(&self, id: &MessageId, part: &PartId) -> Result<Part> {
        self.notmuch.part(id, part).await
    }

    async fn tag(&self, ops: &[TagOp]) -> Result<Revision> {
        self.notmuch.tag(ops).await
    }

    async fn sync(
        &self,
        accounts: &[AccountId],
        progress: &dyn ProgressSink,
    ) -> Result<SyncReport> {
        let started = Instant::now();
        let channels = self.channels_for(accounts);
        let before = self.notmuch.count(&Query::new("*")).await.unwrap_or(0);

        let warnings = mbsync::run(&self.paths, &channels, progress).await?;

        progress.line("indexing new mail");
        self.notmuch.index_new().await?;

        let after = self.notmuch.count(&Query::new("*")).await.unwrap_or(before);

        Ok(SyncReport {
            channels,
            new_messages: after.saturating_sub(before),
            duration_ms: started.elapsed().as_millis() as u64,
            warnings,
        })
    }

    async fn send(&self, account: &AccountId, raw: &[u8]) -> Result<()> {
        let accounts = discovery::accounts(&self.paths);
        let msmtp_account = accounts
            .iter()
            .find(|a| &a.id == account)
            .and_then(|a| a.msmtp_account.clone())
            .unwrap_or_else(|| account.to_string());

        msmtp::send(&self.paths, &msmtp_account, raw).await
    }

    async fn doctor(&self) -> Doctor {
        crate::doctor::run_with_paths(&self.paths).await
    }
}
