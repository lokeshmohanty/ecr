use std::time::Duration;

pub const OAUTHMAN: &str = "oauthman";

const REFRESH_MARGIN: Duration = Duration::from_secs(300);

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
         run `oauthman authorize {profile}`"
    )
}

pub async fn token_state(profile: &str) -> TokenState {
    let output = match tokio::process::Command::new(OAUTHMAN)
        .arg("status")
        .arg(profile)
        .output()
        .await
    {
        Ok(output) => output,
        Err(err) => return TokenState::Unknown(err.to_string()),
    };

    if !output.status.success() {
        return TokenState::Unknown(
            String::from_utf8_lossy(&output.stderr)
                .lines()
                .last()
                .unwrap_or("oauthman status failed")
                .to_string(),
        );
    }

    parse_status(&String::from_utf8_lossy(&output.stdout))
}

fn parse_status(stdout: &str) -> TokenState {
    let expires_in = extract_number(stdout, "expires_in");
    let has_refresh = extract_bool(stdout, "has_refresh_token").unwrap_or(false);

    match expires_in {
        Some(seconds) if seconds > REFRESH_MARGIN.as_secs() as i64 => TokenState::Valid {
            expires_in: seconds,
        },
        Some(_) | None if has_refresh => TokenState::Refreshable,
        Some(_) => TokenState::Expired,
        None => TokenState::Unknown("no expiry reported".to_string()),
    }
}

fn extract_number(text: &str, key: &str) -> Option<i64> {
    field(text, key)?.parse().ok()
}

fn extract_bool(text: &str, key: &str) -> Option<bool> {
    field(text, key)?.parse().ok()
}

fn field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{key}\"");
    let line = text.lines().find(|l| l.trim_start().starts_with(&needle))?;
    Some(
        line.split_once(':')?
            .1
            .trim()
            .trim_end_matches([',', '}', ' '])
            .trim_matches('"'),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIVE_STATUS: &str = r#"{
  "client_preset": "thunderbird",
  "email": "alice@example.com",
  "expires_at": 1785419915,
  "expires_in": 2981,
  "has_refresh_token": true,
  "profile": "main",
  "provider": "gmail"
}"#;

    #[test]
    fn a_live_token_is_valid() {
        assert_eq!(
            parse_status(LIVE_STATUS),
            TokenState::Valid { expires_in: 2981 }
        );
        assert!(parse_status(LIVE_STATUS).is_usable());
    }

    #[test]
    fn an_expiring_token_with_a_refresh_token_is_refreshable() {
        let status = r#"{"expires_in": 12, "has_refresh_token": true}"#
            .replace(", ", ",\n  ")
            .replace('{', "{\n  ");
        assert_eq!(parse_status(&status), TokenState::Refreshable);
        assert!(parse_status(&status).is_usable());
    }

    #[test]
    fn an_expired_token_without_a_refresh_token_is_expired() {
        let status = "{\n  \"expires_in\": 0,\n  \"has_refresh_token\": false\n}";
        assert_eq!(parse_status(status), TokenState::Expired);
        assert!(!parse_status(status).is_usable());
    }

    #[test]
    fn unparseable_output_is_unknown_rather_than_a_false_pass() {
        let state = parse_status("something went wrong");
        assert!(matches!(state, TokenState::Unknown(_)));
        assert!(!state.is_usable());
    }

    #[tokio::test]
    async fn a_missing_profile_does_not_panic() {
        let state = token_state("definitely-not-a-profile-xyzzy").await;
        assert!(!state.is_usable());
    }

    #[test]
    fn authorize_hint_names_the_profile_and_stays_conditional() {
        let hint = authorize_hint("main");
        assert!(hint.contains("oauthman authorize main"), "{hint}");
        assert!(
            hint.contains("if"),
            "must not assert the token expired: {hint}"
        );
    }
}
