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
    Ok(run(index, notmuch, true, Audit::Counts)
        .await?
        .expect("a rebuild is allowed"))
}

/// The same, plus a message-for-message check that the index holds exactly what
/// notmuch holds.
///
/// One extra `notmuch search` and one table scan, so it belongs where a rebuild
/// already would: a server starting up. It is the only check that sees a
/// missed write and a stale row cancelling each other out in the count.
pub async fn verify(index: &MessageIndex, notmuch: &Notmuch) -> Result<Refreshed> {
    Ok(run(index, notmuch, true, Audit::Ids)
        .await?
        .expect("a rebuild is allowed"))
}

/// The same, except that it declines to rebuild.
///
/// A rebuild reads the whole database, which is seconds on a real inbox — far
/// longer than the notmuch call it exists to save. A read that finds the index
/// that far behind is better served by notmuch while a refresh happens
/// somewhere it is not being waited on. `None` says exactly that: do not use
/// this index, and rebuild it where nobody is waiting.
pub async fn refresh_incremental(
    index: &MessageIndex,
    notmuch: &Notmuch,
) -> Result<Option<Refreshed>> {
    run(index, notmuch, false, Audit::Counts).await
}

/// How hard the audit looks. See [`audit`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Audit {
    Counts,
    Ids,
}

async fn run(
    index: &MessageIndex,
    notmuch: &Notmuch,
    may_rebuild: bool,
    depth: Audit,
) -> Result<Option<Refreshed>> {
    let started = Instant::now();
    let revision = notmuch.revision().await?;
    let held = index.revision()?;

    // Catching up is only possible forwards, and only within the database the
    // index was built against.
    let resumable = matches!(
        &held,
        Some(held) if held.uuid == revision.uuid && held.lastmod <= revision.lastmod
    );

    let mut rebuilt = !resumable;
    if rebuilt && !may_rebuild {
        return Ok(None);
    }
    if rebuilt {
        index.clear()?;
    }

    let from = match (&held, resumable) {
        (Some(held), true) => held.lastmod + 1,
        _ => 0,
    };
    catch_up(index, notmuch, from, &revision).await?;

    let mut revision = revision;
    if let Some(disagreement) = audit(index, notmuch, &revision, depth).await? {
        if !may_rebuild {
            return Ok(None);
        }

        tracing::warn!(%disagreement, "the mail index disagrees with notmuch; rebuilding it");
        index.clear()?;
        revision = notmuch.revision().await?;
        catch_up(index, notmuch, 0, &revision).await?;
        rebuilt = true;
    }

    Ok(Some(Refreshed {
        revision,
        messages: index.message_count()?,
        rebuilt,
        took: started.elapsed(),
    }))
}

async fn catch_up(
    index: &MessageIndex,
    notmuch: &Notmuch,
    from: u64,
    revision: &Revision,
) -> Result<()> {
    let mut from = from;
    while from <= revision.lastmod {
        let to = (from + CHUNK - 1).min(revision.lastmod);
        let messages = notmuch.messages_between(from, to).await?;
        index.apply(&messages, &Revision::new(&revision.uuid, to))?;
        from = to + 1;
    }
    Ok(())
}

/// Whether the index still holds what notmuch holds — and if not, what to put
/// in the log.
///
/// **A watermark cannot answer this, and that is the whole reason this
/// exists.** `lastmod:` names what *changed*; it names nothing at all for a
/// message that was deleted, and nothing for a message the index simply failed
/// to write. Either way the index goes on claiming notmuch's exact revision, so
/// every later refresh starts at `lastmod + 1` and finds nothing to do, for
/// ever. That is not hypothetical: an index was found holding 826 messages
/// fewer and 169 messages more than notmuch, at notmuch's exact uuid and
/// lastmod. Threads containing one of those stale rows could never be marked
/// read or deleted — the row's `unread` survived every write, and because it
/// was also the newest message in its thread the client named *it* in the tag
/// operation, which `notmuch tag --batch` then matched against nothing and
/// exited 0 on.
///
/// So the audit is a second, independent question, asked after every catch-up
/// rather than instead of one. `Counts` is one process and answers it for
/// anything that changed the number of messages, which is every delivery and
/// every deletion. `Ids` is the exhaustive form, for the one case counts cannot
/// see: a message missed and a message deleted cancelling out.
///
/// Answering `None` because the database moved is deliberate. The count read
/// after a catch-up describes a database that has since gained mail, and a
/// rebuild on the strength of that would be a rebuild per delivery. The next
/// refresh asks again, from a database that is standing still.
async fn audit(
    index: &MessageIndex,
    notmuch: &Notmuch,
    caught_up_to: &Revision,
    depth: Audit,
) -> Result<Option<String>> {
    let (now, total) = notmuch.revision_and_total().await?;
    if &now != caught_up_to {
        return Ok(None);
    }

    let held = index.message_count()?;
    if held != total {
        return Ok(Some(format!(
            "the index holds {held} messages, notmuch holds {total}"
        )));
    }

    if depth == Audit::Counts {
        return Ok(None);
    }

    let theirs = notmuch.all_message_ids().await?;
    let ours = index.message_ids()?;
    if ours == theirs {
        return Ok(None);
    }

    let missing = theirs.difference(&ours).count();
    let stale = ours.difference(&theirs).count();
    Ok(Some(format!(
        "the index is missing {missing} messages and holds {stale} notmuch no longer has"
    )))
}
