use crate::error::{Error, Result};
use ecr_core::message::{Body, BodyFormat, Disposition, Part, PartId, PartMeta};
use mail_parser::{MessageParser, MessagePart, MimeHeaders, PartType};

pub struct ParsedMessage {
    parts: Vec<StoredPart>,
    html: Option<String>,
    text: Option<String>,
}

struct StoredPart {
    meta: PartMeta,
    bytes: Vec<u8>,
}

pub fn parse(id: &str, raw: &[u8]) -> Result<ParsedMessage> {
    let parsed = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| Error::MessageParse {
            id: id.to_string(),
            message: "not a well-formed RFC 5322 message".to_string(),
        })?;

    let html = parsed.body_html(0).map(|c| c.into_owned());
    let text = parsed.body_text(0).map(|c| c.into_owned());

    let mut parts = Vec::new();
    for (index, part) in parsed.parts.iter().enumerate() {
        if part.is_multipart() {
            continue;
        }
        if let Some(stored) = store_part(index as u32, part) {
            parts.push(stored);
        }
    }

    Ok(ParsedMessage { parts, html, text })
}

fn store_part(index: u32, part: &MessagePart<'_>) -> Option<StoredPart> {
    let content_type = part
        .content_type()
        .map(|ct| match ct.subtype() {
            Some(sub) => format!("{}/{}", ct.ctype(), sub),
            None => ct.ctype().to_string(),
        })
        .unwrap_or_else(|| default_content_type(part).to_string());

    let content_id = part
        .content_id()
        .map(|id| id.trim_matches(['<', '>']).to_string());

    let is_attachment = part
        .content_disposition()
        .is_some_and(|d| d.ctype().eq_ignore_ascii_case("attachment"));

    let bytes = match &part.body {
        PartType::Text(text) | PartType::Html(text) => text.as_bytes().to_vec(),
        PartType::Binary(data) | PartType::InlineBinary(data) => data.to_vec(),
        PartType::Message(_) | PartType::Multipart(_) => return None,
    };

    Some(StoredPart {
        meta: PartMeta {
            id: PartId(index),
            size: bytes.len(),
            content_type,
            filename: part.attachment_name().map(str::to_string),
            disposition: if is_attachment {
                Disposition::Attachment
            } else {
                Disposition::Inline
            },
            content_id,
        },
        bytes,
    })
}

