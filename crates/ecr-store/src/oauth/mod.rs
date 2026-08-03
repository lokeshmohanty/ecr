pub mod flow;
pub mod profile;
pub mod providers;

use crate::error::{Error, Result};
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;

pub use profile::{ProfileConfig, Profiles, Tokens};
pub use providers::{Client, Provider, DEFAULT_CLIENT, GMAIL, MICROSOFT, PROVIDERS};

/// Refresh this far ahead of expiry.
///
/// mbsync asks for a token and then spends minutes syncing; handing it one that
/// expires in ten seconds is handing it a failure halfway through.
const REFRESH_SKEW: Duration = Duration::from_secs(120);

/// Below this, doctor reports a token as expiring rather than valid. Wider than
/// the refresh skew on purpose: doctor is reporting, not deciding.
const REPORT_MARGIN: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenState {
    Valid { expires_in: i64 },
    Refreshable,
    Expired,
    Unknown(String),
}

impl TokenState {
    pub fn is_usable(&self) -> bool {
        matches!(self, TokenState::Valid { .. } | TokenState::Refreshable)
    }
}

/// Appended to a send failure when the account authenticates with OAuth: a
/// token expiry is the most likely cause, so the fix is named rather than
/// leaving the user to decode msmtp's stderr.
pub fn authorize_hint(profile: &str) -> String {
    format!(
        "this account authenticates with OAuth; if the token has expired, \
         run `ecr oauth authorize {profile}`"
    )
}

/// What doctor reports. Reads the files rather than refreshing: doctor says what
/// is, and a check that quietly fixed what it was checking could never fail.
pub fn token_state(profiles: &Profiles, name: &str) -> TokenState {
    let tokens = match profiles.load_tokens(name) {
        Ok(tokens) => tokens,
        Err(err) => return TokenState::Unknown(err.to_string()),
    };

    let expires_in = tokens.expires_in();
    if expires_in > REPORT_MARGIN.as_secs() as i64 {
        TokenState::Valid { expires_in }
    } else if tokens.refresh_token.is_some() {
        TokenState::Refreshable
    } else {
        TokenState::Expired
    }
}

/// A valid access token, refreshed and written back if it was about to expire.
pub async fn access_token(profiles: &Profiles, name: &str) -> Result<String> {
    Ok(ensure(profiles, name).await?.1.access_token)
}

/// The base64 XOAUTH2 string, which is what mbsync and msmtp actually consume.
pub async fn xoauth2(profiles: &Profiles, name: &str) -> Result<String> {
    let (config, tokens) = ensure(profiles, name).await?;
    Ok(flow::xoauth2(&config.email, &tokens.access_token))
}

async fn ensure(profiles: &Profiles, name: &str) -> Result<(ProfileConfig, Tokens)> {
    let config = profiles.load_config(name)?;
    let tokens = profiles.load_tokens(name)?;

    if tokens.expires_in() > REFRESH_SKEW.as_secs() as i64 {
        return Ok((config, tokens));
    }

    let refreshed = flow::refresh(&config, &tokens).await?;
    profiles.save_tokens(name, &refreshed)?;
    Ok((config, refreshed))
}

/// The shape `ecr oauth status` prints. The field names are oauthman's, so a
/// script that read its output keeps working.
#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub profile: String,
    pub provider: String,
    pub email: String,
    pub client_preset: Option<String>,
    pub client_source: Option<String>,
    pub expires_at: i64,
    pub expires_in: i64,
    pub has_refresh_token: bool,
    pub scopes: Vec<String>,
}

