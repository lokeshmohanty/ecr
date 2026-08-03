use super::MessageIndex;
use crate::error::Result;
use crate::notmuch::Notmuch;
use ecr_core::revision::Revision;
use std::time::{Duration, Instant};

/// How much of notmuch's modification counter one `notmuch show` covers. Large
/// enough that a first build of a real inbox is a handful of processes, small
/// enough that each one's JSON is megabytes rather than hundreds.
const CHUNK: u64 = 2_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refreshed {
    pub revision: Revision,
    pub messages: u64,
    pub rebuilt: bool,
    pub took: Duration,
}

/// Brings the index up to the database's current revision.
///
/// notmuch stamps every message with the modification counter it was last
/// written at, so the work is bounded by what changed: `lastmod:a..b` names
/// exactly the messages a refresh has to re-read. Each chunk lands with the
/// watermark it covers, so an interrupted refresh resumes rather than restarts.
pub async fn refresh(index: &MessageIndex, notmuch: &Notmuch) -> Result<Refreshed> {
    Ok(run(index, notmuch, true)
        .await?
        .expect("a rebuild is allowed"))
}

/// The same, except that it declines to rebuild.
///
/// A rebuild reads the whole database, which is seconds on a real inbox — far
/// longer than the notmuch call it exists to save. A read that finds the index
/// that far behind is better served by notmuch while a refresh happens
/// somewhere it is not being waited on.
pub async fn refresh_incremental(
    index: &MessageIndex,
    notmuch: &Notmuch,
) -> Result<Option<Refreshed>> {
    run(index, notmuch, false).await
}

async fn run(
    index: &MessageIndex,
    notmuch: &Notmuch,
    may_rebuild: bool,
) -> Result<Option<Refreshed>> {
    let started = Instant::now();
    let (revision, total) = notmuch.revision_and_total().await?;
    let held = index.revision()?;

    // A deletion leaves nothing behind for `lastmod:` to name — the message is
    // simply gone — so the count is the only thing that can notice one. Any
    // disagreement rebuilds rather than trying to work out which rows to drop.
    let deletions = held.is_some() && index.message_count()? > total;

    let rebuilt = match &held {
        Some(held) if held.uuid == revision.uuid && held.lastmod <= revision.lastmod => deletions,
        _ => true,
    };

    if rebuilt && !may_rebuild {
        return Ok(None);
    }
    if rebuilt {
        index.clear()?;
    }

    let mut from = match (rebuilt, &held) {
        (false, Some(held)) => held.lastmod + 1,
        _ => 0,
    };

    while from <= revision.lastmod {
        let to = (from + CHUNK - 1).min(revision.lastmod);
        let messages = notmuch.messages_between(from, to).await?;
        index.apply(&messages, &Revision::new(&revision.uuid, to))?;
        from = to + 1;
    }

    Ok(Some(Refreshed {
        revision,
        messages: index.message_count()?,
        rebuilt,
        took: started.elapsed(),
    }))
}
