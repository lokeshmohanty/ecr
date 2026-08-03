use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// What a profile is: which provider, which address, which client. Written once
/// by `init` and read by everything else.
///
/// The field names are oauthman's, so a profile adopted from it round-trips
/// without translation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileConfig {
    pub profile: String,
    pub provider: String,
    pub email: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub client_preset: Option<String>,
    #[serde(default)]
    pub client_source: Option<String>,
    #[serde(default)]
    pub tenant: Option<String>,
    pub authorize_url: String,
    pub token_url: String,
    #[serde(default)]
    pub device_authorize_url: Option<String>,
    pub scopes: Vec<String>,
    pub redirect_uri: String,
}

/// The tokens themselves. Kept apart from the config because this is the half
/// that is secret and the half that changes on every refresh.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_at: i64,
    #[serde(default = "bearer")]
    pub token_type: String,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub obtained_at: i64,
}

fn bearer() -> String {
    "Bearer".to_string()
}

impl Tokens {
    pub fn expires_in(&self) -> i64 {
        (self.expires_at - now()).max(0)
    }
}

/// Where profiles live, and where they used to live.
///
/// ecr owns `~/.config/ecr/oauth` and `~/.local/state/ecr/oauth`. The legacy
/// directories are oauthman's; a profile is adopted out of them the first time
/// it is asked for, so an existing setup keeps its refresh tokens instead of
/// sending the user back through four browser flows.
#[derive(Debug, Clone)]
pub struct Profiles {
    pub config_dir: PathBuf,
    pub state_dir: PathBuf,
    legacy_config_dir: PathBuf,
    legacy_state_dir: PathBuf,
}

impl Profiles {
    /// For `ecr oauth`, which sets up accounts and so cannot require the mail
    /// configuration to resolve first. Everything that already has a
    /// `MailPaths` must go through `MailPaths::oauth_profiles` instead.
    pub fn from_process() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let config = dirs::config_dir().unwrap_or_else(|| home.join(".config"));
        let state = dirs::state_dir().unwrap_or_else(|| home.join(".local").join("state"));
        Self::under(&config.join("ecr"), &state.join("ecr"))
    }

    pub fn rooted_at(home: &Path) -> Self {
        Self::under(
            &home.join(".config").join("ecr"),
            &home.join(".local").join("state").join("ecr"),
        )
    }

    /// Anchored to an explicit pair of ecr directories.
    ///
    /// This is what keeps a test isolated: `MailPaths` resolves both out of its
    /// own `Env`, so a suite pointed at a tempdir cannot reach the real profiles
    /// — and adoption means a mere *read* would otherwise write there.
    /// oauthman's directories are siblings of ecr's, which is where they were.
    pub fn under(ecr_config_dir: &Path, ecr_state_dir: &Path) -> Self {
        let sibling = |dir: &Path| dir.parent().unwrap_or(Path::new("/")).join("oauthman");
        Self {
            config_dir: ecr_config_dir.join("oauth"),
            state_dir: ecr_state_dir.join("oauth"),
            legacy_config_dir: sibling(ecr_config_dir),
            legacy_state_dir: sibling(ecr_state_dir),
        }
    }

    pub fn config_path(&self, profile: &str) -> PathBuf {
        self.config_dir.join(format!("{profile}.json"))
    }

    pub fn token_path(&self, profile: &str) -> PathBuf {
        self.state_dir.join(format!("{profile}.json"))
    }

    /// Adopt a profile from oauthman's directories, if ecr has none of its own.
    ///
    /// Copies rather than moves: an adoption that goes wrong should not be the
    /// reason a working setup stops working, and the old files cost nothing to
    /// leave behind. Returns what was adopted, so a command can say so.
    pub fn migrate(&self, profile: &str) -> Vec<PathBuf> {
        let pairs = [
            (
                self.legacy_config_dir.join(format!("{profile}.json")),
                self.config_path(profile),
            ),
            (
                self.legacy_state_dir.join(format!("{profile}.json")),
                self.token_path(profile),
            ),
        ];

        let mut adopted = Vec::new();
        for (from, to) in pairs {
            if to.exists() || !from.is_file() {
                continue;
            }
            let Ok(bytes) = std::fs::read(&from) else {
                continue;
            };
            if write_private(&to, &bytes).is_ok() {
                adopted.push(from);
            }
        }
        adopted
    }

    pub fn load_config(&self, profile: &str) -> Result<ProfileConfig> {
        self.migrate(profile);
        let path = self.config_path(profile);
        let text = std::fs::read_to_string(&path).map_err(|_| {
            Error::Oauth(format!(
                "no OAuth profile named {profile:?} ({} does not exist); \
                 create it with `ecr oauth setup {profile} --email <address>`",
                path.display()
            ))
        })?;
        serde_json::from_str(&text).map_err(|err| {
            Error::Oauth(format!("{}: not a readable profile: {err}", path.display()))
        })
    }

    pub fn load_tokens(&self, profile: &str) -> Result<Tokens> {
        self.migrate(profile);
        let path = self.token_path(profile);
        let text = std::fs::read_to_string(&path).map_err(|_| {
            Error::Oauth(format!(
                "profile {profile:?} has never been authorized; \
                 run `ecr oauth authorize {profile}`"
            ))
        })?;
        serde_json::from_str(&text)
            .map_err(|err| Error::Oauth(format!("{}: not a readable token: {err}", path.display())))
    }

    pub fn save_config(&self, config: &ProfileConfig) -> Result<PathBuf> {
        let path = self.config_path(&config.profile);
        write_private(&path, serialize(config)?.as_bytes())?;
        Ok(path)
    }

    pub fn save_tokens(&self, profile: &str, tokens: &Tokens) -> Result<PathBuf> {
        let path = self.token_path(profile);
        write_private(&path, serialize(tokens)?.as_bytes())?;
        Ok(path)
    }

    pub fn forget_tokens(&self, profile: &str) {
        let _ = std::fs::remove_file(self.token_path(profile));
    }

    /// Every profile ecr can see, including ones still only in oauthman's
    /// directory — those are one read away from being adopted.
    pub fn list(&self) -> Vec<String> {
        let mut names: Vec<String> = [&self.config_dir, &self.legacy_config_dir]
            .iter()
            .filter_map(|dir| std::fs::read_dir(dir).ok())
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                name.strip_suffix(".json").map(str::to_string)
            })
            .collect();
        names.sort();
        names.dedup();
        names
    }
}

