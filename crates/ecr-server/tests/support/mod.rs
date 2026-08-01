#![allow(dead_code)]

use ecr_store::paths::{Env, MailPaths};
use ecr_store::settings::ServerSettings;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const TOKEN: &str = "test-token-0123456789abcdef";

pub struct Server {
    home: tempfile::TempDir,
    base: String,
    client: reqwest::Client,
    paths: Arc<MailPaths>,
}

impl Server {
    pub async fn start() -> Option<Self> {
        if ecr_store::tools::find(ecr_store::tools::NOTMUCH).is_none() {
            eprintln!("skipping: notmuch is not on PATH");
            return None;
        }

        let home = tempfile::tempdir().expect("tempdir");
        let root = home.path().join("Mail");
        let inbox = root.join("main/Inbox");

        for leaf in ["cur", "new", "tmp"] {
            std::fs::create_dir_all(inbox.join(leaf)).expect("maildir");
            std::fs::create_dir_all(root.join("main/Archive").join(leaf)).expect("maildir");
        }

        for source in [fixtures("maildir/cur"), fixtures("mime")] {
            for entry in std::fs::read_dir(&source).expect("fixtures") {
                let entry = entry.expect("entry");
                let name = entry.file_name().to_string_lossy().replace(".eml", ":2,");
                std::fs::copy(entry.path(), inbox.join("cur").join(name)).expect("copy");
            }
        }

        let config_dir = home.path().join(".config/notmuch/default");
        std::fs::create_dir_all(&config_dir).expect("config dir");
        std::fs::write(
            config_dir.join("config"),
            format!(
                "[database]\npath={}\n\n[user]\nprimary_email=test@example.com\n\n[new]\ntags=unread;inbox\n",
                root.display()
            ),
        )
        .expect("notmuch config");

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

        std::fs::create_dir_all(home.path().join(".config/msmtp")).expect("msmtp dir");
        std::fs::write(
            home.path().join(".config/msmtp/config"),
            "account main\nfrom test@example.com\naccount default : main\n",
        )
        .expect("msmtp config");

        index(&config_dir.join("config"));

        let bin = home.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin");

        let settings = ServerSettings {
            mbsync_bin: Some(bin.join("mbsync")),
            msmtp_bin: Some(bin.join("msmtp")),
            ..Default::default()
        };
        let paths =
            Arc::new(MailPaths::with(&Env::rooted_at(home.path()), &settings).expect("paths"));

        let base = spawn(Arc::clone(&paths), home.path()).await;

        Some(Self {
            home,
            base,
            client: reqwest::Client::new(),
            paths,
        })
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    pub fn request(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.get(self.url(path)).bearer_auth(TOKEN)
    }

    pub async fn get(&self, path: &str) -> reqwest::Response {
        self.request(path).send().await.expect("request")
    }

    pub async fn anonymous(&self, path: &str) -> reqwest::Response {
        self.client
            .get(self.url(path))
            .send()
            .await
            .expect("request")
    }

    pub async fn with_token(&self, path: &str, token: &str) -> reqwest::Response {
        self.client
            .get(self.url(path))
            .bearer_auth(token)
            .send()
            .await
            .expect("request")
    }

    pub async fn post(&self, path: &str, body: serde_json::Value) -> reqwest::Response {
        self.client
            .post(self.url(path))
            .bearer_auth(TOKEN)
            .json(&body)
            .send()
            .await
            .expect("request")
    }

    pub async fn put(&self, path: &str, body: serde_json::Value) -> reqwest::Response {
        self.client
            .put(self.url(path))
            .bearer_auth(TOKEN)
            .json(&body)
            .send()
            .await
            .expect("request")
    }

    pub fn settings_path(&self) -> PathBuf {
        self.home.path().join(".config/ecr/settings.toml")
    }

    pub fn capture_path(&self) -> PathBuf {
        self.home.path().join("captured")
    }

    pub fn stub_msmtp(&self) -> PathBuf {
        self.write_stub(
            &self.paths.binaries.msmtp,
            "cat > \"$ECR_TEST_CAPTURE\"\necho \"$@\" >> \"$ECR_TEST_CAPTURE\"\n",
        );
        self.capture_path()
    }

    pub fn stub_mbsync(&self, body: &str) {
        self.write_stub(&self.paths.binaries.mbsync, body);
    }

    fn write_stub(&self, path: &Path, body: &str) {
        let script = format!(
            "#!/bin/sh\nECR_TEST_INBOX='{}'\nECR_TEST_CAPTURE='{}'\n{body}",
            self.home.path().join("Mail/main/Inbox").display(),
            self.capture_path().display(),
        );
        std::fs::write(path, script).expect("stub");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
    }
}

async fn spawn(paths: Arc<MailPaths>, _home: &Path) -> String {
    let store = Arc::new(ecr_store::NotmuchStore::new(paths));

    let mut tokens = ecr_server::TokenStore::default();
    tokens.adopt("test", TOKEN);

    let state = ecr_server::AppState::new(store, tokens, false);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");

    tokio::spawn(async move {
        let _ = axum::serve(listener, ecr_server::router(state)).await;
    });

    format!("http://{addr}")
}

fn index(config: &Path) {
    let output = std::process::Command::new("notmuch")
        .arg(format!("--config={}", config.display()))
        .arg("new")
        .arg("--quiet")
        .env("NOTMUCH_CONFIG", config)
        .output()
        .expect("notmuch new");

    assert!(
        output.status.success(),
        "notmuch new failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn fixtures(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(relative)
        .canonicalize()
        .unwrap_or_else(|e| panic!("fixtures/{relative}: {e}"))
}
