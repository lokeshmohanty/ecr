mod doctor;
mod help;
mod init;
mod oauth;
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
    // Two channels are published from this repository — the newest release and
    // whatever `main` is at. They can carry the same Cargo version, so a build
    // that cannot name its own commit cannot answer "which one am I running".
    version = option_env!("ECR_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")),
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

        #[arg(
            long,
            help = "fail instead of offering to set up a missing mail configuration"
        )]
        no_init: bool,
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

    // Hidden because they are for whoever is packaging ecr, not for whoever is
    // reading mail. Every packaging path — the Nix derivation, the release
    // tarball — generates its man page and completions by running the binary it
    // just built, so the two can never describe a different command tree than
    // the one being shipped.
    #[command(about = "print a shell completion script", hide = true)]
    Completions {
        #[arg(help = "bash, elvish, fish, powershell or zsh")]
        shell: clap_complete::Shell,
    },

    #[command(about = "print this manual page in roff", hide = true)]
    Man,
}

#[derive(Subcommand)]
enum OauthCommand {
    #[command(about = "create a profile and authorize it in one step")]
    Setup {
        #[command(flatten)]
        profile: ProfileArgs,
        #[command(flatten)]
        flow: FlowArgs,
    },
    #[command(about = "create a profile without authorizing it")]
    Init {
        #[command(flatten)]
        profile: ProfileArgs,
    },
    #[command(about = "run the browser flow and store a refresh token")]
    Authorize {
        profile: String,
        #[command(flatten)]
        flow: FlowArgs,
    },
    #[command(about = "print a valid access token, refreshing it if needed")]
    Token { profile: String },
    #[command(about = "print the base64 XOAUTH2 string IMAP and SMTP want")]
    Xoauth2 { profile: String },
    #[command(about = "report a profile's provider, address and token expiry")]
    Status { profile: String },
    #[command(name = "client-id", about = "print a built-in OAuth client id")]
    ClientId {
        #[command(flatten)]
        client: ClientArgs,
    },
    #[command(name = "client-secret", about = "print a built-in OAuth client secret")]
    ClientSecret {
        #[command(flatten)]
        client: ClientArgs,
    },
}

#[derive(clap::Args)]
struct ProfileArgs {
    #[arg(help = "name for the profile; mbsync and msmtp refer to it by this")]
    profile: String,

    // No default. Both providers are plausible for any address, and guessing
    // wrong is not discovered until a browser flow has already been walked
    // through and the resulting token fails against the real server.
    #[arg(
        long,
        required = true,
        help = "gmail for Google accounts, microsoft for Outlook and Microsoft 365"
    )]
    provider: String,

    #[arg(long, required = true, help = "the address this profile authenticates")]
    email: String,

    #[arg(
        long,
        help = "built-in client preset to borrow; defaults to thunderbird"
    )]
    client: Option<String>,

    #[arg(long, help = "your own OAuth client id, instead of a preset")]
    client_id: Option<String>,

    #[arg(long, help = "your own OAuth client secret")]
    client_secret: Option<String>,

    #[arg(long, help = "Microsoft tenant; defaults to common")]
    tenant: Option<String>,

    #[arg(long, help = "override the requested scopes; repeatable")]
    scope: Vec<String>,

    #[arg(
        long,
        help = "loopback port for the browser callback; defaults to a free one"
    )]
    redirect_port: Option<u16>,

    #[arg(long, help = "replace an existing profile, discarding its tokens")]
    force: bool,
}

#[derive(clap::Args)]
struct FlowArgs {
    #[arg(
        long,
        default_value = "auto",
        help = "auto, authcode or device. auto takes the device flow where the provider offers one"
    )]
    flow: String,

    #[arg(
        long,
        default_value_t = 300,
        help = "seconds to wait for authorization"
    )]
    timeout: u64,

    #[arg(long, help = "print the URL instead of opening a browser")]
    no_open: bool,
}

#[derive(clap::Args)]
struct ClientArgs {
    #[arg(long, required = true, help = "gmail or microsoft")]
    provider: String,

    #[arg(long, help = "built-in client preset; defaults to thunderbird")]
    client: Option<String>,
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
            no_init,
        } => {
            serve::run(serve::Options {
                bind,
                read_only,
                no_watch,
                allowed_origins: allowed_origin,
                web_dir,
                token_path,
                no_init,
            })
            .await
        }

        Command::Token { command } => match command {
            TokenCommand::New { name, qr } => token::new(&token_path, &name, qr),
            TokenCommand::List => token::list(&token_path),
            TokenCommand::Revoke { name } => token::revoke(&token_path, &name),
        },

        Command::Help { topic } => help::run(topic.as_deref()),

        Command::Completions { shell } => {
            let mut command = <Cli as clap::CommandFactory>::command();
            clap_complete::generate(shell, &mut command, "ecr", &mut std::io::stdout());
            Ok(())
        }

        Command::Man => {
            clap_mangen::Man::new(<Cli as clap::CommandFactory>::command())
                .render(&mut std::io::stdout())?;
            Ok(())
        }

        Command::Init { force } => init::run(force).await,
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
        Command::Oauth { command } => match command {
            OauthCommand::Setup { profile, flow } => {
                oauth::setup(profile.into(), flow.try_into()?).await
            }
            OauthCommand::Init { profile } => oauth::init(profile.into()).await,
            OauthCommand::Authorize { profile, flow } => {
                oauth::authorize(&profile, flow.try_into()?).await
            }
            OauthCommand::Token { profile } => oauth::token(&profile).await,
            OauthCommand::Xoauth2 { profile } => oauth::xoauth2(&profile).await,
            OauthCommand::Status { profile } => oauth::status(&profile),
            OauthCommand::ClientId { client } => {
                oauth::client_id(&client.provider, client.client.as_deref())
            }
            OauthCommand::ClientSecret { client } => {
                oauth::client_secret(&client.provider, client.client.as_deref())
            }
        },
    }
}

impl From<ProfileArgs> for oauth::Init {
    fn from(args: ProfileArgs) -> Self {
        oauth::Init {
            profile: args.profile,
            provider: args.provider,
            email: args.email,
            client: args.client,
            client_id: args.client_id,
            client_secret: args.client_secret,
            tenant: args.tenant,
            scope: args.scope,
            redirect_port: args.redirect_port,
            force: args.force,
        }
    }
}

impl TryFrom<FlowArgs> for oauth::Authorize {
    type Error = anyhow::Error;

    fn try_from(args: FlowArgs) -> anyhow::Result<Self> {
        Ok(oauth::Authorize {
            flow: match args.flow.as_str() {
                "auto" => ecr_store::oauth::Flow::Auto,
                "authcode" => ecr_store::oauth::Flow::AuthCode,
                "device" => ecr_store::oauth::Flow::Device,
                other => anyhow::bail!("unknown flow {other:?}; use auto, authcode or device"),
            },
            timeout: args.timeout,
            no_open: args.no_open,
        })
    }
}

fn not_yet(what: &str, meanwhile: &str) -> anyhow::Result<()> {
    anyhow::bail!("{what}.\n\n  {meanwhile}\n")
}
