mod batch;
mod json;
mod query;

pub use json::{ShowMessage, ThreadNode};
pub use query::{and, escape_query_value};

use crate::error::{Error, Result};
use crate::paths::MailPaths;
use ecr_core::message::{
    Address, Body, BodyFormat, Message, MessageId, Part, PartId, Query, TagOp, Thread, ThreadId,
    ThreadSummary,
};
use ecr_core::revision::Revision;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::Mutex;

pub struct Notmuch {
    paths: Arc<MailPaths>,
    write_lock: Mutex<()>,
    /// Parsing a message dominates a body request, and a maildir file never
    /// changes in place, so the parse is worth keeping.
    parsed: crate::cache::FileCache<Arc<crate::mime::ParsedMessage>>,
    files: crate::cache::FileCache<PathBuf>,
}

impl Notmuch {
    pub fn new(paths: Arc<MailPaths>) -> Self {
        Self {
            paths,
            write_lock: Mutex::new(()),
            parsed: crate::cache::FileCache::new(256),
            files: crate::cache::FileCache::new(2048),
        }
    }

    pub fn paths(&self) -> &MailPaths {
        &self.paths
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.paths.binaries.notmuch);
        if let Some(config) = &self.paths.notmuch.path {
            command.arg(format!("--config={}", config.display()));
            command.env("NOTMUCH_CONFIG", config);
        }
        command
    }

    async fn run(&self, args: &[&str]) -> Result<String> {
        let output = self
            .command()
            .args(args)
            .output()
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => Error::ToolMissing {
                    tool: crate::tools::NOTMUCH,
                },
                _ => Error::Io(e),
            })?;

        if !output.status.success() {
            return Err(Error::ToolFailed {
                tool: crate::tools::NOTMUCH,
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    async fn run_json<T: serde::de::DeserializeOwned>(&self, args: &[&str]) -> Result<T> {
        let stdout = self.run(args).await?;
        serde_json::from_str(&stdout).map_err(|e| Error::ToolFailed {
            tool: crate::tools::NOTMUCH,
            stderr: format!("could not parse `notmuch {}` output: {e}", args.join(" ")),
        })
    }

    pub async fn revision(&self) -> Result<Revision> {
        let stdout = self.run(&["count", "--lastmod", "*"]).await?;
        parse_lastmod(&stdout)
    }

    pub async fn count(&self, query: &Query) -> Result<usize> {
        let stdout = self.run(&["count", query.effective_text()]).await?;
        stdout.trim().parse().map_err(|_| Error::ToolFailed {
            tool: crate::tools::NOTMUCH,
            stderr: format!("`notmuch count` returned {stdout:?}"),
        })
    }

    /// Counts many queries in one process.
    ///
    /// The sidebar asks for a count per row, and spawning notmuch per row costs
    /// more than the counting does. `--batch` reads one query per line and
    /// writes one count per line, in order. No write lock: counting is a read,
    /// and Xapian's single-writer rule does not reach it.
    ///
    /// An empty line means "everything" to notmuch, so a blank query would
    /// silently return the whole database rather than nothing. They are
    /// substituted before sending and answered as 0.
    pub async fn count_batch(&self, queries: &[String]) -> Result<Vec<u64>> {
        use tokio::io::AsyncWriteExt;

        if queries.is_empty() {
            return Ok(Vec::new());
        }

        const NOTHING: &str = "tag:__ecr_matches_nothing__";
        let batch: String = queries
            .iter()
            .map(|q| {
                let line = q.trim();
                if line.is_empty() { NOTHING } else { line }
            })
            .collect::<Vec<_>>()
            .join("\n");

        let mut child = self
            .command()
            .args(["count", "--batch"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => Error::ToolMissing {
                    tool: crate::tools::NOTMUCH,
                },
                _ => Error::Io(e),
            })?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(batch.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.shutdown().await?;
        }

        let output = child.wait_with_output().await?;
        if !output.status.success() {
            return Err(Error::ToolFailed {
                tool: crate::tools::NOTMUCH,
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            });
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let counts: Vec<u64> = stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| line.trim().parse().unwrap_or(0))
            .collect();

        // A short read would silently shift every count onto the wrong row.
        if counts.len() != queries.len() {
            return Err(Error::ToolFailed {
                tool: crate::tools::NOTMUCH,
                stderr: format!(
                    "`notmuch count --batch` answered {} of {} queries",
                    counts.len(),
                    queries.len()
                ),
            });
        }

        Ok(counts)
    }

    pub async fn search_threads(&self, query: &Query) -> Result<Vec<ThreadSummary>> {
        let limit = format!("--limit={}", query.limit);
        let offset = format!("--offset={}", query.offset);
        let items: Vec<json::SearchItem> = self
            .run_json(&[
                "search",
                "--format=json",
                "--output=summary",
                "--sort=newest-first",
                &limit,
                &offset,
                query.effective_text(),
            ])
            .await?;

        Ok(items
            .into_iter()
            .map(json::SearchItem::into_summary)
            .collect())
    }

    pub async fn thread(&self, id: &ThreadId) -> Result<Thread> {
        let messages = self.show(&id.query()).await?;
        let subject = messages
            .first()
            .map(|m| m.subject.clone())
            .unwrap_or_default();

        Ok(Thread {
            id: id.clone(),
            subject,
            messages,
        })
    }

    pub async fn message(&self, id: &MessageId) -> Result<Message> {
        self.show(&id.query())
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| Error::MessageNotFound { id: id.to_string() })
    }

    async fn show(&self, query: &str) -> Result<Vec<Message>> {
        let output: json::ShowOutput = self
            .run_json(&[
                "show",
                "--format=json",
                "--body=false",
                "--entire-thread=true",
                query,
            ])
            .await?;

        let mut messages: Vec<Message> = output
            .flatten()
            .into_iter()
            .filter_map(|m| m.into_message())
            .collect();

        messages.sort_by_key(|m| m.timestamp);
        Ok(messages)
    }

    pub async fn message_file(&self, id: &MessageId) -> Result<PathBuf> {
        // Resolving a message to its file is a subprocess; the mapping only
        // changes when the message moves, which the mtime check catches.
        if let Some(cached) = self.files.get(id.as_str(), None) {
            if cached.is_file() {
                return Ok(cached);
            }
        }

        let stdout = self
            .run(&["search", "--output=files", "--format=text", &id.query()])
            .await?;

        let path = stdout
            .lines()
            .map(|l| PathBuf::from(l.trim()))
            .find(|p| p.is_file())
            .ok_or_else(|| Error::MessageNotFound { id: id.to_string() })?;

        self.files.insert(id.0.clone(), None, path.clone());
        Ok(path)
    }

    pub async fn parsed(&self, id: &MessageId) -> Result<Arc<crate::mime::ParsedMessage>> {
        let path = self.message_file(id).await?;
        let modified = crate::cache::modified_at(&path);
        let key = path.to_string_lossy().into_owned();

        if let Some(cached) = self.parsed.get(&key, modified) {
            return Ok(cached);
        }

        let raw = tokio::fs::read(&path).await?;
        let parsed = Arc::new(crate::mime::parse(id.as_str(), &raw)?);

        self.parsed.insert(key, modified, Arc::clone(&parsed));
        Ok(parsed)
    }

    pub async fn message_with_parts(&self, id: &MessageId) -> Result<Message> {
        let mut message = self.message(id).await?;
        message.parts = self.parsed(id).await?.parts();
        Ok(message)
    }

    pub async fn body(
        &self,
        id: &MessageId,
        format: BodyFormat,
        allow_remote_resources: bool,
    ) -> Result<Body> {
        let parsed = self.parsed(id).await?;
        let ctx = crate::mime::SanitizeContext::new(
            format!("/api/v1/messages/{id}/parts/"),
            allow_remote_resources,
        );
        Ok(parsed.body(format, &ctx))
    }

    pub async fn part(&self, id: &MessageId, part: &PartId) -> Result<Part> {
        self.parsed(id)
            .await?
            .part(part)
            .ok_or_else(|| Error::PartNotFound {
                id: id.to_string(),
                part: part.0,
            })
    }

    /// The address book, built from who you have written to and who has
    /// written to you. Recipients are collected first so they outrank senders.
    pub async fn address_book(&self, limit: usize) -> Result<crate::address::AddressBook> {
        use crate::address::{AddressBook, Source};

        let mut book = AddressBook::new();

        let recipients = self
            .run(&[
                "address",
                "--output=recipients",
                "--deduplicate=address",
                "tag:sent or tag:draft",
            ])
            .await
            .unwrap_or_default();
        book.add_lines(&recipients, Source::Recipient);

        let senders = self
            .run(&["address", "--output=sender", "--deduplicate=address", "*"])
            .await
            .unwrap_or_default();
        book.add_lines(&senders, Source::Sender);

        let _ = limit;
        Ok(book)
    }

    /// Every tag in the database, for query completion.
    pub async fn tags(&self) -> Result<Vec<String>> {
        let stdout = self.run(&["search", "--output=tags", "*"]).await?;
        Ok(stdout
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }

    pub async fn tag(&self, ops: &[TagOp]) -> Result<Revision> {
        self.tag_batch(&batch::build(ops)?).await
    }

    pub async fn tag_batch(&self, batch: &str) -> Result<Revision> {
        use tokio::io::AsyncWriteExt;

        if batch.trim().is_empty() {
            return self.revision().await;
        }

        let _guard = self.write_lock.lock().await;

        let mut child = self
            .command()
            .args(["tag", "--batch"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => Error::ToolMissing {
                    tool: crate::tools::NOTMUCH,
                },
                _ => Error::Io(e),
            })?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(batch.as_bytes()).await?;
            stdin.shutdown().await?;
        }

        let output = child.wait_with_output().await?;
        if !output.status.success() {
            return Err(Error::ToolFailed {
                tool: crate::tools::NOTMUCH,
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            });
        }

        drop(_guard);
        self.revision().await
    }

    pub async fn index_new(&self) -> Result<Revision> {
        let _guard = self.write_lock.lock().await;
        self.run(&["new", "--quiet"]).await?;
        drop(_guard);
        self.revision().await
    }
}

fn parse_lastmod(stdout: &str) -> Result<Revision> {
    let line = stdout.trim();
    let mut fields = line.split_whitespace();
    let (_count, uuid, lastmod) = (fields.next(), fields.next(), fields.next());

    match (uuid, lastmod) {
        (Some(uuid), Some(lastmod)) => lastmod
            .parse()
            .map(|lastmod| Revision::new(uuid, lastmod))
            .map_err(|_| Error::ToolFailed {
                tool: crate::tools::NOTMUCH,
                stderr: format!("unparseable lastmod in {line:?}"),
            }),
        _ => Err(Error::ToolFailed {
            tool: crate::tools::NOTMUCH,
            stderr: format!("unexpected `notmuch count --lastmod` output: {line:?}"),
        }),
    }
}

pub fn parse_address_list(raw: &str) -> Vec<Address> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut in_angle = false;

    for ch in raw.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                current.push(ch);
            }
            '<' if !in_quotes => {
                in_angle = true;
                current.push(ch);
            }
            '>' if !in_quotes => {
                in_angle = false;
                current.push(ch);
            }
            ',' if !in_quotes && !in_angle => {
                push_address(&mut out, &current);
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    push_address(&mut out, &current);
    out
}

