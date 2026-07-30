// Left sidebar: accounts + query-centric views (not folders)
use crate::models::AppState;
use crate::theme;
use egui::{self, Align, Layout, Ui, Vec2};

pub fn show(ui: &mut Ui, state: &mut AppState) {
    ui.vertical(|ui| {
        ui.add_space(12.0);

        // ── Accounts ──────────────────────────────────────────────
        ui.label(theme::heading_text("ACCOUNTS"));
        ui.add_space(4.0);

        let mut clicked_account_idx: Option<usize> = None;
        let current_idx = state.selected_account_idx;

        for (i, account) in state.accounts.iter().enumerate() {
            let is_selected = i == current_idx;
            let color = if is_selected {
                theme::ACCENT
            } else {
                theme::TEXT_PRIMARY
            };
            let label = if !account.email.is_empty() {
                &account.email
            } else {
                &account.name
            };

            ui.horizontal(|ui| {
                let icon = if is_selected { "●" } else { "○" };
                let response = ui.selectable_label(
                    is_selected,
                    egui::RichText::new(format!("  {} {}", icon, label))
                        .font(theme::mono(15.0))
                        .color(color),
                );
                if response.clicked() {
                    clicked_account_idx = Some(i);
                }
            });
        }

        if let Some(idx) = clicked_account_idx {
            state.switch_to_account(idx);
        }

        ui.add_space(16.0);
        ui.separator();
        ui.add_space(12.0);

        // ── Views (query-centric, not folder-centric) ─────────────
        ui.label(theme::heading_text("VIEWS"));
        ui.label(theme::section_label("NOTMUCH QUERIES"));
        ui.add_space(4.0);

        let mut clicked_view_idx: Option<usize> = None;
        let current_view_idx = state.selected_view_idx;

        for (i, view) in state.views.iter().enumerate() {
            let is_selected = i == current_view_idx;
            let color = if is_selected {
                theme::ACCENT
            } else {
                theme::TEXT_PRIMARY
            };

            // Count unread for inbox/unread views
            let count = if view.name.to_lowercase() == "unread" {
                state.unread_count()
            } else if view.name.to_lowercase() == "inbox" {
                state.tag_count("inbox")
            } else {
                state.tag_count(&view.name.to_lowercase())
            };

            ui.horizontal(|ui| {
                let icon = &view.icon;
                let label = view.name.to_uppercase();

                let response = ui.selectable_label(
                    is_selected,
                    egui::RichText::new(format!("  {}  {}", icon, label))
                        .font(theme::mono(15.0))
                        .color(color),
                );

                if count > 0 {
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        let count_color = if view.name.to_lowercase() == "unread" {
                            theme::ACCENT
                        } else {
                            theme::TEXT_DIM
                        };
                        ui.label(
                            egui::RichText::new(format!("{}", count))
                                .font(theme::mono(13.0))
                                .color(count_color),
                        );
                    });
                }

                if response.clicked() {
                    clicked_view_idx = Some(i);
                }
            });
        }

        if let Some(idx) = clicked_view_idx {
            state.switch_to_view(idx);
        }

        ui.add_space(20.0);
        ui.separator();
        ui.add_space(12.0);

        // ── Tags from current results ─────────────────────────────
        ui.label(theme::heading_text("CURRENT TAGS"));
        ui.add_space(4.0);

        let mut unique_tags: Vec<String> =
            state.emails.iter().flat_map(|e| e.tags.clone()).collect();
        unique_tags.sort();
        unique_tags.dedup();

        if unique_tags.is_empty() {
            ui.label(
                egui::RichText::new("  (no tags)")
                    .font(theme::mono(14.0))
                    .color(theme::TEXT_DIM),
            );
        }

        for tag in &unique_tags {
            ui.horizontal(|ui| {
                let color = theme::tag_color(tag);
                ui.label(
                    egui::RichText::new(format!("  ⊙  {}", tag))
                        .font(theme::mono(14.0))
                        .color(color),
                );
            });
        }

        ui.add_space(ui.available_height() - 40.0);

        let compose_btn = egui::Button::new(
            egui::RichText::new("+ COMPOSE")
                .font(theme::mono(15.0))
                .color(theme::TEXT_ON_ACCENT)
                .strong(),
        )
        .fill(theme::ACCENT)
        .min_size(Vec2::new(ui.available_width() - 16.0, 40.0));

        if ui.add(compose_btn).clicked() {
            state.start_compose();
        }
    });
}
