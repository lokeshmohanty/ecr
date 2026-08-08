//! Moving a message between folders.
//!
//! ecr tags; until now it could not *move*. That is the biggest behavioural gap
//! against a client where filing something means dragging it somewhere — and it
//! is also the one operation here that touches the only copy of anything, so it
//! is the most carefully bounded.
//!
//! A move is a maildir rename: the file goes from one folder's `cur/` to
//! another's, keeping its flags, and notmuch is told to look again. It is a
//! rename within one filesystem, which is atomic — the message is in exactly
//! one of the two places at every instant, never both and never neither.
//!
//! What this does **not** do is tell the server. mbsync notices a message that
//! has moved on the next sync and propagates it, which is the same path a move
//! made by any other maildir client takes.

use crate::error::{Error, Result};
use crate::paths::MailPaths;
use ecr_core::message::MessageId;
use std::path::{Path, PathBuf};

/// A folder a message can be moved into.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Folder {
    /// Relative to the maildir root, e.g. `main/Archive`.
    pub path: String,
    pub account: String,
    pub name: String,
}

/// Every folder under the maildir root, as move destinations.
pub fn list(paths: &MailPaths) -> Vec<Folder> {
    let mut out = Vec::new();
    for account in crate::discovery::accounts(paths) {
        for folder in &account.folders {
            out.push(Folder {
                path: folder.relative_path.clone(),
                account: account.id.to_string(),
                name: folder.name.clone(),
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Moves one message into a folder. Answers where it landed.
///
/// The destination is a folder *under the maildir root*, named the way
/// `discovery` names it. Anything else is refused rather than resolved: this
/// renames a file, and a destination that could climb out of the maildir is a
/// rename into somebody's home directory.
pub async fn move_message(
    paths: &MailPaths,
    notmuch: &crate::Notmuch,
    id: &MessageId,
    destination: &str,
) -> Result<PathBuf> {
    let target = resolve(paths, destination)?;

    let from = notmuch.message_file(id).await?;

    // A message notmuch knows about but whose file has gone is a database that
    // is behind, not a move that failed.
    if !from.is_file() {
        return Err(Error::MessageNotFound { id: id.to_string() });
    }
    if from.starts_with(&target) {
        // Already there. Renaming it onto itself would churn the flags for
        // nothing and look, to the watcher, like a delivery.
        return Ok(from);
    }

    let name = from
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::Managed("that message has no filename".into()))?;

    // Into `cur/`, not `new/`. A moved message has been seen — it was in a list
    // somebody was reading — and putting it in `new/` would have every client
    // announce it as newly delivered mail.
    let dir = target.join("cur");
    std::fs::create_dir_all(&dir)?;
    let to = dir.join(renamed_for_move(name));

    // Rename rather than copy-and-delete: within one filesystem it is atomic,
    // so the message is in exactly one of the two places at every instant. A
    // copy that failed halfway leaves two, and a delete that ran first leaves
    // none.
    std::fs::rename(&from, &to).map_err(|err| {
        Error::Managed(format!(
            "could not move {} into {}: {err}",
            from.display(),
            destination
        ))
    })?;

    // notmuch tracks a message by its file. Until it looks again it believes
    // this one is still where it was, so every query naming the old folder
    // answers with a message that is not there.
    notmuch.index_new().await?;
    Ok(to)
}

/// Moves one file that is already known, without asking notmuch for it.
///
/// The filing pass has the path in hand from a single `notmuch search`, so
/// looking each one up again by message id would be one process per message
/// over a whole mailbox. It also does not reindex: the caller is `pre-new`,
/// and the `notmuch new` about to run is what picks up every move at once.
pub fn move_file(paths: &MailPaths, from: &Path, destination: &str) -> Result<()> {
    let target = resolve(paths, destination)?;
    if from.starts_with(&target) {
        return Ok(());
    }

    let name = from
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| Error::Managed("that message has no filename".into()))?;

    let dir = target.join("cur");
    std::fs::create_dir_all(&dir)?;
    let to = dir.join(renamed_for_move(name));

    std::fs::rename(from, &to).map_err(|err| {
        Error::Managed(format!(
            "could not move {} into {destination}: {err}",
            from.display()
        ))
    })
}

/// The filename a moved message must take.
///
/// mbsync's default UID mapping scheme encodes the IMAP UID in the filename as
/// a `,U=<n>` infix, and that UID belongs to the folder the message was in.
/// Carrying it into another folder hands mbsync a message claiming a UID that
/// means something else there, which corrupts the sync state for both — the
/// manual is explicit that an MUA moving a message between maildirs must
/// rename the file, and that stripping this infix is sufficient.
///
/// The maildir flags are kept: the `:2,S` suffix says the message has been
/// read, and dropping it on the way to the Archive marks a whole mailbox
/// unread.
fn renamed_for_move(name: &str) -> String {
    // Everything from `,U=` up to the flag separator. Splitting on `:` first
    // means a `,U=` that somehow appears inside the flags is left alone.
    let (base, flags) = match name.split_once(':') {
        Some((base, flags)) => (base, Some(flags)),
        None => (name, None),
    };

    let stripped = match base.find(",U=") {
        None => base.to_string(),
        Some(at) => {
            let rest = &base[at + 3..];
            let end = rest
                .find(|c: char| !c.is_ascii_digit())
                .map(|i| at + 3 + i)
                .unwrap_or(base.len());
            format!("{}{}", &base[..at], &base[end..])
        }
    };

    match flags {
        Some(flags) => format!("{stripped}:{flags}"),
        None => stripped,
    }
}

/// Resolves a folder name to a directory inside the maildir root.
///
/// A boundary, not a convenience: this ends in a rename, so a destination that
/// is absolute or climbs with `..` is refused rather than clamped — the same
/// rule, and for the same reason, as `MailPaths::resolve_relative`.
pub fn resolve(paths: &MailPaths, destination: &str) -> Result<PathBuf> {
    let unsafe_path = |reason| Error::UnsafePath {
        path: destination.to_string(),
        reason,
    };

    if destination.trim().is_empty() {
        return Err(unsafe_path("it is empty"));
    }
    let candidate = Path::new(destination);
    if candidate.is_absolute() {
        return Err(unsafe_path("it is absolute"));
    }
    for part in candidate.components() {
        match part {
            std::path::Component::Normal(_) | std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                return Err(unsafe_path("it climbs above the maildir"))
            }
            _ => return Err(unsafe_path("it is absolute")),
        }
    }

    let target = paths.maildir_root.join(candidate);
    // It has to be a maildir already. Creating one on demand would let a typo
    // become a folder, and a message filed into a folder that exists only
    // because it was misspelled is a message nobody finds again.
    if !target.join("cur").is_dir() {
        return Err(Error::Managed(format!(
            "{destination} is not a folder under the maildir; \
             ecr does not create folders, mbsync does"
        )));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Env;
    use crate::settings::ServerSettings;

    fn fixture() -> (tempfile::TempDir, MailPaths) {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("Mail");
        for folder in ["main/Inbox", "main/Archive"] {
            for leaf in ["cur", "new", "tmp"] {
                std::fs::create_dir_all(root.join(folder).join(leaf)).unwrap();
            }
        }
        let config = home.path().join(".config/notmuch/default");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(
            config.join("config"),
            format!("[database]\npath={}\n", root.display()),
        )
        .unwrap();

        let paths =
            MailPaths::with(&Env::rooted_at(home.path()), &ServerSettings::default()).unwrap();
        (home, paths)
    }

    #[test]
    fn every_folder_under_the_root_is_a_destination() {
        let (_home, paths) = fixture();
        let names: Vec<String> = list(&paths).into_iter().map(|f| f.path).collect();

        assert!(names.contains(&"main/Inbox".to_string()), "{names:?}");
        assert!(names.contains(&"main/Archive".to_string()), "{names:?}");
    }

    /// This ends in a rename. A destination that can climb out of the maildir
    /// is a rename into somebody's home directory.
    #[test]
    fn a_destination_that_climbs_out_of_the_maildir_is_refused() {
        let (_home, paths) = fixture();

        for attempt in ["../elsewhere", "main/../../etc", "/etc", ""] {
            assert!(
                resolve(&paths, attempt).is_err(),
                "{attempt:?} was accepted"
            );
        }
    }

    /// A folder created on demand lets a typo become a folder, and a message
    /// filed into one is a message nobody finds again.
    #[test]
    fn a_folder_that_does_not_exist_is_refused_rather_than_created() {
        let (_home, paths) = fixture();

        let err = resolve(&paths, "main/Typo").unwrap_err().to_string();
        assert!(err.contains("does not create folders"), "{err}");
        assert!(!paths.maildir_root.join("main/Typo").exists());
    }

    #[test]
    fn a_real_folder_resolves_inside_the_root() {
        let (_home, paths) = fixture();
        assert_eq!(
            resolve(&paths, "main/Archive").unwrap(),
            paths.maildir_root.join("main/Archive")
        );
    }

    /// The trap the isync manual names outright: an MUA moving a message
    /// between maildirs must rename the file. `,U=<n>` encodes the IMAP UID,
    /// which belongs to the folder the message was *in* — carried across it
    /// claims a UID that means something else in the destination and corrupts
    /// the sync state for both folders.
    #[test]
    fn a_moved_file_loses_the_uid_that_belonged_to_its_old_folder() {
        assert_eq!(
            renamed_for_move("1699999999.12345_1.host,U=4711:2,S"),
            "1699999999.12345_1.host:2,S"
        );
    }

    /// The flags are not the UID. Dropping `:2,S` on the way to the Archive
    /// marks a whole mailbox unread, which is the most visible possible way to
    /// get this wrong.
    #[test]
    fn the_maildir_flags_survive_the_move() {
        for name in [
            "1699999999.12345.host:2,S",
            "1699999999.12345.host:2,FRS",
            "1699999999.12345.host:2,",
        ] {
            assert_eq!(renamed_for_move(name), name, "{name} lost its flags");
        }
    }

    #[test]
    fn a_name_with_no_uid_infix_is_left_exactly_as_it_is() {
        for name in ["plain", "1699999999.12345_1.host:2,S", "has,commas:2,S"] {
            assert_eq!(renamed_for_move(name), name);
        }
    }

    /// A UID at the very end, with no flags after it, is the case an
    /// off-by-one in the scan silently mangles into a truncated filename.
    #[test]
    fn a_uid_at_the_end_of_the_name_is_removed_cleanly() {
        assert_eq!(
            renamed_for_move("1699999999.12345.host,U=4711"),
            "1699999999.12345.host"
        );
    }
}
