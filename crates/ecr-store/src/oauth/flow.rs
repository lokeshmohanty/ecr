use crate::error::{Error, Result};
use crate::oauth::profile::{now, ProfileConfig, Tokens};
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use rand::Rng;
use reqwest::Url;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// The ports oauthman picked from, kept so a profile carried over from it keeps
/// working against a redirect URI the provider has already seen.
pub const CALLBACK_PORTS: std::ops::Range<u16> = 49152..49252;

/// A token endpoint's own refusal, with the `error` code it named.
///
/// The device flow polls until the user finishes, and *every* poll before that
/// is an HTTP 400 saying `authorization_pending`. Parsing the code out is what
/// separates "keep waiting" from "this will never work" — matching on substrings
/// of the raw body would treat a client-id typo as something to sit through.
#[derive(Debug)]
struct TokenError {
    code: Option<String>,
    body: String,
}

impl From<TokenError> for Error {
    fn from(err: TokenError) -> Self {
        Error::Oauth(err.body)
    }
}

type TokenResult<T> = std::result::Result<T, TokenError>;

/// `reqwest::Client::new()` *panics* when it cannot load the system trust
/// store, so it is never used: a machine with no CA bundle is a bad
/// configuration, not a reason for ecr to abort.
fn https() -> TokenResult<reqwest::Client> {
    reqwest::Client::builder()
        .build()
        .map_err(|err| TokenError {
            code: None,
            body: format!("could not start an HTTPS client: {err}"),
        })
}

