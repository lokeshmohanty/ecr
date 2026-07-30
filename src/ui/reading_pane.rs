use crate::backends::editor::render_html_with_w3m;
use crate::models::AppState;
use crate::theme;
use egui::Align2;
use egui::{self, Align, CornerRadius, Frame, Layout, ScrollArea, Ui, Vec2};

pub fn show(ui: &mut Ui, state: &mut AppState) {
    let selected = match state.selected_row() {
        Some(crate::models::Row::Email(_, email)) => Some(email.clone()),
        _ => None,
    };

    match selected {
        None => {
            ui.centered_and_justified(|ui| {
                ui.label(theme::dim_text("Select an email to view"));
            });
        }
        Some(email) => {
            ScrollArea::vertical()
                .id_salt("reading_pane_scroll")
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    ui.add_space(8.0);

                    ui.horizontal(|ui| {
                        if email.flagged {
                            ui.label(egui::RichText::new("★").color(theme::STAR_COLOR).size(20.0));
                        }
                    });

                    ui.horizontal(|ui| {
                        let initials: String = email
                            .sender_name
                            .split_whitespace()
                            .filter_map(|w: &str| w.chars().next())
                            .take(2)
                            .collect::<String>()
                            .to_uppercase();

                        let (rect, _) =
                            ui.allocate_exact_size(Vec2::new(48.0, 48.0), egui::Sense::hover());
                        ui.painter()
                            .circle_filled(rect.center(), 22.0, theme::ACCENT_DIM);
                        ui.painter().text(
                            rect.center(),
                            Align2::CENTER_CENTER,
                            &initials,
                            theme::mono(16.0),
                            theme::TEXT_ON_ACCENT,
                        );

                        ui.vertical(|ui| {
                            ui.label(
                                egui::RichText::new(&email.sender_name)
                                    .font(theme::mono(16.0))
                                    .color(theme::TEXT_PRIMARY)
                                    .strong(),
                            );
                            ui.label(
                                egui::RichText::new(&email.sender_email)
                                    .font(theme::mono(14.0))
                                    .color(theme::ACCENT),
                            );
                        });

                        ui.with_layout(Layout::right_to_left(Align::TOP), |ui| {
                            let btn = egui::Button::new(theme::button_text("ARCHIVE"))
                                .fill(theme::BG_PANEL);
                            if ui.add(btn).clicked() {
                                state.archive_selected();
                            }
                        });
                    });

                    ui.add_space(12.0);

                    ui.label(
                        egui::RichText::new(&email.subject)
                            .font(theme::mono(20.0))
                            .color(theme::TEXT_PRIMARY)
                            .strong(),
                    );

                    ui.add_space(6.0);

                    ui.horizontal(|ui| {
                        ui.label(theme::dim_text("DATE:"));
                        ui.label(theme::secondary_text(&email.date));
                        ui.add_space(16.0);
                        ui.label(theme::dim_text("ID:"));
                        ui.label(theme::secondary_text(&email.message_id));
                    });

                    ui.add_space(6.0);

                    if !email.tags.is_empty() {
                        ui.horizontal(|ui| {
                            ui.label(theme::dim_text("TAGS:"));
                            for tag in &email.tags {
                                let tag_color = theme::tag_color(tag);
                                let tag_bg = theme::tag_bg_color(tag);

                                Frame::NONE
                                    .fill(tag_bg)
                                    .inner_margin(egui::Margin::symmetric(8, 4))
                                    .corner_radius(CornerRadius::ZERO)
                                    .show(ui, |ui| {
                                        ui.label(
                                            egui::RichText::new(tag)
                                                .font(theme::mono(13.0))
                                                .color(tag_color)
                                                .strong(),
                                        );
                                    });
                            }
                        });
                    }

                    ui.add_space(12.0);
                    ui.separator();
                    ui.add_space(12.0);

                    let content: String = if state.render_html {
                        if let Some(rendered) = &email.rendered_html {
                            rendered.clone()
                        } else if !email.html_body.is_empty() {
                            // Fallback if not rendered yet (shouldn't happen often)
                            if let Some(rendered) = render_html_with_w3m(&email.html_body) {
                                rendered
                            } else {
                                email.html_body.clone()
                            }
                        } else {
                            email.body.clone()
                        }
                    } else {
                        email.body.clone()
                    };

                    for line in content.lines() {
                        if line.starts_with('>') {
                            ui.label(
                                egui::RichText::new(line)
                                    .font(theme::mono(15.0))
                                    .color(theme::TEXT_QUOTED),
                            );
                        } else {
                            ui.label(
                                egui::RichText::new(line)
                                    .font(theme::mono(15.0))
                                    .color(theme::TEXT_PRIMARY),
                            );
                        }
                    }

                    ui.add_space(20.0);
                    ui.separator();
                    ui.add_space(12.0);

                    let image_attachments: Vec<_> = email
                        .attachments
                        .iter()
                        .filter(|a| a.content_type.starts_with("image/"))
                        .collect();

                    if !image_attachments.is_empty() {
                        ui.label(theme::heading_text("IMAGES:"));
                        ui.add_space(8.0);
                        for attachment in &image_attachments {
                            ui.label(
                                egui::RichText::new(format!("[{}]", attachment.filename))
                                    .font(theme::mono(14.0))
                                    .color(theme::TEXT_DIM),
                            );
                            show_inline_image(ui, attachment);
                            ui.add_space(8.0);
                        }
                    }

                    if !email.attachments.is_empty() {
                        let other_attachments: Vec<_> = email
                            .attachments
                            .iter()
                            .filter(|a| !a.content_type.starts_with("image/"))
                            .collect();
                        if !other_attachments.is_empty() {
                            ui.add_space(12.0);
                            ui.label(theme::heading_text("ATTACHMENTS:"));
                            ui.add_space(4.0);
                            for attachment in &other_attachments {
                                ui.label(
                                    egui::RichText::new(&attachment.filename)
                                        .font(theme::mono(14.0))
                                        .color(theme::ACCENT),
                                );
                            }
                        }
                    }

                    if state.show_tag_input {
                        ui.horizontal(|ui| {
                            ui.label(theme::heading_text("ADD TAG:"));
                            let resp = ui.add(
                                egui::TextEdit::singleline(&mut state.tag_input)
                                    .font(theme::mono(14.0))
                                    .desired_width(200.0),
                            );
                            if state.focus_input {
                                resp.request_focus();
                                state.focus_input = false;
                            }
                            if ui
                                .add(
                                    egui::Button::new(theme::button_text("APPLY"))
                                        .fill(theme::BG_PANEL),
                                )
                                .clicked()
                            {
                                let tag = state.tag_input.clone();
                                if !tag.is_empty() {
                                    state.add_tag_to_selected(&tag);
                                }
                                state.show_tag_input = false;
                                state.tag_input.clear();
                            }
                            if ui
                                .add(
                                    egui::Button::new(theme::button_text("CANCEL"))
                                        .fill(theme::BG_PANEL),
                                )
                                .clicked()
                            {
                                state.show_tag_input = false;
                                state.tag_input.clear();
                            }
                        });
                        ui.add_space(12.0);
                        ui.separator();
                        ui.add_space(12.0);
                    }

                    ui.horizontal(|ui| {
                        let btn_style = |label: &str| {
                            egui::Button::new(
                                egui::RichText::new(label)
                                    .font(theme::mono(14.0))
                                    .color(theme::ACCENT)
                                    .strong(),
                            )
                            .fill(theme::BG_PANEL)
                            .stroke(egui::Stroke::new(1.0, theme::ACCENT))
                            .min_size(Vec2::new(100.0, 36.0))
                        };

                        if ui.add(btn_style("REPLY")).clicked() {
                            state.start_reply();
                        }
                        if ui.add(btn_style("FORWARD")).clicked() {
                            state.start_forward();
                        }
                        if ui.add(btn_style("TAG...")).clicked() {
                            state.show_tag_input = true;
                            state.focus_input = true;
                            state.tag_input.clear();
                        }
                    });

                    ui.add_space(12.0);
                });
        }
    }
}