fn push_address(out: &mut Vec<Address>, raw: &str) {
    let raw = raw.trim();
    if raw.is_empty() {
        return;
    }

    match (raw.find('<'), raw.rfind('>')) {
        (Some(start), Some(end)) if end > start => {
            let name = raw[..start].trim().trim_matches('"').trim();
            let email = raw[start + 1..end].trim();
            if !email.is_empty() {
                out.push(Address::new(
                    (!name.is_empty()).then(|| name.to_string()),
                    email,
                ));
            }
        }
        _ => out.push(Address::new(None, raw)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_live_lastmod_line() {
        let rev = parse_lastmod("45865\tc92ee515-acf5-452e-a148-5941a7e9852f\t227965\n").unwrap();
        assert_eq!(rev.uuid, "c92ee515-acf5-452e-a148-5941a7e9852f");
        assert_eq!(rev.lastmod, 227965);
    }

    #[test]
    fn rejects_unexpected_lastmod_output() {
        assert!(parse_lastmod("").is_err());
        assert!(parse_lastmod("45865").is_err());
        assert!(parse_lastmod("45865\tuuid\tnot-a-number").is_err());
    }

    #[test]
    fn parses_a_plain_address() {
        let addrs = parse_address_list("alice@example.com");
        assert_eq!(addrs.len(), 1);
        assert_eq!(addrs[0].email, "alice@example.com");
        assert_eq!(addrs[0].name, None);
    }

    #[test]
    fn parses_a_named_address() {
        let addrs = parse_address_list("Google <no-reply@accounts.google.com>");
        assert_eq!(addrs[0].name.as_deref(), Some("Google"));
        assert_eq!(addrs[0].email, "no-reply@accounts.google.com");
    }

    #[test]
    fn a_comma_inside_a_quoted_name_does_not_split_the_list() {
        let addrs = parse_address_list("\"Doe, Jane\" <a@b.c>, Other <d@e.f>");
        assert_eq!(addrs.len(), 2);
        assert_eq!(addrs[0].name.as_deref(), Some("Doe, Jane"));
        assert_eq!(addrs[0].email, "a@b.c");
        assert_eq!(addrs[1].email, "d@e.f");
    }

    #[test]
    fn an_empty_header_yields_no_addresses() {
        assert!(parse_address_list("").is_empty());
        assert!(parse_address_list("  ,  ").is_empty());
    }
}
