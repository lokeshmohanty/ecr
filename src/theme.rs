// Theme and styling for the "Tokyo Night" aesthetic
use egui::{Color32, CornerRadius, FontFamily, FontId, Margin, RichText, Stroke};

// ── Color palette (Tokyo Night - Night variant) ────────────────────────
pub const BG_MAIN: Color32 = Color32::from_rgb(26, 27, 38); // main bg
pub const BG_PANEL: Color32 = Color32::from_rgb(22, 22, 30); // sidebar bg
pub const BG_HOVER: Color32 = Color32::from_rgb(41, 46, 66); // highlight bg
pub const BG_SELECTED: Color32 = Color32::from_rgb(51, 70, 124); // selection bg
pub const BG_INPUT: Color32 = Color32::from_rgb(21, 22, 30); // terminal black
pub const BG_TAG: Color32 = Color32::from_rgb(31, 35, 53); // statusline bg
pub const BG_TAG_URGENT: Color32 = Color32::from_rgb(73, 30, 45); // dim red bg

pub const ACCENT: Color32 = Color32::from_rgb(122, 162, 247); // blue (7aa2f7)
pub const ACCENT_DIM: Color32 = Color32::from_rgb(125, 207, 255); // cyan (7dcfff)
pub const TEXT_PRIMARY: Color32 = Color32::from_rgb(192, 202, 245); // foreground (c0caf5)
pub const TEXT_SECONDARY: Color32 = Color32::from_rgb(154, 171, 235); // lighter blue-gray
pub const TEXT_DIM: Color32 = Color32::from_rgb(86, 95, 137); // comments (565f89)
pub const TEXT_QUOTED: Color32 = Color32::from_rgb(158, 206, 106); // green (9ece6a)
pub const BORDER: Color32 = Color32::from_rgb(41, 46, 66); // ui border (292e42)
pub const TAG_UNREAD: Color32 = Color32::from_rgb(158, 206, 106); // green (9ece6a)
pub const TAG_URGENT: Color32 = Color32::from_rgb(247, 118, 142); // red (f7768e)
pub const TAG_DEFAULT: Color32 = Color32::from_rgb(187, 154, 247); // magenta (bb9af7)

pub const TEXT_ON_ACCENT: Color32 = Color32::from_rgb(26, 27, 38); // BG_MAIN
pub const STAR_COLOR: Color32 = Color32::from_rgb(224, 175, 104); // yellow (e0af68)

// ── Font helpers ───────────────────────────────────────────────────────
pub fn mono(size: f32) -> FontId {
    FontId::new(size, FontFamily::Monospace)
}

// ── RichText builders ──────────────────────────────────────────────────
pub fn accent_text(s: &str) -> RichText {
    RichText::new(s).font(mono(16.0)).color(ACCENT)
}

pub fn heading_text(s: &str) -> RichText {
    RichText::new(s).font(mono(14.0)).color(ACCENT).strong()
}

pub fn section_label(s: &str) -> RichText {
    RichText::new(s).font(mono(12.0)).color(TEXT_DIM)
}

pub fn primary_text(s: &str) -> RichText {
    RichText::new(s).font(mono(15.0)).color(TEXT_PRIMARY)
}

pub fn secondary_text(s: &str) -> RichText {
    RichText::new(s).font(mono(14.0)).color(TEXT_SECONDARY)
}

pub fn dim_text(s: &str) -> RichText {
    RichText::new(s).font(mono(14.0)).color(TEXT_DIM)
}

pub fn body_text(s: &str) -> RichText {
    RichText::new(s).font(mono(15.0)).color(TEXT_PRIMARY)
}

pub fn button_text(s: &str) -> RichText {
    RichText::new(s).font(mono(14.0)).color(ACCENT).strong()
}

pub fn tag_color(tag: &str) -> Color32 {
    match tag.to_uppercase().as_str() {
        "URGENT" => TAG_URGENT,
        "UNREAD" => TAG_UNREAD,
        _ => TAG_DEFAULT,
    }
}

pub fn tag_bg_color(tag: &str) -> Color32 {
    match tag.to_uppercase().as_str() {
        "URGENT" => BG_TAG_URGENT,
        _ => BG_TAG,
    }
}

// ── Apply console theme to egui context ────────────────────────────────
pub fn apply_theme(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();

    // Use Cascadia Code
    fonts.font_data.insert(
        "CascadiaCode".to_owned(),
        egui::FontData::from_static(include_bytes!("../assets/CascadiaCode.ttf")).into(),
    );

    // Set as the first choice for both Proportional and Monospace
    fonts
        .families
        .get_mut(&FontFamily::Proportional)
        .unwrap()
        .insert(0, "CascadiaCode".to_owned());

    fonts
        .families
        .get_mut(&FontFamily::Monospace)
        .unwrap()
        .insert(0, "CascadiaCode".to_owned());

    ctx.set_fonts(fonts);

    let mut visuals = egui::Visuals::dark();

    // Window / panel backgrounds
    visuals.window_fill = BG_PANEL;
    visuals.panel_fill = BG_MAIN;
    visuals.faint_bg_color = BG_HOVER;
    visuals.extreme_bg_color = BG_INPUT;

    // Text
    visuals.override_text_color = Some(TEXT_PRIMARY);

    // Widgets
    let corner_radius = CornerRadius::from(6);
    visuals.widgets.noninteractive.bg_fill = BG_PANEL;
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT_SECONDARY);
    visuals.widgets.noninteractive.corner_radius = corner_radius;
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, BORDER);

    visuals.widgets.inactive.bg_fill = BG_PANEL;
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, TEXT_PRIMARY);
    visuals.widgets.inactive.corner_radius = corner_radius;

    visuals.widgets.hovered.bg_fill = BG_HOVER;
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, ACCENT);
    visuals.widgets.hovered.corner_radius = corner_radius;

    visuals.widgets.active.bg_fill = BG_SELECTED;
    visuals.widgets.active.fg_stroke = Stroke::new(1.0, ACCENT);
    visuals.widgets.active.corner_radius = corner_radius;

    // Selection
    visuals.selection.bg_fill = BG_SELECTED;
    visuals.selection.stroke = Stroke::new(1.0, ACCENT);

    // Misc
    visuals.window_corner_radius = corner_radius;
    visuals.menu_corner_radius = CornerRadius::from(4);
    visuals.window_stroke = Stroke::new(1.0, BORDER);
    visuals.resize_corner_size = 6.0;

    ctx.set_visuals(visuals);

    // Style adjustments
    let mut style = (*ctx.style()).clone();

    // Explicitly set font families for all styles to ensure Cascadia is used
    for font_id in style.text_styles.values_mut() {
        font_id.family = FontFamily::Monospace;
    }

    style.spacing.item_spacing = egui::vec2(10.0, 8.0);
    style.spacing.window_margin = Margin::same(12);
    style.spacing.button_padding = egui::vec2(12.0, 6.0);
    style.spacing.indent = 20.0;
    ctx.set_style(style);
}
