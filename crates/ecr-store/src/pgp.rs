//! OpenPGP, through the reader's own `gpg`.
//!
//! ecr does not implement OpenPGP and does not keep keys. It shells out to
//! GnuPG, for the same reason it shells out to notmuch and mbsync — and here
//! the reason is stronger than anywhere else in the codebase.
//!
//! A private key is the most consequential thing a mail reader touches. GnuPG
//! already has the keyring, the agent that holds the passphrase, the smartcard
//! drivers and the reader's own web of trust; a second keyring inside
//! `~/.config/ecr` would be a second place the secret key lives, and a
//! reimplemented trust model would have to be right about revocation, expiry
//! and subkeys before anyone could rely on the padlock it draws. A padlock that
//! is wrong is worse than no padlock, because it is *believed*.
//!
//! So: absent gpg is reported by doctor as absent, and a message is shown
//! unverified. That is a state a reader can act on. A homegrown verifier
//! quietly disagreeing with `gpg --verify` is not.
//!
//! ## Reading the result
//!
//! Everything here is read from `--status-fd`, never from gpg's ordinary
//! output. That output is prose written for a person, it is translated, and it
//! has changed between versions; the status lines are the documented machine
//! interface and are the only thing a security decision may be made from.
//! Parsing "Good signature from" out of the human text is how a client ends up
//! showing a green tick for a locale it was never tested in.

use crate::error::{Error, Result};

pub use ecr_core::pgp::Signature;

/// What a message turned out to be carrying.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Protection {
    /// RFC 3156 `multipart/signed`: the signed bytes and the detached
    /// signature.
    Signed {
        /// Exactly as they appear on the wire — see [`signed_bytes`].
        signed: Vec<u8>,
        signature: Vec<u8>,
    },
    /// RFC 3156 `multipart/encrypted`: the PGP/MIME ciphertext.
    Encrypted { ciphertext: Vec<u8> },
    /// The older convention: armour pasted into a `text/plain` body. Still
    /// what a lot of mailing-list traffic and most scripts produce.
    Inline { armoured: Vec<u8> },
}

/// Whether a raw message carries anything OpenPGP.
///
/// Deliberately reads the **raw** bytes rather than a parsed message. A
/// signature covers the bytes that were transmitted — headers, boundary,
/// transfer encoding and all — so anything that has been decoded and
/// re-serialised is no longer the thing that was signed. mail-parser decodes
/// quoted-printable and rewrites line endings, both of which change the digest;
/// a verifier fed its output would report BADSIG for perfectly good mail, and
/// the failure would look like the sender's problem.
pub fn detect(raw: &[u8]) -> Option<Protection> {
    let (content_type, _) = split_headers(raw)?;
    let lowered = content_type.to_ascii_lowercase();

    if lowered.contains("multipart/signed") {
        let boundary = boundary(&content_type)?;
        let parts = split_at_boundary(raw, &boundary);
        // Exactly two: the signed material and the signature. A
        // multipart/signed with any other number is malformed, and guessing
        // which part to verify is how a signature gets attached to bytes it
        // does not cover.
        if parts.len() == 2 {
            return Some(Protection::Signed {
                signed: parts[0].clone(),
                signature: strip_part_headers(&parts[1]),
            });
        }
    }

    if lowered.contains("multipart/encrypted") {
        let boundary = boundary(&content_type)?;
        let parts = split_at_boundary(raw, &boundary);
        // The first part is the `application/pgp-encrypted` version marker,
        // which carries nothing but "Version: 1"; the ciphertext is the second.
        if parts.len() == 2 {
            return Some(Protection::Encrypted {
                ciphertext: strip_part_headers(&parts[1]),
            });
        }
    }

    if let Some(start) = find(raw, b"-----BEGIN PGP MESSAGE-----") {
        return Some(Protection::Inline {
            armoured: raw[start..].to_vec(),
        });
    }
    if find(raw, b"-----BEGIN PGP SIGNED MESSAGE-----").is_some() {
        return Some(Protection::Inline {
            armoured: raw.to_vec(),
        });
    }

    None
}

