# AGENTS.md

Instructions for AI coding agents working on this codebase.

## Build & Development

### Setup

```bash
direnv allow  # Loads Nix dev environment automatically
# or manually:
nix flake develop
```

### Commands

```bash
cargo build --release   # Release build
cargo run --bin ecr     # Run the application
cargo check             # Fast type checking
cargo fmt              # Format code
cargo clippy -- -D warnings  # Lint with warnings-as-errors
cargo test             # Run all tests
cargo test <name> -- --nocapture  # Run specific test with output
cargo clean            # Clean build artifacts
```

## Code Style

### General Rules

- **Never add comments** unless explicitly requested
- **Never add logging statements** (debug/trace/info) unless explicitly requested
- **Error handling:** Use `Result<T, Error>` with `thiserror` or `anyhow` for clear error messages
- **Prefer `anyhow` for application errors** (simpler, good for error propagation)
- **Prefer `thiserror` for library/public API errors** (explicit, no dynamic dispatch)
- **Use `tracing` for runtime observability** only when debugging production issues

### Naming Conventions

- Functions/variables: `snake_case`
- Types/Structs/Enums: `PascalCase`
- Modules: `snake_case`
- Constants: `SCREAMING_SNAKE_CASE`
- Trait names: `PascalCase` (e.g., `Display`, `Iterator`)

### Imports & Modules

- Group imports: standard library → external crates → local modules
- Use absolute paths from `crate::` for project imports
- Avoid deeply nested module hierarchies; prefer flat structures

### Async & Concurrency

- **Tokio runtime** lives exclusively in the `Worker` thread
- UI thread communicates via `Command`/`Event` channels only
- Use `tokio::sync::mpsc::Sender<Command>` for UI → Worker
- Use `std::sync::mpsc::Receiver<Event>` for Worker → UI (polled each frame)
- Prefer structured concurrency: avoid `spawn`ing detached tasks

### Error Handling Patterns

```rust
// Application errors - use anyhow
fn load_config() -> anyhow::Result<Config> {
    let file = File::open("config.toml")?;
    Ok(toml::from_str(&file)?)
}

// Library errors - use thiserror
#[derive(Debug, thiserror::Error)]
pub enum NotmuchError {
    #[error("notmuch command failed: {0}")]
    Command(#[from] std::io::Error),
    #[error("parsing error: {0}")]
    Parse(String),
}
```

### Testing

- Place tests in the same module using `#[cfg(test)]` or in `tests/` directory
- Use `#[tokio::test]` for async tests
- Mock external processes (notmuch, msmtp, mbsync) by capturing their output

## Architecture

```
src/
├── main.rs              # Entry point, spawns Worker, initializes eframe
├── lib.rs               # Module exports
├── app.rs               # EmailApp struct, vim keybindings, eframe::App impl
├── config.rs            # TOML config loading/saving
├── models.rs             # Data structures (Email, ComposeDraft, AppState, etc.)
├── theme.rs             # Tokyo Night color scheme
├── keybindings.rs       # KeybindingEngine (trie), Action enum
├── worker.rs            # Background thread: Command/Event channels
├── backends/
│   ├── notmuch.rs       # notmuch CLI wrapper
│   ├── msmtp.rs         # msmtp CLI wrapper
│   ├── mbsync.rs        # mbsync CLI wrapper
│   └── editor.rs        # External editor + w3m HTML rendering
└── ui/
    ├── sidebar.rs
    ├── email_list.rs
    ├── reading_pane.rs
    ├── compose.rs
    ├── command_palette.rs
    ├── config_view.rs
    ├── top_bar.rs
    └── status_bar.rs
```

### Concurrency Model

The app uses a **dedicated background Worker thread** owning a Tokio runtime:

1. **UI thread** (eframe) polls `Receiver<Event>` each frame
2. **Worker thread** processes commands asynchronously
3. Worker calls `ctx.request_repaint()` after completing commands

### Vim Mode System

Four modes defined in `VimMode`:

| Mode | Purpose | Input Handling |
|------|---------|----------------|
| Normal | Navigation | `KeybindingEngine` (trie-based) |
| Insert | Text editing | egui `TextEdit` directly |
| Command | After `:` | Command palette overlay |
| Search | After `/` | Command palette overlay |

## Adding Features

### New Vim Command

1. Add `Action` variant in `keybindings.rs`
2. Register binding: `engine.add_binding(seq, Action::MyAction)` in `app.rs`
3. Handle in `app.rs::handle_keybindings()` match arm
4. Send `Command` to worker or modify `AppState` directly

### New Background Operation

1. Add `Command` variant in `worker.rs`
2. Add matching `Event` variant for result
3. Implement handler in `Worker::run()` match arm
4. Poll for new event in `app.rs` frame loop

### New UI Component

1. Create module in `src/ui/`
2. Add `pub mod component_name;` to `lib.rs`
3. Component receives `&mut AppState` and `&mut egui::Ui`
4. State changes apply immediately (immediate-mode pattern)

## Key Dependencies

| Crate | Version | Purpose |
|-------|---------|---------|
| eframe/egui | 0.31 | Immediate-mode GUI |
| tokio | full | Async runtime (Worker only) |
| serde | - | Serialization |
| toml | - | Config files |
| dirs | - | Platform paths |
| chrono | - | Date/time |
| tracing | - | Logging |
| html2text | - | HTML fallback |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Graphics not rendering | Check `LD_LIBRARY_PATH` (set by flake.nix) |
| Emails not appearing | Run `notmuch new`; check `~/.notmuch-config` |
| HTML not rendering | Ensure `w3m` is installed and on `$PATH` |
| Emails not sending | Verify `msmtp` config in `~/.msmtprc` |
| Build errors | Run `cargo clean && cargo build` |
