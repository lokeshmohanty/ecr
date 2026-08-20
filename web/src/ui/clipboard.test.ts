import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("copying text", () => {
	it("uses the async clipboard where the origin has one", () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText } });

		expect(copyText("yanked")).toBe(true);
		expect(writeText).toHaveBeenCalledWith("yanked");
	});

	/**
	 * The case this exists for. On `http://mail.lan:8383` the async clipboard
	 * is not there at all, and the call sites used to guard that with `?.` —
	 * which reported a yank and copied nothing.
	 */
	it("falls back to execCommand where there is none", () => {
		vi.stubGlobal("navigator", {});
		const exec = vi.fn().mockReturnValue(true);
		Object.defineProperty(document, "execCommand", {
			value: exec,
			configurable: true,
		});

		expect(copyText("yanked")).toBe(true);
		expect(exec).toHaveBeenCalledWith("copy");
	});

	/** The carrier is a detached element; leaving it behind litters the DOM. */
	it("leaves nothing in the document afterwards", () => {
		vi.stubGlobal("navigator", {});
		Object.defineProperty(document, "execCommand", {
			value: () => true,
			configurable: true,
		});

		copyText("yanked");
		expect(document.querySelectorAll("textarea")).toHaveLength(0);
	});

	/**
	 * Both callers yank from a surface that owns the keyboard. Focus left on a
	 * removed node hands the next keystroke to the document, and the pane the
	 * reader is in goes inert.
	 */
	it("gives focus back to whatever had it", () => {
		vi.stubGlobal("navigator", {});
		Object.defineProperty(document, "execCommand", {
			value: () => true,
			configurable: true,
		});

		const field = document.createElement("textarea");
		document.body.appendChild(field);
		field.focus();

		copyText("yanked");
		expect(document.activeElement).toBe(field);
	});

	it("does not reach for the clipboard over nothing", () => {
		const writeText = vi.fn();
		vi.stubGlobal("navigator", { clipboard: { writeText } });

		expect(copyText("")).toBe(false);
		expect(writeText).not.toHaveBeenCalled();
	});
});
