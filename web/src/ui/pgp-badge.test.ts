import { describe, expect, it } from "vitest";
import { pgpBadge } from "./pgp-badge";
import type { Body, Signature } from "../api/types";

function body(over: Partial<Body> = {}): Body {
	return {
		format: "text",
		content: "hello",
		remote_resources_blocked: 0,
		has_html: false,
		...over,
	};
}

const good: Signature = { state: "good", key: "DEADBEEF", signer: "Ada" };

describe("the OpenPGP badge", () => {
	/*
	 * The one that decides whether any of the others are ever read. A badge on
	 * every message is a badge nobody looks at, and it would make the one that
	 * matters invisible by being ordinary.
	 */
	it("says nothing at all about ordinary mail", () => {
		expect(pgpBadge(body())).toBeNull();
		expect(pgpBadge(undefined)).toBeNull();
		expect(pgpBadge(null)).toBeNull();
	});

	it("names who signed a message that verified", () => {
		const badge = pgpBadge(body({ signature: good }));

		expect(badge?.tone).toBe("pgp-good");
		expect(badge?.label).toContain("Ada");
	});

	/*
	 * Good is the only reassuring state. Anything that treats "there is a
	 * signature" as reassurance is wrong, and this is the assertion that says
	 * so for all five of the others at once.
	 */
	it("reserves the reassuring colour for a plainly good signature", () => {
		const others: Signature[] = [
			{ state: "expired", key: "K", signer: "Ada" },
			{ state: "revoked", key: "K", signer: "Ada" },
			{ state: "bad", key: "K" },
			{ state: "unknown", key: "K" },
			{ state: "failed", detail: "gpg is not installed" },
		];

		for (const signature of others) {
			expect(pgpBadge(body({ signature }))?.tone).not.toBe("pgp-good");
		}
	});

	/*
	 * Amber, not red. The message really was signed; the key is not current.
	 * Red would make the alarming state ordinary, and a red that is ordinary
	 * is one nobody reads.
	 */
	it("treats an expired or revoked key as caution rather than forgery", () => {
		for (const state of ["expired", "revoked"] as const) {
			const badge = pgpBadge(
				body({ signature: { state, key: "K", signer: "Ada" } }),
			);
			expect(badge?.tone).toBe("pgp-caution");
			expect(badge?.label).toContain("Ada");
		}
	});

	it("is alarming only when the bytes do not match the signature", () => {
		const badge = pgpBadge(body({ signature: { state: "bad", key: "K" } }));

		expect(badge?.tone).toBe("pgp-bad");
		expect(badge?.label).toContain("altered");
	});

	/*
	 * The ordinary state of mail from a stranger. Painted as broken, it
	 * teaches people to ignore the indicator entirely.
	 */
	it("stays quiet about a key nobody has, rather than calling it broken", () => {
		const badge = pgpBadge(body({ signature: { state: "unknown", key: "K" } }));

		expect(badge?.tone).toBe("pgp-quiet");
		expect(badge?.label).not.toContain("altered");
	});

	/*
	 * Two different questions — who could read this, and who wrote it — and a
	 * client that shows one padlock for both is wrong about half the mail it
	 * draws it on.
	 */
	it("tells encryption apart from a signature", () => {
		const encrypted = pgpBadge(body({ encrypted: true }));
		expect(encrypted?.label).toBe("encrypted");
		expect(encrypted?.detail).toContain("Nothing here says who sent it");

		const both = pgpBadge(body({ encrypted: true, signature: good }));
		expect(both?.tone).toBe("pgp-good");
		expect(both?.label).toContain("encrypted");
		expect(both?.label).toContain("Ada");
	});

	/*
	 * A machine with no gpg cannot check anything, and that is a fact about
	 * the machine. Reported as a bad signature it would accuse every sender of
	 * forgery.
	 */
	it("reports being unable to check as being unable to check", () => {
		const badge = pgpBadge(
			body({
				signature: { state: "failed", detail: "gpg is not installed" },
			}),
		);

		expect(badge?.tone).toBe("pgp-quiet");
		expect(badge?.detail).toContain("gpg is not installed");
	});
});
