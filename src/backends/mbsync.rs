use std::fs;
use std::path::Path;

pub struct AccountInfo {
    pub email: String,
    pub name: String,
    pub maildir_path: String,
}

pub fn get_accounts() -> Vec<AccountInfo> {
    let mail_base = dirs::data_dir()
        .map(|p| p.join("mail"))
        .unwrap_or_else(|| Path::new("").to_path_buf());

    let mut accounts = Vec::new();

    if let Ok(entries) = fs::read_dir(&mail_base) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();

                if !name.starts_with('.') && !name.is_empty() {
                    accounts.push(AccountInfo {
                        email: name.clone(),
                        name: name.clone(),
                        maildir_path: path.to_string_lossy().to_string(),
                    });
                }
            }
        }
    }

    if accounts.is_empty() {
        accounts.push(AccountInfo {
            email: "default".to_string(),
            name: "default".to_string(),
            maildir_path: mail_base.join("default").to_string_lossy().to_string(),
        });
    }

    accounts
}

pub fn get_mailboxes_for_account(account_path: &str) -> Vec<String> {
    let path = Path::new(account_path);
    let mut mailboxes = Vec::new();

    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                let name = entry_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();

                let is_gmail_folder = name.starts_with('[');
                if !is_gmail_folder && !name.is_empty() && name != ".notmuch" {
                    mailboxes.push(name);
                }
            }
        }
    }

    mailboxes.sort();
    mailboxes
}

pub fn get_mailboxes(_config_path: &str) -> Vec<String> {
    let accounts = get_accounts();
    if let Some(first) = accounts.first() {
        return get_mailboxes_for_account(&first.maildir_path);
    }
    vec![
        "INBOX".to_string(),
        "Drafts".to_string(),
        "Sent".to_string(),
        "Archive".to_string(),
    ]
}

pub async fn sync_all() -> std::io::Result<()> {
    let mut child = tokio::process::Command::new("mbsync")
        .arg("-a")
        .spawn()?;

    let status = child.wait().await?;
    if !status.success() {
        return Err(std::io::Error::other(
            format!("mbsync -a failed with status {}", status),
        ));
    }

    // Also run notmuch new to index new mail
    let mut notmuch_child = tokio::process::Command::new("notmuch")
        .arg("new")
        .spawn()?;
    notmuch_child.wait().await?;

    Ok(())
}

pub async fn sync_account(account: &str) -> std::io::Result<()> {
    let mut child = tokio::process::Command::new("mbsync")
        .arg(account)
        .spawn()?;

    let status = child.wait().await?;
    if !status.success() {
        return Err(std::io::Error::other(
            format!("mbsync {} failed with status {}", account, status),
        ));
    }

    // Also run notmuch new to index new mail
    let mut notmuch_child = tokio::process::Command::new("notmuch")
        .arg("new")
        .spawn()?;
    notmuch_child.wait().await?;

    Ok(())
}
