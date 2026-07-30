// Main application struct and eframe::App implementation
use egui;
use crate::models::{AppState, VimMode, RightPane};
use crate::theme;
use crate::ui;

pub struct EmailApp {
    pub state: AppState,
    theme_applied: bool,
    frames_until_snapshot: Option<usize>,
}

impl EmailApp {
    pub fn new(cc: &eframe::CreationContext<'_>, snapshot_mode: bool) -> Self {
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        let (cmd_tx, _worker_thread) = crate::worker::Worker::spawn(event_tx.clone(), cc.egui_ctx.clone());
        let _ = cmd_tx.try_send(crate::worker::Command::SearchThreads("tag:inbox".to_string()));
        Self {
            state: AppState::new(cmd_tx, event_rx),
            theme_applied: false,
            frames_until_snapshot: if snapshot_mode { Some(5) } else { None },
        }
    }

    fn handle_keybindings(&mut self, ctx: &egui::Context) {
        use crate::config::is_action_triggered;
        
        let bindings = self.state.config.keybindings.clone();
        
        // Escape always returns to Normal mode
        if ctx.input(|i| is_action_triggered(i, &bindings.command.cancel)) {
            if self.state.mode == VimMode::Insert {
                // In compose, Escape goes back to normal mode but stays in compose view
                self.state.mode = VimMode::Normal;
                self.state.status_message = "NORMAL (press :w to send, :q to discard)".into();
            } else {
                self.state.mode = VimMode::Normal;
                self.state.command_buffer.clear();
                self.state.status_message.clear();
                self.state.show_tag_input = false;
                self.state.tag_input.clear();
            }
            return;
        }

        // Don't intercept keys in Insert or Search modes (text fields are active)
        if self.state.mode == VimMode::Insert || self.state.mode == VimMode::Search {
            if self.state.mode == VimMode::Search {
                if ctx.input(|i| is_action_triggered(i, &bindings.command.execute)) {
                    let results = self.state.filtered_indices().len();
                    self.state.status_message = format!("{} results", results);
                    self.state.mode = VimMode::Normal;
                }
            }
            return;
        }

        // Tag input mode
        if self.state.show_tag_input {
            if ctx.input(|i| is_action_triggered(i, &bindings.command.execute)) {
                let tag = self.state.tag_input.clone();
                if !tag.is_empty() {
                    self.state.add_tag_to_selected(&tag);
                }
                self.state.show_tag_input = false;
                self.state.tag_input.clear();
            }
            return;
        }

        // Process backend actions in Normal mode
        self.state.load_body_if_needed();

        match self.state.mode {
            VimMode::Normal => {
                if ctx.input(|i| is_action_triggered(i, &bindings.normal.next_email)) {
                    if let Some(current) = self.state.selected_row_index {
                        if current + 1 < self.state.visible_rows().len() {
                            self.state.selected_row_index = Some(current + 1);
                            self.state.scroll_to_selected = true;
                            self.state.right_pane = RightPane::EmailDetail;
                        }
                    } else if !self.state.emails.is_empty() {
                        self.state.selected_row_index = Some(0);
                        self.state.scroll_to_selected = true;
                    }
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.prev_email)) {
                    if let Some(current) = self.state.selected_row_index {
                        if current > 0 {
                            self.state.selected_row_index = Some(current - 1);
                            self.state.scroll_to_selected = true;
                            self.state.right_pane = RightPane::EmailDetail;
                        }
                    } else if !self.state.emails.is_empty() {
                        self.state.selected_row_index = Some(self.state.visible_rows().len() - 1);
                        self.state.scroll_to_selected = true;
                    }
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.first_email)) {
                    if !self.state.emails.is_empty() {
                        self.state.selected_row_index = Some(0);
                        self.state.scroll_to_selected = true;
                    }
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.last_email)) {
                    if !self.state.emails.is_empty() {
                        self.state.selected_row_index = Some(self.state.visible_rows().len() - 1);
                        self.state.scroll_to_selected = true;
                    }
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.open_email)) {
                    if let Some(_) = self.state.selected_row_index {
                        if !self.state.is_selected_read() {
                            self.state.toggle_read();
                        }
                        self.state.right_pane = RightPane::EmailDetail;
                    }
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.delete_archive)) {
                    self.state.archive_selected();
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.reply)) {
                    self.state.start_reply();
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.star)) {
                    self.state.toggle_star();
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.toggle_read)) {
                    self.state.toggle_read();
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.archive)) {
                    self.state.archive_selected();
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.tag)) {
                    self.state.show_tag_input = true;
                    self.state.tag_input.clear();
                    self.state.focus_input = true;
                    self.state.status_message = "Enter tag name...".into();
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.compose)) {
                    self.state.start_compose();
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.search)) {
                    self.state.mode = VimMode::Search;
                    self.state.focus_input = true;
                }

                if ctx.input(|i| is_action_triggered(i, &bindings.normal.command_mode)) {
                    self.state.mode = VimMode::Command;
                    self.state.command_buffer.clear();
                    self.state.focus_input = true;
                }
            }
            VimMode::Command => {
                if ctx.input(|i| is_action_triggered(i, &bindings.command.execute)) {
                    let cmd = self.state.command_buffer.trim().to_lowercase();
                    match cmd.as_str() {
                        "q" | "quit" => {
                            if self.state.right_pane == RightPane::Compose {
                                self.state.discard_draft();
                            } else {
                                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                            }
                        }
                        "w" | "send" => {
                            if self.state.right_pane == RightPane::Compose {
                                self.state.send_draft();
                            } else {
                                self.state.status_message = "Syncing...".into();
                                let _ = crate::backends::sync_all();
                                self.state.refresh_current_view();
                            }
                        }
                        "wq" => {
                            if self.state.right_pane == RightPane::Compose {
                                self.state.send_draft();
                                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                            } else {
                                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                            }
                        }
                        "compose" | "new" => {
                            self.state.start_compose();
                        }
                        "reply" => {
                            self.state.start_reply();
                        }
                        "forward" | "fwd" => {
                            self.state.start_forward();
                        }
                        "archive" => {
                            self.state.archive_selected();
                        }
                        "read" => {
                            self.state.toggle_read();
                        }
                        "star" => {
                            self.state.toggle_star();
                        }
                        "help" => {
                            self.state.status_message =
                                "See ~/.config/vim_email_client/config.toml for keybindings".into();
                        }
                        _ => {
                            // Check for tag commands: :tag TAGNAME, :untag TAGNAME
                            if let Some(tag) = cmd.strip_prefix("tag ") {
                                self.state.add_tag_to_selected(tag);
                            } else if let Some(tag) = cmd.strip_prefix("untag ") {
                                self.state.remove_tag_from_selected(tag);
                            } else {
                                self.state.status_message = format!("Unknown command: {}", cmd);
                            }
                        }
                    }
                    self.state.mode = VimMode::Normal;
                    self.state.command_buffer.clear();
                }
            }
            VimMode::Search => {
                 if ctx.input(|i| is_action_triggered(i, &bindings.command.execute)) {
                    self.state.apply_search();
                    self.state.mode = VimMode::Normal;
                }
            }
            _ => {}
        }
    }
}

