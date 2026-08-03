use super::*;
use ecr_core::message::{Address, MessageId};

fn message(id: &str, thread: &str, timestamp: i64, subject: &str, tags: &[&str]) -> Message {
    Message {
        id: MessageId::from(id),
        thread_id: ThreadId::from(thread),
        subject: subject.to_string(),
        from: vec![Address::new(None, format!("{id}@example.com"))],
        to: vec![Address::new(None, "reader@example.com")],
        cc: Vec::new(),
        bcc: Vec::new(),
        reply_to: Vec::new(),
        date: String::new(),
        timestamp,
        tags: tags.iter().map(|t| t.to_string()).collect(),
        in_reply_to: None,
        references: Vec::new(),
        parts: Vec::new(),
        excluded: false,
    }
}

fn index(exclude: &[&str]) -> MessageIndex {
    MessageIndex::in_memory(exclude.iter().map(|t| t.to_string()).collect()).expect("open")
}

fn load(index: &MessageIndex, messages: &[Message]) {
    index
        .apply(messages, &Revision::new("uuid", 1))
        .expect("apply");
}

fn threads(index: &MessageIndex, query: &str) -> Vec<ThreadSummary> {
    index
        .search_threads(&Query::new(query))
        .expect("search")
        .expect("the index can answer this")
}

#[test]
fn a_thread_reports_a_subject_and_its_newest_matched_message() {
    let index = index(&[]);
    load(
        &index,
        &[
            message("a", "t1", 100, "Original", &["inbox"]),
            message("b", "t1", 200, "Re: Original", &["inbox"]),
        ],
    );

    let found = threads(&index, "tag:inbox");

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].subject, "Original");
    // From "Re: Original", the newest matched, not from the older message that
    // happens to carry the same words.
    assert_eq!(found[0].timestamp, 200);
    assert_eq!(found[0].matched, 2);
    assert_eq!(found[0].total, 2);
    assert_eq!(
        found[0].newest_message.as_ref().map(|m| m.as_str()),
        Some("b")
    );
}

/// The fixtures hid this: their reply is `Re: <the first subject>`, so every
/// candidate rule produces the same string. On real mail they do not.
#[test]
fn the_thread_subject_keeps_its_reply_prefix_off() {
    let index = index(&[]);
    load(
        &index,
        &[
            message("a", "t1", 100, "Re: Original", &["inbox"]),
            message("b", "t1", 200, "Re: Original", &["inbox"]),
        ],
    );

    assert_eq!(threads(&index, "tag:inbox")[0].subject, "Original");
}

/// The subject is the *newest matched* message's, so a query that excludes the
/// newest message renames the thread — notmuch's own behaviour, and the reason
/// this cannot be precomputed per thread.
#[test]
fn the_subject_comes_from_the_newest_matched_message() {
    let index = index(&[]);
    load(
        &index,
        &[
            message(
                "a",
                "t1",
                100,
                "The original subject",
                &["inbox", "flagged"],
            ),
            message("b", "t1", 200, "A renamed reply", &["inbox"]),
        ],
    );

    assert_eq!(threads(&index, "tag:inbox")[0].subject, "A renamed reply");
    assert_eq!(
        threads(&index, "tag:flagged")[0].subject,
        "The original subject"
    );
}

#[test]
fn exactly_one_leading_re_is_removed_and_nothing_else_is() {
    for (raw, expected) in [
        ("Re: hello", "hello"),
        ("RE: hello", "hello"),
        ("re: hello", "hello"),
        ("Undeliverable: Re: hello", "Undeliverable: Re: hello"),
        ("Re:hello", "Re:hello"),
        ("hello", "hello"),
        // Once, never repeatedly.
        ("Re: Re: hello", "Re: hello"),
    ] {
        assert_eq!(thread_subject(raw), expected, "on {raw:?}");
    }
}

/// notmuch hands the header through as it found it. Tidying a folded or padded
/// subject here would be an improvement that makes the two paths disagree.
#[test]
fn a_subject_is_not_tidied_up() {
    assert_eq!(
        thread_subject("\r\n Official invitation"),
        "\r\n Official invitation"
    );
    assert_eq!(thread_subject("padded  "), "padded  ");
}

