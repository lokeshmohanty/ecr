//! Sending, without msmtp.
//!
//! Unlike sync, this one is worth doing ourselves. Sending is a single stateless
//! operation — connect, TLS, authenticate, `MAIL FROM`, `RCPT TO`, `DATA` — and
//! ecr already builds the whole RFC 5322 message in [`crate::compose`], so msmtp
//! was doing nothing but transport. What a bug here costs is a message that does
//! not leave, with an error on screen; what a bug in sync costs is mail.
//!
//! msmtp is still used for a self-managed account, because that account's
//! configuration is the reader's and ecr does not know what is in it. This runs
//! only for accounts ecr manages, where every one of those settings came from
//! `accounts.toml` in the first place.

use crate::error::{Error, Result};
use crate::oauth::Profiles;
use ecr_core::managed::{Auth, ManagedAccount, Tls};
use mail_send::SmtpClientBuilder;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(60);

/// Sends one message, already built.
///
/// `raw` is the complete message as it will appear on the wire; the envelope is
/// derived from it rather than passed alongside, so there is exactly one answer
/// to who this is from and where it is going.
pub async fn send(profiles: &Profiles, account: &ManagedAccount, raw: &[u8]) -> Result<()> {
    crate::imap::ensure_crypto_provider();

    let endpoint = account
        .smtp()
        .ok_or_else(|| Error::Managed("this account names no SMTP server".into()))?;

    let recipients = recipients(raw)?;
    if recipients.is_empty() {
        return Err(Error::InvalidDraft {
            reason: "it names nobody to send to".into(),
        });
    }

    let mut builder = SmtpClientBuilder::new(endpoint.host.clone(), endpoint.port)
        .map_err(Error::Managed)?
        .timeout(TIMEOUT)
        // `implicit_tls(false)` is STARTTLS, which is what 587 wants; true is
        // SMTPS on 465. Getting this backwards does not fail cleanly — a
        // STARTTLS handshake against an implicit-TLS port hangs until the
        // timeout — so it is derived from the account rather than guessed.
        .implicit_tls(endpoint.tls == Tls::Implicit);

    if endpoint.tls == Tls::None {
        // Only ever a deliberate choice for a relay on the same machine, and
        // `allow_invalid_certs` is not the same thing as no TLS at all.
        builder = builder.allow_invalid_certs();
    }

    let credential = match &account.auth {
        Auth::Oauth { profile } => {
            let token = crate::oauth::access_token(profiles, profile).await?;
            mail_send::Credentials::new_xoauth2(account.address.clone(), token)
        }
        Auth::Command { command } => {
            let password = run_password_command(command).await?;
            mail_send::Credentials::new(account.address.clone(), password)
        }
    };

    let mut client = builder
        .credentials(credential)
        .connect()
        .await
        .map_err(|err| Error::ToolFailed {
            tool: "smtp",
            stderr: describe(err, account),
        })?;

    // The body goes out as the bytes ecr composed, not rebuilt from a parse.
    // Re-serialising here would be a second chance to change what the reader
    // saw before they pressed send.
    let message = mail_send::smtp::message::Message::new(
        account.address.clone(),
        recipients,
        std::borrow::Cow::Borrowed(raw),
    );

    client
        .send(message)
        .await
        .map_err(|err| Error::ToolFailed {
            tool: "smtp",
            stderr: describe(err, account),
        })?;

    Ok(())
}

/// Connects and authenticates, and sends nothing.
///
/// The session is opened exactly as [`send`] opens it and then dropped, so what
/// it proves is what a send would need: the host, the port, the TLS mode and the
/// credential. Anything after that is the message, and a message is not
/// something to test with.
pub async fn probe(profiles: &Profiles, account: &ManagedAccount) -> crate::imap::Probe {
    crate::imap::ensure_crypto_provider();
    let mut probe = crate::imap::Probe::default();

    let Some(endpoint) = account.smtp() else {
        return probe.failed("this account names no SMTP server");
    };

    let credential = match &account.auth {
        Auth::Oauth { profile } => match crate::oauth::access_token(profiles, profile).await {
            Ok(token) => mail_send::Credentials::new_xoauth2(account.address.clone(), token),
            Err(err) => return probe.failed(err),
        },
        Auth::Command { command } => match run_password_command(command).await {
            Ok(password) => mail_send::Credentials::new(account.address.clone(), password),
            Err(err) => return probe.failed(err),
        },
    };

    let builder = match SmtpClientBuilder::new(endpoint.host.clone(), endpoint.port) {
        Ok(builder) => builder
            .timeout(TIMEOUT)
            .implicit_tls(endpoint.tls == Tls::Implicit)
            .credentials(credential),
        Err(err) => return probe.failed(err),
    };

    // `connect` does the lot — TCP, TLS, EHLO and AUTH — so the three flags
    // cannot be filled in separately here the way the IMAP probe fills them.
    // Reaching the end means all three.
    match builder.connect().await {
        Ok(_) => {
            probe.reached = true;
            probe.tls = endpoint.tls != Tls::None;
            probe.authenticated = true;
            probe
        }
        Err(err) => probe.failed(describe(err, account)),
    }
}

