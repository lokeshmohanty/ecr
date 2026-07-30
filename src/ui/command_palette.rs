use crate::models::{AppState, VimMode};
use crate::theme;
use egui;

pub fn show(ctx: &egui::Context, state: &mut AppState) {
    if state.mode != VimMode::Command && state.mode != VimMode::Search {
        return;
    }

    let screen_rect = ctx.screen_rect();
    let width = 600.0;
    let height = 40.0;
    let x = (screen_rect.width() - width) / 2.0;
    let y = 100.0; // Show near the top

    let mut open = true;
    egui::Window::new("command_palette")
        .fixed_pos([x, y])
        .fixed_size([width, height])
        .title_bar(false)
        .resizable(false)
        .collapsible(false)
        .frame(
            egui::Frame::window(&ctx.style())
                .fill(theme::BG_PANEL)
                .stroke(egui::Stroke::new(2.0, theme::ACCENT))
                .inner_margin(egui::Margin::symmetric(12, 8))
                .corner_radius(egui::CornerRadius::from(8)),
        )
        .open(&mut open)
        .show(ctx, |ui| {
            ui.horizontal(|ui| {
                let prefix = if state.mode == VimMode::Command { ":" } else { "/" };
                ui.label(
                    egui::RichText::new(prefix)
                        .font(theme::mono(20.0))
                        .color(theme::ACCENT),
                );

                let text_edit = egui::TextEdit::singleline(&mut state.command_buffer)
                    .frame(false)
                    .font(theme::mono(18.0))
                    .text_color(theme::TEXT_PRIMARY)
                    .hint_text(if state.mode == VimMode::Command {
                        "Enter command..."
                    } else {
                        "Search..."
                    })
                    .desired_width(ui.available_width());

                let response = ui.add(text_edit);
                
                if state.focus_input {
                    response.request_focus();
                    state.focus_input = false;
                }
            });
        });
    
    if !open {
        state.mode = VimMode::Normal;
    }
}
