//! Draining the outbox.
//!
//! Everything a reader sends goes into the queue first, so this is the only
//! thing that actually puts mail on the wire. That is the point: one path means
//! a message that fails is always recoverable, and undo-send is the default
//! rather than a feature somebody has to find.

use crate::state::AppState;
use ecr_core::account::AccountId;
use ecr_store::MailStore;
use std::time::Duration;

/// How often the queue is looked at.
///
/// Short, because the hold before an ordinary send is ten seconds and a message
/// that sat a further half-minute would feel broken. It is a directory listing
/// of a directory that is almost always empty.
const TICK: Duration = Duration::from_secs(2);

/// How long a failed send waits before it is tried again.
///
/// Backs off per attempt, because the common failures are a laptop in a tunnel
/// (fixed in seconds) and a credential that is wrong (never fixed by retrying).
/// Growing the gap serves the first without hammering a server about the
/// second.
fn retry_in(attempts: u32) -> i64 {
    match attempts {
        0 => 30,
        1 => 120,
        2 => 600,
        _ => 3600,
    }
}

/// After this many failures a message stops being retried automatically.
///
/// It stays in the outbox carrying its last error rather than being deleted:
/// what is wrong is nearly always the account, and a message silently discarded
/// after an hour of trying is one nobody finds out was never sent.
const GIVE_UP_AFTER: u32 = 8;

pub fn spawn(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let dir = state.store.paths().ecr_state_dir.clone();

        // A message claimed by a process that died is one nobody knows the fate
        // of. Left claimed it silently never arrives, so it goes back in the
        // queue before anything else runs.
        let recovered = ecr_store::outbox::recover(&dir);
        if recovered > 0 {
            tracing::info!(messages = recovered, "recovered from the outbox");
        }

        loop {
            tokio::time::sleep(TICK).await;

            if state.read_only {
                continue;
            }
            drain_once(&state, &dir).await;
        }
    })
}

async fn drain_once(state: &AppState, dir: &std::path::Path) {
    // One at a time. A server sending a hundred queued messages at once is one
    // that looks like a spammer to the receiving end.
    let Some((entry, raw)) = ecr_store::outbox::claim(dir) else {
        return;
    };

    match state
        .store
        .send(&AccountId::from(entry.account.as_str()), &raw)
        .await
    {
        Ok(()) => {
            tracing::info!(subject = %entry.subject, "sent");
            ecr_store::outbox::complete(dir, &entry.id);
            state
                .events
                .publish(crate::events::ServerEvent::OutboxChanged);
        }
        Err(err) => {
            let attempts = entry.attempts;
            let wait = if attempts + 1 >= GIVE_UP_AFTER {
                // Far enough away that it is effectively stopped, without ever
                // deleting somebody's message.
                86_400
            } else {
                retry_in(attempts)
            };

            tracing::warn!(subject = %entry.subject, %err, attempts, "send failed; still queued");
            if let Err(err) = ecr_store::outbox::defer(dir, entry, &err.to_string(), wait) {
                tracing::error!(%err, "a claimed message could not be put back");
            }
            state
                .events
                .publish(crate::events::ServerEvent::OutboxChanged);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two failures worth telling apart are a tunnel and a wrong password.
    /// Retrying the first quickly is the whole point; retrying the second at
    /// the same rate is hammering a server about something that will never fix
    /// itself.
    #[test]
    fn retries_back_off_rather_than_hammering() {
        assert!(retry_in(0) < retry_in(1));
        assert!(retry_in(1) < retry_in(2));
        assert!(retry_in(2) < retry_in(3));
        assert_eq!(
            retry_in(9),
            retry_in(3),
            "it should plateau, not grow forever"
        );
    }
}
