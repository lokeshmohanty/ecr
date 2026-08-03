use crate::error::{Error, Result};

pub const GMAIL: &str = "gmail";
pub const MICROSOFT: &str = "microsoft";

/// The providers ecr knows how to talk to. Gmail/Google accounts use `gmail`;
/// Outlook and Microsoft 365 accounts use `microsoft`.
pub const PROVIDERS: [&str; 2] = [GMAIL, MICROSOFT];

pub const DEFAULT_CLIENT: &str = "thunderbird";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Provider {
    pub authorize_url: String,
    pub token_url: String,
    pub device_authorize_url: Option<String>,
    pub scopes: Vec<String>,
    pub tenant: String,
}

/// The endpoints and scopes for a provider, with `{tenant}` resolved.
///
/// Only Microsoft has a tenant; Gmail carries `common` so the field is never
/// absent, which is what the profile files on disk already assume.
pub fn provider(name: &str, tenant: Option<&str>) -> Result<Provider> {
    let tenant = tenant.unwrap_or("common").to_string();
    match name {
        GMAIL => Ok(Provider {
            authorize_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            device_authorize_url: None,
            scopes: vec!["https://mail.google.com/".into()],
            tenant,
        }),
        MICROSOFT => Ok(Provider {
            authorize_url: format!(
                "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize"
            ),
            token_url: format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"),
            device_authorize_url: Some(format!(
                "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/devicecode"
            )),
            scopes: vec![
                "offline_access".into(),
                "https://outlook.office.com/IMAP.AccessAsUser.All".into(),
                "https://outlook.office.com/SMTP.Send".into(),
            ],
            tenant,
        }),
        other => Err(Error::Oauth(format!(
            "unknown provider {other:?}; known providers: {}",
            PROVIDERS.join(", ")
        ))),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Client {
    pub client_id: String,
    pub client_secret: Option<String>,
    pub redirect_uri: Option<String>,
    pub source: String,
}

/// A built-in OAuth client preset.
///
/// Neither Google nor Microsoft will register a client for a mail client that
/// is not a hosted service, so ecr borrows Thunderbird's — the same ones every
/// other desktop client uses. The "secret" is shipped in Thunderbird's own
/// omni.ja and is public by construction; it is a client identifier, not a
/// credential.
pub fn client(provider: &str, preset: Option<&str>) -> Result<Client> {
    let preset = preset.unwrap_or(DEFAULT_CLIENT);
    let source = "Thunderbird built-in issuer config from omni.ja".to_string();

    match (provider, preset) {
        (MICROSOFT, DEFAULT_CLIENT) => Ok(Client {
            client_id: "9e5f94bc-e8a4-4e73-b8be-63364c29d753".into(),
            client_secret: None,
            redirect_uri: Some("https://localhost".into()),
            source,
        }),
        (GMAIL, DEFAULT_CLIENT) => Ok(Client {
            client_id: "406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com"
                .into(),
            client_secret: Some("kSmqreRr0qwBWJgbf5Y-PjSU".into()),
            redirect_uri: None,
            source,
        }),
        (GMAIL | MICROSOFT, other) => Err(Error::Oauth(format!(
            "unknown client preset {other:?} for provider {provider:?}; \
             available presets: {DEFAULT_CLIENT}"
        ))),
        _ => provider_unknown(provider),
    }
}

fn provider_unknown(name: &str) -> Result<Client> {
    Err(Error::Oauth(format!(
        "unknown provider {name:?}; known providers: {}",
        PROVIDERS.join(", ")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microsoft_endpoints_carry_the_tenant() {
        let common = provider(MICROSOFT, None).unwrap();
        assert!(common.authorize_url.contains("/common/"), "{common:?}");
        assert_eq!(common.tenant, "common");

        let tenanted = provider(MICROSOFT, Some("contoso.onmicrosoft.com")).unwrap();
        assert!(
            tenanted.token_url.contains("/contoso.onmicrosoft.com/"),
            "{tenanted:?}"
        );
    }

    #[test]
    fn only_microsoft_offers_the_device_flow() {
        assert!(provider(MICROSOFT, None)
            .unwrap()
            .device_authorize_url
            .is_some());
        assert!(provider(GMAIL, None)
            .unwrap()
            .device_authorize_url
            .is_none());
    }

    #[test]
    fn gmail_asks_for_the_whole_mailbox_and_microsoft_for_imap_and_smtp() {
        assert_eq!(
            provider(GMAIL, None).unwrap().scopes,
            ["https://mail.google.com/"]
        );

        let ms = provider(MICROSOFT, None).unwrap().scopes;
        assert!(ms.contains(&"offline_access".to_string()), "{ms:?}");
        assert!(ms.iter().any(|s| s.contains("IMAP")), "{ms:?}");
        assert!(ms.iter().any(|s| s.contains("SMTP")), "{ms:?}");
    }

    #[test]
    fn an_unknown_provider_names_the_ones_that_exist() {
        let err = provider("yahoo", None).unwrap_err().to_string();
        assert!(err.contains("gmail"), "{err}");
        assert!(err.contains("microsoft"), "{err}");
    }

    #[test]
    fn an_unknown_preset_is_refused_rather_than_silently_defaulted() {
        assert!(client(GMAIL, Some("nope")).is_err());
        assert!(client("yahoo", None).is_err());
    }

    #[test]
    fn only_gmail_ships_a_client_secret() {
        assert!(client(GMAIL, None).unwrap().client_secret.is_some());
        assert!(client(MICROSOFT, None).unwrap().client_secret.is_none());
    }
}
