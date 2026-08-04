use ecr_core::doctor::ConfigKind;
use ecr_store::paths::{Env, MailPaths};
use ecr_store::settings::ServerSettings;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};

/// Where a maildir goes when there is no existing one to adopt.
///
/// This is a *default offered to the user*, never a guess acted on: the path is
/// asked for, with this prefilled, and the answer is what is written into the
/// notmuch config. `MailPaths` still reads the root back out of `database.path`
/// afterwards, so nothing here becomes a second source of truth for where mail
/// lives — the one rule this codebase does not bend.
fn default_maildir(env: &Env) -> PathBuf {
    env.home.join(".local").join("share").join("mail")
}

/// Maildirs an existing setup is likely to already keep mail in.
///
/// Adopting beats creating: someone with mail in `~/Mail` who is handed a fresh
/// database over an empty `~/.local/share/mail` has not been set up, they have
/// been given a second, emptier mail store and no hint that the first one is
/// still there.
const LIKELY_MAILDIRS: [&str; 4] = ["Mail", "Maildir", ".mail", ".maildir"];

pub struct Plan {
    pub maildir: PathBuf,
    pub notmuch_config: PathBuf,
    pub primary_email: Option<String>,
    pub full_name: Option<String>,
    /// Whether the maildir directory itself has to be created.
    pub create_maildir: bool,
    /// An existing file being replaced, and where it will be backed up to.
    pub backup: Option<(PathBuf, PathBuf)>,
}

pub async fn run(force: bool) -> anyhow::Result<()> {
    let env = Env::from_process();
    let mut settings = ServerSettings::load();

    require_a_terminal()?;

    // Resolve notmuch config first – this is the existing behaviour.
    let resolved = env.resolve(ConfigKind::Notmuch, &settings);
    if let Some(existing) = &resolved.path {
        if !force {
            println!("  notmuch config  {} (adopted)", existing.display());
            // Record the adopted path in server.toml before finishing.
            settings.notmuch_config = Some(existing.clone());
            settings.save()?;
            return finish(&env, &settings).await;
        }
        println!(
            "  notmuch config  {} (will be replaced)",
            existing.display()
        );
    }

    let plan = plan(&env, resolved.path.as_deref(), force)?;
    apply(&plan)?;

    // Record the notmuch path (whether newly created or adopted).
    settings.notmuch_config = Some(plan.notmuch_config.clone());

    // Resolve the other two configs (mbsync and msmtp) and record any existing
    // paths. If they are not found we simply leave the fields `None` – the user
    // can set them up later.  At this point ecr‑managed creation of those files is
    // not yet supported, so we only record paths.
    let mbsync_res = env.resolve(ConfigKind::Mbsync, &settings);
    let msmtp_res = env.resolve(ConfigKind::Msmtp, &settings);
    settings.mbsync_config = mbsync_res.path.clone();
    settings.msmtp_config = msmtp_res.path.clone();

    // Persist the updated server settings.
    settings.save()?;

    finish(&env, &settings).await
}

/// Runs init because something else needed it, having already established that
/// the configuration is missing. Answers whether anything was written.
pub async fn ensure() -> anyhow::Result<bool> {
    let env = Env::from_process();
    let mut settings = ServerSettings::load();

    // If a notmuch config already resolves, we only need to record the path.
    if let Some(p) = env.resolve(ConfigKind::Notmuch, &settings).path {
        settings.notmuch_config = Some(p);
        settings.save()?;
        return Ok(false);
    }

    println!("No mail configuration was found, so there is nothing for ecr to read.");
    println!("Setting one up now. Nothing is written without asking first.\n");

    require_a_terminal()?;
    let plan = plan(&env, None, false)?;
    apply(&plan)?;

    // Record the newly created notmuch config path.
    settings.notmuch_config = Some(plan.notmuch_config.clone());
    // Resolve mbsync and msmtp as well (they are likely missing at this point).
    let mbsync_res = env.resolve(ConfigKind::Mbsync, &settings);
    let msmtp_res = env.resolve(ConfigKind::Msmtp, &settings);
    settings.mbsync_config = mbsync_res.path.clone();
    settings.msmtp_config = msmtp_res.path.clone();
    settings.save()?;

    Ok(true)
}

/// Every write is confirmed, so there has to be somebody there to confirm it.
///
/// A systemd unit or a container has no stdin, and a prompt there is not a
/// question — it is a process that has stopped for a reason nobody can see. It
/// is named as a refusal instead, with the command to run by hand.
fn require_a_terminal() -> anyhow::Result<()> {
    if std::io::stdin().is_terminal() {
        return Ok(());
    }
    anyhow::bail!(
        "there is no terminal to confirm the changes on.\n\n  \
         Run `ecr init` from a shell, then start the server again.\n"
    )
}

