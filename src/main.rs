use ecr::app::EmailApp;

fn main() -> Result<(), eframe::Error> {
    let args: Vec<String> = std::env::args().collect();
    let snapshot_mode = args.contains(&"--snapshot".to_string());

    tracing_subscriber::fmt::init();
    tracing::info!("Starting ECR Email Client");
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 800.0])
            .with_title("Email Client in Rust (ecr)"),
        ..Default::default()
    };

    eframe::run_native(
        "Email Client in Rust (ecr)",
        options,
        Box::new(move |cc| {
            let app = EmailApp::new(cc, snapshot_mode);
            Ok(Box::new(app))
        }),
    )
}
