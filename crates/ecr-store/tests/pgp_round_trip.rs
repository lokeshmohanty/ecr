//! OpenPGP against a real gpg, with a throwaway keyring.
//!
//! The unit tests in `pgp.rs` pin the parsing — which bytes are signed, and how
//! a status line becomes a verdict. Neither can tell whether the two halves fit
//! together: a boundary split that is one CRLF out parses perfectly and reports
//! BADSIG on every message in the world, and no amount of reasoning about the
//! code shows it. Only gpg's own answer does.
//!
//! Every test here builds its own `GNUPGHOME` in a tempdir. Nothing touches the
//! developer's keyring, and nothing here can read their mail.

use ecr_store::pgp::{self, Protection, Signature};
use ecr_store::pgp_mime::{self, Protect};

/// A keyring with one key in it, and nothing else on the machine.
struct Keyring {
    home: tempfile::TempDir,
    key: String,
}

const USER: &str = "Ada Lovelace <ada@example.com>";

impl Keyring {
    fn new() -> Option<Self> {
        pgp::installed()?;
        let home = tempfile::tempdir().ok()?;

        // A quick key with no passphrase. `--batch` matters as much here as it
        // does in the module: a gpg that decides to ask something has no
        // terminal to ask it on, and the test would hang rather than fail.
        let made = std::process::Command::new("gpg")
            .env("GNUPGHOME", home.path())
            .args([
                "--batch",
                "--pinentry-mode",
                "loopback",
                "--passphrase",
                "",
                "--quick-generate-key",
                USER,
                // `default` rather than a sign-only key: an encryption subkey
                // is what makes the encryption tests possible at all, and a
                // sign-only key fails them with "no such user id" — which
                // reads as the recipient being wrong rather than as the key
                // having no way to receive anything.
                "default",
                "default",
                "never",
            ])
            .output()
            .ok()?;
        if !made.status.success() {
            return None;
        }

        Some(Self {
            home,
            key: USER.to_string(),
        })
    }

    /// Runs a closure with this keyring as the process's own.
    ///
    /// `GNUPGHOME` is process-wide, so these tests take a lock rather than
    /// running in parallel: two of them setting it at once would have each
    /// one's gpg looking in the other's directory, and the failure reads as a
    /// key that was generated and then was not there. The lock is the async
    /// one because it is held across the gpg calls it exists to serialise —
    /// a std guard held over an await is a deadlock waiting for a scheduler
    /// that parks the task somewhere else.
    async fn scope(&self) -> tokio::sync::MutexGuard<'static, ()> {
        static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let guard = LOCK.lock().await;
        // SAFETY: single-threaded within the lock this guard holds.
        unsafe { std::env::set_var("GNUPGHOME", self.home.path()) };
        guard
    }
}

/// Builds the RFC 3156 message a real mail client would send, with gpg's own
/// signature over the part. This is the whole point of the file: the bytes
/// under test are produced the way a sender produces them, not the way the
/// parser expects them.
fn signed_message(keyring: &Keyring, part: &str) -> Vec<u8> {
    let signature = std::process::Command::new("gpg")
        .env("GNUPGHOME", keyring.home.path())
        .args([
            "--batch",
            "--armor",
            "--detach-sign",
            "--local-user",
            &keyring.key,
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(part.as_bytes())
                .unwrap();
            child.wait_with_output()
        })
        .expect("gpg could not sign");

    let armour = String::from_utf8(signature.stdout).unwrap();

    format!(
        "From: {USER}\r\n\
         Subject: signed\r\n\
         Content-Type: multipart/signed; micalg=pgp-sha512;\r\n\
         \tprotocol=\"application/pgp-signature\"; boundary=\"sep\"\r\n\
         \r\n\
         --sep\r\n\
         {part}\r\n\
         --sep\r\n\
         Content-Type: application/pgp-signature; name=\"signature.asc\"\r\n\
         \r\n\
         {armour}\r\n\
         --sep--\r\n"
    )
    .into_bytes()
}

const PART: &str = "Content-Type: text/plain; charset=utf-8\r\n\r\nhello, world";

