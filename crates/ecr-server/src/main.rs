use clap::{Parser, Subcommand};
use ecr_server::auth::TokenStore;
use ecr_server::state::AppState;
use ecr_server::{app, watcher};
use ecr_store::NotmuchStore;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser)]
#[command(name = "ecr-server", about = "ecr mail server", version)]
struct Cli {
    #[arg(long, global = true, help = "path to the device token store")]
    tokens: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long, default_value = "127.0.0.1:8080")]
        bind: SocketAddr,

        #[arg(long, help = "refuse every write: no tagging, syncing or sending")]
        read_only: bool,

        #[arg(long, help = "do not watch the maildir for delivered mail")]
        no_watch: bool,

        #[arg(
            long,
            help = "restrict browser origins; repeatable. Default allows any, because auth is a bearer token and no cookies are used"
        )]
        allowed_origin: Vec<String>,
    },
    Doctor {
        #[arg(long)]
        json: bool,
    },
    Token {
        #[command(subcommand)]
        command: TokenCommand,
    },
}

#[derive(Subcommand)]
enum TokenCommand {
    New {
        name: String,
        #[arg(long, help = "also print a QR code for pairing a phone")]
        qr: bool,
    },
    List,
    Revoke {
        name: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ecr_server=info,ecr_store=info,tower_http=warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let token_path = cli.tokens.unwrap_or_else(TokenStore::default_path);

    match cli.command {
        Command::Serve {
            bind,
            read_only,
            no_watch,
            allowed_origin,
        } => serve(bind, read_only, no_watch, allowed_origin, &token_path).await,
        Command::Doctor { json } => doctor(json).await,
        Command::Token { command } => token(command, &token_path),
    }
}

async fn serve(
    bind: SocketAddr,
    read_only: bool,
    no_watch: bool,
    allowed_origins: Vec<String>,
    token_path: &std::path::Path,
) -> anyhow::Result<()> {
    let store = Arc::new(NotmuchStore::open()?);

    let report = ecr_store::doctor::run_with_paths(store.paths()).await;
    if !report.is_healthy() {
        eprintln!("{}", ecr_store::doctor::render(&report));
        anyhow::bail!("refusing to start: the mail setup is not healthy");
    }

    let tokens = TokenStore::load(token_path)?;
    if tokens.is_empty() {
        tracing::warn!(
            "no device tokens exist, so the API is unauthenticated; run `ecr-server token new <name>`"
        );
    }

    let state = AppState::new(Arc::clone(&store), tokens, read_only);

    let _watcher = if no_watch {
        None
    } else {
        match watcher::spawn(state.clone()) {
            Ok(watcher) => Some(watcher),
            Err(err) => {
                tracing::warn!(%err, "could not watch the maildir; new mail will need a manual sync");
                None
            }
        }
    };

    let listener = tokio::net::TcpListener::bind(bind).await?;
    let accounts = report.accounts.len();

    tracing::info!(
        %bind,
        accounts,
        read_only,
        "ecr-server listening"
    );

    let cors = (!allowed_origins.is_empty()).then_some(allowed_origins);
    axum::serve(listener, app::router_with_cors(state, cors))
        .with_graceful_shutdown(shutdown())
        .await?;

    Ok(())
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
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

fn token(command: TokenCommand, path: &std::path::Path) -> anyhow::Result<()> {
    let mut store = TokenStore::load(path)?;

    match command {
        TokenCommand::New { name, qr } => {
            let token = store.issue(&name)?;
            store.save(path)?;

            println!("{token}");
            eprintln!();
            eprintln!("Saved as \"{name}\" in {}.", path.display());
            eprintln!("This is the only time the token is shown.");

            if qr {
                eprintln!();
                eprintln!("{}", qr_code(&token)?);
            }
        }
        TokenCommand::List => {
            if store.is_empty() {
                println!("no device tokens; the API is unauthenticated");
            }
            for token in &store.tokens {
                println!("{}\t{}", token.name, token.created);
            }
        }
        TokenCommand::Revoke { name } => {
            if store.revoke(&name) {
                store.save(path)?;
                println!("revoked {name}");
            } else {
                anyhow::bail!("no token named {name}");
            }
        }
    }
    Ok(())
}

fn qr_code(text: &str) -> anyhow::Result<String> {
    use qrcode::render::unicode;
    use qrcode::QrCode;

    Ok(QrCode::new(text)?
        .render::<unicode::Dense1x2>()
        .quiet_zone(true)
        .build())
}
