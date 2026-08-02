mod support;

use ecr_server::ServerEvent;
use std::time::Duration;
use support::Server;
use tokio::sync::broadcast::error::RecvError;

/// Long enough to cover the watcher's own debounce and the `notmuch new` that
/// follows it.
const SETTLE: Duration = Duration::from_secs(6);

/// Drains events until one is `mail:changed`, or the time runs out.
async fn mail_changed(events: &mut tokio::sync::broadcast::Receiver<ServerEvent>) -> bool {
    let deadline = tokio::time::Instant::now() + SETTLE;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return false;
        }
        match tokio::time::timeout(left, events.recv()).await {
            Ok(Ok(ServerEvent::MailChanged { .. })) => return true,
            Ok(Ok(_)) => continue,
            Ok(Err(RecvError::Lagged(_))) => continue,
            Ok(Err(RecvError::Closed)) | Err(_) => return false,
        }
    }
}

/// The two halves belong in one test: the delivery is what proves the watcher
/// is live in this environment, without which the silence in the first half
/// would prove nothing.
#[tokio::test]
async fn a_tag_write_is_not_a_delivery_but_a_delivered_file_is() {
    let Some(server) = Server::start_watched().await else {
        return;
    };
    let mut events = server.events();

    let response = server
        .post(
            "/api/v1/tags",
            serde_json::json!({
                "ops": [{"id": "msg1@example.com", "add": [], "remove": ["unread"]}]
            }),
        )
        .await;
    assert_eq!(response.status(), 200);

    // notmuch synchronises maildir flags, so the write renamed the file — the
    // filesystem event the watcher is watching for really did happen.
    let renamed = std::fs::read_dir(server.inbox())
        .expect("inbox")
        .filter_map(Result::ok)
        .any(|entry| entry.file_name().to_string_lossy().ends_with(":2,S"));
    assert!(renamed, "the tag write did not rename any file");

    assert!(
        !mail_changed(&mut events).await,
        "reading a message announced itself as new mail"
    );

    std::fs::write(
        server.inbox().join("delivered:2,"),
        "From: someone@example.com\nTo: test@example.com\n\
         Subject: delivered\nMessage-ID: <delivered@example.com>\n\nhello\n",
    )
    .expect("deliver");

    assert!(
        mail_changed(&mut events).await,
        "a delivered message was not announced"
    );
}
