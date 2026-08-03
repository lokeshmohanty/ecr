use crate::discovery;
use crate::notmuch::Notmuch;
use crate::paths::{Env, MailPaths};
use crate::settings::ServerSettings;
use crate::tools;
use ecr_core::doctor::{Check, ConfigKind, ConfigSource, Doctor, ResolvedConfig, ToolInfo};

pub async fn run() -> Doctor {
    run_with(&Env::from_process(), &ServerSettings::load()).await
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
        Some(hook) => Check::ok("post-new hook", format!("{}", hook.display())),
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
        .revision()
        .await
    {
        Ok(current) => match status.revision {
            Some(held) if held.uuid != current.uuid => {
                Check::warn(NAME, format!("built against another database; {detail}"))
                    .with_hint("it is rebuilt the next time `ecr serve` starts")
            }
            Some(held) if held.lastmod < current.lastmod => Check::ok(
                NAME,
                format!("{} behind; {detail}", current.lastmod - held.lastmod),
            ),
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
}
