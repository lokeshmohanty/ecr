use crate::account::Account;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Ok,
    Warn,
    Fail,
}

impl CheckStatus {
    pub fn symbol(&self) -> &'static str {
        match self {
            CheckStatus::Ok => "ok",
            CheckStatus::Warn => "warn",
            CheckStatus::Fail => "FAIL",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Check {
    pub name: String,
    pub status: CheckStatus,
    pub detail: String,
    pub hint: Option<String>,
}

impl Check {
    pub fn ok(name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status: CheckStatus::Ok,
            detail: detail.into(),
            hint: None,
        }
    }

    pub fn warn(name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status: CheckStatus::Warn,
            detail: detail.into(),
            hint: None,
        }
    }

    pub fn fail(name: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status: CheckStatus::Fail,
            detail: detail.into(),
            hint: None,
        }
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigKind {
    Notmuch,
    Mbsync,
    Msmtp,
}

impl fmt::Display for ConfigKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ConfigKind::Notmuch => "notmuch",
            ConfigKind::Mbsync => "mbsync",
            ConfigKind::Msmtp => "msmtp",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "source", content = "via")]
pub enum ConfigSource {
    ServerToml,
    EnvVar(String),
    Xdg,
    LegacyDotfile,
    NotFound,
}

impl fmt::Display for ConfigSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigSource::ServerToml => f.write_str("ecr server.toml"),
            ConfigSource::EnvVar(name) => write!(f, "${name}"),
            ConfigSource::Xdg => f.write_str("XDG"),
            ConfigSource::LegacyDotfile => f.write_str("legacy dotfile"),
            ConfigSource::NotFound => f.write_str("not found"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedConfig {
    pub kind: ConfigKind,
    pub path: Option<PathBuf>,
    pub source: ConfigSource,
    pub shadowed: Vec<PathBuf>,
}

impl ResolvedConfig {
    pub fn missing(kind: ConfigKind) -> Self {
        Self {
            kind,
            path: None,
            source: ConfigSource::NotFound,
            shadowed: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Doctor {
    pub tools: Vec<ToolInfo>,
    pub configs: Vec<ResolvedConfig>,
    pub maildir_root: Option<PathBuf>,
    pub database_path: Option<PathBuf>,
    pub post_new_hook: Option<PathBuf>,
    pub accounts: Vec<Account>,
    pub checks: Vec<Check>,
}

impl Doctor {
    pub fn status(&self) -> CheckStatus {
        self.checks
            .iter()
            .map(|c| c.status)
            .max()
            .unwrap_or(CheckStatus::Ok)
    }

    pub fn is_healthy(&self) -> bool {
        self.status() != CheckStatus::Fail
    }

    pub fn failures(&self) -> impl Iterator<Item = &Check> {
        self.checks.iter().filter(|c| c.status == CheckStatus::Fail)
    }

    pub fn config(&self, kind: ConfigKind) -> Option<&ResolvedConfig> {
        self.configs.iter().find(|c| c.kind == kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doctor_with(checks: Vec<Check>) -> Doctor {
        Doctor {
            tools: Vec::new(),
            configs: Vec::new(),
            maildir_root: None,
            database_path: None,
            post_new_hook: None,
            accounts: Vec::new(),
            checks,
        }
    }

    #[test]
    fn status_is_the_worst_check() {
        let d = doctor_with(vec![
            Check::ok("a", ""),
            Check::warn("b", ""),
            Check::ok("c", ""),
        ]);
        assert_eq!(d.status(), CheckStatus::Warn);
        assert!(d.is_healthy());
    }

    #[test]
    fn any_failure_makes_it_unhealthy() {
        let d = doctor_with(vec![Check::ok("a", ""), Check::fail("b", "broken")]);
        assert_eq!(d.status(), CheckStatus::Fail);
        assert!(!d.is_healthy());
        assert_eq!(d.failures().count(), 1);
    }

    #[test]
    fn no_checks_is_ok() {
        assert_eq!(doctor_with(Vec::new()).status(), CheckStatus::Ok);
    }
}
