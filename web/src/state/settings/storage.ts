/**
 * The local copy. The server holds the real file; this is what lets the client
 * paint before the network answers, and keep working when it does not.
 */
import { DEFAULT_BINDINGS } from "../../keymap/engine";
import { DEFAULT_PACKAGES } from "../packages";
import { DEFAULT_PREFERENCES, defaultSettings, type Settings } from "./schema";
import { defaultToml, fromToml, toToml } from "./toml";

const STORAGE_KEY = "ecr.settings.toml";
/** The shape settings had before they became a file; still read, never written. */
const LEGACY_KEY = "ecr.settings";

/**
 * The server holds the real file; this is the copy that lets the client start
 * before the network answers, and keep working when it does not.
 */
export function loadSettings(): Settings {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) return fromToml(text).settings;

    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return defaultSettings();

    const parsed = JSON.parse(legacy) as Partial<Settings>;
    return {
      preferences: { ...DEFAULT_PREFERENCES, ...(parsed.preferences ?? {}) },
      bindings: parsed.bindings?.length ? parsed.bindings : [...DEFAULT_BINDINGS],
      packages: { ...structuredClone(DEFAULT_PACKAGES), ...(parsed.packages ?? {}) },
    };
  } catch {
    return defaultSettings();
  }
}

/** The file as last seen, for starting up before the server answers. */
export function loadSettingsText(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || toToml(loadSettings());
  } catch {
    return defaultToml();
  }
}

export function saveSettings(settings: Settings, source = toToml(settings)): void {
  try {
    localStorage.setItem(STORAGE_KEY, source);
  } catch {
    // A full or disabled storage is not worth failing the edit over.
  }
}