fn serialize<T: Serialize>(value: &T) -> Result<String> {
    let mut text = serde_json::to_string_pretty(value)
        .map_err(|err| Error::Oauth(format!("could not serialize: {err}")))?;
    text.push('\n');
    Ok(text)
}

/// Write 0600, through a staging file that is renamed into place.
///
/// The rename is what makes a half-written token impossible: a refresh that
/// dies mid-write leaves the previous token intact rather than a truncated file
/// that every later command fails to parse.
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let staging = path.with_extension("json.staging");
    std::fs::write(&staging, bytes)?;
    restrict(&staging)?;
    std::fs::rename(&staging, path)?;
    Ok(())
}

fn restrict(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> ProfileConfig {
        ProfileConfig {
            profile: "main".into(),
            provider: "gmail".into(),
            email: "alice@example.com".into(),
            client_id: "cid".into(),
            client_secret: Some("csecret".into()),
            client_preset: Some("thunderbird".into()),
            client_source: Some("omni.ja".into()),
            tenant: Some("common".into()),
            authorize_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_url: "https://oauth2.googleapis.com/token".into(),
            device_authorize_url: None,
            scopes: vec!["https://mail.google.com/".into()],
            redirect_uri: "http://127.0.0.1:49152/callback".into(),
        }
    }

    fn tokens() -> Tokens {
        Tokens {
            access_token: "at".into(),
            refresh_token: Some("rt".into()),
            expires_at: now() + 3600,
            token_type: "Bearer".into(),
            scope: None,
            obtained_at: now(),
        }
    }

    #[test]
    fn a_profile_round_trips_through_disk() {
        let home = tempfile::tempdir().unwrap();
        let profiles = Profiles::rooted_at(home.path());

        profiles.save_config(&sample()).unwrap();
        profiles.save_tokens("main", &tokens()).unwrap();

        assert_eq!(profiles.load_config("main").unwrap(), sample());
        assert_eq!(profiles.load_tokens("main").unwrap(), tokens());
    }

    #[test]
    fn tokens_are_written_unreadable_to_anyone_else() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let home = tempfile::tempdir().unwrap();
            let profiles = Profiles::rooted_at(home.path());
            let path = profiles.save_tokens("main", &tokens()).unwrap();
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "{mode:o}");
        }
    }

    /// The whole point of the migration: an existing oauthman setup keeps its
    /// refresh tokens instead of being sent back through the browser.
    #[test]
    fn an_oauthman_profile_is_adopted_on_first_read() {
        let home = tempfile::tempdir().unwrap();
        let profiles = Profiles::rooted_at(home.path());

        let legacy_config = home.path().join(".config/oauthman");
        let legacy_state = home.path().join(".local/state/oauthman");
        std::fs::create_dir_all(&legacy_config).unwrap();
        std::fs::create_dir_all(&legacy_state).unwrap();
        std::fs::write(
            legacy_config.join("main.json"),
            serde_json::to_string(&sample()).unwrap(),
        )
        .unwrap();
        std::fs::write(
            legacy_state.join("main.json"),
            serde_json::to_string(&tokens()).unwrap(),
        )
        .unwrap();

        assert_eq!(profiles.load_config("main").unwrap(), sample());
        assert_eq!(
            profiles
                .load_tokens("main")
                .unwrap()
                .refresh_token
                .as_deref(),
            Some("rt")
        );
        assert!(profiles.config_path("main").exists());
        assert!(profiles.token_path("main").exists());
        // Copied, not moved: an adoption that goes wrong must not be the reason
        // a working setup stops working.
        assert!(legacy_config.join("main.json").exists());
    }

    #[test]
    fn adoption_never_overwrites_what_ecr_already_has() {
        let home = tempfile::tempdir().unwrap();
        let profiles = Profiles::rooted_at(home.path());

        let mine = ProfileConfig {
            email: "current@example.com".into(),
            ..sample()
        };
        profiles.save_config(&mine).unwrap();

        let legacy_config = home.path().join(".config/oauthman");
        std::fs::create_dir_all(&legacy_config).unwrap();
        std::fs::write(
            legacy_config.join("main.json"),
            serde_json::to_string(&sample()).unwrap(),
        )
        .unwrap();

        assert_eq!(profiles.load_config("main").unwrap(), mine);
    }

    #[test]
    fn listing_sees_profiles_that_have_not_been_adopted_yet() {
        let home = tempfile::tempdir().unwrap();
        let profiles = Profiles::rooted_at(home.path());

        profiles.save_config(&sample()).unwrap();
        let legacy_config = home.path().join(".config/oauthman");
        std::fs::create_dir_all(&legacy_config).unwrap();
        std::fs::write(legacy_config.join("work.json"), "{}").unwrap();
        std::fs::write(legacy_config.join("main.json"), "{}").unwrap();

        assert_eq!(profiles.list(), ["main", "work"]);
    }

    #[test]
    fn a_missing_profile_names_the_command_that_creates_one() {
        let home = tempfile::tempdir().unwrap();
        let err = Profiles::rooted_at(home.path())
            .load_config("nope")
            .unwrap_err()
            .to_string();
        assert!(err.contains("ecr oauth setup nope"), "{err}");
    }

    #[test]
    fn an_unauthorized_profile_names_the_command_that_authorizes_it() {
        let home = tempfile::tempdir().unwrap();
        let profiles = Profiles::rooted_at(home.path());
        profiles.save_config(&sample()).unwrap();

        let err = profiles.load_tokens("main").unwrap_err().to_string();
        assert!(err.contains("ecr oauth authorize main"), "{err}");
    }

    /// oauthman wrote nulls where ecr writes absent fields, and older files
    /// carry no `token_type` at all. Neither may be a parse failure — that
    /// would strand exactly the tokens the migration exists to keep.
    #[test]
    fn a_sparse_oauthman_token_still_parses() {
        let parsed: Tokens = serde_json::from_str(
            r#"{"access_token": "at", "expires_at": 1785419915, "refresh_token": null}"#,
        )
        .unwrap();
        assert_eq!(parsed.access_token, "at");
        assert_eq!(parsed.refresh_token, None);
        assert_eq!(parsed.token_type, "Bearer");
    }
}