/// Checks a detached signature over some bytes.
pub async fn verify(signed: &[u8], signature: &[u8]) -> Result<Signature> {
    let dir = tempfile::tempdir()?;
    let data = dir.path().join("data");
    let sig = dir.path().join("data.asc");
    std::fs::write(&data, signed)?;
    std::fs::write(&sig, signature)?;

    let status = run(&["--verify", path(&sig)?, path(&data)?], &[]).await?;
    Ok(read_signature(&status))
}

/// What came out of an armoured blob.
#[derive(Debug, Clone)]
pub struct Opened {
    pub plaintext: Vec<u8>,
    pub signature: Option<Signature>,
    /// Whether it was actually *encrypted*, as opposed to merely signed.
    ///
    /// Not the same question as whether there is a signature, and a client
    /// that draws one padlock for both is wrong about half the mail it draws
    /// it on: encryption says who could read this, a signature says who wrote
    /// it, and a message can carry either without the other.
    pub encrypted: bool,
}

/// Opens an armoured blob: decrypts it, verifies it, or both.
///
/// One call rather than two, because in PGP/MIME the signature is *inside* the
/// encryption — a message is signed and then encrypted, so nothing can be said
/// about who wrote it until after it is opened. Verifying separately afterwards
/// would have to re-parse the plaintext and would miss exactly this case.
///
/// It is also the one entry point for clearsigned text, which is not encrypted
/// at all: gpg opens both with `--decrypt` and reports a signature either way,
/// but only encryption produces `DECRYPTION_OK`. Requiring that line is what
/// used to refuse every clearsigned message on the grounds that it could not be
/// decrypted — of something that was never encrypted.
pub async fn open(armoured: &[u8]) -> Result<Opened> {
    let status = run(&["--decrypt"], armoured).await?;

    let encrypted = status.lines.iter().any(|l| l.starts_with("DECRYPTION_OK"));
    let signed = status
        .lines
        .iter()
        .any(|l| l.starts_with("GOODSIG") || l.starts_with("ERRSIG") || l.starts_with("BADSIG"));

    if !encrypted && !signed {
        // Distinguishing "not for me" from "gpg is broken" is the difference
        // between a reader filing a bug and a reader realising they are looking
        // at someone else's mail.
        if status.lines.iter().any(|l| l.starts_with("NO_SECKEY")) {
            return Err(Error::Managed(
                "this message is encrypted to a key that is not in your keyring".into(),
            ));
        }
        return Err(Error::Managed(format!(
            "gpg could not open this message: {}",
            status.stderr.lines().last().unwrap_or("no reason given")
        )));
    }

    let signature = signed.then(|| read_signature(&status));
    Ok(Opened {
        plaintext: status.stdout,
        signature,
        encrypted,
    })
}

/// A detached signature, and which digest made it.
#[derive(Debug, Clone)]
pub struct Signed {
    pub armour: Vec<u8>,
    /// The `micalg` parameter, without the `pgp-` prefix.
    ///
    /// It has to match the digest gpg actually used, and gpg chooses that from
    /// the key and the recipient's preferences rather than from anything here
    /// — so it is read back from the status line rather than assumed. A
    /// hardcoded `sha256` is right until somebody signs with an Ed25519 key,
    /// which uses SHA-512, and then it is a signature that strict verifiers
    /// reject and lenient ones accept, which is the hardest kind of wrong to
    /// notice.
    pub micalg: String,
}

/// Signs bytes, answering a detached ASCII-armoured signature.
pub async fn sign_detached(body: &[u8], key: &str) -> Result<Signed> {
    let status = run(&["--detach-sign", "--armor", "--local-user", key], body).await?;

    if status.stdout.is_empty() {
        return Err(Error::Managed(format!(
            "gpg signed nothing: {}",
            status.stderr.lines().last().unwrap_or("no reason given")
        )));
    }

    // `SIG_CREATED <type> <pkalgo> <hashalgo> <class> <timestamp> <fpr>`; the
    // hash algorithm is field 2, as an RFC 4880 number.
    let micalg = status
        .lines
        .iter()
        .find_map(|line| line.strip_prefix("SIG_CREATED "))
        .and_then(|rest| rest.split_whitespace().nth(2))
        .and_then(|code| digest_name(code))
        .unwrap_or("sha256")
        .to_string();

    Ok(Signed {
        armour: status.stdout,
        micalg,
    })
}