fn plan(env: &Env, replacing: Option<&Path>, force: bool) -> anyhow::Result<Plan> {
    let adopted = LIKELY_MAILDIRS
        .iter()
        .map(|name| env.home.join(name))
        .find(|dir| looks_like_a_maildir(dir));

    match &adopted {
        Some(dir) => println!("Found what looks like a maildir at {}.", dir.display()),
        None => println!("No existing maildir was found."),
    }

    let suggested = adopted.clone().unwrap_or_else(|| default_maildir(env));
    let maildir = ask_path("Where should mail live?", &suggested, &env.home)?;

    let full_name = ask_optional("Your name (for the From: line)", whoami().as_deref())?;
    let primary_email = ask_optional("Your primary email address", None)?;

    let notmuch_config = env
        .config_dir
        .join("notmuch")
        .join(env.notmuch_profile.as_deref().unwrap_or("default"))
        .join("config");

    // Replacing a file that is not ours to lose. The backup is part of the plan
    // rather than a side-effect of writing, so it is shown before it happens.
    let backup = match replacing {
        Some(path) if force && path.is_file() => Some((path.to_path_buf(), backup_path(path))),
        _ => None,
    };

    Ok(Plan {
        create_maildir: !maildir.is_dir(),
        maildir,
        notmuch_config,
        primary_email,
        full_name,
        backup,
    })
}

fn apply(plan: &Plan) -> anyhow::Result<()> {
    println!();

    // What has already happened by the time a later question is declined.
    // Answering "nothing was changed" after creating a directory is a small lie,
    // and the reader has no other record of what this command did to their home.
    let mut done: Vec<String> = Vec::new();

    if plan.create_maildir {
        if !confirm(&format!("Create the directory {}?", plan.maildir.display()))? {
            anyhow::bail!("{}", stopped(&done));
        }
        std::fs::create_dir_all(&plan.maildir)?;
        println!("  created  {}", plan.maildir.display());
        done.push(format!("created {}", plan.maildir.display()));
    }

    if let Some((from, to)) = &plan.backup {
        if !confirm(&format!("Back up {} to {}?", from.display(), to.display()))? {
            anyhow::bail!("{}", stopped(&done));
        }
        std::fs::rename(from, to)?;
        println!("  moved    {} -> {}", from.display(), to.display());
        done.push(format!("moved {} to {}", from.display(), to.display()));
    }

    let contents = notmuch_config_text(plan);
    println!("\n{}:\n", plan.notmuch_config.display());
    for line in contents.lines() {
        println!("    {line}");
    }
    println!();

    if !confirm("Write this file?")? {
        anyhow::bail!("{}", stopped(&done));
    }
    if let Some(parent) = plan.notmuch_config.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&plan.notmuch_config, &contents)?;
    println!("  wrote    {}", plan.notmuch_config.display());

    // Without this there is no Xapian database, which doctor reports as a
    // failure and the server refuses to start on. It is the one step that runs
    // another program, so it is confirmed on its own.
    if confirm("\nRun `notmuch new` to create the database?")? {
        run_notmuch_new(&plan.notmuch_config)?;
    }

    Ok(())
}

/// Why init stopped, and what it had already done by then.
fn stopped(done: &[String]) -> String {
    if done.is_empty() {
        return "stopped; nothing was changed".to_string();
    }
    format!(
        "stopped. What had already been done:\n  {}\n",
        done.join("\n  ")
    )
}

/// The generated notmuch config.
///
/// `index.header.List` is set here and not left for later on purpose: notmuch
/// only applies it to mail indexed *after* it is set, so adding it to a database
/// that already has mail in it costs a full `notmuch reindex '*'`. At init time
/// the database is empty and it is free. Without it the sidebar's mailing-list
/// section cannot be searched at all, and `ecr doctor` warns for the life of the
/// install.
fn notmuch_config_text(plan: &Plan) -> String {
    let mut out = String::new();
    out.push_str("# Written by `ecr init`. Edit freely — ecr reads this file,\n");
    out.push_str("# it does not own it.\n\n");

    out.push_str("[database]\n");
    out.push_str(&format!("path={}\n\n", plan.maildir.display()));

    out.push_str("[user]\n");
    if let Some(name) = &plan.full_name {
        out.push_str(&format!("name={name}\n"));
    }
    if let Some(email) = &plan.primary_email {
        out.push_str(&format!("primary_email={email}\n"));
    }
    out.push('\n');

    out.push_str("[new]\n");
    out.push_str("tags=unread;inbox;\n");
    out.push_str("ignore=.mbsyncstate;.uidvalidity;.isyncuidmap.db;\n\n");

    out.push_str("[search]\n");
    out.push_str("exclude_tags=deleted;spam;\n\n");

    // ecr treats the maildir flags as authoritative, so notmuch has to be the
    // one keeping them in step with its tags.
    out.push_str("[maildir]\n");
    out.push_str("synchronize_flags=true\n\n");

    out.push_str("[index]\n");
    out.push_str("header.List=List-Id\n");
    out
}

