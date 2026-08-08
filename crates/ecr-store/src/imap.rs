//! Talking to an IMAP server directly, for the two things mbsync cannot do.
//!
//! ecr does not sync mail itself — mbsync does, and the reasons are written up
//! in `docs/content/parity.md`: bidirectional UID and flag propagation with a
//! crash-recoverable journal is the one part of a mail client where a bug costs
//! somebody their mail. What is *safe* to do here is the part that only reads:
//!
//! * **IDLE.** A connection that waits, and says when the server has something.
//!   It writes nothing; all it does is trigger the sync mbsync was going to do
//!   anyway. That removes imapnotify and the supervisor it needs.
//! * **A connection test.** Whether a host, a port, a TLS mode and a credential
//!   actually work, answered before the first sync instead of as an mbsync error
//!   minutes later.
//!
//! Nothing here ever issues a STORE, an APPEND, an EXPUNGE or a COPY. If that
//! changes, the reasoning above has to change with it.

use crate::error::{Error, Result};
use crate::oauth::Profiles;
use ecr_core::managed::{Auth, Endpoint, ManagedAccount, Tls};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

/// How long to hold one IDLE before renewing it.
///
/// RFC 2177 says a client must re-issue IDLE at least every 29 minutes, because
/// servers and the middleboxes between them drop an idle connection well before
/// that. 24 keeps a margin without waking often enough to matter.
const IDLE_RENEW: Duration = Duration::from_secs(24 * 60);

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// What a connection test found, in the order it was found out.
///
/// Each step is reported separately because they fail for entirely different
/// reasons and have entirely different fixes: a host that does not resolve is a
/// typo, a TLS failure is a certificate or a port, and an authentication failure
/// is a token or a password. "Could not connect" answers none of those.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Probe {
    pub reached: bool,
    pub tls: bool,
    pub authenticated: bool,
    /// Folders the server lists, once there is a session to ask in. Useful on
    /// its own: it is how somebody finds out their Sent folder is called
    /// something other than what the preset guessed.
    pub folders: Vec<String>,
    pub error: Option<String>,
}

impl Probe {
    pub(crate) fn failed(self, error: impl std::fmt::Display) -> Self {
        Self {
            error: Some(error.to_string()),
            ..self
        }
    }

    pub fn ok(&self) -> bool {
        self.authenticated && self.error.is_none()
    }
}

/// Picks the TLS backend, once per process.
///
/// rustls refuses to choose when more than one provider is compiled in, and
/// more than one is: reqwest brings its own for the OAuth endpoints and
/// mail-send brings `ring`. What that refusal looks like is a **panic on the
/// first TLS connection**, from inside a builder that has no idea it is being
/// asked to make a policy decision — so it surfaces as ecr crashing while
/// reading mail, naming a crate the reader has never heard of. Choosing here is
/// cheap; being chosen for is not possible.
pub fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // Ignored deliberately: an `Err` means something else installed one
        // first, which is the same outcome this is for.
        let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
    });
}

fn tls_config() -> Arc<ClientConfig> {
    ensure_crypto_provider();

    // The same roots reqwest already uses for the OAuth endpoints, so a machine
    // that can refresh a token can reach the mail server the token is for.
    let roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    Arc::new(
        ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

/// The credential this account presents, refreshed if it is an OAuth one.
async fn credential(profiles: &Profiles, account: &ManagedAccount) -> Result<Credential> {
    match &account.auth {
        Auth::Oauth { profile } => Ok(Credential::Xoauth2(
            crate::oauth::access_token(profiles, profile).await?,
        )),
        Auth::Command { command } => {
            let (program, args) = command
                .split_first()
                .ok_or_else(|| Error::Managed("the password command is empty".into()))?;

            let output = tokio::process::Command::new(program)
                .args(args)
                .output()
                .await
                .map_err(|err| {
                    Error::Managed(format!("the password command could not be run: {err}"))
                })?;

            if !output.status.success() {
                return Err(Error::Managed(format!(
                    "the password command exited with {}",
                    output.status
                )));
            }
            // The first line only: a password manager that prints the password
            // and then a block of metadata is the normal case, and sending the
            // metadata as part of the password fails as a bad credential.
            let text = String::from_utf8_lossy(&output.stdout);
            Ok(Credential::Password(
                text.lines().next().unwrap_or_default().to_string(),
            ))
        }
    }
}

enum Credential {
    Xoauth2(String),
    Password(String),
}

type Stream = tokio_rustls::client::TlsStream<TcpStream>;
type Session = async_imap::Session<Stream>;

/// Opens an authenticated session, filling in how far it got on the way.
///
/// The two callers want the failure in different shapes — a `Probe` to show and
/// an `Error` to log — so this reports a message and lets them wrap it.
async fn connect(
    account: &ManagedAccount,
    credential: Credential,
    probe: &mut Probe,
) -> std::result::Result<Session, String> {
    let endpoint: Endpoint = account
        .imap()
        .ok_or_else(|| "this account names no IMAP server".to_string())?;

    // STARTTLS is not implemented here on purpose: every provider ecr has a
    // preset for offers implicit TLS on 993, and a half-open path that
    // negotiates upward is where downgrade bugs live. mbsync still honours
    // whatever the account is actually set to — this only limits ecr's own
    // connection, which does nothing but wait and read.
    if endpoint.tls != Tls::Implicit {
        return Err(
            "ecr's own IMAP connection requires implicit TLS, normally on port 993".to_string(),
        );
    }

    let stream = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((endpoint.host.as_str(), endpoint.port)),
    )
    .await
    .map_err(|_| format!("{}:{} did not answer in time", endpoint.host, endpoint.port))?
    .map_err(|err| err.to_string())?;
    probe.reached = true;

    let name = ServerName::try_from(endpoint.host.clone()).map_err(|err| err.to_string())?;
    let stream = TlsConnector::from(tls_config())
        .connect(name, stream)
        .await
        .map_err(|err| err.to_string())?;
    probe.tls = true;

    let mut client = async_imap::Client::new(stream);

    // The server speaks first, and `Client::new` does not consume that. Without
    // this every command afterwards is one response behind — the greeting is
    // read as the answer to LOGIN, and the connection simply hangs.
    client
        .read_response()
        .await
        .map_err(|err| err.to_string())?
        .ok_or_else(|| "the server closed before it said hello".to_string())?;

    let session = match credential {
        Credential::Xoauth2(token) => {
            let auth = Xoauth2 {
                user: account.address.clone(),
                token,
            };
            client
                .authenticate("XOAUTH2", &auth)
                .await
                .map_err(|(err, _)| err.to_string())?
        }
        Credential::Password(password) => client
            .login(&account.address, &password)
            .await
            .map_err(|(err, _)| err.to_string())?,
    };
    probe.authenticated = true;
    Ok(session)
}

struct Xoauth2 {
    user: String,
    token: String,
}

impl async_imap::Authenticator for &Xoauth2 {
    type Response = String;

    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        // The same string mbsync and msmtp are handed, and the same one
        // `oauth::xoauth2` builds — the \x01 separators are the format, not a
        // quoting artefact.
        format!("user={}\x01auth=Bearer {}\x01\x01", self.user, self.token)
    }
}

