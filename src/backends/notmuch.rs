use crate::models::{Email, Thread};
use serde::Deserialize;
use std::collections::HashSet;
use tokio::process::Command;

#[derive(Deserialize, Debug)]
pub struct NotmuchSearchItem {
    pub thread: String,
    pub timestamp: i64,
    pub date_relative: String,
    pub authors: String,
    pub subject: String,
    pub query: Vec<Option<String>>,
    pub tags: Vec<String>,
    pub matched: usize,
    pub total: Option<usize>,
}

// Notused ThreadItem anymore, search implicitly outputs thread summaries


#[derive(Deserialize, Debug)]
#[serde(untagged)]
pub enum NotmuchShowBody {
    Part(NotmuchPart),
    Nested(Vec<NotmuchShowBody>),
}

#[derive(Deserialize, Debug)]
pub struct NotmuchPart {
    pub id: i32,
    #[serde(rename = "content-type")]
    pub content_type: String,
    pub content: Option<NotmuchContent>,
}

#[derive(Deserialize, Debug)]
#[serde(untagged)]
pub enum NotmuchContent {
    Text(String),
    Parts(Vec<NotmuchShowBody>),
}

pub struct NotmuchBackend {
    pub config_path: String,
}

impl Default for NotmuchBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl NotmuchBackend {
    pub fn new() -> Self {
        let config_path = std::env::var("NOTMUCH_CONFIG").unwrap_or_else(|_| {
            dirs::home_dir()
                .map(|h| h.join(".notmuch-config").to_string_lossy().to_string())
                .unwrap_or_else(|| "/home/alice/.notmuch-config".to_string())
        });
        Self { config_path }
    }

