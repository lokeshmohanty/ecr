use qrcode::render::unicode;
use qrcode::QrCode;

pub fn render(text: &str) -> anyhow::Result<String> {
    Ok(QrCode::new(text)?
        .render::<unicode::Dense1x2>()
        .quiet_zone(true)
        .build())
}
