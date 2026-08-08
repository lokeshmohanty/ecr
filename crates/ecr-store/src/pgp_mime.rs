//! Wrapping an outgoing message in PGP/MIME (RFC 3156).
//!
//! Reading protected mail is `pgp.rs`. This is the other direction, and the
//! hard part of it is not the cryptography — gpg does that — but **which
//! headers go where**.
//!
//! A PGP/MIME message is two entities. The outer one carries the addressing:
//! who it is from, who it is to, what it is about, when it was sent. The inner
//! one carries the content, and only the content headers travel with it. Put an
//! addressing header inside and no mail server can route the message; leave a
//! content header outside and every client renders armour as the body.
//!
//! ## What this does not protect
//!
//! **The subject line is sent in the clear, and so is every address.** That is
//! not a shortcut here — it is what PGP/MIME is. An encrypted message announces
//! who is talking to whom and what about; only the body and the attachments are
//! hidden. Anyone who assumes otherwise has been given a much stronger promise
//! than the format makes, which is why it is written here rather than left to
//! be inferred.

use crate::error::{Error, Result};

/// What to do to an outgoing message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protect {
    Sign,
    Encrypt,
    /// Signed *and* encrypted, in that order — the signature goes inside the
    /// encryption, so who wrote it is hidden along with what they wrote.
    /// Signing the ciphertext instead would publish that you wrote something to
    /// this person, which is most of what encrypting it was for.
    SignAndEncrypt,
}

/// Wraps a built message so that its content is signed, encrypted, or both.
///
/// `raw` is an ordinary RFC 5322 message as `compose::build_as` produces it.
/// `key` is what to sign with, and `recipients` who to encrypt to.
pub async fn protect(
    raw: &[u8],
    what: Protect,
    key: Option<&str>,
    recipients: &[String],
) -> Result<Vec<u8>> {
    let (outer, inner) = split_headers(raw)?;

    match what {
        Protect::Sign => {
            let key = key.ok_or_else(|| Error::Managed("no key to sign with".into()))?;
            sign(&outer, &inner, key).await
        }
        Protect::Encrypt => encrypt(&outer, &inner, recipients, None).await,
        Protect::SignAndEncrypt => {
            let key = key.ok_or_else(|| Error::Managed("no key to sign with".into()))?;
            encrypt(&outer, &inner, recipients, Some(key)).await
        }
    }
}

async fn sign(outer: &str, inner: &[u8], key: &str) -> Result<Vec<u8>> {
    // Canonical CRLF before signing, per RFC 3156. A message built on this
    // machine may carry bare newlines, and the receiving end verifies whatever
    // its transport delivered — which is CRLF. Signing the other form produces
    // a signature that fails everywhere except here, which is the worst place
    // for it to fail, because here it passes.
    let inner = crlf(inner);
    let signed = crate::pgp::sign_detached(&inner, key).await?;

    let boundary = boundary();
    let mut out = String::new();
    out.push_str(outer);
    out.push_str(&format!(
        "MIME-Version: 1.0\r\n\
         Content-Type: multipart/signed; micalg=\"pgp-{}\";\r\n\
         \tprotocol=\"application/pgp-signature\"; boundary=\"{boundary}\"\r\n\
         \r\n\
         This is an OpenPGP/MIME signed message (RFC 3156).\r\n\
         --{boundary}\r\n",
        signed.micalg
    ));

    let mut bytes = out.into_bytes();
    // Byte-for-byte what was signed. Rebuilding it from anything — even
    // re-encoding the same string — is how a signature that verified on the
    // sending machine fails on every other one.
    bytes.extend_from_slice(&inner);
    bytes.extend_from_slice(
        format!(
            "\r\n--{boundary}\r\n\
             Content-Type: application/pgp-signature; name=\"signature.asc\"\r\n\
             Content-Description: OpenPGP digital signature\r\n\
             Content-Disposition: attachment; filename=\"signature.asc\"\r\n\
             \r\n"
        )
        .as_bytes(),
    );
    bytes.extend_from_slice(&signed.armour);
    bytes.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    Ok(bytes)
}