/// Whether this account's IMAP settings and credential actually work.
pub async fn probe(profiles: &Profiles, account: &ManagedAccount) -> Probe {
    let mut probe = Probe::default();

    let credential = match credential(profiles, account).await {
        Ok(credential) => credential,
        Err(err) => return probe.failed(err),
    };

    let mut session = match connect(account, credential, &mut probe).await {
        Ok(session) => session,
        Err(err) => return probe.failed(err),
    };

    // Everything below is a nicety; having authenticated is the answer. The
    // folder list is the useful part of it — it is how somebody finds out their
    // Sent folder is not called what the preset guessed.
    if let Ok(folders) = session.list(None, Some("*")).await {
        use futures::TryStreamExt;
        let mut folders = std::pin::pin!(folders);
        while let Ok(Some(folder)) = folders.try_next().await {
            probe.folders.push(folder.name().to_string());
        }
    }
    let _ = session.logout().await;

    probe
}

/// Waits on one folder until the server says something arrived.
///
/// Answers `Ok(())` when there is something to sync and an error when the
/// connection could not be kept. It deliberately says nothing about *what*
/// arrived: the caller runs mbsync, which is what actually knows.
pub async fn wait_for_mail(
    profiles: &Profiles,
    account: &ManagedAccount,
    folder: &str,
) -> Result<()> {
    let mut probe = Probe::default();
    let credential = credential(profiles, account).await?;

    let mut session = connect(account, credential, &mut probe)
        .await
        .map_err(Error::Managed)?;

    session
        .select(folder)
        .await
        .map_err(|err| Error::Managed(format!("could not select {folder}: {err}")))?;

    let mut idle = session.idle();
    idle.init()
        .await
        .map_err(|err| Error::Managed(format!("IDLE was refused: {err}")))?;

    let (wait, interrupt) = idle.wait_with_timeout(IDLE_RENEW);
    let outcome = wait.await;
    drop(interrupt);

    match outcome {
        // Something happened, or the renewal window elapsed. Both mean "go and
        // look": a timeout that syncs once every 24 minutes is a poll, which is
        // exactly the behaviour ecr had before this existed.
        Ok(_) => Ok(()),
        Err(err) => Err(Error::Managed(format!("IDLE ended: {err}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_xoauth2_string_is_the_format_the_providers_specify() {
        let mut auth = &Xoauth2 {
            user: "alice@example.com".into(),
            token: "tok".into(),
        };
        assert_eq!(
            async_imap::Authenticator::process(&mut auth, b""),
            "user=alice@example.com\u{1}auth=Bearer tok\u{1}\u{1}"
        );
    }

    #[test]
    fn a_probe_is_only_ok_when_it_authenticated_and_nothing_went_wrong() {
        let mut probe = Probe {
            reached: true,
            tls: true,
            authenticated: true,
            ..Default::default()
        };
        assert!(probe.ok());

        probe.error = Some("but then it hung up".into());
        assert!(!probe.ok());

        assert!(!Probe::default().ok());
    }

    /// A probe that got partway has to say how far, because "could not connect"
    /// is the same words for a typo, a wrong port and an expired token.
    #[tokio::test]
    async fn a_host_that_is_not_there_is_reported_as_unreached() {
        let account = ManagedAccount::new(
            "alice@example.com",
            ecr_core::managed::Provider::Generic,
            Auth::oauth("nope"),
        );
        let home = tempfile::tempdir().unwrap();
        let profiles = Profiles::rooted_at(home.path());

        let probe = probe(&profiles, &account).await;
        assert!(!probe.reached);
        assert!(probe.error.is_some());
    }
}
