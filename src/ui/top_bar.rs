// Top bar: app title, search/query input, utility buttons
use crate::models::AppState;
use crate::theme;
use egui::{self, Align, Layout, Ui};

pub fn show(ui: &mut Ui, state: &mut AppState) {
    ui.horizontal(|ui| {
        ui.set_min_height(44.0);

        ui.label(theme::heading_text("ECR_MAIL"));
        ui.add_space(20.0);

        let search_frame = egui::Frame::NONE
            .fill(theme::BG_INPUT)
            .stroke(egui::Stroke::new(1.0, theme::BORDER))
            .inner_margin(egui::Margin::symmetric(10, 6));

        search_frame.show(ui, |ui| {
            ui.set_min_width(400.0);
            ui.horizontal(|ui| {
                ui.label(theme::dim_text("🔍"));
                let response = ui.add(
                    egui::TextEdit::singleline(&mut state.search_query)
                        .font(theme::mono(14.0))
                        .text_color(theme::TEXT_PRIMARY)
                        .desired_width(360.0)
                        .hint_text("query: tag:inbox and not tag:killed"),
                );
                if state.focus_input && state.mode == crate::models::VimMode::Search {
                    response.request_focus();
                    state.focus_input = false;
                }
            });
        });

        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            if ui
                .add(egui::Button::new(theme::button_text("⌨ SHELL")).fill(theme::BG_PANEL))
                .clicked()
            {
                state.status_message = "Shell not implemented".into();
            }
            if ui
                .add(egui::Button::new(theme::button_text("⚙ CONF")).fill(theme::BG_PANEL))
                .clicked()
            {
                state.right_pane = crate::models::RightPane::Config;
            }
            if ui
                .add(egui::Button::new(theme::button_text("↻ SYNC")).fill(theme::BG_PANEL))
                .clicked()
            {
                state.status_message = "Syncing...".into();
                let _ = state.cmd_tx.try_send(crate::worker::Command::Sync);
            }
        });
    });
}
