use crate::error::Result;
use rusqlite::Connection;

/// Bumped whenever the tables below change shape. A database at any other
/// version is discarded and rebuilt rather than migrated: every row in here is
/// a copy of something notmuch still holds, so rebuilding costs time and
/// nothing else, and a migration path would be code that can only ever be
/// wrong about mail it did not write.
pub const VERSION: i64 = 3;

const DDL: &str = "
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- `num` is the rowid under a name, so it survives a VACUUM and can be a
-- foreign key. It is also the FTS5 rowid, which is what ties a message to its
-- indexed headers.
CREATE TABLE messages (
    num       INTEGER PRIMARY KEY,
    id        TEXT NOT NULL UNIQUE,
    thread    TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    subject   TEXT NOT NULL,
    author    TEXT NOT NULL,
    -- Where the file is, so a snippet can be read without asking notmuch
    -- again. Free here: `notmuch show` already reports it.
    path      TEXT,
    -- The first line or two of the body. NULL means not read yet, which is
    -- not the same as empty: a message really can have no text, and a row that
    -- kept being retried would read every empty message on every pass.
    snippet   TEXT
);
CREATE INDEX messages_thread ON messages (thread, timestamp);
CREATE INDEX messages_timestamp ON messages (timestamp);

CREATE TABLE tags (
    message INTEGER NOT NULL REFERENCES messages (num) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (message, tag)
) WITHOUT ROWID;
CREATE INDEX tags_tag ON tags (tag, message);
";

/// There is deliberately no full-text table. See `plan.rs`: an FTS index over
/// the headers does not select the same messages Xapian does, so text search
/// stays notmuch's and nothing here has to carry the words.
pub fn prepare(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;

    let version: i64 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version == VERSION && has_tables(conn)? {
        return Ok(());
    }

    reset(conn)
}

pub fn reset(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        // `search` is a table an older ecr built and this one does not.
        "DROP TABLE IF EXISTS search;
         DROP TABLE IF EXISTS tags;
         DROP TABLE IF EXISTS messages;
         DROP TABLE IF EXISTS meta;",
    )?;
    conn.execute_batch(DDL)?;
    conn.pragma_update(None, "user_version", VERSION)?;
    Ok(())
}

/// A `user_version` that matches proves nothing about a file that was truncated
/// or half-written; the tables it names are what the queries actually need.
fn has_tables(conn: &Connection) -> Result<bool> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master
          WHERE name IN ('meta', 'messages', 'tags')",
        [],
        |row| row.get(0),
    )?;
    Ok(found == 3)
}
