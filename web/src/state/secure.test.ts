import { afterEach, describe, expect, it, vi } from "vitest";
import { insecureOriginNotice, isSecure, restricted } from "./secure";

function context(secure: boolean) {
	vi.stubGlobal("window", { ...globalThis.window, isSecureContext: secure });
}

afterEach(() => vi.unstubAllGlobals());

describe("what a plain-HTTP origin withholds", () => {
	it("says nothing at all when the context is secure", () => {
		context(true);
		expect(isSecure()).toBe(true);
		expect(restricted()).toEqual([]);
		expect(insecureOriginNotice()).toBeNull();
	});

	it("names every feature the browser takes away", () => {
		context(false);
		expect(restricted()).toEqual([
			"install",
			"offline",
			"notifications",
			"clipboard",
		]);
	});

	/**
	 * Both remedies, because they suit different setups — and loopback, because
	 * a reader on the machine running the server would otherwise go looking for
	 * a problem they do not have.
	 */
	it("names both ways out, and says where the problem is not", () => {
		context(false);
		const notice = insecureOriginNotice() ?? "";

		expect(notice).toContain("HTTPS");
		expect(notice).toContain("tailscale cert");
		expect(notice).toContain("--unsafely-treat-insecure-origin-as-secure");
		expect(notice).toContain("http://localhost");
	});

	/**
	 * `isSecureContext` is the browser's own answer, and it is the only one
	 * worth having: guessing from the protocol gets loopback wrong, and
	 * loopback is how ecr is reached on the machine that serves it.
	 */
	it("trusts the browser rather than reading the scheme", () => {
		vi.stubGlobal("window", {
			...globalThis.window,
			isSecureContext: true,
			location: { protocol: "http:", hostname: "localhost" },
		});
		expect(isSecure()).toBe(true);
	});

	/** Server-side or in a test with no window, nothing is claimed to be broken. */
	it("assumes secure where there is no window to ask", () => {
		vi.stubGlobal("window", undefined);
		expect(isSecure()).toBe(true);
	});
});
