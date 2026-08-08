//! The managed-account routes.
//!
//! Kept apart from `routes.rs` because these are the only ones that reconfigure
//! *how mail is fetched* rather than reading or tagging it, and they carry a
//! restriction the rest do not: a password command is arbitrary code, and a
//! device that can pair with this server must not be able to make the server run
//! something of its choosing. Those arrive from the CLI or not at all.

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::Json;
use ecr_core::doctor::ConfigKind;
use ecr_core::managed::{Auth, ManagedAccount, ManagedAccounts};
use ecr_store::managed::accounts::{self, Accounts, State as FileState};
use ecr_store::packages::{Management, Packages};
use serde::{Deserialize, Serialize};

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
}

#[derive(Serialize)]
pub struct FileView {
    pub kind: String,
    pub path: String,
    pub state: &'static str,
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

pub async fn view(State(state): State<AppState>) -> ApiResult<Json<ManagedView>> {
    let (accounts, packages) = load(&state)?;
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
    view(State(state)).await
}

pub async fn update(
    State(state): State<AppState>,
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
    view(State(state)).await
}

pub async fn remove(
    State(state): State<AppState>,
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
    view(State(state)).await
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

pub async fn apply(State(state): State<AppState>) -> ApiResult<Json<ManagedView>> {
    reject_if_read_only(&state)?;
    let (accounts, packages) = load(&state)?;
    apply_now(&state, &accounts, &packages)?;
    view(State(state)).await
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
    view(State(state)).await
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
    view(State(state)).await
}
