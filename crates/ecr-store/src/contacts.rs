//! The address book, read out of the vdir.
//!
//! ecr already offers addresses in the composer, gathered from mail that has
//! been received — which is good at people who have written and useless for
//! everybody else. This is the other half: the contacts the reader actually
//! keeps, synced by [`crate::dav`] and read from the same vdir khard uses.
//!
//! Parsing is deliberately shallow. A vCard has dozens of properties and ecr
//! needs two of them; anything more is a contacts application, which this is
//! not.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contact {
    pub name: Option<String>,
    pub email: String,
}

/// Every contact in a vdir, sorted and deduplicated by address.
///
/// A person with three addresses is three entries, because the composer
/// completes an address rather than a person — picking "Alice" and being given
/// whichever of her addresses came first is worse than being asked.
pub fn read(root: &Path) -> Vec<Contact> {
    let mut found: BTreeMap<String, Contact> = BTreeMap::new();

    let contacts_dir = root.join("contacts");
    let Ok(books) = std::fs::read_dir(&contacts_dir) else {
        return Vec::new();
    };

    for book in books.flatten() {
        let Ok(entries) = std::fs::read_dir(book.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("vcf") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            for contact in parse(&text) {
                found
                    .entry(contact.email.to_ascii_lowercase())
                    .or_insert(contact);
            }
        }
    }

    found.into_values().collect()
}

/// The addresses in one vCard.
pub fn parse(vcard: &str) -> Vec<Contact> {
    let unfolded = unfold(vcard);
    let mut name = None;
    let mut emails = Vec::new();

    for line in unfolded.lines() {
        let Some((property, value)) = line.split_once(':') else {
            continue;
        };
        // `EMAIL;TYPE=WORK` and `item1.EMAIL` are both an EMAIL property. The
        // name is whatever is left after the grouping prefix and before the
        // first parameter.
        let key = property
            .split(';')
            .next()
            .unwrap_or_default()
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();

        let value = value.trim();
        if value.is_empty() {
            continue;
        }

        match key.as_str() {
            "FN" => name = Some(unescape(value)),
            // The structured name, used only when there is no formatted one:
            // `Family;Given;Middle;Prefix;Suffix`.
            "N" if name.is_none() => {
                let parts: Vec<&str> = value.split(';').collect();
                let given = parts.get(1).copied().unwrap_or_default().trim();
                let family = parts.first().copied().unwrap_or_default().trim();
                let joined = format!("{given} {family}");
                if !joined.trim().is_empty() {
                    name = Some(unescape(joined.trim()));
                }
            }
            "EMAIL" => emails.push(unescape(value)),
            _ => {}
        }
    }

    emails
        .into_iter()
        .filter(|email| email.contains('@'))
        .map(|email| Contact {
            name: name.clone(),
            email,
        })
        .collect()
}

/// vCard folds long lines by continuing them with leading whitespace.
///
/// Without unfolding, an address broken across two lines is read as a truncated
/// one — which is worse than missing it, because it looks deliverable.
fn unfold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        match line.strip_prefix([' ', '\t']) {
            Some(rest) if !out.is_empty() => out.push_str(rest),
            _ => {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(line);
            }
        }
    }
    out
}

fn unescape(value: &str) -> String {
    value
        .replace("\\n", " ")
        .replace("\\,", ",")
        .replace("\\;", ";")
        .replace("\\\\", "\\")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CARD: &str = "BEGIN:VCARD\r\n\
VERSION:3.0\r\n\
FN:Alice Example\r\n\
EMAIL;TYPE=INTERNET;TYPE=HOME:alice@example.com\r\n\
EMAIL;TYPE=WORK:alice@work.example\r\n\
END:VCARD\r\n";

    #[test]
    fn every_address_on_a_card_is_its_own_entry() {
        let found = parse(CARD);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].name.as_deref(), Some("Alice Example"));
        assert_eq!(found[0].email, "alice@example.com");
        assert_eq!(found[1].email, "alice@work.example");
    }

    /// A folded line read without unfolding gives a truncated address, which is
    /// worse than none: it looks deliverable.
    #[test]
    fn a_folded_line_is_rejoined_before_it_is_read() {
        let card = "BEGIN:VCARD\r\nFN:Alice\r\nEMAIL:alice@exa\r\n mple.com\r\nEND:VCARD\r\n";
        assert_eq!(parse(card)[0].email, "alice@example.com");
    }

    #[test]
    fn a_grouped_or_parameterised_property_is_still_that_property() {
        let card = "BEGIN:VCARD\r\nitem1.EMAIL;type=pref:a@example.com\r\nEND:VCARD\r\n";
        assert_eq!(parse(card)[0].email, "a@example.com");
    }

    #[test]
    fn the_structured_name_is_used_when_there_is_no_formatted_one() {
        let card = "BEGIN:VCARD\r\nN:Example;Alice;;;\r\nEMAIL:a@example.com\r\nEND:VCARD\r\n";
        assert_eq!(parse(card)[0].name.as_deref(), Some("Alice Example"));
    }

    #[test]
    fn a_card_with_no_address_contributes_nothing() {
        let card = "BEGIN:VCARD\r\nFN:Nobody\r\nTEL:+1234\r\nEND:VCARD\r\n";
        assert!(parse(card).is_empty());
    }

    #[test]
    fn a_vdir_is_read_and_deduplicated_by_address() {
        let dir = tempfile::tempdir().unwrap();
        let book = dir.path().join("contacts/Personal");
        std::fs::create_dir_all(&book).unwrap();
        std::fs::write(book.join("one.vcf"), CARD).unwrap();
        // The same address again, from another book.
        let other = dir.path().join("contacts/Work");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(
            other.join("two.vcf"),
            "BEGIN:VCARD\r\nFN:Alice\r\nEMAIL:ALICE@example.com\r\nEND:VCARD\r\n",
        )
        .unwrap();

        let found = read(dir.path());
        assert_eq!(found.len(), 2, "{found:?}");
    }

    #[test]
    fn no_vdir_at_all_is_no_contacts_rather_than_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read(dir.path()).is_empty());
    }
}
