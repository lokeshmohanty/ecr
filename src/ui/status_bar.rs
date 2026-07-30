// Vim-style status bar at the bottom
use crate::models::{AppState, VimMode};
use crate::theme;
use egui::{self, Align, Color32, Layout, Ui};

pub fn show(ui: &mut Ui, state: &mut AppState) {
    ui.horizontal(|ui| {
        ui.set_min_height(28.0);

        match state.mode {
            VimMode::Normal => {
                // Show mark queue hint if there are pending marks
                if !state.mark_queue.is_empty() {
                    ui.label(
                        egui::RichText::new(format!(
                            "[{} MARKS] e=EXECUTE ESC=CLEAR",
                            state.mark_queue.len()
                        ))
                        .font(theme::mono(12.0))
                        .color(Color32::from_rgb(247, 118, 142)),
                    );
                    ui.add_space(10.0);
                }

                let hints = [
                    ("j/k", "NAV"),
                    ("a", "ARCHIVE"),
                    ("d", "DELETE"),
                    ("r", "REPLY"),
                    ("e", "EXEC"),
                    ("/", "SEARCH"),
                ];

                for (key, hint) in &hints {
                    ui.label(
                        egui::RichText::new(format!("{}:{}", key, hint))
                            .font(theme::mono(12.0))
                            .color(theme::ACCENT),
                    );
                    ui.add_space(10.0);
                }
            }
            VimMode::Command => {
                ui.label(
                    egui::RichText::new(":")
                        .font(theme::mono(14.0))
                        .color(theme::ACCENT),
                );
                let response = ui.add(
                    egui::TextEdit::singleline(&mut state.command_buffer)
                        .font(theme::mono(14.0))
                        .text_color(theme::TEXT_PRIMARY)
                        .desired_width(250.0)
                        .frame(false),
                );
                if state.focus_input {
                    response.request_focus();
                    state.focus_input = false;
                }
            }
            VimMode::Search => {
                ui.label(
                    egui::RichText::new("/")
                        .font(theme::mono(14.0))
                        .color(theme::ACCENT),
                );
                let response = ui.add(
                    egui::TextEdit::singleline(&mut state.search_query)
                        .font(theme::mono(14.0))
                        .text_color(theme::TEXT_PRIMARY)
                        .desired_width(250.0)
                        .frame(false),
                );
                if state.focus_input {
                    response.request_focus();
                    state.focus_input = false;
                }
            }
            VimMode::Insert => {
                ui.label(
                    egui::RichText::new("-- INSERT --")
                        .font(theme::mono(13.0))
                        .color(theme::ACCENT)
                        .strong(),
                );
            }
        }

        if !state.status_message.is_empty() {
            ui.add_space(20.0);
            ui.label(theme::secondary_text(&state.status_message));
        }

        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            let line = state.current_line();
            let total = state.total_emails;

            ui.label(
                egui::RichText::new(format!("L:{}/{}", line, total))
                    .font(theme::mono(12.0))
                    .color(theme::TEXT_DIM),
            );
            ui.add_space(10.0);

            // Show current view query
            if let Some(view) = state.current_view() {
                ui.label(
                    egui::RichText::new(&view.query)
                        .font(theme::mono(12.0))
                        .color(theme::TEXT_DIM),
                );
                ui.add_space(10.0);
            }

            ui.label(
                egui::RichText::new("utf-8")
                    .font(theme::mono(12.0))
                    .color(theme::TEXT_DIM),
            );
        });
    });
}