async fn post_form(url: &str, params: &HashMap<&str, String>) -> TokenResult<serde_json::Value> {
    let response = https()?
        .post(url)
        .form(params)
        .send()
        .await
        .map_err(|err| TokenError {
            code: None,
            body: format!("could not reach {url}: {err}"),
        })?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let parsed: Option<serde_json::Value> = serde_json::from_str(&body).ok();

    if status.is_success() {
        return parsed.ok_or_else(|| TokenError {
            code: None,
            body: format!("{url} answered {status} with something that is not JSON: {body}"),
        });
    }

    let code = parsed
        .as_ref()
        .and_then(|v| v.get("error"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let description = parsed
        .as_ref()
        .and_then(|v| v.get("error_description"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    Err(TokenError {
        body: match (&code, &description) {
            (Some(code), Some(text)) => format!("{url} refused: {code}: {text}"),
            (Some(code), None) => format!("{url} refused: {code}"),
            _ => format!("{url} answered {status}: {body}"),
        },
        code,
    })
}

fn tokens_from(response: &serde_json::Value, fallback_refresh: Option<&str>) -> Result<Tokens> {
    let access_token = response
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            Error::Oauth(format!(
                "token response carried no access_token: {response}"
            ))
        })?
        .to_string();

    let string = |key: &str| {
        response
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };

    Ok(Tokens {
        access_token,
        refresh_token: string("refresh_token").or_else(|| fallback_refresh.map(str::to_string)),
        expires_at: now()
            + response
                .get("expires_in")
                .and_then(|v| v.as_i64())
                .unwrap_or(3600),
        token_type: string("token_type").unwrap_or_else(|| "Bearer".to_string()),
        scope: string("scope"),
        obtained_at: now(),
    })
}

/// Trade the refresh token for a fresh access token.
///
/// The response need not carry a refresh token — Google only returns one on the
/// first authorization — so the existing one is carried forward rather than
/// dropped, which would turn every refresh into the last one.
pub async fn refresh(config: &ProfileConfig, tokens: &Tokens) -> Result<Tokens> {
    let refresh_token = tokens.refresh_token.as_deref().ok_or_else(|| {
        Error::Oauth(format!(
            "profile {:?} has no refresh token; run `ecr oauth authorize {}`",
            config.profile, config.profile
        ))
    })?;

    let mut params = HashMap::from([
        ("grant_type", "refresh_token".to_string()),
        ("client_id", config.client_id.clone()),
        ("refresh_token", refresh_token.to_string()),
        ("scope", config.scopes.join(" ")),
    ]);
    if let Some(secret) = &config.client_secret {
        params.insert("client_secret", secret.clone());
    }

    let response = post_form(&config.token_url, &params).await?;
    tokens_from(&response, Some(refresh_token))
}

/// The base64 XOAUTH2 string IMAP and SMTP want.
pub fn xoauth2(email: &str, access_token: &str) -> String {
    STANDARD_NO_PAD.encode(format!(
        "user={email}\x01auth=Bearer {access_token}\x01\x01"
    ))
}

fn pkce_pair() -> (String, String) {
    let mut bytes = [0u8; 64];
    rand::rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn random_state() -> String {
    let mut bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// A free loopback port from the range oauthman used.
pub async fn free_port() -> Result<u16> {
    for port in CALLBACK_PORTS {
        if TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
            return Ok(port);
        }
    }
    Err(Error::Oauth(
        "no free loopback port for the OAuth callback".to_string(),
    ))
}

pub struct Authorization {
    pub url: String,
    listener: TcpListener,
    verifier: String,
    state: String,
    redirect_uri: String,
}

/// Build the authorization URL and start listening for the callback *before*
/// the browser opens.
///
/// Binding first is what makes the race impossible: a provider that answers
/// instantly would otherwise redirect to a port nothing is listening on yet,
/// and the user would see a connection refused page with the code already spent.
pub async fn begin(config: &ProfileConfig) -> Result<Authorization> {
    let redirect = Url::parse(&config.redirect_uri)
        .map_err(|err| Error::Oauth(format!("profile has an unreadable redirect_uri: {err}")))?;

    let port = match (redirect.scheme(), redirect.port()) {
        ("http", Some(port)) => port,
        _ => {
            return Err(Error::Oauth(format!(
                "redirect_uri {} is not a loopback address this can serve, so the browser \
                 flow cannot complete; authorize this profile with `--flow device` instead",
                config.redirect_uri
            )))
        }
    };

    let listener = TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|err| {
            Error::Oauth(format!(
                "could not listen on 127.0.0.1:{port} for the OAuth callback: {err}"
            ))
        })?;

    let (verifier, challenge) = pkce_pair();
    let state = random_state();

    let mut url = Url::parse(&config.authorize_url)
        .map_err(|err| Error::Oauth(format!("profile has an unreadable authorize_url: {err}")))?;
    url.query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &config.redirect_uri)
        .append_pair("response_mode", "query")
        .append_pair("scope", &config.scopes.join(" "))
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("login_hint", &config.email);

    Ok(Authorization {
        url: url.to_string(),
        listener,
        verifier,
        state,
        redirect_uri: config.redirect_uri.clone(),
    })
}

impl Authorization {
    /// Wait for the browser to come back, then trade the code for tokens.
    pub async fn finish(self, config: &ProfileConfig, timeout: Duration) -> Result<Tokens> {
        let params = tokio::time::timeout(timeout, self.await_callback())
            .await
            .map_err(|_| {
                Error::Oauth(format!(
                    "timed out after {}s waiting for the OAuth callback",
                    timeout.as_secs()
                ))
            })??;

        if params.get("state").map(String::as_str) != Some(self.state.as_str()) {
            return Err(Error::Oauth(
                "OAuth state mismatch: the reply did not come from the request that was sent"
                    .to_string(),
            ));
        }
        if let Some(error) = params.get("error") {
            let detail = params.get("error_description").unwrap_or(error);
            return Err(Error::Oauth(format!("authorization was refused: {detail}")));
        }
        let code = params.get("code").ok_or_else(|| {
            Error::Oauth("the callback carried no authorization code".to_string())
        })?;

        let mut form = HashMap::from([
            ("grant_type", "authorization_code".to_string()),
            ("client_id", config.client_id.clone()),
            ("code", code.clone()),
            ("redirect_uri", self.redirect_uri.clone()),
            ("code_verifier", self.verifier.clone()),
        ]);
        if let Some(secret) = &config.client_secret {
            form.insert("client_secret", secret.clone());
        }

        let response = post_form(&config.token_url, &form).await?;
        tokens_from(&response, None)
    }

    /// Accept connections until one of them is the callback.
    ///
    /// Anything else — a favicon request, a stray probe — is answered and
    /// ignored rather than mistaken for the reply, which would abandon the flow
    /// with no code and no way to tell why.
    async fn await_callback(&self) -> Result<HashMap<String, String>> {
        loop {
            let Ok((stream, _)) = self.listener.accept().await else {
                continue;
            };
            if let Some(params) = handle(stream).await {
                return Ok(params);
            }
        }
    }
}

async fn handle(mut stream: TcpStream) -> Option<HashMap<String, String>> {
    let mut buffer = [0u8; 8192];
    let read = stream.read(&mut buffer).await.ok()?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let target = request.split_whitespace().nth(1)?;

    // Only the path and query matter, and only a real URL parser gets the
    // percent-decoding right; the base is thrown away.
    let url = Url::parse("http://127.0.0.1").ok()?.join(target).ok()?;
    if url.path() != "/callback" {
        respond(&mut stream, "404 Not Found", "not the OAuth callback\n").await;
        return None;
    }

    let params: HashMap<String, String> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    let body = if params.contains_key("error") {
        "Authorization failed. Check the terminal.\n"
    } else {
        "Authorized. You can close this window.\n"
    };
    respond(&mut stream, "200 OK", body).await;
    Some(params)
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
}

pub struct DeviceCode {
    pub user_code: String,
    pub verification_uri: String,
    pub message: Option<String>,
    device_code: String,
    interval: u64,
}

/// Ask for a device code, which the user types into a browser anywhere.
///
/// This is the flow Microsoft gets: Thunderbird's Microsoft client registers
/// `https://localhost` as its redirect, which no local HTTP listener can serve.
pub async fn begin_device(config: &ProfileConfig) -> Result<DeviceCode> {
    let url = config.device_authorize_url.as_deref().ok_or_else(|| {
        Error::Oauth(format!(
            "provider {} does not offer the device flow",
            config.provider
        ))
    })?;

    let params = HashMap::from([
        ("client_id", config.client_id.clone()),
        ("scope", config.scopes.join(" ")),
    ]);
    let response = post_form(url, &params).await?;

    let string = |key: &str| {
        response
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };

    Ok(DeviceCode {
        user_code: string("user_code")
            .ok_or_else(|| Error::Oauth("no user_code in the device response".to_string()))?,
        verification_uri: string("verification_uri")
            .or_else(|| string("verification_url"))
            .ok_or_else(|| {
                Error::Oauth("no verification_uri in the device response".to_string())
            })?,
        message: string("message"),
        device_code: string("device_code")
            .ok_or_else(|| Error::Oauth("no device_code in the device response".to_string()))?,
        interval: response
            .get("interval")
            .and_then(|v| v.as_u64())
            .unwrap_or(5),
    })
}

impl DeviceCode {
    /// Poll until the user finishes in the browser.
    ///
    /// `authorization_pending` is the ordinary answer and `slow_down` asks for a
    /// longer gap; every other code ends the wait, because nothing the user does
    /// in the browser will fix a bad client id.
    pub async fn poll(self, config: &ProfileConfig, timeout: Duration) -> Result<Tokens> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut interval = self.interval;

        let mut form = HashMap::from([
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code".to_string(),
            ),
            ("client_id", config.client_id.clone()),
            ("device_code", self.device_code.clone()),
        ]);
        if let Some(secret) = &config.client_secret {
            form.insert("client_secret", secret.clone());
        }

        while tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_secs(interval)).await;
            match post_form(&config.token_url, &form).await {
                Ok(response) => return tokens_from(&response, None),
                Err(err) => match err.code.as_deref() {
                    Some("authorization_pending") => continue,
                    Some("slow_down") => interval += 5,
                    Some("expired_token") => {
                        return Err(Error::Oauth(
                            "the device code expired before it was entered".to_string(),
                        ))
                    }
                    _ => return Err(err.into()),
                },
            }
        }

        Err(Error::Oauth(format!(
            "timed out after {}s waiting for the device code to be entered",
            timeout.as_secs()
        )))
    }
}

