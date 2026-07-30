mod support;

use serde_json::Value;
use support::Server;

#[tokio::test]
async fn health_is_reachable_without_a_token() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server.anonymous("/api/v1/health").await;
    assert_eq!(response.status(), 200);

    let doctor: Value = response.json().await.unwrap();
    assert!(!doctor["accounts"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn a_protected_route_rejects_a_missing_token() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server.anonymous("/api/v1/accounts").await;

    assert_eq!(response.status(), 401);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"], "unauthorized");
}

#[tokio::test]
async fn a_protected_route_rejects_a_wrong_token() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server.with_token("/api/v1/accounts", "not-the-token").await;
    assert_eq!(response.status(), 401);
}

#[tokio::test]
async fn accounts_lists_the_discovered_account_and_its_folders() {
    let Some(server) = Server::start().await else {
        return;
    };

    let accounts: Value = server.get("/api/v1/accounts").await.json().await.unwrap();
    let main = &accounts.as_array().unwrap()[0];

    assert_eq!(main["id"], "main");
    assert!(!main["folders"].as_array().unwrap().is_empty());
    assert_eq!(main["mbsync_channel"], "main");
}

#[tokio::test]
async fn threads_returns_summaries_with_an_etag() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server.get("/api/v1/threads?q=tag:inbox").await;
    assert_eq!(response.status(), 200);

    let etag = response
        .headers()
        .get("etag")
        .expect("an ETag")
        .to_str()
        .unwrap()
        .to_string();
    assert!(etag.starts_with('"'), "{etag}");

    let page: Value = response.json().await.unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 6);
    assert_eq!(page["total"], 8);
    assert!(page["revision"]["lastmod"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn an_unchanged_revision_returns_304() {
    let Some(server) = Server::start().await else {
        return;
    };

    let first = server.get("/api/v1/threads").await;
    let etag = first
        .headers()
        .get("etag")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();

    let second = server
        .request("/api/v1/threads")
        .header("if-none-match", &etag)
        .send()
        .await
        .unwrap();

    assert_eq!(second.status(), 304);
}

#[tokio::test]
async fn paging_is_honoured() {
    let Some(server) = Server::start().await else {
        return;
    };

    let page: Value = server
        .get("/api/v1/threads?limit=2&offset=1")
        .await
        .json()
        .await
        .unwrap();

    assert_eq!(page["items"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn a_thread_returns_its_messages() {
    let Some(server) = Server::start().await else {
        return;
    };

    let page: Value = server
        .get("/api/v1/threads?q=subject:%22Thread%201%22")
        .await
        .json()
        .await
        .unwrap();
    let id = page["items"][0]["id"].as_str().unwrap().to_string();

    let thread: Value = server
        .get(&format!("/api/v1/threads/{id}"))
        .await
        .json()
        .await
        .unwrap();

    assert_eq!(thread["messages"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn a_missing_thread_is_a_404() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server.get("/api/v1/threads/ffffffffffffffff").await;
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn a_message_reports_its_parts() {
    let Some(server) = Server::start().await else {
        return;
    };

    let message: Value = server
        .get("/api/v1/messages/mime1@example.com")
        .await
        .json()
        .await
        .unwrap();

    assert_eq!(message["subject"], "Hello ☁");
    let parts = message["parts"].as_array().unwrap();
    assert!(parts.iter().any(|p| p["filename"] == "report.pdf"));
}

#[tokio::test]
async fn a_body_is_sanitized_and_blocks_remote_images_by_default() {
    let Some(server) = Server::start().await else {
        return;
    };

    let body: Value = server
        .get("/api/v1/messages/mime1@example.com/body")
        .await
        .json()
        .await
        .unwrap();

    let content = body["content"].as_str().unwrap();
    assert!(!content.contains("<script"), "{content}");
    assert!(content.contains("/parts/"), "{content}");
    assert_eq!(body["remote_resources_blocked"], 1);
}

#[tokio::test]
async fn a_text_body_can_be_requested() {
    let Some(server) = Server::start().await else {
        return;
    };

    let body: Value = server
        .get("/api/v1/messages/mime1@example.com/body?html=false")
        .await
        .json()
        .await
        .unwrap();

    assert_eq!(body["format"], "text");
    assert!(body["content"]
        .as_str()
        .unwrap()
        .contains("Plain text fallback"));
}

#[tokio::test]
async fn an_attachment_downloads_with_its_content_type_and_filename() {
    let Some(server) = Server::start().await else {
        return;
    };

    let message: Value = server
        .get("/api/v1/messages/mime1@example.com")
        .await
        .json()
        .await
        .unwrap();
    let part = message["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["filename"] == "report.pdf")
        .unwrap()["id"]
        .as_u64()
        .unwrap();

    let response = server
        .get(&format!("/api/v1/messages/mime1@example.com/parts/{part}"))
        .await;

    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "application/pdf");
    assert!(response.headers()["content-disposition"]
        .to_str()
        .unwrap()
        .contains("report.pdf"));

    let bytes = response.bytes().await.unwrap();
    assert!(bytes.starts_with(b"%PDF-1.4"));
}

#[tokio::test]
async fn a_missing_part_is_a_404() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server
        .get("/api/v1/messages/mime1@example.com/parts/99")
        .await;
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn tagging_updates_the_revision_and_the_message() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server
        .post(
            "/api/v1/tags",
            serde_json::json!({
                "ops": [{"id": "msg1@example.com", "add": ["starred"], "remove": ["unread"]}]
            }),
        )
        .await;
    assert_eq!(response.status(), 200);

    let message: Value = server
        .get("/api/v1/messages/msg1@example.com")
        .await
        .json()
        .await
        .unwrap();
    let tags = message["tags"].as_array().unwrap();

    assert!(tags.iter().any(|t| t == "starred"));
    assert!(!tags.iter().any(|t| t == "unread"));
}

#[tokio::test]
async fn a_tag_containing_a_newline_is_a_400() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server
        .post(
            "/api/v1/tags",
            serde_json::json!({
                "ops": [{"id": "msg1@example.com", "add": ["evil\n-inbox -- *"], "remove": []}]
            }),
        )
        .await;

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn sending_from_an_unknown_account_is_a_400() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server
        .post(
            "/api/v1/send",
            serde_json::json!({
                "account": "nope",
                "to": ["someone@example.com"],
                "subject": "Hi",
                "body": "Hello"
            }),
        )
        .await;

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn a_draft_with_no_recipients_is_a_400() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server
        .post(
            "/api/v1/send",
            serde_json::json!({"account": "main", "subject": "Hi", "body": "Hello"}),
        )
        .await;

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn sending_delivers_the_message_to_msmtp() {
    let Some(server) = Server::start().await else {
        return;
    };
    let captured = server.stub_msmtp();

    let response = server
        .post(
            "/api/v1/send",
            serde_json::json!({
                "account": "main",
                "to": ["someone@example.com"],
                "subject": "Hello from ecr",
                "body": "Body text"
            }),
        )
        .await;

    assert_eq!(response.status(), 200, "{:?}", response.text().await);

    let sent = std::fs::read_to_string(&captured).unwrap();
    assert!(sent.contains("Subject: Hello from ecr"), "{sent}");
    assert!(sent.contains("someone@example.com"), "{sent}");
    assert!(sent.contains("--account main"), "{sent}");
}

#[tokio::test]
async fn cross_origin_requests_are_allowed_by_default() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = reqwest::Client::new()
        .get(server.url("/api/v1/health"))
        .header("origin", "http://some-other-host:4199")
        .send()
        .await
        .unwrap();

    assert_eq!(
        response
            .headers()
            .get("access-control-allow-origin")
            .map(|v| v.to_str().unwrap()),
        Some("*"),
        "a hardcoded origin list breaks every real deployment; auth is the bearer token"
    );
}

#[tokio::test]
async fn a_preflight_permits_the_authorization_header() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = reqwest::Client::new()
        .request(reqwest::Method::OPTIONS, server.url("/api/v1/threads"))
        .header("origin", "http://some-other-host:4199")
        .header("access-control-request-method", "GET")
        .header("access-control-request-headers", "authorization")
        .send()
        .await
        .unwrap();

    let allowed = response
        .headers()
        .get("access-control-allow-headers")
        .map(|v| v.to_str().unwrap().to_lowercase())
        .unwrap_or_default();

    assert!(allowed.contains("authorization"), "got {allowed:?}");
}
