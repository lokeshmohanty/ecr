use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

use crate::error::{Error, Result};
use ecr_core::account::Account;
use ecr_core::compose::Draft;
use mail_builder::MessageBuilder;

pub fn build(account: &Account, draft: &Draft) -> Result<Vec<u8>> {
    build_as(account, draft, &[])
}

/// The same, with the addresses this account is allowed to send as.
///
/// A draft naming a `from` that is not one of them is refused rather than
/// quietly sent as the account's own: a message going out as an address the
/// reader did not choose is worse than one that does not go out at all, and
/// silently rewriting the sender is how a Bcc-shaped mistake happens.
pub fn build_as(account: &Account, draft: &Draft, identities: &[String]) -> Result<Vec<u8>> {
    draft.is_sendable().map_err(|reason| Error::InvalidDraft {
        reason: reason.to_string(),
    })?;

    let own = account.address.clone().ok_or_else(|| Error::InvalidDraft {
        reason: format!("account {} has no address to send from", account.id),
    })?;

    let from = match &draft.from {
        None => own,
        Some(chosen) if chosen.eq_ignore_ascii_case(&own) => own,
        Some(chosen)
            if identities
                .iter()
                .any(|known| known.eq_ignore_ascii_case(chosen)) =>
        {
            chosen.clone()
        }
        Some(chosen) => {
            return Err(Error::InvalidDraft {
                reason: format!(
                    "{chosen:?} is not an address account {} can send as",
                    account.id
                ),
            })
        }
    };

    let mut builder = MessageBuilder::new()
        .from(from.as_str())
        .subject(draft.subject.as_str())
        .text_body(draft.body.as_str());

    if !draft.to.is_empty() {
        builder = builder.to(addresses(&draft.to));
    }
    if !draft.cc.is_empty() {
        builder = builder.cc(addresses(&draft.cc));
    }
    if !draft.bcc.is_empty() {
        builder = builder.bcc(addresses(&draft.bcc));
    }
    if let Some(in_reply_to) = &draft.in_reply_to {
        builder = builder.in_reply_to(in_reply_to.as_str());
    }
    if !draft.references.is_empty() {
        builder = builder.references(references(&draft.references));
    }

    for attachment in &draft.attachments {
        let bytes = STANDARD
            .decode(attachment.data_b64.as_bytes())
            .map_err(|e| Error::InvalidDraft {
                reason: format!("attachment {}: {e}", attachment.filename),
            })?;

        let content_type = if attachment.content_type.trim().is_empty() {
            "application/octet-stream"
        } else {
            attachment.content_type.as_str()
        };

        builder = builder.attachment(content_type, attachment.filename.as_str(), bytes);
    }

    builder.write_to_vec().map_err(|e| Error::InvalidDraft {
        reason: e.to_string(),
    })
}

fn addresses(list: &[String]) -> Vec<String> {
    list.iter().map(|a| a.trim().to_string()).collect()
}

fn references(list: &[String]) -> Vec<String> {
    list.iter()
        .map(|r| r.trim().trim_matches(['<', '>']).to_string())
        .filter(|r| !r.is_empty())
        .collect()
}

