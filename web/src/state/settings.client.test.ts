import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CLIENT_KEYS,
	DEFAULT_PREFERENCES,
	PREFERENCE_DOCS,
	SERVER_KEYS,
	defaultSettings,
	loadClientSettings,
	mergeBindings,
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

	it("stores no binding it did not itself change", () => {
		// The resolved list is defaults plus customizations, and once written down
		// the two are indistinguishable. Only what differs is the device's.
		saveSettings(defaultSettings());

		const stored = JSON.parse(localStorage.getItem("ecr.client") ?? "{}");
		expect(stored.keybindings).toEqual([]);
		expect(loadClientSettings().bindings).toEqual([]);
	});

	it("keeps a binding that is not a shipped default", () => {
		const settings = defaultSettings();
		settings.bindings = [
			{ keys: "e", action: { kind: "archive" }, description: "archive", panes: ["list"] },
			...settings.bindings,
		];
		saveSettings(settings);

		expect(loadClientSettings().bindings).toEqual([
			{ keys: "e", action: { kind: "archive" }, description: "archive", panes: ["list"] },
		]);
	});

	it("takes a changed default over the one a stale device froze", () => {
		// The bug this replaces: Space was `toggleSelect`, became
		// `toggleSelectNext`, and every device that had ever saved anything held a
		// copy of the old table. `mergeBindings` keys on the action, so both
		// survived and the engine took the first — Space picked a row and stopped
		// there, for ever, on the one device that could not be told why.
		localStorage.setItem(
			"ecr.client",
			JSON.stringify({
				preferences: { theme: "themes/nord.toml" },
				bindings: [
					{
						keys: " ",
						action: { kind: "toggleSelect" },
						description: "select this row",
						panes: ["list"],
					},
				],
			}),
		);

		const space = withClient(defaultSettings()).bindings.filter(
			(b) => b.keys === " " && b.panes?.includes("list"),
		);
		expect(space).toHaveLength(1);
		expect(space[0]?.action.kind).toBe("toggleSelectNext");
	});

	it("gives a device that binds nothing the shared file's keybindings", () => {
		saveClientSettings({ preferences: { theme: "themes/x.toml" }, bindings: [] });

		const shared = defaultSettings();
		shared.bindings = mergeBindings([
			{ keys: "e", action: { kind: "archive" }, description: "archive", panes: ["list"] },
		]);

		const archive = withClient(shared).bindings.filter(
			(b) => b.action.kind === "archive" && b.panes?.includes("list"),
		);
		expect(archive.map((b) => b.keys)).toEqual(["e"]);
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
