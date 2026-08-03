//! A SQLite mirror of what notmuch knows about each message.
//!
//! Every request otherwise costs a notmuch process. The mirror carries message
//! metadata — id, thread, timestamp, subject, sender, tags — and answers the
//! queries it can prove it answers *identically*: tags, ids, threads, `*`, and
//! booleans of those. That is every mailbox the sidebar offers and every count
//! beside them. Anything else, and any failure at all, falls through to notmuch
//! — see [`plan`], which also records why text search is not on the list.
//!
//! It carries no words, so it is small: a 46k-message maildir is about 9MB.
//!
//! notmuch remains the only writer of mail state. Nothing in here is a source
//! of truth; the file can be deleted at any point and is rebuilt on the next
//! refresh.

mod plan;
mod relative;
mod schema;
mod sync;

use crate::error::Result;
use crate::paths::MailPaths;
use ecr_core::message::{Message, Query, ThreadId, ThreadSummary};
use ecr_core::revision::Revision;
use rusqlite::{Connection, OptionalExtension};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub use sync::{refresh, refresh_incremental, Refreshed};

/// What the index holds, for `ecr doctor`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexStatus {
    pub path: Option<PathBuf>,
    pub revision: Option<Revision>,
    pub messages: u64,
    pub bytes: u64,
}

pub struct MessageIndex {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
    exclude_tags: Vec<String>,
}

impl MessageIndex {
    pub fn file_name() -> &'static str {
        "index.sqlite3"
    }

    pub fn path_for(paths: &MailPaths) -> PathBuf {
        paths.ecr_state_dir.join(Self::file_name())
    }

    pub fn open(paths: &MailPaths) -> Result<Self> {
        let path = Self::path_for(paths);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Self::open_at(&path, paths.notmuch_config.exclude_tags.clone())
    }

    pub fn open_at(path: &Path, exclude_tags: Vec<String>) -> Result<Self> {
        let conn = Connection::open(path)?;
        schema::prepare(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
            path: Some(path.to_path_buf()),
            exclude_tags,
        })
    }

    pub fn in_memory(exclude_tags: Vec<String>) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        schema::prepare(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
            path: None,
            exclude_tags,
        })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| crate::Error::Index("the index lock was poisoned".into()))?;
        f(&conn)
    }

    pub fn revision(&self) -> Result<Option<Revision>> {
        self.with(|conn| {
            let uuid: Option<String> = meta(conn, "uuid")?;
            let lastmod: Option<String> = meta(conn, "lastmod")?;
            Ok(match (uuid, lastmod.and_then(|v| v.parse().ok())) {
                (Some(uuid), Some(lastmod)) => Some(Revision { uuid, lastmod }),
                _ => None,
            })
        })
    }

    pub fn message_count(&self) -> Result<u64> {
        self.with(|conn| {
            let count: i64 =
                conn.query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))?;
            Ok(count as u64)
        })
    }

    pub fn status(&self) -> IndexStatus {
        IndexStatus {
            path: self.path.clone(),
            revision: self.revision().ok().flatten(),
            messages: self.message_count().unwrap_or(0),
            bytes: self
                .path
                .as_ref()
                .and_then(|p| std::fs::metadata(p).ok())
                .map(|m| m.len())
                .unwrap_or(0),
        }
    }

    /// `None` when the query is not one the index can answer identically.
    pub fn search_threads(&self, query: &Query) -> Result<Option<Vec<ThreadSummary>>> {
        let Some(plan) = plan::plan(query.effective_text(), &self.exclude_tags) else {
            return Ok(None);
        };

        self.with(|conn| {
            let page = thread_page(conn, &plan, query.limit, query.offset)?;
            if page.is_empty() {
                return Ok(Some(Vec::new()));
            }
            Ok(Some(summaries(conn, &plan, page)?))
        })
    }

    pub fn count(&self, text: &str) -> Result<Option<u64>> {
        let Some(plan) = plan::plan(text, &self.exclude_tags) else {
            return Ok(None);
        };

        self.with(|conn| {
            let sql = format!(
                "SELECT COUNT(*) FROM messages m WHERE {}",
                plan.predicate(plan::Shape::Set)
            );
            let count: i64 =
                conn.query_row(&sql, rusqlite::params_from_iter(&plan.params), |row| {
                    row.get(0)
                })?;
            Ok(Some(count as u64))
        })
    }

    /// Replaces what the index holds for these messages, in one transaction, and
    /// moves the watermark with them. A refresh interrupted halfway therefore
    /// resumes from the last chunk that landed rather than starting over.
    pub fn apply(&self, messages: &[Message], revision: &Revision) -> Result<()> {
        self.with(|conn| {
            let tx = conn.unchecked_transaction()?;
            for message in messages {
                upsert(&tx, message)?;
            }
            set_meta(&tx, "uuid", &revision.uuid)?;
            set_meta(&tx, "lastmod", &revision.lastmod.to_string())?;
            tx.commit()?;
            Ok(())
        })
    }

    pub fn clear(&self) -> Result<()> {
        self.with(schema::reset)
    }
}

