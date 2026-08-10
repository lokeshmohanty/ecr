use crate::error::Result;
use std::path::Path;

/// The presets that ship with the server, embedded so a binary carries its own
/// themes and a fresh install has something to choose from before the user has
/// written anything.
pub const PRESETS: &[(&str, &str)] = &[
    ("ecr-dark", include_str!("../themes/ecr-dark.toml")),
    ("ecr-light", include_str!("../themes/ecr-light.toml")),
    ("tokyonight", include_str!("../themes/tokyonight.toml")),
    (
        "tokyonight-storm",
        include_str!("../themes/tokyonight-storm.toml"),
    ),
    ("gruvbox-dark", include_str!("../themes/gruvbox-dark.toml")),
    (
        "gruvbox-light",
        include_str!("../themes/gruvbox-light.toml"),
    ),
    ("nord", include_str!("../themes/nord.toml")),
    (
        "solarized-dark",
        include_str!("../themes/solarized-dark.toml"),
    ),
    (
        "solarized-light",
        include_str!("../themes/solarized-light.toml"),
    ),
    ("everforest", include_str!("../themes/everforest.toml")),
];

pub const DEFAULT_THEME: &str = "themes/ecr-dark.toml";

/// Every colour the client can theme, mirroring `COLOR_KEYS` in
/// `web/src/state/theme.ts`. A palette that misses one renders that role with
/// the compiled-in default, which is how a theme ends up half-applied.
pub const COLOR_KEYS: &[&str] = &[
    "paper",
    "paper_2",
    "card",
    "ink",
    "ink_2",
    "ink_3",
    "rule",
    "rule_soft",
    "proved",
    "proved_bg",
    "obligation",
    "obligation_bg",
    "blocking",
    "blocking_bg",
    "neutral_bg",
];

/// Seeded presets whose copy on disk is missing colour roles this ecr fills.
///
/// [`seed`] writes a preset only when the file is absent, which is right — a
/// preset the reader edited is theirs, and restoring ours would throw the edit
/// away. The cost is the same shape as every other generated file here: a
/// palette that gains a role in some release never reaches an install that
/// already has the file, the client falls back to its compiled-in colour for
/// that one role, and a theme is half-applied with nothing anywhere to say why.
///
/// So this reports rather than repairs. It is the only move that cannot destroy
/// an edit, and naming the missing roles is what makes "delete it and let ecr
/// write the current one" a decision the reader can actually make.
pub fn incomplete(dir: &Path) -> Vec<(String, Vec<String>)> {
    let mut behind = Vec::new();

    for (name, _) in PRESETS {
        let path = dir.join(format!("{name}.toml"));
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };

        // A preset that does not parse is a different complaint, and the theme
        // route already makes it when something tries to load it.
        let Ok(doc) = text.parse::<toml::Table>() else {
            continue;
        };

        let colors = doc.get("colors").and_then(|value| value.as_table());
        let missing: Vec<String> = COLOR_KEYS
            .iter()
            .filter(|key| {
                colors
                    .map(|table| !table.contains_key(**key))
                    .unwrap_or(true)
            })
            .map(|key| (*key).to_string())
            .collect();

        if !missing.is_empty() {
            behind.push(((*name).to_string(), missing));
        }
    }

    behind
}

/// Writes any preset the directory does not already have.
///
/// Existing files are left alone even when they differ: a preset the user has
/// edited is theirs, and silently restoring ours would throw the edit away.
pub fn seed(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;

    for (name, body) in PRESETS {
        let path = dir.join(format!("{name}.toml"));
        if !path.exists() {
            std::fs::write(&path, body)?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_preset_is_complete() {
        for (name, body) in PRESETS {
            let doc: toml::Table = body
                .parse()
                .unwrap_or_else(|e| panic!("{name}.toml does not parse: {e}"));

            let scheme = doc
                .get("color_scheme")
                .and_then(|v| v.as_str())
                .unwrap_or_else(|| panic!("{name}.toml has no color_scheme"));
            assert!(
                scheme == "dark" || scheme == "light",
                "{name}.toml has color_scheme {scheme:?}"
            );
            assert!(
                doc.get("name").and_then(|v| v.as_str()).is_some(),
                "{name}.toml has no name"
            );

            let colors = doc
                .get("colors")
                .and_then(|v| v.as_table())
                .unwrap_or_else(|| panic!("{name}.toml has no [colors]"));

            for key in COLOR_KEYS {
                let value = colors
                    .get(*key)
                    .and_then(|v| v.as_str())
                    .unwrap_or_else(|| panic!("{name}.toml is missing colour {key}"));
                assert!(
                    value.starts_with('#') && (value.len() == 7 || value.len() == 9),
                    "{name}.toml has {key} = {value:?}, which is not a hex colour"
                );
            }

            for key in colors.keys() {
                assert!(
                    COLOR_KEYS.contains(&key.as_str()),
                    "{name}.toml sets unknown colour {key}"
                );
            }
        }
    }

    #[test]
    fn the_default_theme_is_a_preset() {
        assert!(PRESETS
            .iter()
            .any(|(name, _)| DEFAULT_THEME == format!("themes/{name}.toml")));
    }

    #[test]
    fn seeding_does_not_overwrite_an_edited_preset() {
        let dir = tempfile::tempdir().unwrap();
        let themes = dir.path().join("themes");

        seed(&themes).unwrap();
        let edited = themes.join("nord.toml");
        std::fs::write(&edited, "name = \"mine\"\n").unwrap();

        seed(&themes).unwrap();

        assert_eq!(
            std::fs::read_to_string(&edited).unwrap(),
            "name = \"mine\"\n"
        );
        assert!(themes.join("everforest.toml").exists());
    }

    #[test]
    fn a_freshly_seeded_directory_is_complete() {
        let dir = tempfile::tempdir().unwrap();
        let themes = dir.path().join("themes");
        seed(&themes).unwrap();

        assert!(incomplete(&themes).is_empty());
    }

    /// The upgrade case: the file on disk is what an older ecr shipped, and
    /// seeding will not touch it because it is already there.
    #[test]
    fn a_preset_left_behind_by_an_older_ecr_is_named_with_its_missing_roles() {
        let dir = tempfile::tempdir().unwrap();
        let themes = dir.path().join("themes");
        seed(&themes).unwrap();

        let older = std::fs::read_to_string(themes.join("nord.toml"))
            .unwrap()
            .lines()
            .filter(|line| !line.trim_start().starts_with("blocking_bg"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(themes.join("nord.toml"), older).unwrap();

        let behind = incomplete(&themes);

        assert_eq!(behind.len(), 1, "{behind:?}");
        assert_eq!(behind[0].0, "nord");
        assert_eq!(behind[0].1, vec!["blocking_bg".to_string()]);
    }

    /// A theme the reader wrote themselves is not a preset and is not ours to
    /// have an opinion about.
    #[test]
    fn a_theme_that_is_not_a_preset_is_not_reported() {
        let dir = tempfile::tempdir().unwrap();
        let themes = dir.path().join("themes");
        seed(&themes).unwrap();
        std::fs::write(themes.join("mine.toml"), "name = \"mine\"\n").unwrap();

        assert!(incomplete(&themes).is_empty());
    }
}
