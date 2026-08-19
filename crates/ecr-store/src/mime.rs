use crate::error::{Error, Result};
use ecr_core::message::{Body, BodyFormat, Disposition, Part, PartId, PartMeta};
use mail_parser::{MessageParser, MessagePart, MimeHeaders, PartType};
use std::sync::OnceLock;

pub struct ParsedMessage {
    parts: Vec<StoredPart>,
    html: Option<String>,
    text: Option<String>,
    /// Whether the message actually carries a text/html part. mail-parser will
    /// synthesise HTML from a text part, and serving that costs the client an
    /// iframe, a sandbox and a resize for a message with no markup in it.
    has_html_part: bool,
    /// Whether it carries a real text/plain part. Without one, `text` is
    /// mail-parser's flattening of the HTML, which runs block elements
    /// together.
    has_text_part: bool,
    /// What OpenPGP this message turned out to carry, from the bytes that
    /// arrived rather than from anything reconstructed.
    ///
    /// Detected here, at parse time, because this is the last place the raw
    /// bytes exist: a signature covers what was transmitted, and everything
    /// downstream of here has been decoded. It is a byte scan over a buffer
    /// already in memory — no process is run and nothing is verified until
    /// something asks.
    protection: Option<crate::pgp::Protection>,
    /// The HTML read as text, converted once and kept.
    ///
    /// A parsed message is cached by file and mtime, so this is computed on the
    /// first request that asks for the text of a message and never again for as
    /// long as that entry lives — the foreground path and the warm path are the
    /// same code, and neither needs a background pass to have run first.
    /// `None` inside means there was nothing to convert or the conversion came
    /// back empty, which is what falls back to the `text/plain` part.
    markdown: OnceLock<Option<String>>,
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

    let has_html_part = parsed
        .parts
        .iter()
        .any(|p| matches!(p.body, PartType::Html(_)));

    // Whether there is a *real* text/plain part, as opposed to `body_text`
    // answering with mail_parser's own flattening of the HTML. The two are
    // indistinguishable from the outside and read very differently: the
    // flattening runs block elements together, so `<div>one</div><div>two</div>`
    // comes back as `onetwo`.
    let has_text_part = parsed
        .parts
        .iter()
        .any(|p| matches!(p.body, PartType::Text(_)));

    let mut parts = Vec::new();
    for (index, part) in parsed.parts.iter().enumerate() {
        if part.is_multipart() {
            continue;
        }
        if let Some(stored) = store_part(index as u32, part) {
            parts.push(stored);
        }
    }

    Ok(ParsedMessage {
        parts,
        html,
        text,
        has_html_part,
        has_text_part,
        protection: crate::pgp::detect(raw),
        markdown: OnceLock::new(),
    })
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

    /// The text of a message, which is the markup read as text whenever there
    /// is markup.
    ///
    /// The `text/plain` part is the *fallback*, not the first choice. On a
    /// message with no text part, `text` is mail-parser's flattening of the
    /// HTML, which runs block elements together; on one that has a text part,
    /// it is very often the alternative a bulk sender generated, which says
    /// the message cannot be displayed and gives a URL. A sender who wrote
    /// HTML wrote the HTML, so that is what is read — see [`crate::markdown`].
    fn reading_text(&self) -> &str {
        let converted = self.markdown.get_or_init(|| {
            let html = self.html.as_deref().filter(|_| self.has_html_part)?;
            crate::markdown::from_html(html)
        });

        match converted {
            Some(markdown) => markdown,
            None => self.text.as_deref().unwrap_or_default(),
        }
    }

    /// The reading text, with its images made reachable.
    ///
    /// The markdown carries an image exactly as the sender wrote it — a
    /// `cid:` naming a part of this message, or a URL somewhere else — and
    /// neither is something a client can render on its own: it has no map from
    /// content id to part, and whether to fetch from a stranger is the
    /// reader's setting rather than the renderer's. Both questions are already
    /// answered for the HTML view, so the text view answers them the same way
    /// and out of the same context.
    fn as_text(&self, ctx: &SanitizeContext) -> Body {
        let (content, blocked) = rewrite_markdown_images(self.reading_text(), self, ctx);

        Body {
            format: BodyFormat::Text,
            content,
            remote_resources_blocked: blocked,
            has_html: self.has_html_part,
            invite: self.invite(),
            signature: None,
            encrypted: false,
        }
    }

    /// The OpenPGP this message carries, if any.
    pub fn protection(&self) -> Option<&crate::pgp::Protection> {
        self.protection.as_ref()
    }

