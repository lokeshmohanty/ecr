//! `ecr account` — the accounts ecr manages, when it is managing them.
//!
//! Every subcommand ends by saying what the state of the world is now, because
//! the thing being configured is four files in three formats and a directory of
//! mail, and a command that answers "done" leaves the reader to go and check.

use ecr_core::doctor::ConfigKind;
use ecr_core::managed::{Auth, Endpoint, ManagedAccount, Provider, Sides, Tls};
use ecr_store::managed::accounts::{self, Accounts, State};
use ecr_store::managed::Outcome;
use ecr_store::packages::{Management, Packages};
use ecr_store::paths::Env;
use std::path::PathBuf;

const MANAGED: [ConfigKind; 3] = [ConfigKind::Notmuch, ConfigKind::Mbsync, ConfigKind::Msmtp];

/// Runs notmuch against the configuration ecr resolved.
///
/// Managed mode moves that file into ecr's own directory, and notmuch is the one
/// of the three tools a reader also runs by hand — so without this, `notmuch
/// search` in a shell answers out of a different database and the two disagree
/// with nothing to explain why. It passes through whatever it is given: this is
/// notmuch, not a wrapper with opinions.
pub fn notmuch_passthrough(args: &[String]) -> anyhow::Result<()> {
    let paths = ecr_store::MailPaths::discover()?;
    let config = paths
        .notmuch
        .path
        .clone()
        .ok_or_else(|| anyhow::anyhow!("no notmuch configuration resolved"))?;

    let status = std::process::Command::new(&paths.binaries.notmuch)
        .env("NOTMUCH_CONFIG", &config)
        // A profile would re-point notmuch at a different config underneath the
        // one just named, which is the trap `ecr_store::paths` exists to avoid.
        .env_remove("NOTMUCH_PROFILE")
        .args(args)
        .status()
        .map_err(|err| {
            anyhow::anyhow!("could not run {}: {err}", paths.binaries.notmuch.display())
        })?;

    match status.code() {
        Some(0) | None => Ok(()),
        Some(code) => std::process::exit(code),
    }
}

pub struct AddOptions {
    pub id: String,
    pub address: String,
    pub provider: String,
    pub name: Option<String>,
    pub oauth_profile: Option<String>,
    pub password_command: Option<String>,
    pub imap: Option<String>,
    pub smtp: Option<String>,
    pub maildir: Option<PathBuf>,
    pub primary: bool,
}

pub fn list() -> anyhow::Result<()> {
    let env = Env::from_process();
    let accounts = Accounts::load(&env)?;
    let packages = Packages::load(&env);

    println!("{}", managed_line(&packages));

    if accounts.accounts.is_empty() {
        println!("\nNo accounts yet. Add one with:\n");
        println!("    ecr account add personal --address you@gmail.com --provider gmail\n");
        return Ok(());
    }

    println!("\n{}", accounts.path.display());
    for (id, account) in accounts.accounts.iter() {
        let mark = if account.enabled { " " } else { "-" };
        let primary = if account.primary { " (primary)" } else { "" };
        println!(
            "{mark} {id:<12} {:<28} {}{primary}",
            account.address, account.provider
        );
        match &account.auth {
            Auth::Oauth { profile } => println!("    auth  ecr oauth token {profile}"),
            Auth::Command { command } => println!("    auth  {}", command.join(" ")),
        }
        if let Some(imap) = account.imap() {
            println!("    imap  {}:{}", imap.host, imap.port);
        }
        if let Some(smtp) = account.smtp() {
            println!("    smtp  {}:{}", smtp.host, smtp.port);
        }
    }

    let layout = accounts.layout(&env)?;
    println!("\nmaildir {}", layout.maildir_root.display());
    for rendered in accounts::plan(&accounts.accounts, &layout, &packages) {
        println!(
            "  {:<10} {}",
            match rendered.state() {
                State::Current => "current",
                State::Missing => "MISSING",
                State::Stale => "STALE",
                State::EditedByHand => "EDITED",
            },
            rendered.path.display()
        );
    }

    // Managed mode moves the config, and notmuch is the one of the three the
    // reader also runs themselves. Naming the invocation costs a line and saves
    // an afternoon of wondering why `notmuch search` disagrees with ecr.
    if packages.is_managed(ConfigKind::Notmuch) {
        println!(
            "\nYour own notmuch reads a different config. For this one:\n    ecr notmuch <args>"
        );
    }
    Ok(())
}

