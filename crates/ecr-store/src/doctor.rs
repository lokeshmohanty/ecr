use crate::discovery;
use crate::notmuch::Notmuch;
use crate::paths::{Env, MailPaths};
use crate::settings::ServerSettings;
use crate::tools;
use ecr_core::doctor::{Check, ConfigKind, ConfigSource, Doctor, ResolvedConfig, ToolInfo};
use ecr_core::managed::{ManagedAccounts, Sides};

pub async fn run() -> Doctor {
    let env = Env::from_process();
    let settings = ServerSettings::load_from_env(&env);
    run_with(&env, &settings).await
}

pub async fn run_with(env: &Env, settings: &ServerSettings) -> Doctor {
    match MailPaths::with(env, settings) {
        Ok(paths) => run_with_paths(&paths).await,
        Err(err) => {
            let tools = tools::inspect_all().await;
            let mut checks: Vec<Check> = tools.iter().map(tool_check).collect();
            checks.push(
                Check::fail("mail configuration", err.to_string()).with_hint(
                    "set notmuch_config in ~/.config/ecr/server.toml, or run `notmuch setup`",
                ),
            );
            Doctor {
                tools,
                configs: vec![
                    ResolvedConfig::missing(ConfigKind::Notmuch),
                    ResolvedConfig::missing(ConfigKind::Mbsync),
                    ResolvedConfig::missing(ConfigKind::Msmtp),
                ],
                maildir_root: None,
                database_path: None,
                post_new_hook: None,
                accounts: Vec::new(),
                checks,
            }
        }
    }
}

pub async fn run_with_paths(paths: &MailPaths) -> Doctor {
    let tools = tools::inspect_all().await;
    let mut checks: Vec<Check> = tools.iter().map(tool_check).collect();

    let configs = vec![
        paths.notmuch.clone(),
        paths.mbsync.clone(),
        paths.msmtp.clone(),
    ];
    checks.extend(configs.iter().map(config_check));
    checks.extend(configs.iter().filter_map(shadow_check));
    checks.push(pgp_check());
    // Read from the accounts file when there is one, so a managed account that
    // has been told removals may cross is not warned about. A self-managed
    // setup gets the notmuch half, which is the half that decides whether
    // anything crosses at all.
    let managed_accounts = crate::managed::accounts::Accounts::load_from(&paths.accounts_file())
        .ok()
        .map(|loaded| loaded.accounts);
    checks.push(tag_sync_check(paths, managed_accounts.as_ref()));
    checks.extend(managed_checks(paths));
    checks.push(theme_check(paths));

    checks.push(if paths.maildir_root.is_dir() {
        Check::ok("maildir root", format!("{}", paths.maildir_root.display()))
    } else {
        Check::fail(
            "maildir root",
            format!("{} does not exist", paths.maildir_root.display()),
        )
        .with_hint("database.path in the notmuch config points somewhere that is not there")
    });

    let xapian = paths.xapian_dir();
    checks.push(if xapian.is_dir() {
        Check::ok("notmuch database", format!("{}", xapian.display()))
    } else {
        Check::fail(
            "notmuch database",
            format!("no Xapian database at {}", xapian.display()),
        )
        .with_hint("run `notmuch new` to create it")
    });

    // Not a failure: everything except the sidebar's mailing-list rows works
    // without it, and reindexing a large database is the user's call to make.
    checks.push(if indexes_list_header(paths) {
        Check::ok("List-Id index", "index.header.List is set")
    } else {
        Check::warn("List-Id index", "index.header.List is not set")
            .with_hint("mailing lists cannot be searched; add `header.List=List-Id` under [index] in your notmuch config, then run `notmuch reindex '*'`")
    });

    checks.push(index_check(paths).await);

    let post_new_hook = paths.post_new_hook();
    checks.push(match &post_new_hook {
        // Existing is not the same as reachable. notmuch runs whatever is in
        // `database.hook_dir`, so a hook ecr wrote elsewhere is a hook that
        // never runs — and the only symptom is untagged mail.
        Some(hook) => match Notmuch::new(std::sync::Arc::new(paths.clone()))
            .hook_dir()
            .await
        {
            // A warning rather than a failure, and deliberately: the server
            // refuses to start on a failure, and untagged mail is a great deal
            // better than no mail client. It is the same severity as no hook at
            // all, which is the same outcome — this one just knows why.
            Some(dir) if !dir.join("post-new").is_file() => Check::warn(
                "post-new hook",
                format!(
                    "{} exists, but notmuch runs hooks from {}, which has none",
                    hook.display(),
                    dir.display()
                ),
            )
            .with_hint(
                "new mail is indexed but never tagged, so `tag:inbox` stops updating; set `hook_dir` under [database] in your notmuch config, or run `ecr account apply` to regenerate it",
            ),
            _ => Check::ok("post-new hook", format!("{}", hook.display())),
        },
        None => Check::warn("post-new hook", "none installed")
            .with_hint("tag routing after `notmuch new` will not happen"),
    });

    let accounts = discovery::accounts(paths);
    checks.push(if accounts.is_empty() {
        Check::fail(
            "accounts",
            format!(
                "no account directories under {}",
                paths.maildir_root.display()
            ),
        )
        .with_hint("run `mbsync -a` to populate the maildir")
    } else {
        Check::ok(
            "accounts",
            accounts
                .iter()
                .map(|a| format!("{} ({} folders)", a.id, a.folders.len()))
                .collect::<Vec<_>>()
                .join(", "),
        )
    });

    if !accounts.is_empty() {
        checks.push(account_tag_check(paths, &accounts).await);
    }

    checks.extend(account_key_checks(&accounts).await);

    let oauth_profiles: Vec<(String, String)> = accounts
        .iter()
        .filter_map(|a| discovery::oauth_profile(paths, a).map(|p| (a.id.to_string(), p)))
        .collect();

    if !oauth_profiles.is_empty() {
        let profiles = paths.oauth_profiles();
        for (account, profile) in &oauth_profiles {
            checks.push(oauth_check(&profiles, account, profile));
        }
    }

    for account in &accounts {
        if !account.can_sync() {
            checks.push(
                Check::warn(
                    format!("account {}", account.id),
                    "no mbsync channel targets this maildir",
                )
                .with_hint("it can be read, but not synced"),
            );
        }
        if !account.can_send() {
            checks.push(
                Check::warn(
                    format!("account {}", account.id),
                    "no msmtp account configured",
                )
                .with_hint("sending from this account will fail"),
            );
        }
    }

    Doctor {
        tools,
        configs,
        maildir_root: Some(paths.maildir_root.clone()),
        database_path: Some(paths.database_path.clone()),
        post_new_hook,
        accounts,
        checks,
    }
}

