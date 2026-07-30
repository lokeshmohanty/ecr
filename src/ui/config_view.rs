use crate::models::AppState;
use crate::theme;
use egui::{self, Align, Frame, Layout, Ui, Vec2};

pub fn show(ui: &mut Ui, state: &mut AppState) {
    ui.add_space(12.0);

    ui.horizontal(|ui| {
        ui.label(theme::heading_text("CONFIGURATION"));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.label(theme::dim_text("Settings saved to config.toml"));
        });
    });

    ui.add_space(20.0);

    egui::ScrollArea::vertical()
        .id_salt("config_scroll")
        .auto_shrink([false, false])
        .show(ui, |ui| {
            ui.label(theme::secondary_text("GENERAL"));
            Frame::NONE
                .fill(theme::BG_PANEL)
                .inner_margin(egui::Margin::symmetric(16, 16))
                .stroke(egui::Stroke::new(1.0, theme::BORDER))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new("mbsync config: ")
                                .font(theme::mono(14.0))
                                .color(theme::TEXT_DIM),
                        );
                        if ui
                            .add(
                                egui::TextEdit::singleline(&mut state.config.mbsync.config_path)
                                    .font(theme::mono(15.0))
                                    .text_color(theme::TEXT_PRIMARY)
                                    .desired_width(f32::INFINITY)
                                    .frame(false),
                            )
                            .changed()
                        {
                            state.config.save();
                        }
                    });
                });

            ui.add_space(20.0);

            ui.label(theme::secondary_text("KEYBINDINGS (Normal Mode)"));
            Frame::NONE
                .fill(theme::BG_PANEL)
                .inner_margin(egui::Margin::symmetric(16, 16))
                .stroke(egui::Stroke::new(1.0, theme::BORDER))
                .show(ui, |ui| {
                    let mut changed = false;

                    egui::Grid::new("normal_bindings_grid")
                        .num_columns(2)
                        .spacing([24.0, 12.0])
                        .show(ui, |ui| {
                            let fields = [
                                (
                                    "Next Email",
                                    &mut state.config.keybindings.normal.next_email,
                                ),
                                (
                                    "Prev Email",
                                    &mut state.config.keybindings.normal.prev_email,
                                ),
                                (
                                    "First Email",
                                    &mut state.config.keybindings.normal.first_email,
                                ),
                                (
                                    "Last Email",
                                    &mut state.config.keybindings.normal.last_email,
                                ),
                                (
                                    "Open Email",
                                    &mut state.config.keybindings.normal.open_email,
                                ),
                                ("Archive", &mut state.config.keybindings.normal.archive),
                                ("Reply", &mut state.config.keybindings.normal.reply),
                                ("Compose", &mut state.config.keybindings.normal.compose),
                                ("Search", &mut state.config.keybindings.normal.search),
                                (
                                    "Command Mode",
                                    &mut state.config.keybindings.normal.command_mode,
                                ),
                            ];

                            for (label, binding) in fields {
                                ui.label(
                                    egui::RichText::new(label)
                                        .font(theme::mono(14.0))
                                        .color(theme::TEXT_DIM),
                                );
                                if ui
                                    .add(
                                        egui::TextEdit::singleline(binding)
                                            .font(theme::mono(15.0))
                                            .text_color(theme::TEXT_PRIMARY)
                                            .desired_width(120.0)
                                            .frame(true),
                                    )
                                    .changed()
                                {
                                    changed = true;
                                }
                                ui.end_row();
                            }
                        });

                    if changed {
                        state.config.save();
                    }
                });

            ui.add_space(24.0);

            if ui
                .add(
                    egui::Button::new(theme::button_text("BACK TO MAIL"))
                        .min_size(Vec2::new(180.0, 40.0)),
                )
                .clicked()
            {
                state.right_pane = crate::models::RightPane::EmailDetail;
            }
        });
}