/// A display name with a comma in it cannot survive notmuch's author string,
/// and the index goes through that same rendering on purpose — so that both
/// paths are wrong in the same way rather than disagreeing.
#[test]
fn an_author_name_containing_a_comma_splits_the_way_notmuch_makes_it_split() {
    let index = index(&[]);
    let mut message = message("a", "t1", 100, "Receipt", &["inbox"]);
    message.from = vec![Address::new(
        Some("Anthropic, PBC".into()),
        "billing@example.com",
    )];
    load(&index, &[message]);

    assert_eq!(
        threads(&index, "tag:inbox")[0].authors,
        vec!["Anthropic", "PBC"]
    );
}

#[test]
fn an_unmatched_message_still_counts_toward_the_total() {
    let index = index(&[]);
    load(
        &index,
        &[
            message("a", "t1", 100, "Original", &["inbox"]),
            message("b", "t1", 200, "Re: Original", &["inbox", "flagged"]),
        ],
    );

    let found = threads(&index, "tag:flagged");

    assert_eq!(found[0].matched, 1);
    assert_eq!(found[0].total, 2);
    assert_eq!(found[0].timestamp, 200);
}

#[test]
fn thread_tags_are_the_union_over_the_whole_thread() {
    let index = index(&[]);
    load(
        &index,
        &[
            message("a", "t1", 100, "Original", &["inbox"]),
            message("b", "t1", 200, "Re: Original", &["inbox", "flagged"]),
        ],
    );

    let found = threads(&index, "tag:inbox");

    assert!(found[0].tags.contains("flagged"), "{:?}", found[0].tags);
}

#[test]
fn matched_authors_come_before_the_rest() {
    let index = index(&[]);
    load(
        &index,
        &[
            message("a", "t1", 100, "Original", &["inbox"]),
            message("b", "t1", 200, "Re: Original", &["inbox", "flagged"]),
        ],
    );

    let found = threads(&index, "tag:flagged");

    assert_eq!(found[0].authors, vec!["b@example.com", "a@example.com"]);
}

#[test]
fn threads_come_back_newest_first() {
    let index = index(&[]);
    load(
        &index,
        &[
            message("a", "t1", 100, "One", &["inbox"]),
            message("b", "t2", 300, "Two", &["inbox"]),
            message("c", "t3", 200, "Three", &["inbox"]),
        ],
    );

    let subjects: Vec<String> = threads(&index, "tag:inbox")
        .into_iter()
        .map(|t| t.subject)
        .collect();

    assert_eq!(subjects, vec!["Two", "Three", "One"]);
}

#[test]
fn an_excluded_message_is_not_matched_but_its_thread_survives() {
    let index = index(&["deleted"]);
    load(
        &index,
        &[
            message("a", "t1", 100, "Original", &["inbox"]),
            message("b", "t1", 200, "Re: Original", &["inbox", "deleted"]),
        ],
    );

    let found = threads(&index, "tag:inbox");

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].matched, 1);
    assert_eq!(found[0].total, 2);
    assert_eq!(found[0].timestamp, 100);
    assert!(found[0].tags.contains("deleted"));
}

#[test]
fn a_thread_of_nothing_but_excluded_messages_disappears() {
    let index = index(&["deleted"]);
    load(&index, &[message("a", "t1", 100, "Gone", &["deleted"])]);

    assert!(threads(&index, "tag:inbox").is_empty());
    assert_eq!(index.count("*").expect("count"), Some(0));
}

#[test]
fn naming_the_excluded_tag_asks_for_it() {
    let index = index(&["deleted"]);
    load(&index, &[message("a", "t1", 100, "Gone", &["deleted"])]);

    assert_eq!(threads(&index, "tag:deleted").len(), 1);
    assert_eq!(index.count("tag:deleted").expect("count"), Some(1));
}

