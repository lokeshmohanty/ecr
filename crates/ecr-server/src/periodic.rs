//! The sync that catches everything push cannot see.
//!
//! `idle.rs` holds an IDLE on each account's **Inbox**, so it hears about mail
//! arriving and nothing else. Everything a reader does in somebody else's
//! client — archiving, deleting, relabelling, reading — happens in folders
//! nothing is watching, and produces no notification at all. Until this
//! existed, that drift was reconciled only when new inbox mail happened to
//! arrive, or when somebody pressed sync: a message archived on the web sat in
//! ecr's inbox indefinitely, and a folder that never receives mail was never
//! looked at twice.
//!
//! So this is deliberately the blunt one. It syncs **every** account, all
//! folders, on a fixed interval, and it is the only thing in the server that
//! does. Push stays what makes new mail feel instant; this is what makes ecr
//! and the server agree.

use ecr_store::MailStore;
use std::time::Duration;
use tokio::task::JoinHandle;

use crate::state::AppState;

/// How often the whole setup is reconciled.
///
/// Long enough that four mbsync runs over every folder are not a background
/// tax, short enough that a mailbox tidied on a phone is not still wrong on a
/// desktop an hour later.
const EVERY: Duration = Duration::from_secs(30 * 60);

/// Reconciles every account on a timer, for as long as the server runs.
///
/// Dropping the handle aborts it. Nothing is published here, for the same
/// reason `idle.rs` publishes nothing: the maildir watcher sees what lands,
/// refreshes the index *before* announcing it, and announcing from here too
/// would wake every client a second time against an index still catching up.
pub fn spawn(state: AppState) -> Option<JoinHandle<()>> {
    if state.read_only {
        tracing::debug!("read-only; no periodic sync");
        return None;
    }

    tracing::info!(minutes = EVERY.as_secs() / 60, "reconciling on a timer");

    Some(tokio::spawn(async move {
        let mut ticks = tokio::time::interval(EVERY);

        // `interval` fires its first tick immediately. Booting is the one moment
        // a full sync is least wanted — the index is still catching up and a
        // reader is waiting for a list — and least useful, since whatever
        // started the server is about to sync anyway.
        ticks.tick().await;

        loop {
            ticks.tick().await;

            // An empty slice is every account, the same shape `POST /sync` with
            // no body uses.
            if let Err(err) = state.store.sync(&[], &()).await {
                // A failed reconcile is the state ecr was already in, so it is
                // worth saying and not worth escalating: the next tick tries
                // again, and push is unaffected either way.
                tracing::warn!(%err, "the periodic sync failed");
            }
        }
    }))
}
