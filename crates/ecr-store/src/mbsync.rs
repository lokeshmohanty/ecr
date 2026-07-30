use crate::error::{Error, Result};
use crate::paths::MailPaths;
use crate::store::ProgressSink;
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

pub fn argv(config: Option<&Path>, channels: &[String]) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(config) = config {
        args.push("--config".to_string());
        args.push(config.display().to_string());
    }
    if channels.is_empty() {
        args.push("--all".to_string());
    } else {
        args.extend(channels.iter().cloned());
    }
    args
}

pub async fn run(
    paths: &MailPaths,
    channels: &[String],
    progress: &dyn ProgressSink,
) -> Result<Vec<String>> {
    let args = argv(paths.mbsync.path.as_deref(), channels);

    let mut child = Command::new(&paths.binaries.mbsync)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::ToolMissing {
                tool: crate::tools::MBSYNC,
            },
            _ => Error::Io(e),
        })?;

    let mut warnings = Vec::new();

    if let Some(stdout) = child.stdout.take() {
        let mut lines = BufReader::new(stdout).lines();
        while let Some(line) = lines.next_line().await? {
            let line = line.trim().to_string();
            if !line.is_empty() {
                progress.line(&line);
            }
        }
    }

    if let Some(stderr) = child.stderr.take() {
        let mut lines = BufReader::new(stderr).lines();
        while let Some(line) = lines.next_line().await? {
            let line = line.trim().to_string();
            if !line.is_empty() {
                progress.line(&line);
                warnings.push(line);
            }
        }
    }

    let status = child.wait().await?;
    if !status.success() {
        return Err(Error::ToolFailed {
            tool: crate::tools::MBSYNC,
            stderr: if warnings.is_empty() {
                format!("exited with {status}")
            } else {
                warnings.join("; ")
            },
        });
    }

    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn syncs_all_channels_when_none_are_named() {
        let args = argv(Some(&PathBuf::from("/home/l/.config/isyncrc")), &[]);
        assert_eq!(args, vec!["--config", "/home/l/.config/isyncrc", "--all"]);
    }

    #[test]
    fn syncs_only_the_named_channels() {
        let args = argv(
            Some(&PathBuf::from("/cfg")),
            &["main".to_string(), "work".to_string()],
        );
        assert_eq!(args, vec!["--config", "/cfg", "main", "work"]);
    }

    #[test]
    fn omits_the_config_flag_when_there_is_no_config() {
        assert_eq!(argv(None, &["main".to_string()]), vec!["main"]);
    }
}
