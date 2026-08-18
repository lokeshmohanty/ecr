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
    /// Whether the index has been found to disagree with notmuch.
    condemned: AtomicBool,
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
            condemned: AtomicBool::new(false),
            writes: AtomicU64::new(0),
        }
    }

    /// Whether the index has been found holding something other than what
    /// notmuch holds.
    ///
    /// A condemned index answers nothing at all: every read goes to notmuch,
    /// which is slower and right. It is not a cache that is merely behind —
    /// being behind is what `fresh` is about, and catching up fixes it — it is
    /// a cache whose contents have been shown to be wrong, and only a rebuild
    /// fixes that. Reads cannot rebuild, so the flag is what carries the
    /// finding from the read that made it to the task that can act on it, and
    /// what stops every read in between paying for the same discovery.
    pub fn condemned(&self) -> bool {
        self.condemned.load(Ordering::SeqCst)
    }

    pub fn condemn(&self) {
        self.condemned.store(true, Ordering::SeqCst);
        if let Ok(mut at) = self.verified.lock() {
            *at = None;
        }
    }

    /// A rebuild put it back in service.
    pub fn absolve(&self) {
        self.condemned.store(false, Ordering::SeqCst);
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
    fn a_condemned_index_is_not_fresh_however_recently_it_was_vouched_for() {
        let f = freshness();
        f.vouch(f.generation());
        f.condemn();

        assert!(f.condemned());
        assert!(!f.fresh(), "a vouching survived the index being condemned");
    }

    #[test]
    fn only_a_rebuild_lifts_a_condemnation() {
        let f = freshness();
        f.condemn();

        // Everything a refresh does short of rebuilding leaves it condemned:
        // the contents are wrong, and catching up does not make them right.
        f.note_write();
        f.vouch(f.generation());
        assert!(f.condemned());

        f.absolve();
        assert!(!f.condemned());
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