fn meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM meta WHERE key = ?", [key], |row| {
            row.get(0)
        })
        .optional()?)
}

fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

fn upsert(conn: &Connection, message: &Message) -> Result<()> {
    let author = message
        .from
        .first()
        .map(|a| a.display().to_string())
        .unwrap_or_default();

    let num: i64 = conn.query_row(
        "INSERT INTO messages (id, thread, timestamp, subject, author)
              VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
              thread = excluded.thread,
              timestamp = excluded.timestamp,
              subject = excluded.subject,
              author = excluded.author
         RETURNING num",
        rusqlite::params![
            message.id.as_str(),
            message.thread_id.as_str(),
            message.timestamp,
            message.subject,
            author,
        ],
        |row| row.get(0),
    )?;

    conn.execute("DELETE FROM tags WHERE message = ?", [num])?;
    let mut insert = conn.prepare_cached("INSERT INTO tags (message, tag) VALUES (?, ?)")?;
    for tag in &message.tags {
        insert.execute(rusqlite::params![num, tag])?;
    }

    Ok(())
}

struct Page {
    thread: String,
    timestamp: i64,
}

/// The page of threads, newest first.
///
/// A thread's sort key is its newest *matched* message, so walking matched
/// messages newest-first and keeping each thread the first time it appears
/// produces exactly that order — with no aggregation, and without looking
/// beyond the page. The obvious `GROUP BY thread ORDER BY MAX(timestamp)` is
/// the same answer computed over every match in the database: 94ms against a
/// 46k inbox where this is 2ms, because a page of fifty is fifty rows of work
/// either way and the aggregate does not know that.
///
/// Rows are pulled lazily, so stopping is free and no limit has to be guessed
/// in advance — a page of fifty threads may take fifty rows or five hundred,
/// depending on how many messages each thread has.
fn thread_page(
    conn: &Connection,
    plan: &plan::Plan,
    limit: usize,
    offset: usize,
) -> Result<Vec<Page>> {
    let wanted = offset.saturating_add(limit);
    if wanted == 0 {
        return Ok(Vec::new());
    }

    let sql = format!(
        "SELECT m.thread, m.timestamp
           FROM messages m
          WHERE {}
          ORDER BY m.timestamp DESC",
        plan.predicate(plan::Shape::Scan)
    );

    let mut statement = conn.prepare(&sql)?;
    let mut rows = statement.query(rusqlite::params_from_iter(&plan.params))?;

    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut found: Vec<Page> = Vec::new();

    while let Some(row) = rows.next()? {
        let timestamp: i64 = row.get(1)?;

        // Two threads whose newest matched message shares a timestamp are
        // ordered by thread id, and no ordering the timestamp index can supply
        // does that — asking SQL for it costs a sort of every match. Instead
        // the walk runs on past the page to the end of the timestamp it ended
        // in, so the whole tied group is in hand before it is ordered. Rows
        // arrive in timestamp order, so a group is always contiguous.
        if found.len() >= wanted && found.last().is_some_and(|p| p.timestamp != timestamp) {
            break;
        }

        let thread: String = row.get(0)?;
        if seen.insert(thread.clone()) {
            found.push(Page { thread, timestamp });
        }
    }

    found.sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then(a.thread.cmp(&b.thread)));

    Ok(found.into_iter().skip(offset).take(limit).collect())
}

struct Row {
    thread: String,
    id: String,
    subject: String,
    author: String,
    matched: bool,
}

/// notmuch's thread subject is the **newest matched** message's, with one
/// leading `Re: ` removed once — never repeatedly, and nothing else removed:
/// `Fw: `, `Fwd: ` and `Undeliverable: ` all stay.
///
/// Every word of that had to be measured, and three plausible readings are
/// wrong. *Newest*, because the search is sorted newest-first and notmuch names
/// the thread after the message it reached first — "the subject it started
/// with" is the intuitive rule and it disagrees on any thread that was renamed,
/// bounced, or forwarded onward. *Matched*, because the same thread answers
/// differently to different queries; a query that excludes the newest message
/// names the thread after the newest one that survived. And the header is
/// otherwise passed through, so a subject that arrives padded keeps its
/// trailing spaces — tidying it here is a disagreement, not an improvement.
///
/// Fixtures cannot catch any of this: a reply to `X` is `Re: X`, so every rule
/// produces the same string. It was settled by running both paths over a real
/// 46k maildir and comparing 1,907 thread rows, which is the only thing that
/// distinguishes them.
fn thread_subject(newest: &str) -> String {
    match newest.get(..4) {
        Some(head) if head.eq_ignore_ascii_case("re: ") => newest[4..].to_string(),
        _ => newest.to_string(),
    }
}

