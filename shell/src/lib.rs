use std::process::Command;
use std::sync::Mutex;

use tauri::Manager;

/// A `mailto:` the app was asked to open, waiting for the client to collect it.
///
/// The client polls rather than subscribing to an event: listening would mean
/// pulling in `@tauri-apps/api` for the one call, and this client deliberately
/// speaks to the shell through raw `invoke` so that the same bundle runs in a
/// browser with no Tauri at all. Polling is not a compromise here — a deep link
/// brings the window to the front, so the focus event the client already reacts
/// to is exactly when a URL is waiting.
#[derive(Default)]
struct PendingMailto(Mutex<Option<String>>);

/// Hands over the pending `mailto:`, if any, and forgets it.
///
/// Taking rather than reading is the point: a draft opened from a link must not
/// reappear every time the window regains focus.
#[tauri::command]
fn take_launch_mailto(state: tauri::State<'_, PendingMailto>) -> Option<String> {
    state.0.lock().ok().and_then(|mut slot| slot.take())
}

/// Shows a desktop notification.
///
/// This is the shell's own command rather than the notification plugin's,
/// because the client would otherwise have to name that plugin's commands as
/// strings. `invoke` answers `null` for a command that does not exist, exactly
/// as it does for one that was refused, so a wrong guess would be a feature
/// that silently never fires — the same failure the opener plugin's missing
/// scope permission produced.
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<bool, String> {
    use tauri::plugin::PermissionState;
    use tauri_plugin_notification::NotificationExt;

    let state = app.notification().permission_state().map_err(err)?;
    let state = if state == PermissionState::Granted {
        state
    } else {
        // Android 13 and up will not show anything until the user has been
        // asked, and asking is only allowed in response to something they did.
        // Arriving mail is close enough: the alternative is a permission prompt
        // on first launch, before there is anything to notify about.
        app.notification().request_permission().map_err(err)?
    };

    if state != PermissionState::Granted {
        return Ok(false);
    }

    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(err)?;
    Ok(true)
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Records a `mailto:` for the client to collect, and raises the window.
///
/// Only `mailto:` is kept. The scheme is the one this app asked the system for,
/// and a URL arriving here came from another application entirely — treating
/// whatever it sent as an instruction is not something to do by accident.
fn remember_mailto(app: &tauri::AppHandle, urls: Vec<String>) {
    let Some(url) = urls
        .into_iter()
        .find(|url| url.trim_start().to_ascii_lowercase().starts_with("mailto:"))
    else {
        return;
    };

    if let Some(state) = app.try_state::<PendingMailto>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some(url);
        }
    }

    // Without this the draft opens behind whatever the reader was using when
    // they clicked the link, which reads as the click having done nothing.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
}

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

    let mut builder = tauri::Builder::default();

    // Before the deep-link plugin, and not optional: on Linux and Windows a
    // `mailto:` is argv of a newly started process, and this is what forwards
    // it to the instance already running instead of opening a second one.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            remember_mailto(app, argv);
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingMailto::default())
        .setup(|app| {
            use tauri_plugin_deep_link::DeepLinkExt;

            // The cold start. `get_current` is how the app finds out it was
            // launched *by* a link rather than handed one while running, and it
            // has to be read here because by the time the client has booted and
            // asked, nothing else would still be holding it.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                remember_mailto(
                    app.handle(),
                    urls.into_iter().map(|url| url.to_string()).collect(),
                );
            }

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                remember_mailto(
                    &handle,
                    event
                        .urls()
                        .into_iter()
                        .map(|url| url.to_string())
                        .collect(),
                );
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            compose_in_editor,
            default_server_url,
            take_launch_mailto,
            notify
        ])
        .run(tauri::generate_context!())
        .expect("error while running ecr");
}
