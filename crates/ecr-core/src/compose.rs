use crate::message::{Address, Message};
use serde::{Deserialize, Serialize};

/// A file travelling with a draft, base64 in the same request that sends it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Attachment {
    pub filename: String,
    pub content_type: String,
    pub data_b64: String,
}

/// What every mail provider in practice refuses beyond, before encoding.
pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

impl Attachment {
    /// Decoded size, from the encoded length: base64 is 4 characters per 3
    /// bytes, so this needs no decoding to check a total against the cap.
    pub fn approximate_bytes(&self) -> usize {
        let padding = self
            .data_b64
            .bytes()
            .rev()
            .take_while(|b| *b == b'=')
            .count();
        self.data_b64.len() / 4 * 3 - padding.min(2)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Draft {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
    pub in_reply_to: Option<String>,
    pub references: Vec<String>,
    pub attachments: Vec<Attachment>,
}

impl Draft {
    pub fn is_sendable(&self) -> Result<(), &'static str> {
        if self.to.is_empty() && self.cc.is_empty() && self.bcc.is_empty() {
            return Err("a message needs at least one recipient");
        }
        if self
            .to
            .iter()
            .chain(&self.cc)
            .chain(&self.bcc)
            .any(|r| r.trim().is_empty() || r.contains('\n') || r.contains('\r'))
        {
            return Err("a recipient address cannot be empty or contain a line break");
        }
        if self.subject.contains('\n') || self.subject.contains('\r') {
            return Err("a subject cannot contain a line break");
        }

        let mut total = 0;
        for attachment in &self.attachments {
            if attachment.filename.trim().is_empty() {
                return Err("an attachment needs a filename");
            }
            // The filename and content type both reach MIME headers.
            if attachment.filename.contains(['\n', '\r'])
                || attachment.content_type.contains(['\n', '\r'])
            {
                return Err("an attachment name cannot contain a line break");
            }
            total += attachment.approximate_bytes();
        }
        if total > MAX_ATTACHMENT_BYTES {
            return Err("attachments exceed the 25MB limit");
        }

        Ok(())
    }

    pub fn reply(message: &Message, self_addresses: &[String], reply_all: bool) -> Self {
        let reply_to = if message.reply_to.is_empty() {
            &message.from
        } else {
            &message.reply_to
        };

        let mut to: Vec<String> = reply_to.iter().map(|a| a.email.clone()).collect();
        let mut cc = Vec::new();

        if reply_all {
            for address in message.to.iter().chain(message.cc.iter()) {
                if !is_self(&address.email, self_addresses) && !to.contains(&address.email) {
                    cc.push(address.email.clone());
                }
            }
        }
        to.retain(|a| !a.trim().is_empty());

        let mut references = message.references.clone();
        references.push(message.id.0.clone());

        Self {
            to,
            cc,
            bcc: Vec::new(),
            subject: prefix_subject(&message.subject, "Re:"),
            body: quote(message),
            in_reply_to: Some(message.id.0.clone()),
            references,
            attachments: Vec::new(),
        }
    }

    pub fn forward(message: &Message) -> Self {
        Self {
            to: Vec::new(),
            cc: Vec::new(),
            bcc: Vec::new(),
            subject: prefix_subject(&message.subject, "Fwd:"),
            body: forwarded(message),
            in_reply_to: None,
            references: Vec::new(),
            attachments: Vec::new(),
        }
    }
}

fn is_self(email: &str, self_addresses: &[String]) -> bool {
    self_addresses.iter().any(|s| s.eq_ignore_ascii_case(email))
}

fn prefix_subject(subject: &str, prefix: &str) -> String {
    let trimmed = subject.trim();
    if trimmed
        .to_ascii_lowercase()
        .starts_with(&prefix.to_ascii_lowercase())
    {
        trimmed.to_string()
    } else {
        format!("{prefix} {trimmed}")
    }
}

fn quote(message: &Message) -> String {
    let attribution = match message.from.first() {
        Some(from) => format!("On {}, {} wrote:", message.date, from),
        None => "Previously:".to_string(),
    };
    format!("\n\n{attribution}\n")
}

fn forwarded(message: &Message) -> String {
    let mut out = String::from("\n\n---------- Forwarded message ----------\n");
    out.push_str(&format!("From: {}\n", join(&message.from)));
    out.push_str(&format!("Date: {}\n", message.date));
    out.push_str(&format!("Subject: {}\n", message.subject));
    out.push_str(&format!("To: {}\n\n", join(&message.to)));
    out
}

fn join(addresses: &[Address]) -> String {
    addresses
        .iter()
        .map(|a| a.to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{MessageId, ThreadId};
    use std::collections::BTreeSet;

    fn message() -> Message {
        Message {
            id: MessageId::from("original@example.com"),
            thread_id: ThreadId::from("t1"),
            subject: "Project update".to_string(),
            from: vec![Address::new(Some("Alice".into()), "alice@example.com")],
            to: vec![
                Address::new(None, "me@example.com"),
                Address::new(None, "bob@example.com"),
            ],
            cc: vec![Address::new(None, "carol@example.com")],
            bcc: Vec::new(),
            reply_to: Vec::new(),
            date: "Wed, 01 Apr 2026 10:00:00 +0000".to_string(),
            timestamp: 0,
            tags: BTreeSet::new(),
            in_reply_to: None,
            references: vec!["older@example.com".to_string()],
            parts: Vec::new(),
            excluded: false,
        }
    }

    fn attachment(name: &str, bytes: usize) -> Attachment {
        Attachment {
            filename: name.to_string(),
            content_type: "application/octet-stream".to_string(),
            data_b64: "A".repeat(bytes.div_ceil(3) * 4),
        }
    }

    fn sendable(attachments: Vec<Attachment>) -> Draft {
        Draft {
            to: vec!["someone@example.com".to_string()],
            attachments,
            ..Default::default()
        }
    }

    #[test]
    fn an_attachment_without_a_filename_is_refused() {
        let draft = sendable(vec![attachment("  ", 10)]);
        assert!(draft.is_sendable().is_err());
    }

    #[test]
    fn a_filename_with_a_line_break_is_refused() {
        let draft = sendable(vec![attachment("a\r\nBcc: victim@example.com", 10)]);
        assert!(draft.is_sendable().is_err());
    }

    #[test]
    fn attachments_over_the_cap_are_refused() {
        let draft = sendable(vec![attachment("big.bin", MAX_ATTACHMENT_BYTES + 1024)]);
        assert_eq!(
            draft.is_sendable(),
            Err("attachments exceed the 25MB limit")
        );
    }

    #[test]
    fn attachments_under_the_cap_are_allowed() {
        let draft = sendable(vec![attachment("small.bin", 1024)]);
        assert!(draft.is_sendable().is_ok());
    }

    #[test]
    fn the_cap_is_on_the_total_rather_than_each_file() {
        let half = MAX_ATTACHMENT_BYTES / 2 + 1024;
        let draft = sendable(vec![attachment("a.bin", half), attachment("b.bin", half)]);
        assert!(draft.is_sendable().is_err());
    }

    #[test]
    fn the_decoded_size_is_read_from_the_encoded_length() {
        let payload = Attachment {
            filename: "x".to_string(),
            content_type: "text/plain".to_string(),
            // 6 bytes encode to 8 characters with no padding.
            data_b64: "AAAAAAAA".to_string(),
        };
        assert_eq!(payload.approximate_bytes(), 6);
    }

    #[test]
    fn a_reply_goes_to_the_sender_only() {
        let draft = Draft::reply(&message(), &["me@example.com".to_string()], false);

        assert_eq!(draft.to, vec!["alice@example.com"]);
        assert!(draft.cc.is_empty());
    }

    #[test]
    fn a_reply_all_ccs_the_others_but_never_yourself() {
        let draft = Draft::reply(&message(), &["me@example.com".to_string()], true);

        assert_eq!(draft.to, vec!["alice@example.com"]);
        assert!(draft.cc.contains(&"bob@example.com".to_string()));
        assert!(draft.cc.contains(&"carol@example.com".to_string()));
        assert!(!draft.cc.contains(&"me@example.com".to_string()));
    }

    #[test]
    fn a_reply_honours_the_reply_to_header() {
        let mut message = message();
        message.reply_to = vec![Address::new(None, "list@example.com")];

        let draft = Draft::reply(&message, &[], false);
        assert_eq!(draft.to, vec!["list@example.com"]);
    }

    #[test]
    fn a_reply_threads_correctly() {
        let draft = Draft::reply(&message(), &[], false);

        assert_eq!(draft.in_reply_to.as_deref(), Some("original@example.com"));
        assert_eq!(
            draft.references,
            vec!["older@example.com", "original@example.com"]
        );
    }

    #[test]
    fn re_is_not_stacked_on_an_existing_reply_subject() {
        let mut message = message();
        message.subject = "Re: Project update".to_string();

        assert_eq!(
            Draft::reply(&message, &[], false).subject,
            "Re: Project update"
        );
    }

    #[test]
    fn a_forward_has_no_recipients_and_quotes_the_headers() {
        let draft = Draft::forward(&message());

        assert!(draft.to.is_empty());
        assert_eq!(draft.subject, "Fwd: Project update");
        assert!(draft.body.contains("Forwarded message"));
        assert!(draft.body.contains("alice@example.com"));
        assert_eq!(draft.in_reply_to, None);
    }

    #[test]
    fn a_draft_without_recipients_is_not_sendable() {
        let draft = Draft::default();
        assert!(draft.is_sendable().is_err());
    }

    #[test]
    fn a_header_injection_attempt_is_refused() {
        let draft = Draft {
            to: vec!["a@b.c\r\nBcc: victim@example.com".to_string()],
            ..Default::default()
        };
        assert!(draft.is_sendable().is_err());

        let draft = Draft {
            to: vec!["a@b.c".to_string()],
            subject: "hi\r\nBcc: victim@example.com".to_string(),
            ..Default::default()
        };
        assert!(draft.is_sendable().is_err());
    }

    #[test]
    fn a_plain_draft_is_sendable() {
        let draft = Draft {
            to: vec!["a@b.c".to_string()],
            subject: "Hello".to_string(),
            body: "Hi there".to_string(),
            ..Default::default()
        };
        assert!(draft.is_sendable().is_ok());
    }
}