/// The one that cannot be reasoned about: a signature gpg made over the bytes
/// a sender signs, checked against the bytes this code hands back.
#[tokio::test]
async fn a_real_signature_over_a_real_message_verifies() {
    let Some(keyring) = Keyring::new() else {
        eprintln!("gpg is not installed; skipping");
        return;
    };
    let _scope = keyring.scope().await;

    let raw = signed_message(&keyring, PART);
    let Some(Protection::Signed { signed, signature }) = pgp::detect(&raw) else {
        panic!("a signed message was not detected as one");
    };

    match pgp::verify(&signed, &signature).await.unwrap() {
        Signature::Good { signer, .. } => assert!(signer.contains("Ada"), "{signer}"),
        other => panic!("gpg refused a signature it had just made: {other:?}"),
    }
}

/// The failure this file exists to catch. If a single byte of the message is
/// altered in transit the signature must not still pass — a verifier that
/// answers Good for tampered mail is worse than none, because it is believed.
#[tokio::test]
async fn a_message_altered_in_transit_does_not_verify() {
    let Some(keyring) = Keyring::new() else {
        eprintln!("gpg is not installed; skipping");
        return;
    };
    let _scope = keyring.scope().await;

    let raw = signed_message(&keyring, PART);
    let tampered = String::from_utf8(raw)
        .unwrap()
        .replace("hello, world", "hello, w0rld")
        .into_bytes();

    let Some(Protection::Signed { signed, signature }) = pgp::detect(&tampered) else {
        panic!("not detected as signed");
    };

    let verdict = pgp::verify(&signed, &signature).await.unwrap();
    assert!(
        !verdict.is_good(),
        "a tampered message verified: {verdict:?}"
    );
}

/// **The bytes on disk are not the bytes that were signed, and this is what
/// that costs.** mbsync writes a maildir with bare newlines, so every signed
/// message ecr has ever read was checked against an LF copy of a signature
/// covering the CRLF form — gpg answered BADSIG and the client said *this
/// message has been altered*, which is the strongest accusation it can make,
/// about mail that is perfectly good.
///
/// The message here is stored the way isync stores one. It cannot be caught by
/// any fixture that keeps its CRLFs, and it cannot be reasoned out of the
/// splitting code, which is correct.
#[tokio::test]
async fn a_signature_survives_being_stored_in_a_maildir_with_bare_newlines() {
    let Some(keyring) = Keyring::new() else {
        eprintln!("gpg is not installed; skipping");
        return;
    };
    let _scope = keyring.scope().await;

    let on_the_wire = signed_message(&keyring, PART);
    let as_stored: Vec<u8> = on_the_wire
        .into_iter()
        .filter(|&byte| byte != b'\r')
        .collect();

    let Some(Protection::Signed { signed, signature }) = pgp::detect(&as_stored) else {
        panic!("a signed message was not detected as one");
    };
    assert!(
        !signed.contains(&b'\r'),
        "the fixture kept its CRLFs and proves nothing"
    );

    match pgp::verify(&signed, &signature).await.unwrap() {
        Signature::Good { signer, .. } => assert!(signer.contains("Ada"), "{signer}"),
        other => panic!("a stored message read as altered: {other:?}"),
    }
}

/// And the half that makes the one above safe. Canonicalising before verifying
/// must not turn "these bytes were changed" into "close enough" — a verifier
/// that answers Good for tampered mail is worse than none.
#[tokio::test]
async fn canonicalising_does_not_rescue_a_message_that_really_was_altered() {
    let Some(keyring) = Keyring::new() else {
        eprintln!("gpg is not installed; skipping");
        return;
    };
    let _scope = keyring.scope().await;

    let raw = signed_message(&keyring, PART);
    let tampered: Vec<u8> = String::from_utf8(raw)
        .unwrap()
        .replace("hello, world", "hello, w0rld")
        .bytes()
        .filter(|&byte| byte != b'\r')
        .collect();

    let Some(Protection::Signed { signed, signature }) = pgp::detect(&tampered) else {
        panic!("not detected as signed");
    };

    let verdict = pgp::verify(&signed, &signature).await.unwrap();
    assert!(
        !verdict.is_good(),
        "a tampered message verified once canonicalised: {verdict:?}"
    );
}