/// RFC 4880's hash algorithm numbers, as the names `micalg` uses.
fn digest_name(code: &str) -> Option<&'static str> {
    Some(match code {
        "1" => "md5",
        "2" => "sha1",
        "3" => "ripemd160",
        "8" => "sha256",
        "9" => "sha384",
        "10" => "sha512",
        "11" => "sha224",
        _ => return None,
    })
}

/// Encrypts bytes to a set of recipients, answering ASCII-armoured ciphertext.
///
/// Every recipient must have a key. Encrypting to the ones that do and sending
/// anyway would deliver a message the others cannot open, and — worse — would
/// look to the sender exactly like it worked.
pub async fn encrypt(
    body: &[u8],
    recipients: &[String],
    sign_with: Option<&str>,
) -> Result<Vec<u8>> {
    if recipients.is_empty() {
        return Err(Error::Managed("no recipient to encrypt to".into()));
    }

    let mut args: Vec<String> = vec![
        "--encrypt".into(),
        "--armor".into(),
        "--trust-model".into(),
        "always".into(),
    ];
    for recipient in recipients {
        args.push("--recipient".into());
        args.push(recipient.clone());
    }
    if let Some(key) = sign_with {
        args.push("--sign".into());
        args.push("--local-user".into());
        args.push(key.to_string());
    }

    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let status = run(&borrowed, body).await?;

    if status.stdout.is_empty() {
        return Err(Error::Managed(format!(
            "gpg encrypted nothing: {}",
            status.stderr.lines().last().unwrap_or("no reason given")
        )));
    }
    Ok(status.stdout)
}

/// Whether a key that can decrypt or sign is available at all.
pub async fn have_a_secret_key() -> bool {
    run(&["--list-secret-keys", "--with-colons"], &[])
        .await
        .is_ok_and(|s| String::from_utf8_lossy(&s.stdout).contains("sec:"))
}

struct Status {
    /// The `[GNUPG:] ` lines, with that prefix removed.
    lines: Vec<String>,
    stdout: Vec<u8>,
    stderr: String,
}

/// Turns the status lines into one conclusion.
///
/// Order matters and is not alphabetical: it is worst-news-first. A message
/// with several signatures where one is bad must not be reported by whichever
/// happened to be listed last, and `EXPKEYSIG` arrives *alongside* `GOODSIG`
/// rather than instead of it — reading them in the other order would show a
/// plain green tick for an expired key.
fn read_signature(status: &Status) -> Signature {
    let field = |line: &str, n: usize| -> String {
        line.split_whitespace().nth(n).unwrap_or("").to_string()
    };
    let rest = |line: &str, n: usize| -> String {
        line.split_whitespace()
            .skip(n)
            .collect::<Vec<_>>()
            .join(" ")
    };

    for line in &status.lines {
        if let Some(body) = line.strip_prefix("BADSIG ") {
            return Signature::Bad {
                key: field(body, 0),
            };
        }
    }
    for line in &status.lines {
        if let Some(body) = line.strip_prefix("REVKEYSIG ") {
            return Signature::Revoked {
                key: field(body, 0),
                signer: rest(body, 1),
            };
        }
        if let Some(body) = line.strip_prefix("EXPKEYSIG ") {
            return Signature::Expired {
                key: field(body, 0),
                signer: rest(body, 1),
            };
        }
    }
    for line in &status.lines {
        if let Some(body) = line.strip_prefix("GOODSIG ") {
            return Signature::Good {
                key: field(body, 0),
                signer: rest(body, 1),
            };
        }
    }
    for line in &status.lines {
        if let Some(body) = line.strip_prefix("ERRSIG ") {
            // Field 6 is gpg's own reason code. 9 is "no public key", which is
            // the ordinary state of mail from a stranger rather than anything
            // being wrong.
            if field(body, 5) == "9" {
                return Signature::Unknown {
                    key: field(body, 0),
                };
            }
            return Signature::Failed {
                detail: format!(
                    "gpg could not check the signature (code {})",
                    field(body, 5)
                ),
            };
        }
    }

    Signature::Failed {
        detail: "gpg said nothing about a signature".to_string(),
    }
}