pub fn add(options: AddOptions) -> anyhow::Result<()> {
    let env = Env::from_process();
    let mut accounts = Accounts::load(&env)?;

    if accounts.accounts.accounts.contains_key(&options.id) {
        anyhow::bail!(
            "an account named {:?} is already there; edit it in {}",
            options.id,
            accounts.path.display()
        );
    }

    let provider: Provider = options
        .provider
        .parse()
        .map_err(|err: String| anyhow::anyhow!(err))?;

    // OAuth by default where the provider has one, because Gmail and Outlook
    // will not take a password at all and a profile named after the account is
    // what `ecr oauth setup` would create anyway.
    let auth = match (&options.oauth_profile, &options.password_command) {
        (Some(_), Some(_)) => {
            anyhow::bail!("--oauth-profile and --password-command are two answers to one question")
        }
        (Some(profile), None) => Auth::oauth(profile),
        (None, Some(command)) => Auth::Command {
            command: command.split_whitespace().map(str::to_string).collect(),
        },
        (None, None) => match provider.oauth_provider() {
            Some(_) => Auth::oauth(&options.id),
            None => anyhow::bail!(
                "the {provider} provider authenticates with a password, so this account needs \
                 --password-command (a command that prints one, like `pass show mail/{}`)",
                options.id
            ),
        },
    };

    let mut account = ManagedAccount::new(&options.address, provider, auth);
    account.name = options.name;
    account.primary = options.primary || accounts.accounts.is_empty();
    account.imap = options
        .imap
        .as_deref()
        .map(|s| endpoint(s, 993))
        .transpose()?;
    account.smtp = options
        .smtp
        .as_deref()
        .map(|s| endpoint(s, 587))
        .transpose()?;

    let problems = account.problems(&options.id);
    if !problems.is_empty() {
        anyhow::bail!("{}", problems.join("\n"));
    }

    if accounts.accounts.maildir.is_none() {
        accounts.accounts.maildir = Some(
            options
                .maildir
                .unwrap_or_else(|| env.home.join(".local").join("share").join("mail")),
        );
    }
    if account.primary {
        for other in accounts.accounts.accounts.values_mut() {
            other.primary = false;
        }
    }

    let oauth = account.oauth_profile().map(str::to_string);
    accounts
        .accounts
        .accounts
        .insert(options.id.clone(), account);
    accounts.save()?;
    println!("  wrote    {}", accounts.path.display());

    // Adding an account to a file nothing reads is not adding an account. The
    // first one is what turns managed mode on, and it says so rather than
    // leaving the reader to find the switch.
    let packages = Packages::load(&env);
    if !packages.any_managed() {
        for kind in MANAGED {
            let path = Packages::set_management(&env, kind, Management::Ecr)?;
            if kind == ConfigKind::Notmuch {
                println!("  managed  notmuch, mbsync and msmtp ({})", path.display());
            }
        }
    }

    apply()?;

    // A profile only ever exists for a provider that has an OAuth one, so this
    // reads the same answer twice rather than falling back to a guess.
    if let (Some(profile), Some(oauth_provider)) = (oauth, provider.oauth_provider()) {
        println!("\nThis account has no token yet. Authorize it with:\n");
        println!(
            "    ecr oauth setup {profile} --provider {oauth_provider} --email {}",
            options.address
        );
        println!("{}\n", first_sync(&env, &options.id));
    }
    Ok(())
}

pub fn remove(id: &str, keep_mail: bool) -> anyhow::Result<()> {
    let env = Env::from_process();
    let mut accounts = Accounts::load(&env)?;

    if accounts.accounts.accounts.remove(id).is_none() {
        anyhow::bail!("there is no account named {id:?}");
    }
    accounts.save()?;
    println!("  wrote    {}", accounts.path.display());

    // The mail is never deleted here, and this is why: a maildir is the only
    // copy of anything that was moved out of the server, and removing an account
    // is something people do to fix a name they typed wrong.
    let layout = accounts.layout(&env)?;
    let dir = layout.account_dir(id);
    if !keep_mail && dir.is_dir() {
        println!(
            "\nThe mail is still at {}. Nothing here deletes it; remove that directory\n\
             yourself and run `notmuch new` if that is what you meant.",
            dir.display()
        );
    }

    apply()
}