fn run_notmuch_new(config: &Path) -> anyhow::Result<()> {
    let notmuch = ecr_store::tools::find(ecr_store::tools::NOTMUCH).ok_or_else(|| {
        anyhow::anyhow!("`notmuch` is not on PATH, so the database cannot be created")
    })?;

    let status = std::process::Command::new(&notmuch)
        .env("NOTMUCH_CONFIG", config)
        .arg("new")
        .status()
        .map_err(|err| anyhow::anyhow!("could not run {}: {err}", notmuch.display()))?;

    if !status.success() {
        anyhow::bail!("`notmuch new` exited with {status}");
    }
    Ok(())
}

/// Reports where things stand once the files are in place.
///
/// Deliberately the real doctor rather than a summary of what was just written:
/// what init can do and what a working install needs are not the same list, and
/// the gap between them — no accounts yet — is the next thing to do rather than
/// a failure of this command.
async fn finish(env: &Env, settings: &ServerSettings) -> anyhow::Result<()> {
    let report = ecr_store::doctor::run_with(env, settings).await;
    println!("\n{}", ecr_store::doctor::render(&report));

    if !report.accounts.is_empty() {
        return Ok(());
    }

    println!("There is no mail yet. To add an account:\n");
    println!("    ecr oauth setup <name> --provider gmail --email you@example.com");
    println!("    mbsync -a\n");
    println!("Then `ecr doctor` again, and `ecr serve`.");
    Ok(())
}

fn looks_like_a_maildir(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    // Either a maildir itself, or a directory of per-account maildirs, which is
    // the shape ecr expects and mbsync produces.
    if dir.join("cur").is_dir() {
        return true;
    }
    std::fs::read_dir(dir)
        .map(|entries| {
            entries.flatten().any(|entry| {
                let path = entry.path();
                path.is_dir() && has_a_maildir_inside(&path)
            })
        })
        .unwrap_or(false)
}

fn has_a_maildir_inside(dir: &Path) -> bool {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .any(|entry| entry.path().join("cur").is_dir())
        })
        .unwrap_or(false)
}

fn backup_path(path: &Path) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".ecr-backup.{stamp}"));
    path.with_file_name(name)
}

fn whoami() -> Option<String> {
    std::env::var("USER").ok().filter(|u| !u.is_empty())
}

/// Asks, and answers what was typed with the trailing newline gone.
///
/// An empty read means the pipe closed rather than that the reader accepted the
/// default — treating the two the same would let a closed stdin silently agree
/// to every remaining question.
fn ask(label: &str) -> anyhow::Result<String> {
    print!("{label}");
    std::io::stdout().flush()?;

    let mut line = String::new();
    if std::io::stdin().read_line(&mut line)? == 0 {
        anyhow::bail!("input ended before the question was answered");
    }
    Ok(line.trim().to_string())
}

fn prompt(question: &str, default: Option<&str>) -> anyhow::Result<String> {
    let label = match default {
        Some(value) => format!("{question} [{value}]: "),
        None => format!("{question}: "),
    };

    let answer = ask(&label)?;
    Ok(if answer.is_empty() {
        default.unwrap_or_default().to_string()
    } else {
        answer
    })
}

fn ask_path(question: &str, default: &Path, home: &Path) -> anyhow::Result<PathBuf> {
    loop {
        let answer = prompt(question, Some(&default.display().to_string()))?;
        let expanded = expand_tilde(&answer, home);

        if expanded.is_absolute() {
            return Ok(expanded);
        }
        println!("  that has to be an absolute path.");
    }
}

fn ask_optional(question: &str, default: Option<&str>) -> anyhow::Result<Option<String>> {
    let answer = prompt(question, default)?;
    Ok(Some(answer).filter(|a| !a.trim().is_empty()))
}

/// Nothing is written without one of these answering yes.
///
/// The default is no, and Enter takes it. A confirmation whose default is yes is
/// not a confirmation — it is a pause that most people will press through, and
/// what is on the other side of these is somebody's home directory.
fn confirm(question: &str) -> anyhow::Result<bool> {
    loop {
        match ask(&format!("{question} [y/N] "))?
            .to_ascii_lowercase()
            .as_str()
        {
            "y" | "yes" => return Ok(true),
            "" | "n" | "no" => return Ok(false),
            _ => println!("  answer y or n."),
        }
    }
}

