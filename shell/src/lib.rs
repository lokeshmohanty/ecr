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
    std::env::var("ECR_SERVER_URL").unwrap_or_else(|_| "http://localhost:8383".to_string())
}

/// Gives the screen a resolution before WebKit reads one.
///
/// WebKitGTK derives `devicePixelRatio` from the GDK screen resolution divided
/// by 96. GTK only ever sets that resolution from `gtk-xft-dpi`, and leaves it
/// at -1 when nothing has set that — which is the normal state of a Wayland
/// session with no XSettings daemon and no `Xft.dpi`. The page then lays out at
/// a *negative* device pixel ratio of -1/96: every length saturates, every box
/// collapses under its own contents, and the whole UI renders on top of itself.
/// X11 sessions escape it only because `xrdb` happens to seed `Xft.dpi`.
///
/// 96dpi is the CSS reference, so this is the identity scale, not a preference.
/// A real value — a HiDPI display, a user who scaled their text — is positive
/// and left exactly as it is.
#[cfg(all(target_os = "linux", not(mobile)))]
fn ensure_screen_resolution() {
    use gtk::prelude::GtkSettingsExt;

    if gtk::init().is_err() {
        return;
    }

    if let Some(settings) = gtk::Settings::default() {
        if settings.gtk_xft_dpi() <= 0 {
            settings.set_gtk_xft_dpi(96 * 1024);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(all(target_os = "linux", not(mobile)))]
    ensure_screen_resolution();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            compose_in_editor,
            default_server_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running ecr");
}