pub fn apply() -> anyhow::Result<()> {
    let env = Env::from_process();
    let accounts = Accounts::load(&env)?;
    let packages = Packages::load(&env);

    if !packages.any_managed() {
        println!("{}", managed_line(&packages));
        return Ok(());
    }

    let problems = accounts.problems();
    if !problems.is_empty() {
        anyhow::bail!("{}", problems.join("\n"));
    }

    let layout = accounts.layout(&env)?;
    for applied in accounts::apply(&accounts.accounts, &layout, &packages)? {
        match applied.outcome {
            Outcome::Unchanged => {}
            Outcome::Created => println!("  wrote    {}", applied.path.display()),
            Outcome::Replaced => println!("  updated  {}", applied.path.display()),
            Outcome::ReplacedAfterBackup(backup) => {
                println!("  updated  {}", applied.path.display());
                println!("  backed up your edit to {}", backup.display());
            }
        }
    }
    Ok(())
}

/// Builds the account model out of a setup ecr does not manage.
///
/// Shared by `import`, which shows it as a diff, and `test`, which dials it —
/// so the question "will ecr reach this account" can be answered before
/// anything is handed over. Answers the accounts and everything worth telling
/// the reader about how they were read.
fn derive(paths: &ecr_store::MailPaths) -> (ecr_core::managed::ManagedAccounts, Vec<String>) {
    let discovered = ecr_store::discovery::accounts(paths);
    // Read out of the notmuch config rather than defaulted, both of them.
    // `exclude_tags` decides what every query in ecr returns and what the mail
    // index is built against — a setup with `trash` in it, regenerated without,
    // has deleted mail quietly reappearing in every search. And the primary
    // address is the identity replies go out as, which is a choice somebody
    // made, not the alphabetically first account.
    let mut accounts = ecr_core::managed::ManagedAccounts {
        maildir: Some(paths.maildir_root.clone()),
        name: paths.notmuch_config.user_name.clone(),
        exclude_tags: match paths.notmuch_config.exclude_tags.is_empty() {
            true => ecr_core::managed::ManagedAccounts::default().exclude_tags,
            false => paths.notmuch_config.exclude_tags.clone(),
        },
        ..Default::default()
    };
    let primary_email = paths.notmuch_config.primary_email.clone();
    let mut notes: Vec<String> = Vec::new();

    for (index, account) in discovered.iter().enumerate() {
        let id = account.id.to_string();
        let imap = account
            .mbsync_channel
            .as_deref()
            .and_then(|channel| paths.mbsync_config.channel_imap_account(channel));
        let msmtp = account
            .msmtp_account
            .as_deref()
            .and_then(|name| paths.msmtp_config.accounts.get(name));

        let Some(address) = account.address.clone() else {
            notes.push(format!(
                "{id}: no address could be found for it, so it is left out. It has no IMAP \
                 account in your mbsyncrc and no msmtp account of its own."
            ));
            continue;
        };

        let provider = provider_for(imap.and_then(|a| a.host.as_deref()));
        let auth = match imap.and_then(|a| a.pass_cmd.as_deref()) {
            Some(cmd) => auth_from(cmd, &id),
            None => {
                notes.push(format!(
                    "{id}: no PassCmd in your mbsyncrc, so ecr guessed an OAuth profile named \
                     {id:?}. Check it before applying."
                ));
                Auth::oauth(&id)
            }
        };

        let mut managed = ManagedAccount::new(&address, provider, auth);
        managed.primary = match &primary_email {
            Some(primary) => *primary == address,
            // Nothing said which, so the first is as good an answer as there is
            // — and it is reported below rather than left to be discovered when
            // a reply goes out as the wrong person.
            None => index == 0,
        };

        // Only where it differs from what the preset already says, so an
        // imported Gmail account reads as "gmail" rather than as a wall of
        // hostnames that happen to match.
        if let Some(endpoint) = imported_imap(imap, provider) {
            managed.imap = Some(endpoint);
        }
        if let Some(endpoint) = imported_smtp(msmtp, provider) {
            managed.smtp = Some(endpoint);
        }
        managed.certificate_file = imap.and_then(|a| a.certificate_file.clone());

        // What a channel syncs, and how far a creation or a deletion travels,
        // are carried across verbatim — never replaced by the preset. A reader
        // handing ecr a working setup is asking it to keep working, and an
        // import that quietly changed `Patterns` or `Expunge` would be changing
        // which mail exists and where, on the next sync, with the diff above
        // being the only warning anybody ever got.
        if let Some(channel) = account
            .mbsync_channel
            .as_deref()
            .and_then(|c| paths.mbsync_config.channels.get(c))
        {
            managed.patterns = channel.patterns.clone();
            if let Some(sides) = channel.create.as_deref().and_then(Sides::parse) {
                managed.create = sides;
            }
            if let Some(sides) = channel.expunge.as_deref().and_then(Sides::parse) {
                managed.expunge = sides;
            }
            if let Some(sides) = channel.remove.as_deref().and_then(Sides::parse) {
                managed.remove = sides;
            }
        }

        if managed.smtp().is_none() {
            notes.push(format!(
                "{id}: your msmtp config names no host for it, so ecr has no SMTP server to \
                 write. Add one to accounts.toml before applying."
            ));
        }
        accounts.accounts.insert(id, managed);
    }

    // The one part of an imported setup ecr cannot carry across, and the one
    // that decides how mail is tagged. Saying so beats hoping the diff is read.
    if paths.post_new_hook().is_some() {
        notes.push(
            "you already have a post-new hook. ecr's tags each message by the folder it \
             arrived in; yours may key on something else, and replacing it changes how \
             new mail is tagged. Read that diff before applying — nothing already \
             indexed is retagged either way."
                .to_string(),
        );
    }

    if primary_email.is_none() {
        notes.push(format!(
            "your notmuch config names no primary_email, so {:?} was taken as the identity \
             replies default to.",
            accounts
                .primary()
                .map(|(id, _)| id.as_str())
                .unwrap_or("none")
        ));
    } else if accounts.primary().is_none() {
        notes.push(format!(
            "primary_email is {:?}, which is not the address of any account found. \
             Set `primary = true` on the right one in accounts.toml.",
            primary_email.unwrap_or_default()
        ));
    }

    (accounts, notes)
}

