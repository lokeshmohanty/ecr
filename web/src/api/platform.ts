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
