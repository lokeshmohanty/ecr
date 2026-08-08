//! Keeping folders in step with tags.
//!
//! ecr's model is tags. IMAP's model is folders. Three of the five marks bridge
//! that by themselves, because notmuch stores them as maildir flags and mbsync
//! sends flags: `unread`, `flagged` and `replied` are `S`, `F` and `R` on the
//! filename. The other two have no flag to live in — `inbox` and `archive` are
//! notmuch tags and nothing else — so archiving in ecr used to rename no file,
//! leave mbsync with nothing to send, and leave the message in the server's
//! inbox.
//!
//! This is the bridge for those. A tag names a folder; anything carrying that
//! tag and not already in that folder is moved there, and the move is what
//! mbsync propagates.
//!
//! ## Why it is a hook and not part of tagging
//!
//! Because the tag is the truth and anything may have written it. A tag applied
//! by `notmuch tag` at a shell, by afew, by another client against the same
//! database, or by ecr's own rules in `post-new` must all end in the same
//! place. Filing at the moment ecr writes a tag would move the ones ecr wrote
//! and silently ignore every other route to the same tag, which is a rule that
//! holds until the day somebody uses the tool the normal way.
//!
//! It runs from notmuch's **`pre-new`** hook, which is the one point where
//! moving is safe: files move, then `notmuch new` scans and finds them at their
//! new paths in the same run. Moving after the scan would leave the database
//! naming files that are no longer there until something ran again.
//!
//! ## Why it is a query and not a list of message ids
//!
//! `tag:deleted and not folder:Trash` is answered by notmuch against whatever
//! the database currently holds, so the hook is stateless and idempotent —
//! running it twice moves nothing the second time, and a run interrupted
//! halfway is simply a run that has less left to do.

use crate::error::Result;
use crate::paths::MailPaths;
use ecr_core::managed::{FolderRole, ManagedAccounts};

/// One tag, and where mail carrying it belongs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub tag: String,
    pub role: FolderRole,
}

/// What ecr files by default, and why each one.
///
/// Deliberately short. Every entry here moves somebody's mail on the strength
/// of a tag, so the list is the ones whose meaning is unambiguous across every
/// provider — a `deleted` message belongs in the trash everywhere. Anything
/// arguable is left to the reader to add.
///
/// `inbox` is **not** in it and cannot be: it is an absence, not a presence.
/// Archiving is *removing* `inbox`, so it is handled below by its own rule
/// rather than by a tag lookup, which is the one asymmetry in this module.
pub const DEFAULTS: &[(&str, FolderRole)] =
    &[("deleted", FolderRole::Trash), ("spam", FolderRole::Junk)];

/// The notmuch queries that file one account's mail, as `(query, folder)`.
///
/// Each query carries `not folder:<destination>` so a message already in the
/// right place is not moved onto itself — which would rename it for nothing,
/// and look to the delivery watcher exactly like a new message arriving.
pub fn queries(accounts: &ManagedAccounts, id: &str) -> Vec<(String, String)> {
    let Some(account) = accounts.accounts.get(id) else {
        return Vec::new();
    };
    let mut out = Vec::new();

    for (tag, role) in DEFAULTS {
        let Some(folder) = account.folder(*role) else {
            continue;
        };
        out.push((
            format!("tag:{tag} and path:\"{id}/**\" and not path:\"{id}/{folder}/**\""),
            format!("{id}/{folder}"),
        ));
    }

    // Archiving is the absence of `inbox`, not the presence of anything, so it
    // cannot be a tag lookup. The extra clauses matter: without them a sent
    // message, a draft and everything already in the trash all lack `inbox`
    // too, and every one of them would be swept into the archive on the first
    // run — which is a mailbox nobody can put back.
    if let (Some(inbox), Some(archive)) = (
        account.folder(FolderRole::Inbox),
        account.folder(FolderRole::Archive),
    ) {
        let mut excluded = vec![format!("not path:\"{id}/{archive}/**\"")];
        for role in [
            FolderRole::Sent,
            FolderRole::Drafts,
            FolderRole::Trash,
            FolderRole::Junk,
        ] {
            if let Some(folder) = account.folder(role) {
                excluded.push(format!("not path:\"{id}/{folder}/**\""));
            }
        }

        out.push((
            format!(
                "not tag:inbox and path:\"{id}/{inbox}/**\" and {}",
                excluded.join(" and ")
            ),
            format!("{id}/{archive}"),
        ));
    }

    out
}

/// What one filing pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Filed {
    pub moved: usize,
    /// Messages a rule matched that could not be moved, with the reason.
    pub problems: Vec<String>,
}

