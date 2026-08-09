//! The managed-account routes.
//!
//! Kept apart from `routes.rs` because these are the only ones that reconfigure
//! *how mail is fetched* rather than reading or tagging it, and they carry a
//! restriction the rest do not: a password command is arbitrary code, and a
//! device that can pair with this server must not be able to make the server run
//! something of its choosing. Those arrive from the CLI or not at all.

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{ConnectInfo, Path, State};
use axum::Json;
use ecr_core::doctor::ConfigKind;
use ecr_core::managed::{Auth, ManagedAccount, ManagedAccounts};
use ecr_store::managed::accounts::{self, Accounts, State as FileState};
use ecr_store::oauth::{self, Profiles, TokenState};
use ecr_store::packages::{Management, Packages};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::net::SocketAddr;

/// Whether a caller is on the machine this server runs on.
///
/// Loopback is the whole test, and it is the right one rather than a cheap one:
/// what the OAuth routes need to know is not "is this device trusted" — the
/// bearer token already answered that — but "will a browser here receive a
/// redirect to this machine's `127.0.0.1`". Only a caller on this machine will.
fn is_local(peer: SocketAddr) -> bool {
    peer.ip().is_loopback()
}

/// The OAuth state of every account that authenticates with one.
fn auth_views(accounts: &ManagedAccounts, profiles: &Profiles) -> BTreeMap<String, AuthView> {
    accounts
        .iter()
        .filter_map(|(id, account)| {
            let Auth::Oauth { profile } = &account.auth else {
                return None;
            };

            let token = match oauth::token_state(profiles, profile) {
                TokenState::Valid { .. } => "valid".to_string(),
                TokenState::Refreshable => "refreshable".to_string(),
                TokenState::Expired => "expired".to_string(),
                TokenState::Unknown(why) => why,
            };

            // The scopes on disk, not the ones a provider would ask for today:
            // what decides whether sync-dav works is what this profile was
            // actually authorized with. And the *profile's* provider, not the
            // account's — `gmail`/`microsoft` name OAuth endpoints, while
            // `Provider::Outlook` names a set of folder and server presets, and
            // asking one for the other's key silently answers "no scopes".
            let config = profiles.load_config(profile).ok();
            let granted = config
                .as_ref()
                .map(|config| config.scopes.clone())
                .unwrap_or_default();
            let wanted = config
                .as_ref()
                .map(|config| oauth::providers::dav_scopes(&config.provider))
                .unwrap_or_default();

            Some((
                id.clone(),
                AuthView {
                    profile: profile.clone(),
                    token,
                    dav: !wanted.is_empty() && wanted.iter().all(|s| granted.contains(s)),
                    dav_available: !wanted.is_empty()
                        && (account.provider.carddav_url(&account.address).is_some()
                            || account.provider.caldav_url(&account.address).is_some()),
                },
            ))
        })
        .collect()
}

#[derive(Serialize)]
pub struct ManagedView {
    /// Which tools ecr is generating configuration for. Empty means managed mode
    /// is off, which is a state the client has to be able to show rather than an
    /// error.
    pub managing: Vec<String>,
    pub path: String,
    pub maildir: Option<String>,
    pub accounts: ManagedAccounts,
    pub files: Vec<FileView>,
    /// Anything that would stop `apply` from working, in the reader's words.
    pub problems: Vec<String>,
    /// The OAuth state of each account that has any, keyed by account id.
    pub auth: BTreeMap<String, AuthView>,
    /// Whether this caller is on the machine the server runs on.
    ///
    /// The client shows the authorize buttons only when it is, because the flow
    /// they start redirects to this machine's loopback: a phone that follows the
    /// link consents perfectly and then waits forever for a callback that is
    /// being delivered somewhere it cannot see. A button that cannot work is
    /// worse than an absent one — it reads as ecr being broken rather than as
    /// this being a thing to do at the desk.
    pub local: bool,
}

#[derive(Serialize)]
pub struct FileView {
    pub kind: String,
    pub path: String,
    pub state: &'static str,
}

/// What the settings page needs to say about one account's token.
#[derive(Serialize)]
pub struct AuthView {
    pub profile: String,
    /// `valid`, `refreshable`, `expired`, or why it could not be read.
    pub token: String,
    /// Whether the profile already asks for contacts and calendars. This is the
    /// difference between "sync-dav needs one trip through the browser" and
    /// "sync-dav's 403 is about something else", and the button says which.
    pub dav: bool,
    /// Whether the provider has DAV to offer at all. Microsoft retired it, so
    /// for an Outlook account there is nothing to enable and the button is not
    /// drawn rather than drawn and refused.
    pub dav_available: bool,
}

