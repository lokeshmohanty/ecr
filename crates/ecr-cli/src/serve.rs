use ecr_server::auth::TokenStore;
use ecr_server::state::AppState;
use ecr_server::{app, watcher};
use ecr_store::NotmuchStore;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

pub struct Options {
    pub bind: SocketAddr,
    pub read_only: bool,
    pub no_watch: bool,
    pub allowed_origins: Vec<String>,
    pub web_dir: Option<PathBuf>,
    pub token_path: PathBuf,
    pub no_init: bool,
}

pub async fn run(options: Options) -> anyhow::Result<()> {
    let Options {
        bind,
        read_only,
        no_watch,
        allowed_origins,
        web_dir,
        token_path,
        no_init,
    } = options;

    // A machine with no mail configuration cannot be served, and until now that
    // was the end of it: `NotmuchStore::open` failed naming every path it had
    // looked in, which tells you what is missing and nothing about how to make
    // it. Init is offered here instead, before the store is opened, and it asks
    // before it writes anything. `--no-init` is the way back to refusing.
    //
    // It does not make a fresh machine servable on its own, and is not meant to:
    // an empty maildir has no accounts, which doctor calls a failure below. What
    // it removes is the step where the reader has to compose a notmuch config by
    // hand before anything can even be diagnosed.
    if !no_init && !crate::init::is_configured() {
        crate::init::ensure().await?;
    }

    let store = Arc::new(NotmuchStore::open()?);

    let report = ecr_store::doctor::run_with_paths(store.paths()).await;
    if !report.is_healthy() {
        eprintln!("{}", ecr_store::doctor::render(&report));
        anyhow::bail!("refusing to start: the mail setup is not healthy");
    }

    let tokens = TokenStore::load(&token_path)?;
    if tokens.is_empty() {
        tracing::warn!(
            "no device tokens exist, so the API is unauthenticated; run `ecr token new <name>`"
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

    // A busy port is an ordinary, user-fixable situation. Reporting it as a
    // panic with a full backtrace buries the one line that matters.
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|err| match err.kind() {
            std::io::ErrorKind::AddrInUse => anyhow::anyhow!(
                "{bind} is already in use.\n\
                 Something else is listening there. Either stop it, or choose \
                 another address:\n    \
                 ecr serve --bind 127.0.0.1:8384"
            ),
            std::io::ErrorKind::PermissionDenied => {
                anyhow::anyhow!("not allowed to bind {bind} (ports below 1024 need root)")
            }
            std::io::ErrorKind::AddrNotAvailable => anyhow::anyhow!(
                "{bind} is not an address on this machine; check the interface is up"
            ),
            _ => anyhow::anyhow!("could not bind {bind}: {err}"),
        })?;

    let web = ecr_server::web::locate(web_dir);
    let accounts = report.accounts.len();

    eprintln!();
    eprintln!("  ecr is running");
    eprintln!("    open      http://{bind}");
    eprintln!("    accounts  {accounts}");
    if read_only {
        eprintln!("    mode      read-only (no tagging, syncing or sending)");
    }
    match &web {
        Some(dir) => eprintln!("    client    {}", dir.display()),
        None => eprintln!(
            "    client    not built — run `just build-web`, or `just dev` for hot reload"
        ),
    }
    eprintln!();

    let cors = (!allowed_origins.is_empty()).then_some(allowed_origins);
    app::serve(listener, state, cors, web.as_deref()).await
}
