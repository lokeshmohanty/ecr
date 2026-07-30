use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub struct EditedEmail {
    pub to: String,
    pub cc: String,
    pub bcc: String,
    pub subject: String,
    pub body: String,
}

impl EditedEmail {
    pub fn compose() -> Option<Self> {
        let template = "TO: \n\
            SUBJECT: \n\
            CC: \n\
            \n\
            ---BODY---\n\
            \n";

        let temp_path = get_temp_email_path();

        fs::write(&temp_path, template).ok()?;

        let editor = std::env::var("EDITOR")
            .or_else(|_| std::env::var("VISUAL"))
            .unwrap_or_else(|_| "vi".to_string());

        let mut child = Command::new(&editor)
            .arg(&temp_path)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .ok()?;

        let _ = child.wait();

        let content = match fs::read_to_string(&temp_path) {
            Ok(c) => c,
            Err(_) => return None,
        };

        let _ = fs::remove_file(&temp_path);

        if content.trim().is_empty() {
            return None;
        }

        Some(parse_email_content(&content))
    }

    pub fn reply(to: &str, subject: &str, quoted_body: &str) -> Option<Self> {
        let template = format!(
            "TO: {}\n\
            SUBJECT: Re: {}\n\
            CC: \n\
            \n\
            ---BODY---\n\
            \n\
            On ,  wrote:\n\
            {}\n",
            to, subject, quoted_body
        );

        let temp_path = get_temp_email_path();

        fs::write(&temp_path, &template).ok()?;

        let editor = std::env::var("EDITOR")
            .or_else(|_| std::env::var("VISUAL"))
            .unwrap_or_else(|_| "vi".to_string());

        let mut child = Command::new(&editor)
            .arg(&temp_path)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .ok()?;

        let _ = child.wait();

        let content = match fs::read_to_string(&temp_path) {
            Ok(c) => c,
            Err(_) => return None,
        };

        let _ = fs::remove_file(&temp_path);

        if content.trim().is_empty() {
            return None;
        }

        Some(parse_email_content(&content))
    }

    pub fn forward(subject: &str, original: &str) -> Option<Self> {
        let template = format!(
            "TO: \n\
            SUBJECT: Fwd: {}\n\
            CC: \n\
            \n\
            ---BODY---\n\
            \n\
            ---------- Forwarded message ----------\n\
            {}\n",
            subject, original
        );

        let temp_path = get_temp_email_path();

        fs::write(&temp_path, &template).ok()?;

        let editor = std::env::var("EDITOR")
            .or_else(|_| std::env::var("VISUAL"))
            .unwrap_or_else(|_| "vi".to_string());

        let mut child = Command::new(&editor)
            .arg(&temp_path)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .ok()?;

        let _ = child.wait();

        let content = match fs::read_to_string(&temp_path) {
            Ok(c) => c,
            Err(_) => return None,
        };

        let _ = fs::remove_file(&temp_path);

        if content.trim().is_empty() {
            return None;
        }

        Some(parse_email_content(&content))
    }
}

fn parse_email_content(content: &str) -> EditedEmail {
    let mut to = String::new();
    let mut cc = String::new();
    let mut bcc = String::new();
    let mut subject = String::new();
    let body_marker = "---BODY---";
    let parts: Vec<&str> = content.splitn(2, body_marker).collect();

    let mut body = if parts.len() == 2 {
        parts[1].trim().to_string()
    } else {
        content.trim().to_string()
    };

    if parts.len() == 2 {
        let headers = parts[0];

        for line in headers.lines() {
            if let Some(val) = line.strip_prefix("TO:") {
                to = val.trim().to_string();
            } else if let Some(val) = line.strip_prefix("SUBJECT:") {
                subject = val.trim().to_string();
            } else if let Some(val) = line.strip_prefix("CC:") {
                cc = val.trim().to_string();
            } else if let Some(val) = line.strip_prefix("BCC:") {
                bcc = val.trim().to_string();
            }
        }
    } else {
        body = content.trim().to_string();
    }

    EditedEmail {
        to,
        cc,
        bcc,
        subject,
        body,
    }
}

fn get_temp_email_path() -> PathBuf {
    std::env::temp_dir().join("ecr_compose_email.txt")
}

pub fn render_html_with_w3m(html: &str) -> Option<String> {
    let temp_path = std::env::temp_dir().join("ecr_email_html.html");

    fs::write(&temp_path, html).ok()?;

    let output = Command::new("w3m")
        .args(["-dump", "-T", "text/html", "-cols", "120"])
        .arg(&temp_path)
        .output()
        .ok()?;

    let _ = fs::remove_file(&temp_path);

    if output.status.success() && !output.stdout.is_empty() {
        Some(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("w3m error: {}", stderr);
        None
    }
}
