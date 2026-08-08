//! Switching the vacation responder on and off.
//!
//! The server decides *what* to answer — `ecr_core::vacation` is the whole of
//! that, and it is almost entirely a list of what must not be replied to. This
//! is only the half somebody types.

use ecr_store::managed::accounts::Accounts;
use ecr_store::paths::Env;
use std::path::PathBuf;

/// Where the responder records who it has already answered.
///
/// The server owns this file; the CLI only reads it, and only for `forget`
/// does it write — which is a deliberate act, unlike everything else here.
fn ledger_path(env: &Env) -> anyhow::Result<PathBuf> {
    let paths =
        ecr_store::paths::MailPaths::with(env, &ecr_store::settings::ServerSettings::load())?;
    Ok(paths.ecr_state_dir.join("vacation-sent.json"))
}

pub fn show() -> anyhow::Result<()> {
    let env = Env::from_process();
    let accounts = Accounts::load(&env)?;

    let Some(vacation) = accounts.accounts.vacation.as_ref() else {
        println!("the vacation responder has never been set up");
        println!("  ecr account vacation on --body 'I am away until Monday'");
        return Ok(());
    };

    // Whether it is *on* is not the same question as whether it is enabled: a
    // window that has closed leaves `enabled = true` in the file, which is
    // exactly what somebody wants to see when they come back and wonder
    // whether it stopped.
    let now = super::dates::now_seconds();
    let within = vacation.from.is_none_or(|s| now >= s) && vacation.until.is_none_or(|e| now <= e);

    println!(
        "  status   {}",
        match (vacation.enabled, within) {
            (false, _) => "off",
            (true, false) => "on, but outside its dates — nothing is being sent",
            (true, true) => "on — replying to new mail",
        }
    );
    if let Some(subject) = &vacation.subject {
        println!("  subject  {subject}");
    }
    if let Some(from) = vacation.from {
        println!("  from     {}", super::dates::format(from));
    }
    if let Some(until) = vacation.until {
        println!("  until    {}", super::dates::format(until));
    }
    println!("  every    {} days per person", vacation.interval_days);
    if let Some(query) = &vacation.query {
        println!("  only     {query}");
    }
    println!();
    for line in vacation.body.lines() {
        println!("  | {line}");
    }

    if let Ok(path) = ledger_path(&env) {
        let told = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| {
                serde_json::from_str::<std::collections::BTreeMap<String, i64>>(&text).ok()
            })
            .unwrap_or_default();
        println!();
        println!("  told     {} people so far", told.len());
    }
    Ok(())
}

pub fn on(
    body: &str,
    subject: Option<String>,
    from: Option<String>,
    until: Option<String>,
    every: u32,
) -> anyhow::Result<()> {
    let env = Env::from_process();
    let mut accounts = Accounts::load(&env)?;

    // A dash means stdin, because a holiday notice is several lines and the
    // shell quoting for that is worse than the feature.
    let body = if body == "-" {
        std::io::read_to_string(std::io::stdin())?
    } else {
        body.to_string()
    };
    if body.trim().is_empty() {
        anyhow::bail!("the reply needs a message; an empty one is worse than no responder at all");
    }

    let existing = accounts.accounts.vacation.clone().unwrap_or_default();
    let vacation = ecr_core::vacation::Vacation {
        enabled: true,
        body,
        subject: subject.or(existing.subject),
        from: from.map(|d| super::dates::parse(&d)).transpose()?,
        until: until.map(|d| super::dates::parse(&d)).transpose()?,
        interval_days: every,
        query: existing.query,
    };

    // Switching it on is the moment to say what it will not answer, because it
    // is the only moment somebody is reading. The list is not a caveat — it is
    // the feature, and a responder without it is one that writes to every
    // mailing list its owner is on.
    accounts.accounts.vacation = Some(vacation);
    accounts.save()?;

    println!("the vacation responder is on.");
    println!();
    println!("  It will not answer mailing lists, bounces, other autoresponders,");
    println!("  your own addresses, mail you were only Bcc'd on, or the same");
    println!("  person more than once every {every} days.");
    println!();
    println!("  ecr account vacation off   when you are back");
    Ok(())
}

pub fn off() -> anyhow::Result<()> {
    let env = Env::from_process();
    let mut accounts = Accounts::load(&env)?;

    match accounts.accounts.vacation.as_mut() {
        None => println!("the vacation responder was never set up"),
        Some(vacation) => {
            // The message is kept. Somebody switching it off has come back from
            // one holiday, not sworn off them, and retyping the notice is the
            // reason people leave a responder running.
            vacation.enabled = false;
            accounts.save()?;
            println!("the vacation responder is off. The message is kept for next time");
        }
    }
    Ok(())
}

pub fn forget() -> anyhow::Result<()> {
    let env = Env::from_process();
    let path = ledger_path(&env)?;

    match std::fs::remove_file(&path) {
        Ok(()) => println!("forgot who had been told; everyone will be answered again"),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            println!("nobody has been told yet")
        }
        Err(err) => anyhow::bail!("could not clear {}: {err}", path.display()),
    }
    Ok(())
}
