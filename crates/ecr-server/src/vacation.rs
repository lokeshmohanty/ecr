//! Running the vacation responder over mail that has just arrived.
//!
//! The decision — whether a given message should be answered at all — lives in
//! `ecr_core::vacation` and is pure. This is the half that has to touch the
//! world: which messages are new, who has already been told, and putting the
//! reply where the outbox will find it.
//!
//! Two things about *where* this runs matter more than anything in it.
//!
//! It runs on `tag:new`, the tag notmuch puts on mail it has just indexed and
//! that the post-new hook clears. So it can only ever see mail that arrived
//! since the last pass. Running it over a query instead — "unread mail from
//! today" — would mean that switching the responder on answered a fortnight of
//! backlog in one burst, which is indistinguishable, from the receiving end,
//! from a compromised account.
//!
//! And it enqueues rather than sends. `drain.rs` is the only thing that puts
//! mail on the wire, and keeping it that way means an autoreply is visible in
//! the outbox before it goes, is retried on a failure like anything else, and
//! can be taken back. A responder that sent directly would be the one kind of
//! mail nobody could stop.

use crate::state::AppState;
use ecr_core::message::Query;
use ecr_core::vacation::{bare, Arrived, Decision, Skip, Vacation};
use ecr_store::MailStore;
use std::collections::BTreeMap;
use std::path::Path;

/// Who has been told, and when.
///
/// A JSON file beside the outbox rather than a table in the index: the index is
/// a cache that is rebuilt from notmuch whenever it looks stale, and a ledger
/// that can be rebuilt is a ledger that can be *lost* — which here means
/// telling everybody again. This file is the only record that a message was
/// ever sent, so it is the one thing in ecr's state directory that is not
/// derived from anything.
type Ledger = BTreeMap<String, i64>;

fn ledger_path(state_dir: &Path) -> std::path::PathBuf {
    state_dir.join("vacation-sent.json")
}