/// Runs gpg with the status interface on, and nothing interactive.
///
/// `--batch` and `--no-tty` matter as much as anything above: a gpg that
/// decides to ask a question has no terminal to ask it on, so without them a
/// server hangs forever holding a request open, which reads as the mail being
/// slow rather than as a prompt nobody can see. It is the same rule `ecr init`
/// follows for its own questions.
async fn run(args: &[&str], stdin: &[u8]) -> Result<Status> {
    use tokio::io::AsyncWriteExt;

    let gpg = crate::tools::find("gpg")
        .or_else(|| crate::tools::find("gpg2"))
        .ok_or_else(|| {
            Error::Managed(
                "gpg is not installed. ecr does not ship OpenPGP and does not keep keys; \
                 install GnuPG and this message can be checked"
                    .into(),
            )
        })?;

    let mut command = tokio::process::Command::new(gpg);
    command
        .arg("--batch")
        .arg("--no-tty")
        .arg("--status-fd")
        .arg("2")
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|err| Error::Managed(format!("could not run gpg: {err}")))?;

    if let Some(mut pipe) = child.stdin.take() {
        let _ = pipe.write_all(stdin).await;
        drop(pipe);
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|err| Error::Managed(format!("gpg did not finish: {err}")))?;

    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let lines = stderr
        .lines()
        .filter_map(|line| line.strip_prefix("[GNUPG:] "))
        .map(str::to_string)
        .collect();

    Ok(Status {
        lines,
        stdout: output.stdout,
        stderr,
    })
}

fn path(p: &std::path::Path) -> Result<&str> {
    p.to_str()
        .ok_or_else(|| Error::Managed("a temporary path was not valid UTF-8".into()))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// The top-level `Content-Type` and where the body starts.
fn split_headers(raw: &[u8]) -> Option<(String, usize)> {
    let end = find(raw, b"\r\n\r\n")
        .map(|i| i + 4)
        .or_else(|| find(raw, b"\n\n").map(|i| i + 2))?;

    let headers = String::from_utf8_lossy(&raw[..end]);
    let mut content_type = String::new();
    let mut collecting = false;

    for line in headers.lines() {
        // A header may be folded across lines, and `boundary=` very often is —
        // it is the longest parameter in the header. Reading only the first
        // line finds a Content-Type with no boundary in it and gives up on a
        // message that is perfectly well formed.
        if collecting && line.starts_with([' ', '\t']) {
            content_type.push(' ');
            content_type.push_str(line.trim());
            continue;
        }
        collecting = false;
        if let Some(value) = line.strip_prefix("Content-Type:") {
            content_type = value.trim().to_string();
            collecting = true;
        } else if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-type:") {
            let _ = value;
            content_type = line[line.find(':')? + 1..].trim().to_string();
            collecting = true;
        }
    }

    (!content_type.is_empty()).then_some((content_type, end))
}

fn boundary(content_type: &str) -> Option<String> {
    let lowered = content_type.to_ascii_lowercase();
    let at = lowered.find("boundary=")? + "boundary=".len();
    let rest = content_type[at..].trim_start();

    Some(if let Some(quoted) = rest.strip_prefix('"') {
        quoted[..quoted.find('"')?].to_string()
    } else {
        rest.split([';', ' ', '\r', '\n'])
            .next()?
            .trim()
            .to_string()
    })
}

