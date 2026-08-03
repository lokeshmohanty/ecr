//! notmuch query text to SQL.
//!
//! Only the part of notmuch's syntax that SQLite can answer *identically* is
//! translated. Everything else — `date:`, `folder:`, `attachment:`, `subject:`,
//! `from:`, `to:`, a bare word, a wildcard on a boolean prefix — returns
//! `None`, and the caller asks notmuch. A translation that is merely close is
//! worse than no translation at all: the index answers silently, so a query it
//! gets subtly wrong is a wrong list with nothing on screen to say so.
//!
//! **Header searches are declined for exactly that reason.** An FTS5 index over
//! the headers is easy to build and answers `subject:invoice` in half the time
//! notmuch takes — with a different set of messages. notmuch generates terms
//! through Xapian, with its own stemmer, its own word splitting and its own
//! handling of addresses and punctuation; FTS5 does not reproduce any of that,
//! and no tokenizer setting makes it. Measured against a real 46k maildir the
//! totals differed on half the header queries tried — `subject:invoice` 108
//! against notmuch's 103, `subject:re` 3042 against 2875 — and once the set
//! differs so does everything downstream of it. Being twice as fast about the
//! wrong mail is not what the index is for.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    All,
    Tag(String),
    Id(String),
    Thread(String),
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Box<Node>),
}

/// Which way a tag test is written. The two are exactly equivalent and SQLite
/// plans them completely differently, which is worth 4x on the query the client
/// makes most:
///
/// - [`Shape::Scan`] writes a *correlated* `EXISTS`, so the planner is free to
///   walk `messages_timestamp` in order and stop at the page — nothing is
///   sorted and nothing beyond the page is looked at.
/// - [`Shape::Set`] writes `IN (SELECT … FROM tags)`, so the planner builds the
///   matching set once off `tags_tag` and probes it. That is what a count
///   wants, having no order to exploit and every row to visit.
///
/// Giving a count the scan shape costs 87ms against a 46k inbox where the set
/// shape costs 18ms; giving an ordered page the set shape forces a sort of
/// every match, 50ms against 2ms. Neither is a hint the planner can be trusted
/// to infer, and neither is written as an optimiser hint — `INDEXED BY` would
/// be a constraint that fails the query outright if the schema ever moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    Scan,
    Set,
}

/// A translated query: the predicate over the alias `m` in both shapes, sharing
/// one parameter list — the two differ only in wording, never in what they
/// bind, so a caller picks a shape and passes the same params either way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    scan: String,
    set: String,
    pub params: Vec<String>,
}

impl Plan {
    pub fn predicate(&self, shape: Shape) -> &str {
        match shape {
            Shape::Scan => &self.scan,
            Shape::Set => &self.set,
        }
    }
}

pub fn plan(text: &str, exclude_tags: &[String]) -> Option<Plan> {
    let node = parse(text)?;

    let mut params = Vec::new();
    let mut scan = String::new();
    let mut set = String::new();
    render(&node, Shape::Scan, &mut scan, &mut params);
    render(&node, Shape::Set, &mut set, &mut Vec::new());

    // notmuch drops an exclusion whenever the query string mentions the tag —
    // a plain substring test on the text, not a parse, which is why `ecr` does
    // the same rather than looking for a `tag:` node. Anything cleverer here
    // answers a different question than `notmuch search` does.
    let excluded: Vec<&String> = exclude_tags
        .iter()
        .filter(|tag| !tag.is_empty() && !text.contains(tag.as_str()))
        .collect();

    if !excluded.is_empty() {
        let holes = vec!["?"; excluded.len()].join(", ");
        scan = format!(
            "({scan}) AND NOT EXISTS \
             (SELECT 1 FROM tags x WHERE x.message = m.num AND x.tag IN ({holes}))"
        );
        // `NOT IN` over a subquery yielding NULL matches nothing at all, which
        // would hide every message rather than the excluded ones. `tags.message`
        // is `NOT NULL`, so the trap cannot fire here.
        set = format!("({set}) AND m.num NOT IN (SELECT message FROM tags WHERE tag IN ({holes}))");
        params.extend(excluded.into_iter().map(|t| t.to_string()));
    }

    Some(Plan { scan, set, params })
}

