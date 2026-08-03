//! When the index may be trusted to answer instead of notmuch.
//!
//! Three facts decide it, and the interesting part is how they interact rather
//! than any one of them, which is why they live together here with tests
//! instead of as loose fields on the store.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a read trusts the index without asking notmuch whether the database
/// has moved. Every writer ecr knows about says so directly, so this window
/// only bounds how long a *stranger's* `notmuch tag` can go unnoticed — at one
/// cheap process per window rather than one per request.
pub const REVALIDATE_AFTER: Duration = Duration::from_secs(2);

pub struct Freshness {
    window: Duration,
    /// When the index was last known to stand where notmuch does.
    verified: Mutex<Option<Instant>>,
    building: AtomicBool,
    /// Writes this server has made, counted so a refresh can tell whether one
    /// landed while it was working.
    writes: AtomicU64,
}

impl Default for Freshness {
    fn default() -> Self {
        Self::new(REVALIDATE_AFTER)
    }
}

impl Freshness {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            verified: Mutex::new(None),
            building: AtomicBool::new(false),
            writes: AtomicU64::new(0),
        }
    }

    /// Whether a refresh is writing to the index right now.
    ///
    /// A read checks this rather than queueing behind the write: the index is
    /// one connection behind one mutex, and a chunk of a rebuild takes far
    /// longer than the notmuch call the reader would otherwise be waiting on,
    /// so blocking on it would make the index *slower* than not having one.
    pub fn building(&self) -> bool {
        self.building.load(Ordering::SeqCst)
    }

    pub fn begin_build(&self) {
        self.building.store(true, Ordering::SeqCst);
    }

    pub fn end_build(&self) {
        self.building.store(false, Ordering::SeqCst);
    }

    /// Whether the index was confirmed current recently enough to be believed.
    pub fn fresh(&self) -> bool {
        self.verified
            .lock()
            .ok()
            .and_then(|at| *at)
            .is_some_and(|at| at.elapsed() < self.window)
    }

    /// Read before doing the work that makes the index current, and handed back
    /// to [`Self::vouch`] afterwards.
    pub fn generation(&self) -> u64 {
        self.writes.load(Ordering::SeqCst)
    }

    /// Declares the index current — but only if nothing was written since
    /// `generation` was taken.
    ///
    /// A write that lands *during* a refresh is not in what that refresh read,
    /// so vouching for it unconditionally hides the write for a whole window:
    /// the tag is in notmuch, the list does not have it, and nothing anywhere
    /// is in an error state. It takes a build finishing in the same moment as a
    /// write, which is why it survived every run of the suite but one.
    pub fn vouch(&self, generation: u64) {
        if self.generation() != generation {
            return;
        }
        if let Ok(mut at) = self.verified.lock() {
            *at = Some(Instant::now());
        }
    }

    /// A write of ours moved the database, so the next read revalidates — and
    /// any refresh already in flight can no longer vouch for what it built.
    pub fn note_write(&self) {
        self.writes.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut at) = self.verified.lock() {
            *at = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn freshness() -> Freshness {
        Freshness::new(Duration::from_secs(60))
    }

    #[test]
    fn nothing_is_trusted_before_a_refresh_has_vouched() {
        assert!(!freshness().fresh());
    }

    #[test]
    fn a_refresh_that_ran_alone_is_trusted() {
        let f = freshness();
        let generation = f.generation();
        f.vouch(generation);

        assert!(f.fresh());
    }

    #[test]
    fn a_write_during_a_refresh_stops_it_vouching() {
        let f = freshness();
        let generation = f.generation();

        // The refresh is under way; the write lands before it finishes.
        f.note_write();
        f.vouch(generation);

        assert!(!f.fresh(), "the refresh vouched for mail it had not read");
    }

    #[test]
    fn a_write_after_a_refresh_retracts_the_vouching() {
        let f = freshness();
        f.vouch(f.generation());
        f.note_write();

        assert!(!f.fresh());
    }

    #[test]
    fn a_later_refresh_can_vouch_again_after_a_write() {
        let f = freshness();
        f.note_write();
        f.vouch(f.generation());

        assert!(f.fresh());
    }

    #[test]
    fn the_window_expires() {
        let f = Freshness::new(Duration::ZERO);
        f.vouch(f.generation());

        assert!(!f.fresh());
    }

    #[test]
    fn building_is_reported_while_it_lasts() {
        let f = freshness();
        assert!(!f.building());

        f.begin_build();
        assert!(f.building());

        f.end_build();
        assert!(!f.building());
    }
}