/// An OAuth failure is the likely one, and it has a fix worth naming.
fn describe(err: mail_send::Error, account: &ManagedAccount) -> String {
    match &account.auth {
        Auth::Oauth { profile } => {
            format!("{err}. {}", crate::oauth::authorize_hint(profile))
        }
        Auth::Command { .. } => err.to_string(),
    }
}

async fn run_password_command(command: &[String]) -> Result<String> {
    let (program, args) = command
        .split_first()
        .ok_or_else(|| Error::Managed("the password command is empty".into()))?;

    let output = tokio::process::Command::new(program)
        .args(args)
        .output()
        .await
        .map_err(|err| Error::Managed(format!("the password command could not be run: {err}")))?;

    if !output.status.success() {
        return Err(Error::Managed(format!(
            "the password command exited with {}",
            output.status
        )));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.lines().next().unwrap_or_default().to_string())
}

/// Every address the envelope has to carry, from the headers of the message.
///
/// `Bcc` is included and the header itself is expected to have been stripped by
/// the composer before this is called — a Bcc that reaches the wire is the one
/// mail bug that cannot be taken back.
pub fn recipients(raw: &[u8]) -> Result<Vec<String>> {
    use mail_parser::MessageParser;

    let message = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| Error::InvalidDraft {
            reason: "it could not be parsed".into(),
        })?;

    let mut out: Vec<String> = Vec::new();
    for header in ["To", "Cc", "Bcc"] {
        let Some(value) = message.header(header) else {
            continue;
        };
        collect(value, &mut out);
    }

    out.sort();
    out.dedup();
    Ok(out)
}

fn collect(value: &mail_parser::HeaderValue, out: &mut Vec<String>) {
    match value {
        mail_parser::HeaderValue::Address(address) => {
            for one in address.iter() {
                if let Some(email) = &one.address {
                    out.push(email.to_string());
                }
            }
        }
        mail_parser::HeaderValue::Text(text) => out.push(text.to_string()),
        mail_parser::HeaderValue::TextList(list) => out.extend(list.iter().map(|t| t.to_string())),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESSAGE: &[u8] = b"From: alice@example.com\r\n\
To: bob@example.com, carol@example.com\r\n\
Cc: dave@example.com\r\n\
Subject: hello\r\n\
\r\n\
body\r\n";

    #[test]
    fn every_recipient_header_lands_in_the_envelope() {
        let found = recipients(MESSAGE).unwrap();
        assert_eq!(
            found,
            vec!["bob@example.com", "carol@example.com", "dave@example.com"]
        );
    }

    /// The same address twice is one delivery, not two. Servers vary on whether
    /// they collapse duplicates, and a message arriving twice reads as a bug in
    /// the client that sent it.
    #[test]
    fn a_repeated_address_is_sent_to_once() {
        let raw = b"To: bob@example.com\r\nCc: bob@example.com\r\n\r\nbody\r\n";
        assert_eq!(recipients(raw).unwrap(), vec!["bob@example.com"]);
    }

    #[test]
    fn a_message_with_nobody_to_send_to_is_refused_before_connecting() {
        let raw = b"From: alice@example.com\r\nSubject: to nobody\r\n\r\nbody\r\n";
        assert!(recipients(raw).unwrap().is_empty());
    }

    /// Bcc is a delivery, and the header is the composer's to remove. If this
    /// stopped reading it, blind recipients would silently stop receiving mail.
    #[test]
    fn bcc_is_a_recipient() {
        let raw = b"To: bob@example.com\r\nBcc: secret@example.com\r\n\r\nbody\r\n";
        let found = recipients(raw).unwrap();
        assert!(
            found.contains(&"secret@example.com".to_string()),
            "{found:?}"
        );
    }
}