fn default_content_type(part: &MessagePart<'_>) -> &'static str {
    match &part.body {
        PartType::Html(_) => "text/html",
        PartType::Text(_) => "text/plain",
        _ => "application/octet-stream",
    }
}

impl ParsedMessage {
    pub fn parts(&self) -> Vec<PartMeta> {
        self.parts.iter().map(|p| p.meta.clone()).collect()
    }

    pub fn part(&self, id: &PartId) -> Option<Part> {
        self.parts.iter().find(|p| &p.meta.id == id).map(|p| Part {
            meta: p.meta.clone(),
            bytes: p.bytes.clone(),
        })
    }

    pub fn part_by_content_id(&self, content_id: &str) -> Option<&PartMeta> {
        self.parts
            .iter()
            .find(|p| p.meta.content_id.as_deref() == Some(content_id))
            .map(|p| &p.meta)
    }

    pub fn text(&self) -> Option<&str> {
        self.text.as_deref()
    }

    pub fn html(&self) -> Option<&str> {
        self.html.as_deref()
    }

    pub fn body(&self, format: BodyFormat, ctx: &SanitizeContext) -> Body {
        match format {
            BodyFormat::Text => Body {
                format: BodyFormat::Text,
                content: self.text.clone().unwrap_or_default(),
                remote_resources_blocked: 0,
            },
            BodyFormat::Html => match &self.html {
                Some(html) => sanitize(html, self, ctx),
                None => Body {
                    format: BodyFormat::Text,
                    content: self.text.clone().unwrap_or_default(),
                    remote_resources_blocked: 0,
                },
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct SanitizeContext {
    pub part_url_prefix: String,
    pub allow_remote_resources: bool,
}

impl SanitizeContext {
    pub fn new(part_url_prefix: impl Into<String>, allow_remote_resources: bool) -> Self {
        Self {
            part_url_prefix: part_url_prefix.into(),
            allow_remote_resources,
        }
    }
}

fn sanitize(html: &str, message: &ParsedMessage, ctx: &SanitizeContext) -> Body {
    let rewritten = rewrite_cid_references(html, message, ctx);
    let (stripped, blocked) = if ctx.allow_remote_resources {
        (rewritten, 0)
    } else {
        strip_remote_resources(&rewritten)
    };

    let cleaned = sanitizer().clean(&stripped).to_string();

    Body {
        format: BodyFormat::Html,
        content: cleaned,
        remote_resources_blocked: blocked,
    }
}

/// ammonia's default allowlist is written for user comments, not for mail.
/// It drops `<table>`, `<style>`, width/height/align and the inline colours
/// that almost every real message is built from, which is why messages came
/// out as unstyled runs of text. Layout and presentation are allowed back in;
/// what stays banned is anything that can execute or navigate on its own.
fn sanitizer() -> ammonia::Builder<'static> {
    let mut builder = ammonia::Builder::default();

    builder
        .add_tags([
            "table",
            "thead",
            "tbody",
            "tfoot",
            "tr",
            "td",
            "th",
            "caption",
            "colgroup",
            "col",
            "center",
            "font",
            "style",
            "span",
            "div",
            "section",
            "article",
            "header",
            "footer",
            "figure",
            "figcaption",
            "picture",
            "source",
            "map",
            "area",
            "big",
            "small",
            "s",
            "strike",
            "u",
            "address",
        ])
        .add_generic_attributes([
            "style",
            "align",
            "valign",
            "width",
            "height",
            "bgcolor",
            "color",
            "background",
            "border",
            "cellpadding",
            "cellspacing",
            "colspan",
            "rowspan",
            "face",
            "size",
            "dir",
            "lang",
            "title",
            "class",
            "id",
        ])
        .add_tag_attributes("img", ["srcset", "sizes", "loading", "usemap"])
        .add_tag_attributes("a", ["target"])
        .add_tag_attributes("table", ["summary"])
        // Keeping <style> means keeping its contents; ammonia strips the text
        // of unknown tags otherwise, which leaves a stylesheet-shaped hole.
        .clean_content_tags(std::collections::HashSet::from([
            "script", "iframe", "object", "embed", "applet", "form", "title",
        ]))
        .link_rel(Some("noopener noreferrer"))
        .url_relative(ammonia::UrlRelative::PassThrough);

    builder
}

fn rewrite_cid_references(html: &str, message: &ParsedMessage, ctx: &SanitizeContext) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;

    while let Some(pos) = rest.find("cid:") {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 4..];
        let end = after
            .find(|c: char| c == '"' || c == '\'' || c.is_whitespace() || c == '>')
            .unwrap_or(after.len());
        let cid = &after[..end];

        match message.part_by_content_id(cid) {
            Some(meta) => {
                out.push_str(&ctx.part_url_prefix);
                out.push_str(&meta.id.to_string());
            }
            None => {
                out.push_str("cid:");
                out.push_str(cid);
            }
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

fn strip_remote_resources(html: &str) -> (String, usize) {
    let mut out = String::with_capacity(html.len());
    let mut blocked = 0;
    let mut rest = html;

    while let Some(pos) = rest.find("<img") {
        let tag_end = match rest[pos..].find('>') {
            Some(end) => pos + end + 1,
            None => break,
        };
        let tag = &rest[pos..tag_end];

        out.push_str(&rest[..pos]);
        if tag.contains("src=\"http") || tag.contains("src='http") {
            blocked += 1;
        } else {
            out.push_str(tag);
        }
        rest = &rest[tag_end..];
    }
    out.push_str(rest);
    (out, blocked)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/mime")
            .join(name);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
    }

    fn related() -> ParsedMessage {
        parse("mime1@example.com", &fixture("multipart_related.eml")).unwrap()
    }

    fn ctx(allow_remote: bool) -> SanitizeContext {
        SanitizeContext::new("/api/v1/messages/mime1@example.com/parts/", allow_remote)
    }

    #[test]
    fn decodes_quoted_printable_and_utf8_in_the_text_body() {
        let text = related().text().unwrap().to_string();
        assert!(text.contains("Plain text fallback"), "{text}");
        assert!(text.contains('☁'), "{text}");
    }

    #[test]
    fn prefers_the_html_alternative_for_the_html_body() {
        let html = related().html().unwrap().to_string();
        assert!(html.contains("Rich <b>HTML</b> body"), "{html}");
    }

    #[test]
    fn decodes_a_latin1_body_into_utf8() {
        let message = parse("mime2@example.com", &fixture("latin1_plain.eml")).unwrap();
        let text = message.text().unwrap();

        assert!(text.contains("Café au lait"), "{text}");
        assert!(text.contains("coûte"), "{text}");
    }

    #[test]
    fn finds_the_inline_image_and_the_attachment() {
        let message = related();
        let parts = message.parts();

        let logo = parts
            .iter()
            .find(|p| p.content_id.as_deref() == Some("logo@example.com"))
            .expect("inline logo");
        assert_eq!(logo.content_type, "image/png");
        assert_eq!(logo.disposition, Disposition::Inline);
        assert!(logo.is_image());

        let pdf = parts
            .iter()
            .find(|p| p.disposition == Disposition::Attachment)
            .expect("attachment");
        assert_eq!(pdf.content_type, "application/pdf");
        assert_eq!(pdf.filename.as_deref(), Some("report.pdf"));
    }

    #[test]
    fn part_bytes_round_trip_to_the_real_payload() {
        let message = related();
        let pdf_meta = message
            .parts()
            .into_iter()
            .find(|p| p.filename.as_deref() == Some("report.pdf"))
            .unwrap();

        let part = message.part(&pdf_meta.id).unwrap();
        assert!(
            part.bytes.starts_with(b"%PDF-1.4"),
            "{:?}",
            &part.bytes[..8]
        );
    }

    #[test]
    fn cid_references_are_rewritten_to_the_parts_endpoint() {
        let message = related();
        let body = message.body(BodyFormat::Html, &ctx(true));

        assert!(
            body.content
                .contains("/api/v1/messages/mime1@example.com/parts/"),
            "{}",
            body.content
        );
        assert!(
            !body.content.contains("cid:logo@example.com"),
            "{}",
            body.content
        );
    }

    #[test]
    fn scripts_and_event_handlers_are_removed() {
        let body = related().body(BodyFormat::Html, &ctx(true));

        assert!(!body.content.contains("<script"), "{}", body.content);
        assert!(!body.content.contains("alert("), "{}", body.content);
        assert!(!body.content.contains("onclick"), "{}", body.content);
        assert!(body.content.contains("<a href"), "{}", body.content);
    }

    #[test]
    fn remote_images_are_blocked_by_default_and_counted() {
        let body = related().body(BodyFormat::Html, &ctx(false));

        assert_eq!(body.remote_resources_blocked, 1);
        assert!(
            !body.content.contains("tracker.example.com"),
            "{}",
            body.content
        );
    }

    #[test]
    fn remote_images_survive_when_explicitly_allowed() {
        let body = related().body(BodyFormat::Html, &ctx(true));

        assert_eq!(body.remote_resources_blocked, 0);
        assert!(
            body.content.contains("tracker.example.com"),
            "{}",
            body.content
        );
    }

    #[test]
    fn inline_images_are_never_blocked_as_remote() {
        let body = related().body(BodyFormat::Html, &ctx(false));
        assert!(body.content.contains("/parts/"), "{}", body.content);
    }

    #[test]
    fn an_html_only_message_still_yields_text() {
        let message = parse("mime3@example.com", &fixture("html_only.eml")).unwrap();
        let text = message.text().unwrap();

        assert!(text.contains("Heading"), "{text}");
        assert!(text.contains("Paragraph one."), "{text}");
    }

    #[test]
    fn a_text_only_message_falls_back_to_text_when_html_is_requested() {
        let message = parse("mime2@example.com", &fixture("latin1_plain.eml")).unwrap();
        let body = message.body(BodyFormat::Html, &ctx(false));

        assert!(body.content.contains("Café"), "{}", body.content);
    }

    #[test]
    fn an_unknown_cid_is_left_alone_rather_than_pointing_at_a_wrong_part() {
        let message = related();
        let html = r#"<img src="cid:missing@example.com">"#;
        let rewritten = rewrite_cid_references(html, &message, &ctx(true));

        assert!(rewritten.contains("cid:missing@example.com"), "{rewritten}");
    }

    #[test]
    fn garbage_input_yields_an_empty_message_rather_than_panicking() {
        let message = parse("bad@example.com", &[0xff, 0xfe, 0x00, 0x01]).unwrap();

        assert!(message.parts().iter().all(|p| p.size < 8));
        assert!(message
            .body(BodyFormat::Html, &ctx(false))
            .content
            .trim()
            .is_empty());
    }

    #[test]
    fn a_truncated_multipart_does_not_lose_the_parts_it_did_parse() {
        let raw = fixture("multipart_related.eml");
        let truncated = &raw[..raw.len() * 2 / 3];
        let message = parse("mime1@example.com", truncated).unwrap();

        assert!(message.html().is_some(), "html body should survive");
    }
}

#[cfg(test)]
mod sanitizer_tests {
    use super::*;

    fn clean(html: &str) -> String {
        let message = parse(
            "x@y.z",
            format!("Content-Type: text/html\r\n\r\n{html}").as_bytes(),
        )
        .unwrap();
        message
            .body(BodyFormat::Html, &SanitizeContext::new("/parts/", true))
            .content
    }

    #[test]
    fn keeps_the_table_layout_real_mail_is_built_from() {
        let html = clean(
            r##"<table width="600" cellpadding="0"><tr><td align="center" bgcolor="#ffffff">Hi</td></tr></table>"##,
        );
        assert!(html.contains("<table"), "{html}");
        assert!(html.contains("<td"), "{html}");
        assert!(html.contains("bgcolor"), "{html}");
        assert!(html.contains("align"), "{html}");
    }

    #[test]
    fn keeps_inline_styles_and_the_stylesheet() {
        let html = clean(r##"<style>.a{color:red}</style><p style="color:#333">text</p>"##);
        assert!(html.contains("color:red"), "{html}");
        assert!(html.contains("color:#333"), "{html}");
    }

    #[test]
    fn keeps_presentational_tags_older_senders_still_use() {
        let html = clean(r#"<center><font face="Arial" size="3">Sale</font></center>"#);
        assert!(html.contains("<center"), "{html}");
        assert!(html.contains("<font"), "{html}");
    }

    #[test]
    fn keeps_image_sizing_so_layout_does_not_collapse() {
        let html = clean(r#"<img src="https://x/y.png" width="600" height="80" alt="banner">"#);
        assert!(html.contains("width=\"600\""), "{html}");
    }

    #[test]
    fn still_removes_anything_that_can_execute() {
        let html = clean(
            r#"<script>alert(1)</script><p onclick="steal()">x</p><iframe src="//evil"></iframe>"#,
        );
        assert!(!html.contains("<script"), "{html}");
        assert!(!html.contains("alert(1)"), "{html}");
        assert!(!html.contains("onclick"), "{html}");
        assert!(!html.contains("<iframe"), "{html}");
    }

    #[test]
    fn still_removes_forms_so_credentials_cannot_be_phished_inline() {
        let html = clean(r#"<form action="//evil"><input name="password"></form>"#);
        assert!(!html.contains("<form"), "{html}");
        assert!(!html.contains("<input"), "{html}");
    }

    #[test]
    fn a_javascript_url_does_not_survive() {
        let html = clean(r#"<a href="javascript:alert(1)">click</a>"#);
        assert!(!html.contains("javascript:"), "{html}");
    }
}
