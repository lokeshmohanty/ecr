/**
 * The local copy. The server holds the real file; this is what lets the client
 * paint before the network answers, and keep working when it does not.
 */
import { mergeBindings } from "./toml";
import { DEFAULT_PACKAGES } from "../packages";
import {
	DEFAULT_PREFERENCES,
	defaultSettings,
	preferencesInScope,
	type Settings,
} from "./schema";
import {
	hasClientSettings,
	loadClientSettings,
	saveClientSettings,
} from "./client";
import { defaultToml, fromToml, toToml } from "./toml";

const STORAGE_KEY = "ecr.settings.toml";
/** The shape settings had before they became a file; still read, never written. */
const LEGACY_KEY = "ecr.settings";

/**
 * The server holds the real file; this is the copy that lets the client start
 * before the network answers, and keep working when it does not.
 */
export function loadSettings(): Settings {
	return withClient(serverSettings());
}

function serverSettings(): Settings {
	try {
		const text = localStorage.getItem(STORAGE_KEY);
		if (text) return fromToml(text).settings;

		const legacy = localStorage.getItem(LEGACY_KEY);
		if (!legacy) return defaultSettings();

		const parsed = JSON.parse(legacy) as Partial<Settings>;
		return {
			preferences: { ...DEFAULT_PREFERENCES, ...(parsed.preferences ?? {}) },
			bindings: mergeBindings(parsed.bindings ?? []),
			packages: {
				...structuredClone(DEFAULT_PACKAGES),
				...(parsed.packages ?? {}),
			},
		};
	} catch {
		return defaultSettings();
	}
}

/**
 * Lays this device's half over the shared one.
 *
 * Until this device has saved anything, whatever the file said still wins —
 * which is what carries an existing setup across the split instead of silently
 * resetting someone's theme and keybindings to the defaults.
 */
export function withClient(settings: Settings): Settings {
	if (!hasClientSettings()) return settings;

	const client = loadClientSettings();
	return {
		...settings,
		preferences: { ...settings.preferences, ...client.preferences },
		bindings: client.bindings,
	};
}

/** The file as last seen, for starting up before the server answers. */
export function loadSettingsText(): string {
	try {
		return localStorage.getItem(STORAGE_KEY) || toToml(loadSettings());
	} catch {
		return defaultToml();
	}
}

/**
 * Writes both halves: the shared file's text as the local copy, and this
 * device's own preferences and keybindings beside it.
 */
export function saveSettings(
	settings: Settings,
	source = toToml(settings),
): void {
	saveClientSettings({
		preferences: preferencesInScope(settings.preferences, "client"),
		bindings: settings.bindings,
	});
	try {
		localStorage.setItem(STORAGE_KEY, source);
	} catch {
		// A full or disabled storage is not worth failing the edit over.
	}
}
