mod batch;
mod json;
mod query;

pub use json::{ShowMessage, ThreadNode};
pub use query::{and, escape_query_value};

use crate::error::{Error, Result};
use crate::paths::MailPaths;
use ecr_core::message::{
    Address, Message, MessageId, Query, TagOp, Thread, ThreadId, ThreadSummary,
};
use ecr_core::revision::Revision;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::process::Command;
use tokio::sync::Mutex;

pub struct Notmuch {
    paths: Arc<MailPaths>,
    write_lock: Mutex<()>,
}

impl Notmuch {
    pub fn new(paths: Arc<MailPaths>) -> Self {
        Self {
            paths,
            write_lock: Mutex::new(()),
        }
    }

    pub fn paths(&self) -> &MailPaths {
        &self.paths
    }

    fn command(&self) -> Command {
        let mut command = Command::new(crate::tools::NOTMUCH);
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
        let stdout = self
            .run(&["search", "--output=files", "--format=text", &id.query()])
            .await?;

        stdout
            .lines()
            .map(|l| PathBuf::from(l.trim()))
            .find(|p| p.is_file())
            .ok_or_else(|| Error::MessageNotFound { id: id.to_string() })
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
