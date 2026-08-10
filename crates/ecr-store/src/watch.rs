//! What the IMAP watches are actually doing, for a process that is not the
//! server.
//!
//! `ecr doctor` used to answer "is push on?" out of `accounts.toml`, which is a
//! statement about what was *configured* — true of a server that has been
//! refused by every one of those servers since it started, and true of no
//! server running at all. That is the same shape as every other bug this
//! codebase has paid for: a green line standing for something nobody checked.
//!
//! Doctor runs in its own process, so the running server has to leave the answer
//! somewhere. It writes this file, and the reader's job is entirely about not
//! trusting it too far: a file outlives the process that wrote it, so an
//! abandoned report has to read as *nobody is saying*, never as the last thing
//! anybody said. Hence [`Report::fresh`] — the timestamp is the whole point of
//! the format, and a report that has stopped being refreshed says nothing at
//! all.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// How often a running server rewrites the report.
///
/// Fast enough that doctor can call a silent server stale within minutes, which
/// is what makes the check worth reading; the file is a few hundred bytes in the
/// state directory, so the cost of the cadence is nil. It cannot be driven by
/// the IDLE renewal instead — that is tens of minutes, and a window that long
/// would leave a crashed server looking healthy for most of an hour.
pub const HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(60);

/// After this, a report is nobody's rather than somebody's.
///
/// Three beats, so an ordinary scheduling delay is not read as a dead server.
pub const STALE_AFTER: i64 = 180;

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// One account's connection, as the server last saw it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watch {
    pub connected: bool,
    /// When `connected` last changed, so doctor can say *how long*. A watch that
    /// has been down for a minute is a laptop that slept; one down since the
    /// server started is a credential.
    pub since: i64,
    /// Why it is down. `None` while it is up — and the error is kept as the
    /// server phrased it, because "IDLE was refused" and "could not select
    /// INBOX" are different problems with different fixes.
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Report {
    pub pid: u32,
    /// Unix seconds at the last write. See [`Report::fresh`].
    pub updated_at: i64,
    pub accounts: BTreeMap<String, Watch>,
}

impl Report {
    /// Whether anybody is still saying this.
    ///
    /// The file is not removed when the server stops — it cannot be, since the
    /// interesting way to stop is a crash. So freshness is the only thing that
    /// separates a report from a relic, and every reader has to go through it.
    pub fn fresh(&self) -> bool {
        now() - self.updated_at <= STALE_AFTER
    }

    /// The watches that are actually failing.
    ///
    /// Deliberately not "everything not connected": a watch dials on a loop, so
    /// there is always a moment between starting and being up, and reporting
    /// that as a fault would make the check cry wolf every time the server
    /// restarts. A watch with no `problem` has simply not connected *yet*; one
    /// with a problem has tried and been told no.
    pub fn failing(&self) -> Vec<(&String, &Watch)> {
        self.accounts
            .iter()
            .filter(|(_, watch)| !watch.connected && watch.problem.is_some())
            .collect()
    }

    pub fn connecting(&self) -> Vec<&String> {
        self.accounts
            .iter()
            .filter(|(_, watch)| !watch.connected && watch.problem.is_none())
            .map(|(id, _)| id)
            .collect()
    }
}

pub fn report_path(state_dir: &Path) -> PathBuf {
    state_dir.join("watch.json")
}

/// The report a running server left, if one is there and parses.
///
/// Every failure is the same answer — `None`, meaning nobody is saying — because
/// doctor must never turn "I could not read the file" into a claim about the
/// mail. Freshness is deliberately *not* applied here: a stale report is still
/// worth distinguishing from an absent one when reporting, and [`Report::fresh`]
/// is how a caller asks.
pub fn read(state_dir: &Path) -> Option<Report> {
    let text = std::fs::read_to_string(report_path(state_dir)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Replaces the report, atomically.
///
/// Through a staging file and a rename for the same reason every other generated
/// file here is: doctor reads this while the server writes it, and a reader that
/// caught a half-written file would report a healthy setup as unparseable.
pub fn write(state_dir: &Path, report: &Report) -> crate::error::Result<()> {
    std::fs::create_dir_all(state_dir)?;

    let path = report_path(state_dir);
    let staging = path.with_extension("json.staging");
    let body =
        serde_json::to_vec(report).map_err(|err| crate::error::Error::Managed(err.to_string()))?;
    std::fs::write(&staging, body)?;
    std::fs::rename(&staging, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watching(connected: bool) -> Watch {
        Watch {
            connected,
            since: now(),
            problem: (!connected).then(|| "IDLE was refused".to_string()),
        }
    }

    #[test]
    fn a_report_survives_the_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut report = Report {
            pid: 42,
            updated_at: now(),
            ..Default::default()
        };
        report.accounts.insert("main".into(), watching(true));
        report.accounts.insert("work".into(), watching(false));

        write(dir.path(), &report).unwrap();
        let back = read(dir.path()).unwrap();

        assert_eq!(back.pid, 42);
        assert!(back.fresh());
        assert_eq!(back.failing().len(), 1);
        assert_eq!(back.failing()[0].0, "work");
        assert_eq!(
            back.failing()[0].1.problem.as_deref(),
            Some("IDLE was refused")
        );
    }

    /// The restart case. A watch dials on a loop, so there is always a window
    /// between starting and being up; calling that a fault would make the check
    /// cry wolf every time the server is restarted.
    #[test]
    fn a_watch_that_has_not_connected_yet_is_not_a_failure() {
        let mut report = Report {
            updated_at: now(),
            ..Default::default()
        };
        report.accounts.insert(
            "main".into(),
            Watch {
                connected: false,
                since: now(),
                problem: None,
            },
        );

        assert!(report.failing().is_empty());
        assert_eq!(report.connecting(), vec![&"main".to_string()]);
    }

    /// The failure the format exists to prevent: a file left behind by a server
    /// that is no longer running must not be read as news.
    #[test]
    fn a_report_nobody_has_refreshed_is_not_fresh() {
        let stale = Report {
            pid: 1,
            updated_at: now() - STALE_AFTER - 1,
            ..Default::default()
        };
        assert!(!stale.fresh());

        let just_now = Report {
            pid: 1,
            updated_at: now(),
            ..Default::default()
        };
        assert!(just_now.fresh());
    }

    #[test]
    fn nothing_written_is_nobody_saying() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read(dir.path()).is_none());
    }

    #[test]
    fn a_file_that_is_not_a_report_is_nobody_saying_either() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(report_path(dir.path()), "{ not json").unwrap();
        assert!(read(dir.path()).is_none());
    }

    /// Nothing is left beside the report; a staging file that survived would be
    /// read by nothing and grow forever.
    #[test]
    fn writing_leaves_only_the_report() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &Report::default()).unwrap();

        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["watch.json".to_string()]);
    }
}