/// A password command is a command this server would run. Over HTTP that is
/// remote code execution wearing a mail client's clothes, and no amount of
/// bearer token makes it a reasonable thing to accept — the token is on a phone
/// in somebody's pocket. The CLI has a terminal and a person at it.
fn reject_command_auth(account: &ManagedAccount) -> ApiResult<()> {
    match account.auth {
        Auth::Command { .. } => Err(ApiError::BadRequest(
            "a password command can only be set with `ecr account`, at a terminal: it is a \
             command this server would run, and that is not something to accept over the \
             network"
                .to_string(),
        )),
        Auth::Oauth { .. } => Ok(()),
    }
}

fn reject_if_read_only(state: &AppState) -> ApiResult<()> {
    if state.read_only {
        return Err(ApiError::BadRequest(
            "the server is running in --read-only mode".to_string(),
        ));
    }
    Ok(())
}

/// Everything managed mode reads or writes is anchored to the `MailPaths` the
/// server was opened with, never to the process environment. `dirs::config_dir()`
/// answers the real `~/.config` however `HOME` is pointed — which in a rooted
/// test means writing the developer's own settings file, and these routes write.
fn load(state: &AppState) -> ApiResult<(Accounts, Packages)> {
    let paths = state.store.paths();
    let accounts = Accounts::load_from(&paths.accounts_file()).map_err(ApiError::from)?;
    Ok((accounts, Packages::load_from(&paths.settings_file())))
}

