/**
 * The half of the settings that belongs to this device.
 *
 * The server file is one answer for everyone — it is about the mail. This is
 * about the screen in front of you, so it stays here: a phone reading the same
 * mailbox wants a smaller page, its own theme and a composer that fills the
 * screen, and making a laptop agree would be wrong rather than tidy.
 *
 * JSON rather than TOML because nobody hand-edits it: there is no file to open
 * on a phone, and the settings page is the way in.
 */
import { DEFAULT_BINDINGS, type Binding } from "../../keymap/engine";
import { mergeBindings } from "./toml";
import {
	CLIENT_KEYS,
	DEFAULT_PREFERENCES,
	preferencesInScope,
	type Preferences,
} from "./schema";

const STORAGE_KEY = "ecr.client";

export interface ClientSettings {
	preferences: Partial<Preferences>;
	bindings: Binding[];
}

export function defaultClientSettings(): ClientSettings {
	return {
		preferences: preferencesInScope(DEFAULT_PREFERENCES, "client"),
		bindings: [...DEFAULT_BINDINGS],
	};
}

/** Whether this device has ever saved its own settings. */
export function hasClientSettings(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) !== null;
	} catch {
		return false;
	}
}

export function loadClientSettings(): ClientSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return defaultClientSettings();

		const parsed = JSON.parse(raw) as Partial<ClientSettings>;
		return {
			// Only the keys this side owns: a key that changed scope in a later
			// release must not be resurrected from an old device's copy.
			preferences: pickClient(parsed.preferences ?? {}),
			bindings: mergeBindings(parsed.bindings ?? []),
		};
	} catch {
		return defaultClientSettings();
	}
}

export function saveClientSettings(client: ClientSettings): void {
	try {
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({
				preferences: pickClient(client.preferences),
				bindings: client.bindings,
			}),
		);
	} catch {
		// A full or disabled storage is not worth failing the edit over.
	}
}

function pickClient(preferences: Partial<Preferences>): Partial<Preferences> {
	const out: Partial<Preferences> = {};
	for (const key of CLIENT_KEYS) {
		if (preferences[key] !== undefined) out[key] = preferences[key] as never;
	}
	return out;
}