fn render(node: &Node, shape: Shape, out: &mut String, params: &mut Vec<String>) {
    match node {
        Node::All => out.push('1'),
        Node::Tag(value) => {
            out.push_str(match shape {
                Shape::Scan => {
                    "EXISTS (SELECT 1 FROM tags t WHERE t.message = m.num AND t.tag = ?)"
                }
                Shape::Set => "m.num IN (SELECT message FROM tags WHERE tag = ?)",
            });
            params.push(value.clone());
        }
        Node::Id(value) => {
            out.push_str("m.id = ?");
            params.push(value.clone());
        }
        Node::Thread(value) => {
            out.push_str("m.thread = ?");
            params.push(value.clone());
        }
        Node::Not(inner) => {
            out.push_str("NOT (");
            render(inner, shape, out, params);
            out.push(')');
        }
        Node::And(parts) | Node::Or(parts) => {
            let joiner = if matches!(node, Node::And(_)) {
                " AND "
            } else {
                " OR "
            };
            out.push('(');
            for (i, part) in parts.iter().enumerate() {
                if i > 0 {
                    out.push_str(joiner);
                }
                render(part, shape, out, params);
            }
            out.push(')');
        }
    }
}

pub fn parse(text: &str) -> Option<Node> {
    let tokens = tokenize(text)?;
    let mut cursor = Cursor {
        tokens: &tokens,
        at: 0,
    };
    let node = cursor.or_expression()?;
    cursor.done().then_some(node)
}

#[derive(Debug, PartialEq, Eq)]
enum Token {
    Open,
    Close,
    And,
    Or,
    Not,
    Word(String),
}

fn tokenize(text: &str) -> Option<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut chars = text.chars().peekable();

    while let Some(&c) = chars.peek() {
        match c {
            c if c.is_whitespace() => {
                chars.next();
            }
            '(' => {
                chars.next();
                tokens.push(Token::Open);
            }
            ')' => {
                chars.next();
                tokens.push(Token::Close);
            }
            _ => {
                let mut word = String::new();
                let mut quoted = false;
                while let Some(&c) = chars.peek() {
                    if !quoted && (c.is_whitespace() || c == '(' || c == ')') {
                        break;
                    }
                    if c == '"' {
                        quoted = !quoted;
                    }
                    word.push(c);
                    chars.next();
                }
                // An unbalanced quote is notmuch's problem, not ours.
                if quoted {
                    return None;
                }
                tokens.push(match word.to_ascii_lowercase().as_str() {
                    "and" => Token::And,
                    "or" => Token::Or,
                    "not" => Token::Not,
                    "xor" | "near" | "adj" => return None,
                    _ => Token::Word(word),
                });
            }
        }
    }

    (!tokens.is_empty()).then_some(tokens)
}

