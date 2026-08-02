/**
 * The desktop shell loads the client from `tauri://localhost`, so
 * `location.origin` is not a usable API base the way it is in a browser. The
 * shell exposes the configured server URL as a command instead.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function invoker(): Invoke | null {
  if (typeof window === "undefined") return null;
  const internals = (window as Record<string, any>).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" ? internals.invoke : null;
}

export async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  const call = invoker();
  if (!call) return null;
  try {
    return await call<T>(command, args);
  } catch {
    return null;
  }
}

/** The server URL the shell was configured with, or null outside Tauri. */
export async function shellServerUrl(): Promise<string | null> {
  return invoke<string>("default_server_url");
}

/** Opens $EDITOR on the desktop. Null anywhere the command does not exist. */
export async function composeInEditor(initial: string): Promise<string | null> {
  return invoke<string>("compose_in_editor", { initial });
}

/**
 * A `mailto:` the app was launched with or handed while running, or null.
 *
 * The shell hands each URL over exactly once, so this can be called as often as
 * there is reason to: at boot, for the cold start, and whenever the window
 * regains focus, which is what happens the instant a link is followed from
 * another application.
 */
export async function takeLaunchMailto(): Promise<string | null> {
  return invoke<string>("take_launch_mailto");
}

/**
 * Shows a system notification. Answers whether one was actually shown.
 *
 * Under Tauri this is the shell's own command, which owns the permission
 * handshake; in a browser it is the Notification API, where permission has to
 * be asked for here. Both refuse silently rather than throwing — a notification
 * is the least important thing happening at the moment it fires.
 */
export async function notify(title: string, body: string): Promise<boolean> {
  if (isTauri()) {
    return (await invoke<boolean>("notify", { title, body })) ?? false;
  }

  if (typeof Notification === "undefined") return false;

  try {
    let permission = Notification.permission;
    if (permission === "default") permission = await Notification.requestPermission();
    if (permission !== "granted") return false;

    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a link outside the app.
 *
 * `window.open` is right in a browser and wrong everywhere else: a Tauri
 * webview has nowhere to put a new window, and on Android it does nothing at
 * all — a tapped link in a message simply died. The shell's opener plugin
 * hands the URL to the system instead, which is what puts it in Chrome.
 *
 * Only http(s) and mailto are passed on. A message is untrusted input, and
 * everything else — `file:`, an app scheme, `javascript:` — is a way to make
 * the system do something the reader did not ask for. Returns whether the URL
 * was one worth handing over.
 */
export async function openExternal(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    return false;
  }

  if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return false;

  if (isTauri()) {
    // No browser fallback: `window.open` is what does nothing here, so trying
    // it after a failed plugin call would only hide the failure.
    await invoke<null>("plugin:opener|open_url", { url: parsed.href, with: null });
    return true;
  }

  window.open(parsed.href, "_blank", "noopener,noreferrer");
  return true;
}
