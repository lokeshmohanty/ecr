import { describe, expect, it } from "vitest";
import { PROTECTIONS } from "./ComposePane";
import type { Protection } from "../api/types";

describe("the composer's OpenPGP choices", () => {
	/*
	 * The server refuses anything outside this set rather than falling back to
	 * none — a typo answering "no protection" sends in the clear a message
	 * somebody asked to have encrypted, and nothing on either end ever says so.
	 * So the labels the client offers have to be exactly the values it accepts.
	 */
	it("offers only values the server accepts", () => {
		const accepted: Protection[] = ["sign", "encrypt", "sign+encrypt"];

		expect(PROTECTIONS.map((p) => p.value).sort()).toEqual(accepted.sort());
	});

	/*
	 * "Sign" and "encrypt" are the format's words, not a writer's. One proves
	 * who wrote it, the other decides who can read it, and a control that
	 * assumes the distinction is known is one that gets the wrong one chosen.
	 */
	it("explains what each one actually achieves", () => {
		for (const option of PROTECTIONS) {
			expect(option.detail.length).toBeGreaterThan(20);
		}
		expect(
			PROTECTIONS.find((p) => p.value === "sign")?.detail,
		).toMatch(/anyone can still read it/i);
	});

	/*
	 * PGP/MIME leaves the subject and every address in the clear. Somebody who
	 * assumes otherwise has been given a much stronger promise than the format
	 * makes, so the one control that could imply it has to say so.
	 */
	it("says that encryption does not hide the subject", () => {
		const encrypt = PROTECTIONS.find((p) => p.value === "encrypt");

		expect(encrypt?.detail).toMatch(/subject/i);
		expect(encrypt?.detail).toMatch(/clear/i);
	});
});
