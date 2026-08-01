pub async fn run(json: bool) -> anyhow::Result<()> {
    let report = ecr_store::doctor::run().await;

    if json {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        print!("{}", ecr_store::doctor::render(&report));
    }

    if !report.is_healthy() {
        std::process::exit(1);
    }
    Ok(())
}