/// Reads the setup that is already working into `accounts.toml`.
///
/// Nothing is switched here. It writes the account file, shows what ecr *would*
/// generate against what the tools read today, and stops — because the only
/// honest way to ask somebody to hand over a working mail setup is to show them
/// the diff first. `ecr account apply` is the separate step that acts on it.
pub fn import(write: bool) -> anyhow::Result<()> {
    let env = Env::from_process();
    let settings = ecr_store::ServerSettings::load_from_env(&env);

    // Deliberately resolved as if nothing were managed: what is being imported
    // is the reader's own configuration, and a second import must not read back
    // what the first one generated.
    let paths = ecr_store::MailPaths::with_packages(&env, &settings, &Packages::default())?;
    let (accounts, notes) = derive(&paths);

    if accounts.accounts.is_empty() {
        anyhow::bail!(
            "no accounts were found under {}. There is nothing to import; \
             `ecr account add` is the way in on a machine with no mail yet.",
            paths.maildir_root.display()
        );
    }

    let holder = Accounts {
        path: Accounts::path_in(&env),
        accounts,
    };

    println!("Read {} account(s) from:", holder.accounts.accounts.len());
    for config in [&paths.notmuch, &paths.mbsync, &paths.msmtp] {
        if let Some(path) = &config.path {
            println!("  {:<8} {}", config.kind.to_string(), path.display());
        }
    }

    // The diff is the whole point: every file ecr would write, against the file
    // the tools read now.
    let layout = holder.layout(&env)?;
    let every_package = Packages::parse(
        "[packages.notmuch]\nmanagement = \"ecr\"\n\
         [packages.mbsync]\nmanagement = \"ecr\"\n\
         [packages.msmtp]\nmanagement = \"ecr\"\n",
    );

    for rendered in accounts::plan(&holder.accounts, &layout, &every_package) {
        let live = match rendered.kind {
            ConfigKind::Notmuch if rendered.path.ends_with("post-new") => paths
                .post_new_hook()
                .and_then(|p| std::fs::read_to_string(p).ok())
                .unwrap_or_default(),
            ConfigKind::Notmuch => read(&paths.notmuch.path),
            ConfigKind::Mbsync => read(&paths.mbsync.path),
            ConfigKind::Msmtp => read(&paths.msmtp.path),
        };

        println!("\n─── {} ───", rendered.path.display());
        let changes = crate::diff::summary(&live, &rendered.body, 2);
        if changes.is_empty() {
            println!("  (identical to what you have)");
        } else {
            for line in changes {
                println!("{line}");
            }
        }
    }

    if !notes.is_empty() {
        println!("\nWorth checking:");
        for note in &notes {
            println!("  - {note}");
        }
    }

    if !write {
        println!(
            "\nNothing was written. `ecr account import --write` saves this to {}.\n\
             Managed mode stays off either way until `ecr account apply`.",
            holder.path.display()
        );
        return Ok(());
    }

    holder.save()?;
    println!("\n  wrote    {}", holder.path.display());
    println!(
        "\nManaged mode is still off. To hand these files to ecr:\n\n    \
         ecr account apply\n\nUntil then your own configuration is what runs."
    );
    Ok(())
}

