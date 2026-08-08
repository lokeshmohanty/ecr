import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/platform", () => ({ isTauri: vi.fn(() => false) }));

import { isTauri } from "../api/platform";
import { isOffline, registerServiceWorker } from "./offline";

const platform = vi.mocked(isTauri);

function withServiceWorker(register: ReturnType<typeof vi.fn>) {
	Object.defineProperty(navigator, "serviceWorker", {
		value: { register },
		configurable: true,
	});
}

/** Fires whatever `registerServiceWorker` deferred to load. */
function load() {
	window.dispatchEvent(new Event("load"));
}

afterEach(() => {
	platform.mockReturnValue(false);
	vi.restoreAllMocks();
});

describe("the service worker registration", () => {
	it("registers the worker in a browser", () => {
		const register = vi.fn(() => Promise.resolve());
		withServiceWorker(register);

		registerServiceWorker();
		load();

		expect(register).toHaveBeenCalledWith("/sw.js");
	});

	/*
	 * The shells load the whole client out of the binary. There is no network
	 * fetch to intercept, and registering a worker there inserts a cache
	 * between the app and assets it already has on disk.
	 */
	it("does nothing at all inside the desktop or Android shell", () => {
		const register = vi.fn(() => Promise.resolve());
		withServiceWorker(register);
		platform.mockReturnValue(true);

		registerServiceWorker();
		load();

		expect(register).not.toHaveBeenCalled();
	});

	/*
	 * A worker is a secure-context feature, so an http origin on a LAN — a real
	 * deployment that must keep working — simply has none. Nothing about the
	 * client depends on this succeeding, so a rejection must not surface.
	 */
	it("swallows a refusal rather than reporting one", async () => {
		const register = vi.fn(() => Promise.reject(new Error("insecure origin")));
		withServiceWorker(register);

		expect(() => {
			registerServiceWorker();
			load();
		}).not.toThrow();

		await Promise.resolve();
	});

	it("does nothing in a browser with no service workers", () => {
		// @ts-expect-error deleting an optional platform feature
		delete navigator.serviceWorker;

		expect(() => {
			registerServiceWorker();
			load();
		}).not.toThrow();
	});
});

describe("knowing there is no network", () => {
	/*
	 * `navigator.onLine` answers true for a machine attached to a router that
	 * reaches nothing, so it is used only for the one thing it is reliable at.
	 * Whether *the server* is there is `store.health`, which asks it.
	 */
	it("is only ever certain about being disconnected", () => {
		Object.defineProperty(navigator, "onLine", {
			value: false,
			configurable: true,
		});
		expect(isOffline()).toBe(true);

		Object.defineProperty(navigator, "onLine", {
			value: true,
			configurable: true,
		});
		expect(isOffline()).toBe(false);
	});
});
