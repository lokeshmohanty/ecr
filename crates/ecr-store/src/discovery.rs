use crate::paths::MailPaths;
use ecr_core::account::{Account, AccountId, Folder, FolderKind};
use std::path::Path;

const MAX_FOLDER_DEPTH: usize = 4;

pub fn accounts(paths: &MailPaths) -> Vec<Account> {
    let Ok(entries) = std::fs::read_dir(&paths.maildir_root) else {
        return Vec::new();
    };

    let mut accounts: Vec<Account> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            (!name.starts_with('.')).then(|| build_account(paths, &name, &e.path()))
        })
        .collect();

    accounts.sort_by(|a, b| a.id.cmp(&b.id));
    accounts
}

fn build_account(paths: &MailPaths, name: &str, dir: &Path) -> Account {
    let id = AccountId(name.to_string());
    let mbsync_channel = channel_for(paths, dir);

    let address = mbsync_channel
        .as_deref()
        .and_then(|c| paths.mbsync_config.channel_imap_account(c))
        .and_then(|a| a.user.clone())
        .or_else(|| {
            let msmtp = paths.msmtp_config.accounts.get(name)?;
            msmtp.from.clone().or_else(|| msmtp.user.clone())
        });

    let msmtp_account = msmtp_account_for(paths, name, address.as_deref());

    Account {
        folders: folders(&id, dir),
        display_name: address.clone().unwrap_or_else(|| name.to_string()),
        id,
        maildir_path: dir.to_path_buf(),
        address,
        mbsync_channel,
        msmtp_account,
    }
}

pub fn oauth_profile(paths: &MailPaths, account: &Account) -> Option<String> {
    paths
        .mbsync_config
        .channel_imap_account(account.mbsync_channel.as_deref()?)?
        .oauth_profile()
        .map(str::to_string)
}

fn channel_for(paths: &MailPaths, account_dir: &Path) -> Option<String> {
    paths
        .mbsync_config
        .channels
        .keys()
        .find(|channel| {
            paths
                .mbsync_config
                .channel_maildir(channel)
                .is_some_and(|near| same_dir(near, account_dir))
        })
        .cloned()
}

fn same_dir(a: &Path, b: &Path) -> bool {
    let normalize = |p: &Path| {
        p.to_string_lossy()
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };
    normalize(a) == normalize(b)
}

fn msmtp_account_for(paths: &MailPaths, name: &str, address: Option<&str>) -> Option<String> {
    if paths.msmtp_config.accounts.contains_key(name) {
        return Some(name.to_string());
    }
    address
        .and_then(|a| paths.msmtp_config.account_for_address(a))
        .map(str::to_string)
}

fn folders(account: &AccountId, dir: &Path) -> Vec<Folder> {
    let mut found = Vec::new();
    collect_folders(account, dir, "", 0, &mut found);
    found.sort_by(|a, b| {
        a.kind
            .sort_rank()
            .cmp(&b.kind.sort_rank())
            .then_with(|| a.name.cmp(&b.name))
    });
    found
}

fn collect_folders(
    account: &AccountId,
    dir: &Path,
    prefix: &str,
    depth: usize,
    out: &mut Vec<Folder>,
) {
    if depth > MAX_FOLDER_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || is_maildir_leaf(&name) {
            continue;
        }

        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };

        if is_maildir(&path) {
            out.push(Folder::new(account, relative.clone()));
        }
        collect_folders(account, &path, &relative, depth + 1, out);
    }
}

fn is_maildir_leaf(name: &str) -> bool {
    matches!(name, "cur" | "new" | "tmp")
}

fn is_maildir(dir: &Path) -> bool {
    dir.join("cur").is_dir()
}