/// What managed mode is doing, if anything.
///
/// Reported even when nothing is managed, because "ecr writes none of this" is
/// the first thing worth knowing about a setup that is behaving unexpectedly —
/// and the answer that tells a reader their switch did not take.
/// gpg, if it is there.
///
/// A warning and never a failure: mail works perfectly without OpenPGP, and
/// most readers never touch it. But a machine with no gpg shows every signed
/// message unverified, and saying nothing about that leaves the reader unable
/// to tell "nobody signed this" from "nothing here can check a signature".
fn pgp_check() -> Check {
    match crate::pgp::installed() {
        Some(path) => Check::ok("openpgp", format!("{}", path.display())),
        None => Check::warn("openpgp", "gpg is not installed").with_hint(
            "signed mail will be shown unverified. ecr does not ship OpenPGP \
             and keeps no keys of its own; install GnuPG and it will use your \
             existing keyring and agent",
        ),
    }
}

/// An account's own key, when it has one that has stopped working.
///
/// **Silent about an account with no key**, which is the ordinary case and not
/// a thing to fix. The state worth a warning is the one that cannot be read
/// from the outside: a key that is right there in the keyring and whose
/// encryption subkey expired, so the address looks configured, gpg refuses at
/// the moment of sending, and the error arrives with the message still in the
/// composer. Asked here, it is a line in doctor instead.
async fn account_key_checks(accounts: &[ecr_core::account::Account]) -> Vec<Check> {
    use crate::pgp::{Capability, KeyState};

    if crate::pgp::installed().is_none() {
        return Vec::new();
    }

    let mut checks = Vec::new();
    for account in accounts {
        let Some(address) = account.address.as_deref() else {
            continue;
        };

        let mut stale = Vec::new();
        for (capability, what) in [
            (Capability::Encrypt, "be encrypted to"),
            (Capability::Sign, "sign"),
        ] {
            if crate::pgp::key_can(address, capability).await == KeyState::Unusable {
                stale.push(what);
            }
        }

        if !stale.is_empty() {
            checks.push(
                Check::warn(
                    format!("openpgp {}", account.id),
                    format!("the key for {address} can no longer {}", stale.join(" or ")),
                )
                .with_hint(
                    "every subkey that could has expired, been revoked or been disabled, \
                     so gpg refuses at the moment of sending. `gpg --edit-key` to extend it, \
                     or send without OpenPGP",
                ),
            );
        }
    }
    checks
}

/// What actually reaches the server when you read, archive or delete something.
///
/// This check exists because the answer is counter-intuitive and nothing else
/// in ecr says it. notmuch synchronises *maildir flags*, so `unread`,
/// `flagged` and `replied` cross the network by themselves — they are `S`, `F`
/// and `R` on the filename, and mbsync sends them as `\Seen`, `\Flagged` and
/// `\Answered`.
///
/// **`inbox` and `archive` are not flags.** They are notmuch tags and nothing
/// else, so archiving in ecr renames no file and mbsync has nothing to send.
/// The message stays in the inbox on the server.
///
/// **`deleted` is the `T` flag**, sent as `\Deleted` — and with `Expunge None`
/// nothing ever acts on it. On Gmail in particular `\Deleted` alone is
/// invisible: the message stays in the inbox and in All Mail.
///
/// Both are defensible as a local-first reading workflow. Neither is
/// defensible unsaid: somebody who deletes a hundred messages and finds them
/// all still in Gmail an hour later has been misled by silence.
///
/// It runs for a self-managed setup too, and that is the point — the reader's
/// own notmuch config is where `synchronize_flags` lives, and a setup with it
/// switched off is one where *nothing at all* crosses, including marking
/// something read.
fn tag_sync_check(paths: &MailPaths, accounts: Option<&ManagedAccounts>) -> Check {
    const NAME: &str = "tags on sync";

    // Explicitly off is the loud case: not even reading a message reaches the
    // server, so every device shows a different idea of what has been read.
    // Absent is not the same thing — notmuch's own default is true, and
    // treating a missing line as off would condemn nearly every setup.
    if paths.notmuch_config.synchronize_flags == Some(false) {
        return Check::warn(
            NAME,
            "maildir.synchronize_flags is off, so nothing reaches the server",
        )
        .with_hint(
            "not even marking a message read: notmuch will not rename the file, \
             so mbsync has no change to send and every other device keeps its \
             own idea of what you have read. Set `synchronize_flags=true` under \
             `[maildir]`",
        );
    }

    // `Expunge`, not `Remove`. Remove propagates *mailbox* deletions; message
    // disappearance is already propagated, because ecr emits no `Sync` line
    // and mbsync's default `Full` includes `Gone`. What `Expunge None` means
    // is that the far copy is marked deleted and then never acted on, which is
    // exactly a delete that looks done here and is not done there.
    let filing_reaches_the_server = accounts.is_some_and(|accounts| {
        accounts
            .enabled()
            .any(|(_, account)| matches!(account.expunge, Sides::Far | Sides::Both))
    });

    if filing_reaches_the_server {
        return Check::ok(
            NAME,
            "read and flagged cross as maildir flags; archiving and deleting file and expunge",
        );
    }

    Check::warn(
        NAME,
        "read, flagged and replied reach the server; archive and delete do not",
    )
    .with_hint(
        "notmuch syncs maildir flags, and `inbox` is not one — archiving renames \
         no file, so the message stays in the server's inbox. `deleted` is the T \
         flag, sent as \\Deleted, which Gmail ignores unless it is expunged. This \
         is safe and it is local-only; ecr will not remove mail from a server \
         you have not told it to. Set `expunge = \"far\"` on an account to let \
         filing cross",
    )
}

