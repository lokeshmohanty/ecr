use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "ecr-server", about = "ecr mail server")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Doctor {
        #[arg(long)]
        json: bool,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ecr_server=info,ecr_store=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    match Cli::parse().command {
        Command::Doctor { json } => doctor(json).await,
    }
}

async fn doctor(json: bool) -> anyhow::Result<()> {
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
