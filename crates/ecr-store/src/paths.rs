use crate::error::{Error, Result};
use crate::parse::{MbsyncConfig, MsmtpConfig, NotmuchConfig};
use crate::settings::ServerSettings;
use ecr_core::doctor::{ConfigKind, ConfigSource, ResolvedConfig};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Candidate {
    pub path: PathBuf,
    pub source: ConfigSource,
}

#[derive(Debug, Clone)]
pub struct Env {
    pub home: PathBuf,
    pub config_dir: PathBuf,
    pub notmuch_config: Option<PathBuf>,
    pub notmuch_profile: Option<String>,
    pub mbsyncrc: Option<PathBuf>,
}

impl Env {
    pub fn from_process() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        Self {
            config_dir: dirs::config_dir().unwrap_or_else(|| home.join(".config")),
            home,
            notmuch_config: std::env::var_os("NOTMUCH_CONFIG").map(PathBuf::from),
            notmuch_profile: std::env::var("NOTMUCH_PROFILE").ok(),
            mbsyncrc: std::env::var_os("MBSYNCRC").map(PathBuf::from),
        }
    }

    pub fn rooted_at(home: &Path) -> Self {
        Self {
            home: home.to_path_buf(),
            config_dir: home.join(".config"),
            notmuch_config: None,
            notmuch_profile: None,
            mbsyncrc: None,
        }
    }

    fn candidates(&self, kind: ConfigKind, settings: &ServerSettings) -> Vec<Candidate> {
        let mut out = Vec::new();

        let explicit = match kind {
            ConfigKind::Notmuch => settings.notmuch_config.as_ref(),
            ConfigKind::Mbsync => settings.mbsync_config.as_ref(),
            ConfigKind::Msmtp => settings.msmtp_config.as_ref(),
        };
        if let Some(path) = explicit {
            out.push(Candidate {
                path: path.clone(),
                source: ConfigSource::ServerToml,
            });
        }

        match kind {
            ConfigKind::Notmuch => {
                if let Some(path) = &self.notmuch_config {
                    out.push(Candidate {
                        path: path.clone(),
                        source: ConfigSource::EnvVar("NOTMUCH_CONFIG".into()),
                    });
                }
                let profile = self.notmuch_profile.as_deref().unwrap_or("default");
                out.push(Candidate {
                    path: self.config_dir.join("notmuch").join(profile).join("config"),
                    source: ConfigSource::Xdg,
                });
                out.push(Candidate {
                    path: self.home.join(".notmuch-config"),
                    source: ConfigSource::LegacyDotfile,
                });
            }
            ConfigKind::Mbsync => {
                if let Some(path) = &self.mbsyncrc {
                    out.push(Candidate {
                        path: path.clone(),
                        source: ConfigSource::EnvVar("MBSYNCRC".into()),
                    });
                }
                out.push(Candidate {
                    path: self.config_dir.join("isyncrc"),
                    source: ConfigSource::Xdg,
                });
                out.push(Candidate {
                    path: self.config_dir.join("mbsync").join("mbsyncrc"),
                    source: ConfigSource::Xdg,
                });
                out.push(Candidate {
                    path: self.home.join(".mbsyncrc"),
                    source: ConfigSource::LegacyDotfile,
                });
            }
            ConfigKind::Msmtp => {
                out.push(Candidate {
                    path: self.config_dir.join("msmtp").join("config"),
                    source: ConfigSource::Xdg,
                });
                out.push(Candidate {
                    path: self.home.join(".msmtprc"),
                    source: ConfigSource::LegacyDotfile,
                });
            }
        }
        out
    }

    pub fn resolve(&self, kind: ConfigKind, settings: &ServerSettings) -> ResolvedConfig {
        let candidates = self.candidates(kind, settings);
        let mut chosen: Option<Candidate> = None;
        let mut shadowed = Vec::new();

        for candidate in candidates {
            if !candidate.path.is_file() {
                continue;
            }
            match chosen {
                None => chosen = Some(candidate),
                Some(_) => shadowed.push(candidate.path),
            }
        }

        match chosen {
            Some(c) => ResolvedConfig {
                kind,
                path: Some(c.path),
                source: c.source,
                shadowed,
            },
            None => ResolvedConfig::missing(kind),
        }
    }
}

#[derive(Debug, Clone)]
pub struct MailPaths {
    pub notmuch: ResolvedConfig,
    pub mbsync: ResolvedConfig,
    pub msmtp: ResolvedConfig,
    pub notmuch_config: NotmuchConfig,
    pub mbsync_config: MbsyncConfig,
    pub msmtp_config: MsmtpConfig,
    pub maildir_root: PathBuf,
    pub database_path: PathBuf,
    pub binaries: crate::settings::Binaries,
}

impl MailPaths {
    pub fn discover() -> Result<Self> {
        Self::with(&Env::from_process(), &ServerSettings::load())
    }

