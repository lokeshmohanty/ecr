//! A line diff, for showing a reader what ecr would write over.
//!
//! Small and exact rather than clever: these are configuration files of a few
//! dozen lines, and the reason this exists at all is that nobody should have to
//! take "ecr can regenerate your setup" on trust.

/// Lines prefixed `-` for what is there now, `+` for what ecr would write, and
/// a space for what is the same in both.
pub fn lines(before: &str, after: &str) -> Vec<String> {
    let old: Vec<&str> = before.lines().collect();
    let new: Vec<&str> = after.lines().collect();

    // The classic longest-common-subsequence table. O(n·m) is nothing at this
    // size and is the version that is obviously correct.
    let mut table = vec![vec![0usize; new.len() + 1]; old.len() + 1];
    for i in (0..old.len()).rev() {
        for j in (0..new.len()).rev() {
            table[i][j] = if old[i] == new[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }

    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < old.len() && j < new.len() {
        if old[i] == new[j] {
            out.push(format!("  {}", old[i]));
            i += 1;
            j += 1;
        } else if table[i + 1][j] >= table[i][j + 1] {
            out.push(format!("- {}", old[i]));
            i += 1;
        } else {
            out.push(format!("+ {}", new[j]));
            j += 1;
        }
    }
    out.extend(old[i..].iter().map(|line| format!("- {line}")));
    out.extend(new[j..].iter().map(|line| format!("+ {line}")));
    out
}

/// The same, with runs of unchanged lines collapsed. A generated file is mostly
/// identical to the one it replaces, and the point is to see what is not.
pub fn summary(before: &str, after: &str, context: usize) -> Vec<String> {
    let all = lines(before, after);
    let changed: Vec<usize> = all
        .iter()
        .enumerate()
        .filter(|(_, line)| !line.starts_with("  "))
        .map(|(index, _)| index)
        .collect();

    if changed.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut last: Option<usize> = None;
    for (index, line) in all.iter().enumerate() {
        let near = changed.iter().any(|c| index.abs_diff(*c) <= context);
        if !near {
            continue;
        }
        if last.is_some_and(|previous| index > previous + 1) {
            out.push("  …".to_string());
        }
        out.push(line.clone());
        last = Some(index);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_identical_file_has_nothing_to_show() {
        assert!(summary("a\nb\nc\n", "a\nb\nc\n", 1).is_empty());
    }

    #[test]
    fn a_changed_line_shows_as_a_removal_and_an_addition() {
        let out = lines("a\nb\nc\n", "a\nB\nc\n");
        assert_eq!(out, vec!["  a", "- b", "+ B", "  c"]);
    }

    #[test]
    fn an_added_line_is_not_reported_as_a_change_to_its_neighbour() {
        let out = lines("a\nc\n", "a\nb\nc\n");
        assert_eq!(out, vec!["  a", "+ b", "  c"]);
    }

    #[test]
    fn unchanged_runs_are_collapsed_with_a_marker() {
        let before = "1\n2\n3\n4\n5\n6\n7\n8\n";
        let after = "1\n2\n3\n4\nX\n6\n7\n8\n";
        let out = summary(before, after, 1);

        assert_eq!(out, vec!["  4", "- 5", "+ X", "  6"]);
    }

    #[test]
    fn a_file_that_is_entirely_new_is_all_additions() {
        let out = lines("", "a\nb\n");
        assert_eq!(out, vec!["+ a", "+ b"]);
    }
}
