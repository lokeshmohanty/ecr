use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct MessageId(pub String);

impl MessageId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn query(&self) -> String {
        format!("id:\"{}\"", self.0)
    }
}

impl fmt::Display for MessageId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for MessageId {
    fn from(s: &str) -> Self {
        MessageId(s.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ThreadId(pub String);

impl ThreadId {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn query(&self) -> String {
        format!("thread:\"{}\"", self.0)
    }
}

impl fmt::Display for ThreadId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<&str> for ThreadId {
    fn from(s: &str) -> Self {
        ThreadId(s.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Address {
    pub name: Option<String>,
    pub email: String,
}

impl Address {
    pub fn new(name: Option<String>, email: impl Into<String>) -> Self {
        Self {
            name: name.filter(|n| !n.trim().is_empty()),
            email: email.into(),
        }
    }

    pub fn display(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.email)
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.name {
            Some(name) => write!(f, "{name} <{}>", self.email),
            None => f.write_str(&self.email),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadSummary {
    pub id: ThreadId,
    pub subject: String,
    pub authors: Vec<String>,
    pub timestamp: i64,
    pub date_relative: String,
    pub matched: usize,
    pub total: usize,
    pub tags: BTreeSet<String>,
    pub newest_message: Option<MessageId>,
}

impl ThreadSummary {
    pub fn is_unread(&self) -> bool {
        self.tags.contains("unread")
    }

    pub fn is_flagged(&self) -> bool {
        self.tags.contains("flagged")
    }

    pub fn has_attachment(&self) -> bool {
        self.tags.contains("attachment")
    }

    pub fn account(&self, known: &[&str]) -> Option<String> {
        known
            .iter()
            .find(|a| self.tags.contains(**a))
            .map(|a| a.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Thread {
    pub id: ThreadId,
    pub subject: String,
    pub messages: Vec<Message>,
}

impl Thread {
    pub fn newest(&self) -> Option<&Message> {
        self.messages.iter().max_by_key(|m| m.timestamp)
    }

    pub fn unread_count(&self) -> usize {
        self.messages.iter().filter(|m| m.is_unread()).count()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub id: MessageId,
    pub thread_id: ThreadId,
    pub subject: String,
    pub from: Vec<Address>,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub bcc: Vec<Address>,
    pub reply_to: Vec<Address>,
    pub date: String,
    pub timestamp: i64,
    pub tags: BTreeSet<String>,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub parts: Vec<PartMeta>,
    pub excluded: bool,
}

impl Message {
    pub fn is_unread(&self) -> bool {
        self.tags.contains("unread")
    }

    pub fn attachments(&self) -> impl Iterator<Item = &PartMeta> {
        self.parts
            .iter()
            .filter(|p| p.disposition == Disposition::Attachment)
    }

    pub fn inline_parts(&self) -> impl Iterator<Item = &PartMeta> {
        self.parts.iter().filter(|p| p.content_id.is_some())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    Inline,
    Attachment,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct PartId(pub u32);

impl fmt::Display for PartId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartMeta {
    pub id: PartId,
    pub content_type: String,
    pub filename: Option<String>,
    pub size: usize,
    pub disposition: Disposition,
    pub content_id: Option<String>,
}

impl PartMeta {
    pub fn is_image(&self) -> bool {
        self.content_type.starts_with("image/")
    }

    pub fn display_name(&self) -> String {
        self.filename
            .clone()
            .unwrap_or_else(|| format!("part-{}", self.id))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Part {
    pub meta: PartMeta,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BodyFormat {
    Text,
    Html,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Body {
    pub format: BodyFormat,
    pub content: String,
    pub remote_resources_blocked: usize,
    /// Whether the message carries a real HTML part, so the client knows
    /// whether offering to switch to it means anything.
    pub has_html: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TagOp {
    pub id: MessageId,
    pub add: Vec<String>,
    pub remove: Vec<String>,
}

impl TagOp {
    pub fn new(id: MessageId) -> Self {
        Self {
            id,
            add: Vec::new(),
            remove: Vec::new(),
        }
    }

    pub fn adding(mut self, tag: impl Into<String>) -> Self {
        self.add.push(tag.into());
        self
    }

    pub fn removing(mut self, tag: impl Into<String>) -> Self {
        self.remove.push(tag.into());
        self
    }

    pub fn is_empty(&self) -> bool {
        self.add.is_empty() && self.remove.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Query {
    pub text: String,
    pub limit: usize,
    pub offset: usize,
}

impl Query {
    pub const DEFAULT_LIMIT: usize = 50;

    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            limit: Self::DEFAULT_LIMIT,
            offset: 0,
        }
    }

    pub fn limit(mut self, limit: usize) -> Self {
        self.limit = limit;
        self
    }

    pub fn offset(mut self, offset: usize) -> Self {
        self.offset = offset;
        self
    }

    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty()
    }

    pub fn effective_text(&self) -> &str {
        if self.is_empty() {
            "*"
        } else {
            self.text.trim()
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncReport {
    pub channels: Vec<String>,
    pub new_messages: usize,
    pub duration_ms: u64,
    pub warnings: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_quote_themselves_for_notmuch() {
        assert_eq!(MessageId::from("a@b.c").query(), "id:\"a@b.c\"");
        assert_eq!(
            ThreadId::from("0000000000002899").query(),
            "thread:\"0000000000002899\""
        );
    }

    #[test]
    fn an_empty_query_becomes_the_match_all_query() {
        assert_eq!(Query::new("   ").effective_text(), "*");
        assert_eq!(Query::new("tag:inbox").effective_text(), "tag:inbox");
    }

    #[test]
    fn address_display_prefers_the_name() {
        let named = Address::new(Some("Lokesh".into()), "a@b.c");
        let bare = Address::new(None, "a@b.c");

        assert_eq!(named.display(), "Lokesh");
        assert_eq!(bare.display(), "a@b.c");
        assert_eq!(named.to_string(), "Lokesh <a@b.c>");
        assert_eq!(bare.to_string(), "a@b.c");
    }

    #[test]
    fn a_blank_display_name_is_not_a_name() {
        assert_eq!(Address::new(Some("  ".into()), "a@b.c").display(), "a@b.c");
    }

    #[test]
    fn tag_ops_build_up_and_report_emptiness() {
        let op = TagOp::new(MessageId::from("x"));
        assert!(op.is_empty());

        let op = op.adding("inbox").removing("unread");
        assert_eq!(op.add, vec!["inbox"]);
        assert_eq!(op.remove, vec!["unread"]);
        assert!(!op.is_empty());
    }

    fn summary(tags: &[&str]) -> ThreadSummary {
        ThreadSummary {
            id: ThreadId::from("t"),
            subject: "s".into(),
            authors: vec!["a".into()],
            timestamp: 0,
            date_relative: "now".into(),
            matched: 1,
            total: 1,
            tags: tags.iter().map(|t| t.to_string()).collect(),
            newest_message: None,
        }
    }

    #[test]
    fn thread_flags_read_off_tags() {
        let s = summary(&["inbox", "unread", "attachment"]);
        assert!(s.is_unread());
        assert!(s.has_attachment());
        assert!(!s.is_flagged());
    }

    #[test]
    fn thread_account_comes_from_the_account_tag() {
        let s = summary(&["inbox", "team"]);
        assert_eq!(
            s.account(&["main", "work", "personal", "team"])
                .as_deref(),
            Some("team")
        );
        assert_eq!(summary(&["inbox"]).account(&["main"]), None);
    }
}