async fn encrypt(
    outer: &str,
    inner: &[u8],
    recipients: &[String],
    sign_with: Option<&str>,
) -> Result<Vec<u8>> {
    if recipients.is_empty() {
        return Err(Error::Managed(
            "nobody to encrypt to. Every recipient needs a public key in your keyring; \
             encrypting to only some of them and sending anyway delivers a message the \
             others cannot open, and looks to you exactly like it worked"
                .into(),
        ));
    }

    let armour = crate::pgp::encrypt(&crlf(inner), recipients, sign_with).await?;

    let boundary = boundary();
    let mut out = String::new();
    out.push_str(outer);
    out.push_str(&format!(
        "MIME-Version: 1.0\r\n\
         Content-Type: multipart/encrypted;\r\n\
         \tprotocol=\"application/pgp-encrypted\"; boundary=\"{boundary}\"\r\n\
         \r\n\
         This is an OpenPGP/MIME encrypted message (RFC 3156).\r\n\
         --{boundary}\r\n\
         Content-Type: application/pgp-encrypted\r\n\
         Content-Description: PGP/MIME version identification\r\n\
         \r\n\
         Version: 1\r\n\
         --{boundary}\r\n\
         Content-Type: application/octet-stream; name=\"encrypted.asc\"\r\n\
         Content-Description: OpenPGP encrypted message\r\n\
         Content-Disposition: inline; filename=\"encrypted.asc\"\r\n\
         \r\n"
    ));

    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(&armour);
    bytes.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    Ok(bytes)
}

/// Splits a built message into the headers that stay outside and the entity
/// that gets protected.
///
/// The rule is the whole of this module. Addressing goes out, content goes in.
/// An addressing header left inside is a message no server can route; a content
/// header left outside is armour rendered as the body by every client.
fn split_headers(raw: &[u8]) -> Result<(String, Vec<u8>)> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| Error::Managed("that message is not valid UTF-8".into()))?;

    let split = text
        .find("\r\n\r\n")
        .map(|i| (i, i + 4))
        .or_else(|| text.find("\n\n").map(|i| (i, i + 2)))
        .ok_or_else(|| Error::Managed("that message has no body".into()))?;

    let (head, body) = (&text[..split.0], &text[split.1..]);

    let mut outer = String::new();
    let mut inner = String::new();
    let mut keeping: Option<bool> = None;

    for line in head.lines() {
        // A folded continuation belongs to whichever header it continues.
        if line.starts_with([' ', '\t']) {
            match keeping {
                Some(true) => {
                    outer.push_str(line);
                    outer.push_str("\r\n");
                }
                Some(false) => {
                    inner.push_str(line);
                    inner.push_str("\r\n");
                }
                None => {}
            }
            continue;
        }

        let name = line
            .split(':')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        // `MIME-Version` is dropped from both: the outer entity gets a fresh
        // one that describes the multipart, and a second copy inside is a
        // header that describes an entity it is no longer at the top of.
        if name == "mime-version" {
            keeping = None;
            continue;
        }

        let inside = name.starts_with("content-");
        keeping = Some(!inside);

        let target = if inside { &mut inner } else { &mut outer };
        target.push_str(line);
        target.push_str("\r\n");
    }

    let mut entity = inner.into_bytes();
    entity.extend_from_slice(b"\r\n");
    entity.extend_from_slice(crlf(body.as_bytes()).as_slice());

    Ok((outer, entity))
}

/// Canonical CRLF, without doubling one that is already there.
fn crlf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + bytes.len() / 16);
    let mut previous = 0u8;
    for &byte in bytes {
        if byte == b'\n' && previous != b'\r' {
            out.push(b'\r');
        }
        out.push(byte);
        previous = byte;
    }
    out
}