fn read_ledger(state_dir: &Path) -> Ledger {
    std::fs::read_to_string(ledger_path(state_dir))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Records that somebody has been told, immediately and before the reply is
/// queued.
///
/// Before, deliberately. If the write fails the reply is not sent, which costs
/// one person one notice; the other order costs everybody a second copy of it
/// every time the process restarts mid-pass.
fn note(state_dir: &Path, address: &str, at: i64) -> std::io::Result<()> {
    let mut ledger = read_ledger(state_dir);
    ledger.insert(address.to_ascii_lowercase(), at);

    std::fs::create_dir_all(state_dir)?;
    let text = serde_json::to_string_pretty(&ledger)
        .map_err(|err| std::io::Error::other(err.to_string()))?;

    // Written aside and renamed: a truncated ledger reads as nobody having
    // been told, and the whole address book gets a second notice.
    let staging = ledger_path(state_dir).with_extension("staging");
    std::fs::write(&staging, text)?;
    std::fs::rename(staging, ledger_path(state_dir))
}

/// Answers whatever has just arrived and deserves an answer.
///
/// Returns how many replies were queued. Never fails the caller: this runs
/// behind the watcher, and a responder that could take the delivery path down
/// with it would cost somebody their mail to save them an autoreply.
pub async fn run(state: &AppState) -> usize {
    let paths = state.store.paths();
    let Ok(accounts) = ecr_store::managed::accounts::Accounts::load_from(&paths.accounts_file())
    else {
        return 0;
    };

    let Some(vacation) = accounts.accounts.vacation.as_ref().filter(|v| v.enabled) else {
        return 0;
    };

    let ours: Vec<String> = accounts
        .accounts
        .accounts
        .values()
        .flat_map(|account| account.identities())
        .map(|identity| identity.address)
        .collect();

    if ours.is_empty() {
        return 0;
    }

    // Only what has just arrived, and only what a rule left in the inbox. The
    // `tag:new` half is what stops switching the responder on from answering a
    // fortnight of backlog in one burst.
    let query = match &vacation.query {
        Some(extra) => Query::new(format!("tag:new and ({extra})")),
        None => Query::new("tag:new"),
    };

    let Ok(threads) = state.store.search_threads(&query).await else {
        return 0;
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut sent = 0;
    for summary in threads.iter().take(MOST_IN_ONE_PASS) {
        let Ok(thread) = state.store.thread(&summary.id).await else {
            continue;
        };
        // The thread is the unit notmuch searches in, but `new` is a property
        // of a *message*: a reply arriving on a conversation from last year
        // brings the whole thing back, and answering every message in it would
        // send one notice per exchange the two of you have ever had.
        for message in thread.messages.iter().filter(|m| m.tags.contains("new")) {
            if reply_to(state, vacation, &ours, message, now).await {
                sent += 1;
            }
        }
    }
    sent
}

/// A ceiling on one pass.
///
/// Not a performance limit — a blast radius. If anything above is ever wrong
/// about what counts as new, this is what stands between one bad pass and a
/// mailbox's worth of autoreplies, and the remainder is simply left for the
/// next pass rather than dropped.
const MOST_IN_ONE_PASS: usize = 50;

async fn reply_to(
    state: &AppState,
    vacation: &Vacation,
    ours: &[String],
    message: &ecr_core::message::Message,
    now: i64,
) -> bool {
    let paths = state.store.paths();
    let state_dir = &paths.ecr_state_dir;

    let arrived = Arrived {
        from: message
            .from
            .first()
            .map(|a| a.to_string())
            .unwrap_or_default(),
        to: message
            .to
            .iter()
            .chain(message.cc.iter())
            .map(|a| a.email.clone())
            .collect(),
        headers: header_markers(state, &message.id).await,
        message_id: Some(message.id.to_string()),
        subject: message.subject.clone(),
    };

    let sender = arrived.from.clone();
    let key = bare(&sender);
    let last = read_ledger(state_dir).get(&key).copied();

    match ecr_core::vacation::decide(vacation, &arrived, ours, now, last) {
        Decision::Skip(Skip::NotOn) => false,
        Decision::Skip(reason) => {
            tracing::debug!(?reason, subject = %message.subject, "not auto-replying");
            false
        }
        Decision::Reply { to, subject } => {
            // The ledger first. A failure here costs one person one notice; the
            // other order costs everybody a second copy every time the process
            // restarts mid-pass.
            if let Err(err) = note(state_dir, &key, now) {
                tracing::warn!(%err, "could not record an auto-reply; not sending it");
                return false;
            }

            match queue(state, vacation, message, &to, &subject).await {
                Ok(()) => {
                    tracing::info!(%to, "auto-replied");
                    true
                }
                Err(err) => {
                    tracing::warn!(%err, %to, "could not queue an auto-reply");
                    false
                }
            }
        }
    }
}

/// The headers the decision turns on, read from the message file.
///
/// Only these: `List-Id` and the rest are the difference between answering one
/// person and answering a mailing list, and they are not in notmuch's own
/// message record. Reading the whole file for every arrival would be the wrong
/// trade, so this reads the header block and stops.
async fn header_markers(
    state: &AppState,
    id: &ecr_core::message::MessageId,
) -> Vec<(String, String)> {
    const WANTED: &[&str] = &[
        "auto-submitted",
        "precedence",
        "list-id",
        "list-post",
        "list-unsubscribe",
        "list-help",
        "mailing-list",
        "x-mailing-list",
        "x-auto-response-suppress",
        "x-autoreply",
        "x-autorespond",
        "x-autogenerated",
    ];

    let Ok(path) = state.store.notmuch().message_file(id).await else {
        // Nothing read means nothing suppresses the reply, which is the wrong
        // way to fail — so a message whose file cannot be read is reported as
        // machine-generated and left alone.
        return vec![("auto-submitted".into(), "auto-generated".into())];
    };
    let Ok(raw) = tokio::fs::read(&path).await else {
        return vec![("auto-submitted".into(), "auto-generated".into())];
    };

    let text = String::from_utf8_lossy(&raw);
    let head = text.split("\n\n").next().unwrap_or_default();

    let mut found = Vec::new();
    for line in head.lines() {
        // Continuation of a folded header — none of the ones above are read
        // for their value in a way that a fold would change.
        if line.starts_with([' ', '\t']) {
            continue;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        if WANTED.contains(&name.as_str()) {
            found.push((name, value.trim().to_string()));
        }
    }
    found
}

async fn queue(
    state: &AppState,
    vacation: &Vacation,
    original: &ecr_core::message::Message,
    to: &str,
    subject: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let accounts: Vec<ecr_core::account::Account> = state.store.accounts().await?;

    // The account the message was delivered to, not the first one. Answering a
    // Gmail thread from the work address is the same bug reply already has,
    // and here nobody is watching when it happens.
    let account = accounts
        .iter()
        .find(|a| original.tags.contains(a.id.as_str()))
        .or_else(|| accounts.first())
        .ok_or("no account to reply from")?;

    let draft = ecr_core::compose::Draft {
        to: vec![to.to_string()],
        subject: subject.to_string(),
        body: vacation.body.clone(),
        in_reply_to: Some(original.id.to_string()),
        references: vec![original.id.to_string()],
        ..Default::default()
    };

    let mut raw = ecr_store::compose::build_as(account, &draft, &[])?;

    // RFC 3834, and the reason two ecr installations on holiday do not talk to
    // each other forever. `Precedence: bulk` is the older convention and is
    // what most of the software that predates the RFC actually looks at, so
    // both go on. Prepended, because a header block ends at the first blank
    // line and appending would put them in the body.
    let markers =
        b"Auto-Submitted: auto-replied\r\nPrecedence: bulk\r\nX-Auto-Response-Suppress: All\r\n";
    let mut out = markers.to_vec();
    out.append(&mut raw);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    ecr_store::outbox::enqueue(
        &state.store.paths().ecr_state_dir,
        account.id.as_str(),
        &out,
        // No hold. Undo exists for a message somebody just wrote and might
        // regret; nobody is sitting in front of this one, and a ten-second
        // pause only delays it.
        now,
        subject,
        &[to.to_string()],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ledger is the only record that a message was ever sent. Losing it
    /// means telling everybody again, so it survives a restart by being a file
    /// rather than anything derived.
    #[test]
    fn who_has_been_told_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();

        note(dir.path(), "grace@example.org", 1_000).unwrap();
        note(dir.path(), "ada@example.com", 2_000).unwrap();

        let ledger = read_ledger(dir.path());
        assert_eq!(ledger.get("grace@example.org"), Some(&1_000));
        assert_eq!(ledger.get("ada@example.com"), Some(&2_000));
    }

    /// A ledger that cannot be read must read as *nobody has been told*
    /// failing safe would mean never replying at all, and this is the one
    /// place where the safe direction is not obvious. It is not: an empty
    /// ledger costs a second notice, a ledger that silently claims everyone
    /// has been told turns the feature off with no way to notice.
    #[test]
    fn a_missing_ledger_is_empty_rather_than_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_ledger(dir.path()).is_empty());

        std::fs::write(ledger_path(dir.path()), "not json at all").unwrap();
        assert!(read_ledger(dir.path()).is_empty());
    }

    #[test]
    fn an_address_is_recorded_under_its_bare_form() {
        let dir = tempfile::tempdir().unwrap();
        note(dir.path(), &bare("Grace Hopper <GRACE@example.org>"), 1).unwrap();

        assert!(read_ledger(dir.path()).contains_key("grace@example.org"));
    }
}
