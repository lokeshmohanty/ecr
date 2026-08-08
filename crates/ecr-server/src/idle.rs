//! Push, without a fifth process to supervise.
//!
//! `imapnotify` existed to hold an IMAP connection open and run a command when
//! the server said something arrived. ecr can hold that connection itself: the
//! token is one it already mints, the connection writes nothing, and what it
//! triggers is the same mbsync run the reader would have waited for.
//!
//! What this is *not* is a sync. It says "go and look"; `store.sync` does the
//! looking, and the maildir watcher notices what lands. That layering is what
//! keeps this safe to add — a bug here means mail arrives late, which is the
//! behaviour without it.

use crate::state::AppState;
use ecr_core::account::AccountId;
use ecr_core::managed::{ManagedAccount, ManagedAccounts};
use ecr_store::managed::accounts::Accounts;
use std::time::Duration;
use tokio::task::JoinSet;

/// After a failure. Long enough not to hammer a server that is refusing us, and
/// short enough that a laptop waking up does not sit disconnected for an hour.
const RETRY: Duration = Duration::from_secs(60);

/// A watcher per account gets its own connection, so one account's server being
/// unreachable never stops another's mail from arriving.
pub fn spawn(state: AppState) -> Option<JoinSet<()>> {
    if state.read_only {
        tracing::debug!("read-only; not watching IMAP");
        return None;
    }

    let accounts = match Accounts::load_from(&state.store.paths().accounts_file()) {
        Ok(accounts) => accounts.accounts,
        Err(err) => {
            tracing::warn!(%err, "could not read the managed accounts; no IMAP watch");
            return None;
        }
    };

    // Only accounts ecr manages. A self-managed setup has told ecr nothing about
    // where its IMAP server is — the mbsync config names a host, but not in a
    // form ecr should be dialling on its own initiative.
    let watched: Vec<(String, ManagedAccount)> = accounts
        .enabled()
        .filter(|(_, account)| account.imap().is_some())
        .map(|(id, account)| (id.clone(), account.clone()))
        .collect();

    if watched.is_empty() {
        return None;
    }

    let mut tasks = JoinSet::new();
    for (id, account) in watched {
        let state = state.clone();
        tasks.spawn(watch_one(state, id, account));
    }

    tracing::info!(accounts = tasks.len(), "watching IMAP for new mail");
    Some(tasks)
}

async fn watch_one(state: AppState, id: String, account: ManagedAccount) {
    let folder = account
        .folder(ecr_core::managed::FolderRole::Inbox)
        .unwrap_or_else(|| "INBOX".to_string());

    loop {
        let profiles = state.store.paths().oauth_profiles();

        match ecr_store::imap::wait_for_mail(&profiles, &account, &folder).await {
            Ok(()) => {
                tracing::debug!(account = %id, "IMAP says there is something to fetch");
                sync_one(&state, &id).await;
            }
            Err(err) => {
                // Every failure is the same shape from here: wait, try again.
                // A token that expired is refreshed by the next attempt, a
                // laptop that slept reconnects, and a server that is down
                // recovers on its own.
                tracing::warn!(account = %id, %err, "IMAP watch dropped; retrying");
                tokio::time::sleep(RETRY).await;
            }
        }
    }
}

/// Runs the sync, then lets the maildir watcher do what it always does.
///
/// Nothing is published here. `watcher.rs` sees the files land, refreshes the
/// index *before* publishing `mail:changed`, and clients ask for the new page
/// once. Announcing from here as well would wake every client twice, once
/// against an index that had not caught up.
async fn sync_one(state: &AppState, id: &str) {
    use ecr_store::MailStore;

    let accounts = [AccountId::from(id)];
    if let Err(err) = state.store.sync(&accounts, &()).await {
        tracing::warn!(account = %id, %err, "sync after an IMAP notification failed");
    }
}

/// Which accounts would be watched, without starting anything.
///
/// Doctor reports this: a managed account that ecr cannot watch falls back to
/// the maildir watcher, which only sees mail that something else fetched — so
/// "push is on" is worth being able to state rather than infer.
pub fn watchable(accounts: &ManagedAccounts) -> Vec<String> {
    accounts
        .enabled()
        .filter(|(_, account)| account.imap().is_some())
        .map(|(id, _)| id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ecr_core::managed::{Auth, Provider};

    fn accounts() -> ManagedAccounts {
        let mut accounts = ManagedAccounts::default();
        accounts.accounts.insert(
            "main".into(),
            ManagedAccount::new("alice@gmail.com", Provider::Gmail, Auth::oauth("main")),
        );

        let mut disabled =
            ManagedAccount::new("old@gmail.com", Provider::Gmail, Auth::oauth("old"));
        disabled.enabled = false;
        accounts.accounts.insert("old".into(), disabled);

        // A generic account with no endpoints given: there is nowhere to dial.
        accounts.accounts.insert(
            "vague".into(),
            ManagedAccount::new(
                "someone@example.net",
                Provider::Generic,
                Auth::oauth("vague"),
            ),
        );
        accounts
    }

    #[test]
    fn only_enabled_accounts_with_somewhere_to_connect_are_watched() {
        assert_eq!(watchable(&accounts()), vec!["main".to_string()]);
    }

    #[test]
    fn a_setup_ecr_does_not_manage_is_watched_by_nothing() {
        assert!(watchable(&ManagedAccounts::default()).is_empty());
    }
}