fn show_inline_image(ui: &mut Ui, attachment: &crate::models::Attachment) {
    if attachment.content_type.starts_with("image/") {
        if let Ok(img) = image::load_from_memory(&attachment.data) {
            let rgba = img.to_rgba8();
            let (width, height) = (rgba.width(), rgba.height());
            let max_w = 500.0_f32;
            let max_h = 400.0_f32;
            let scale = (max_w / width as f32).min(max_h / height as f32).min(1.0);
            let display_w = (width as f32 * scale) as u32;
            let display_h = (height as f32 * scale) as u32;
            let resized =
                image::imageops::resize(&rgba, display_w, display_h, image::imageops::Nearest);
            let size = [resized.width() as usize, resized.height() as usize];
            let pixels: Vec<u8> = resized.into_raw();
            let color_image = egui::ColorImage::from_rgba_unmultiplied(size, &pixels);
            let texture =
                ui.ctx()
                    .load_texture("inline_image", color_image, egui::TextureOptions::LINEAR);
            ui.add(egui::Image::new(&texture).max_size(egui::vec2(max_w, max_h)));
        } else {
            ui.label(
                egui::RichText::new(format!("[Cannot decode image: {}]", attachment.filename))
                    .font(theme::mono(14.0))
                    .color(theme::TEXT_DIM),
            );
        }
    }
}