/// The count and the page are the same predicate written two ways, so a
/// disagreement is a mistranslation in one of them — and it surfaces as a list
/// whose total does not match what is in it.
#[test]
fn the_two_query_shapes_agree_on_what_matches() {
    let index = index(&["deleted"]);
    load(
        &index,
        &[
            message("a", "t1", 100, "One", &["inbox"]),
            message("b", "t1", 200, "Two", &["inbox", "flagged"]),
            message("c", "t2", 300, "Three", &["inbox", "deleted"]),
            message("d", "t3", 400, "Four", &["archive"]),
        ],
    );

    for query in [
        "*",
        "tag:inbox",
        "tag:inbox and tag:flagged",
        "tag:inbox or tag:archive",
        "tag:inbox -tag:flagged",
        "not tag:inbox",
    ] {
        let counted = index.count(query).expect("count").expect("answered") as usize;
        let paged: usize = threads(&index, query).iter().map(|t| t.matched).sum();

        assert_eq!(counted, paged, "the shapes disagreed on {query:?}");
    }
}

#[test]
fn counts_are_of_messages_not_threads() {
    let index = index(&[]);
    load(
        &index,
        &[
            message("a", "t1", 100, "One", &["inbox"]),
            message("b", "t1", 200, "Two", &["inbox"]),
        ],
    );

    assert_eq!(index.count("tag:inbox").expect("count"), Some(2));
    assert_eq!(threads(&index, "tag:inbox").len(), 1);
}

#[test]
fn a_query_the_index_cannot_answer_is_declined() {
    let index = index(&[]);
    load(&index, &[message("a", "t1", 100, "One", &["inbox"])]);

    assert_eq!(index.count("date:today").expect("count"), None);
    assert!(index
        .search_threads(&Query::new("invoice"))
        .expect("search")
        .is_none());
}

/// The index holds no words at all, so a text search never reaches it.
#[test]
fn a_header_search_goes_to_notmuch() {
    let index = index(&[]);
    let mut message = message("a", "t1", 100, "Quarterly report", &["inbox"]);
    message.from = vec![Address::new(
        Some("Alice Smith".into()),
        "alice@example.com",
    )];
    load(&index, &[message]);

    assert_eq!(index.count("subject:quarterly").expect("count"), None);
    assert!(index
        .search_threads(&Query::new("from:alice"))
        .expect("search")
        .is_none());
}

#[test]
fn a_re_indexed_message_replaces_what_was_there() {
    let index = index(&[]);
    load(&index, &[message("a", "t1", 100, "Before", &["inbox"])]);
    load(&index, &[message("a", "t1", 100, "After", &["archive"])]);

    assert_eq!(index.message_count().expect("count"), 1);
    assert!(threads(&index, "tag:inbox").is_empty());
    assert_eq!(threads(&index, "tag:archive")[0].subject, "After");
}

#[test]
fn the_page_is_the_limit_and_the_offset() {
    let index = index(&[]);
    let messages: Vec<Message> = (0..5)
        .map(|i| {
            message(
                &format!("m{i}"),
                &format!("t{i}"),
                100 + i as i64,
                "Subject",
                &["inbox"],
            )
        })
        .collect();
    load(&index, &messages);

    let page = index
        .search_threads(&Query::new("tag:inbox").limit(2).offset(1))
        .expect("search")
        .expect("answered");

    assert_eq!(page.len(), 2);
    assert_eq!(page[0].timestamp, 103);
    assert_eq!(page[1].timestamp, 102);
}

#[test]
fn the_revision_survives_a_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("index.sqlite3");

    let index = MessageIndex::open_at(&path, Vec::new()).expect("open");
    index
        .apply(
            &[message("a", "t1", 100, "One", &["inbox"])],
            &Revision::new("uuid", 7),
        )
        .expect("apply");
    drop(index);

    let reopened = MessageIndex::open_at(&path, Vec::new()).expect("reopen");

    assert_eq!(
        reopened.revision().expect("revision"),
        Some(Revision::new("uuid", 7))
    );
    assert_eq!(reopened.message_count().expect("count"), 1);
}

#[test]
fn a_database_from_another_schema_is_discarded_rather_than_read() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("index.sqlite3");

    let conn = rusqlite::Connection::open(&path).expect("open");
    conn.execute_batch("CREATE TABLE messages (nonsense TEXT);")
        .expect("write a foreign schema");
    drop(conn);

    let index = MessageIndex::open_at(&path, Vec::new()).expect("open");
    load(&index, &[message("a", "t1", 100, "One", &["inbox"])]);

    assert_eq!(threads(&index, "tag:inbox").len(), 1);
}