    pub fn with(env: &Env, settings: &ServerSettings) -> Result<Self> {
        let notmuch = env.resolve(ConfigKind::Notmuch, settings);
        let mbsync = env.resolve(ConfigKind::Mbsync, settings);
        let msmtp = env.resolve(ConfigKind::Msmtp, settings);

        let notmuch_path = notmuch.path.clone().ok_or_else(|| Error::ConfigNotFound {
            kind: "notmuch",
            searched: env
                .candidates(ConfigKind::Notmuch, settings)
                .into_iter()
                .map(|c| c.path)
                .collect(),
        })?;

        let notmuch_config = NotmuchConfig::parse(&std::fs::read_to_string(&notmuch_path)?);
        let mbsync_config = read_optional(&mbsync)
            .map(|t| MbsyncConfig::parse(&t))
            .unwrap_or_default();
        let msmtp_config = read_optional(&msmtp)
            .map(|t| MsmtpConfig::parse(&t))
            .unwrap_or_default();

        let database_path =
            notmuch_config
                .database_path
                .clone()
                .ok_or_else(|| Error::NoDatabasePath {
                    path: notmuch_path.clone(),
                })?;

        let maildir_root = settings
            .maildir_root
            .clone()
            .or_else(|| notmuch_config.effective_mail_root().cloned())
            .unwrap_or_else(|| database_path.clone());

        Ok(Self {
            notmuch,
            mbsync,
            msmtp,
            notmuch_config,
            mbsync_config,
            msmtp_config,
            maildir_root,
            database_path,
            binaries: crate::settings::Binaries::from_settings(settings),
        })
    }

    pub fn xapian_dir(&self) -> PathBuf {
        self.database_path.join(".notmuch").join("xapian")
    }

    pub fn post_new_hook(&self) -> Option<PathBuf> {
        let hook = self
            .notmuch
            .path
            .as_ref()?
            .parent()?
            .join("hooks")
            .join("post-new");
        hook.is_file().then_some(hook)
    }
}

fn read_optional(resolved: &ResolvedConfig) -> Option<String> {
    std::fs::read_to_string(resolved.path.as_ref()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn xdg_config_wins_over_the_legacy_dotfile() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        write(
            &home.join(".config/notmuch/default/config"),
            "[database]\npath=/srv/Mail\n",
        );
        write(
            &home.join(".notmuch-config"),
            "[database]\npath=/srv/stale-mail\n",
        );

        let paths = MailPaths::with(&Env::rooted_at(home), &ServerSettings::default()).unwrap();

        assert_eq!(paths.notmuch.source, ConfigSource::Xdg);
        assert_eq!(paths.maildir_root, PathBuf::from("/srv/Mail"));
    }

    #[test]
    fn the_stale_dotfile_is_reported_as_shadowed() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        write(
            &home.join(".config/notmuch/default/config"),
            "[database]\npath=/srv/Mail\n",
        );
        write(&home.join(".notmuch-config"), "[database]\npath=/srv/old\n");

        let paths = MailPaths::with(&Env::rooted_at(home), &ServerSettings::default()).unwrap();

        assert_eq!(paths.notmuch.shadowed, vec![home.join(".notmuch-config")]);
    }

    #[test]
    fn server_settings_override_everything() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        write(
            &home.join(".config/notmuch/default/config"),
            "[database]\npath=/srv/xdg\n",
        );
        let explicit = home.join("explicit-config");
        write(&explicit, "[database]\npath=/srv/explicit\n");

        let settings = ServerSettings {
            notmuch_config: Some(explicit.clone()),
            ..Default::default()
        };
        let paths = MailPaths::with(&Env::rooted_at(home), &settings).unwrap();

        assert_eq!(paths.notmuch.source, ConfigSource::ServerToml);
        assert_eq!(paths.maildir_root, PathBuf::from("/srv/explicit"));
    }

    #[test]
    fn falls_back_to_the_legacy_dotfile_when_xdg_is_absent() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        write(
            &home.join(".notmuch-config"),
            "[database]\npath=/srv/only\n",
        );

        let paths = MailPaths::with(&Env::rooted_at(home), &ServerSettings::default()).unwrap();

        assert_eq!(paths.notmuch.source, ConfigSource::LegacyDotfile);
        assert_eq!(paths.maildir_root, PathBuf::from("/srv/only"));
    }

    #[test]
    fn missing_notmuch_config_lists_every_location_searched() {
        let home = tempfile::tempdir().unwrap();
        let err =
            MailPaths::with(&Env::rooted_at(home.path()), &ServerSettings::default()).unwrap_err();

        let message = err.to_string();
        assert!(
            message.contains(".config/notmuch/default/config"),
            "{message}"
        );
        assert!(message.contains(".notmuch-config"), "{message}");
    }

    #[test]
    fn maildir_root_never_guesses_from_the_data_dir() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        write(
            &home.join(".config/notmuch/default/config"),
            "[database]\npath=/home/someone/.local/share/Mail\n",
        );

        let paths = MailPaths::with(&Env::rooted_at(home), &ServerSettings::default()).unwrap();

        assert_eq!(
            paths.maildir_root,
            PathBuf::from("/home/someone/.local/share/Mail")
        );
    }
}
