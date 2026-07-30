use ecr_store::paths::{Env, MailPaths};
use ecr_store::settings::ServerSettings;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct Fixture {
    _home: tempfile::TempDir,
    pub paths: Arc<MailPaths>,
}

impl Fixture {
    pub fn build() -> Option<Self> {
        if ecr_store::tools::find(ecr_store::tools::NOTMUCH).is_none() {
            eprintln!("skipping: notmuch is not on PATH");
            return None;
        }

        let home = tempfile::tempdir().expect("tempdir");
        let root = home.path().join("Mail");
        let inbox = root.join("main/Inbox");

        for leaf in ["cur", "new", "tmp"] {
            std::fs::create_dir_all(inbox.join(leaf)).expect("maildir");
        }
        for leaf in ["cur", "new", "tmp"] {
            std::fs::create_dir_all(root.join("main/Archive").join(leaf)).expect("maildir");
        }

        for source in [fixtures_dir().join("cur"), mime_fixtures_dir()] {
            for entry in std::fs::read_dir(&source).expect("fixtures") {
                let entry = entry.expect("fixture entry");
                let name = entry.file_name().to_string_lossy().replace(".eml", ":2,");
                std::fs::copy(entry.path(), inbox.join("cur").join(name)).expect("copy fixture");
            }
        }

        let config_dir = home.path().join(".config/notmuch/default");
        std::fs::create_dir_all(&config_dir).expect("config dir");
        std::fs::write(
            config_dir.join("config"),
            format!(
                "[database]\npath={}\n\n[user]\nname=Test\nprimary_email=test@example.com\n\n\
                 [new]\ntags=unread;inbox\n\n[search]\nexclude_tags=deleted;spam\n",
                root.display()
            ),
        )
        .expect("notmuch config");

        std::fs::create_dir_all(home.path().join(".config/msmtp")).expect("msmtp dir");
        std::fs::write(
            home.path().join(".config/isyncrc"),
            format!(
                "IMAPAccount main\nUser test@example.com\n\n\
                 IMAPStore main-remote\nAccount main\n\n\
                 MaildirStore main-local\nPath {}/main/\n\n\
                 Channel main\nFar :main-remote:\nNear :main-local:\n",
                root.display()
            ),
        )
        .expect("isyncrc");
        std::fs::write(
            home.path().join(".config/msmtp/config"),
            "account main\nfrom test@example.com\naccount default : main\n",
        )
        .expect("msmtp config");

        index(&config_dir.join("config"));

        let paths = MailPaths::with(&Env::rooted_at(home.path()), &ServerSettings::default())
            .expect("discover paths");

        Some(Self {
            _home: home,
            paths: Arc::new(paths),
        })
    }

    pub fn store(&self) -> ecr_store::Notmuch {
        ecr_store::Notmuch::new(Arc::clone(&self.paths))
    }
}

fn index(config: &Path) {
    let output = std::process::Command::new("notmuch")
        .arg(format!("--config={}", config.display()))
        .arg("new")
        .arg("--quiet")
        .env("NOTMUCH_CONFIG", config)
        .output()
        .expect("run notmuch new");

    assert!(
        output.status.success(),
        "notmuch new failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/maildir")
        .canonicalize()
        .expect("fixtures/maildir must exist")
}

fn mime_fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/mime")
        .canonicalize()
        .expect("fixtures/mime must exist")
}

#[macro_export]
macro_rules! fixture_or_skip {
    () => {
        match $crate::support::Fixture::build() {
            Some(fixture) => fixture,
            None => return,
        }
    };
}
