//! What a pairing QR carries.
//!
//! A phone that has just been installed knows neither where the server is nor
//! how to prove itself to it, and typing a tailnet hostname and a 64-character
//! hex token on a soft keyboard is the worst part of setting ecr up. One code
//! carries both.
//!
//! The format is a URI so that it is unambiguous when something other than ecr
//! scans it, and so a future field can be added without the reader having to
//! guess what it is looking at:
//!
//! ```text
//! ecr://pair?url=http%3A%2F%2Fbox%3A8383&token=8f1c…
//! ```
//!
//! A bare token with no scheme is still accepted, because that is exactly what
//! `ecr token new --qr` produced before this existed and codes already printed
//! or photographed have to keep working.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pairing {
    /// Absent when the code carries only a token, which is every code printed
    /// before this format and any produced without a reachable address.
    pub url: Option<String>,
    pub token: String,
}

const SCHEME: &str = "ecr://pair?";

impl Pairing {
    pub fn token_only(token: impl Into<String>) -> Self {
        Self {
            url: None,
            token: token.into(),
        }
    }

    pub fn new(url: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            url: Some(url.into()),
            token: token.into(),
        }
    }

    /// `None` when there is nothing usable in the text, so a reader can say
    /// "that is not an ecr code" rather than pairing with an empty token.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }

        let Some(query) = text.strip_prefix(SCHEME) else {
            // The old format, and the only thing a bare string can be.
            return (!text.contains(char::is_whitespace)).then(|| Self::token_only(text));
        };

        let mut url = None;
        let mut token = None;
        for field in query.split('&') {
            let Some((key, value)) = field.split_once('=') else {
                continue;
            };
            match key {
                "url" => url = decode(value),
                "token" => token = decode(value),
                _ => {}
            }
        }

        let token = token.filter(|t| !t.is_empty())?;
        Some(Self {
            url: url.filter(|u| !u.is_empty()),
            token,
        })
    }
}

impl fmt::Display for Pairing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The token alone stays bare rather than becoming a one-field URI: a
        // code that is only a token is what every older ecr wrote, and writing
        // it the old way keeps a new server pairing an older client.
        let Some(url) = &self.url else {
            return f.write_str(&self.token);
        };
        write!(
            f,
            "{SCHEME}url={}&token={}",
            encode(url),
            encode(&self.token)
        )
    }
}

/// Percent-encoding, unreserved characters only. Deliberately small: the only
/// things encoded here are a URL and a hex token, and a dependency for that
/// would reach `ecr-core`, which has none by design.
fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn decode(text: &str) -> Option<String> {
    let mut out = Vec::with_capacity(text.len());
    let mut bytes = text.bytes();

    while let Some(byte) = bytes.next() {
        if byte != b'%' {
            out.push(byte);
            continue;
        }
        let hex = [bytes.next()?, bytes.next()?];
        let hex = std::str::from_utf8(&hex).ok()?;
        out.push(u8::from_str_radix(hex, 16).ok()?);
    }

    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "8f1c2d3e4f5a6b7c";

    #[test]
    fn a_pairing_survives_a_round_trip() {
        let pairing = Pairing::new("http://box:8383", TOKEN);

        assert_eq!(Pairing::parse(&pairing.to_string()), Some(pairing));
    }

    #[test]
    fn the_url_is_encoded_so_its_punctuation_cannot_end_a_field() {
        let encoded = Pairing::new("http://box:8383/", TOKEN).to_string();

        assert!(!encoded.contains("//box"), "{encoded}");
        assert!(encoded.starts_with("ecr://pair?url="));
    }

    #[test]
    fn a_url_containing_an_ampersand_still_round_trips() {
        // Not a realistic mail server address, but the reason the value is
        // encoded at all: an unescaped `&` would truncate it into two fields.
        let pairing = Pairing::new("http://box:8383/?a=1&b=2", TOKEN);

        assert_eq!(Pairing::parse(&pairing.to_string()), Some(pairing));
    }

    #[test]
    fn a_bare_token_is_still_a_pairing() {
        // What `ecr token new --qr` printed before the address was included.
        assert_eq!(Pairing::parse(TOKEN), Some(Pairing::token_only(TOKEN)));
    }

    #[test]
    fn a_token_only_pairing_is_written_the_old_way() {
        assert_eq!(Pairing::token_only(TOKEN).to_string(), TOKEN);
    }

    #[test]
    fn a_code_without_a_token_is_not_a_pairing() {
        assert_eq!(Pairing::parse("ecr://pair?url=http%3A%2F%2Fbox"), None);
        assert_eq!(Pairing::parse("ecr://pair?token="), None);
    }

    #[test]
    fn something_that_is_not_a_code_at_all_is_refused() {
        assert_eq!(Pairing::parse(""), None);
        assert_eq!(Pairing::parse("   "), None);
        assert_eq!(Pairing::parse("some words here"), None);
    }

    #[test]
    fn an_unknown_field_is_ignored_rather_than_failing() {
        let parsed = Pairing::parse("ecr://pair?url=http%3A%2F%2Fbox&token=abc&name=phone");

        assert_eq!(parsed, Some(Pairing::new("http://box", "abc")));
    }

    #[test]
    fn a_truncated_escape_is_refused_rather_than_guessed() {
        assert_eq!(Pairing::parse("ecr://pair?token=ab%"), None);
        assert_eq!(Pairing::parse("ecr://pair?token=ab%2"), None);
    }
}