struct Cursor<'a> {
    tokens: &'a [Token],
    at: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.at)
    }

    fn done(&self) -> bool {
        self.at == self.tokens.len()
    }

    fn or_expression(&mut self) -> Option<Node> {
        let mut parts = vec![self.and_expression()?];
        while matches!(self.peek(), Some(Token::Or)) {
            self.at += 1;
            parts.push(self.and_expression()?);
        }
        Some(if parts.len() == 1 {
            parts.pop()?
        } else {
            Node::Or(parts)
        })
    }

    fn and_expression(&mut self) -> Option<Node> {
        let mut parts = vec![self.unary()?];
        loop {
            match self.peek() {
                Some(Token::And) => {
                    self.at += 1;
                    parts.push(self.unary()?);
                }
                // Juxtaposition is notmuch's AND.
                Some(Token::Word(_) | Token::Not | Token::Open) => parts.push(self.unary()?),
                _ => break,
            }
        }
        Some(if parts.len() == 1 {
            parts.pop()?
        } else {
            Node::And(parts)
        })
    }

    fn unary(&mut self) -> Option<Node> {
        if matches!(self.peek(), Some(Token::Not)) {
            self.at += 1;
            return Some(Node::Not(Box::new(self.unary()?)));
        }
        if let Some(Token::Word(word)) = self.peek() {
            if let Some(rest) = word.strip_prefix('-') {
                let rest = rest.to_string();
                self.at += 1;
                return Some(Node::Not(Box::new(atom(&rest)?)));
            }
        }
        self.atom()
    }

    fn atom(&mut self) -> Option<Node> {
        match self.peek()? {
            Token::Open => {
                self.at += 1;
                let inner = self.or_expression()?;
                matches!(self.peek(), Some(Token::Close)).then_some(())?;
                self.at += 1;
                Some(inner)
            }
            Token::Word(word) => {
                let node = atom(word)?;
                self.at += 1;
                Some(node)
            }
            _ => None,
        }
    }
}

fn atom(word: &str) -> Option<Node> {
    if word == "*" {
        return Some(Node::All);
    }

    let (prefix, value) = word.split_once(':')?;
    let value = unquote(value)?;

    match prefix.to_ascii_lowercase().as_str() {
        // A wildcard on a boolean prefix is a Xapian term expansion, and
        // matching it with LIKE would agree only by accident.
        "tag" | "is" => literal(value).map(Node::Tag),
        "id" | "mid" => literal(value).map(Node::Id),
        "thread" => literal(value).map(Node::Thread),
        _ => None,
    }
}

fn literal(value: &str) -> Option<String> {
    (!value.is_empty() && !value.contains('*')).then(|| value.to_string())
}

