use egui::{InputState, Key};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Config {
    pub mbsync: MbsyncConfig,
    pub keybindings: Keybindings,
    pub macros: HashMap<String, String>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct MbsyncConfig {
    pub config_path: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Keybindings {
    pub normal: NormalBindings,
    pub command: CommandBindings,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct NormalBindings {
    pub next_email: String,
    pub prev_email: String,
    pub first_email: String,
    pub last_email: String,
    pub open_email: String,
    pub delete_archive: String,
    pub reply: String,
    pub star: String,
    pub toggle_read: String,
    pub archive: String,
    pub tag: String,
    pub compose: String,
    pub search: String,
    pub command_mode: String,
    pub pane_left: String,
    pub pane_right: String,
    pub next_account: String,
    pub prev_account: String,
    pub execute: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct CommandBindings {
    pub execute: String,
    pub cancel: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            mbsync: MbsyncConfig {
                config_path: "~/.mbsyncrc".to_string(),
            },
            keybindings: Keybindings {
                normal: NormalBindings {
                    next_email: "j".to_string(),
                    prev_email: "k".to_string(),
                    first_email: "g".to_string(),
                    last_email: "End".to_string(),
                    open_email: "Enter".to_string(),
                    delete_archive: "d".to_string(),
                    reply: "r".to_string(),
                    star: "s".to_string(),
                    toggle_read: "u".to_string(),
                    archive: "a".to_string(),
                    tag: "t".to_string(),
                    compose: "c".to_string(),
                    search: "/".to_string(),
                    command_mode: ":".to_string(),
                    pane_left: "h".to_string(),
                    pane_right: "l".to_string(),
                    next_account: "]".to_string(),
                    prev_account: "[".to_string(),
                    execute: "e".to_string(),
                },
                command: CommandBindings {
                    execute: "Enter".to_string(),
                    cancel: "Escape".to_string(),
                },
            },
            macros: [
                ("gg".to_string(), "g".to_string()), // Example: gg maps to g (which is FirstEmail)
            ]
            .into_iter()
            .collect(),
        }
    }
}

impl Config {
    pub fn load() -> Self {
        let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        path.push("vim_email_client");
        path.push("config.toml");

        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(config) = toml::from_str(&content) {
                    return config;
                }
            }
        }

        let default = Config::default();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
            let _ = fs::write(&path, toml::to_string_pretty(&default).unwrap());
        }
        default
    }

    pub fn save(&self) {
        let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        path.push("vim_email_client");
        path.push("config.toml");

        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
            let _ = fs::write(&path, toml::to_string_pretty(&self).unwrap());
        }
    }
}

pub fn parse_key(s: &str) -> Option<Key> {
    match s.to_uppercase().as_str() {
        "A" => Some(Key::A),
        "B" => Some(Key::B),
        "C" => Some(Key::C),
        "D" => Some(Key::D),
        "E" => Some(Key::E),
        "F" => Some(Key::F),
        "G" => Some(Key::G),
        "H" => Some(Key::H),
        "I" => Some(Key::I),
        "J" => Some(Key::J),
        "K" => Some(Key::K),
        "L" => Some(Key::L),
        "M" => Some(Key::M),
        "N" => Some(Key::N),
        "O" => Some(Key::O),
        "P" => Some(Key::P),
        "Q" => Some(Key::Q),
        "R" => Some(Key::R),
        "S" => Some(Key::S),
        "T" => Some(Key::T),
        "U" => Some(Key::U),
        "V" => Some(Key::V),
        "W" => Some(Key::W),
        "X" => Some(Key::X),
        "Y" => Some(Key::Y),
        "Z" => Some(Key::Z),
        "ENTER" => Some(Key::Enter),
        "ESCAPE" | "ESC" => Some(Key::Escape),
        "END" => Some(Key::End),
        "ARROWDOWN" | "DOWN" => Some(Key::ArrowDown),
        "ARROWUP" | "UP" => Some(Key::ArrowUp),
        "SPACE" => Some(Key::Space),
        "BACKSPACE" => Some(Key::Backspace),
        "DELETE" => Some(Key::Delete),
        "SLASH" | "/" => Some(Key::Slash),
        _ => None,
    }
}

pub fn is_action_triggered(i: &InputState, action_str: &str) -> bool {
    // If it maps to a key, check key_pressed
    if let Some(key) = parse_key(action_str) {
        if i.key_pressed(key) {
            return true;
        }
    }
    // Also check text input events for characters like ':' or '/'
    for event in &i.events {
        if let egui::Event::Text(t) = event {
            if t == action_str {
                return true;
            }
        }
    }
    false
}

pub fn is_action_triggered_with_modifier(i: &InputState, action_str: &str) -> bool {
    for event in &i.events {
        if let egui::Event::Text(t) = event {
            if t == action_str {
                return true;
            }
        }
    }
    false
}
