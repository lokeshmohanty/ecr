pub fn escape_query_value(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

pub fn and(clauses: &[&str]) -> String {
    let clauses: Vec<&str> = clauses
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .collect();

    match clauses.len() {
        0 => "*".to_string(),
        1 => clauses[0].to_string(),
        _ => clauses
            .iter()
            .map(|c| format!("({c})"))
            .collect::<Vec<_>>()
            .join(" and "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_values_in_quotes() {
        assert_eq!(
            escape_query_value("General Payments"),
            "\"General Payments\""
        );
    }

    #[test]
    fn doubles_embedded_quotes_rather_than_breaking_the_query() {
        assert_eq!(escape_query_value(r#"a"b"#), r#""a""b""#);
    }

    #[test]
    fn combines_clauses_with_explicit_grouping() {
        assert_eq!(
            and(&["tag:inbox", "path:main/**"]),
            "(tag:inbox) and (path:main/**)"
        );
    }

    #[test]
    fn a_single_clause_is_left_alone() {
        assert_eq!(and(&["tag:inbox"]), "tag:inbox");
    }

    #[test]
    fn no_clauses_becomes_match_all() {
        assert_eq!(and(&[]), "*");
        assert_eq!(and(&["", "  "]), "*");
    }
}
