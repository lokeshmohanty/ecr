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

    // With the file it came from: `ecr token new` runs in another process while
    // this one is serving, and a token nobody can use until the server is
    // restarted is indistinguishable from a token the server rejected.
    let state = AppState::new(Arc::clone(&store), tokens, read_only).with_token_file(token_path);

    // Alongside the server, not before it. A first build of a large maildir
    // takes over a minute, and holding the listener until it finished would
    // make a first start look hung — while the index it is waiting for saves,
    // at most, tens of milliseconds a request. Reads fall through to notmuch
    // until it is ready, which is exactly what they did before it existed.
    tokio::spawn({
        let store = Arc::clone(&store);
        async move {
            build_the_index(&store).await;
            // After the index, never beside it: a preview is read from the
            // message file, and doing that while the index is still being
            // built would have both competing for the same disk.
            fill_the_previews(store);
        }
    });

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

    // The only thing that puts mail on the wire. Everything a reader sends goes
    // into the outbox first, so this runs even under --no-watch: not watching
    // for *incoming* mail is not a reason to stop sending.
    let _drain = ecr_server::drain::spawn(state.clone());

    // Held for as long as the server runs; dropping the set aborts the watches.
    // It is layered *above* the maildir watcher rather than replacing it: this
    // says "go and look", the sync fetches, and the watcher is what notices what
    // landed. So a server with no managed account, or one whose IMAP connection
    // keeps dropping, behaves exactly as it did before this existed.
    let _idle = if no_watch {
        None
    } else {
        ecr_server::idle::spawn(state.clone())
    };

    // Push only ever hears about the inbox, so this is the only thing that
    // reconciles the folders a reader changes somewhere else. It is held for as
    // long as the server runs, and skipped under --no-watch for the same reason
    // the others are: that flag means "do not go looking on your own".
    let _periodic = if no_watch {
        None
    } else {
        ecr_server::periodic::spawn(state.clone())
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

/// The index is a cache, so a failure here is reported and then ignored: the
/// server runs without it and every read asks notmuch, which is what it did
/// before the index existed.
async fn build_the_index(store: &NotmuchStore) {
    match store.refresh_index().await {
        Ok(Some(built)) => {
            let what = if built.rebuilt { "built" } else { "caught up" };
            tracing::info!(
                messages = built.messages,
                took_ms = built.took.as_millis() as u64,
                "mail index {what}"
            );
        }
        Ok(None) => tracing::info!("the mail index is off; every read will ask notmuch"),
        Err(err) => {
            tracing::warn!(%err, "could not build the mail index; every read will ask notmuch")
        }
    }
}

/// Fills in the list previews, behind the server rather than in front of it.
///
/// Yields between batches so this never competes with a request: it is a line
/// of text under each subject, and no reader is waiting for it. It ends when
/// there is nothing left, and starts again from wherever it stopped if the
/// server is restarted halfway.
fn fill_the_previews(store: std::sync::Arc<NotmuchStore>) {
    tokio::spawn(async move {
        let mut filled = 0usize;
        loop {
            let store = std::sync::Arc::clone(&store);
            // A blocking read of many files, off the async threads.
            let batch = tokio::task::spawn_blocking(move || store.fill_snippets()).await;

            match batch {
                Ok(Ok(0)) => break,
                Ok(Ok(count)) => filled += count,
                Ok(Err(err)) => {
                    tracing::debug!(%err, "could not fill list previews");
                    break;
                }
                Err(_) => break,
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        if filled > 0 {
            tracing::info!(messages = filled, "list previews filled");
        }
    });
}
