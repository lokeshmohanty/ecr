// Email list panel: sender, subject, tags, timestamps, mark badges
use crate::models::{AppState, Row};
use crate::theme;
use egui::{self, Align, Color32, CornerRadius, Frame, Layout, Ui};

pub fn show(ui: &mut Ui, state: &mut AppState) {
    let rows = state.visible_rows();
    let total = state.total_emails; // This is now total threads in most cases
    let shown = rows.len();

    // Instrumentation log as requested
    tracing::info!("Rendered {} rows (From {} total threads)", shown, total);

    ui.horizontal(|ui| {
        if let Some(crate::models::Row::Thread(t)) = rows.first() {
            println!("DEBUG: UI got thread: authors='{}', subject='{}'", t.authors, t.subject);
        }
        // Show current view name
        if let Some(view) = state.current_view() {
            ui.label(theme::secondary_text(&view.name.to_uppercase()));
            ui.label(theme::dim_text("/"));
        }
        ui.label(theme::secondary_text("SORT:DATE_DESC"));

        // Show mark queue indicator
        if !state.mark_queue.is_empty() {
            ui.label(
                egui::RichText::new(format!(" [{} marked]", state.mark_queue.len()))
                    .font(theme::mono(13.0))
                    .color(Color32::from_rgb(247, 118, 142)),
            );
        }

        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.label(theme::secondary_text(&format!(
                "1-{} ROWS / {}",
                shown.min(100),
                total
            )));
        });
    });

    ui.add_space(6.0);
    ui.separator();
    ui.add_space(6.0);

    let mut new_selected_row = None;
    let mut clear_scroll = false;

    egui::ScrollArea::vertical()
        .id_salt("email_list_scroll")
        .auto_shrink([false, false])
        .show(ui, |ui| {
            if rows.is_empty() {
                ui.add_space(20.0);
                ui.label(theme::dim_text("  No messages/threads match."));
                return;
            }

            for (idx, row) in rows.iter().enumerate() {
                let is_selected = state.selected_row_index == Some(idx);
                let bg = if is_selected {
                    theme::BG_SELECTED
                } else {
                    theme::BG_MAIN
                };

                // Indentation for emails inside threads
                let indent: i8 = match row {
                    Row::Thread(_) => 0,
                    Row::Email(_, _) => 24,
                };

                let frame = Frame::NONE
                    .fill(bg)
                    .inner_margin(egui::Margin {
                        left: 10 + indent,
                        right: 8,
                        top: 8,
                        bottom: 8,
                    });

                let response = frame
                    .show(ui, |ui| {
                        ui.set_width(ui.available_width());

                        match row {
                            Row::Thread(thread) => {
                                render_thread_row(ui, state, thread);
                            }
                            Row::Email(_thread, email) => {
                                render_email_row(ui, state, email);
                            }
                        }

                        ui.add_space(4.0);
                        ui.separator();
                    })
                    .response;

                if response.interact(egui::Sense::click()).clicked() {
                    new_selected_row = Some(idx);
                }

                if is_selected && state.scroll_to_selected {
                    response.scroll_to_me(Some(Align::Center));
                    clear_scroll = true;
                }
            }
        });

    drop(rows);

    if let Some(idx) = new_selected_row {
        state.selected_row_index = Some(idx);
    }
    if clear_scroll {
        state.scroll_to_selected = false;
    }
}

