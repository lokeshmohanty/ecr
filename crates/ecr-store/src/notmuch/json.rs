use super::parse_address_list;
use ecr_core::message::{Message, MessageId, ThreadId, ThreadSummary};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
pub struct SearchItem {
    pub thread: String,
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub date_relative: String,
    #[serde(default)]
    pub authors: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub query: Vec<Option<String>>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub matched: usize,
    #[serde(default)]
    pub total: usize,
}

impl SearchItem {
    pub fn into_summary(self) -> ThreadSummary {
        let newest_message = self
            .query
            .into_iter()
            .flatten()
            .next()
            .map(|q| MessageId(q.trim_start_matches("id:").to_string()));

        ThreadSummary {
            id: ThreadId(self.thread),
            authors: split_authors(&self.authors),
            subject: self.subject,
            timestamp: self.timestamp,
            date_relative: self.date_relative,
            matched: self.matched,
            total: self.total,
            tags: self.tags.into_iter().collect(),
            newest_message,
        }
    }
}

fn split_authors(raw: &str) -> Vec<String> {
    raw.split(['|', ','])
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .map(str::to_string)
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(transparent)]
pub struct ShowOutput(pub Vec<Vec<ThreadNode>>);

impl ShowOutput {
    pub fn flatten(self) -> Vec<ShowMessage> {
        let mut out = Vec::new();
        for thread in self.0 {
            for node in thread {
                node.flatten_into(&mut out);
            }
        }
        out
    }
}