fn summaries(conn: &Connection, plan: &plan::Plan, page: Vec<Page>) -> Result<Vec<ThreadSummary>> {
    let threads: Vec<&str> = page.iter().map(|p| p.thread.as_str()).collect();
    let holes = vec!["?"; threads.len()].join(", ");

    // Ordered oldest-first: the thread's subject is its oldest message's, and
    // notmuch lists authors in the order they wrote.
    //
    // The predicate is a *selected expression* rather than a subquery the rows
    // are tested against, so it is evaluated only for the messages of these
    // fifty threads. Written as `num IN (SELECT … WHERE <predicate>)` it is
    // instead evaluated across the whole table to build the set first.
    let sql = format!(
        "SELECT m.thread, m.id, m.subject, m.author, ({})
           FROM messages m
          WHERE m.thread IN ({holes})
          ORDER BY m.thread, m.timestamp, m.num",
        plan.predicate(plan::Shape::Scan)
    );

    let params = plan
        .params
        .iter()
        .map(|p| p.as_str())
        .chain(threads.iter().copied())
        .collect::<Vec<&str>>();

    let mut statement = conn.prepare(&sql)?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(params), |row| {
            Ok(Row {
                thread: row.get(0)?,
                id: row.get(1)?,
                subject: row.get(2)?,
                author: row.get(3)?,
                matched: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut by_thread: BTreeMap<String, Vec<Row>> = BTreeMap::new();
    for row in rows {
        by_thread.entry(row.thread.clone()).or_default().push(row);
    }

    let tags = thread_tags(conn, &threads, &holes)?;
    let now = relative::now();

    Ok(page
        .into_iter()
        .map(|entry| {
            let rows = by_thread.remove(&entry.thread).unwrap_or_default();
            let (matched, unmatched): (Vec<&Row>, Vec<&Row>) =
                rows.iter().partition(|row| row.matched);

            ThreadSummary {
                id: ThreadId(entry.thread.clone()),
                subject: matched
                    .last()
                    .map(|r| thread_subject(&r.subject))
                    .unwrap_or_default(),
                authors: authors(&matched, &unmatched),
                timestamp: entry.timestamp,
                date_relative: relative::describe(entry.timestamp, now),
                matched: matched.len(),
                total: rows.len(),
                tags: tags.get(&entry.thread).cloned().unwrap_or_default(),
                newest_message: matched.last().map(|row| row.id.as_str().into()),
            }
        })
        .collect())
}

/// notmuch's thread tags are the union over every message in the thread,
/// matched or not — a thread carrying one deleted message reports `deleted`
/// even when the query excluded it.
fn thread_tags(
    conn: &Connection,
    threads: &[&str],
    holes: &str,
) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let sql = format!(
        "SELECT m.thread, t.tag
           FROM messages m JOIN tags t ON t.message = m.num
          WHERE m.thread IN ({holes})"
    );

    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(rusqlite::params_from_iter(threads), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for row in rows {
        let (thread, tag) = row?;
        out.entry(thread).or_default().insert(tag);
    }
    Ok(out)
}

/// Matched authors first, then the rest, each deduplicated and in date order.
///
/// notmuch renders this as `a, b| c` and the caller splits it back apart on
/// both separators. The index has the real per-message list and could skip the
/// round trip — but a name with a comma in it survives that and does not
/// survive notmuch's, so the two paths would disagree on every message from
/// `Anthropic, PBC`. It goes through the same lossy rendering deliberately;
/// see `split_authors`.
fn authors(matched: &[&Row], unmatched: &[&Row]) -> Vec<String> {
    fn join(rows: &[&Row], seen: &mut BTreeSet<String>) -> String {
        rows.iter()
            .filter(|row| !row.author.is_empty() && seen.insert(row.author.clone()))
            .map(|row| row.author.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }

    let mut seen = BTreeSet::new();
    let rendered = format!(
        "{}|{}",
        join(matched, &mut seen),
        join(unmatched, &mut seen)
    );

    crate::notmuch::split_authors(&rendered)
}

#[cfg(test)]
mod tests;
