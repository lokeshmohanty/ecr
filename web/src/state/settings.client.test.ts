import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CLIENT_KEYS,
	DEFAULT_PREFERENCES,
	PREFERENCE_DOCS,
	SERVER_KEYS,
	defaultSettings,
	loadClientSettings,
	preferencesInScope,
	saveClientSettings,
	saveSettings,
	withClient,
} from "./settings";

beforeEach(() => localStorage.clear());

describe("the client/server line", () => {
	it("gives every preference exactly one owner", () => {
		const all = Object.keys(DEFAULT_PREFERENCES).sort();
		expect([...SERVER_KEYS, ...CLIENT_KEYS].sort()).toEqual(all);
		expect(SERVER_KEYS.filter((k) => CLIENT_KEYS.includes(k))).toEqual([]);
	});

	it("keeps the mail on the server and the screen on the device", () => {
		expect(SERVER_KEYS).toContain("startQuery");
		expect(SERVER_KEYS).toContain("markReadOnOpen");
		expect(CLIENT_KEYS).toContain("theme");
		expect(CLIENT_KEYS).toContain("pageSize");
		expect(CLIENT_KEYS).toContain("sidebarSections");
	});

	it("names the owner of every option, so none is quietly unowned", () => {
		for (const key of Object.keys(
			DEFAULT_PREFERENCES,
		) as (keyof typeof DEFAULT_PREFERENCES)[]) {
			expect(["server", "client"], key).toContain(PREFERENCE_DOCS[key].scope);
		}
	});

	it("takes only its own half when asked for one", () => {
		const client = preferencesInScope(DEFAULT_PREFERENCES, "client");
		expect(Object.keys(client).sort()).toEqual([...CLIENT_KEYS].sort());
		expect(client).not.toHaveProperty("startQuery");
	});
});

describe("a device with settings of its own", () => {
	it("wins over the shared file", () => {
		saveClientSettings({
			preferences: { theme: "themes/tokyonight.toml" },
			bindings: [],
		});

		const shared = defaultSettings();
		shared.preferences.theme = "themes/ecr-dark.toml";
		shared.preferences.startQuery = "tag:unread";

		const merged = withClient(shared);
		expect(merged.preferences.theme).toBe("themes/tokyonight.toml");
		// The server still owns what the server owns.
		expect(merged.preferences.startQuery).toBe("tag:unread");
	});

	it("leaves the file alone until it has saved anything", () => {
		const shared = defaultSettings();
		shared.preferences.theme = "themes/gruvbox.toml";
		shared.preferences.pageSize = 40;

		// Nothing saved here yet, so an existing setup carries across the split
		// rather than being reset to the defaults.
		expect(withClient(shared).preferences.theme).toBe("themes/gruvbox.toml");
		expect(withClient(shared).preferences.pageSize).toBe(40);
	});

	it("stores its half when settings are saved", () => {
		const settings = defaultSettings();
		settings.preferences.timezone = "Europe/Berlin";
		settings.preferences.startQuery = "tag:flagged";
		saveSettings(settings);

		const stored = loadClientSettings();
		expect(stored.preferences.timezone).toBe("Europe/Berlin");
		expect(stored.preferences).not.toHaveProperty("startQuery");
	});

	it("ignores a key that is no longer the device's to hold", () => {
		localStorage.setItem(
			"ecr.client",
			JSON.stringify({
				preferences: { startQuery: "tag:spam", theme: "themes/nord.toml" },
			}),
		);
		const stored = loadClientSettings();
		expect(stored.preferences).not.toHaveProperty("startQuery");
		expect(stored.preferences.theme).toBe("themes/nord.toml");
	});

	it("restores a default binding missing from a stale device copy", () => {
		// A device that saved its bindings when the file dropped an action keeps a
		// snapshot missing it. Loading heals the gap rather than leaving the key dead.
		const stale = defaultSettings().bindings.filter(
			(b) =>
				b.action.kind !== "toggleSelectNext" &&
				b.action.kind !== "visualSelect" &&
				b.action.kind !== "tagPrompt",
		);
		saveClientSettings({
			preferences: { theme: "themes/x.toml" },
			bindings: stale,
		});

		const loaded = loadClientSettings();
		expect(
			loaded.bindings.some((b) => b.action.kind === "toggleSelectNext"),
		).toBe(true);
		expect(loaded.bindings.some((b) => b.action.kind === "visualSelect")).toBe(
			true,
		);
		expect(loaded.bindings.some((b) => b.action.kind === "tagPrompt")).toBe(
			true,
		);
	});
});

describe("what a phone assumes before anyone tells it", () => {
  const phone = () =>
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));

  afterEach(() => vi.unstubAllGlobals());

  it("reads mail as HTML even where the shared file prefers text", () => {
    phone();
    const shared = defaultSettings();
    shared.preferences.preferHtml = false;

    // The file was written at a desk. A phone has one column and no keyboard,
    // and the plain-text alternative is a flattened shadow of the message.
    expect(withClient(shared).preferences.preferHtml).toBe(true);
  });

  it("leaves a desktop's own choice alone", () => {
    const shared = defaultSettings();
    shared.preferences.preferHtml = false;
    expect(withClient(shared).preferences.preferHtml).toBe(false);
  });

  it("yields to what this phone was actually told", () => {
    phone();
    saveClientSettings({ preferences: { preferHtml: false }, bindings: [] });

    const shared = defaultSettings();
    shared.preferences.preferHtml = true;
    // Turning it off here outranks both the file and the form factor.
    expect(withClient(shared).preferences.preferHtml).toBe(false);
  });

  it("is a device setting, so it never reaches the shared file", () => {
    expect(CLIENT_KEYS).toContain("preferHtml");
    expect(SERVER_KEYS).not.toContain("preferHtml");
  });
});