/// The parts of a multipart body, each exactly as it appears on the wire.
///
/// Byte-exact by construction: this slices the original buffer and never
/// rebuilds anything. The delimiter's leading CRLF belongs to the boundary
/// rather than to the part before it (RFC 2046), so it is not included — a
/// verifier handed that extra pair of bytes reports BADSIG on every message.
fn split_at_boundary(raw: &[u8], boundary: &str) -> Vec<Vec<u8>> {
    let delimiter = format!("--{boundary}");
    let text = raw;
    let mut parts = Vec::new();
    let mut cursor = 0usize;
    let mut start: Option<usize> = None;

    while let Some(offset) = find(&text[cursor..], delimiter.as_bytes()) {
        let at = cursor + offset;
        // Only at the start of a line — the string may legitimately appear
        // inside a part's own content.
        if at != 0 && text[at - 1] != b'\n' {
            cursor = at + delimiter.len();
            continue;
        }

        if let Some(begin) = start {
            let mut end = at;
            // Back off the CRLF that introduces the delimiter.
            if end > begin && text[end - 1] == b'\n' {
                end -= 1;
            }
            if end > begin && text[end - 1] == b'\r' {
                end -= 1;
            }
            parts.push(text[begin..end].to_vec());
        }

        let after = at + delimiter.len();
        if text[after..].starts_with(b"--") {
            break;
        }
        // Past the newline that ends the delimiter line.
        let body = find(&text[after..], b"\n").map(|i| after + i + 1);
        match body {
            Some(begin) => {
                start = Some(begin);
                cursor = begin;
            }
            None => break,
        }
    }

    parts
}

/// Drops a part's own MIME headers, leaving its body.
fn strip_part_headers(part: &[u8]) -> Vec<u8> {
    match find(part, b"\r\n\r\n")
        .map(|i| i + 4)
        .or_else(|| find(part, b"\n\n").map(|i| i + 2))
    {
        Some(at) => part[at..].to_vec(),
        None => part.to_vec(),
    }
}