pub async fn view(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<ManagedView>> {
    build(&state, is_local(peer))
}

/// Every route answers with the whole view, so each one needs to know whether
/// its caller was local. Threading it rather than recomputing keeps one answer
/// per request: a mutation and the view it returns cannot disagree about who
/// asked.
fn build(state: &AppState, local: bool) -> ApiResult<Json<ManagedView>> {
    let (accounts, packages) = load(state)?;
    let paths = state.store.paths();

    let managing: Vec<String> = [ConfigKind::Notmuch, ConfigKind::Mbsync, ConfigKind::Msmtp]
        .into_iter()
        .filter(|kind| packages.is_managed(*kind))
        .map(|kind| kind.to_string())
        .collect();

    let files = match accounts.layout_at(&paths.managed_dir()) {
        Ok(layout) => accounts::plan(&accounts.accounts, &layout, &packages)
            .into_iter()
            .map(|rendered| FileView {
                kind: rendered.kind.to_string(),
                path: rendered.path.display().to_string(),
                state: match rendered.state() {
                    FileState::Current => "current",
                    FileState::Missing => "missing",
                    FileState::Stale => "stale",
                    FileState::EditedByHand => "edited",
                },
            })
            .collect(),
        Err(_) => Vec::new(),
    };

    Ok(Json(ManagedView {
        managing,
        path: accounts.path.display().to_string(),
        maildir: accounts
            .accounts
            .maildir
            .as_ref()
            .map(|p| p.display().to_string()),
        problems: accounts.problems(),
        auth: auth_views(&accounts.accounts, &paths.oauth_profiles()),
        local,
        accounts: accounts.accounts,
        files,
    }))
}

#[derive(Deserialize)]
pub struct AccountUpdate {
    pub id: String,
    #[serde(flatten)]
    pub account: ManagedAccount,
}

pub async fn create(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(update): Json<AccountUpdate>,
) -> ApiResult<Json<ManagedView>> {
    reject_if_read_only(&state)?;
    reject_command_auth(&update.account)?;

    let (mut accounts, _) = load(&state)?;
    if accounts.accounts.accounts.contains_key(&update.id) {
        return Err(ApiError::BadRequest(format!(
            "an account named {:?} is already there",
            update.id
        )));
    }
    write(&state, &mut accounts, update)?;
    build(&state, is_local(peer))
}

pub async fn update(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Json(mut update): Json<AccountUpdate>,
) -> ApiResult<Json<ManagedView>> {
    reject_if_read_only(&state)?;
    reject_command_auth(&update.account)?;

    let (mut accounts, _) = load(&state)?;
    let Some(existing) = accounts.accounts.accounts.get(&id) else {
        return Err(ApiError::BadRequest(format!("no account named {id:?}")));
    };

    // An account authenticating with a command keeps it. Rejecting the whole
    // edit would leave such an account uneditable from the client — including
    // its address and its folders, which have nothing to do with the secret.
    if let Auth::Command { .. } = &existing.auth {
        update.account.auth = existing.auth.clone();
    }
    update.id = id;
    write(&state, &mut accounts, update)?;
    build(&state, is_local(peer))
}

pub async fn remove(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
) -> ApiResult<Json<ManagedView>> {
    reject_if_read_only(&state)?;

    let (mut accounts, packages) = load(&state)?;
    if accounts.accounts.accounts.remove(&id).is_none() {
        return Err(ApiError::BadRequest(format!("no account named {id:?}")));
    }
    accounts.save().map_err(ApiError::from)?;
    // The maildir is deliberately left alone. It is the only copy of anything
    // that was moved off the server, and removing an account is what somebody
    // does to fix a name they typed wrong.
    apply_now(&state, &accounts, &packages)?;
    build(&state, is_local(peer))
}

fn write(state: &AppState, accounts: &mut Accounts, update: AccountUpdate) -> ApiResult<()> {
    let problems = update.account.problems(&update.id);
    if !problems.is_empty() {
        return Err(ApiError::BadRequest(problems.join("; ")));
    }

    if update.account.primary {
        for other in accounts.accounts.accounts.values_mut() {
            other.primary = false;
        }
    }
    if accounts.accounts.maildir.is_none() {
        return Err(ApiError::BadRequest(
            "there is no maildir root yet. Run `ecr account add` once at a terminal, or set \
             `maildir` in accounts.toml — where mail is kept is not a thing to decide \
             remotely"
                .to_string(),
        ));
    }

    accounts.accounts.accounts.insert(update.id, update.account);
    accounts.save().map_err(ApiError::from)?;

    let packages = Packages::load_from(&state.store.paths().settings_file());
    apply_now(state, accounts, &packages)
}

/// Regenerates every managed file.
///
/// Always, after any change: an account saved into `accounts.toml` and not
/// applied is one the tools cannot see, and the client has no way to notice the
/// difference. Doctor would report it as drift eventually — long after the
/// reader concluded the account did not work.
fn apply_now(state: &AppState, accounts: &Accounts, packages: &Packages) -> ApiResult<()> {
    // Nothing to generate is not a failure. Handing a package to ecr before any
    // account exists is the order a client naturally does it in, and a config
    // that has not been generated simply loses the resolution to the reader's
    // own — `Env::candidates` skips a candidate that is not a file — so the
    // in-between state is a working self-managed setup rather than a broken one.
    if !packages.any_managed() || accounts.accounts.maildir.is_none() {
        return Ok(());
    }
    let layout = accounts
        .layout_at(&state.store.paths().managed_dir())
        .map_err(ApiError::from)?;
    accounts::apply(&accounts.accounts, &layout, packages).map_err(ApiError::from)?;
    Ok(())
}

pub async fn apply(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
) -> ApiResult<Json<ManagedView>> {
    reject_if_read_only(&state)?;
    let (accounts, packages) = load(&state)?;
    apply_now(&state, &accounts, &packages)?;
    build(&state, is_local(peer))
}

#[derive(Deserialize)]
pub struct RulesUpdate {
    pub rules: Vec<ecr_core::managed::Rule>,
}

/// Replaces the whole set of tagging rules.
///
/// Whole rather than one at a time, because order is part of what a rule set
/// means: they run top to bottom and an earlier one that files a message stops
/// a later one seeing it. Editing them individually would make reordering the
/// one operation the API could not express.
pub async fn set_rules(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(update): Json<RulesUpdate>,
) -> ApiResult<Json<ManagedView>> {
    reject_if_read_only(&state)?;

    let problems: Vec<String> = update
        .rules
        .iter()
        .flat_map(|rule| rule.problems())
        .collect();
    if !problems.is_empty() {
        return Err(ApiError::BadRequest(problems.join("; ")));
    }

    let (mut accounts, packages) = load(&state)?;
    accounts.accounts.rules = update.rules;
    accounts.save().map_err(ApiError::from)?;
    apply_now(&state, &accounts, &packages)?;
    build(&state, is_local(peer))
}

#[derive(Deserialize)]
pub struct ManagementUpdate {
    pub package: String,
    pub management: String,
}

/// Hands a package to ecr, or gives it back.
///
/// The same switch the settings page writes, reachable as an action because the
/// client has to be able to say "manage this" without asking the reader to edit
/// TOML — and because turning it *off* has to be as easy, or nobody should
/// reasonably turn it on.
pub async fn set_management(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Json(update): Json<ManagementUpdate>,
) -> ApiResult<Json<ManagedView>> {
    reject_if_read_only(&state)?;

    let kind = match update.package.as_str() {
        "notmuch" => ConfigKind::Notmuch,
        "mbsync" => ConfigKind::Mbsync,
        "msmtp" => ConfigKind::Msmtp,
        other => {
            return Err(ApiError::BadRequest(format!(
                "{other:?} is not a package ecr can manage"
            )))
        }
    };
    let management = match update.management.as_str() {
        "ecr" => Management::Ecr,
        "self" => Management::SelfManaged,
        other => {
            return Err(ApiError::BadRequest(format!(
                "{other:?} is neither \"ecr\" nor \"self\""
            )))
        }
    };

    Packages::set_management_at(&state.store.paths().settings_file(), kind, management)
        .map_err(ApiError::from)?;

    if management.is_ecr() {
        let (accounts, packages) = load(&state)?;
        apply_now(&state, &accounts, &packages)?;
    }
    build(&state, is_local(peer))
}

#[derive(Deserialize)]
pub struct AuthorizeRequest {
    /// Widen the profile to contacts and calendars before running the flow.
    #[serde(default)]
    pub with_dav: bool,
}

#[derive(Serialize)]
pub struct AuthorizeStarted {
    /// The URL to consent at. Returned even when a browser was opened here, so
    /// the page can show it: `open` is best-effort and silently does nothing
    /// under a session with no browser, which would otherwise look like the
    /// button having done nothing at all.
    pub url: String,
    /// Whether this call added the DAV scopes, as opposed to their already
    /// being there. "Re-authorize with --with-dav" is the wrong thing to tell
    /// somebody who already has them.
    pub widened: bool,
}

/// Starts an OAuth flow for one account, and answers with the URL to consent at.
///
/// **Local callers only.** The flow redirects to `http://127.0.0.1:<port>` on
/// this machine, so a browser anywhere else consents perfectly and then waits
/// for a callback delivered somewhere it cannot see — the account is left
/// exactly as it was, with a page that looks like it worked.
///
/// The flow itself outlives the request. It has to: it does not finish until
/// somebody has clicked through a consent screen, which is minutes of a person
/// rather than milliseconds of a server, and an HTTP request held open that
/// long is one a proxy or a phone will drop. So this returns as soon as there
/// is something to act on, and the page watches the token state in the view for
/// it to become `valid`.
pub async fn authorize(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Json(request): Json<AuthorizeRequest>,
) -> ApiResult<Json<AuthorizeStarted>> {
    reject_if_read_only(&state)?;

    if !is_local(peer) {
        return Err(ApiError::BadRequest(
            "authorizing has to be done on the machine ecr runs on: the browser is sent back to \
             that machine's loopback address, which nothing else can receive"
                .to_string(),
        ));
    }

    let (accounts, _) = load(&state)?;
    let account = accounts
        .accounts
        .accounts
        .get(&id)
        .ok_or_else(|| ApiError::BadRequest(format!("no account {id:?}")))?;

    let Auth::Oauth { profile } = &account.auth else {
        return Err(ApiError::BadRequest(format!(
            "{id} authenticates with a password command, which has no flow to run"
        )));
    };
    let profile = profile.clone();
    let profiles = state.store.paths().oauth_profiles();

    let widened = if request.with_dav {
        oauth::widen_to_dav(&profiles, &profile).map_err(ApiError::from)?
    } else {
        false
    };

    let (send, receive) = tokio::sync::oneshot::channel();
    let running = profiles.clone();
    let named = profile.clone();
    tokio::spawn(async move {
        let outcome = oauth::authorize(
            &running,
            &named,
            oauth::Flow::Auto,
            AUTHORIZE_TIMEOUT,
            true,
            move |prompt| {
                let _ = send.send(match prompt {
                    oauth::Prompt::Browser { url, .. } => url,
                    oauth::Prompt::Device {
                        verification_uri, ..
                    } => verification_uri,
                });
            },
        )
        .await;

        match outcome {
            Ok(path) => tracing::info!(profile = %named, path = %path.display(), "authorized"),
            Err(err) => tracing::warn!(profile = %named, %err, "the authorization did not finish"),
        }
    });

    // The prompt arrives as soon as the URL exists, which is before anybody has
    // clicked anything. A flow that fails *before* that — a profile with no
    // client id — drops the sender instead, and that is the error to report.
    let url = receive.await.map_err(|_| {
        ApiError::BadRequest(format!(
            "the flow for {profile} could not be started; `ecr oauth status {profile}` says why"
        ))
    })?;

    Ok(Json(AuthorizeStarted { url, widened }))
}

/// Long enough for somebody to find the right Google account and read a consent
/// screen, short enough that an abandoned flow does not hold a loopback port
/// for the life of the server.
const AUTHORIZE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
