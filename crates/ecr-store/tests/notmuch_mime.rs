mod support;

use ecr_core::message::{BodyFormat, Disposition};

#[tokio::test]
async fn a_message_reports_its_parts_from_the_indexed_file() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let message = store
        .message_with_parts(&"mime1@example.com".into())
        .await
        .expect("message");

    assert!(
        message
            .attachments()
            .any(|p| p.filename.as_deref() == Some("report.pdf")),
        "parts: {:#?}",
        message.parts
    );
    assert!(
        message.inline_parts().any(|p| p.is_image()),
        "expected an inline image"
    );
}

#[tokio::test]
async fn the_subject_is_decoded_from_its_mime_encoding() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let message = store
        .message(&"mime1@example.com".into())
        .await
        .expect("message");

    assert_eq!(message.subject, "Hello ☁");
}

#[tokio::test]
async fn an_html_body_is_sanitized_and_its_inline_image_rewritten() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let body = store
        .body(&"mime1@example.com".into(), BodyFormat::Html, false)
        .await
        .expect("body");

    assert_eq!(body.format, BodyFormat::Html);
    assert!(!body.content.contains("<script"), "{}", body.content);
    assert!(
        body.content
            .contains("/api/v1/messages/mime1@example.com/parts/"),
        "{}",
        body.content
    );
    assert_eq!(body.remote_resources_blocked, 1);
}

#[tokio::test]
async fn the_text_alternative_is_served_when_asked_for() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let body = store
        .body(&"mime1@example.com".into(), BodyFormat::Text, false)
        .await
        .expect("body");

    assert_eq!(body.format, BodyFormat::Text);
    assert!(
        body.content.contains("Plain text fallback"),
        "{}",
        body.content
    );
    assert!(!body.content.contains("<b>"), "{}", body.content);
}

#[tokio::test]
async fn a_latin1_message_is_served_as_utf8() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let body = store
        .body(&"mime2@example.com".into(), BodyFormat::Text, false)
        .await
        .expect("body");

    assert!(body.content.contains("Café au lait"), "{}", body.content);
}

#[tokio::test]
async fn an_attachment_downloads_with_its_real_bytes() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let id = "mime1@example.com".into();
    let message = store.message_with_parts(&id).await.expect("message");
    let pdf = message
        .attachments()
        .find(|p| p.filename.as_deref() == Some("report.pdf"))
        .expect("attachment")
        .clone();

    let part = store.part(&id, &pdf.id).await.expect("part");

    assert_eq!(part.meta.content_type, "application/pdf");
    assert_eq!(part.meta.disposition, Disposition::Attachment);
    assert!(part.bytes.starts_with(b"%PDF-1.4"));
}

#[tokio::test]
async fn requesting_a_part_that_does_not_exist_is_an_error() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let result = store
        .part(&"mime1@example.com".into(), &ecr_core::message::PartId(99))
        .await;

    assert!(result.is_err(), "expected an error, got {result:?}");
}

#[tokio::test]
async fn allowing_remote_resources_stops_blocking_them() {
    let fixture = fixture_or_skip!();
    let store = fixture.store();

    let body = store
        .body(&"mime1@example.com".into(), BodyFormat::Html, true)
        .await
        .expect("body");

    assert_eq!(body.remote_resources_blocked, 0);
    assert!(
        body.content.contains("tracker.example.com"),
        "{}",
        body.content
    );
}
