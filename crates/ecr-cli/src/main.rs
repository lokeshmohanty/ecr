mod doctor;
mod help;
mod qr;
mod serve;
mod token;

use clap::{Parser, Subcommand};
use ecr_server::auth::TokenStore;
use std::net::SocketAddr;
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "ecr",
    about = "a mail client",
    version,
    disable_help_subcommand = true,
    after_help = "Run `ecr help` for worked examples."
)]
struct Cli {
    #[arg(long, global = true, help = "path to the device token store")]
    tokens: Option<PathBuf>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "set up the mail configuration, adopting whatever already exists")]
    Init {
        #[arg(long, help = "regenerate the files ecr owns, backing up what is there")]
        force: bool,
    },

    #[command(about = "report on the mail setup and name the fix for anything broken")]
    Doctor {
        #[arg(long)]
        json: bool,
    },

    #[command(about = "run the server")]
    Serve {
        #[arg(long, default_value = "127.0.0.1:8383")]
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

        #[arg(
            long,
            help = "directory holding the built web client; found automatically if omitted"
        )]
        web_dir: Option<PathBuf>,
    },

    #[command(about = "stop the server running in the background")]
    Stop,

    #[command(about = "report whether the server is running")]
    Status,

    #[command(about = "restart the server running in the background")]
    Restart,

    #[command(about = "show the server's log")]
    Logs {
        #[arg(short, long, help = "keep printing as the log grows")]
        follow: bool,

        #[arg(short = 'n', long, default_value_t = 200, help = "lines to show")]
        lines: usize,
    },

    #[command(about = "open the web client in a browser, starting a server if none is running")]
    Web,

    #[command(about = "print a QR code that pairs a phone with this server")]
    Qr {
        #[arg(default_value = "phone", help = "name recorded for the device")]
        name: String,
    },

    #[command(about = "authorize and refresh OAuth tokens for Gmail and Outlook")]
    Oauth {
        #[command(subcommand)]
        command: OauthCommand,
    },

    #[command(about = "issue, list and revoke device tokens")]
    Token {
        #[command(subcommand)]
        command: TokenCommand,
    },

    #[command(about = "worked examples, organised by what you are trying to do")]
    Help {
        #[arg(help = "one of: start, phone, autostart, accounts, trouble")]
        topic: Option<String>,
    },
}

#[derive(Subcommand)]
enum OauthCommand {
    #[command(about = "run the browser flow and store a refresh token")]
    Authorize { profile: String },
    #[command(about = "print a valid access token, refreshing it if needed")]
    Token { profile: String },
    #[command(about = "print the base64 XOAUTH2 string IMAP and SMTP want")]
    Xoauth2 { profile: String },
    #[command(about = "report a profile's provider, address and token expiry")]
    Status { profile: String },
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
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ecr_server=info,ecr_store=info,tower_http=warn".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    if let Err(err) = dispatch().await {
        // The dev shell sets RUST_BACKTRACE=1, which would otherwise attach a
        // stack trace to every operational error. What went wrong is the
        // useful part; the frames are not.
        eprintln!("\nerror: {err}");
        for cause in err.chain().skip(1) {
            eprintln!("  caused by: {cause}");
        }
        std::process::exit(1);
    }
}

async fn dispatch() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let token_path = cli.tokens.unwrap_or_else(TokenStore::default_path);

    let Some(command) = cli.command else {
        return not_yet(
            "the desktop client is not wired up yet",
            "Run `ecr web` to open the client in a browser.",
        );
    };

    match command {
        Command::Doctor { json } => doctor::run(json).await,

        Command::Serve {
            bind,
            read_only,
            no_watch,
            allowed_origin,
            web_dir,
        } => {
            serve::run(serve::Options {
                bind,
                read_only,
                no_watch,
                allowed_origins: allowed_origin,
                web_dir,
                token_path,
            })
            .await
        }

        Command::Token { command } => match command {
            TokenCommand::New { name, qr } => token::new(&token_path, &name, qr),
            TokenCommand::List => token::list(&token_path),
            TokenCommand::Revoke { name } => token::revoke(&token_path, &name),
        },

        Command::Help { topic } => help::run(topic.as_deref()),

        Command::Init { .. } => not_yet(
            "`ecr init` is not implemented yet",
            "Set up notmuch, mbsync and msmtp by hand, then run `ecr doctor`.",
        ),
        Command::Stop | Command::Status | Command::Restart => not_yet(
            "the server does not run in the background yet",
            "Run `ecr serve` in a terminal; ctrl-c stops it.",
        ),
        Command::Logs { .. } => not_yet(
            "`ecr logs` is not implemented yet",
            "`ecr serve` logs to stderr; RUST_LOG controls the level.",
        ),
        Command::Web => not_yet(
            "`ecr web` is not implemented yet",
            "Run `ecr serve` and open the address it prints.",
        ),
        Command::Qr { .. } => not_yet(
            "`ecr qr` is not implemented yet",
            "`ecr token new <name> --qr` prints a token and a QR code.",
        ),
        Command::Oauth { .. } => not_yet(
            "`ecr oauth` is not implemented yet",
            "Use `oauthman` directly; ecr reads the profiles it writes.",
        ),
    }
}

fn not_yet(what: &str, meanwhile: &str) -> anyhow::Result<()> {
    anyhow::bail!("{what}.\n\n  {meanwhile}\n")
}
