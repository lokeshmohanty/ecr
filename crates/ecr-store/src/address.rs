use ecr_core::message::Address;
use std::collections::BTreeMap;

/// Builds an address book from `notmuch address` output.
///
/// Addresses seen as recipients of your own mail rank above ones merely seen
/// as senders: you are far more likely to write to someone you have written to
/// before than to a newsletter that has written to you.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Source {
    /// Someone you have sent mail to.
    Recipient,
    /// Someone who has sent you mail.
    Sender,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookEntry {
    pub address: Address,
    pub source: Source,
    pub count: usize,
}

#[derive(Debug, Clone, Default)]
pub struct AddressBook {
    entries: BTreeMap<String, BookEntry>,
}

impl AddressBook {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Adds every line of `notmuch address` output.
    pub fn add_lines(&mut self, output: &str, source: Source) {
        for line in output.lines() {
            self.add(line, source);
        }
    }

    pub fn add(&mut self, line: &str, source: Source) {
        let Some(address) = parse_line(line) else {
            return;
        };
        let key = address.email.to_ascii_lowercase();

        self.entries
            .entry(key)
            .and_modify(|existing| {
                existing.count += 1;
                // A name is better than none, and a recipient beats a sender.
                if existing.address.name.is_none() && address.name.is_some() {
                    existing.address.name = address.name.clone();
                }
                if source < existing.source {
                    existing.source = source;
                }
            })
            .or_insert(BookEntry {
                address,
                source,
                count: 1,
            });
    }

    /// Most useful first: recipients before senders, then by how often seen.
    pub fn ranked(&self) -> Vec<BookEntry> {
        let mut out: Vec<BookEntry> = self.entries.values().cloned().collect();
        out.sort_by(|a, b| {
            a.source
                .cmp(&b.source)
                .then(b.count.cmp(&a.count))
                .then(a.address.email.cmp(&b.address.email))
        });
        out
    }
}

fn parse_line(line: &str) -> Option<Address> {
    let value = line.trim();
    if value.is_empty() {
        return None;
    }

    if let Some(open) = value.rfind('<') {
        let close = value.rfind('>')?;
        if close <= open {
            return None;
        }
        let email = value[open + 1..close].trim();
        if !email.contains('@') {
            return None;
        }
        let name = value[..open].trim().trim_matches('"').trim();
        return Some(Address::new(
            (!name.is_empty()).then(|| name.to_string()),
            email,
        ));
    }

    (value.contains('@') && !value.contains(' ')).then(|| Address::new(None, value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_named_address() {
        let address = parse_line("Alice Smith <alice@example.com>").unwrap();
        assert_eq!(address.name.as_deref(), Some("Alice Smith"));
        assert_eq!(address.email, "alice@example.com");
    }

    #[test]
    fn parses_a_bare_address() {
        let address = parse_line("bob@example.com").unwrap();
        assert_eq!(address.name, None);
        assert_eq!(address.email, "bob@example.com");
    }

    #[test]
    fn strips_quotes_from_a_name() {
        let address = parse_line("\"Doe, Jane\" <l@x.com>").unwrap();
        assert_eq!(address.name.as_deref(), Some("Doe, Jane"));
    }

    #[test]
    fn rejects_lines_that_are_not_addresses() {
        assert!(parse_line("").is_none());
        assert!(parse_line("   ").is_none());
        assert!(parse_line("Just A Name").is_none());
        assert!(parse_line("Name <not-an-address>").is_none());
    }

    #[test]
    fn deduplicates_by_address_case_insensitively() {
        let mut book = AddressBook::new();
        book.add("Alice <alice@example.com>", Source::Sender);
        book.add("alice@EXAMPLE.com", Source::Sender);

        assert_eq!(book.len(), 1);
        assert_eq!(book.ranked()[0].count, 2);
    }

    #[test]
    fn keeps_the_first_name_it_learns() {
        let mut book = AddressBook::new();
        book.add("alice@example.com", Source::Sender);
        book.add("Alice Smith <alice@example.com>", Source::Sender);

        assert_eq!(
            book.ranked()[0].address.name.as_deref(),
            Some("Alice Smith")
        );
    }

    #[test]
    fn a_recipient_outranks_a_sender() {
        let mut book = AddressBook::new();
        book.add("newsletter@corp.com", Source::Sender);
        book.add("newsletter@corp.com", Source::Sender);
        book.add("colleague@work.com", Source::Recipient);

        assert_eq!(book.ranked()[0].address.email, "colleague@work.com");
    }

    #[test]
    fn seeing_someone_as_a_recipient_upgrades_them() {
        let mut book = AddressBook::new();
        book.add("person@x.com", Source::Sender);
        book.add("person@x.com", Source::Recipient);

        assert_eq!(book.ranked()[0].source, Source::Recipient);
    }

    #[test]
    fn frequency_breaks_ties_within_a_source() {
        let mut book = AddressBook::new();
        book.add("rare@x.com", Source::Sender);
        book.add("often@x.com", Source::Sender);
        book.add("often@x.com", Source::Sender);

        assert_eq!(book.ranked()[0].address.email, "often@x.com");
    }

    #[test]
    fn ingests_multiline_output_and_skips_junk() {
        let mut book = AddressBook::new();
        book.add_lines(
            "Alice <alice@x.com>\n\nnot an address\nbob@y.com\n",
            Source::Sender,
        );

        assert_eq!(book.len(), 2);
    }

    #[test]
    fn an_empty_book_is_empty() {
        let book = AddressBook::new();
        assert!(book.is_empty());
        assert!(book.ranked().is_empty());
    }
}
