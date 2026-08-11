//! The outbox: messages written but not yet gone.
//!
//! Three features are one mechanism. **Undo send** is a queue that waits a few
//! seconds before it drains, so a message can be taken back by deleting a file.
//! **Send later** is the same queue with a time somebody chose. And a message
//! that could not be sent because the laptop was in a tunnel stays here instead
//! of being lost, which is the behaviour a queue gives away for free.
//!
//! One file per message, in a directory, with the time it is due encoded in the
//! name. That is deliberately not a database: the queue has to survive a crash
//! mid-send and be inspectable when something has gone wrong, and a directory
//! of RFC 5322 files is the most durable, most debuggable thing available — the
//! same reasoning that makes a maildir a maildir.

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// How long an ordinary send waits before it goes.
///
/// Long enough to notice the mistake everybody makes — the wrong recipient, the
/// forgotten attachment — and short enough that mail still feels sent. Zero
/// turns undo off, which is a legitimate choice and not a broken one.
pub const DEFAULT_HOLD: u64 = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Queued {
    pub id: String,
    pub account: String,
    /// Unix seconds. The message is not sent before this.
    pub due: i64,
    /// What the list shows while it waits.
    pub subject: String,
    pub to: Vec<String>,
    /// How many times sending has been tried and failed.
    #[serde(default)]
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

/// Where the queue lives.
pub fn dir(state_dir: &Path) -> PathBuf {
    state_dir.join("outbox")
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Puts a message in the queue. Answers its id, which is what cancels it.
///
/// The message and its metadata are two files, and the *message* is written
/// first: a crash between them leaves a body with no envelope, which is
/// recoverable and inspectable. The other order leaves an envelope promising a
/// message that does not exist, and something has to decide what to do about a
/// send that cannot be performed.
pub fn enqueue(
    state_dir: &Path,
    account: &str,
    raw: &[u8],
    due: i64,
    subject: &str,
    to: &[String],
) -> Result<String> {
    let dir = dir(state_dir);
    std::fs::create_dir_all(&dir)?;

    // Sortable by time, then unique. Two messages queued in the same second are
    // ordinary, and a name that collided would silently replace one with the
    // other.
    let id = format!("{due:012}-{}", short_random());

    std::fs::write(dir.join(format!("{id}.eml")), raw)?;

    let entry = Queued {
        id: id.clone(),
        account: account.to_string(),
        due,
        subject: subject.to_string(),
        to: to.to_vec(),
        attempts: 0,
        last_error: None,
    };
    let json = serde_json::to_vec_pretty(&entry).map_err(|err| Error::Managed(err.to_string()))?;
    std::fs::write(dir.join(format!("{id}.json")), json)?;

    Ok(id)
}

/// Everything waiting, soonest first.
pub fn list(state_dir: &Path) -> Vec<Queued> {
    let Ok(entries) = std::fs::read_dir(dir(state_dir)) else {
        return Vec::new();
    };

    let mut out: Vec<Queued> = entries
        .flatten()
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|text| serde_json::from_str::<Queued>(&text).ok())
        .collect();

    out.sort_by_key(|q| (q.due, q.id.clone()));
    out
}

/// Takes a message back. Answers whether there was one to take.
///
/// This is the whole of undo-send: the file is gone, so the drain that would
/// have sent it finds nothing. There is no window in which a cancel races a
/// send, because the drain removes the entry *before* it dials.
pub fn cancel(state_dir: &Path, id: &str) -> bool {
    let dir = dir(state_dir);
    let json = dir.join(format!("{id}.json"));
    let eml = dir.join(format!("{id}.eml"));

    let existed = json.exists();
    let _ = std::fs::remove_file(&json);
    let _ = std::fs::remove_file(&eml);
    existed
}

/// Makes a waiting message due now. Answers whether there was one.
///
/// **The attempt count goes back to zero**, and that is the point rather than
/// tidiness: the backoff doubles, and after enough failures `defer` parks a
/// message a day away — so a reader who has just fixed the password and asked
/// for it to go would otherwise watch it sit there until tomorrow, with a
/// button that appeared to do nothing. The last error is kept, because it is
/// still the reason it is here until something replaces it.
///
/// A message that is currently `.sending` is not touched: it has been claimed,
/// and putting a second copy of it in the queue is how one gets sent twice.
pub fn retry(state_dir: &Path, id: &str) -> bool {
    let dir = dir(state_dir);
    let path = dir.join(format!("{id}.json"));

    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(mut entry) = serde_json::from_str::<Queued>(&text) else {
        return false;
    };

    entry.due = now();
    entry.attempts = 0;

    let Ok(json) = serde_json::to_vec_pretty(&entry) else {
        return false;
    };
    std::fs::write(&path, json).is_ok()
}

/// The next message that is due, claimed so nothing else takes it.
///
/// Claiming is renaming the metadata aside before the body is read: whatever
/// happens next — a crash, a refusal, a laptop closing — this message is no
/// longer in the queue, so it cannot be sent twice. A send that fails is put
/// back by [`defer`], deliberately as a separate act.
pub fn claim(state_dir: &Path) -> Option<(Queued, Vec<u8>)> {
    let dir = dir(state_dir);
    let due = list(state_dir).into_iter().find(|q| q.due <= now())?;

    let json = dir.join(format!("{}.json", due.id));
    let claimed = dir.join(format!("{}.sending", due.id));
    // Rename is the claim, and it is atomic: two drains racing, only one wins.
    std::fs::rename(&json, &claimed).ok()?;

    let raw = std::fs::read(dir.join(format!("{}.eml", due.id))).ok()?;
    Some((due, raw))
}

/// Finishes with a claimed message: the send worked, so nothing is left.
pub fn complete(state_dir: &Path, id: &str) {
    let dir = dir(state_dir);
    let _ = std::fs::remove_file(dir.join(format!("{id}.sending")));
    let _ = std::fs::remove_file(dir.join(format!("{id}.eml")));
}

/// Puts a claimed message back, to be tried again later.
///
/// The error is kept on the entry so the outbox can say *why* something is
/// still sitting there — a queue that silently retries forever is one where a
/// wrong password looks like a slow network.
pub fn defer(state_dir: &Path, mut entry: Queued, error: &str, retry_in: i64) -> Result<()> {
    let dir = dir(state_dir);
    let _ = std::fs::remove_file(dir.join(format!("{}.sending", entry.id)));

    entry.attempts += 1;
    entry.last_error = Some(error.to_string());
    entry.due = now() + retry_in;

    let json = serde_json::to_vec_pretty(&entry).map_err(|err| Error::Managed(err.to_string()))?;
    std::fs::write(dir.join(format!("{}.json", entry.id)), json)?;
    Ok(())
}

/// Anything left `.sending` from a process that died mid-send.
///
/// Recovered on startup rather than at send time: a message claimed and never
/// finished is one nobody knows the fate of, and leaving it claimed forever
/// means it silently never arrives.
pub fn recover(state_dir: &Path) -> usize {
    let dir = dir(state_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };

    let mut recovered = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("sending") {
            continue;
        }
        let restored = path.with_extension("json");
        if std::fs::rename(&path, &restored).is_ok() {
            recovered += 1;
        }
    }
    recovered
}