fn managed_checks(paths: &MailPaths) -> Vec<Check> {
    use crate::managed::accounts::{plan, Accounts, State};
    use crate::packages::Packages;

    let packages = Packages::load_from(&paths.settings_file());

    let managed: Vec<String> = [ConfigKind::Notmuch, ConfigKind::Mbsync, ConfigKind::Msmtp]
        .into_iter()
        .filter(|kind| packages.is_managed(*kind))
        .map(|kind| kind.to_string())
        .collect();

    if managed.is_empty() {
        return vec![Check::ok(
            "managed config",
            "off; every tool is configured by you",
        )];
    }

    let mut checks = vec![Check::ok("managed config", managed.join(", "))];

    let accounts = match Accounts::load_from(&paths.accounts_file()) {
        Ok(accounts) => accounts,
        Err(err) => {
            return {
                checks.push(
                    Check::fail("managed accounts", err.to_string())
                        .with_hint("nothing can be regenerated until it parses"),
                );
                checks
            }
        }
    };

    let problems = accounts.problems();
    if !problems.is_empty() {
        checks.push(Check::fail("managed accounts", problems.join("; ")));
    }

    let Ok(layout) = accounts.layout_at(&paths.managed_dir()) else {
        checks.push(
            Check::fail("managed accounts", "no maildir is named")
                .with_hint("add `maildir = \"…\"` to accounts.toml, or run `ecr account add`"),
        );
        return checks;
    };

    // Push is worth stating rather than leaving to be inferred from mail
    // arriving promptly. Without it, mail appears when something else fetches
    // it — which on a laptop can be a long time.
    let watched: Vec<&String> = accounts
        .accounts
        .enabled()
        .filter(|(_, account)| account.imap().is_some())
        .map(|(id, _)| id)
        .collect();

    checks.push(if watched.is_empty() {
        Check::warn("imap push", "no account can be watched")
            .with_hint("new mail appears when something syncs; give an account an IMAP host")
    } else {
        push_check(paths, &watched)
    });

    // Drift is the failure this whole check exists for: the reader edited
    // accounts.toml, or added one on another machine, and the files the tools
    // actually read are still the old ones. Nothing else in the system notices.
    for rendered in plan(&accounts.accounts, &layout, &packages) {
        // notmuch generates two files, so the package name alone would label
        // both of them the same and leave the reader unable to tell which one a
        // warning is about.
        let name = match rendered.path.file_name().and_then(|n| n.to_str()) {
            Some("post-new") => "managed post-new".to_string(),
            _ => format!("managed {}", rendered.kind),
        };
        checks.push(match rendered.state() {
            State::Current => Check::ok(name, format!("{}", rendered.path.display())),
            State::Stale => Check::warn(
                name,
                format!("{} is behind accounts.toml", rendered.path.display()),
            )
            .with_hint("run `ecr account apply`"),
            State::Missing => Check::fail(
                name,
                format!("{} has not been generated", rendered.path.display()),
            )
            .with_hint("run `ecr account apply`"),
            State::EditedByHand => Check::warn(
                name,
                format!("{} was edited by hand", rendered.path.display()),
            )
            .with_hint(
                "`ecr account apply` will back that edit up and replace it; put the change in \
                 accounts.toml instead",
            ),
        });
    }

    checks
}

