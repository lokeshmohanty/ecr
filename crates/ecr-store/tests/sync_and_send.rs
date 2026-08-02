mod support;

use ecr_core::account::AccountId;
use ecr_core::message::Query;
use ecr_store::store::{MailStore, ProgressSink};
use std::sync::Mutex;

#[derive(Default)]
struct Recorder(Mutex<Vec<String>>);

impl ProgressSink for Recorder {
    fn line(&self, text: &str) {
        self.0.lock().unwrap().push(text.to_string());
    }
}

impl Recorder {
    fn lines(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn sync_delivers_new_mail_and_indexes_it() {
    let fixture = fixture_or_skip!();
    let store = fixture.notmuch_store();
    let progress = Recorder::default();

    let before = store.count(&Query::new("*")).await.expect("count before");

    fixture.stub_mbsync(
        r#"echo "C: 1/1 B: 1/1"
cat > "$ECR_TEST_INBOX/cur/delivered:2," <<'MSG'
From: new@example.com
To: test@example.com
Subject: Delivered by the stub
Message-Id: <delivered@example.com>
Date: Wed, 01 Apr 2026 12:00:00 +0000

Fresh mail.
MSG
"#,
    );

    let report = store
        .sync(&[AccountId::from("main")], &progress)
        .await
        .expect("sync");

    assert_eq!(report.channels, vec!["main"]);
    assert_eq!(report.new_messages, 1);

    let after = store.count(&Query::new("*")).await.expect("count after");
    assert_eq!(after, before + 1);

    let delivered = store
        .message(&"delivered@example.com".into())
        .await
        .expect("the delivered message is indexed");
    assert_eq!(delivered.subject, "Delivered by the stub");
}

#[tokio::test]
async fn sync_streams_progress_lines_as_they_arrive() {
    let fixture = fixture_or_skip!();
    let store = fixture.notmuch_store();
    let progress = Recorder::default();

    fixture.stub_mbsync("echo 'C: 1/2 B: 3/4'\necho 'C: 2/2 B: 4/4'\n");

    store.sync(&[], &progress).await.expect("sync");

    let lines = progress.lines();
    assert!(lines.iter().any(|l| l.contains("C: 1/2")), "{lines:?}");
    assert!(lines.iter().any(|l| l.contains("C: 2/2")), "{lines:?}");
    assert!(
        lines.iter().any(|l| l.contains("indexing new mail")),
        "{lines:?}"
    );
}

#[tokio::test]
async fn a_failing_sync_reports_the_error_output() {
    let fixture = fixture_or_skip!();
    let store = fixture.notmuch_store();
    let progress = Recorder::default();

    fixture.stub_mbsync("echo 'IMAP error: AUTHENTICATE failed' >&2\nexit 1\n");

    let err = store
        .sync(&[], &progress)
        .await
        .expect_err("sync should fail");

    assert!(err.to_string().contains("AUTHENTICATE failed"), "{err}");
}

#[tokio::test]
async fn sync_selects_only_the_channels_for_the_named_accounts() {
    let fixture = fixture_or_skip!();
    let store = fixture.notmuch_store();
    let progress = Recorder::default();

    fixture.stub_mbsync("echo \"args: $@\"\n");

    let report = store
        .sync(&[AccountId::from("main")], &progress)
        .await
        .expect("sync");

    assert_eq!(report.channels, vec!["main"]);
    assert!(
        progress.lines().iter().any(|l| l.contains("main")),
        "{:?}",
        progress.lines()
    );
}

#[tokio::test]
async fn send_pipes_the_message_to_msmtp_for_the_right_account() {
    let fixture = fixture_or_skip!();
    let store = fixture.notmuch_store();

    let captured =
        fixture.stub_msmtp("cat > \"$ECR_TEST_CAPTURE\"\necho \"$@\" >> \"$ECR_TEST_CAPTURE\"\n");

    let raw = b"From: test@example.com\r\nTo: someone@example.com\r\nSubject: Hi\r\n\r\nBody\r\n";
    store
        .send(&AccountId::from("main"), raw)
        .await
        .expect("send");

    let recorded = std::fs::read_to_string(&captured).expect("capture file");
    assert!(recorded.contains("Subject: Hi"), "{recorded}");
    assert!(recorded.contains("--account main"), "{recorded}");
    assert!(recorded.contains("--read-recipients"), "{recorded}");
}

#[tokio::test]
async fn a_failing_send_surfaces_the_msmtp_error() {
    let fixture = fixture_or_skip!();
    let store = fixture.notmuch_store();

    fixture.stub_msmtp("cat >/dev/null\necho 'msmtp: authentication failed' >&2\nexit 1\n");

    let err = store
        .send(&AccountId::from("main"), b"From: a@b.c\r\n\r\nx")
        .await
        .expect_err("send should fail");

    assert!(err.to_string().contains("authentication failed"), "{err}");
}

#[tokio::test]
async fn a_failing_send_appends_the_oauth_authorize_hint() {
    let fixture = fixture_or_skip!();
    let store = fixture.notmuch_store();

    fixture.stub_msmtp("cat >/dev/null\necho 'msmtp: authentication failed' >&2\nexit 1\n");

    let err = store
        .send(&AccountId::from("main"), b"From: a@b.c\r\n\r\nx")
        .await
        .expect_err("send should fail");

    assert!(err.to_string().contains("authentication failed"), "{err}");
    assert!(err.to_string().contains("oauthman authorize main"), "{err}");
}

#[tokio::test]
async fn sending_from_an_unknown_account_is_refused_before_spawning_msmtp() {
    let fixture = fixture_or_skip!();
    let store = fixture.notmuch_store();

    fixture.stub_msmtp("echo 'must not run' >&2\nexit 1\n");

    let err = store
        .send(&AccountId::from("nonexistent"), b"From: a@b.c\r\n\r\nx")
        .await
        .expect_err("send should be refused");

    assert!(err.to_string().contains("nonexistent"), "{err}");
}
