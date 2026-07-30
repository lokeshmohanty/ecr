use ecr_core::doctor::ToolInfo;
use std::path::PathBuf;

pub const NOTMUCH: &str = "notmuch";
pub const MBSYNC: &str = "mbsync";
pub const MSMTP: &str = "msmtp";

pub const REQUIRED: [&str; 3] = [NOTMUCH, MBSYNC, MSMTP];

pub fn find(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

pub async fn inspect(name: &'static str) -> ToolInfo {
    let path = find(name);
    let version = match &path {
        Some(_) => version_of(name).await,
        None => None,
    };
    ToolInfo {
        name: name.to_string(),
        path,
        version,
    }
}

async fn version_of(name: &str) -> Option<String> {
    let output = tokio::process::Command::new(name)
        .arg("--version")
        .output()
        .await
        .ok()?;
    let text = if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr)
    } else {
        String::from_utf8_lossy(&output.stdout)
    };
    text.lines().next().map(|l| l.trim().to_string())
}

pub async fn inspect_all() -> Vec<ToolInfo> {
    let mut out = Vec::with_capacity(REQUIRED.len());
    for name in REQUIRED {
        out.push(inspect(name).await);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_binary_that_is_certainly_present() {
        assert!(find("sh").is_some());
    }

    #[test]
    fn does_not_find_a_nonexistent_binary() {
        assert!(find("definitely-not-a-real-binary-xyzzy").is_none());
    }

    #[tokio::test]
    async fn missing_tool_reports_no_version() {
        let info = inspect("definitely-not-a-real-binary-xyzzy").await;
        assert!(info.path.is_none());
        assert!(info.version.is_none());
    }
}
