//! The mail index answers instead of notmuch, so the only thing worth
//! asserting is that it answers the *same*. Every test here runs a query both
//! ways against the same database and compares the results field by field.

mod support;

use ecr_core::message::{Query, TagOp, ThreadSummary};
use ecr_store::index::MessageIndex;
use ecr_store::store::MailStore;
use ecr_store::Notmuch;

/// The queries the index claims. `date_relative` is the one field it renders
/// itself rather than mirroring, so it is blanked before comparing — the client
/// formats its own dates from `timestamp`, which is compared.
const CLAIMED: &[&str] = &[
    "*",
    "tag:inbox",
    "tag:unread",
    "tag:inbox and tag:unread",
    "tag:inbox or tag:attachment",
    "tag:inbox -tag:attachment",
    "not tag:attachment",
    "(tag:inbox or tag:unread) and not tag:attachment",
    "tag:nothing-has-this-tag",
    "thread:0000000000000001",
    "id:msg1@example.com",
];

fn comparable(mut threads: Vec<ThreadSummary>) -> Vec<ThreadSummary> {
    for thread in &mut threads {
        thread.date_relative = String::new();
    }
    threads
}

async fn build(fixture: &support::Fixture) -> (ecr_store::NotmuchStore, Notmuch) {
    let store = fixture.notmuch_store();
    store.refresh_index().await.expect("build the index");
    (store, fixture.store())
}

#[tokio::test]
async fn every_claimed_query_answers_exactly_what_notmuch_answers() {
    let fixture = fixture_or_skip!();
    let (store, notmuch) = build(&fixture).await;

    for text in CLAIMED {
        let query = Query::new(*text);

        let indexed = store.search_threads(&query).await.expect("indexed search");
        let direct = notmuch
            .search_threads(&query)
            .await
            .expect("notmuch search");
        assert_eq!(
            comparable(indexed),
            comparable(direct),
            "search disagreed on {text:?}"
        );

        let indexed = store.count(&query).await.expect("indexed count");
        let direct = notmuch.count(&query).await.expect("notmuch count");
        assert_eq!(indexed, direct, "count disagreed on {text:?}");
    }
}

#[tokio::test]
async fn paging_agrees_page_by_page() {
    let fixture = fixture_or_skip!();
    let (store, notmuch) = build(&fixture).await;

    for offset in 0..4 {
        let query = Query::new("*").limit(2).offset(offset);

        let indexed = store.search_threads(&query).await.expect("indexed");
        let direct = notmuch.search_threads(&query).await.expect("notmuch");

        assert_eq!(
            comparable(indexed),
            comparable(direct),
            "page at offset {offset} disagreed"
        );
    }
}

#[tokio::test]
async fn an_excluded_message_is_hidden_the_same_way_by_both() {
    let fixture = fixture_or_skip!();
    let (store, notmuch) = build(&fixture).await;

    // The fixture config excludes `deleted`, and this message shares a thread
    // with another that is not deleted — so the thread survives with one fewer
    // match, which is the case a naive translation gets wrong.
    store
        .tag(&[TagOp::new("msg2@example.com".into()).adding("deleted")])
        .await
        .expect("tag");
    store.refresh_index().await.expect("refresh");

    for text in ["*", "tag:inbox", "tag:deleted"] {
        let query = Query::new(text);

        assert_eq!(
            comparable(store.search_threads(&query).await.expect("indexed")),
            comparable(notmuch.search_threads(&query).await.expect("notmuch")),
            "search disagreed on {text:?} with a deleted message present"
        );
        assert_eq!(
            store.count(&query).await.expect("indexed"),
            notmuch.count(&query).await.expect("notmuch"),
            "count disagreed on {text:?} with a deleted message present"
        );
    }
}

#[tokio::test]
async fn a_tag_write_is_visible_to_the_very_next_read() {
    let fixture = fixture_or_skip!();
    let (store, _) = build(&fixture).await;

    let before = store
        .search_threads(&Query::new("tag:urgent"))
        .await
        .expect("search");
    assert!(before.is_empty());

    store
        .tag(&[TagOp::new("msg1@example.com".into()).adding("urgent")])
        .await
        .expect("tag");

    let after = store
        .search_threads(&Query::new("tag:urgent"))
        .await
        .expect("search");

    assert_eq!(after.len(), 1, "the index served a stale answer");
    assert!(after[0].tags.contains("urgent"));
}

