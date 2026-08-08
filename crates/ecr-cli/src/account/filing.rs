//! `ecr account file` — moving mail into folders to match its tags.
//!
//! This is what the generated `pre-new` hook calls on every sync.

use ecr_store::managed::accounts::Accounts;
use ecr_store::paths::Env;

/// Files mail into folders according to its tags.
///
/// This is what the generated `pre-new` hook calls, and it is deliberately a
/// command rather than a shell loop in the hook: a maildir path can contain
/// spaces, brackets and — legally — a newline, and Gmail's `[Gmail]/…` folders
/// already prove real servers use whatever they like. A `while read` loop over
/// `notmuch search --output=files` mangles all three.
///
/// `--dry-run` is the whole reason somebody would run this by hand. It moves
/// mail on the strength of a tag, so being able to see what it *would* move
/// before it does is worth more than the command itself.
pub async fn run(dry_run: bool) -> anyhow::Result<()> {
    let env = Env::from_process();
    let accounts = Accounts::load(&env)?;

    if accounts.accounts.is_empty() {
        println!("no managed accounts, so there is nothing to file");
        return Ok(());
    }

    let store = ecr_store::NotmuchStore::open()?;
    let paths = store.paths();

    if dry_run {
        let mut total = 0usize;
        for (id, _) in accounts.accounts.enabled() {
            for (query, destination) in ecr_store::filing::queries(&accounts.accounts, id) {
                let files = store
                    .notmuch()
                    .files_matching(&query)
                    .await
                    .unwrap_or_default();
                if files.is_empty() {
                    continue;
                }
                println!("  {} → {destination}", files.len());
                for file in &files {
                    println!("      {}", file.display());
                }
                total += files.len();
            }
        }
        println!();
        println!("{total} would move. Nothing was changed.");
        return Ok(());
    }

    let filed = ecr_store::filing::run(paths, store.notmuch(), &accounts.accounts).await?;

    // Reported even when nothing moved: this runs from a hook on every sync,
    // and a command that is silent when it works and silent when it has
    // nothing to do gives nobody a way to tell those apart.
    for problem in &filed.problems {
        eprintln!("  could not file {problem}");
    }
    if filed.moved > 0 {
        println!("filed {} message(s)", filed.moved);
    }
    Ok(())
}
