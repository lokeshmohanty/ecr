use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerSettings {
    pub notmuch_config: Option<PathBuf>,
    pub mbsync_config: Option<PathBuf>,
    pub msmtp_config: Option<PathBuf>,
    pub maildir_root: Option<PathBuf>,
    pub notmuch_bin: Option<PathBuf>,
    pub mbsync_bin: Option<PathBuf>,
    pub msmtp_bin: Option<PathBuf>,
    /// `index = false` sends every read back to notmuch. See
    /// [`crate::paths::MailPaths::use_index`].
    pub index: Option<bool>,
}

impl ServerSettings {
    /// Save the settings to its default location (`~/.config/ecr/server.toml`).
    /// This writes a TOML representation of the struct, preserving any fields
    /// that are present. Missing fields are omitted (the default `None` values).
    pub fn save(&self) -> std::io::Result<()> {
        let path = Self::default_path().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "cannot determine config directory for server.toml",
            )
        })?;
        // Serialize to TOML – `toml` crate is already a dependency.
        let toml_str = toml::to_string_pretty(self).map_err(|e| std::io::Error::other(e))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Atomic write – write to a temporary file then rename.
        let tmp = path.with_extension("toml.new");
        std::fs::write(&tmp, toml_str)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binaries {
    pub notmuch: PathBuf,
    pub mbsync: PathBuf,
    pub msmtp: PathBuf,
}

impl Default for Binaries {
    fn default() -> Self {
        Self {
            notmuch: PathBuf::from(crate::tools::NOTMUCH),
            mbsync: PathBuf::from(crate::tools::MBSYNC),
            msmtp: PathBuf::from(crate::tools::MSMTP),
        }
    }
}

impl Binaries {
    pub fn from_settings(settings: &ServerSettings) -> Self {
        let defaults = Self::default();
        Self {
            notmuch: settings.notmuch_bin.clone().unwrap_or(defaults.notmuch),
            mbsync: settings.mbsync_bin.clone().unwrap_or(defaults.mbsync),
            msmtp: settings.msmtp_bin.clone().unwrap_or(defaults.msmtp),
        }
    }
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