fn render_thread_row(ui: &mut Ui, state: &AppState, thread: &crate::models::Thread) {
    let is_collapsed = state.fold_state.is_collapsed(&thread.thread_id);
    let icon = if is_collapsed { "▶" } else { "▼" };
    
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new(icon).color(theme::TEXT_DIM).font(theme::mono(12.0)));
        ui.add_space(4.0);
        
        let authors_color = if !thread.is_unread() {
            theme::TEXT_SECONDARY
        } else {
            theme::ACCENT
        };
        
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            // Thread counts (rightmost)
            let count_str = if thread.matched_messages == thread.message_count {
                format!("({})", thread.message_count)
            } else {
                format!("({}/{})", thread.matched_messages, thread.message_count)
            };
            ui.label(
                egui::RichText::new(count_str)
                    .font(theme::mono(12.0))
                    .color(theme::TEXT_DIM),
            );

            // Date (second rightmost)
            ui.label(
                egui::RichText::new(&thread.date)
                    .font(theme::mono(13.0))
                    .color(theme::TEXT_DIM),
            );

            // Authors (left-to-right filling remaining space)
            ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                ui.add(
                    egui::Label::new(
                        egui::RichText::new(&thread.authors)
                            .font(theme::mono(14.0))
                            .color(authors_color),
                    )
                );
            });
        });
    });

    let subject_color = if !thread.is_unread() {
        theme::TEXT_SECONDARY
    } else {
        theme::TEXT_PRIMARY
    };

    ui.horizontal(|ui| {
        ui.add_space(20.0); // align past icon
        if thread.is_flagged() {
            ui.label(egui::RichText::new("★").color(theme::STAR_COLOR).size(14.0));
            ui.add_space(4.0);
        }
        ui.add(
            egui::Label::new(
                egui::RichText::new(&thread.subject)
                    .font(theme::mono(14.0))
                    .color(subject_color),
            )
        );
    });

    // Tags & Badges
    ui.horizontal(|ui| {
        ui.add_space(20.0);
        render_tags(ui, &thread.tags.iter().cloned().collect::<Vec<_>>());
        if let Some(marks) = state.has_mark(&format!("thread:{}", thread.thread_id)) {
            render_badges(ui, marks);
        }
    });
}

fn render_email_row(ui: &mut Ui, state: &AppState, email: &crate::models::Email) {
    ui.horizontal(|ui| {
        ui.label(egui::RichText::new("↳").color(theme::TEXT_DIM).font(theme::mono(14.0)));
        ui.add_space(4.0);
        
        let sender_color = if email.read { theme::TEXT_SECONDARY } else { theme::ACCENT };
        let sender_display = if !email.sender_name.is_empty() {
            &email.sender_name
        } else if !email.sender_email.is_empty() {
            &email.sender_email
        } else {
            "(unknown)"
        };
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            // Time (rightmost)
            ui.label(
                egui::RichText::new(&email.time)
                    .font(theme::mono(13.0))
                    .color(theme::TEXT_DIM),
            );

            // Sender (left-to-right filling remainder)
            ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                ui.add(
                    egui::Label::new(
                        egui::RichText::new(sender_display)
                            .font(theme::mono(14.0))
                            .color(sender_color),
                    )
                );
            });
        });
    });

    let subject_color = if email.read { theme::TEXT_SECONDARY } else { theme::TEXT_PRIMARY };

    ui.horizontal(|ui| {
        ui.add_space(24.0);
        if email.flagged {
            ui.label(egui::RichText::new("★").color(theme::STAR_COLOR).size(14.0));
            ui.add_space(4.0);
        }
        ui.add(
            egui::Label::new(
                egui::RichText::new(&email.subject)
                    .font(theme::mono(14.0))
                    .color(subject_color),
            )
        );
    });

    ui.horizontal(|ui| {
        ui.add_space(24.0);
        render_tags(ui, &email.tags.iter().cloned().collect::<Vec<_>>());
        if let Some(marks) = state.has_mark(&email.message_id) {
            render_badges(ui, marks);
        }
    });
}

fn render_tags(ui: &mut Ui, tags: &[String]) {
    if tags.is_empty() { return; }
    for tag in tags {
        if tag == "unread" || tag == "inbox" { continue; } // Exclude noisy tags normally displayed via style
        let tag_color = theme::tag_color(tag);
        let tag_bg = theme::tag_bg_color(tag);

        Frame::NONE
            .fill(tag_bg)
            .inner_margin(egui::Margin::symmetric(6, 2))
            .corner_radius(CornerRadius::ZERO)
            .show(ui, |ui| {
                ui.label(
                    egui::RichText::new(tag)
                        .font(theme::mono(11.0))
                        .color(tag_color)
                        .strong(),
                );
            });
    }
}

fn render_badges(ui: &mut Ui, marks: &[crate::models::Mark]) {
    for mark in marks {
        Frame::NONE
            .fill(Color32::from_rgb(73, 30, 45))
            .inner_margin(egui::Margin::symmetric(6, 2))
            .corner_radius(CornerRadius::ZERO)
            .show(ui, |ui| {
                ui.label(
                    egui::RichText::new(mark.badge_label())
                        .font(theme::mono(11.0))
                        .color(Color32::from_rgb(247, 118, 142))
                        .strong(),
                );
            });
    }
}