impl eframe::App for EmailApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Apply theme on first frame
        if !self.theme_applied {
            theme::apply_theme(ctx);
            self.theme_applied = true;
        }

        while let Ok(event) = self.state.event_rx.try_recv() {
            match event {
                crate::worker::Event::ThreadsLoaded(threads) => {
                    self.state.threads = threads;
                }
                crate::worker::Event::EmailsLoaded(emails) => {
                    self.state.emails = emails;
                }
                crate::worker::Event::ThreadMessagesLoaded(thread_id, emails) => {
                    for thread in &mut self.state.threads {
                        if thread.thread_id == thread_id {
                            thread.messages = emails;
                            break;
                        }
                    }
                }
                crate::worker::Event::EmailContentLoaded { id: message_id, plain, html, rendered, attachments } => {
                    for thread in &mut self.state.threads {
                        for email in &mut thread.messages {
                            if email.message_id == message_id {
                                email.body = plain.clone();
                                email.html_body = html.clone();
                                email.rendered_html = rendered.clone();
                                email.attachments = attachments.clone();
                            }
                        }
                    }
                }
                crate::worker::Event::SyncStarted => {
                    self.state.status_message = "Syncing...".into();
                }
                crate::worker::Event::SyncFinished => {
                    self.state.status_message = "Sync complete".into();
                }
                crate::worker::Event::EmailSent => {
                    self.state.status_message = "Email sent successfully".into();
                    self.state.discard_draft();
                }
                crate::worker::Event::Error(msg) => {
                    self.state.status_message = format!("Error: {}", msg).into();
                }
            }
        }

        // Handle vim keybindings before UI (but not when text fields have focus)
        self.handle_keybindings(ctx);

        // Top bar
        egui::TopBottomPanel::top("top_bar")
            .frame(egui::Frame::NONE
                .fill(theme::BG_PANEL)
                .inner_margin(egui::Margin::symmetric(12, 8))
                .stroke(egui::Stroke::new(1.0, theme::BORDER)))
            .show(ctx, |ui| {
                ui::top_bar::show(ui, &mut self.state);
            });

        // Bottom status bar
        egui::TopBottomPanel::bottom("status_bar")
            .frame(egui::Frame::NONE
                .fill(theme::BG_PANEL)
                .inner_margin(egui::Margin::symmetric(12, 4))
                .stroke(egui::Stroke::new(1.0, theme::BORDER)))
            .show(ctx, |ui| {
                ui::status_bar::show(ui, &mut self.state);
            });

        // Left sidebar (maildir + tags)
        egui::SidePanel::left("sidebar")
            .default_width(200.0)
            .frame(egui::Frame::NONE
                .fill(theme::BG_PANEL)
                .inner_margin(egui::Margin::symmetric(8, 0))
                .stroke(egui::Stroke::new(1.0, theme::BORDER)))
            .show(ctx, |ui| {
                ui::sidebar::show(ui, &mut self.state);
            });

        // Email list panel — using SidePanel::left so it gets FULL HEIGHT
        egui::SidePanel::left("email_list_panel")
            .default_width(380.0)
            .min_width(250.0)
            .max_width(600.0)
            .resizable(true)
            .frame(egui::Frame::NONE
                .fill(theme::BG_MAIN)
                .inner_margin(egui::Margin::symmetric(4, 4))
                .stroke(egui::Stroke::new(1.0, theme::BORDER)))
            .show(ctx, |ui| {
                ui::email_list::show(ui, &mut self.state);
            });

        // CentralPanel is now just the reading pane / compose — gets FULL remaining height
        egui::CentralPanel::default()
            .frame(egui::Frame::NONE
                .fill(theme::BG_MAIN)
                .inner_margin(egui::Margin::symmetric(12, 4)))
            .show(ctx, |ui| {
                match self.state.right_pane {
                    RightPane::EmailDetail => {
                        crate::ui::reading_pane::show(ui, &mut self.state);
                    }
                    RightPane::Compose => {
                        crate::ui::compose::show(ui, &mut self.state);
                    }
                    RightPane::Config => {
                        crate::ui::config_view::show(ui, &mut self.state);
                    }
                }
            });

        if let Some(frames) = &mut self.frames_until_snapshot {
            *frames = frames.saturating_sub(1);
            tracing::info!("Waiting for layout... {} frames left", frames);
            if *frames == 0 {
                tracing::info!("Requesting screenshot viewport command");
                ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()));
                self.frames_until_snapshot = None;
            } else {
                ctx.request_repaint();
            }
        }

        ctx.input(|i| {
            for event in &i.raw.events {
                if let egui::Event::Screenshot { image, .. } = event {
                    let path = "screenshots/current.png";
                    std::fs::create_dir_all("screenshots").unwrap();
                    let color_image = image.as_ref();
                    
                    let img = image::RgbaImage::from_fn(
                        color_image.width() as u32,
                        color_image.height() as u32,
                        |x, y| {
                            let idx = y as usize * color_image.width() + x as usize;
                            if let Some(p) = color_image.pixels.get(idx) {
                                image::Rgba([p.r(), p.g(), p.b(), p.a()])
                            } else {
                                image::Rgba([0, 0, 0, 0])
                            }
                        },
                    );
                    img.save(path).unwrap();
                    println!("Screenshot saved to {}", path);
                    std::process::exit(0);
                }
            }
        });
    }
}