#[tokio::test]
async fn a_query_the_index_declines_is_still_answered() {
    let fixture = fixture_or_skip!();
    let (store, notmuch) = build(&fixture).await;

    // A bare word searches the body and `subject:` searches terms Xapian
    // generated; the index carries neither.
    for text in ["attachment", "subject:thread", "from:alice"] {
        let query = Query::new(text);
        assert_eq!(
            comparable(store.search_threads(&query).await.expect("indexed")),
            comparable(notmuch.search_threads(&query).await.expect("notmuch")),
            "disagreed on {text:?}"
        );
    }
    let query = Query::new("attachment");

    assert_eq!(
        comparable(store.search_threads(&query).await.expect("indexed")),
        comparable(notmuch.search_threads(&query).await.expect("notmuch")),
    );
}

#[tokio::test]
async fn a_batch_of_counts_mixing_both_paths_answers_in_order() {
    let fixture = fixture_or_skip!();
    let (store, notmuch) = build(&fixture).await;

    // `date:` and the bare word are notmuch's; the rest are the index's. The
    // answers still have to line up with the rows that asked for them.
    let queries: Vec<String> = ["tag:inbox", "date:2020-01-01..2020-01-02", "tag:unread", ""]
        .iter()
        .map(|q| q.to_string())
        .collect();

    let indexed = store.count_batch(&queries).await.expect("batch");
    let direct = notmuch.count_batch(&queries).await.expect("batch");

    assert_eq!(indexed, direct);
    assert_eq!(indexed[1], 0);
    assert_eq!(
        indexed[3], 0,
        "a blank query counts nothing, not everything"
    );
}

#[tokio::test]
async fn a_refresh_after_new_mail_only_reads_what_changed() {
    let fixture = fixture_or_skip!();
    let (store, _) = build(&fixture).await;

    let before = store.index_status().expect("an index").messages;

    std::fs::write(
        fixture.inbox().join("cur").join("arrived:2,"),
        "From: new@example.com\nTo: test@example.com\nSubject: Arrived\n\
         Message-ID: <arrived@example.com>\nDate: Wed, 01 Apr 2026 12:00:00 +0000\n\n\
         Body.\n",
    )
    .expect("deliver");

    store.notmuch().index_new().await.expect("notmuch new");
    let refreshed = store
        .refresh_index()
        .await
        .expect("refresh")
        .expect("an index");

    assert!(
        !refreshed.rebuilt,
        "a delivery should not rebuild the index"
    );
    assert_eq!(refreshed.messages, before + 1);

    let found = store
        .search_threads(&Query::new("subject:arrived"))
        .await
        .expect("search");
    assert_eq!(found.len(), 1);
}

#[tokio::test]
async fn a_deleted_message_forces_a_rebuild_rather_than_lingering() {
    let fixture = fixture_or_skip!();
    let (store, _) = build(&fixture).await;

    let path = store
        .notmuch()
        .message_file(&"msg5@example.com".into())
        .await
        .expect("message file");
    std::fs::remove_file(&path).expect("remove");

    store.notmuch().index_new().await.expect("notmuch new");
    let refreshed = store
        .refresh_index()
        .await
        .expect("refresh")
        .expect("an index");

    assert!(refreshed.rebuilt, "a deletion is only visible as a rebuild");
    assert!(store
        .search_threads(&Query::new("id:msg5@example.com"))
        .await
        .expect("search")
        .is_empty());
}

#[tokio::test]
async fn the_index_file_lands_in_the_state_directory() {
    let fixture = fixture_or_skip!();
    let (store, _) = build(&fixture).await;

    let path = MessageIndex::path_for(&fixture.paths);

    assert!(path.is_file(), "{} is not a file", path.display());
    assert!(path.starts_with(&fixture.paths.ecr_state_dir));
    assert_eq!(store.index_status().expect("an index").path, Some(path));
}

#[tokio::test]
async fn turning_the_index_off_leaves_every_answer_unchanged() {
    let fixture = fixture_or_skip!();
    let store = fixture.notmuch_store_without_index();
    let notmuch = fixture.store();

    assert!(store.index_status().is_none());
    assert!(store.refresh_index().await.expect("refresh").is_none());

    for text in ["*", "tag:inbox", "from:alice"] {
        let query = Query::new(text);
        assert_eq!(
            store.search_threads(&query).await.expect("search"),
            notmuch.search_threads(&query).await.expect("search"),
            "disagreed on {text:?} with the index off"
        );
    }
}