    /// True when the message carries real markup, not text dressed up as HTML.
    pub fn is_html(&self) -> bool {
        self.has_html_part
    }

    /// Whether [`Self::text`] is a part the sender wrote, rather than the
    /// parser's flattening of the HTML one.
    pub fn has_text_part(&self) -> bool {
        self.has_text_part
    }

    /// The meeting this message is about, if it carries one.
    ///
    /// A `text/calendar` part is shown *with* the message rather than as an
    /// attachment called `invite.ics` — which is a file the reader has to
    /// download and open somewhere else to find out when a meeting is.
    pub fn invite(&self) -> Option<ecr_core::invite::Invite> {
        self.parts
            .iter()
            .find(|p| p.meta.content_type.eq_ignore_ascii_case("text/calendar"))
            .and_then(|part| std::str::from_utf8(&part.bytes).ok())
            .and_then(ecr_core::invite::parse)
    }

    pub fn body(&self, format: BodyFormat, ctx: &SanitizeContext) -> Body {
        match format {
            BodyFormat::Text => self.as_text(ctx),
            BodyFormat::Html if self.has_html_part => match &self.html {
                Some(html) => sanitize(html, self, ctx),
                None => self.as_text(ctx),
            },
            BodyFormat::Html => self.as_text(ctx),
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

/// Rewrites a sender's dark-mode block so it can never match.
///
/// Messages are rendered on white regardless of the app theme, so a
/// `prefers-color-scheme: dark` block would style light-on-dark text over a
/// light canvas — invisible. Renaming the feature leaves the stylesheet
/// otherwise intact rather than dropping rules the message needs.
fn neutralize_dark_mode(css: &str) -> String {
    let lower = css.to_ascii_lowercase();
    let needle = "prefers-color-scheme";
    let mut out = String::with_capacity(css.len());
    let mut at = 0;

    while let Some(found) = lower[at..].find(needle) {
        let start = at + found;
        let after = start + needle.len();

        // Only the dark branch is neutralised; a light branch is what we want.
        let value_end = lower[after..]
            .find(')')
            .map(|i| after + i)
            .unwrap_or(lower.len());
        let value = &lower[after..value_end];

        out.push_str(&css[at..start]);
        if value.contains("dark") {
            out.push_str("ecr-neutralised-color-scheme");
        } else {
            out.push_str(&css[start..after]);
        }
        at = after;
    }

    out.push_str(&css[at..]);
    out
}

/// Applies `f` to the contents of every `<style>` element.
fn map_style_blocks(html: &str, f: impl Fn(&str) -> String) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut at = 0;

    while let Some(found) = lower[at..].find("<style") {
        let tag_start = at + found;
        let Some(open_end) = lower[tag_start..].find('>').map(|i| tag_start + i + 1) else {
            break;
        };
        let Some(close) = lower[open_end..].find("</style").map(|i| open_end + i) else {
            break;
        };

        out.push_str(&html[at..open_end]);
        out.push_str(&f(&html[open_end..close]));
        at = close;
    }

    out.push_str(&html[at..]);
    out
}

fn sanitize(html: &str, message: &ParsedMessage, ctx: &SanitizeContext) -> Body {
    let html = &map_style_blocks(html, neutralize_dark_mode);
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
        has_html: true,
        invite: message.invite(),
        signature: None,
        encrypted: false,
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

/// The same two questions [`sanitize`] asks of `<img>`, asked of `![](…)`.
///
/// A separate scanner rather than a reuse of the HTML pair above, because the
/// two syntaxes end a URL differently: `rewrite_cid_references` stops at a
/// quote, whitespace or `>`, and a markdown target ends at `)` — teaching it
/// that character would change what it does to HTML, where an unencoded `)`
/// inside an attribute is legal and does occur.
///
/// A target that is neither a resolvable `cid:` nor remote — a part URL, a
/// `data:` — is left exactly as written. An unresolvable `cid:` is dropped
/// outright rather than left in place: it names a part of this message that is
/// not there, so it can only ever render as a broken image.
fn rewrite_markdown_images(
    markdown: &str,
    message: &ParsedMessage,
    ctx: &SanitizeContext,
) -> (String, usize) {
    let mut out = String::with_capacity(markdown.len());
    let mut blocked = 0;
    let mut rest = markdown;

    while let Some(pos) = rest.find("![") {
        let after_alt = match rest[pos..].find("](") {
            Some(at) => pos + at + 2,
            None => break,
        };
        let close = match rest[after_alt..].find(')') {
            Some(at) => after_alt + at,
            None => break,
        };

        // The alt text may not run past the end of the line, or a stray `![`
        // in prose swallows everything up to the next link.
        if rest[pos..after_alt].contains('\n') {
            out.push_str(&rest[..after_alt]);
            rest = &rest[after_alt..];
            continue;
        }

        let target = rest[after_alt..close].trim();
        out.push_str(&rest[..pos]);

        match resolve_image(target, message, ctx) {
            Some(url) => {
                out.push_str(&rest[pos..after_alt]);
                out.push_str(&url);
                out.push(')');
            }
            None => {
                if is_remote(target) {
                    blocked += 1;
                }
            }
        }

        rest = &rest[close + 1..];
    }

    out.push_str(rest);
    (out, blocked)
}

/// Where an image in the reading text actually lives, or `None` to drop it.
fn resolve_image(target: &str, message: &ParsedMessage, ctx: &SanitizeContext) -> Option<String> {
    if let Some(cid) = target.strip_prefix("cid:") {
        let meta = message.part_by_content_id(cid)?;
        return Some(format!("{}{}", ctx.part_url_prefix, meta.id));
    }

    if is_remote(target) && !ctx.allow_remote_resources {
        return None;
    }

    Some(target.to_string())
}

fn is_remote(target: &str) -> bool {
    let lower = target.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("//")
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

    /// The text view is markdown the client renders, so an inline image has to
    /// arrive as something fetchable. A `cid:` is not: it names a part of this
    /// message, and only the server holds that map.
    #[test]
    fn the_text_view_resolves_an_inline_image_to_its_part() {
        let body = related().body(BodyFormat::Text, &ctx(true));

        assert!(
            body.content
                .contains("![logo](/api/v1/messages/mime1@example.com/parts/"),
            "{}",
            body.content
        );
    }

    #[test]
    fn the_text_view_blocks_and_counts_a_remote_image_too() {
        let body = related().body(BodyFormat::Text, &ctx(false));

        assert_eq!(body.remote_resources_blocked, 1);
        assert!(
            !body.content.contains("tracker.example.com"),
            "{}",
            body.content
        );
        // An inline part is local, and is never what "remote" means.
        assert!(body.content.contains("/parts/"), "{}", body.content);
    }

    #[test]
    fn the_text_view_keeps_a_remote_image_when_it_is_allowed() {
        let body = related().body(BodyFormat::Text, &ctx(true));

        assert_eq!(body.remote_resources_blocked, 0);
        assert!(
            body.content.contains("tracker.example.com"),
            "{}",
            body.content
        );
    }

    /// Left in place it renders as a broken image and nothing else — the part
    /// it names is not in this message and never will be.
    #[test]
    fn a_markdown_image_naming_a_missing_part_is_dropped() {
        let message = related();
        let (out, blocked) = rewrite_markdown_images(
            "before ![x](cid:missing@example.com) after",
            &message,
            &ctx(true),
        );

        assert_eq!(out, "before  after");
        assert_eq!(blocked, 0);
    }

    /// The alt text of an image cannot span a blank line, and a `!` ending a
    /// sentence before a link must not swallow the paragraph between them.
    #[test]
    fn an_exclamation_before_a_link_is_not_an_image() {
        let message = related();
        let text = "Look at this![\n\nread the notes](https://example.com/x)";
        let (out, blocked) = rewrite_markdown_images(text, &message, &ctx(false));

        assert_eq!(out, text);
        assert_eq!(blocked, 0);
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

#[cfg(test)]
mod dark_mode_tests {
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
    fn a_dark_mode_block_is_neutralised_so_it_cannot_match() {
        let html = clean(
            "<style>@media (prefers-color-scheme: dark) { body { background: #111; } }</style><p>hi</p>",
        );
        assert!(!html.contains("prefers-color-scheme: dark"), "{html}");
        assert!(html.contains("hi"), "{html}");
    }

    #[test]
    fn spacing_and_quoting_variants_are_caught_too() {
        for query in [
            "@media(prefers-color-scheme:dark)",
            "@media screen and (prefers-color-scheme: dark)",
            "@media (prefers-color-scheme:DARK)",
        ] {
            let html = clean(&format!(
                "<style>{query} {{ body {{ color: #fff; }} }}</style>"
            ));
            assert!(
                !html.to_lowercase().contains("prefers-color-scheme:dark")
                    && !html.to_lowercase().contains("prefers-color-scheme: dark"),
                "{query} survived: {html}"
            );
        }
    }

    #[test]
    fn a_light_mode_block_is_left_alone() {
        let html =
            clean("<style>@media (prefers-color-scheme: light) { p { color: #222; } }</style>");
        assert!(html.contains("prefers-color-scheme: light"), "{html}");
    }

    #[test]
    fn ordinary_media_queries_are_untouched() {
        let html = clean("<style>@media (max-width: 600px) { p { font-size: 12px; } }</style>");
        assert!(html.contains("max-width: 600px"), "{html}");
    }

    #[test]
    fn the_rest_of_a_stylesheet_survives_neutralisation() {
        let html = clean(
            "<style>p{color:#131517}@media (prefers-color-scheme: dark){p{color:#fff}}h1{margin:0}</style>",
        );
        assert!(html.contains("#131517"), "{html}");
        assert!(html.contains("margin:0"), "{html}");
    }
}

#[cfg(test)]
mod format_tests {
    use super::*;

    fn body_of(raw: &str, format: BodyFormat) -> Body {
        parse("x@y.z", raw.as_bytes())
            .unwrap()
            .body(format, &SanitizeContext::new("/parts/", true))
    }

    #[test]
    fn a_text_only_message_is_served_as_text_even_when_html_is_asked_for() {
        // mail-parser will happily synthesise HTML from a text part. Doing so
        // costs an iframe, a sandbox and a resize for a message that has no
        // markup at all, so the client is told what it really is.
        let body = body_of(
            "Content-Type: text/plain\r\n\r\nA single email with no replies.",
            BodyFormat::Html,
        );

        assert_eq!(body.format, BodyFormat::Text);
        assert!(body.content.contains("no replies"));
        assert!(!body.content.contains("<div"), "{}", body.content);
    }

    #[test]
    fn a_real_html_message_is_still_served_as_html() {
        let body = body_of(
            "Content-Type: text/html\r\n\r\n<p>Hello <b>there</b></p>",
            BodyFormat::Html,
        );

        assert_eq!(body.format, BodyFormat::Html);
        assert!(body.content.contains("<b>"), "{}", body.content);
    }

    #[test]
    fn a_multipart_alternative_still_prefers_its_html_part() {
        let raw = "Content-Type: multipart/alternative; boundary=B\r\n\r\n\
                   --B\r\nContent-Type: text/plain\r\n\r\nplain\r\n\
                   --B\r\nContent-Type: text/html\r\n\r\n<p>rich</p>\r\n--B--\r\n";
        let body = body_of(raw, BodyFormat::Html);

        assert_eq!(body.format, BodyFormat::Html);
        assert!(body.content.contains("rich"), "{}", body.content);
    }

    #[test]
    fn asking_for_text_always_gets_text() {
        let body = body_of(
            "Content-Type: text/html\r\n\r\n<p>Hello</p>",
            BodyFormat::Text,
        );
        assert_eq!(body.format, BodyFormat::Text);
    }

    #[test]
    fn a_message_with_no_body_at_all_is_empty_text() {
        let body = body_of("Subject: nothing\r\n\r\n", BodyFormat::Html);
        assert_eq!(body.format, BodyFormat::Text);
        assert_eq!(body.content.trim(), "");
    }
}

#[cfg(test)]
mod alternative_tests {
    use super::*;

    fn body_of(raw: &str) -> Body {
        parse("x@y.z", raw.as_bytes())
            .unwrap()
            .body(BodyFormat::Text, &SanitizeContext::new("/parts/", true))
    }

    #[test]
    fn a_text_only_message_reports_no_html_alternative() {
        // The client uses this to decide whether offering "as html" is honest.
        assert!(!body_of("Content-Type: text/plain\r\n\r\nplain").has_html);
    }

    #[test]
    fn an_html_message_reports_one() {
        assert!(body_of("Content-Type: text/html\r\n\r\n<p>hi</p>").has_html);
    }

    #[test]
    fn a_multipart_alternative_reports_one() {
        let raw = "Content-Type: multipart/alternative; boundary=B\r\n\r\n\
                   --B\r\nContent-Type: text/plain\r\n\r\nplain\r\n\
                   --B\r\nContent-Type: text/html\r\n\r\n<p>rich</p>\r\n--B--\r\n";
        assert!(body_of(raw).has_html);
    }

    #[test]
    fn the_flag_does_not_depend_on_which_format_was_asked_for() {
        let parsed = parse("x@y.z", b"Content-Type: text/html\r\n\r\n<p>hi</p>").unwrap();
        let ctx = SanitizeContext::new("/parts/", true);

        assert!(parsed.body(BodyFormat::Html, &ctx).has_html);
        assert!(parsed.body(BodyFormat::Text, &ctx).has_html);
    }
}
