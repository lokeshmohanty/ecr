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

/// This build's version, but only where an APK is what someone installed.
///
/// The answer is what decides whether the client offers an update check at all,
/// so `None` is the whole point of it: a deb, an AppImage, the Nix package and
/// the browser client are all updated by whatever installed them, and a mail
/// client that goes looking at a code host on their behalf is offering to
/// replace a package the system is managing.
///
/// `cfg!` rather than `#[cfg]` so that the command exists on every target and
/// the client has one shape of answer to read. The version comes from
/// `package_info`, which Tauri fills from `tauri.conf.json` — the same value the
/// APK's `versionName` is generated from, so the two cannot drift.
#[tauri::command]
fn apk_version(app: tauri::AppHandle) -> Option<String> {
    if cfg!(target_os = "android") {
        Some(app.package_info().version.to_string())
    } else {
        None
    }
}

/// The server this launch was explicitly pointed at, if it was pointed at one.
///
/// The client treats an answer here as authoritative — `just desktop` and
/// `verify-desktop.sh` start a server on a port of their own and the client has
/// to go there rather than to whatever an earlier run persisted. A built-in
/// default cannot be authoritative in the same way, and answering with one was
/// how a paired phone lost its server on every launch: Android has no
/// environment to read, so this answered `http://localhost:8383` every time and
/// the client wrote that over the address the device had been paired with. The
/// address a device was paired with is the client's to keep; where a client
/// starts when it has never been paired is `defaultBaseUrl`'s business.
#[tauri::command]
fn default_server_url() -> Option<String> {
    std::env::var("ECR_SERVER_URL")
        .ok()
        .filter(|url| !url.is_empty())
}

/// The device token a development launch was handed, if any.
///
/// Two sources because the two platforms can only be reached in different ways.
/// `just desktop` sets `ECR_TOKEN` in the environment it runs the binary under,
/// the same way it already sets `ECR_SERVER_URL`. A phone has no such
/// environment — it runs an installed APK, reaching this machine back down the
/// USB cable — so `just android` sets the variable at *build* time and
/// `option_env!` bakes it into the debug APK. A release build is compiled
/// without it and answers `None`, which is what keeps this out of a shipped
/// artifact.
///
/// The client only reads this when it has no token of its own, so pairing a
/// device properly still wins over whatever a dev build was born with.
#[tauri::command]
fn default_token() -> Option<String> {
    std::env::var("ECR_TOKEN")
        .ok()
        .or_else(|| option_env!("ECR_TOKEN").map(str::to_string))
        .filter(|token| !token.is_empty())
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

    builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init());

    // Mobile only, because the plugin is a camera and has no desktop build.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    }

    builder
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
            apk_version,
            compose_in_editor,
            default_server_url,
            default_token,
            take_launch_mailto,
            notify
        ])
        .run(tauri::generate_context!())
        .expect("error while running ecr");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A launch that was not pointed at a server must not name one.
    ///
    /// This is the whole of the Android bug: a phone has no environment for
    /// `ECR_SERVER_URL` to be in, so an answer here was always the built-in
    /// default — and the client takes an answer as authoritative, so every
    /// launch wrote `http://localhost:8383` over the address the device had
    /// been paired with. The reader had to scan the pairing code again each
    /// time the app was opened.
    #[test]
    fn a_launch_that_was_pointed_nowhere_names_no_server() {
        let restore = std::env::var("ECR_SERVER_URL").ok();

        std::env::remove_var("ECR_SERVER_URL");
        assert_eq!(default_server_url(), None);

        // Set but empty is the same as unset: `just desktop` interpolates the
        // variable, and an empty one is a recipe that failed to resolve a port
        // rather than an address to send a client to.
        std::env::set_var("ECR_SERVER_URL", "");
        assert_eq!(default_server_url(), None);

        std::env::set_var("ECR_SERVER_URL", "http://dev:8399");
        assert_eq!(default_server_url(), Some("http://dev:8399".to_string()));

        match restore {
            Some(url) => std::env::set_var("ECR_SERVER_URL", url),
            None => std::env::remove_var("ECR_SERVER_URL"),
        }
    }
}
