// Compose pane: text inputs for To, Subject, and Body
use crate::models::AppState;
use crate::theme;
use egui::{self, Align, Frame, Layout, Ui, Vec2};

pub fn show(ui: &mut Ui, state: &mut AppState) {
    ui.add_space(12.0);

    ui.horizontal(|ui| {
        ui.label(theme::heading_text("COMPOSE PREVIEW"));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.label(theme::dim_text("Press :w to SEND, :q to DISCARD"));
        });
    });

    ui.add_space(20.0);

    egui::ScrollArea::vertical()
        .id_salt("compose_scroll")
        .auto_shrink([false, false])
        .show(ui, |ui| {
            Frame::NONE
                .fill(theme::BG_PANEL)
                .inner_margin(egui::Margin::symmetric(16, 16))
                .stroke(egui::Stroke::new(1.0, theme::BORDER))
                .show(ui, |ui| {
                    ui.label(
                        egui::RichText::new("TO:")
                            .font(theme::mono(14.0))
                            .color(theme::TEXT_DIM),
                    );
                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new(&state.compose_draft.to)
                            .font(theme::mono(15.0))
                            .color(theme::TEXT_PRIMARY),
                    );

                    ui.add_space(12.0);
                    ui.separator();
                    ui.add_space(12.0);

                    ui.label(
                        egui::RichText::new("SUBJECT:")
                            .font(theme::mono(14.0))
                            .color(theme::TEXT_DIM),
                    );
                    ui.add_space(4.0);
                    ui.label(
                        egui::RichText::new(&state.compose_draft.subject)
                            .font(theme::mono(15.0))
                            .color(theme::TEXT_PRIMARY),
                    );

                    if !state.compose_draft.cc.is_empty() {
                        ui.add_space(12.0);
                        ui.separator();
                        ui.add_space(12.0);
                        ui.label(
                            egui::RichText::new("CC:")
                                .font(theme::mono(14.0))
                                .color(theme::TEXT_DIM),
                        );
                        ui.add_space(4.0);
                        ui.label(
                            egui::RichText::new(&state.compose_draft.cc)
                                .font(theme::mono(15.0))
                                .color(theme::TEXT_PRIMARY),
                        );
                    }
                });

            ui.add_space(20.0);

            Frame::NONE
                .fill(theme::BG_PANEL)
                .inner_margin(egui::Margin::symmetric(16, 16))
                .stroke(egui::Stroke::new(1.0, theme::BORDER))
                .show(ui, |ui| {
                    ui.label(
                        egui::RichText::new("BODY:")
                            .font(theme::mono(14.0))
                            .color(theme::TEXT_DIM),
                    );
                    ui.add_space(8.0);
                    ui.label(
                        egui::RichText::new(&state.compose_draft.body)
                            .font(theme::mono(15.0))
                            .color(theme::TEXT_PRIMARY),
                    );
                });

            ui.add_space(20.0);

            ui.horizontal(|ui| {
                let btn_style = |label: &str, primary: bool| {
                    let color = if primary {
                        theme::TEXT_ON_ACCENT
                    } else {
                        theme::ACCENT
                    };
                    let bg = if primary {
                        theme::ACCENT
                    } else {
                        theme::BG_PANEL
                    };

                    egui::Button::new(
                        egui::RichText::new(label)
                            .font(theme::mono(14.0))
                            .color(color)
                            .strong(),
                    )
                    .fill(bg)
                    .stroke(egui::Stroke::new(1.0, theme::ACCENT))
                    .min_size(Vec2::new(120.0, 40.0))
                };

                if ui.add(btn_style("CANCEL", false)).clicked() {
                    state.discard_draft();
                }

                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if ui.add(btn_style("SEND", true)).clicked() {
                        state.send_draft();
                    }
                });
            });
        });
}
