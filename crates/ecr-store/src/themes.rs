use crate::error::Result;
use std::path::Path;

/// The presets that ship with the server, embedded so a binary carries its own
/// themes and a fresh install has something to choose from before the user has
/// written anything.
pub const PRESETS: &[(&str, &str)] = &[
    ("ecr-dark", include_str!("../../../themes/ecr-dark.toml")),
    ("ecr-light", include_str!("../../../themes/ecr-light.toml")),
    ("tokyonight", include_str!("../../../themes/tokyonight.toml")),
    (
        "tokyonight-storm",
        include_str!("../../../themes/tokyonight-storm.toml"),
    ),
    (
        "gruvbox-dark",
        include_str!("../../../themes/gruvbox-dark.toml"),
    ),
    (
        "gruvbox-light",
        include_str!("../../../themes/gruvbox-light.toml"),
    ),
    ("nord", include_str!("../../../themes/nord.toml")),
    (
        "solarized-dark",
        include_str!("../../../themes/solarized-dark.toml"),
    ),
    (
        "solarized-light",
        include_str!("../../../themes/solarized-light.toml"),
    ),
    ("everforest", include_str!("../../../themes/everforest.toml")),
];

pub const DEFAULT_THEME: &str = "themes/ecr-dark.toml";

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

    /// Every colour the client can theme, mirroring `COLOR_KEYS` in
    /// `web/src/state/theme.ts`. A preset that misses one renders that role with
    /// the compiled-in default, which is how a palette ends up half-applied.
    const COLOR_KEYS: &[&str] = &[
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
        assert!(PRESETS.iter().any(|(name, _)| DEFAULT_THEME
            == format!("themes/{name}.toml")));
    }

    #[test]
    fn seeding_does_not_overwrite_an_edited_preset() {
        let dir = tempfile::tempdir().unwrap();
        let themes = dir.path().join("themes");

        seed(&themes).unwrap();
        let edited = themes.join("nord.toml");
        std::fs::write(&edited, "name = \"mine\"\n").unwrap();

        seed(&themes).unwrap();

        assert_eq!(std::fs::read_to_string(&edited).unwrap(), "name = \"mine\"\n");
        assert!(themes.join("everforest.toml").exists());
    }
}