/// Files every account's mail according to its tags.
///
/// Never fails the caller for one message it could not move. This runs from a
/// hook in front of `notmuch new`, and a hook that exits non-zero stops the
/// scan — so one unreadable file would cost the reader every message that
/// arrived in that sync, to save them one misplaced one.
pub async fn run(
    paths: &MailPaths,
    notmuch: &crate::Notmuch,
    accounts: &ManagedAccounts,
) -> Result<Filed> {
    let mut filed = Filed::default();

    for (id, _) in accounts.enabled() {
        for (query, destination) in queries(accounts, id) {
            let files = notmuch.files_matching(&query).await.unwrap_or_default();

            for file in files {
                match crate::folders::move_file(paths, &file, &destination) {
                    Ok(()) => filed.moved += 1,
                    Err(err) => filed.problems.push(format!("{}: {err}", file.display())),
                }
            }
        }
    }

    Ok(filed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ecr_core::managed::{Auth, ManagedAccount, Provider};

    fn accounts_for(provider: Provider) -> ManagedAccounts {
        let mut accounts = ManagedAccounts::default();
        accounts.accounts.insert(
            "main".into(),
            ManagedAccount::new("a@example.com", provider, Auth::oauth("main")),
        );
        accounts
    }

    fn queries_for(id: &str) -> Vec<(String, String)> {
        queries(&accounts_for(Provider::Gmail), id)
    }

    #[test]
    fn deleted_mail_is_filed_into_the_trash() {
        let queries = queries_for("main");
        let (query, destination) = queries
            .iter()
            .find(|(q, _)| q.starts_with("tag:deleted"))
            .expect("nothing files deleted mail");

        assert!(destination.contains("Trash"), "{destination}");
        assert!(query.contains("path:\"main/**\""), "{query}");
    }

    /// Without this a message already in the trash is renamed on every single
    /// sync — for nothing, and looking to the delivery watcher exactly like a
    /// new message arriving each time.
    #[test]
    fn a_message_already_in_its_folder_is_not_moved_onto_itself() {
        for (query, destination) in queries_for("main") {
            let folder = destination.trim_start_matches("main/");
            assert!(
                query.contains(&format!("not path:\"main/{folder}/**\"")),
                "{query} would move mail that is already in {destination}"
            );
        }
    }

    /// The one that would be catastrophic. Archiving is the *absence* of
    /// `inbox`, and sent mail, drafts, trash and spam all lack it too — so a
    /// naive `not tag:inbox` sweeps the entire mailbox into the archive on the
    /// first run, which is not something anybody can put back.
    #[test]
    fn archiving_does_not_sweep_up_everything_that_is_merely_not_in_the_inbox() {
        let accounts = accounts_for(Provider::Outlook);
        let queries = queries(&accounts, "main");
        let (query, destination) = queries
            .iter()
            .find(|(q, _)| q.starts_with("not tag:inbox"))
            .expect("nothing archives");

        assert!(destination.contains("Archive"), "{destination}");
        // Scoped to what is actually in the inbox folder, which is the real
        // guard: nothing outside it can be swept anywhere.
        assert!(query.contains("path:\"main/Inbox/**\""), "{query}");

        for folder in ["Sent Items", "Drafts", "Deleted Items", "Junk Email"] {
            assert!(
                query.contains(folder),
                "{folder} is not excluded from archiving: {query}"
            );
        }
    }

    /// Gmail's archive is `[Gmail]/All Mail`, which ecr deliberately does not
    /// sync — it holds a copy of every message in the account and would double
    /// the maildir. So there is nowhere for a Gmail message to be archived
    /// *to*, and filing must produce no archive rule at all rather than invent
    /// a destination.
    ///
    /// This is the one place where filing cannot close the gap, and it is
    /// better to file nothing than to move a Gmail message somewhere ecr made
    /// up. `ecr doctor` is where a Gmail account is told that archiving stays
    /// local.
    #[test]
    fn gmail_has_nowhere_to_archive_to_and_files_nothing_for_it() {
        assert!(
            !queries_for("main")
                .iter()
                .any(|(q, _)| q.starts_with("not tag:inbox")),
            "Gmail invented an archive folder"
        );
    }

    #[test]
    fn an_account_nobody_configured_files_nothing() {
        assert!(queries_for("absent").is_empty());
    }

    /// `inbox` must never appear as a *tag* rule. It is an absence, and a rule
    /// that filed on its presence would move every message in the mailbox into
    /// the inbox folder.
    #[test]
    fn inbox_is_not_among_the_tags_that_name_a_folder() {
        assert!(!DEFAULTS.iter().any(|(tag, _)| *tag == "inbox"));
    }
}
