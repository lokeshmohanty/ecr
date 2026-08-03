use anyhow::Result;
use ecr_store::oauth::{self, Flow, InitOptions, Profiles, Prompt};
use std::time::Duration;

pub struct Init {
    pub profile: String,
    pub provider: String,
    pub email: String,
    pub client: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub tenant: Option<String>,
    pub scope: Vec<String>,
    pub redirect_port: Option<u16>,
    pub force: bool,
}

impl From<Init> for InitOptions {
    fn from(init: Init) -> Self {
        InitOptions {
            profile: init.profile,
            provider: init.provider,
            email: init.email,
            client_preset: init.client,
            client_id: init.client_id,
            client_secret: init.client_secret,
            tenant: init.tenant,
            scopes: init.scope,
            redirect_port: init.redirect_port,
            force: init.force,
        }
    }
}

pub struct Authorize {
    pub flow: Flow,
    pub timeout: u64,
    pub no_open: bool,
}

pub async fn init(options: Init) -> Result<()> {
    let profiles = Profiles::from_process();
    let path = oauth::init(&profiles, options.into()).await?;
    println!("{}", path.display());
    Ok(())
}

/// Create the profile and walk straight into the browser: the two things
/// nobody wants to do separately when adding an account.
pub async fn setup(init_options: Init, auth: Authorize) -> Result<()> {
    let profile = init_options.profile.clone();
    let profiles = Profiles::from_process();
    let path = oauth::init(&profiles, init_options.into()).await?;
    eprintln!("wrote {}", path.display());
    run_authorize(&profiles, &profile, auth).await
}

pub async fn authorize(profile: &str, auth: Authorize) -> Result<()> {
    let profiles = Profiles::from_process();
    adopt(&profiles, profile);
    run_authorize(&profiles, profile, auth).await
}

async fn run_authorize(profiles: &Profiles, profile: &str, auth: Authorize) -> Result<()> {
    let path = oauth::authorize(
        profiles,
        profile,
        auth.flow,
        Duration::from_secs(auth.timeout),
        !auth.no_open,
        announce,
    )
    .await?;
    println!("{}", path.display());
    Ok(())
}

/// Everything the user has to act on goes to stderr, so `authorize` still
/// prints exactly one line — the token path — on stdout.
fn announce(prompt: Prompt) {
    match prompt {
        Prompt::Browser { url, opened } => {
            if opened {
                eprintln!("opened a browser to authorize this account.");
                eprintln!("if nothing appeared, open this:\n\n  {url}\n");
            } else {
                eprintln!("open this to authorize this account:\n\n  {url}\n");
            }
        }
        Prompt::Device {
            user_code,
            verification_uri,
            message,
        } => match message {
            Some(message) => eprintln!("{message}"),
            None => eprintln!("open {verification_uri} and enter the code {user_code}"),
        },
    }
}

pub async fn token(profile: &str) -> Result<()> {
    let profiles = Profiles::from_process();
    adopt(&profiles, profile);
    println!("{}", oauth::access_token(&profiles, profile).await?);
    Ok(())
}

pub async fn xoauth2(profile: &str) -> Result<()> {
    let profiles = Profiles::from_process();
    adopt(&profiles, profile);
    println!("{}", oauth::xoauth2(&profiles, profile).await?);
    Ok(())
}

pub fn status(profile: &str) -> Result<()> {
    let profiles = Profiles::from_process();
    adopt(&profiles, profile);
    let status = oauth::status(&profiles, profile)?;
    println!("{}", serde_json::to_string_pretty(&status)?);
    Ok(())
}

pub fn client_id(provider: &str, client: Option<&str>) -> Result<()> {
    println!("{}", oauth::providers::client(provider, client)?.client_id);
    Ok(())
}

pub fn client_secret(provider: &str, client: Option<&str>) -> Result<()> {
    let client = oauth::providers::client(provider, client)?;
    match client.client_secret {
        Some(secret) => {
            println!("{secret}");
            Ok(())
        }
        None => anyhow::bail!("the {provider} client preset has no client secret"),
    }
}

/// Say so when a profile is adopted from oauthman, once.
///
/// Silence would be worse than noise here: the files ecr reads from then on are
/// not the ones the user has been editing, and nothing else would ever mention
/// the move.
fn adopt(profiles: &Profiles, profile: &str) {
    for from in profiles.migrate(profile) {
        eprintln!("adopted profile {profile:?} from {}", from.display());
    }
}