/// Never a failure. The index is a cache of what notmuch holds: without it
/// every read is slower and every answer is the same, which is a remark rather
/// than something to fix.
async fn index_check(paths: &MailPaths) -> Check {
    use crate::index::MessageIndex;

    const NAME: &str = "mail index";

    if !paths.use_index {
        return Check::ok(NAME, "off (index = false in server.toml)");
    }

    let path = MessageIndex::path_for(paths);
    let index = match MessageIndex::open_at(&path, paths.notmuch_config.exclude_tags.clone()) {
        Ok(index) => index,
        Err(err) => {
            return Check::warn(NAME, err.to_string())
                .with_hint("every read will ask notmuch, which is correct but slower")
        }
    };

    let status = index.status();
    if status.revision.is_none() {
        return Check::warn(NAME, "not built yet").with_hint("it is built when `ecr serve` starts");
    }

    let detail = format!(
        "{} messages, {} MB, at {}",
        status.messages,
        status.bytes / 1_000_000,
        path.display()
    );

    // A held revision from another database is a maildir that was rebuilt from
    // scratch; the next refresh notices and starts over, so it is worth saying
    // and not worth acting on.
    match Notmuch::new(std::sync::Arc::new(paths.clone()))
        .revision_and_total()
        .await
    {
        Ok((current, total)) => match status.revision {
            Some(held) if held.uuid != current.uuid => {
                Check::warn(NAME, format!("built against another database; {detail}"))
                    .with_hint("it is rebuilt the next time `ecr serve` starts")
            }
            Some(held) if held.lastmod < current.lastmod => Check::ok(
                NAME,
                format!("{} behind; {detail}", current.lastmod - held.lastmod),
            ),
            // Standing where notmuch stands and holding a different number of
            // messages is the one index failure a reader can see from the
            // outside, because it is the one that never corrects itself: mail
            // that was deleted goes on showing, and a thread carrying a stale
            // row can be neither marked read nor deleted. The server audits for
            // exactly this and rebuilds, so saying so is the whole fix.
            Some(_) if status.messages != total => Check::warn(
                NAME,
                format!("disagrees with notmuch, which holds {total} messages; {detail}"),
            )
            .with_hint("restart `ecr serve` — it verifies the index at startup and rebuilds one that disagrees"),
            _ => Check::ok(NAME, format!("current; {detail}")),
        },
        Err(_) => Check::ok(NAME, detail),
    }
}

fn oauth_check(profiles: &crate::oauth::Profiles, account: &str, profile: &str) -> Check {
    use crate::oauth::TokenState;

    let name = format!("oauth {account}");
    match crate::oauth::token_state(profiles, profile) {
        TokenState::Valid { expires_in } => {
            Check::ok(name, format!("token valid for {expires_in}s"))
        }
        TokenState::Refreshable => {
            Check::ok(name, "token expiring, refresh token present".to_string())
        }
        TokenState::Expired => Check::fail(name, "token expired with no refresh token")
            .with_hint(format!("run `ecr oauth authorize {profile}`")),
        TokenState::Unknown(reason) => Check::warn(name, reason)
            .with_hint(format!("run `ecr oauth status {profile}` to see why")),
    }
}

/// Whether the notmuch config defines `header.List` under `[index]`.
///
/// Read from the file rather than asked of notmuch: doctor runs when things are
/// already broken, and shelling out is one more thing that can fail.
fn indexes_list_header(paths: &MailPaths) -> bool {
    let Some(path) = paths.notmuch.path.as_ref() else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };

    let mut in_index = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_index = line.eq_ignore_ascii_case("[index]");
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let qualified = key.eq_ignore_ascii_case("index.header.List");
        let scoped = in_index && key.eq_ignore_ascii_case("header.List");
        if (qualified || scoped) && value.trim().eq_ignore_ascii_case("List-Id") {
            return true;
        }
    }
    false
}

/// Mail sitting in an account's maildir without that account's tag.
///
/// This is the failure nothing else in the system can see. The message is
/// fetched, on disk and indexed — `notmuch count '*'` is right, the maildir is
/// right, mbsync is right — but every account view filters on the account tag,
/// so it is invisible in the client. It reads as mail that never arrived, which
/// sends whoever is looking at the sync, which is the one part that worked.
///
/// It happens whenever mail is indexed without the `post-new` hook running:
/// the hook was unreachable (`hook_dir`), or `notmuch new` was run by hand, or
/// the database already had mail in it when managed mode was switched on. The
/// hook is keyed on `tag:new`, which it clears, so nothing it does later can
/// reach that mail — which is what makes this worth a check rather than a
/// retry.
async fn account_tag_check(paths: &MailPaths, accounts: &[ecr_core::account::Account]) -> Check {
    const NAME: &str = "account tags";

    let queries: Vec<String> = accounts
        .iter()
        .map(|a| format!("path:\"{id}/**\" and not tag:{id}", id = a.id))
        .collect();

    // One process for every account, and a failure here says nothing about the
    // mail — doctor must not report a notmuch that would not run as untagged
    // mail.
    let Ok(counts) = Notmuch::new(std::sync::Arc::new(paths.clone()))
        .count_batch(&queries)
        .await
    else {
        return Check::ok(NAME, "not checked");
    };

    let behind: Vec<String> = accounts
        .iter()
        .zip(&counts)
        .filter(|(_, untagged)| **untagged > 0)
        .map(|(account, untagged)| format!("{} ({untagged})", account.id))
        .collect();

    if behind.is_empty() {
        return Check::ok(NAME, "every message carries the account it arrived in");
    }

    // A warning, not a failure: the mail is all still there, and refusing to
    // start the server over it would take away the client that could show it.
    Check::warn(NAME, format!("mail with no account tag: {}", behind.join(", ")))
        .with_hint(
            "it is on disk but hidden from every account view; retag it by path with `notmuch tag +<account> -- path:\"<account>/**\" and not tag:<account>`",
        )
}