/// The message that carries an answer to an invitation.
///
/// The calendar goes in as a `text/calendar; method=REPLY` part, which is what
/// an organiser's software looks for — an `.ics` attachment is a file a person
/// opens, and nothing automated reads it. A plain-text part rides alongside so
/// that a client which does not understand calendars still shows a sentence
/// rather than an empty message.
pub fn build_invite_reply(
    account: &Account,
    to: &str,
    subject: &str,
    calendar: &str,
) -> Result<Vec<u8>> {
    let from = account.address.clone().ok_or_else(|| Error::InvalidDraft {
        reason: format!("account {} has no address to send from", account.id),
    })?;

    let raw = MessageBuilder::new()
        .from(from.as_str())
        .to(to)
        .subject(subject)
        .text_body(subject)
        .body(mail_builder::mime::MimePart::new(
            "text/calendar; method=REPLY; charset=utf-8",
            calendar,
        ))
        .write_to_vec()
        .map_err(|err| Error::InvalidDraft {
            reason: err.to_string(),
        })?;

    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ecr_core::account::AccountId;
    use ecr_core::compose::Attachment;

    fn account() -> Account {
        Account {
            id: AccountId::from("main"),
            display_name: "Alice".to_string(),
            maildir_path: "/tmp/Mail/main".into(),
            address: Some("alice@example.com".to_string()),
            mbsync_channel: Some("main".to_string()),
            msmtp_account: Some("main".to_string()),
            folders: Vec::new(),
        }
    }

    fn draft() -> Draft {
        Draft {
            to: vec!["someone@example.com".to_string()],
            subject: "Hello".to_string(),
            body: "Hi there.".to_string(),
            ..Default::default()
        }
    }

    fn built(draft: &Draft) -> String {
        String::from_utf8(build(&account(), draft).unwrap()).unwrap()
    }

    /// A message must never go out as an address the reader did not choose.
    /// Silently rewriting the sender to the account's own is the failure that
    /// tells a recipient which of somebody's addresses is the real one.
    #[test]
    fn a_from_that_is_not_one_of_the_accounts_addresses_is_refused() {
        let draft = Draft {
            from: Some("someone-else@example.net".into()),
            ..draft()
        };

        let err = build_as(&account(), &draft, &["alias@example.com".into()])
            .unwrap_err()
            .to_string();
        assert!(err.contains("someone-else@example.net"), "{err}");
    }

    #[test]
    fn an_alias_the_account_owns_is_what_goes_on_the_from_line() {
        let draft = Draft {
            from: Some("alias@example.com".into()),
            ..draft()
        };

        let raw = build_as(&account(), &draft, &["alias@example.com".into()]).unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        assert!(text.contains("alias@example.com"), "{text}");
    }

    #[test]
    fn a_draft_naming_no_identity_goes_out_as_the_account() {
        let raw = build_as(&account(), &draft(), &[]).unwrap();
        assert!(String::from_utf8_lossy(&raw).contains("alice@example.com"));
    }

    #[test]
    fn builds_a_minimal_rfc5322_message() {
        let raw = built(&draft());

        assert!(raw.contains("From:"), "{raw}");
        assert!(raw.contains("alice@example.com"), "{raw}");
        assert!(raw.contains("To:"), "{raw}");
        assert!(raw.contains("someone@example.com"), "{raw}");
        assert!(raw.contains("Subject: Hello"), "{raw}");
        assert!(raw.contains("Hi there."), "{raw}");
    }

    #[test]
    fn includes_a_message_id_and_date() {
        let raw = built(&draft());
        assert!(raw.contains("Message-ID:"), "{raw}");
        assert!(raw.contains("Date:"), "{raw}");
    }

    #[test]
    fn threading_headers_are_written_when_replying() {
        let draft = Draft {
            in_reply_to: Some("original@example.com".to_string()),
            references: vec![
                "older@example.com".to_string(),
                "original@example.com".to_string(),
            ],
            ..draft()
        };
        let raw = built(&draft);

        assert!(raw.contains("In-Reply-To:"), "{raw}");
        assert!(raw.contains("References:"), "{raw}");
        assert!(raw.contains("older@example.com"), "{raw}");
    }

    #[test]
    fn cc_and_bcc_are_written() {
        let draft = Draft {
            cc: vec!["cc@example.com".to_string()],
            bcc: vec!["bcc@example.com".to_string()],
            ..draft()
        };
        let raw = built(&draft);

        assert!(raw.contains("cc@example.com"), "{raw}");
        assert!(raw.contains("bcc@example.com"), "{raw}");
    }

    #[test]
    fn a_unicode_subject_is_encoded_rather_than_emitted_raw() {
        let draft = Draft {
            subject: "Café ☁".to_string(),
            ..draft()
        };
        let raw = built(&draft);

        assert!(raw.contains("=?utf-8?"), "subject should be encoded: {raw}");
    }

    #[test]
    fn a_draft_with_no_recipients_is_refused() {
        let err = build(&account(), &Draft::default()).unwrap_err();
        assert!(matches!(err, Error::InvalidDraft { .. }), "{err:?}");
    }

    #[test]
    fn an_account_with_no_address_cannot_send() {
        let mut account = account();
        account.address = None;

        let err = build(&account, &draft()).unwrap_err();
        assert!(err.to_string().contains("no address"), "{err}");
    }

    #[test]
    fn an_attachment_becomes_a_mime_part() {
        let draft = Draft {
            attachments: vec![Attachment {
                filename: "notes.txt".to_string(),
                content_type: "text/plain".to_string(),
                data_b64: STANDARD.encode("hello attachment"),
            }],
            ..draft()
        };
        let raw = built(&draft);

        assert!(raw.contains("multipart/mixed"), "{raw}");
        assert!(raw.contains("notes.txt"), "{raw}");
        assert!(raw.contains("attachment"), "{raw}");
        assert!(raw.contains("Hi there."), "the body survives: {raw}");
    }

    #[test]
    fn several_attachments_all_travel() {
        let file = |name: &str| Attachment {
            filename: name.to_string(),
            content_type: "application/pdf".to_string(),
            data_b64: STANDARD.encode("%PDF-1.4"),
        };
        let draft = Draft {
            attachments: vec![file("one.pdf"), file("two.pdf")],
            ..draft()
        };
        let raw = built(&draft);

        assert!(raw.contains("one.pdf"), "{raw}");
        assert!(raw.contains("two.pdf"), "{raw}");
    }

    #[test]
    fn a_message_with_no_attachments_stays_a_plain_body() {
        let raw = built(&draft());
        assert!(!raw.contains("multipart"), "{raw}");
    }

    #[test]
    fn an_empty_content_type_falls_back_rather_than_producing_a_broken_header() {
        let draft = Draft {
            attachments: vec![Attachment {
                filename: "blob.bin".to_string(),
                content_type: String::new(),
                data_b64: STANDARD.encode([0u8, 1, 2, 3]),
            }],
            ..draft()
        };
        assert!(built(&draft).contains("application/octet-stream"));
    }

    #[test]
    fn undecodable_base64_is_refused_rather_than_sent_as_rubbish() {
        let draft = Draft {
            attachments: vec![Attachment {
                filename: "bad.bin".to_string(),
                content_type: "application/octet-stream".to_string(),
                data_b64: "not!valid!base64".to_string(),
            }],
            ..draft()
        };

        let err = build(&account(), &draft).unwrap_err();
        assert!(err.to_string().contains("bad.bin"), "{err}");
    }

    #[test]
    fn a_header_injection_attempt_never_reaches_the_builder() {
        let draft = Draft {
            subject: "hi\r\nBcc: victim@example.com".to_string(),
            ..draft()
        };

        let err = build(&account(), &draft).unwrap_err();
        assert!(matches!(err, Error::InvalidDraft { .. }), "{err:?}");
    }
}
