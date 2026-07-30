use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use subtle::ConstantTimeEq;

const TOKEN_BYTES: usize = 32;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TokenStore {
    pub tokens: Vec<DeviceToken>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceToken {
    pub name: String,
    pub hash: String,
    pub created: String,
}

impl TokenStore {
    pub fn default_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ecr")
            .join("tokens.toml")
    }

    pub fn load(path: &Path) -> anyhow::Result<Self> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(toml::from_str(&text)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, toml::to_string_pretty(self)?)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }

    pub fn issue(&mut self, name: &str) -> anyhow::Result<String> {
        let token = generate_token()?;
        self.tokens.retain(|t| t.name != name);
        self.tokens.push(DeviceToken {
            name: name.to_string(),
            hash: hash_token(&token),
            created: chrono::Utc::now().to_rfc3339(),
        });
        Ok(token)
    }

    pub fn adopt(&mut self, name: &str, token: &str) {
        self.tokens.retain(|t| t.name != name);
        self.tokens.push(DeviceToken {
            name: name.to_string(),
            hash: hash_token(token),
            created: chrono::Utc::now().to_rfc3339(),
        });
    }

    pub fn revoke(&mut self, name: &str) -> bool {
        let before = self.tokens.len();
        self.tokens.retain(|t| t.name != name);
        before != self.tokens.len()
    }

    pub fn verify(&self, presented: &str) -> Option<&DeviceToken> {
        let presented = hash_token(presented);
        self.tokens
            .iter()
            .find(|t| t.hash.as_bytes().ct_eq(presented.as_bytes()).unwrap_u8() == 1)
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }
}

fn generate_token() -> anyhow::Result<String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    Ok(hex::encode(bytes))
}

fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn bearer(header: Option<&str>) -> Option<&str> {
    let value = header?.trim();
    let (scheme, token) = value.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim())
        .filter(|t| !t.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_issued_token_verifies() {
        let mut store = TokenStore::default();
        let token = store.issue("phone").unwrap();

        assert!(store.verify(&token).is_some());
        assert_eq!(store.verify(&token).unwrap().name, "phone");
    }

    #[test]
    fn the_plaintext_token_is_never_stored() {
        let mut store = TokenStore::default();
        let token = store.issue("phone").unwrap();

        assert!(!store.tokens[0].hash.contains(&token));
        assert_eq!(store.tokens[0].hash.len(), 64);
    }

    #[test]
    fn a_wrong_token_does_not_verify() {
        let mut store = TokenStore::default();
        store.issue("phone").unwrap();

        assert!(store.verify("deadbeef").is_none());
        assert!(store.verify("").is_none());
    }

    #[test]
    fn issuing_the_same_name_twice_replaces_the_old_token() {
        let mut store = TokenStore::default();
        let first = store.issue("phone").unwrap();
        let second = store.issue("phone").unwrap();

        assert_eq!(store.tokens.len(), 1);
        assert!(store.verify(&first).is_none());
        assert!(store.verify(&second).is_some());
    }

    #[test]
    fn revoking_removes_the_token() {
        let mut store = TokenStore::default();
        let token = store.issue("phone").unwrap();

        assert!(store.revoke("phone"));
        assert!(store.verify(&token).is_none());
        assert!(!store.revoke("phone"));
    }

    #[test]
    fn tokens_are_unique_per_issue() {
        let mut store = TokenStore::default();
        let a = store.issue("a").unwrap();
        let b = store.issue("b").unwrap();

        assert_ne!(a, b);
        assert_eq!(a.len(), TOKEN_BYTES * 2);
    }

    #[test]
    fn parses_a_bearer_header() {
        assert_eq!(bearer(Some("Bearer abc123")), Some("abc123"));
        assert_eq!(bearer(Some("bearer abc123")), Some("abc123"));
    }

    #[test]
    fn rejects_headers_that_are_not_bearer_tokens() {
        assert_eq!(bearer(None), None);
        assert_eq!(bearer(Some("Basic abc")), None);
        assert_eq!(bearer(Some("Bearer")), None);
        assert_eq!(bearer(Some("Bearer   ")), None);
    }

    #[test]
    fn round_trips_through_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tokens.toml");

        let mut store = TokenStore::default();
        let token = store.issue("laptop").unwrap();
        store.save(&path).unwrap();

        let loaded = TokenStore::load(&path).unwrap();
        assert!(loaded.verify(&token).is_some());
    }

    #[test]
    fn a_missing_file_loads_as_empty() {
        let store = TokenStore::load(Path::new("/nonexistent/tokens.toml")).unwrap();
        assert!(store.is_empty());
    }
}