#[derive(Debug, Deserialize)]
pub struct ThreadNode(pub ShowMessage, #[serde(default)] pub Vec<ThreadNode>);

impl ThreadNode {
    fn flatten_into(self, out: &mut Vec<ShowMessage>) {
        out.push(self.0);
        for reply in self.1 {
            reply.flatten_into(out);
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ShowMessage {
    pub id: String,
    pub thread: String,
    pub timestamp: i64,
    pub date_relative: String,
    pub tags: Vec<String>,
    pub filename: Vec<PathBuf>,
    pub excluded: bool,
    pub headers: BTreeMap<String, serde_json::Value>,
}

impl ShowMessage {
    fn header(&self, name: &str) -> Option<String> {
        let value = self
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v)?;

        match value {
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Array(items) => {
                let joined = items
                    .iter()
                    .filter_map(|i| i.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                (!joined.is_empty()).then_some(joined)
            }
            _ => None,
        }
    }

    fn addresses(&self, name: &str) -> Vec<super::Address> {
        self.header(name)
            .map(|raw| parse_address_list(&raw))
            .unwrap_or_default()
    }

    pub fn primary_file(&self) -> Option<&PathBuf> {
        self.filename
            .iter()
            .find(|p| p.is_file())
            .or_else(|| self.filename.first())
    }

    pub fn into_message(self) -> Option<Message> {
        if self.id.is_empty() {
            return None;
        }

        let subject = self.header("Subject").unwrap_or_default();
        let date = self.header("Date").unwrap_or_default();
        let from = self.addresses("From");
        let to = self.addresses("To");
        let cc = self.addresses("Cc");
        let bcc = self.addresses("Bcc");
        let reply_to = self.addresses("Reply-To");
        let in_reply_to = self.header("In-Reply-To");
        let references = self
            .header("References")
            .map(|r| {
                r.split_whitespace()
                    .map(|s| s.trim_matches(['<', '>']).to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        let tags: BTreeSet<String> = self.tags.into_iter().collect();

        Some(Message {
            id: MessageId(self.id),
            thread_id: ThreadId(self.thread),
            subject,
            from,
            to,
            cc,
            bcc,
            reply_to,
            date,
            timestamp: self.timestamp,
            tags,
            in_reply_to,
            references,
            parts: Vec::new(),
            excluded: self.excluded,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE_SEARCH: &str = r#"[{
      "thread": "000000000000633e",
      "timestamp": 20250324210,
      "date_relative": "the future",
      "matched": 1,
      "total": 1,
      "authors": "Google",
      "subject": "CRED's access to your Google Account data will expire soon",
      "query": ["id:Igz4LEN4rI70Ta4IkKoKpg@notifications.google.com", null],
      "tags": ["inbox", "main"]
    }]"#;

    #[test]
    fn parses_the_live_search_output() {
        let items: Vec<SearchItem> = serde_json::from_str(LIVE_SEARCH).unwrap();
        let summary = items.into_iter().next().unwrap().into_summary();

        assert_eq!(summary.id.as_str(), "000000000000633e");
        assert_eq!(summary.authors, vec!["Google"]);
        assert!(summary.tags.contains("inbox"));
        assert_eq!(
            summary.newest_message.as_ref().map(|m| m.as_str()),
            Some("Igz4LEN4rI70Ta4IkKoKpg@notifications.google.com")
        );
    }

    #[test]
    fn the_id_prefix_is_stripped_from_the_query_field() {
        let items: Vec<SearchItem> = serde_json::from_str(LIVE_SEARCH).unwrap();
        let summary = items.into_iter().next().unwrap().into_summary();
        assert!(!summary.newest_message.unwrap().as_str().starts_with("id:"));
    }

    #[test]
    fn splits_the_authors_string_notmuch_produces() {
        assert_eq!(
            split_authors("Alice, Bob| Charlie"),
            vec!["Alice", "Bob", "Charlie"]
        );
        assert!(split_authors("").is_empty());
    }

    const LIVE_SHOW: &str = r#"[[[{
      "id": "Igz4LEN4rI70Ta4IkKoKpg@notifications.google.com",
      "match": true,
      "excluded": false,
      "thread": "000000000000633e",
      "filename": ["/nonexistent/a", "/nonexistent/b"],
      "timestamp": 20250324210,
      "date_relative": "the future",
      "tags": ["inbox", "main"],
      "headers": {
        "Subject": "CRED's access will expire",
        "From": "Google <no-reply@accounts.google.com>",
        "To": "alice@example.com",
        "Date": "Mon, 16 Sep 2611 18:03:30 +0000"
      }
    }, []]]]"#;

    #[test]
    fn parses_the_live_show_output() {
        let output: ShowOutput = serde_json::from_str(LIVE_SHOW).unwrap();
        let messages = output.flatten();
        assert_eq!(messages.len(), 1);

        let message = messages.into_iter().next().unwrap().into_message().unwrap();
        assert_eq!(message.subject, "CRED's access will expire");
        assert_eq!(message.from[0].email, "no-reply@accounts.google.com");
        assert_eq!(message.to[0].email, "alice@example.com");
        assert!(message.tags.contains("main"));
    }

    #[test]
    fn nested_replies_are_flattened_in_order() {
        let json = r#"[[[{"id":"a","headers":{}}, [[{"id":"b","headers":{}}, []]]]]]"#;
        let output: ShowOutput = serde_json::from_str(json).unwrap();
        let ids: Vec<_> = output.flatten().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["a", "b"]);
    }

    #[test]
    fn a_ghost_message_without_an_id_is_dropped() {
        let json = r#"[[[{"headers":{}}, []]]]"#;
        let output: ShowOutput = serde_json::from_str(json).unwrap();
        assert!(output
            .flatten()
            .into_iter()
            .all(|m| m.into_message().is_none()));
    }

    #[test]
    fn headers_are_matched_case_insensitively() {
        let json = r#"[[[{"id":"a","headers":{"subject":"lower","REPLY-TO":"x@y.z"}}, []]]]"#;
        let output: ShowOutput = serde_json::from_str(json).unwrap();
        let message = output
            .flatten()
            .into_iter()
            .next()
            .unwrap()
            .into_message()
            .unwrap();

        assert_eq!(message.subject, "lower");
        assert_eq!(message.reply_to[0].email, "x@y.z");
    }

    #[test]
    fn references_are_split_and_unbracketed() {
        let json = r#"[[[{"id":"a","headers":{"References":"<one@x> <two@y>"}}, []]]]"#;
        let output: ShowOutput = serde_json::from_str(json).unwrap();
        let message = output
            .flatten()
            .into_iter()
            .next()
            .unwrap()
            .into_message()
            .unwrap();

        assert_eq!(message.references, vec!["one@x", "two@y"]);
    }
}