fn unquote(value: &str) -> Option<&str> {
    match value.strip_prefix('"') {
        Some(rest) => rest.strip_suffix('"'),
        None => (!value.contains('"')).then_some(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag(name: &str) -> Node {
        Node::Tag(name.to_string())
    }

    #[test]
    fn a_bare_tag_is_the_whole_query() {
        assert_eq!(parse("tag:inbox"), Some(tag("inbox")));
    }

    #[test]
    fn is_is_a_synonym_for_tag() {
        assert_eq!(parse("is:unread"), Some(tag("unread")));
    }

    #[test]
    fn juxtaposition_is_and() {
        assert_eq!(
            parse("tag:inbox tag:unread"),
            Some(Node::And(vec![tag("inbox"), tag("unread")]))
        );
    }

    #[test]
    fn and_binds_tighter_than_or() {
        let parsed = parse("tag:a and tag:b or tag:c").expect("parses");
        assert_eq!(
            parsed,
            Node::Or(vec![Node::And(vec![tag("a"), tag("b")]), tag("c")])
        );
    }

    #[test]
    fn parentheses_regroup() {
        let parsed = parse("tag:a and (tag:b or tag:c)").expect("parses");
        assert_eq!(
            parsed,
            Node::And(vec![tag("a"), Node::Or(vec![tag("b"), tag("c")])])
        );
    }

    #[test]
    fn both_spellings_of_negation_parse() {
        let expected = Node::Not(Box::new(tag("deleted")));
        assert_eq!(parse("-tag:deleted"), Some(expected.clone()));
        assert_eq!(parse("not tag:deleted"), Some(expected));
    }

    #[test]
    fn a_quoted_value_keeps_its_spaces() {
        assert_eq!(parse("tag:\"to do\""), Some(tag("to do")));
    }

    #[test]
    fn the_match_all_query_is_translated() {
        assert_eq!(parse("*"), Some(Node::All));
    }

    #[test]
    fn an_unknown_prefix_is_not_translated() {
        assert_eq!(parse("date:yesterday..today"), None);
        assert_eq!(parse("folder:Inbox"), None);
        assert_eq!(parse("attachment:pdf"), None);
        assert_eq!(parse("path:main/**"), None);
    }

    #[test]
    fn a_bare_word_is_not_translated() {
        // notmuch searches the body for it and the index carries headers only,
        // so answering this from SQL would quietly lose every body match.
        assert_eq!(parse("invoice"), None);
        assert_eq!(parse("tag:inbox invoice"), None);
    }

    #[test]
    fn a_wildcard_on_a_boolean_prefix_is_not_translated() {
        assert_eq!(parse("tag:work*"), None);
        assert_eq!(parse("thread:00*"), None);
    }

    /// The index carries no words, so every text search is notmuch's — see the
    /// module comment for why an FTS index that is merely close is not an
    /// improvement over asking the tool that is exact.
    #[test]
    fn a_header_search_is_not_translated() {
        assert_eq!(parse("subject:invoice"), None);
        assert_eq!(parse("from:alice"), None);
        assert_eq!(parse("to:bob"), None);
        assert_eq!(parse("from:ali*"), None);
        assert_eq!(parse("subject:\"quarterly report\""), None);
        // Including when it is one term of something otherwise translatable.
        assert_eq!(parse("tag:inbox and from:alice"), None);
    }

    #[test]
    fn an_unbalanced_quote_is_not_translated() {
        assert_eq!(parse("tag:\"open"), None);
    }

    #[test]
    fn an_unclosed_group_is_not_translated() {
        assert_eq!(parse("(tag:a"), None);
        assert_eq!(parse("tag:a)"), None);
    }

    #[test]
    fn an_empty_query_is_not_translated() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("   "), None);
    }

    #[test]
    fn excluded_tags_are_appended_to_the_predicate() {
        let plan = plan("tag:inbox", &["deleted".into(), "spam".into()]).expect("plans");

        assert!(plan.predicate(Shape::Scan).contains("NOT EXISTS"));
        assert!(plan.predicate(Shape::Set).contains("NOT IN"));
        assert_eq!(plan.params, vec!["inbox", "deleted", "spam"]);
    }

    #[test]
    fn naming_an_excluded_tag_anywhere_lifts_that_exclusion() {
        // This is notmuch's own rule: a substring test on the query text.
        let plan = plan("tag:deleted", &["deleted".into(), "spam".into()]).expect("plans");

        assert_eq!(plan.params, vec!["deleted", "spam"]);
        assert!(plan.predicate(Shape::Scan).contains("NOT EXISTS"));

        let only = plan.params.iter().filter(|p| *p == "spam").count();
        assert_eq!(only, 1, "spam is still excluded");
    }

    #[test]
    fn no_exclusions_means_no_extra_clause() {
        let plan = plan("tag:inbox", &[]).expect("plans");

        assert!(!plan.predicate(Shape::Scan).contains("NOT EXISTS"));
        assert!(!plan.predicate(Shape::Set).contains("NOT IN"));
        assert_eq!(plan.params, vec!["inbox"]);
    }

    /// The two shapes bind the same values in the same order, which is what
    /// lets one parameter list serve both. A node that pushed a parameter in
    /// one shape and not the other would put every later `?` on the wrong
    /// value — a wrong answer rather than an error.
    #[test]
    fn both_shapes_bind_the_same_parameters() {
        for text in [
            "tag:inbox",
            "tag:a and tag:b",
            "(tag:a or tag:b) and not tag:c",
            "id:x@y or tag:inbox",
            "thread:00ff",
            "*",
        ] {
            let plan = plan(text, &["deleted".into()]).expect("plans");

            assert_eq!(
                plan.predicate(Shape::Scan).matches('?').count(),
                plan.params.len(),
                "the scan shape of {text:?} does not bind every parameter"
            );
            assert_eq!(
                plan.predicate(Shape::Set).matches('?').count(),
                plan.params.len(),
                "the set shape of {text:?} does not bind every parameter"
            );
        }
    }
}
