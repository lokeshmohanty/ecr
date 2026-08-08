//! The line or two of a message that the list shows under its subject.
//!
//! notmuch's search output has no body in it, so this is the one thing in the
//! index that is not a copy of something notmuch already answered — it is read
//! from the message file. That makes it the only part with a cost worth
//! bounding: a rebuild covers tens of thousands of messages, and doing this in
//! front of a server that has not started listening would add a quarter of a
//! minute of file reads to every start.
//!
//! So it is filled afterwards, in batches, where nobody is waiting. A row
//! without one shows no preview, which is the row exactly as it was before this
//! existed.

use crate::error::Result;
use rusqlite::Connection;

/// About two lines at the width the list is read at.
const LENGTH: usize = 200;

/// How much of a file to read.
///
/// A preview comes from the top of the first text part, and a message whose
/// first text part starts beyond 64KB of headers and MIME preamble is not one
/// this is going to describe well anyway.
const READ: usize = 64 * 1024;

/// Rows to fill in one pass.
const BATCH: usize = 500;

/// Fills up to [`BATCH`] missing snippets. Answers how many it wrote.
///
/// Zero means there is nothing left to do, which is what the caller loops on.
pub fn fill(conn: &Connection) -> Result<usize> {
    let pending: Vec<(i64, String)> = {
        let mut statement = conn.prepare(
            "SELECT num, path FROM messages
              WHERE snippet IS NULL AND path IS NOT NULL
              ORDER BY timestamp DESC
              LIMIT ?",
        )?;
        let rows = statement.query_map([BATCH as i64], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    if pending.is_empty() {
        return Ok(0);
    }

    let tx = conn.unchecked_transaction()?;
    {
        let mut update = tx.prepare_cached("UPDATE messages SET snippet = ? WHERE num = ?")?;
        for (num, path) in &pending {
            // A file that has gone is written as empty rather than left NULL,
            // or every pass would read it again forever. The row simply shows
            // no preview, which is true.
            let text = read(std::path::Path::new(path)).unwrap_or_default();
            update.execute(rusqlite::params![text, num])?;
        }
    }
    tx.commit()?;

    Ok(pending.len())
}

/// The preview for one message file.
fn read(path: &std::path::Path) -> Option<String> {
    use std::io::Read;

    let mut file = std::fs::File::open(path).ok()?;
    let mut buffer = vec![0u8; READ];
    let read = file.read(&mut buffer).ok()?;
    buffer.truncate(read);

    Some(from_bytes(&buffer))
}

/// Extracts a preview from the head of a message.
///
/// Through the store's own parser rather than mail_parser directly, because
/// `text_bodies()` counts an HTML part as a text body and hands back its
/// *source*. Against real mail that is most of the previews: `<!DOCTYPE html
/// PUBLIC …` under one subject after another. The parser here already keeps
/// text and HTML apart, the same way the reading pane does.
pub fn from_bytes(raw: &[u8]) -> String {
    let Ok(message) = crate::mime::parse("preview", raw) else {
        return String::new();
    };

    // `text()` on an HTML-only message is mail-parser's own flattening, which
    // runs block elements together — `<div>one</div><div>two</div>` arrives as
    // `onetwo`. Only a text part the sender actually wrote is preferred.
    let text = match message.text() {
        Some(text) if message.has_text_part() && !text.trim().is_empty() => text.to_string(),
        _ => flatten(message.html().unwrap_or_default()),
    };

    condense(&text)
}

/// The visible words of a fragment of HTML.
///
/// Deliberately not a renderer: `<style>` and `<script>` contents are dropped
/// rather than shown, entities are decoded, and everything else becomes spaces.
/// A preview is one line under a subject — anything cleverer belongs in the
/// reading pane, which already has it.
fn flatten(html: &str) -> String {
    let mut out = String::new();
    let mut chars = html.chars().peekable();
    let mut skipping: Option<&'static str> = None;

    while let Some(ch) = chars.next() {
        if ch != '<' {
            if skipping.is_none() {
                out.push(ch);
            }
            continue;
        }

        // A tag. Read its name, then its remainder.
        let mut tag = String::new();
        for next in chars.by_ref() {
            if next == '>' {
                break;
            }
            tag.push(next);
        }
        let name = tag
            .trim_start_matches('/')
            .split(|c: char| c.is_whitespace() || c == '>')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();

        match skipping {
            Some(open) if tag.starts_with('/') && name == open => skipping = None,
            Some(_) => {}
            None => match name.as_str() {
                "style" => skipping = Some("style"),
                "script" => skipping = Some("script"),
                "head" => skipping = Some("head"),
                // A block boundary is a space, or words either side of it run
                // together into one long unreadable string.
                _ => out.push(' '),
            },
        }
    }

    decode_entities(&out)
}

fn decode_entities(text: &str) -> String {
    // The non-breaking space is decoded twice over: mail-parser turns `&nbsp;`
    // into U+00A0 before this sees it, and a preview full of them is a line
    // that will not wrap.
    text.replace('\u{a0}', " ")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&zwnj;", "")
        .replace("&#8203;", "")
}

/// One line of prose out of a body.
///
/// Quoted lines and the signature are dropped: a reply's preview is otherwise
/// the message being replied to, which is the one thing the reader has already
/// seen.
fn condense(text: &str) -> String {
    let mut out = String::new();

    for line in text.lines() {
        let line = line.trim();

        if line == "--" || line == "-- " {
            break;
        }
        if line.is_empty() || line.starts_with('>') {
            continue;
        }
        // "On <date>, <somebody> wrote:" and its many translations all end in a
        // colon and are followed by quoted lines. Matching the colon alone
        // would eat real sentences, so this only skips it when it is the
        // attribution shape: one line, ending in a colon, mentioning writing.
        if line.ends_with(':') && line.len() < 120 && line.contains(" wrote") {
            continue;
        }

        if !out.is_empty() {
            out.push(' ');
        }
        // Runs collapse to one. Flattening HTML puts a space either side of
        // every tag, so adjacent tags leave gaps that a proportional face makes
        // very visible.
        let mut spaced = false;
        for ch in line.chars() {
            if ch.is_whitespace() {
                if !spaced && !out.is_empty() {
                    out.push(' ');
                    spaced = true;
                }
                continue;
            }
            spaced = false;
            out.push(ch);
        }

        if out.chars().count() >= LENGTH {
            break;
        }
    }

    truncate(&out, LENGTH)
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let cut: String = text.chars().take(limit).collect();
    // On a word boundary where there is one nearby, so a preview does not end
    // mid-word for the sake of four characters.
    match cut.rfind(' ') {
        Some(at) if at > limit / 2 => format!("{}…", &cut[..at]),
        _ => format!("{cut}…"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESSAGE: &[u8] = b"From: a@example.com\r\n\
Subject: hello\r\n\
Content-Type: text/plain\r\n\
\r\n\
The first line of the body.\r\n\
And the second.\r\n";

    #[test]
    fn a_preview_is_the_first_prose_in_the_body() {
        assert_eq!(
            from_bytes(MESSAGE),
            "The first line of the body. And the second."
        );
    }

    /// A reply's preview must not be the message being replied to — that is the
    /// one thing the reader has already read.
    #[test]
    fn quoted_text_and_its_attribution_are_skipped() {
        let raw = b"Subject: re\r\nContent-Type: text/plain\r\n\r\n\
On Tuesday, Alice wrote:\r\n\
> the original message\r\n\
> more of it\r\n\
\r\n\
Agreed, let us do that.\r\n";
        assert_eq!(from_bytes(raw), "Agreed, let us do that.");
    }

    #[test]
    fn a_signature_ends_the_preview() {
        let raw = b"Subject: s\r\nContent-Type: text/plain\r\n\r\n\
The actual message.\r\n\
--\r\n\
Alice, Some Company, a telephone number\r\n";
        assert_eq!(from_bytes(raw), "The actual message.");
    }

    /// `wrote:` is only an attribution in that shape. A real sentence ending in
    /// a colon is content.
    #[test]
    fn a_sentence_ending_in_a_colon_is_not_an_attribution() {
        let raw = b"Subject: s\r\nContent-Type: text/plain\r\n\r\n\
Here is what I need:\r\n\
one thing\r\n";
        assert_eq!(from_bytes(raw), "Here is what I need: one thing");
    }

    #[test]
    fn a_long_body_is_cut_on_a_word_boundary() {
        let body = "word ".repeat(200);
        let raw = format!("Subject: s\r\nContent-Type: text/plain\r\n\r\n{body}");
        let preview = from_bytes(raw.as_bytes());

        assert!(preview.chars().count() <= LENGTH + 1, "{preview}");
        assert!(preview.ends_with('…'), "{preview}");
        assert!(!preview.contains("wor…"), "cut mid-word: {preview}");
    }

    /// Most real mail is HTML-only, and `text_bodies()` counts an HTML part as
    /// a text body — so before this, preview after preview was `<!DOCTYPE html
    /// PUBLIC …` under a perfectly ordinary subject.
    #[test]
    fn an_html_only_message_previews_its_words_not_its_markup() {
        let raw = b"Subject: s\r\nContent-Type: text/html\r\n\r\n\
<!DOCTYPE html><html><head><style>p { color: red }</style></head>\
<body><p>Your order has shipped.</p><p>Track&nbsp;it&nbsp;here.</p></body></html>";

        let preview = from_bytes(raw);
        assert!(!preview.contains('<'), "markup leaked: {preview}");
        assert!(!preview.contains("color: red"), "css leaked: {preview}");
        assert_eq!(preview, "Your order has shipped. Track it here.");
    }

    #[test]
    fn words_across_a_block_boundary_do_not_run_together() {
        let raw = b"Subject: s\r\nContent-Type: text/html\r\n\r\n\
<div>one</div><div>two</div>";
        assert_eq!(from_bytes(raw), "one two");
    }

    #[test]
    fn a_message_with_no_text_at_all_is_empty_rather_than_absent() {
        let raw = b"Subject: s\r\nContent-Type: text/plain\r\n\r\n\r\n";
        assert_eq!(from_bytes(raw), "");
    }
}

/// Reads a real maildir and prints what the previews would be.
///
/// Ignored by default: it needs somebody's actual mail, and what it proves —
/// that the extractor survives real messages rather than the tidy ones in the
/// tests above — cannot be proved with fixtures.
#[cfg(test)]
#[test]
#[ignore]
fn previews_of_real_mail() {
    let root =
        std::path::Path::new(&std::env::var("ECR_REAL_MAILDIR").unwrap_or_default()).to_path_buf();
    if !root.is_dir() {
        eprintln!("set ECR_REAL_MAILDIR to run this");
        return;
    }

    let mut shown = 0;
    for entry in walkdir(&root) {
        let Some(text) = read(&entry) else { continue };
        if text.is_empty() {
            continue;
        }
        println!("{text}");
        shown += 1;
        if shown >= 15 {
            break;
        }
    }
    assert!(shown > 0, "no previews at all from real mail");
}

#[cfg(test)]
fn walkdir(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if dir.ends_with("cur") && out.len() < 400 {
                out.push(path);
            }
        }
        if out.len() >= 400 {
            break;
        }
    }
    out
}
