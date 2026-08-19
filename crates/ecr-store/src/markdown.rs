//! Reading a message's HTML as text.
//!
//! The plain-text view used to be whatever `mail_parser::body_text` answered.
//! For a message with no `text/plain` part that is the parser's own flattening
//! of the markup, which runs block elements together — `<div>one</div>
//! <div>two</div>` arrives as `onetwo` — and for a message that has one it is
//! usually the `text/plain` half of a marketing alternative, which is a line
//! saying the mail cannot be displayed and a URL. Neither is a reading of the
//! message.
//!
//! So the text view is the markup, converted: headings, emphasis, lists, quotes
//! and links survive as the punctuation they were always written as, and the
//! result is legible in a monospaced pane with nothing rendering it. The real
//! `text/plain` part is the fallback rather than the first choice, on the
//! grounds that a sender who wrote HTML wrote the HTML — and it is still what
//! answers when there is no markup at all.
//!
//! Nothing here is a security boundary. The output is inserted as text, so
//! what `<script>` becomes does not matter; it is dropped because a reader
//! does not want to read it.
//!
//! The one exception is an image, which the client turns back into an `<img>`
//! — a `src` is an attribute rather than text, and it is the only thing here
//! that reaches a DOM as anything but a string. What it is allowed to point at
//! is decided twice and in both languages: `mime::rewrite_markdown_images`
//! resolves `cid:` and applies the reader's remote-images setting, and
//! `ui/linkify.ts` refuses any scheme that is not a way of fetching a picture.

use std::sync::OnceLock;

/// Tags whose *contents* are not the message.
///
/// `img` used to be on this list, and the reason it no longer is is worth
/// writing down, because the original reason was sound. htmd renders an image
/// as `![alt](src)`, and real mail is tracking pixels, spacer gifs and
/// sliced-up letterheads with no alt text — so a reader who is shown the
/// *markdown* gets a column of `![](https://…)` between the sentences, which
/// is why they were dropped.
///
/// What changed is that the client no longer shows the markdown. It renders
/// it: `![alt](src)` becomes an `<img>`, so a spacer gif is a spacer gif and a
/// letterhead is a letterhead, exactly as in the HTML view. The complaint was
/// never about images, it was about URLs standing in for them.
///
/// `svg` stays out. It is markup rather than a resource, it does not survive
/// the round trip through markdown as anything a client can render, and it is
/// the one image format that can carry script.
const NOT_THE_MESSAGE: &[&str] = &[
    "script", "style", "head", "title", "meta", "link", "noscript", "iframe", "svg",
];

fn converter() -> &'static htmd::HtmlToMarkdown {
    static CONVERTER: OnceLock<htmd::HtmlToMarkdown> = OnceLock::new();
    CONVERTER.get_or_init(|| {
        htmd::HtmlToMarkdown::builder()
            .skip_tags(NOT_THE_MESSAGE.to_vec())
            .options(htmd::options::Options {
                // A dash and one space, rather than the default asterisk and
                // three. This is read in a proportional pane beside prose, not
                // in an editor: `- item` is a list, `*   item` is a column of
                // punctuation with a gap after it. Emphasis is still asterisks,
                // so a leading `*` would be the one marker that means two
                // things.
                bullet_list_marker: htmd::options::BulletListMarker::Dash,
                ul_bullet_spacing: 1,
                ol_number_spacing: 1,
                ..Default::default()
            })
            .build()
    })
}

/// `None` when the conversion failed or came back with nothing in it, so the
/// caller can fall back rather than show an empty pane.
pub fn from_html(html: &str) -> Option<String> {
    let markdown = converter().convert(html).ok()?;
    let trimmed = markdown.trim();

    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_elements_do_not_run_together() {
        let out = from_html("<div>one</div><div>two</div>").expect("markdown");
        assert_eq!(out, "one\n\ntwo");
    }

    #[test]
    fn structure_survives_as_punctuation() {
        let out = from_html(
            "<h1>Notice</h1><p>Please <strong>read</strong> this.</p>\
             <ul><li>first</li><li>second</li></ul>",
        )
        .expect("markdown");

        assert!(out.contains("# Notice"), "{out}");
        assert!(out.contains("**read**"), "{out}");
        assert!(out.contains("- first"), "{out}");
    }

    #[test]
    fn a_link_keeps_both_its_words_and_its_url() {
        let out = from_html(r#"<p>See <a href="https://example.com/x">the notes</a>.</p>"#)
            .expect("markdown");

        assert_eq!(out, "See [the notes](https://example.com/x).");
    }

    /// A stylesheet is not a message, and mail carries kilobytes of it.
    #[test]
    fn styles_and_scripts_are_not_read_out() {
        let out = from_html("<style>.a{color:red}</style><script>alert(1)</script><p>Hello.</p>")
            .expect("markdown");

        assert_eq!(out, "Hello.");
    }

    /// The client renders these back into `<img>`, so the src has to survive
    /// the conversion rather than being dropped as noise.
    #[test]
    fn an_image_keeps_its_source() {
        let out = from_html(
            r#"<p>Hello.</p><img src="https://t.example.com/pixel.gif" width="1" height="1">"#,
        )
        .expect("markdown");

        assert!(
            out.contains("![](https://t.example.com/pixel.gif)"),
            "{out}"
        );
    }

    /// The one image format that can carry script, and the one that does not
    /// survive the round trip as anything renderable.
    #[test]
    fn inline_svg_is_still_not_the_message() {
        let out =
            from_html(r#"<p>Hello.</p><svg><script>alert(1)</script></svg>"#).expect("markdown");

        assert_eq!(out, "Hello.");
    }

    #[test]
    fn markup_with_nothing_in_it_answers_none() {
        assert_eq!(from_html("<style>.a{color:red}</style>"), None);
        assert_eq!(from_html(""), None);
    }
}
