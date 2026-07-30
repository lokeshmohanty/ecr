use crate::error::{Error, Result};
use crate::paths::MailPaths;
use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub fn argv(config: Option<&Path>, account: &str) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(config) = config {
        args.push("--file".to_string());
        args.push(config.display().to_string());
    }
    args.push("--account".to_string());
    args.push(account.to_string());
    args.push("--read-recipients".to_string());
    args
}

pub async fn send(paths: &MailPaths, account: &str, raw: &[u8]) -> Result<()> {
    if !paths.msmtp_config.accounts.contains_key(account) {
        return Err(Error::UnknownSendAccount {
            account: account.to_string(),
        });
    }

    let args = argv(paths.msmtp.path.as_deref(), account);

    let mut child = Command::new(&paths.binaries.msmtp)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::ToolMissing {
                tool: crate::tools::MSMTP,
            },
            _ => Error::Io(e),
        })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(raw).await?;
        stdin.shutdown().await?;
    }

    let output = child.wait_with_output().await?;
    if !output.status.success() {
        return Err(Error::ToolFailed {
            tool: crate::tools::MSMTP,
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn reads_recipients_from_the_message_headers() {
        let args = argv(Some(&PathBuf::from("/home/l/.config/msmtp/config")), "main");
        assert_eq!(
            args,
            vec![
                "--file",
                "/home/l/.config/msmtp/config",
                "--account",
                "main",
                "--read-recipients"
            ]
        );
    }

    #[test]
    fn omits_the_config_flag_when_there_is_no_config() {
        assert_eq!(
            argv(None, "work"),
            vec!["--account", "work", "--read-recipients"]
        );
    }
}
