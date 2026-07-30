use crate::error::Result;
use ecr_core::account::{Account, AccountId};
use ecr_core::doctor::Doctor;
use ecr_core::message::{
    Body, BodyFormat, Message, MessageId, Part, PartId, Query, SyncReport, TagOp, Thread, ThreadId,
    ThreadSummary,
};
use ecr_core::revision::Revision;
use std::future::Future;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BodyOptions {
    pub format: BodyFormat,
    pub allow_remote_resources: bool,
}

impl Default for BodyOptions {
    fn default() -> Self {
        Self {
            format: BodyFormat::Html,
            allow_remote_resources: false,
        }
    }
}

pub trait ProgressSink: Send + Sync {
    fn line(&self, text: &str);
}

impl ProgressSink for () {
    fn line(&self, _text: &str) {}
}

pub trait MailStore: Send + Sync {
    fn revision(&self) -> impl Future<Output = Result<Revision>> + Send;

    fn accounts(&self) -> impl Future<Output = Result<Vec<Account>>> + Send;

    fn search_threads(
        &self,
        query: &Query,
    ) -> impl Future<Output = Result<Vec<ThreadSummary>>> + Send;

    fn count(&self, query: &Query) -> impl Future<Output = Result<usize>> + Send;

    fn thread(&self, id: &ThreadId) -> impl Future<Output = Result<Thread>> + Send;

    fn message(&self, id: &MessageId) -> impl Future<Output = Result<Message>> + Send;

    fn body(
        &self,
        id: &MessageId,
        options: BodyOptions,
    ) -> impl Future<Output = Result<Body>> + Send;

    fn part(&self, id: &MessageId, part: &PartId) -> impl Future<Output = Result<Part>> + Send;

    fn tag(&self, ops: &[TagOp]) -> impl Future<Output = Result<Revision>> + Send;

    fn sync(
        &self,
        accounts: &[AccountId],
        progress: &dyn ProgressSink,
    ) -> impl Future<Output = Result<SyncReport>> + Send;

    fn send(&self, account: &AccountId, raw: &[u8]) -> impl Future<Output = Result<()>> + Send;

    fn doctor(&self) -> impl Future<Output = Doctor> + Send;
}
