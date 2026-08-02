mod support;

use ecr_core::message::{Query, TagOp, ThreadId};

#[tokio::test]
async fn revision_reports_a_real_database_uuid_and_lastmod() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let revision = store.revision().await.expect("revision");

    assert!(!revision.uuid.is_empty());
    assert!(revision.lastmod > 0, "lastmod was {}", revision.lastmod);
}

const FIXTURE_MESSAGES: usize = 8;
const FIXTURE_THREADS: usize = 6;

#[tokio::test]
async fn counts_every_indexed_fixture_message() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    assert_eq!(
        store.count(&Query::new("*")).await.expect("count"),
        FIXTURE_MESSAGES
    );
    assert_eq!(
        store.count(&Query::new("tag:inbox")).await.expect("count"),
        FIXTURE_MESSAGES
    );
}

#[tokio::test]
async fn search_groups_the_fixtures_into_threads() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let threads = store
        .search_threads(&Query::new("tag:inbox"))
        .await
        .expect("search");

    assert_eq!(threads.len(), FIXTURE_THREADS, "got {threads:#?}");
    assert!(threads.iter().all(|t| t.tags.contains("inbox")));
    assert!(threads.iter().all(|t| t.is_unread()));
}

#[tokio::test]
async fn search_results_are_newest_first() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let threads = store
        .search_threads(&Query::new("*"))
        .await
        .expect("search");

    let timestamps: Vec<i64> = threads.iter().map(|t| t.timestamp).collect();
    let mut sorted = timestamps.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(timestamps, sorted);
}

#[tokio::test]
async fn a_two_message_thread_reports_both_messages() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let threads = store
        .search_threads(&Query::new("subject:\"Thread 1\""))
        .await
        .expect("search");
    let summary = threads.first().expect("a matching thread");

    assert_eq!(summary.total, 2);

    let thread = store.thread(&summary.id).await.expect("thread");
    assert_eq!(thread.messages.len(), 2);
    assert!(thread.messages[0].timestamp <= thread.messages[1].timestamp);
}

#[tokio::test]
async fn a_message_carries_its_parsed_headers_and_tags() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let message = store
        .message(&"msg1@example.com".into())
        .await
        .expect("message");

    assert_eq!(message.subject, "Thread 1 - Message 1");
    assert_eq!(message.from[0].email, "alice@example.com");
    assert_eq!(message.to[0].email, "test@example.com");
    assert!(message.tags.contains("unread"));
    assert!(message.tags.contains("inbox"));
    assert!(message.timestamp > 0);
}

#[tokio::test]
async fn a_missing_message_is_an_error_not_an_empty_result() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let result = store.message(&"nope@example.com".into()).await;

    assert!(result.is_err(), "expected an error, got {result:?}");
}

#[tokio::test]
async fn a_missing_thread_yields_no_messages() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let thread = store
        .thread(&ThreadId::from("ffffffffffffffff"))
        .await
        .expect("thread query should succeed");

    assert!(thread.messages.is_empty());
}

#[tokio::test]
async fn limit_and_offset_page_through_results() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let first = store
        .search_threads(&Query::new("*").limit(2))
        .await
        .expect("page 1");
    let second = store
        .search_threads(&Query::new("*").limit(2).offset(2))
        .await
        .expect("page 2");

    assert_eq!(first.len(), 2);
    assert_eq!(second.len(), 2);
    assert!(first.iter().all(|f| second.iter().all(|s| s.id != f.id)));
}

#[tokio::test]
async fn message_file_resolves_to_a_readable_maildir_path() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let path = store
        .message_file(&"msg1@example.com".into())
        .await
        .expect("message file");

    assert!(path.is_file(), "{} is not a file", path.display());
    let contents = std::fs::read_to_string(&path).expect("read");
    assert!(contents.contains("Thread 1 - Message 1"));
}

#[tokio::test]
async fn tagging_moves_the_revision_forward() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let before = store.revision().await.expect("before");
    let after = store
        .tag(&[TagOp::new("msg1@example.com".into())
            .adding("starred")
            .removing("unread")])
        .await
        .expect("tag");

    assert!(after.supersedes(&before), "{after:?} vs {before:?}");

    let message = store
        .message(&"msg1@example.com".into())
        .await
        .expect("message");
    assert!(message.tags.contains("starred"));
    assert!(!message.tags.contains("unread"));
}

/// What the delivery watcher tells a real delivery from its own tag write by.
/// Dropping `unread` renames the file — notmuch synchronises maildir flags —
/// and that rename reaches the watcher looking exactly like a delivery. The
/// database already carries the new name, so the `notmuch new` that follows
/// has nothing to do and the revision stands still. If that ever stops
/// holding, reading a message announces itself as new mail again and the row
/// being read disappears from every client's list.
#[tokio::test]
async fn reindexing_after_a_tag_write_leaves_the_revision_alone() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let written = store
        .tag(&[TagOp::new("msg1@example.com".into()).removing("unread")])
        .await
        .expect("tag");

    let path = store
        .message_file(&"msg1@example.com".into())
        .await
        .expect("message file");
    assert!(
        path.to_string_lossy().ends_with(":2,S"),
        "the maildir flag was not synchronised: {}",
        path.display()
    );

    assert_eq!(store.index_new().await.expect("index"), written);
}

#[tokio::test]
async fn a_batch_applies_to_several_messages_at_once() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    store
        .tag(&[
            TagOp::new("msg1@example.com".into()).adding("batched"),
            TagOp::new("msg3@example.com".into()).adding("batched"),
        ])
        .await
        .expect("batch tag");

    assert_eq!(
        store
            .count(&Query::new("tag:batched"))
            .await
            .expect("count"),
        2
    );
}

#[tokio::test]
async fn an_empty_tag_batch_is_a_no_op() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let before = store.revision().await.expect("before");
    let after = store.tag(&[]).await.expect("empty batch");

    assert_eq!(before, after);
}

#[tokio::test]
async fn a_malformed_tag_is_rejected_before_reaching_notmuch() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let result = store
        .tag(&[TagOp::new("msg1@example.com".into()).adding("evil\n-inbox -- *")])
        .await;

    assert!(result.is_err(), "expected rejection, got {result:?}");
    assert_eq!(
        store.count(&Query::new("tag:inbox")).await.expect("count"),
        FIXTURE_MESSAGES,
        "the injected line must not have stripped inbox from everything"
    );
}

#[tokio::test]
async fn notmuch_silently_accepts_a_malformed_raw_batch() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let result = store.tag_batch("this is not a valid tag line\n").await;

    assert!(
        result.is_ok(),
        "notmuch tag --batch exits 0 on garbage; validation must happen in ecr-store"
    );
}
