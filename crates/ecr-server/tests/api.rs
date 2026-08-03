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

#[tokio::test]
async fn the_settings_file_starts_out_absent_but_readable() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server.get("/api/v1/config").await;
    assert_eq!(response.status(), 200);

    let body: serde_json::Value = response.json().await.expect("json");
    assert_eq!(body["raw"], "");
    assert!(
        body["path"]
            .as_str()
            .expect("path")
            .ends_with("settings.toml"),
        "{body}"
    );
}

#[tokio::test]
async fn settings_survive_a_write_and_a_read() {
    let Some(server) = Server::start().await else {
        return;
    };

    let raw = "[reading]\nprefer_html = false\n";
    let response = server
        .put("/api/v1/config", serde_json::json!({ "raw": raw }))
        .await;
    assert_eq!(response.status(), 200);

    let body: serde_json::Value = server
        .get("/api/v1/config")
        .await
        .json()
        .await
        .expect("json");
    assert_eq!(body["raw"], raw);
}

#[tokio::test]
async fn the_settings_directory_is_created_on_demand() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server
        .put(
            "/api/v1/config",
            serde_json::json!({ "raw": "[general]\n" }),
        )
        .await;
    assert_eq!(response.status(), 200);

    let path = server.settings_path();
    assert!(path.exists(), "{} was not written", path.display());
}

#[tokio::test]
async fn a_settings_file_that_is_not_toml_is_rejected_with_its_line() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server
        .put(
            "/api/v1/config",
            serde_json::json!({ "raw": "[general]\nstart_query =\n" }),
        )
        .await;
    assert_eq!(response.status(), 422);

    let body: serde_json::Value = response.json().await.expect("json");
    assert_eq!(body["line"], 2, "{body}");
}

#[tokio::test]
async fn a_rejected_settings_file_does_not_replace_the_good_one() {
    let Some(server) = Server::start().await else {
        return;
    };

    let good = "[reading]\nprefer_html = true\n";
    server
        .put("/api/v1/config", serde_json::json!({ "raw": good }))
        .await;
    server
        .put(
            "/api/v1/config",
            serde_json::json!({ "raw": "not = = toml" }),
        )
        .await;

    let body: serde_json::Value = server
        .get("/api/v1/config")
        .await
        .json()
        .await
        .expect("json");
    assert_eq!(body["raw"], good);
}

#[tokio::test]
async fn counts_answer_every_query_in_the_order_asked() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server
        .post(
            "/api/v1/counts",
            serde_json::json!({
                "queries": ["tag:inbox", "tag:__nothing_matches_this__", "*"]
            }),
        )
        .await;
    assert_eq!(response.status(), 200);

    let body: serde_json::Value = response.json().await.expect("json");
    let counts = body["counts"].as_array().expect("counts");
    assert_eq!(counts.len(), 3, "{body}");

    let inbox = counts[0].as_u64().expect("a number");
    let nothing = counts[1].as_u64().expect("a number");
    let all = counts[2].as_u64().expect("a number");

    assert!(inbox > 0, "the fixture inbox is not empty: {body}");
    assert_eq!(nothing, 0, "{body}");
    assert!(all >= inbox, "{body}");
}

