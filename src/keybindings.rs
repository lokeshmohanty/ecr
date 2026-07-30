use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Action {
    NextEmail,
    PrevEmail,
    FirstEmail,
    LastEmail,
    OpenEmail,
    DeleteArchive,
    Reply,
    Star,
    ToggleRead,
    Archive,
    Tag,
    Compose,
    Search,
    CommandMode,
    PaneLeft,
    PaneRight,
    NextAccount,
    PrevAccount,
    Cancel,
    Execute,
}

pub struct KeybindingTrie {
    pub root: Node,
    pub current_node: *const Node,
}

pub struct Node {
    pub children: HashMap<String, Node>,
    pub action: Option<Action>,
}

impl Node {
    fn new() -> Self {
        Self {
            children: HashMap::new(),
            action: None,
        }
    }
}

impl Default for KeybindingTrie {
    fn default() -> Self {
        Self::new()
    }
}

impl KeybindingTrie {
    pub fn new() -> Self {
        let root = Node::new();
        let current_node = &root as *const Node;
        Self { root, current_node }
    }

    pub fn add_binding(&mut self, sequence: &[&str], action: Action) {
        let mut curr = &mut self.root;
        for &key in sequence {
            curr = curr
                .children
                .entry(key.to_string())
                .or_insert_with(Node::new);
        }
        curr.action = Some(action);
    }
}

// Safer implementation without raw pointers for the active state
pub struct KeybindingEngine {
    pub trie: Node,
    pub current_sequence: Vec<String>,
}

impl Default for KeybindingEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl KeybindingEngine {
    pub fn new() -> Self {
        Self {
            trie: Node::new(),
            current_sequence: Vec::new(),
        }
    }

    pub fn add_binding(&mut self, sequence: &str, action: Action) {
        let mut curr = &mut self.trie;
        // If it's a single char, use it. If it's a special key like "Enter", use it as one token.
        // For simplicity, we'll assume characters for now unless it matches a special key.
        if sequence.len() > 1 && !sequence.starts_with('<') {
            // Treat as sequence of characters
            for key in sequence.chars() {
                curr = curr
                    .children
                    .entry(key.to_string())
                    .or_insert_with(Node::new);
            }
        } else {
            // Treat as single token (special key or single char)
            curr = curr
                .children
                .entry(sequence.to_string())
                .or_insert_with(Node::new);
        }
        curr.action = Some(action);
    }

    pub fn add_special_binding(&mut self, key: &str, action: Action) {
        let mut curr = &mut self.trie;
        curr = curr
            .children
            .entry(key.to_string())
            .or_insert_with(Node::new);
        curr.action = Some(action);
    }

    pub fn add_macro(&mut self, sequence: &str, result: &str) {
        if let Some(action) = self.get_action_for_sequence(result) {
            self.add_binding(sequence, action);
        }
    }

    fn get_action_for_sequence(&self, sequence: &str) -> Option<Action> {
        let mut curr = &self.trie;
        if sequence.len() > 1 && !sequence.starts_with('<') {
            for key in sequence.chars() {
                if let Some(next) = curr.children.get(&key.to_string()) {
                    curr = next;
                } else {
                    return None;
                }
            }
        } else {
            if let Some(next) = curr.children.get(sequence) {
                curr = next;
            } else {
                return None;
            }
        }
        curr.action.clone()
    }

    pub fn handle_key(&mut self, key: &str) -> (Option<Action>, bool) {
        self.current_sequence.push(key.to_string());

        let mut curr = &self.trie;
        for k in &self.current_sequence {
            if let Some(next) = curr.children.get(k) {
                curr = next;
            } else {
                // No match, reset
                self.current_sequence.clear();
                return (None, false);
            }
        }

        if let Some(action) = &curr.action {
            self.current_sequence.clear();
            (Some(action.clone()), true)
        } else {
            // Partial match, wait for next key
            (None, true)
        }
    }

    pub fn reset(&mut self) {
        self.current_sequence.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_key_binding() {
        let mut engine = KeybindingEngine::new();
        engine.add_binding("j", Action::NextEmail);

        let (action, matched) = engine.handle_key("j");
        assert_eq!(action, Some(Action::NextEmail));
        assert!(matched);
    }

    #[test]
    fn test_multi_key_sequence() {
        let mut engine = KeybindingEngine::new();
        engine.add_binding("gg", Action::FirstEmail);

        // First 'g' should be partial match
        let (action, matched) = engine.handle_key("g");
        assert!(action.is_none());
        assert!(matched);

        // Second 'g' should complete the sequence
        let (action, matched) = engine.handle_key("g");
        assert_eq!(action, Some(Action::FirstEmail));
        assert!(matched);
    }

    #[test]
    fn test_no_match_resets() {
        let mut engine = KeybindingEngine::new();
        engine.add_binding("gg", Action::FirstEmail);

        // 'g' is partial
        let (action, matched) = engine.handle_key("g");
        assert!(action.is_none());
        assert!(matched);

        // 'x' doesn't continue, should reset
        let (action, matched) = engine.handle_key("x");
        assert!(action.is_none());
        assert!(!matched);

        // Now 'g' again should be fresh partial
        let (action, matched) = engine.handle_key("g");
        assert!(action.is_none());
        assert!(matched);
    }

    #[test]
    fn test_special_binding() {
        let mut engine = KeybindingEngine::new();
        engine.add_special_binding("Enter", Action::OpenEmail);

        let (action, matched) = engine.handle_key("Enter");
        assert_eq!(action, Some(Action::OpenEmail));
        assert!(matched);
    }

    #[test]
    fn test_reset_clears_sequence() {
        let mut engine = KeybindingEngine::new();
        engine.add_binding("gg", Action::FirstEmail);
        engine.handle_key("g");
        assert_eq!(engine.current_sequence.len(), 1);
        engine.reset();
        assert_eq!(engine.current_sequence.len(), 0);
    }

    #[test]
    fn test_macro_adds_existing_binding() {
        let mut engine = KeybindingEngine::new();
        engine.add_binding("a", Action::Archive);
        engine.add_macro("aa", "a");

        let (action, matched) = engine.handle_key("a");
        assert_eq!(action, Some(Action::Archive));
        assert!(matched);
    }

    #[test]
    fn test_macro_nonexistent_target() {
        let mut engine = KeybindingEngine::new();
        engine.add_macro("xx", "nonexistent");

        // Should not crash, just won't match
        let (action, matched) = engine.handle_key("x");
        assert!(action.is_none());
        assert!(!matched);
    }
}
