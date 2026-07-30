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