/// A key nobody has is the ordinary state of mail from a stranger, and it has
/// to be told apart from a forgery. Reported as broken, it teaches people to
/// ignore the indicator entirely.
#[tokio::test]
async fn a_signature_from_a_key_we_do_not_have_is_unknown_not_bad() {
    let Some(signer) = Keyring::new() else {
        eprintln!("gpg is not installed; skipping");
        return;
    };
    let raw = signed_message(&signer, PART);

    // A second, empty keyring: the message is genuine, we simply have no way
    // to check it.
    let Some(stranger) = Keyring::new() else {
        return;
    };
    let _scope = stranger.scope().await;

    let Some(Protection::Signed { signed, signature }) = pgp::detect(&raw) else {
        panic!("not detected as signed");
    };

    let verdict = pgp::verify(&signed, &signature).await.unwrap();
    assert!(
        matches!(verdict, Signature::Unknown { .. }),
        "expected an unknown key, got {verdict:?}"
    );
}

/// Encrypt and open, through the same path a reader's message takes.
#[tokio::test]
async fn what_is_encrypted_comes_back_out() {
    let Some(keyring) = Keyring::new() else {
        eprintln!("gpg is not installed; skipping");
        return;
    };
    let _scope = keyring.scope().await;

    let plaintext = b"Content-Type: text/plain\r\n\r\nthe secret";
    let armour = pgp::encrypt(plaintext, std::slice::from_ref(&keyring.key), None)
        .await
        .expect("could not encrypt");

    let opened = pgp::open(&armour).await.expect("could not open");
    assert_eq!(opened.plaintext, plaintext);
    assert!(opened.encrypted, "encryption was not reported as such");
}

/// Clearsigned text is signed and *not* encrypted, and gpg opens it with the
/// same `--decrypt`. Requiring `DECRYPTION_OK` refuses every one of these on
/// the grounds that it could not be decrypted — of something that was never
/// encrypted in the first place.
#[tokio::test]
async fn clearsigned_text_opens_without_ever_having_been_encrypted() {
    let Some(keyring) = Keyring::new() else {
        eprintln!("gpg is not installed; skipping");
        return;
    };
    let _scope = keyring.scope().await;

    let clearsigned = std::process::Command::new("gpg")
        .env("GNUPGHOME", keyring.home.path())
        .args(["--batch", "--clearsign", "--local-user", &keyring.key])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(b"a note in the open")
                .unwrap();
            child.wait_with_output()
        })
        .expect("gpg could not clearsign");

    let opened = pgp::open(&clearsigned.stdout)
        .await
        .expect("could not open");

    assert!(
        !opened.encrypted,
        "clearsigned text was reported as encrypted"
    );
    assert!(
        opened.signature.is_some_and(|s| s.is_good()),
        "a clearsigned note did not verify"
    );
    assert!(String::from_utf8_lossy(&opened.plaintext).contains("a note in the open"));
}

/// Ordinary mail must not go anywhere near gpg. Detection runs on every
/// message that is read, so a false positive here is a process spawned per
/// message and a padlock on mail nobody signed.
#[test]
fn ordinary_mail_is_not_mistaken_for_protected_mail() {
    let raw = b"From: a@example.com\r\n\
                Content-Type: multipart/alternative; boundary=\"x\"\r\n\r\n\
                --x\r\nContent-Type: text/plain\r\n\r\nhello\r\n\
                --x\r\nContent-Type: text/html\r\n\r\n<p>hello</p>\r\n--x--\r\n";

    assert!(pgp::detect(raw).is_none());
}

const OUTGOING: &[u8] = b"From: ada@example.com\r\n\
To: grace@example.org\r\n\
Subject: lunch?\r\n\
MIME-Version: 1.0\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
hello, world\r\n";