/// Hand a URL to the desktop, reporting whether anything took it.
///
/// A headless session has no browser, and pretending otherwise would leave the
/// user watching a flow that cannot start; the caller prints the URL instead.
pub fn open_browser(url: &str) -> bool {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener)
        .arg(url)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_xoauth2_string_is_what_imap_expects() {
        let encoded = xoauth2("alice@example.com", "tok");
        let decoded = String::from_utf8(STANDARD_NO_PAD.decode(&encoded).unwrap()).unwrap();
        assert_eq!(decoded, "user=alice@example.com\x01auth=Bearer tok\x01\x01");
    }

    #[test]
    fn the_pkce_challenge_is_the_sha256_of_the_verifier() {
        let (verifier, challenge) = pkce_pair();
        assert_eq!(
            challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
        );
        // Both must survive a URL query untouched.
        assert!(!verifier.contains(['+', '/', '=']), "{verifier}");
        assert!(!challenge.contains(['+', '/', '=']), "{challenge}");
    }

    #[test]
    fn two_flows_never_share_a_verifier_or_a_state() {
        assert_ne!(pkce_pair().0, pkce_pair().0);
        assert_ne!(random_state(), random_state());
    }

    fn gmail_profile(redirect: &str) -> ProfileConfig {
        ProfileConfig {
            profile: "main".into(),
            provider: "gmail".into(),
            email: "alice@example.com".into(),
            client_id: "cid".into(),
            client_secret: None,
            client_preset: None,
            client_source: None,
            tenant: None,
            authorize_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            device_authorize_url: None,
            scopes: vec!["https://mail.google.com/".into()],
            redirect_uri: redirect.to_string(),
        }
    }

    #[tokio::test]
    async fn the_authorize_url_carries_pkce_and_the_login_hint() {
        let (_config, auth, _port) = begin_bound().await;

        let url = Url::parse(&auth.url).unwrap();
        let params: HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(params["code_challenge_method"], "S256");
        assert_eq!(params["login_hint"], "alice@example.com");
        assert_eq!(params["client_id"], "cid");
        assert_eq!(params["response_type"], "code");
        assert_eq!(params["scope"], "https://mail.google.com/");
        assert!(!params["code_challenge"].is_empty());
    }

    /// A port the kernel has just handed out.
    ///
    /// Not `free_port`: that scans the range from the bottom and drops its probe
    /// immediately, so every test running in parallel is handed the same number
    /// and all but one fail to bind. The kernel's ephemeral ports are dealt out
    /// round-robin, which is the property the tests actually need.
    async fn ephemeral_port() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        port
    }

    /// A started authorization, on whatever port could actually be bound.
    ///
    /// Any "find a free port, then bind it" pair has a gap, and with the whole
    /// suite running in parallel something else claims the port inside that gap
    /// often enough to fail a run. Production is right to report that as an
    /// error — a real callback has to arrive on the port the provider was told
    /// about — so the retry belongs here rather than in `begin`.
    async fn begin_bound() -> (ProfileConfig, Authorization, u16) {
        for _ in 0..64 {
            let port = ephemeral_port().await;
            let config = gmail_profile(&format!("http://127.0.0.1:{port}/callback"));
            if let Ok(auth) = begin(&config).await {
                return (config, auth, port);
            }
        }
        panic!("no loopback port stayed free long enough to bind");
    }

    /// `begin` and `begin_device` hold the PKCE verifier and the device code,
    /// so they deliberately do not derive Debug and `unwrap_err` is unavailable.
    fn message<T>(result: Result<T>) -> String {
        match result {
            Ok(_) => panic!("expected this to be refused"),
            Err(err) => err.to_string(),
        }
    }

    /// Thunderbird's Microsoft client redirects to `https://localhost`, which no
    /// local listener can answer. Refusing here is what turns a flow that hangs
    /// until it times out into one sentence naming the flag that works.
    #[tokio::test]
    async fn a_redirect_that_cannot_be_served_names_the_device_flow() {
        let config = gmail_profile("https://localhost");
        let err = message(begin(&config).await);
        assert!(err.contains("--flow device"), "{err}");
    }

    /// Binding before the browser opens is the whole reason `begin` is separate
    /// from `finish`; a port that is still free afterwards means it is not.
    #[tokio::test]
    async fn the_callback_port_is_held_before_the_browser_opens() {
        let (_config, _auth, port) = begin_bound().await;
        assert!(TcpListener::bind(("127.0.0.1", port)).await.is_err());
    }

    #[tokio::test]
    async fn the_callback_is_read_off_a_real_request() {
        let (_config, auth, port) = begin_bound().await;
        let state = auth.state.clone();
        let sent = state.clone();

        tokio::spawn(async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let request = format!(
                "GET /callback?code=the-code&state={sent} HTTP/1.1\r\nHost: localhost\r\n\r\n"
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut reply = String::new();
            stream.read_to_string(&mut reply).await.unwrap();
            assert!(reply.contains("Authorized"), "{reply}");
        });

        let params = tokio::time::timeout(Duration::from_secs(5), auth.await_callback())
            .await
            .expect("callback never arrived")
            .unwrap();
        assert_eq!(params["code"], "the-code");
        assert_eq!(params["state"], state);
    }

    /// A browser asking for /favicon.ico must not be mistaken for the reply.
    #[tokio::test]
    async fn a_request_that_is_not_the_callback_is_ignored() {
        let (_config, auth, port) = begin_bound().await;
        let state = auth.state.clone();

        tokio::spawn(async move {
            for target in ["/favicon.ico", "/callback?code=real&state=STATE"] {
                let target = target.replace("STATE", &state);
                let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                let request = format!("GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n");
                stream.write_all(request.as_bytes()).await.unwrap();
                let mut reply = String::new();
                let _ = stream.read_to_string(&mut reply).await;
            }
        });

        let params = tokio::time::timeout(Duration::from_secs(5), auth.await_callback())
            .await
            .expect("callback never arrived")
            .unwrap();
        assert_eq!(params["code"], "real");
    }

    #[tokio::test]
    async fn a_forged_callback_is_refused() {
        let (config, auth, port) = begin_bound().await;

        tokio::spawn(async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let request =
                "GET /callback?code=stolen&state=not-the-state HTTP/1.1\r\nHost: x\r\n\r\n";
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut reply = String::new();
            let _ = stream.read_to_string(&mut reply).await;
        });

        let err = auth
            .finish(&config, Duration::from_secs(5))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("state mismatch"), "{err}");
    }

    #[tokio::test]
    async fn a_provider_that_refuses_says_so_rather_than_timing_out() {
        let (config, auth, port) = begin_bound().await;
        let state = auth.state.clone();

        tokio::spawn(async move {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let request = format!(
                "GET /callback?error=access_denied&error_description=user+said+no&state={state} \
                 HTTP/1.1\r\nHost: x\r\n\r\n"
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut reply = String::new();
            let _ = stream.read_to_string(&mut reply).await;
        });

        let err = auth
            .finish(&config, Duration::from_secs(5))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("user said no"), "{err}");
    }

    #[tokio::test]
    async fn a_browser_that_never_comes_back_times_out() {
        let (config, auth, _port) = begin_bound().await;

        let err = auth
            .finish(&config, Duration::from_millis(50))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("timed out"), "{err}");
    }

    #[tokio::test]
    async fn the_device_flow_is_refused_for_a_provider_without_one() {
        let config = gmail_profile("http://127.0.0.1:49152/callback");
        let err = message(begin_device(&config).await);
        assert!(err.contains("does not offer the device flow"), "{err}");
    }

    #[test]
    fn a_refresh_response_without_a_refresh_token_keeps_the_old_one() {
        let response = serde_json::json!({"access_token": "new", "expires_in": 3599});
        let tokens = tokens_from(&response, Some("keep-me")).unwrap();
        assert_eq!(tokens.access_token, "new");
        assert_eq!(tokens.refresh_token.as_deref(), Some("keep-me"));
        assert!(tokens.expires_in() > 3500);
    }

    #[test]
    fn a_response_with_no_access_token_is_an_error_not_an_empty_token() {
        let response = serde_json::json!({"expires_in": 3599});
        assert!(tokens_from(&response, None).is_err());
    }

    #[tokio::test]
    async fn refreshing_without_a_refresh_token_names_the_fix() {
        let config = gmail_profile("http://127.0.0.1:49152/callback");
        let tokens = Tokens {
            access_token: "at".into(),
            refresh_token: None,
            expires_at: 0,
            token_type: "Bearer".into(),
            scope: None,
            obtained_at: 0,
        };
        let err = refresh(&config, &tokens).await.unwrap_err().to_string();
        assert!(err.contains("ecr oauth authorize main"), "{err}");
    }
}