fn read(path: &Option<PathBuf>) -> String {
    path.as_ref()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

/// Which provider a hostname belongs to. Only the ones with a preset; anything
/// else is generic, which is not a failure — it means the endpoints are carried
/// explicitly instead of by name.
fn provider_for(host: Option<&str>) -> Provider {
    let Some(host) = host.map(str::to_ascii_lowercase) else {
        return Provider::Generic;
    };
    if host.contains("gmail") || host.contains("googlemail") {
        Provider::Gmail
    } else if host.contains("office365") || host.contains("outlook") {
        Provider::Outlook
    } else if host.contains("fastmail") {
        Provider::Fastmail
    } else {
        Provider::Generic
    }
}

/// An `ecr oauth token X` PassCmd is a profile; anything else is a command that
/// prints a password, and is carried across verbatim rather than interpreted.
fn auth_from(pass_cmd: &str, id: &str) -> Auth {
    let cmd = pass_cmd.trim().trim_matches('"');
    let words: Vec<&str> = cmd.split_whitespace().collect();

    let binary = words.first().and_then(|w| w.rsplit('/').next());
    match (binary, words.get(1), words.get(2), words.get(3)) {
        (Some("ecr"), Some(&"oauth"), Some(&"token"), Some(profile)) => Auth::oauth(*profile),
        // The helper ecr used to shell out to. Its profiles are adopted on
        // first read, so the name still means something.
        (Some("oauthman"), Some(&"token"), Some(profile), _) => Auth::oauth(*profile),
        _ if cmd.is_empty() => Auth::oauth(id),
        _ => Auth::Command {
            command: words.into_iter().map(str::to_string).collect(),
        },
    }
}

fn imported_imap(
    imap: Option<&ecr_store::parse::ImapAccount>,
    provider: Provider,
) -> Option<Endpoint> {
    let imap = imap?;
    let host = imap.host.clone()?;
    let tls = match imap.tls_type.as_deref().map(str::to_ascii_uppercase) {
        Some(ref t) if t == "STARTTLS" => Tls::StartTls,
        Some(ref t) if t == "NONE" => Tls::None,
        _ => Tls::Implicit,
    };
    let endpoint = Endpoint {
        host,
        port: imap.port.unwrap_or(993),
        tls,
    };

    // Identical to the preset is not worth writing down.
    (Some(&endpoint) != provider.imap().as_ref()).then_some(endpoint)
}

fn imported_smtp(
    msmtp: Option<&ecr_store::parse::MsmtpAccount>,
    provider: Provider,
) -> Option<Endpoint> {
    let msmtp = msmtp?;
    let host = msmtp.host.clone()?;
    let starttls = msmtp.tls_starttls.unwrap_or(true);
    let endpoint = Endpoint {
        host,
        port: msmtp.port.unwrap_or(if starttls { 587 } else { 465 }),
        tls: if starttls {
            Tls::StartTls
        } else {
            Tls::Implicit
        },
    };

    (Some(&endpoint) != provider.smtp().as_ref()).then_some(endpoint)
}

/// The command that actually fetches the mail, spelled out.
///
/// `mbsync -a` by itself reads the reader's own config, which in managed mode is
/// not the one ecr generated — it would report no channels, over a setup that is
/// perfectly good.
fn first_sync(env: &Env, id: &str) -> String {
    format!(
        "    mbsync --config {} {id}",
        ecr_store::managed::render::isyncrc(&accounts::managed_dir(env)).display()
    )
}

fn managed_line(packages: &Packages) -> String {
    let managed: Vec<String> = MANAGED
        .iter()
        .filter(|kind| packages.is_managed(**kind))
        .map(|kind| kind.to_string())
        .collect();

    match managed.is_empty() {
        true => "ecr manages no configuration; every tool is self-managed.".to_string(),
        false => format!("ecr manages: {}", managed.join(", ")),
    }
}

/// `host`, `host:port`, or `host:port/starttls`.
fn endpoint(value: &str, default_port: u16) -> anyhow::Result<Endpoint> {
    let (rest, tls) = match value.split_once('/') {
        Some((rest, "starttls")) => (rest, Tls::StartTls),
        Some((rest, "none" | "plain")) => (rest, Tls::None),
        Some((rest, "tls" | "ssl" | "implicit")) => (rest, Tls::Implicit),
        Some((_, other)) => {
            anyhow::bail!("{other:?} is not a TLS mode; use starttls, tls, or none")
        }
        None => (value, Tls::Implicit),
    };

    let (host, port) = match rest.rsplit_once(':') {
        Some((host, port)) => (
            host,
            port.parse::<u16>()
                .map_err(|_| anyhow::anyhow!("{port:?} is not a port"))?,
        ),
        None => (rest, default_port),
    };

    if host.is_empty() {
        anyhow::bail!("{value:?} names no host");
    }
    Ok(Endpoint {
        host: host.to_string(),
        port,
        tls,
    })
}

/// Connects to an account's IMAP server and reports how far it got.
///
/// Read-only in the strictest sense: it authenticates, lists folders and hangs
/// up. Nothing is stored, no flag is set, no message is fetched.
pub async fn test(id: &str) -> anyhow::Result<()> {
    let env = Env::from_process();
    let accounts = Accounts::load(&env)?;

    // Falling back to the setup that is already working is the point, not a
    // convenience: the question "will ecr be able to reach this account" is one
    // worth answering *before* handing it anything, and on a self-managed
    // machine there is no accounts.toml to look in yet.
    let derived;
    let account = match accounts.accounts.accounts.get(id) {
        Some(account) => account,
        None => {
            let settings = ecr_store::ServerSettings::load_from_env(&env);
            let paths = ecr_store::MailPaths::with_packages(&env, &settings, &Packages::default())?;
            derived = derive(&paths).0;
            derived.accounts.get(id).ok_or_else(|| {
                anyhow::anyhow!(
                    "there is no account named {id:?}, in accounts.toml or in your own config"
                )
            })?
        }
    };

    let paths = ecr_store::MailPaths::discover()?;
    let profiles = paths.oauth_profiles();
    let mark = |ok: bool| if ok { "ok" } else { "--" };

    let imap = ecr_store::imap::probe(&profiles, account).await;
    println!(
        "IMAP {}:{}",
        account.imap().map(|e| e.host).unwrap_or_default(),
        account.imap().map(|e| e.port).unwrap_or_default()
    );
    println!("  {} reached the server", mark(imap.reached));
    println!("  {} TLS", mark(imap.tls));
    println!("  {} authenticated", mark(imap.authenticated));
    if let Some(error) = &imap.error {
        println!("  -- {error}");
    }
    if !imap.folders.is_empty() {
        println!("  {} folders, including:", imap.folders.len());
        for folder in imap.folders.iter().take(8) {
            println!("     {folder}");
        }
    }

    // Sending is the half a reader finds out about at the worst moment, so it
    // is checked here rather than the first time they write to somebody.
    let smtp = ecr_store::smtp::probe(&profiles, account).await;
    println!(
        "\nSMTP {}:{}",
        account.smtp().map(|e| e.host).unwrap_or_default(),
        account.smtp().map(|e| e.port).unwrap_or_default()
    );
    println!("  {} connected and authenticated", mark(smtp.authenticated));
    if let Some(error) = &smtp.error {
        println!("  -- {error}");
    }
    println!("\nNothing was sent, and nothing was written.");

    if !imap.ok() || !smtp.ok() {
        anyhow::bail!("this account cannot be reached as configured");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_endpoint_takes_a_bare_host_a_port_and_a_tls_mode() {
        let bare = endpoint("imap.example.com", 993).unwrap();
        assert_eq!(bare.port, 993);
        assert_eq!(bare.tls, Tls::Implicit);

        let ported = endpoint("imap.example.com:1993", 993).unwrap();
        assert_eq!(ported.port, 1993);

        let starttls = endpoint("smtp.example.com:587/starttls", 993).unwrap();
        assert_eq!(starttls.tls, Tls::StartTls);
        assert_eq!(starttls.host, "smtp.example.com");
    }

    #[test]
    fn a_nonsense_endpoint_is_refused_rather_than_guessed_at() {
        assert!(endpoint("imap.example.com:no", 993).is_err());
        assert!(endpoint("imap.example.com/quantum", 993).is_err());
        assert!(endpoint(":993", 993).is_err());
    }

    #[test]
    fn a_provider_is_recognised_from_its_hostname() {
        assert_eq!(provider_for(Some("imap.gmail.com")), Provider::Gmail);
        assert_eq!(
            provider_for(Some("outlook.office365.com")),
            Provider::Outlook
        );
        assert_eq!(provider_for(Some("imap.fastmail.com")), Provider::Fastmail);
        assert_eq!(provider_for(Some("mail.example.net")), Provider::Generic);
        assert_eq!(provider_for(None), Provider::Generic);
    }

    /// The `PassCmd` is how an imported account keeps its credentials. Reading
    /// `ecr oauth token X` as a *command* rather than as a profile would work
    /// right up until doctor could no longer report on the token.
    #[test]
    fn an_oauth_passcmd_is_read_as_a_profile_and_anything_else_verbatim() {
        assert_eq!(
            auth_from("\"ecr oauth token work\"", "fallback"),
            Auth::oauth("work")
        );
        assert_eq!(
            auth_from("/nix/store/abc/bin/ecr oauth token work", "fallback"),
            Auth::oauth("work")
        );
        // The helper ecr used to shell out to; its profiles are still adopted.
        assert_eq!(
            auth_from("oauthman token work", "fallback"),
            Auth::oauth("work")
        );

        assert_eq!(
            auth_from("pass show mail/work", "fallback"),
            Auth::Command {
                command: vec!["pass".into(), "show".into(), "mail/work".into()]
            }
        );
    }

    /// An imported endpoint that matches the preset exactly is not written down:
    /// an account reads as `gmail`, not as a wall of hostnames that happen to
    /// be Gmail's.
    #[test]
    fn an_endpoint_equal_to_the_preset_is_left_implicit() {
        let gmail_imap = ecr_store::parse::ImapAccount {
            host: Some("imap.gmail.com".into()),
            port: Some(993),
            tls_type: Some("IMAPS".into()),
            ..Default::default()
        };
        assert_eq!(imported_imap(Some(&gmail_imap), Provider::Gmail), None);

        let moved = ecr_store::parse::ImapAccount {
            port: Some(1993),
            ..gmail_imap
        };
        assert_eq!(
            imported_imap(Some(&moved), Provider::Gmail).map(|e| e.port),
            Some(1993)
        );
    }

    #[test]
    fn the_managed_line_names_the_tools_rather_than_saying_yes() {
        let none = Packages::default();
        assert!(managed_line(&none).contains("self-managed"));

        let some = Packages::parse("[packages.mbsync]\nmanagement = \"ecr\"\n");
        assert_eq!(managed_line(&some), "ecr manages: mbsync");
    }
}