/// The one that ties the two halves of OpenPGP together: ecr wraps a message,
/// and ecr's own reader — the same code that reads mail from strangers — has to
/// find it, split it and verify it.
///
/// Nothing about this can be reasoned out. The signature covers bytes produced
/// by one function and located by another, and a boundary or a line ending one
/// byte out passes every unit test in both files while failing here.
#[tokio::test]
async fn a_message_ecr_signs_is_one_ecr_can_verify() {
    let Some(keyring) = Keyring::new() else {
        eprintln!("gpg is not installed; skipping");
        return;
    };
    let _scope = keyring.scope().await;

    let wrapped = pgp_mime::protect(OUTGOING, Protect::Sign, Some(&keyring.key), &[])
        .await
        .expect("could not sign");

    let Some(Protection::Signed { signed, signature }) = pgp::detect(&wrapped) else {
        panic!("ecr could not find the signature it had just written");
    };

    match pgp::verify(&signed, &signature).await.unwrap() {
        Signature::Good { signer, .. } => assert!(signer.contains("Ada"), "{signer}"),
        other => panic!("a message ecr signed did not verify: {other:?}"),
    }
}

/// The addressing has to survive, or the message is unroutable and nothing
/// downstream — not a server, not a client — can say why.
#[tokio::test]
async fn the_addressing_headers_stay_where_a_mail_server_can_read_them() {
    let Some(keyring) = Keyring::new() else {
        return;
    };
    let _scope = keyring.scope().await;

    let wrapped = pgp_mime::protect(OUTGOING, Protect::Sign, Some(&keyring.key), &[])
        .await
        .expect("could not sign");
    let text = String::from_utf8_lossy(&wrapped);
    let head = text.split("\r\n\r\n").next().unwrap();

    assert!(head.contains("From: ada@example.com"), "{head}");
    assert!(head.contains("To: grace@example.org"), "{head}");
    assert!(head.contains("multipart/signed"), "{head}");
    // The original content type moved inside, where it describes the part it
    // belongs to rather than the whole message.
    assert!(!head.contains("text/plain"), "{head}");
}

/// Round trip through the encryption path, ending at the same reader.
#[tokio::test]
async fn a_message_ecr_encrypts_is_one_ecr_can_open() {
    let Some(keyring) = Keyring::new() else {
        return;
    };
    let _scope = keyring.scope().await;

    let wrapped = pgp_mime::protect(
        OUTGOING,
        Protect::SignAndEncrypt,
        Some(&keyring.key),
        std::slice::from_ref(&keyring.key),
    )
    .await
    .expect("could not encrypt");

    let Some(Protection::Encrypted { ciphertext }) = pgp::detect(&wrapped) else {
        panic!("ecr could not find the ciphertext it had just written");
    };

    let opened = pgp::open(&ciphertext).await.expect("could not open");
    assert!(opened.encrypted);
    assert!(
        opened.signature.is_some_and(|s| s.is_good()),
        "the signature inside the encryption did not verify"
    );
    assert!(String::from_utf8_lossy(&opened.plaintext).contains("hello, world"));
}

/// The body must not be readable in the message that goes out. This is the
/// assertion that would catch a wrapper which built the envelope correctly and
/// forgot to substitute the ciphertext for the plaintext — which produces a
/// message that looks encrypted to a human reading the headers.
#[tokio::test]
async fn nothing_of_the_body_is_left_in_the_clear() {
    let Some(keyring) = Keyring::new() else {
        return;
    };
    let _scope = keyring.scope().await;

    let wrapped = pgp_mime::protect(
        OUTGOING,
        Protect::Encrypt,
        None,
        std::slice::from_ref(&keyring.key),
    )
    .await
    .expect("could not encrypt");

    assert!(
        !String::from_utf8_lossy(&wrapped).contains("hello, world"),
        "the plaintext body went out with the message"
    );
    // And the subject did not become secret, which is what PGP/MIME is and is
    // worth pinning so nobody later assumes otherwise.
    assert!(String::from_utf8_lossy(&wrapped).contains("Subject: lunch?"));
}

/// Encrypting to the recipients who have keys and sending anyway delivers a
/// message the others cannot open, and looks to the sender exactly like it
/// worked.
#[tokio::test]
async fn encrypting_to_nobody_is_refused_rather_than_sent_in_the_clear() {
    let Some(keyring) = Keyring::new() else {
        return;
    };
    let _scope = keyring.scope().await;

    let err = pgp_mime::protect(OUTGOING, Protect::Encrypt, None, &[])
        .await
        .expect_err("a message with no recipient key was encrypted anyway");

    assert!(err.to_string().contains("nobody to encrypt to"), "{err}");
}