/// A boundary that cannot occur in armour.
///
/// Armour is base64 plus `-----BEGIN`/`-----END` lines, so a boundary carrying
/// a character base64 never uses cannot collide with the content no matter what
/// is in it — which means this never has to scan the body, and can be chosen
/// before the body exists.
fn boundary() -> String {
    use rand::RngExt;
    let mut rng = rand::rng();
    let tail: String = (0..16)
        .map(|_| char::from(b'a' + rng.random_range(0..26)))
        .collect();
    format!("=_ecr_{tail}_=")
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = "From: ada@example.com\r\n\
To: grace@example.org\r\n\
Subject: lunch?\r\n\
Message-ID: <1@example.com>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
Content-Transfer-Encoding: 8bit\r\n\
\r\n\
hello, world\r\n";

    /// The whole of this module. An addressing header left inside is a message
    /// no server can route; a content header left outside is armour rendered as
    /// the body by every client.
    #[test]
    fn addressing_goes_outside_and_content_goes_inside() {
        let (outer, inner) = split_headers(RAW.as_bytes()).unwrap();
        let inner = String::from_utf8(inner).unwrap();

        for header in ["From:", "To:", "Subject:", "Message-ID:"] {
            assert!(outer.contains(header), "{header} was not kept outside");
            assert!(!inner.contains(header), "{header} was buried inside");
        }
        for header in ["Content-Type:", "Content-Transfer-Encoding:"] {
            assert!(inner.contains(header), "{header} was not moved inside");
            assert!(!outer.contains(header), "{header} was left outside");
        }
    }

    /// The outer entity gets a fresh one describing the multipart. A second
    /// copy inside describes an entity it is no longer at the top of.
    #[test]
    fn mime_version_is_not_carried_into_either_half() {
        let (outer, inner) = split_headers(RAW.as_bytes()).unwrap();

        assert!(!outer.contains("MIME-Version"));
        assert!(!String::from_utf8(inner).unwrap().contains("MIME-Version"));
    }

    #[test]
    fn the_body_survives_the_split() {
        let (_, inner) = split_headers(RAW.as_bytes()).unwrap();
        assert!(String::from_utf8(inner)
            .unwrap()
            .ends_with("hello, world\r\n"));
    }

    /// A folded header must not be torn in half — the continuation carries the
    /// rest of a value, and delivering it as its own header line is a message
    /// with a garbage header and a truncated one.
    #[test]
    fn a_folded_header_stays_with_the_header_it_continues() {
        let raw = "From: ada@example.com\r\n\
                   Subject: a very long\r\n\tsubject line\r\n\
                   Content-Type: multipart/mixed;\r\n\tboundary=\"x\"\r\n\
                   \r\n\
                   body\r\n";

        let (outer, inner) = split_headers(raw.as_bytes()).unwrap();
        let inner = String::from_utf8(inner).unwrap();

        assert!(outer.contains("subject line"), "{outer}");
        assert!(!inner.contains("subject line"), "{inner}");
        assert!(inner.contains("boundary=\"x\""), "{inner}");
        assert!(!outer.contains("boundary=\"x\""), "{outer}");
    }

    /// A signature is verified against whatever the transport delivered, which
    /// is CRLF. Signing bare newlines produces a signature that fails
    /// everywhere except the machine that made it — the worst place for it to
    /// fail, because there it passes.
    #[test]
    fn line_endings_are_canonical_and_not_doubled() {
        assert_eq!(crlf(b"a\nb\n"), b"a\r\nb\r\n");
        assert_eq!(crlf(b"a\r\nb\r\n"), b"a\r\nb\r\n");
        assert_eq!(crlf(b"a\r\n\nb"), b"a\r\n\r\nb");
    }

    /// Armour is base64 and two dashed lines, so a boundary carrying a
    /// character base64 never uses cannot collide with it whatever the content
    /// turns out to be.
    #[test]
    fn the_boundary_cannot_occur_inside_armour() {
        for _ in 0..32 {
            let boundary = boundary();
            assert!(boundary.contains('='), "{boundary}");
            assert!(boundary.starts_with("=_ecr_"), "{boundary}");
            assert_ne!(boundary, super::boundary(), "boundaries repeat");
        }
    }

    #[test]
    fn a_message_with_no_body_is_refused_rather_than_guessed() {
        assert!(split_headers(b"From: a@b.c\r\n").is_err());
    }
}
