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
use ecr_store::watch::{self, Watch};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinSet;

/// What every watch is doing, shared with the task that writes it down.
///
/// A `std::sync::Mutex` rather than tokio's: every hold is a map update with no
/// await inside it, and the async lock would only add a scheduling point to
/// something that never blocks.
type Watches = Arc<Mutex<BTreeMap<String, Watch>>>;

fn set(watches: &Watches, id: &str, connected: bool, problem: Option<String>) {
    let Ok(mut map) = watches.lock() else { return };

    // `since` is when the state last *changed*, so a watch that has been up for
    // an hour does not read as having reconnected a second ago. It is the whole
    // difference between a laptop that slept and a credential that is wrong.
    let changed = map
        .get(id)
        .map(|watch| watch.connected != connected)
        .unwrap_or(true);
    let since = match changed {
        true => watch::now(),
        false => map
            .get(id)
            .map(|watch| watch.since)
            .unwrap_or_else(watch::now),
    };

    map.insert(
        id.to_string(),
        Watch {
            connected,
            since,
            problem,
        },
    );
}

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

    // Every watched account is present from the start, connected by nothing
    // yet. An account missing from the report is one that is not being watched
    // at all, which is a different thing to report and must stay tellable.
    let watches: Watches = Arc::new(Mutex::new(
        watched
            .iter()
            .map(|(id, _)| {
                (
                    id.clone(),
                    Watch {
                        connected: false,
                        since: watch::now(),
                        problem: None,
                    },
                )
            })
            .collect(),
    ));

    let mut tasks = JoinSet::new();
    for (id, account) in watched {
        let state = state.clone();
        tasks.spawn(watch_one(state, id, account, Arc::clone(&watches)));
    }
    tasks.spawn(report(state.clone(), Arc::clone(&watches)));

    tracing::info!(accounts = tasks.len() - 1, "watching IMAP for new mail");
    Some(tasks)
}

async fn watch_one(state: AppState, id: String, account: ManagedAccount, watches: Watches) {
    let folder = account
        .folder(ecr_core::managed::FolderRole::Inbox)
        .unwrap_or_else(|| "INBOX".to_string());

    loop {
        let profiles = state.store.paths().oauth_profiles();

        let established = || set(&watches, &id, true, None);
        match ecr_store::imap::wait_for_mail(&profiles, &account, &folder, established).await {
            Ok(()) => {
                tracing::debug!(account = %id, "IMAP says there is something to fetch");
                // Still up: the wait ended because something arrived or the
                // renewal window elapsed, and the next iteration redials.
                set(&watches, &id, true, None);
                sync_one(&state, &id).await;
            }
            Err(err) => {
                // Every failure is the same shape from here: wait, try again.
                // A token that expired is refreshed by the next attempt, a
                // laptop that slept reconnects, and a server that is down
                // recovers on its own.
                tracing::warn!(account = %id, %err, "IMAP watch dropped; retrying");
                set(&watches, &id, false, Some(err.to_string()));
                tokio::time::sleep(RETRY).await;
            }
        }
    }
}

/// Writes down what the watches are doing, for a process that is not this one.
///
/// `ecr doctor` runs on its own and could otherwise only report what was
/// *configured* — a line that is equally true of a server being refused by
/// every one of these hosts, and of no server running at all. The file is
/// rewritten on a heartbeat rather than only when something changes, because
/// the reader's question is "is this still true?", and only a timestamp that
/// keeps moving can answer it.
async fn report(state: AppState, watches: Watches) {
    let path = state.store.paths().ecr_state_dir.clone();
    let mut ticker = tokio::time::interval(watch::HEARTBEAT);

    loop {
        ticker.tick().await;

        let accounts = match watches.lock() {
            Ok(map) => map.clone(),
            Err(_) => continue,
        };

        let report = watch::Report {
            pid: std::process::id(),
            updated_at: watch::now(),
            accounts,
        };

        // A report that cannot be written is not worth failing anything over —
        // doctor falls back to saying nobody is reporting, which is true.
        if let Err(err) = watch::write(&path, &report) {
            tracing::debug!(%err, "could not write the IMAP watch report");
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