/// `~` is a shell convenience, and nothing has expanded it by the time a path is
/// typed at a prompt rather than passed as an argument. The home comes from the
/// `Env` everything else resolves through, never from the process, so a rooted
/// test home stays rooted here too.
fn expand_tilde(input: &str, home: &Path) -> PathBuf {
    let trimmed = input.trim();
    match trimmed.strip_prefix('~') {
        Some(rest) => home.join(rest.trim_start_matches('/')),
        None => PathBuf::from(trimmed),
    }
}

/// Whether a usable mail configuration resolves at all.
///
/// This is the question `ecr serve` asks before it opens the store, and it is
/// deliberately the *same* resolution the store performs rather than a check for
/// a file at a guessed location — the four-step order is the only thing that
/// knows where a config may legitimately be.
pub fn is_configured() -> bool {
    MailPaths::discover().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_maildir_is_under_the_given_home() {
        let env = Env::rooted_at(Path::new("/home/someone"));
        assert_eq!(
            default_maildir(&env),
            PathBuf::from("/home/someone/.local/share/mail")
        );
    }

    #[test]
    fn a_directory_of_account_maildirs_is_recognised() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("Mail");
        std::fs::create_dir_all(root.join("main/Inbox/cur")).unwrap();

        assert!(looks_like_a_maildir(&root));
    }

    #[test]
    fn a_bare_maildir_is_recognised() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("Maildir");
        std::fs::create_dir_all(root.join("cur")).unwrap();

        assert!(looks_like_a_maildir(&root));
    }

    #[test]
    fn an_ordinary_directory_is_not_a_maildir() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("Documents");
        std::fs::create_dir_all(root.join("taxes")).unwrap();

        assert!(!looks_like_a_maildir(&root));
        assert!(!looks_like_a_maildir(&home.path().join("nothing-here")));
    }

    /// The generated file has to satisfy the very checks `ecr doctor` runs, or
    /// init would hand the user a setup the server then refuses to start on.
    #[test]
    fn the_generated_config_carries_what_doctor_looks_for() {
        let plan = Plan {
            maildir: PathBuf::from("/srv/Mail"),
            notmuch_config: PathBuf::from("/tmp/config"),
            primary_email: Some("a@b.c".into()),
            full_name: Some("A B".into()),
            create_maildir: false,
            backup: None,
        };

        let text = notmuch_config_text(&plan);
        assert!(text.contains("path=/srv/Mail"));
        assert!(text.contains("primary_email=a@b.c"));
        assert!(text.contains("name=A B"));
        // Free now, a full reindex later.
        assert!(text.contains("header.List=List-Id"));
        assert!(text.contains("synchronize_flags=true"));
    }

    #[test]
    fn the_generated_config_is_what_mailpaths_reads_back() {
        let home = tempfile::tempdir().unwrap();
        let maildir = home.path().join("mail");
        std::fs::create_dir_all(&maildir).unwrap();

        let plan = Plan {
            maildir: maildir.clone(),
            notmuch_config: home.path().join(".config/notmuch/default/config"),
            primary_email: None,
            full_name: None,
            create_maildir: false,
            backup: None,
        };

        std::fs::create_dir_all(plan.notmuch_config.parent().unwrap()).unwrap();
        std::fs::write(&plan.notmuch_config, notmuch_config_text(&plan)).unwrap();

        let paths =
            MailPaths::with(&Env::rooted_at(home.path()), &ServerSettings::default()).unwrap();
        assert_eq!(paths.database_path, maildir);
        assert_eq!(paths.maildir_root, maildir);
    }

    #[test]
    fn an_omitted_identity_leaves_the_keys_out_rather_than_writing_blanks() {
        let plan = Plan {
            maildir: PathBuf::from("/srv/Mail"),
            notmuch_config: PathBuf::from("/tmp/config"),
            primary_email: None,
            full_name: None,
            create_maildir: false,
            backup: None,
        };

        let text = notmuch_config_text(&plan);
        assert!(!text.contains("primary_email="));
        assert!(!text.contains("name="));
    }

    #[test]
    fn a_backup_sits_beside_the_file_it_replaces() {
        let backup = backup_path(Path::new("/home/a/.config/notmuch/default/config"));
        assert_eq!(
            backup.parent(),
            Path::new("/home/a/.config/notmuch/default").into()
        );
        assert!(backup
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("config.ecr-backup."));
    }

    #[test]
    fn tilde_expands_against_the_given_home_not_the_process_one() {
        let home = Path::new("/home/someone");
        assert_eq!(expand_tilde("~/mail", home), home.join("mail"));
        assert_eq!(expand_tilde("~", home), home);
        assert_eq!(expand_tilde("/srv/mail", home), PathBuf::from("/srv/mail"));
    }
}