/// Whether gpg is on the machine at all, for doctor.
///
/// A tool that is absent has to fail as doctor naming it — that is a failure
/// somebody can act on. ecr ships no OpenPGP, so a machine without gpg reads
/// signed mail unverified, and the only wrong thing to do about that is to say
/// nothing.
pub fn installed() -> Option<std::path::PathBuf> {
    crate::tools::find("gpg").or_else(|| crate::tools::find("gpg2"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIGNED: &[u8] = b"From: a@example.com\r\n\
Content-Type: multipart/signed; micalg=pgp-sha256;\r\n\
\tprotocol=\"application/pgp-signature\"; boundary=\"sep\"\r\n\
\r\n\
--sep\r\n\
Content-Type: text/plain\r\n\
\r\n\
hello\r\n\
--sep\r\n\
Content-Type: application/pgp-signature\r\n\
\r\n\
-----BEGIN PGP SIGNATURE-----\r\n\
abc\r\n\
-----END PGP SIGNATURE-----\r\n\
--sep--\r\n";

    /// The signature covers the bytes that were transmitted, headers included.
    /// Anything that has been decoded and re-serialised is not that.
    #[test]
    fn the_signed_part_keeps_its_own_headers_and_its_exact_bytes() {
        let Some(Protection::Signed { signed, signature }) = detect(SIGNED) else {
            panic!("not detected as signed");
        };

        assert_eq!(signed, b"Content-Type: text/plain\r\n\r\nhello");
        assert!(String::from_utf8_lossy(&signature).starts_with("-----BEGIN PGP SIGNATURE-----"));
    }

    /// The CRLF before a boundary belongs to the boundary, not to the part.
    /// Including it reports BADSIG on every message in the world.
    #[test]
    fn the_delimiters_crlf_is_not_part_of_the_signed_bytes() {
        let Some(Protection::Signed { signed, .. }) = detect(SIGNED) else {
            panic!("not detected as signed");
        };
        assert!(
            !signed.ends_with(b"\r\n"),
            "{:?}",
            String::from_utf8_lossy(&signed)
        );
    }

    /// `boundary=` is the longest parameter in the header and is folded in real
    /// mail more often than not. Reading one line finds no boundary and gives
    /// up on a message that is perfectly well formed.
    #[test]
    fn a_folded_content_type_still_yields_its_boundary() {
        let (content_type, _) = split_headers(SIGNED).unwrap();
        assert_eq!(boundary(&content_type).as_deref(), Some("sep"));
    }

    #[test]
    fn encryption_takes_the_second_part_not_the_version_marker() {
        let raw = b"Content-Type: multipart/encrypted; boundary=\"x\"\r\n\r\n\
--x\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\
--x\r\nContent-Type: application/octet-stream\r\n\r\n\
-----BEGIN PGP MESSAGE-----\r\nzzz\r\n-----END PGP MESSAGE-----\r\n--x--\r\n";

        let Some(Protection::Encrypted { ciphertext }) = detect(raw) else {
            panic!("not detected as encrypted");
        };
        assert!(String::from_utf8_lossy(&ciphertext).starts_with("-----BEGIN PGP MESSAGE-----"));
    }

    #[test]
    fn ordinary_mail_carries_nothing() {
        assert!(
            detect(b"From: a@example.com\r\nContent-Type: text/plain\r\n\r\nhello\r\n").is_none()
        );
    }

    #[test]
    fn armour_pasted_into_a_plain_body_is_still_found() {
        let raw = b"Content-Type: text/plain\r\n\r\n-----BEGIN PGP MESSAGE-----\r\nx\r\n";
        assert!(matches!(detect(raw), Some(Protection::Inline { .. })));
    }

    fn status(lines: &[&str]) -> Status {
        Status {
            lines: lines.iter().map(|l| l.to_string()).collect(),
            stdout: Vec::new(),
            stderr: String::new(),
        }
    }

    /// The client draws a padlock from this and nothing else, so the wire tag
    /// has to be stable: renaming a variant silently turns every good
    /// signature into one the client does not recognise.
    #[test]
    fn the_verdict_reaches_a_client_under_a_stable_name() {
        let json = serde_json::to_string(&Signature::Good {
            key: "DEADBEEF".into(),
            signer: "Ada".into(),
        })
        .unwrap();

        assert!(json.contains(r#""state":"good""#), "{json}");
        assert!(json.contains(r#""key":"DEADBEEF""#), "{json}");
    }

    #[test]
    fn a_good_signature_carries_who_signed_it() {
        let read = read_signature(&status(&[
            "NEWSIG",
            "GOODSIG DEADBEEF Ada Lovelace <ada@example.com>",
            "TRUST_ULTIMATE",
        ]));

        assert_eq!(
            read,
            Signature::Good {
                key: "DEADBEEF".into(),
                signer: "Ada Lovelace <ada@example.com>".into()
            }
        );
    }

    /// `EXPKEYSIG` arrives *alongside* `GOODSIG`, not instead of it. Reading
    /// them in the other order shows a plain green tick for an expired key.
    #[test]
    fn an_expired_key_is_not_reported_as_plainly_good() {
        let read = read_signature(&status(&["GOODSIG DEADBEEF Ada", "EXPKEYSIG DEADBEEF Ada"]));

        assert!(matches!(read, Signature::Expired { .. }), "{read:?}");
        assert!(!read.is_good());
    }

    #[test]
    fn a_revoked_key_is_told_apart_from_a_forgery() {
        let read = read_signature(&status(&["GOODSIG D Ada", "REVKEYSIG D Ada"]));
        assert!(matches!(read, Signature::Revoked { .. }), "{read:?}");
    }

    /// The overwhelmingly common case: mail from someone whose key you have
    /// never fetched. Showing it as broken teaches people to ignore the
    /// indicator.
    #[test]
    fn a_key_we_do_not_have_is_unknown_rather_than_bad() {
        let read = read_signature(&status(&["ERRSIG DEADBEEF 1 8 00 1700000000 9 FPR"]));

        assert_eq!(
            read,
            Signature::Unknown {
                key: "DEADBEEF".into()
            }
        );
    }

    #[test]
    fn a_bad_signature_wins_over_every_other_line() {
        let read = read_signature(&status(&["GOODSIG A x", "BADSIG B y"]));
        assert!(matches!(read, Signature::Bad { .. }), "{read:?}");
    }

    /// A security decision is made from the status interface, never from prose
    /// that is translated and has changed between versions.
    #[test]
    fn the_human_readable_output_is_not_read_at_all() {
        let mut plain = status(&[]);
        plain.stderr = "gpg: Good signature from \"Ada Lovelace\"".to_string();

        assert!(matches!(read_signature(&plain), Signature::Failed { .. }));
    }
}