pub fn status(profiles: &Profiles, name: &str) -> Result<Status> {
    let config = profiles.load_config(name)?;
    let tokens = profiles.load_tokens(name)?;
    Ok(Status {
        profile: config.profile,
        provider: config.provider,
        email: config.email,
        client_preset: config.client_preset,
        client_source: config.client_source,
        expires_at: tokens.expires_at,
        expires_in: tokens.expires_in(),
        has_refresh_token: tokens.refresh_token.is_some(),
        scopes: config.scopes,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    /// The device flow where the provider offers one, the browser flow
    /// otherwise. Microsoft's built-in client cannot serve a loopback redirect,
    /// so for it this is the only flow that works.
    Auto,
    AuthCode,
    Device,
}

impl Flow {
    fn resolve(self, config: &ProfileConfig) -> Flow {
        match self {
            Flow::Auto if config.device_authorize_url.is_some() => Flow::Device,
            Flow::Auto => Flow::AuthCode,
            other => other,
        }
    }
}

#[derive(Debug, Clone)]
pub struct InitOptions {
    pub profile: String,
    pub provider: String,
    pub email: String,
    pub client_preset: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub tenant: Option<String>,
    pub scopes: Vec<String>,
    pub redirect_port: Option<u16>,
    pub force: bool,
}

/// Write a profile, without authorizing it.
///
/// A profile with an explicit `--client-id` gets no preset: the caller brought
/// their own client, and recording Thunderbird's secret beside it would be a
/// lie about where the credential came from.
pub async fn init(profiles: &Profiles, options: InitOptions) -> Result<PathBuf> {
    let path = profiles.config_path(&options.profile);
    if path.exists() && !options.force {
        return Err(Error::Oauth(format!(
            "profile {:?} already exists at {}; pass --force to replace it",
            options.profile,
            path.display()
        )));
    }

    let provider = providers::provider(&options.provider, options.tenant.as_deref())?;
    let preset = match (&options.client_preset, &options.client_id) {
        (Some(name), _) => Some(providers::client(&options.provider, Some(name))?),
        (None, None) => Some(providers::client(&options.provider, None)?),
        (None, Some(_)) => None,
    };

    let client_id = options
        .client_id
        .or_else(|| preset.as_ref().map(|c| c.client_id.clone()))
        .ok_or_else(|| {
            Error::Oauth("missing client id; pass --client-id or --client thunderbird".to_string())
        })?;

    let redirect_uri = match preset.as_ref().and_then(|c| c.redirect_uri.clone()) {
        Some(uri) => uri,
        None => {
            let port = match options.redirect_port {
                Some(port) => port,
                None => flow::free_port().await?,
            };
            format!("http://127.0.0.1:{port}/callback")
        }
    };

    let scopes = if options.scopes.is_empty() {
        provider.scopes
    } else {
        options.scopes
    };

    let config = ProfileConfig {
        profile: options.profile.clone(),
        provider: options.provider,
        email: options.email,
        client_id,
        client_secret: options
            .client_secret
            .or_else(|| preset.as_ref().and_then(|c| c.client_secret.clone())),
        client_preset: preset.as_ref().map(|_| {
            options
                .client_preset
                .clone()
                .unwrap_or_else(|| DEFAULT_CLIENT.to_string())
        }),
        client_source: preset.as_ref().map(|c| c.source.clone()),
        tenant: Some(provider.tenant),
        authorize_url: provider.authorize_url,
        token_url: provider.token_url,
        device_authorize_url: provider.device_authorize_url,
        scopes,
        redirect_uri,
    };

    let written = profiles.save_config(&config)?;
    // A replaced profile's tokens belong to the client that is gone, and a
    // refresh against the new one would fail with nothing naming why.
    if options.force {
        profiles.forget_tokens(&options.profile);
    }
    Ok(written)
}

/// What `authorize` needs the caller to put in front of the user. The flows
/// differ in what that is, and only the caller knows where it can be printed.
pub enum Prompt {
    /// Open this URL. `opened` is whether a browser already took it.
    Browser { url: String, opened: bool },
    /// Type this code at this address.
    Device {
        user_code: String,
        verification_uri: String,
        message: Option<String>,
    },
}

/// Run a flow to completion, calling `announce` once the user has something to
/// act on and before the wait begins.
pub async fn authorize(
    profiles: &Profiles,
    name: &str,
    requested: Flow,
    timeout: Duration,
    open: bool,
    announce: impl FnOnce(Prompt),
) -> Result<PathBuf> {
    let config = profiles.load_config(name)?;

    let tokens = match requested.resolve(&config) {
        Flow::Device => {
            let device = flow::begin_device(&config).await?;
            announce(Prompt::Device {
                user_code: device.user_code.clone(),
                verification_uri: device.verification_uri.clone(),
                message: device.message.clone(),
            });
            device.poll(&config, timeout).await?
        }
        _ => {
            let authorization = flow::begin(&config).await?;
            let opened = open && flow::open_browser(&authorization.url);
            announce(Prompt::Browser {
                url: authorization.url.clone(),
                opened,
            });
            authorization.finish(&config, timeout).await?
        }
    };

    profiles.save_tokens(name, &tokens)
}

#[cfg(test)]
mod tests {
    use super::*;
    use profile::now;

    fn store() -> (tempfile::TempDir, Profiles) {
        let home = tempfile::tempdir().unwrap();
        let profiles = Profiles::rooted_at(home.path());
        (home, profiles)
    }

    async fn gmail(profiles: &Profiles, name: &str) {
        init(
            profiles,
            InitOptions {
                profile: name.to_string(),
                provider: GMAIL.to_string(),
                email: "alice@example.com".to_string(),
                client_preset: None,
                client_id: None,
                client_secret: None,
                tenant: None,
                scopes: Vec::new(),
                redirect_port: Some(49500),
                force: false,
            },
        )
        .await
        .unwrap();
    }

    fn write_tokens(profiles: &Profiles, name: &str, expires_in: i64, refresh: Option<&str>) {
        profiles
            .save_tokens(
                name,
                &Tokens {
                    access_token: "at".into(),
                    refresh_token: refresh.map(str::to_string),
                    expires_at: now() + expires_in,
                    token_type: "Bearer".into(),
                    scope: None,
                    obtained_at: now(),
                },
            )
            .unwrap();
    }

    #[tokio::test]
    async fn init_takes_the_thunderbird_preset_by_default() {
        let (_home, profiles) = store();
        gmail(&profiles, "main").await;

        let config = profiles.load_config("main").unwrap();
        assert_eq!(config.client_preset.as_deref(), Some("thunderbird"));
        assert!(config.client_secret.is_some());
        assert_eq!(config.redirect_uri, "http://127.0.0.1:49500/callback");
        assert_eq!(config.scopes, ["https://mail.google.com/"]);
    }

    /// A caller who brought their own client id did not bring Thunderbird's
    /// secret, and recording one would misreport where the credential came from.
    #[tokio::test]
    async fn an_explicit_client_id_takes_no_preset() {
        let (_home, profiles) = store();
        init(
            &profiles,
            InitOptions {
                profile: "mine".into(),
                provider: GMAIL.into(),
                email: "alice@example.com".into(),
                client_preset: None,
                client_id: Some("my-own-id".into()),
                client_secret: None,
                tenant: None,
                scopes: Vec::new(),
                redirect_port: Some(49501),
                force: false,
            },
        )
        .await
        .unwrap();

        let config = profiles.load_config("mine").unwrap();
        assert_eq!(config.client_id, "my-own-id");
        assert_eq!(config.client_preset, None);
        assert_eq!(config.client_secret, None);
        assert_eq!(config.client_source, None);
    }

    #[tokio::test]
    async fn microsoft_gets_the_device_endpoint_and_a_localhost_redirect() {
        let (_home, profiles) = store();
        init(
            &profiles,
            InitOptions {
                profile: "work".into(),
                provider: MICROSOFT.into(),
                email: "bob@example.com".into(),
                client_preset: None,
                client_id: None,
                client_secret: None,
                tenant: None,
                scopes: Vec::new(),
                redirect_port: None,
                force: false,
            },
        )
        .await
        .unwrap();

        let config = profiles.load_config("work").unwrap();
        assert!(config.device_authorize_url.is_some());
        assert_eq!(config.redirect_uri, "https://localhost");
        assert_eq!(Flow::Auto.resolve(&config), Flow::Device);
    }

    #[tokio::test]
    async fn gmail_resolves_auto_to_the_browser_flow() {
        let (_home, profiles) = store();
        gmail(&profiles, "main").await;
        let config = profiles.load_config("main").unwrap();
        assert_eq!(Flow::Auto.resolve(&config), Flow::AuthCode);
    }

    #[tokio::test]
    async fn an_explicit_flow_is_never_overridden() {
        let (_home, profiles) = store();
        gmail(&profiles, "main").await;
        let config = profiles.load_config("main").unwrap();
        assert_eq!(Flow::Device.resolve(&config), Flow::Device);
    }

    #[tokio::test]
    async fn init_refuses_to_clobber_a_profile_without_force() {
        let (_home, profiles) = store();
        gmail(&profiles, "main").await;

        let err = init(
            &profiles,
            InitOptions {
                profile: "main".into(),
                provider: GMAIL.into(),
                email: "other@example.com".into(),
                client_preset: None,
                client_id: None,
                client_secret: None,
                tenant: None,
                scopes: Vec::new(),
                redirect_port: Some(49502),
                force: false,
            },
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("--force"), "{err}");
        assert_eq!(
            profiles.load_config("main").unwrap().email,
            "alice@example.com"
        );
    }

    /// Tokens belong to the client that obtained them. Replacing the profile and
    /// keeping them would leave a refresh failing against a client that never
    /// issued them, with nothing naming why.
    #[tokio::test]
    async fn forcing_a_profile_drops_the_tokens_it_had() {
        let (_home, profiles) = store();
        gmail(&profiles, "main").await;
        write_tokens(&profiles, "main", 3600, Some("rt"));

        init(
            &profiles,
            InitOptions {
                profile: "main".into(),
                provider: GMAIL.into(),
                email: "alice@example.com".into(),
                client_preset: None,
                client_id: None,
                client_secret: None,
                tenant: None,
                scopes: Vec::new(),
                redirect_port: Some(49503),
                force: true,
            },
        )
        .await
        .unwrap();

        assert!(!profiles.token_path("main").exists());
    }

    #[tokio::test]
    async fn a_live_token_is_valid_and_an_expiring_one_is_refreshable() {
        let (_home, profiles) = store();
        gmail(&profiles, "main").await;

        write_tokens(&profiles, "main", 3600, Some("rt"));
        assert!(matches!(
            token_state(&profiles, "main"),
            TokenState::Valid { .. }
        ));

        write_tokens(&profiles, "main", 30, Some("rt"));
        assert_eq!(token_state(&profiles, "main"), TokenState::Refreshable);
    }

    #[tokio::test]
    async fn an_expired_token_with_no_refresh_token_is_expired() {
        let (_home, profiles) = store();
        gmail(&profiles, "main").await;
        write_tokens(&profiles, "main", 0, None);
        assert_eq!(token_state(&profiles, "main"), TokenState::Expired);
        assert!(!token_state(&profiles, "main").is_usable());
    }

    #[test]
    fn a_missing_profile_is_unknown_rather_than_a_false_pass() {
        let (_home, profiles) = store();
        let state = token_state(&profiles, "definitely-not-a-profile-xyzzy");
        assert!(matches!(state, TokenState::Unknown(_)));
        assert!(!state.is_usable());
    }

    /// A token still comfortably alive must not cost a network round trip:
    /// mbsync asks for one on every channel of every sync.
    #[tokio::test]
    async fn a_live_token_is_served_without_reaching_the_provider() {
        let (_home, profiles) = store();
        gmail(&profiles, "main").await;
        write_tokens(&profiles, "main", 3600, Some("rt"));

        assert_eq!(access_token(&profiles, "main").await.unwrap(), "at");
        assert_eq!(
            xoauth2(&profiles, "main").await.unwrap(),
            flow::xoauth2("alice@example.com", "at")
        );
    }

    #[tokio::test]
    async fn status_reports_what_a_script_used_to_read_from_oauthman() {
        let (_home, profiles) = store();
        gmail(&profiles, "main").await;
        write_tokens(&profiles, "main", 3600, Some("rt"));

        let status = status(&profiles, "main").unwrap();
        assert_eq!(status.provider, "gmail");
        assert_eq!(status.email, "alice@example.com");
        assert!(status.has_refresh_token);
        assert!(status.expires_in > 3500);

        let json = serde_json::to_value(&status).unwrap();
        for key in [
            "profile",
            "provider",
            "email",
            "client_preset",
            "client_source",
            "expires_at",
            "expires_in",
            "has_refresh_token",
            "scopes",
        ] {
            assert!(json.get(key).is_some(), "status lost {key}");
        }
    }

    #[tokio::test]
    async fn authorize_hint_names_ecr_and_stays_conditional() {
        let hint = authorize_hint("main");
        assert!(hint.contains("ecr oauth authorize main"), "{hint}");
        assert!(
            hint.contains("if"),
            "must not assert the token expired: {hint}"
        );
    }
}
