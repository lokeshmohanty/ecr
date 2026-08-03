use crate::error::{Error, Result};
use crate::index::{Freshness, IndexStatus, MessageIndex};
use crate::notmuch::Notmuch;
use crate::paths::MailPaths;
use crate::store::{BodyOptions, MailStore, ProgressSink};
use crate::{discovery, index, mbsync, msmtp, oauth};
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
    index: Option<MessageIndex>,
    /// Whether the index may answer this request. See `index::freshness`.
    freshness: Freshness,
}

impl NotmuchStore {
    pub fn open() -> Result<Self> {
        Ok(Self::new(Arc::new(MailPaths::discover()?)))
    }

    pub fn new(paths: Arc<MailPaths>) -> Self {
        let index = paths.use_index.then(|| MessageIndex::open(&paths)).and_then(
            |opened| match opened {
                Ok(index) => Some(index),
                Err(err) => {
                    tracing::warn!(%err, "could not open the mail index; every read will ask notmuch");
                    None
                }
            },
        );

        Self {
            notmuch: Notmuch::new(Arc::clone(&paths)),
            paths,
            index,
            freshness: Freshness::default(),
        }
    }

    pub fn paths(&self) -> &MailPaths {
        &self.paths
    }

    pub fn notmuch(&self) -> &Notmuch {
        &self.notmuch
    }

    pub fn index_status(&self) -> Option<IndexStatus> {
        self.index.as_ref().map(|index| index.status())
    }

    /// Builds or catches up the index, rebuilding it if that is what it takes.
    ///
    /// This is the caller that is allowed to be slow — a first build of a 46k
    /// inbox is around 80 seconds — so it is never run from a request. The
    /// server spawns it at startup and the watcher runs it when the database
    /// moves; reads fall through to notmuch for as long as it takes.
    pub async fn refresh_index(&self) -> Result<Option<index::Refreshed>> {
        let Some(index) = self.index.as_ref() else {
            return Ok(None);
        };

        let generation = self.freshness.generation();

        self.freshness.begin_build();
        let refreshed = index::refresh(index, &self.notmuch).await;
        self.freshness.end_build();

        self.freshness.vouch(generation);
        Ok(Some(refreshed?))
    }

    /// The index, if it can be trusted to answer this request.
    ///
    /// Anything that goes wrong here answers `None`, which is a slower request
    /// and never a wrong one.
    async fn reading_index(&self) -> Option<&MessageIndex> {
        let index = self.index.as_ref()?;

        if self.freshness.building() {
            return None;
        }

        if self.freshness.fresh() {
            return Some(index);
        }

        let generation = self.freshness.generation();
        let revision = self.notmuch.revision().await.ok()?;
        let held = index.revision().ok().flatten()?;

        if held != revision {
            index::refresh_incremental(index, &self.notmuch)
                .await
                .ok()
                .flatten()?;
        }

        self.freshness.vouch(generation);
        Some(index)
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
        if let Some(index) = self.reading_index().await {
            match index.search_threads(query) {
                Ok(Some(threads)) => return Ok(threads),
                Ok(None) => {}
                Err(err) => tracing::warn!(%err, "the mail index could not answer a search"),
            }
        }

        self.notmuch.search_threads(query).await
    }

    async fn count(&self, query: &Query) -> Result<usize> {
        if let Some(index) = self.reading_index().await {
            match index.count(query.effective_text()) {
                Ok(Some(count)) => return Ok(count as usize),
                Ok(None) => {}
                Err(err) => tracing::warn!(%err, "the mail index could not answer a count"),
            }
        }

        self.notmuch.count(query).await
    }

    /// The sidebar's rows are mostly tags, and one saved free-text query among
    /// them must not cost every other row its answer — so the ones the index
    /// can take are taken, and only the rest reach notmuch, still in one batch.
    async fn count_batch(&self, queries: &[String]) -> Result<Vec<u64>> {
        let mut answers: Vec<Option<u64>> = vec![None; queries.len()];

        if let Some(index) = self.reading_index().await {
            for (slot, query) in answers.iter_mut().zip(queries) {
                let text = query.trim();
                if text.is_empty() {
                    *slot = Some(0);
                    continue;
                }
                match index.count(text) {
                    Ok(count) => *slot = count,
                    Err(err) => tracing::warn!(%err, "the mail index could not answer a count"),
                }
            }
        }

        let remaining: Vec<String> = queries
            .iter()
            .zip(&answers)
            .filter(|(_, answer)| answer.is_none())
            .map(|(query, _)| query.clone())
            .collect();

        if !remaining.is_empty() {
            let counted = self.notmuch.count_batch(&remaining).await?;
            let mut counted = counted.into_iter();
            for slot in answers.iter_mut().filter(|slot| slot.is_none()) {
                *slot = counted.next();
            }
        }

        Ok(answers.into_iter().map(|a| a.unwrap_or(0)).collect())
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
        let revision = self.notmuch.tag(ops).await?;
        self.freshness.note_write();
        Ok(revision)
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
        self.freshness.note_write();

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
        let found = accounts.iter().find(|a| &a.id == account);
        let msmtp_account = found
            .and_then(|a| a.msmtp_account.clone())
            .unwrap_or_else(|| account.to_string());

        // msmtp's only signal for a dead OAuth token is a non-zero exit with
        // opaque stderr. If this account uses OAuth, name the fix so the
        // compose pane can show something the user can act on.
        msmtp::send(&self.paths, &msmtp_account, raw)
            .await
            .map_err(|e| match e {
                Error::ToolFailed { tool, stderr } => {
                    let profile = found.and_then(|a| discovery::oauth_profile(&self.paths, a));
                    let stderr = match profile.as_deref() {
                        Some(profile) => format!("{stderr}\n\n{}", oauth::authorize_hint(profile)),
                        None => stderr,
                    };
                    Error::ToolFailed { tool, stderr }
                }
                other => other,
            })
    }

    async fn doctor(&self) -> Doctor {
        crate::doctor::run_with_paths(&self.paths).await
    }
}