/// Whether push is actually working, rather than whether it was asked for.
///
/// The old answer came out of `accounts.toml` alone, which reports an
/// *intention*: it said "watched with IDLE" just as cheerfully for a server
/// being refused by every one of those hosts, and for no server running at all.
/// Given that this is the check somebody reads when mail has stopped arriving,
/// that is the least useful thing it could have said.
///
/// A running server writes what its watches are doing to `watch.json`, and the
/// care here is all in not over-reading it. An absent or stale report is *no
/// answer*, never a bad one — doctor runs perfectly legitimately with no server
/// up, and the configuration is still worth stating then. Only a fresh report
/// can turn this into a complaint.
fn push_check(paths: &MailPaths, watched: &[&String]) -> Check {
    const NAME: &str = "imap push";

    let configured: Vec<&str> = watched.iter().map(|id| id.as_str()).collect();
    let report = crate::watch::read(&paths.ecr_state_dir).filter(|report| report.fresh());

    let Some(report) = report else {
        return Check::ok(
            NAME,
            format!(
                "{} configured; no running server is reporting",
                configured.join(", ")
            ),
        );
    };

    let failing = report.failing();
    if !failing.is_empty() {
        let detail: Vec<String> = failing
            .iter()
            .map(|(id, watch)| {
                format!(
                    "{id} ({}, for {})",
                    watch.problem.as_deref().unwrap_or("no reason given"),
                    ago(crate::watch::now() - watch.since)
                )
            })
            .collect();

        // A warning rather than a failure: push stopping does not lose mail, it
        // delays it, and the periodic reconcile still fetches. Refusing to start
        // the server over it would take away the client that could say so.
        return Check::warn(NAME, format!("not connected: {}", detail.join("; "))).with_hint(
            "mail still arrives on the 30-minute reconcile, just not immediately; an account \
             refused for hours is usually its token — `ecr oauth status <account>`",
        );
    }

    // Watched by the accounts file but absent from a fresh report: the server
    // read the accounts when it started and this one was added since.
    let unwatched: Vec<&str> = configured
        .iter()
        .filter(|id| !report.accounts.contains_key(**id))
        .copied()
        .collect();
    if !unwatched.is_empty() {
        return Check::warn(
            NAME,
            format!("added since the server started: {}", unwatched.join(", ")),
        )
        .with_hint(
            "restart `ecr serve` to watch it; until then its mail arrives on the reconcile",
        );
    }

    let connecting = report.connecting();
    if !connecting.is_empty() {
        return Check::ok(
            NAME,
            format!(
                "connecting: {}",
                connecting
                    .iter()
                    .map(|id| id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        );
    }

    Check::ok(
        NAME,
        format!("{} connected with IDLE", configured.join(", ")),
    )
}

/// A duration a person can read. Doctor is read at a glance and `for 8113s` is
/// not a length of time anybody has an instinct about.
fn ago(seconds: i64) -> String {
    match seconds {
        s if s < 90 => format!("{s}s"),
        s if s < 5400 => format!("{}m", s / 60),
        s => format!("{}h", s / 3600),
    }
}

/// Presets on disk that an older ecr wrote and this one would write differently.
///
/// Seeding deliberately never overwrites, so a palette that gains a colour role
/// in a release does not reach an install that already has the file — the client
/// renders that one role with its compiled-in colour and the theme is quietly
/// half-applied. Unlike the managed files, this cannot be repaired on the
/// reader's behalf: ecr seeds a preset and it is theirs from then on, so the
/// most that can be done is to name it.
fn theme_check(paths: &MailPaths) -> Check {
    const NAME: &str = "theme presets";

    let behind = crate::themes::incomplete(&paths.themes_dir());
    if behind.is_empty() {
        return Check::ok(NAME, "the shipped palettes are current");
    }

    let detail: Vec<String> = behind
        .iter()
        .map(|(name, missing)| format!("{name} ({})", missing.join(", ")))
        .collect();

    Check::warn(
        NAME,
        format!("older than this ecr, missing: {}", detail.join("; ")),
    )
    .with_hint(
        "the client falls back to a built-in colour for each missing role; delete the file to \
         have ecr write the current one, or add the roles to the copy you have edited",
    )
}

fn tool_check(tool: &ToolInfo) -> Check {
    match (&tool.path, &tool.version) {
        (Some(path), version) => Check::ok(
            tool.name.clone(),
            format!(
                "{} ({})",
                version.as_deref().unwrap_or("unknown version"),
                path.display()
            ),
        ),
        (None, _) => Check::fail(tool.name.clone(), "not found on PATH")
            .with_hint("add it to the dev shell or the service environment"),
    }
}

fn config_check(config: &ResolvedConfig) -> Check {
    match &config.path {
        Some(path) => Check::ok(
            format!("{} config", config.kind),
            format!("{} (via {})", path.display(), config.source),
        ),
        None => {
            let check = Check::warn(format!("{} config", config.kind), "not found");
            match config.kind {
                ConfigKind::Notmuch => check.with_hint("nothing can be read without it"),
                ConfigKind::Mbsync => check.with_hint("syncing will be unavailable"),
                ConfigKind::Msmtp => check.with_hint("sending will be unavailable"),
            }
        }
    }
}

fn shadow_check(config: &ResolvedConfig) -> Option<Check> {
    if config.shadowed.is_empty() {
        return None;
    }
    let shadowed = config
        .shadowed
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");

    // A file shadowed by a *managed* config is not a stale copy — it is the
    // reader's own configuration, untouched, and the thing they go back to the
    // moment they set this package to `self`. Telling them to delete it would be
    // telling them to burn the way back.
    if config.source == ConfigSource::Managed {
        return Some(
            Check::ok(
                format!("{} config yours", config.kind),
                format!("{shadowed} (unused while ecr manages this)"),
            )
            .with_hint("it is what ecr goes back to if you set this package to self-managed"),
        );
    }

    Some(
        Check::warn(
            format!("{} config shadowed", config.kind),
            format!("also present but unused: {shadowed}"),
        )
        .with_hint("delete the stale copy so it cannot be picked up by mistake"),
    )
}

pub fn render(doctor: &Doctor) -> String {
    use std::fmt::Write;
    let mut out = String::new();

    let width = doctor
        .checks
        .iter()
        .map(|c| c.name.len())
        .max()
        .unwrap_or(0);

    for check in &doctor.checks {
        let _ = writeln!(
            out,
            "{:>5}  {:<width$}  {}",
            check.status.symbol(),
            check.name,
            check.detail,
            width = width
        );
        if let Some(hint) = &check.hint {
            let _ = writeln!(out, "{:>5}  {:<width$}  -> {hint}", "", "", width = width);
        }
    }

    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "{}",
        if doctor.is_healthy() {
            "healthy"
        } else {
            "NOT healthy — fix the failures above before starting the server"
        }
    );
    out
}

pub fn is_source_legacy(config: &ResolvedConfig) -> bool {
    config.source == ConfigSource::LegacyDotfile
}

#[cfg(test)]
mod tests {
    use super::*;
    use ecr_core::doctor::CheckStatus;
    use std::fs;
    use std::path::Path;

    /// A `MailPaths` with nothing in it but a notmuch config, for the checks
    /// that only read one field of it.
    fn paths_with_flags(synchronize_flags: Option<bool>) -> (tempfile::TempDir, MailPaths) {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("Mail");
        fs::create_dir_all(root.join("cur")).unwrap();

        let config = home.path().join(".config/notmuch/default");
        fs::create_dir_all(&config).unwrap();
        let flags = match synchronize_flags {
            Some(value) => format!("[maildir]\nsynchronize_flags={value}\n"),
            None => String::new(),
        };
        fs::write(
            config.join("config"),
            format!("[database]\npath={}\n{flags}", root.display()),
        )
        .unwrap();

        let paths =
            MailPaths::with(&Env::rooted_at(home.path()), &ServerSettings::default()).unwrap();
        (home, paths)
    }

    fn maildir(root: &Path, relative: &str) {
        for leaf in ["cur", "new", "tmp"] {
            fs::create_dir_all(root.join(relative).join(leaf)).unwrap();
        }
    }

    fn healthy_home() -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("Mail");
        maildir(&root, "main/Inbox");
        fs::create_dir_all(root.join(".notmuch/xapian")).unwrap();

        let cfg = home.path().join(".config");
        fs::create_dir_all(cfg.join("notmuch/default/hooks")).unwrap();
        fs::write(
            cfg.join("notmuch/default/config"),
            format!("[database]\npath={}\n", root.display()),
        )
        .unwrap();
        fs::write(cfg.join("notmuch/default/hooks/post-new"), "#!/bin/sh\n").unwrap();
        fs::write(
            cfg.join("isyncrc"),
            format!(
                "MaildirStore main-local\nPath {}/main/\n\nChannel main\nNear :main-local:\n",
                root.display()
            ),
        )
        .unwrap();
        fs::create_dir_all(cfg.join("msmtp")).unwrap();
        fs::write(
            cfg.join("msmtp/config"),
            "account main\nfrom a@b.c\naccount default : main\n",
        )
        .unwrap();
        home
    }

    /// Doctor reads the OAuth token of every account whose `PassCmd` names one,
    /// and a read *adopts* the profile — so resolving the store from the process
    /// rather than from this `Env` had an integration test writing into the
    /// developer's real `~/.config/ecr`. The tempdir has to be the only place
    /// touched.
    #[tokio::test]
    async fn an_oauth_account_is_checked_without_leaving_the_rooted_home() {
        let home = healthy_home();
        let cfg = home.path().join(".config");
        let root = home.path().join("Mail");
        fs::write(
            cfg.join("isyncrc"),
            format!(
                "IMAPAccount main\nUser a@b.c\nPassCmd \"ecr oauth token main\"\n\n\
                 IMAPStore main-remote\nAccount main\n\n\
                 MaildirStore main-local\nPath {}/main/\n\n\
                 Channel main\nFar :main-remote:\nNear :main-local:\n",
                root.display()
            ),
        )
        .unwrap();

        let legacy = cfg.join("oauthman");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(
            legacy.join("main.json"),
            r#"{"profile":"main","provider":"gmail","email":"a@b.c","client_id":"c",
                "authorize_url":"https://x/","token_url":"https://x/","scopes":[],
                "redirect_uri":"http://127.0.0.1:49152/callback"}"#,
        )
        .unwrap();

        let env = Env::rooted_at(home.path());
        let doctor = run_with(&env, &ServerSettings::default()).await;

        // The account was found and its token reported on at all.
        assert_eq!(check(&doctor, "oauth main").status, CheckStatus::Warn);

        // Adoption landed inside the tempdir, which is only possible if the
        // store was resolved from this Env.
        let profiles = MailPaths::with(&env, &ServerSettings::default())
            .unwrap()
            .oauth_profiles();
        assert!(profiles.config_path("main").starts_with(home.path()));
        assert!(profiles.config_path("main").exists());
    }

    fn check<'a>(doctor: &'a Doctor, name: &str) -> &'a Check {
        doctor
            .checks
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("no check named {name}; got {:?}", doctor.checks))
    }

    #[tokio::test]
    async fn a_complete_setup_reports_no_failures() {
        let home = healthy_home();
        let doctor = run_with(&Env::rooted_at(home.path()), &ServerSettings::default()).await;

        let failures: Vec<_> = doctor
            .failures()
            .filter(|c| !tools::REQUIRED.contains(&c.name.as_str()))
            .collect();
        assert!(failures.is_empty(), "unexpected failures: {failures:?}");

        assert_eq!(check(&doctor, "accounts").status, CheckStatus::Ok);
        assert_eq!(check(&doctor, "notmuch database").status, CheckStatus::Ok);
        assert_eq!(check(&doctor, "post-new hook").status, CheckStatus::Ok);
    }

    #[tokio::test]
    async fn a_maildir_root_that_does_not_exist_is_a_failure() {
        let home = tempfile::tempdir().unwrap();
        let cfg = home.path().join(".config/notmuch/default");
        fs::create_dir_all(&cfg).unwrap();
        fs::write(
            cfg.join("config"),
            "[database]\npath=/nonexistent/lowercase/mail\n",
        )
        .unwrap();

        let doctor = run_with(&Env::rooted_at(home.path()), &ServerSettings::default()).await;

        assert_eq!(check(&doctor, "maildir root").status, CheckStatus::Fail);
        assert!(!doctor.is_healthy());
    }

    #[tokio::test]
    async fn a_stale_legacy_dotfile_is_surfaced_as_shadowed() {
        let home = healthy_home();
        fs::write(
            home.path().join(".notmuch-config"),
            "[database]\npath=/nonexistent/mail\n",
        )
        .unwrap();

        let doctor = run_with(&Env::rooted_at(home.path()), &ServerSettings::default()).await;
        let shadowed = check(&doctor, "notmuch config shadowed");

        assert_eq!(shadowed.status, CheckStatus::Warn);
        assert!(shadowed.detail.contains(".notmuch-config"));
        assert!(doctor.is_healthy());
    }

    #[tokio::test]
    async fn an_env_var_pointing_at_the_xdg_default_is_not_shadowed() {
        let home = healthy_home();
        let xdg = home.path().join(".config/notmuch/default/config");
        let env = Env {
            notmuch_config: Some(xdg),
            ..Env::rooted_at(home.path())
        };

        let doctor = run_with(&env, &ServerSettings::default()).await;

        assert!(
            doctor
                .checks
                .iter()
                .all(|c| c.name != "notmuch config shadowed"),
            "the XDG default reached through $NOTMUCH_CONFIG is the same file, not a stale copy: {:?}",
            doctor.checks
        );
    }

    #[tokio::test]
    async fn a_missing_notmuch_config_fails_early_and_clearly() {
        let home = tempfile::tempdir().unwrap();
        let doctor = run_with(&Env::rooted_at(home.path()), &ServerSettings::default()).await;

        assert!(!doctor.is_healthy());
        assert!(doctor.accounts.is_empty());
        assert_eq!(
            check(&doctor, "mail configuration").status,
            CheckStatus::Fail
        );
    }

    #[tokio::test]
    async fn an_account_without_a_channel_warns_but_stays_healthy() {
        let home = healthy_home();
        maildir(&home.path().join("Mail"), "orphan/Inbox");

        let doctor = run_with(&Env::rooted_at(home.path()), &ServerSettings::default()).await;
        let warnings: Vec<_> = doctor
            .checks
            .iter()
            .filter(|c| c.name == "account orphan")
            .collect();

        assert!(!warnings.is_empty());
        assert!(warnings.iter().all(|c| c.status == CheckStatus::Warn));
    }

    #[tokio::test]
    async fn render_marks_failures_visibly() {
        let home = tempfile::tempdir().unwrap();
        let doctor = run_with(&Env::rooted_at(home.path()), &ServerSettings::default()).await;
        let text = render(&doctor);

        assert!(text.contains("FAIL"));
        assert!(text.contains("NOT healthy"));
    }

    /// The check that exists because the answer is counter-intuitive and
    /// nothing else in ecr says it. Somebody who deletes a hundred messages
    /// and finds them all still in Gmail an hour later has been misled by
    /// silence.
    #[test]
    fn local_only_filing_is_named_rather_than_left_to_be_discovered() {
        use ecr_core::managed::{Auth, ManagedAccount, Provider};

        let mut accounts = ManagedAccounts::default();
        accounts.accounts.insert(
            "main".into(),
            ManagedAccount::new("a@example.com", Provider::Gmail, Auth::oauth("main")),
        );

        let (_home, paths) = paths_with_flags(Some(true));
        let check = tag_sync_check(&paths, Some(&accounts));
        assert_eq!(check.status, ecr_core::doctor::CheckStatus::Warn);
        // The two that do work, and the two that do not, both named — a
        // warning that only says "something is wrong" sends somebody to
        // re-check the flags that were never the problem.
        assert!(check.detail.contains("read"), "{}", check.detail);
        assert!(check.detail.contains("archive"), "{}", check.detail);
        assert!(check.detail.contains("delete"), "{}", check.detail);
    }

    /// An account that has been told removals may cross is not warned about,
    /// because for that one they do.
    #[test]
    fn an_account_that_propagates_removals_is_not_warned_about() {
        use ecr_core::managed::{Auth, ManagedAccount, Provider, Sides};

        let mut account =
            ManagedAccount::new("a@example.com", Provider::Gmail, Auth::oauth("main"));
        account.expunge = Sides::Far;

        let mut accounts = ManagedAccounts::default();
        accounts.accounts.insert("main".into(), account);

        let (_home, paths) = paths_with_flags(Some(true));
        assert_eq!(
            tag_sync_check(&paths, Some(&accounts)).status,
            ecr_core::doctor::CheckStatus::Ok
        );
    }

    /// The loud case, and the one nothing else would ever surface: with flag
    /// synchronisation off, not even marking a message read reaches the
    /// server, so every device keeps its own idea of what has been read.
    #[test]
    fn flag_synchronisation_switched_off_is_reported_as_nothing_crossing() {
        let (_home, paths) = paths_with_flags(Some(false));
        let check = tag_sync_check(&paths, None);

        assert_eq!(check.status, CheckStatus::Warn);
        assert!(check.detail.contains("nothing reaches"), "{}", check.detail);
        assert!(
            check.hint.as_deref().unwrap_or("").contains("read"),
            "the hint should say that even reading does not cross"
        );
    }

    /// notmuch's own default is true, so an absent key and an explicit `false`
    /// mean opposite things. Collapsing them would condemn nearly every setup
    /// in existence, none of which writes the line.
    #[test]
    fn an_absent_setting_is_notmuchs_default_rather_than_off() {
        let (_home, paths) = paths_with_flags(None);
        let check = tag_sync_check(&paths, None);

        assert!(
            !check.detail.contains("nothing reaches"),
            "{}",
            check.detail
        );
        assert!(check.detail.contains("read"), "{}", check.detail);
    }

    mod push {
        use super::*;
        use crate::watch::{now, Report, Watch};

        fn watch(connected: bool, problem: Option<&str>, since: i64) -> Watch {
            Watch {
                connected,
                since,
                problem: problem.map(str::to_string),
            }
        }

        fn with_report(report: Option<Report>) -> (tempfile::TempDir, MailPaths) {
            let (home, paths) = paths_with_flags(None);
            if let Some(report) = report {
                crate::watch::write(&paths.ecr_state_dir, &report).unwrap();
            }
            (home, paths)
        }

        fn report_of(accounts: &[(&str, Watch)], updated_at: i64) -> Report {
            Report {
                pid: 1,
                updated_at,
                accounts: accounts
                    .iter()
                    .map(|(id, w)| ((*id).to_string(), w.clone()))
                    .collect(),
            }
        }

        /// Doctor runs perfectly legitimately with no server up, and the old
        /// check's real sin was answering that case as though push were working.
        /// It has to say what is configured *and* that nobody is confirming it.
        #[test]
        fn no_running_server_is_no_answer_rather_than_a_bad_one() {
            let (_home, paths) = with_report(None);
            let main = "main".to_string();

            let check = push_check(&paths, &[&main]);

            assert_eq!(check.status, CheckStatus::Ok);
            assert!(check.detail.contains("main"), "{}", check.detail);
            assert!(
                check.detail.contains("no running server"),
                "{}",
                check.detail
            );
        }

        /// A report outlives the process that wrote it, so an abandoned one must
        /// read as nobody speaking rather than as the last thing anybody said.
        #[test]
        fn a_report_nobody_is_refreshing_is_not_believed() {
            let (_home, paths) = with_report(Some(report_of(
                &[("main", watch(true, None, now()))],
                now() - crate::watch::STALE_AFTER - 1,
            )));
            let main = "main".to_string();

            let check = push_check(&paths, &[&main]);

            assert_eq!(check.status, CheckStatus::Ok);
            assert!(
                check.detail.contains("no running server"),
                "{}",
                check.detail
            );
        }

        #[test]
        fn a_live_connection_is_reported_as_connected() {
            let (_home, paths) = with_report(Some(report_of(
                &[("main", watch(true, None, now()))],
                now(),
            )));
            let main = "main".to_string();

            let check = push_check(&paths, &[&main]);

            assert_eq!(check.status, CheckStatus::Ok);
            assert!(check.detail.contains("connected"), "{}", check.detail);
        }

        /// The whole point: a server that is up while every one of its watches
        /// is being refused used to report exactly as a healthy one did.
        #[test]
        fn a_refused_watch_is_reported_with_its_reason_and_how_long() {
            let (_home, paths) = with_report(Some(report_of(
                &[("main", watch(false, Some("IDLE was refused"), now() - 7200))],
                now(),
            )));
            let main = "main".to_string();

            let check = push_check(&paths, &[&main]);

            assert_eq!(check.status, CheckStatus::Warn);
            assert!(
                check.detail.contains("IDLE was refused"),
                "{}",
                check.detail
            );
            assert!(check.detail.contains("2h"), "{}", check.detail);
        }

        /// A watch dials on a loop, so there is always a window between starting
        /// and being up. Calling that a fault would make the check cry wolf on
        /// every restart.
        #[test]
        fn a_watch_still_dialling_is_not_a_complaint() {
            let (_home, paths) = with_report(Some(report_of(
                &[("main", watch(false, None, now()))],
                now(),
            )));
            let main = "main".to_string();

            let check = push_check(&paths, &[&main]);

            assert_eq!(check.status, CheckStatus::Ok);
            assert!(check.detail.contains("connecting"), "{}", check.detail);
        }

        /// The accounts file is read once, when the server starts. An account
        /// added after that is watched by nothing until it is restarted, and
        /// nothing else in the system would say so.
        #[test]
        fn an_account_the_running_server_never_read_is_named() {
            let (_home, paths) = with_report(Some(report_of(
                &[("main", watch(true, None, now()))],
                now(),
            )));
            let (main, work) = ("main".to_string(), "work".to_string());

            let check = push_check(&paths, &[&main, &work]);

            assert_eq!(check.status, CheckStatus::Warn);
            assert!(check.detail.contains("work"), "{}", check.detail);
            assert!(
                check.hint.as_deref().unwrap_or("").contains("restart"),
                "{:?}",
                check.hint
            );
        }
    }
}
