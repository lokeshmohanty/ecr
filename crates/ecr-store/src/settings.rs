use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerSettings {
    pub notmuch_config: Option<PathBuf>,
    pub mbsync_config: Option<PathBuf>,
    pub msmtp_config: Option<PathBuf>,
    pub maildir_root: Option<PathBuf>,
}

impl ServerSettings {
    pub fn default_path() -> Option<PathBuf> {
        dirs::config_dir().map(|d| d.join("ecr").join("server.toml"))
    }

    pub fn load() -> Self {
        match Self::default_path() {
            Some(path) => Self::load_from(&path),
            None => Self::default(),
        }
    }

    pub fn load_from(path: &Path) -> Self {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        match toml::from_str::<ServerSettings>(&text) {
            Ok(settings) => settings,
            Err(err) => {
                tracing::warn!(path = %path.display(), %err, "ignoring unreadable server settings");
                Self::default()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn missing_file_yields_defaults() {
        let settings = ServerSettings::load_from(Path::new("/nonexistent/ecr/server.toml"));
        assert!(settings.notmuch_config.is_none());
    }

    #[test]
    fn explicit_paths_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.toml");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, r#"notmuch_config = "/etc/notmuch/config""#).unwrap();

        let settings = ServerSettings::load_from(&path);
        assert_eq!(
            settings.notmuch_config,
            Some(PathBuf::from("/etc/notmuch/config"))
        );
        assert!(settings.mbsync_config.is_none());
    }

    #[test]
    fn malformed_file_degrades_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.toml");
        std::fs::write(&path, "this is not toml {{{").unwrap();
        assert!(ServerSettings::load_from(&path).notmuch_config.is_none());
    }
}
