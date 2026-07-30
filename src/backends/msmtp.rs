use crate::models::ComposeDraft;

pub struct MsmtpBackend {
    pub config_path: String,
}

impl Default for MsmtpBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl MsmtpBackend {
    pub fn new() -> Self {
        Self {
            config_path: "/home/alice/.config/msmtp/config".into(),
        }
    }

    pub async fn send(&self, account: &str, draft: &ComposeDraft) -> std::io::Result<()> {
        // Construct the email message
        let mut message = String::new();
        message.push_str(&format!("To: {}\n", draft.to));
        if !draft.cc.is_empty() {
            message.push_str(&format!("Cc: {}\n", draft.cc));
        }
        if !draft.bcc.is_empty() {
            message.push_str(&format!("Bcc: {}\n", draft.bcc));
        }
        message.push_str(&format!("Subject: {}\n", draft.subject));
        message.push_str("Content-Type: text/plain; charset=utf-8\n");
        message.push('\n');
        message.push_str(&draft.body);

        // Run msmtp command using tokio::process
        use tokio::io::AsyncWriteExt;
        let mut child = tokio::process::Command::new("msmtp")
            .arg(format!("--file={}", self.config_path))
            .arg(format!("--account={}", account))
            .arg("-t") // read recipients from headers
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()?;

        let mut stdin = child.stdin.take().expect("Failed to open stdin");
        stdin.write_all(message.as_bytes()).await?;
        drop(stdin);

        let output = child.wait_with_output().await?;

        if !output.status.success() {
            return Err(std::io::Error::other(
                String::from_utf8_lossy(&output.stderr).to_string(),
            ));
        }

        Ok(())
    }
}