pub fn unclassified_folder_count(account: &Account) -> usize {
    account
        .folders
        .iter()
        .filter(|f| f.kind == FolderKind::Other)
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::Env;
    use crate::settings::ServerSettings;
    use std::fs;

    fn maildir(root: &Path, relative: &str) {
        for leaf in ["cur", "new", "tmp"] {
            fs::create_dir_all(root.join(relative).join(leaf)).unwrap();
        }
    }

    fn fixture() -> (tempfile::TempDir, MailPaths) {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("Mail");

        maildir(&root, "main/Inbox");
        maildir(&root, "main/Sent");
        maildir(&root, "main/Archive");
        maildir(&root, "main/[Gmail]/All Mail");
        maildir(&root, "main/General Payments");
        maildir(&root, "team/Inbox");
        fs::create_dir_all(root.join(".notmuch/xapian")).unwrap();

        let cfg_dir = home.path().join(".config");
        fs::create_dir_all(cfg_dir.join("notmuch/default")).unwrap();
        fs::write(
            cfg_dir.join("notmuch/default/config"),
            format!("[database]\npath={}\n", root.display()),
        )
        .unwrap();
        fs::write(
            cfg_dir.join("isyncrc"),
            format!(
                "IMAPAccount main\nUser alice@example.com\nPassCmd \"oauthman token main\"\n\n\
                 IMAPStore main-remote\nAccount main\n\n\
                 MaildirStore main-local\nPath {}/main/\n\n\
                 Channel main\nFar :main-remote:\nNear :main-local:\n",
                root.display()
            ),
        )
        .unwrap();
        fs::create_dir_all(cfg_dir.join("msmtp")).unwrap();
        fs::write(
            cfg_dir.join("msmtp/config"),
            "account main\nfrom alice@example.com\nuser alice@example.com\naccount default : main\n",
        )
        .unwrap();

        let paths =
            MailPaths::with(&Env::rooted_at(home.path()), &ServerSettings::default()).unwrap();
        (home, paths)
    }

    #[test]
    fn discovers_every_account_directory() {
        let (_home, paths) = fixture();
        let accounts = accounts(&paths);
        let ids: Vec<_> = accounts.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, vec!["main", "team"]);
    }

    #[test]
    fn skips_the_notmuch_database_directory() {
        let (_home, paths) = fixture();
        assert!(accounts(&paths).iter().all(|a| a.id.as_str() != ".notmuch"));
    }

    #[test]
    fn finds_nested_and_spaced_folder_names() {
        let (_home, paths) = fixture();
        let main = accounts(&paths).into_iter().next().unwrap();
        let names: Vec<_> = main.folders.iter().map(|f| f.name.as_str()).collect();

        assert!(names.contains(&"Inbox"));
        assert!(names.contains(&"General Payments"));
        assert!(names.contains(&"[Gmail]/All Mail"));
    }

    #[test]
    fn cur_new_tmp_are_never_treated_as_folders() {
        let (_home, paths) = fixture();
        let main = accounts(&paths).into_iter().next().unwrap();
        assert!(main
            .folders
            .iter()
            .all(|f| !["cur", "new", "tmp"].contains(&f.name.as_str())));
    }

    #[test]
    fn folders_sort_inbox_first() {
        let (_home, paths) = fixture();
        let main = accounts(&paths).into_iter().next().unwrap();
        assert_eq!(main.folders[0].name, "Inbox");
    }

    #[test]
    fn links_the_account_to_its_mbsync_channel() {
        let (_home, paths) = fixture();
        let accounts = accounts(&paths);
        let main = accounts.iter().find(|a| a.id.as_str() == "main").unwrap();
        let team = accounts.iter().find(|a| a.id.as_str() == "team").unwrap();

        assert_eq!(main.mbsync_channel.as_deref(), Some("main"));
        assert!(main.can_sync());
        assert_eq!(team.mbsync_channel, None);
        assert!(!team.can_sync());
    }

    #[test]
    fn links_the_account_to_its_msmtp_account() {
        let (_home, paths) = fixture();
        let accounts = accounts(&paths);
        let main = accounts.iter().find(|a| a.id.as_str() == "main").unwrap();

        assert_eq!(main.msmtp_account.as_deref(), Some("main"));
        assert_eq!(main.address.as_deref(), Some("alice@example.com"));
    }

    #[test]
    fn an_account_with_no_imap_block_does_not_borrow_another_accounts_identity() {
        let (_home, paths) = fixture();
        let accounts = accounts(&paths);
        let team = accounts.iter().find(|a| a.id.as_str() == "team").unwrap();

        assert_eq!(team.address, None);
        assert_eq!(team.msmtp_account, None);
        assert!(!team.can_send());
    }

    #[test]
    fn exposes_the_oauth_profile_backing_an_account() {
        let (_home, paths) = fixture();
        let accounts = accounts(&paths);
        let main = accounts.iter().find(|a| a.id.as_str() == "main").unwrap();
        let team = accounts.iter().find(|a| a.id.as_str() == "team").unwrap();

        assert_eq!(oauth_profile(&paths, main).as_deref(), Some("main"));
        assert_eq!(oauth_profile(&paths, team), None);
    }

    #[test]
    fn nested_folder_query_is_recursive() {
        let (_home, paths) = fixture();
        let main = accounts(&paths).into_iter().next().unwrap();
        let all_mail = main.folder("[Gmail]/All Mail").unwrap();
        assert_eq!(all_mail.query(), "path:\"main/[Gmail]/All Mail/**\"");
    }
}
