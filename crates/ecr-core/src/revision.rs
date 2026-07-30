use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Revision {
    pub uuid: String,
    pub lastmod: u64,
}

impl Revision {
    pub fn new(uuid: impl Into<String>, lastmod: u64) -> Self {
        Self {
            uuid: uuid.into(),
            lastmod,
        }
    }

    pub fn etag(&self) -> String {
        format!("\"{}-{}\"", self.uuid, self.lastmod)
    }

    pub fn supersedes(&self, other: &Revision) -> bool {
        self.uuid != other.uuid || self.lastmod > other.lastmod
    }
}

impl fmt::Display for Revision {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.uuid, self.lastmod)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_is_quoted() {
        let rev = Revision::new("abc", 42);
        assert_eq!(rev.etag(), "\"abc-42\"");
    }

    #[test]
    fn newer_lastmod_supersedes() {
        let old = Revision::new("abc", 41);
        let new = Revision::new("abc", 42);
        assert!(new.supersedes(&old));
        assert!(!old.supersedes(&new));
    }

    #[test]
    fn different_database_always_supersedes() {
        let a = Revision::new("abc", 100);
        let b = Revision::new("xyz", 1);
        assert!(b.supersedes(&a));
    }
}