#[tokio::test]
async fn a_count_matches_the_threads_the_same_query_returns() {
    let Some(server) = Server::start().await else {
        return;
    };

    let counted: serde_json::Value = server
        .post(
            "/api/v1/counts",
            serde_json::json!({ "queries": ["tag:inbox"] }),
        )
        .await
        .json()
        .await
        .expect("json");

    // count is messages, so compare against the message total the list reports
    // rather than the number of threads.
    let listed: serde_json::Value = server
        .get("/api/v1/threads?q=tag:inbox&limit=500")
        .await
        .json()
        .await
        .expect("json");

    let total: u64 = listed["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|t| t["total"].as_u64().unwrap_or(0))
        .sum();

    assert_eq!(counted["counts"][0].as_u64(), Some(total), "{counted}");
}

#[tokio::test]
async fn an_empty_query_list_is_answered_with_an_empty_list() {
    let Some(server) = Server::start().await else {
        return;
    };

    let body: serde_json::Value = server
        .post("/api/v1/counts", serde_json::json!({ "queries": [] }))
        .await
        .json()
        .await
        .expect("json");

    assert_eq!(body["counts"].as_array().map(Vec::len), Some(0));
}

#[tokio::test]
async fn a_blank_query_counts_nothing_rather_than_everything() {
    let Some(server) = Server::start().await else {
        return;
    };

    let body: serde_json::Value = server
        .post(
            "/api/v1/counts",
            serde_json::json!({ "queries": ["", "   "] }),
        )
        .await
        .json()
        .await
        .expect("json");

    assert_eq!(body["counts"][0].as_u64(), Some(0), "{body}");
    assert_eq!(body["counts"][1].as_u64(), Some(0), "{body}");
}

#[tokio::test]
async fn too_many_queries_are_refused_rather_than_run() {
    let Some(server) = Server::start().await else {
        return;
    };

    let queries: Vec<String> = (0..201).map(|i| format!("tag:t{i}")).collect();
    let response = server
        .post("/api/v1/counts", serde_json::json!({ "queries": queries }))
        .await;

    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn counts_are_protected_by_the_same_token_as_everything_else() {
    let Some(server) = Server::start().await else {
        return;
    };

    assert_eq!(server.anonymous("/api/v1/counts").await.status(), 401);
}

#[tokio::test]
async fn the_shipped_presets_appear_on_first_listing() {
    let Some(server) = Server::start().await else {
        return;
    };

    let body: serde_json::Value = server
        .get("/api/v1/themes")
        .await
        .json()
        .await
        .expect("json");

    let presets = body["presets"].as_array().expect("presets");
    assert_eq!(presets.len(), 10, "{body}");

    let paths: Vec<&str> = presets.iter().filter_map(|p| p["path"].as_str()).collect();
    assert!(paths.contains(&"themes/ecr-dark.toml"), "{paths:?}");
    assert!(paths.contains(&"themes/tokyonight.toml"), "{paths:?}");
    assert!(presets.iter().all(|p| p["builtin"] == true), "{body}");
}

#[tokio::test]
async fn a_theme_reads_back_the_file_its_link_names() {
    let Some(server) = Server::start().await else {
        return;
    };

    server.get("/api/v1/themes").await;

    let body: serde_json::Value = server
        .get("/api/v1/theme?path=themes/nord.toml")
        .await
        .json()
        .await
        .expect("json");

    assert!(
        body["raw"].as_str().expect("raw").contains("#2e3440"),
        "{body}"
    );
}

/// The client asks for the theme the default setting names before anything asks
/// for the listing, so seeding only there answered 404 for the palette ecr
/// ships with until the settings page had been opened once.
#[tokio::test]
async fn the_default_theme_reads_without_a_listing_first() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server.get("/api/v1/theme?path=themes/ecr-dark.toml").await;
    assert_eq!(response.status(), 200);

    let body: serde_json::Value = response.json().await.expect("json");
    assert!(
        body["raw"].as_str().expect("raw").contains("name ="),
        "{body}"
    );
}

#[tokio::test]
async fn a_theme_link_cannot_read_outside_the_config_dir() {
    let Some(server) = Server::start().await else {
        return;
    };

    for attempt in [
        "../../../etc/passwd.toml",
        "themes/../../../secrets.toml",
        "/etc/passwd.toml",
        "themes/nord.conf",
    ] {
        let response = server.get(&format!("/api/v1/theme?path={attempt}")).await;
        assert_eq!(response.status(), 400, "{attempt} was not rejected");
    }
}

#[tokio::test]
async fn a_theme_write_cannot_escape_the_config_dir() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server
        .put(
            "/api/v1/theme",
            serde_json::json!({ "path": "../../../tmp/pwned.toml", "raw": "name = \"x\"\n" }),
        )
        .await;
    assert_eq!(response.status(), 400);
    assert!(!std::path::Path::new("/tmp/pwned.toml").exists());
}

#[tokio::test]
async fn an_edited_theme_survives_a_write_and_a_read() {
    let Some(server) = Server::start().await else {
        return;
    };

    let raw = "name = \"Mine\"\ncolor_scheme = \"light\"\n\n[colors]\npaper = \"#ffffff\"\n";
    let response = server
        .put(
            "/api/v1/theme",
            serde_json::json!({ "path": "themes/mine.toml", "raw": raw }),
        )
        .await;
    assert_eq!(response.status(), 200);

    let body: serde_json::Value = server
        .get("/api/v1/theme?path=themes/mine.toml")
        .await
        .json()
        .await
        .expect("json");
    assert_eq!(body["raw"], raw);

    let listing: serde_json::Value = server
        .get("/api/v1/themes")
        .await
        .json()
        .await
        .expect("json");
    let mine = listing["presets"]
        .as_array()
        .expect("presets")
        .iter()
        .find(|p| p["path"] == "themes/mine.toml")
        .expect("the written theme is listed");
    assert_eq!(mine["name"], "Mine");
    assert_eq!(mine["builtin"], false);
}

#[tokio::test]
async fn a_theme_that_is_not_toml_is_rejected_with_its_line() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server
        .put(
            "/api/v1/theme",
            serde_json::json!({ "path": "themes/bad.toml", "raw": "name =\n" }),
        )
        .await;
    assert_eq!(response.status(), 422);

    let body: serde_json::Value = response.json().await.expect("json");
    assert_eq!(body["line"], 1, "{body}");
}

#[tokio::test]
async fn a_missing_theme_is_a_not_found_rather_than_an_empty_palette() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = server.get("/api/v1/theme?path=themes/nope.toml").await;
    assert_eq!(response.status(), 404);
}

#[tokio::test]
async fn themes_are_protected_by_the_same_token_as_everything_else() {
    let Some(server) = Server::start().await else {
        return;
    };

    assert_eq!(server.anonymous("/api/v1/themes").await.status(), 401);
}

#[tokio::test]
async fn settings_are_protected_by_the_same_token_as_everything_else() {
    let Some(server) = Server::start().await else {
        return;
    };

    assert_eq!(server.anonymous("/api/v1/config").await.status(), 401);
}

#[tokio::test]
async fn a_browser_may_preflight_a_settings_write() {
    let Some(server) = Server::start().await else {
        return;
    };

    let response = reqwest::Client::new()
        .request(reqwest::Method::OPTIONS, server.url("/api/v1/config"))
        .header("origin", "http://127.0.0.1:4199")
        .header("access-control-request-method", "PUT")
        .send()
        .await
        .unwrap();

    let allowed = response
        .headers()
        .get("access-control-allow-methods")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default();

    assert!(
        allowed.contains("PUT"),
        "the settings file is written with PUT; the preflight allowed only {allowed}"
    );
}
