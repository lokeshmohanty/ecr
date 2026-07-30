use std::process::Command;

/// Opens the user's `$EDITOR` on a scratch file and returns what they wrote.
///
/// This is the one part of the compose flow that cannot work over HTTP: the
/// editor has to run on the machine the person is sitting at. The web and
/// Android clients use the in-app composer instead.
#[tauri::command]
fn compose_in_editor(initial: String) -> Result<String, String> {
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| "vi".to_string());

    let path = std::env::temp_dir().join(format!("ecr-compose-{}.eml", std::process::id()));
    std::fs::write(&path, initial).map_err(|e| e.to_string())?;

    let status = Command::new(&editor)
        .arg(&path)
        .status()
        .map_err(|e| format!("could not start {editor}: {e}"))?;

    if !status.success() {
        let _ = std::fs::remove_file(&path);
        return Err(format!("{editor} exited with {status}"));
    }

    let body = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    Ok(body)
}

#[tauri::command]
fn default_server_url() -> String {
    std::env::var("ECR_SERVER_URL").unwrap_or_else(|_| "http://localhost:8080".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![compose_in_editor, default_server_url])
        .run(tauri::generate_context!())
        .expect("error while running ecr");
}