    async fn run_command<S: AsRef<str>>(&self, args: &[S]) -> std::io::Result<String> {
        let mut command = Command::new("notmuch");
        command.arg(format!("--config={}", self.config_path));
        for arg in args {
            command.arg(arg.as_ref());
        }

        let output = command.output().await?;

        if !output.status.success() {
            return Err(std::io::Error::other(String::from_utf8_lossy(
                &output.stderr,
            )));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    pub async fn search(&self, query: &str, limit: usize) -> std::io::Result<Vec<Email>> {
        let limit_arg = format!("--limit={}", limit);
        let args = vec!["search", "--format=json", &limit_arg, query];
        let output = self.run_command(&args).await?;

        let items: Vec<NotmuchSearchItem> = serde_json::from_str(&output).map_err(|e| {
            std::io::Error::other(format!("Search JSON parse error: {}", e))
        })?;

        let emails = items
            .into_iter()
            .enumerate()
            .map(|(id, item)| {
                let message_id = item
                    .query
                    .first()
                    .and_then(|q| q.as_ref())
                    .cloned()
                    .unwrap_or_default();

                let read = !item.tags.iter().any(|t| t == "unread");
                let flagged = item.tags.iter().any(|t| t == "flagged" || t == "starred");

                let tags: HashSet<String> = item.tags.into_iter().collect();

                Email {
                    id,
                    thread_id: item.thread,
                    sender_name: item.authors,
                    sender_email: String::new(),
                    subject: item.subject,
                    body: String::new(),
                    html_body: String::new(),
                    attachments: Vec::new(),
                    date: item.date_relative.clone(),
                    time: item.date_relative,
                    message_id,
                    tags,
                    read,
                    flagged,
                    rendered_html: None,
                }
            })
            .collect();

        Ok(emails)
    }

    pub async fn search_threads(
        &self,
        query: &str,
        limit: usize,
    ) -> std::io::Result<Vec<Thread>> {
        let limit_arg = format!("--limit={}", limit);
        let args = vec!["search", "--format=json", &limit_arg, query];
        let output = self.run_command(&args).await?;

        let items: Vec<NotmuchSearchItem> = serde_json::from_str(&output).map_err(|e| {
            std::io::Error::other(format!("Thread search JSON parse error: {}", e))
        })?;

        let threads = items
            .into_iter()
            .map(|item| {
                let tags: HashSet<String> = item.tags.into_iter().collect();
                // Notmuch format gives total matched out of all messages
                Thread::new(
                    item.thread,
                    item.subject,
                    item.authors,
                    item.date_relative,
                    tags,
                    item.total.unwrap_or(item.matched),
                    item.matched,
                )
            })
            .collect();

        Ok(threads)
    }

    pub async fn get_email_content(
        &self,
        message_id: &str,
    ) -> (String, String, Vec<crate::models::Attachment>) {
        let query = if message_id.starts_with("id:") {
            message_id.to_string()
        } else {
            format!("id:{}", message_id)
        };
        let args = vec!["show", "--format=json", "--part=0", &query];
        let output = match self.run_command(&args).await {
            Ok(out) => out,
            Err(e) => {
                tracing::error!("notmuch show failed for {}: {}", message_id, e);
                return (String::new(), String::new(), Vec::new());
            }
        };

        let v: serde_json::Value = match serde_json::from_str(&output) {
            Ok(v) => v,
            Err(e) => {
                tracing::error!("JSON parse error for {}: {}", message_id, e);
                return (String::new(), String::new(), Vec::new());
            }
        };

        let mut plain = String::new();
        let mut html = String::new();
        let mut attachments = Vec::new();

        extract_all_parts(&v, &mut plain, &mut html, &mut attachments);

        (plain, html, attachments)
    }

    pub async fn get_body(&self, message_id: &str) -> String {
        let (plain, _, _) = self.get_email_content(message_id).await;
        plain
    }

    pub async fn tag(
        &self,
        message_id: &str,
        add: &[&str],
        remove: &[&str],
    ) -> std::io::Result<()> {
        let mut args = vec!["tag".to_string()];
        for t in add {
            args.push(format!("+{}", t));
        }
        for t in remove {
            args.push(format!("-{}", t));
        }

        let query = if message_id.starts_with("id:") {
            message_id.to_string()
        } else {
            format!("id:{}", message_id)
        };
        args.push(query);

        self.run_command(&args).await?;
        Ok(())
    }
}

fn extract_all_parts(
    value: &serde_json::Value,
    plain: &mut String,
    html: &mut String,
    attachments: &mut Vec<crate::models::Attachment>,
) {
    if let Some(content_type) = value.get("content-type").and_then(|v| v.as_str()) {
        if content_type == "text/plain" {
            if let Some(content) = value.get("content").and_then(|v| v.as_str()) {
                if plain.is_empty() {
                    *plain = content.to_string();
                }
            }
        } else if content_type == "text/html" {
            if let Some(content) = value.get("content").and_then(|v| v.as_str()) {
                if html.is_empty() {
                    *html = content.to_string();
                }
            }
        } else if value.get("content-disposition").and_then(|v| v.as_str())
            == Some("attachment")
            || content_type.starts_with("image/")
        {
            let filename = value
                .get("filename")
                .and_then(|v| v.as_str())
                .unwrap_or("unnamed")
                .to_string();

            if let Some(content) = value.get("content").and_then(|v| v.as_str()) {
                attachments.push(crate::models::Attachment {
                    filename,
                    content_type: content_type.to_string(),
                    data: content.as_bytes().to_vec(),
                });
            }
        }
    }

    if let Some(arr) = value.as_array() {
        for v in arr {
            extract_all_parts(v, plain, html, attachments);
        }
    }

    if let Some(obj) = value.as_object() {
        if let Some(body) = obj.get("body") {
            extract_all_parts(body, plain, html, attachments);
        }
        if let Some(content) = obj.get("content") {
            extract_all_parts(content, plain, html, attachments);
        }

        for (k, v) in obj {
            if (v.is_array() || v.is_object())
                && k.parse::<i32>().is_ok()
                && k != "body"
                && k != "content"
            {
                extract_all_parts(v, plain, html, attachments);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_plain_text() {
        let json = serde_json::json!([{
            "content-type": "text/plain",
            "content": "Hello world"
        }]);
        let mut plain = String::new();
        let mut html = String::new();
        let mut attachments = Vec::new();
        extract_all_parts(&json, &mut plain, &mut html, &mut attachments);
        assert_eq!(plain, "Hello world");
        assert!(html.is_empty());
    }

    #[test]
    fn test_extract_html_text() {
        let json = serde_json::json!([{
            "content-type": "text/html",
            "content": "<p>Hello</p>"
        }]);
        let mut plain = String::new();
        let mut html = String::new();
        let mut attachments = Vec::new();
        extract_all_parts(&json, &mut plain, &mut html, &mut attachments);
        assert!(plain.is_empty());
        assert_eq!(html, "<p>Hello</p>");
    }

    #[test]
    fn test_extract_nested_parts() {
        let json = serde_json::json!([{
            "body": [
                {"content-type": "text/plain", "content": "Plain body"},
                {"content-type": "text/html", "content": "<b>HTML body</b>"}
            ]
        }]);
        let mut plain = String::new();
        let mut html = String::new();
        let mut attachments = Vec::new();
        extract_all_parts(&json, &mut plain, &mut html, &mut attachments);
        assert_eq!(plain, "Plain body");
        assert_eq!(html, "<b>HTML body</b>");
    }

    #[test]
    fn test_extract_attachment() {
        let json = serde_json::json!([{
            "content-type": "image/png",
            "content-disposition": "attachment",
            "filename": "test.png",
            "content": "fake-data"
        }]);
        let mut plain = String::new();
        let mut html = String::new();
        let mut attachments = Vec::new();
        extract_all_parts(&json, &mut plain, &mut html, &mut attachments);
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].filename, "test.png");
        assert_eq!(attachments[0].content_type, "image/png");
    }

    #[test]
    fn test_malformed_json_skipped() {
        let json = serde_json::json!([{"garbage": true}]);
        let mut plain = String::new();
        let mut html = String::new();
        let mut attachments = Vec::new();
        extract_all_parts(&json, &mut plain, &mut html, &mut attachments);
        assert!(plain.is_empty());
        assert!(html.is_empty());
        assert!(attachments.is_empty());
    }

    #[test]
    fn test_empty_input() {
        let json = serde_json::json!([]);
        let mut plain = String::new();
        let mut html = String::new();
        let mut attachments = Vec::new();
        extract_all_parts(&json, &mut plain, &mut html, &mut attachments);
        assert!(plain.is_empty());
    }
    #[test]
    fn test_parse_real_notmuch_summary_json() {
        // Ground truth JSON from notmuch search --format=json "*"
        let json_str = r#"[{"thread": "0000000000000003", "timestamp": 1775052000, "date_relative": "Wed. 19:30", "matched": 1, "total": 1, "authors": "david@example.com", "subject": "Standalone email", "query": ["id:msg5@example.com", null], "tags": ["inbox", "unread"]},
{"thread": "0000000000000002", "timestamp": 1775048400, "date_relative": "Wed. 18:30", "matched": 2, "total": 2, "authors": "bob@example.com, charlie@example.com", "subject": "Completely different topic", "query": ["id:msg3@example.com id:msg4@example.com", null], "tags": ["inbox", "unread"]},
{"thread": "0000000000000001", "timestamp": 1775041200, "date_relative": "Wed. 16:30", "matched": 2, "total": 2, "authors": "alice@example.com, test@example.com", "subject": "Thread 1 - Message 1", "query": ["id:msg1@example.com id:msg2@example.com", null], "tags": ["inbox", "unread"]}]"#;
        
        let items: Result<Vec<NotmuchSearchItem>, _> = serde_json::from_str(json_str);
        assert!(items.is_ok(), "Failed to parse ground truth JSON");
        
        let items = items.unwrap();
        assert_eq!(items.len(), 3);
        
        let first = &items[0];
        assert_eq!(first.thread, "0000000000000003");
        assert_eq!(first.subject, "Standalone email");
        assert_eq!(first.matched, 1);
        assert_eq!(first.total, Some(1));
        assert!(first.tags.contains(&"inbox".to_string()));
    }
}