fn short_random() -> String {
    use rand::RngExt;
    let mut rng = rand::rng();
    (0..8)
        .map(|_| char::from(b'a' + rng.random_range(0..26)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &[u8] = b"From: a@example.com\r\nTo: b@example.com\r\n\r\nhello\r\n";

    fn queue(dir: &Path, due: i64) -> String {
        enqueue(dir, "main", RAW, due, "Hello", &["b@example.com".into()]).unwrap()
    }

    #[test]
    fn a_queued_message_waits_until_it_is_due() {
        let dir = tempfile::tempdir().unwrap();
        queue(dir.path(), now() + 3600);

        assert_eq!(list(dir.path()).len(), 1);
        assert!(claim(dir.path()).is_none(), "sent before it was due");
    }

    #[test]
    fn a_message_that_is_due_is_claimed_with_its_body() {
        let dir = tempfile::tempdir().unwrap();
        queue(dir.path(), now() - 1);

        let (entry, raw) = claim(dir.path()).expect("nothing claimed");
        assert_eq!(entry.account, "main");
        assert_eq!(raw, RAW);
    }

    /// The whole of undo-send. Cancelling removes the file, so the drain that
    /// would have sent it finds nothing.
    #[test]
    fn cancelling_takes_a_message_back_before_it_goes() {
        let dir = tempfile::tempdir().unwrap();
        let id = queue(dir.path(), now() - 1);

        assert!(cancel(dir.path(), &id));
        assert!(list(dir.path()).is_empty());
        assert!(claim(dir.path()).is_none());
        // And cancelling something that is already gone is not an error.
        assert!(!cancel(dir.path(), &id));
    }

    /// Claiming is a rename, so a second drain running at the same moment finds
    /// nothing to take. A message sent twice is the one failure a send queue
    /// exists to prevent.
    #[test]
    fn a_claimed_message_cannot_be_claimed_again() {
        let dir = tempfile::tempdir().unwrap();
        queue(dir.path(), now() - 1);

        assert!(claim(dir.path()).is_some());
        assert!(claim(dir.path()).is_none());
    }

    #[test]
    fn completing_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        queue(dir.path(), now() - 1);
        let (entry, _) = claim(dir.path()).unwrap();

        complete(dir.path(), &entry.id);
        assert!(list(dir.path()).is_empty());
        assert_eq!(
            std::fs::read_dir(dir.path().join("outbox"))
                .unwrap()
                .count(),
            0
        );
    }

    /// A queue that retries silently forever is one where a wrong password
    /// looks like a slow network.
    #[test]
    fn a_failed_send_goes_back_carrying_its_reason() {
        let dir = tempfile::tempdir().unwrap();
        queue(dir.path(), now() - 1);
        let (entry, _) = claim(dir.path()).unwrap();

        defer(dir.path(), entry, "the server refused the password", 60).unwrap();

        let waiting = list(dir.path());
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].attempts, 1);
        assert!(waiting[0]
            .last_error
            .as_deref()
            .unwrap()
            .contains("refused"));
        // And it is not due again immediately.
        assert!(claim(dir.path()).is_none());
    }

    /// A process that died mid-send leaves a claimed message nobody knows the
    /// fate of. Left alone it silently never arrives.
    #[test]
    fn a_message_claimed_by_a_process_that_died_is_recovered() {
        let dir = tempfile::tempdir().unwrap();
        queue(dir.path(), now() - 1);
        claim(dir.path()).unwrap();

        assert!(list(dir.path()).is_empty(), "still queued while claimed");
        assert_eq!(recover(dir.path()), 1);
        assert_eq!(list(dir.path()).len(), 1);
    }

    #[test]
    fn two_messages_queued_in_the_same_second_are_both_kept() {
        let dir = tempfile::tempdir().unwrap();
        let due = now() + 60;
        let one = queue(dir.path(), due);
        let two = queue(dir.path(), due);

        assert_ne!(one, two);
        assert_eq!(list(dir.path()).len(), 2);
    }

    #[test]
    fn the_queue_is_drained_soonest_first() {
        let dir = tempfile::tempdir().unwrap();
        queue(dir.path(), now() + 100);
        queue(dir.path(), now() - 5);

        let (entry, _) = claim(dir.path()).unwrap();
        assert!(entry.due < now());
    }
}
