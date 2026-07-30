# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Email Client in Rust (ecr)** is a Rust-based GUI email application built with `egui` and `eframe`. It provides a vim-like interface for reading, composing, and managing emails using `notmuch` as the backend for email retrieval and `msmtp` for sending.

## Build & Development

### Setup

The project uses Nix flakes for reproducible development environments. Activate with:

```bash
direnv allow  # Automatically loads dev environment
# or manually:
nix flake develop
```

### Common Commands

```bash
cargo build --release
cargo run --bin ecr
cargo check          # Faster than build for error checking
cargo fmt
cargo clippy -- -D warnings
cargo test <test_name> -- --nocapture
cargo test
cargo clean
```

### Development Environment

The flake.nix provides:
- Stable Rust toolchain with `cargo`, `clippy`, `rustfmt`, `rust-analyzer`
- WASM target (`wasm32-unknown-unknown`) for potential future features
- Display libraries: Wayland, X11, OpenGL, Vulkan (for `wgpu` backend)
- Environment variables: `RUST_LOG=debug`, `RUST_BACKTRACE=1`

## Architecture

### Module Structure

```
src/
├── main.rs              # Entry point, spawns Worker, initializes eframe with EmailApp
├── lib.rs               # Module exports
├── app.rs               # Main EmailApp struct, vim keybinding handling, eframe::App impl
├── config.rs            # Configuration loading and saving (TOML)
├── models.rs            # Data structures: Email, Attachment, ComposeDraft, AppState, VimMode, Mailbox, RightPane
├── theme.rs             # egui theme and visual styling (Tokyo Night)
├── keybindings.rs       # KeybindingEngine (trie-based) and Action enum
├── worker.rs            # Background worker thread: Command/Event async channels
├── backends/
│   ├── notmuch.rs       # Email querying via `notmuch` CLI
│   ├── msmtp.rs         # Email sending via `msmtp` CLI
│   ├── mbsync.rs        # Mailbox sync and channel discovery via `.mbsyncrc`
│   └── editor.rs        # External editor compose ($EDITOR/$VISUAL) and w3m HTML rendering
└── ui/
    ├── sidebar.rs        # Mailbox selection and navigation
    ├── email_list.rs     # Email list with selection and filtering
    ├── reading_pane.rs   # Email detail view
    ├── compose.rs        # In-app compose/reply/forward editor
    ├── command_palette.rs # Floating overlay for Command and Search modes
    ├── config_view.rs    # UI for editing settings and keybindings
    ├── top_bar.rs        # Search and mode indicator
    └── status_bar.rs     # Status messages and keybinding hints
```

### Concurrency Model

The app uses a dedicated background **Worker** thread (`worker.rs`) that owns a Tokio runtime. The UI thread communicates with it via two channels:

- `tokio::sync::mpsc::Sender<Command>` — UI sends commands to the worker
- `std::sync::mpsc::Receiver<Event>` — UI polls for results each frame

`Command` variants: `Search`, `GetEmailContent`, `Archive`, `AddTag`, `RemoveTag`, `ToggleTag`, `Tag`, `Sync`, `SendEmail`

`Event` variants: `EmailsLoaded`, `EmailContentLoaded`, `SyncStarted`, `SyncFinished`, `EmailSent`, `Error`

After each command, the worker calls `ctx.request_repaint()` so egui picks up the new events on the next frame.

### Key Data Flow

1. **AppState** (`models.rs`) holds all application state: selected email, mode, tags, drafts, etc.
2. **EmailApp** (`app.rs`) implements `eframe::App`, drives the update loop, and polls the event channel each frame.
3. **KeybindingEngine** (`keybindings.rs`) uses a trie to handle multi-key sequences (e.g. `gg`, `fwd`). `handle_key(key)` returns `(Option<Action>, bool)` — action if a sequence completed, bool indicating partial match.
4. **UI components** (`ui/`) render based on `AppState` and send `Command`s to the worker.

### Vim Mode System

Four modes defined in `VimMode` (`models.rs`):

- **Normal**: Navigation. Keybindings dispatched through `KeybindingEngine`.
- **Insert**: Text editing in compose (egui TextEdit handles input directly).
- **Command**: After `:`. Input shown in `command_palette.rs` overlay; executed on Enter.
- **Search**: After `/`. Input shown in same overlay; triggers `Command::Search` on Enter.

The command palette (`ui/command_palette.rs`) is a floating `egui::Window` that appears centered near the top when in Command or Search mode, showing `:` or `/` prefix.

### Compose Flows

Two paths for composition:

1. **In-app** (`ui/compose.rs`): `ComposeDraft` struct with `empty()`, `reply(email)`, `forward(email)` constructors. Rendered as an egui panel.
2. **External editor** (`backends/editor.rs`): `EditedEmail::compose/reply/forward()` spawns `$EDITOR`/`$VISUAL`/`vi` with a temp file (`/tmp/ecr_compose_email.txt`). File uses `---BODY---` as the header/body separator.

HTML email rendering: `render_html_with_w3m(html)` in `editor.rs` writes HTML to a temp file and runs `w3m -dump` to produce plain text.

## Dependencies

Key dependencies:
- **eframe/egui 0.31**: Immediate-mode GUI framework
- **egui_extras 0.34.1**: Image loading (PNG, JPEG, GIF via `image` crate)
- **tokio**: Async runtime (full features) used exclusively in the Worker thread
- **serde/serde_json**: JSON parsing for notmuch output
- **toml**: Config file serialization
- **dirs**: Platform-appropriate config/data directories
- **chrono**: Date/time parsing
- **html2text**: Fallback HTML-to-text conversion
- **tracing + tracing-subscriber**: Structured logging

## Common Development Patterns

**Adding a new vim command**:
1. Add an `Action` variant in `keybindings.rs`
2. Register the binding via `engine.add_binding(seq, Action::MyAction)` in `app.rs`
3. Handle the action in `app.rs::handle_keybindings()` match arm
4. Send the appropriate `Command` to the worker or modify `AppState` directly

**Adding a new background operation**:
1. Add a `Command` variant in `worker.rs`
2. Add an `Event` variant for the result
3. Handle the command in `Worker::run()` match arm
4. Poll the new event in `app.rs`'s frame update loop

**Modifying UI layout**:
- Edit the relevant `src/ui/*.rs` component; components receive `&mut AppState` and `&mut egui::Ui`
- State changes apply immediately (immediate-mode pattern — no separate commit step)

## Troubleshooting

- **Graphics not rendering**: Ensure display libraries are in `LD_LIBRARY_PATH` (set by flake.nix)
- **Emails not appearing**: Check `notmuch new` runs and `$HOME/.notmuch-config` exists
- **HTML not rendering**: Ensure `w3m` is installed and on `$PATH`
- **Emails not sending**: Verify `msmtp` is configured with `~/.msmtprc`
- **Performance issues**: Check `RUST_LOG=debug` output — Worker logs command timing
