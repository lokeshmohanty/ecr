import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternal } from "./platform";

const opened: string[] = [];

afterEach(() => {
  opened.length = 0;
  vi.unstubAllGlobals();
});

function captureWindowOpen() {
  vi.stubGlobal(
    "open",
    (url: string) => {
      opened.push(url);
      return null;
    },
  );
}

describe("opening a link from a message", () => {
  it("hands over the schemes a reader meant to follow", async () => {
    captureWindowOpen();

    expect(await openExternal("https://example.com/x")).toBe(true);
    expect(await openExternal("http://example.com")).toBe(true);
    expect(await openExternal("mailto:ada@example.com")).toBe(true);
    expect(opened).toHaveLength(3);
  });

  it("refuses a scheme that would make the system act", async () => {
    captureWindowOpen();

    // A message is untrusted input: these are ways to reach the machine
    // rather than ways to read a page.
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>",
      "intent://scan/#Intent;scheme=zxing;end",
    ]) {
      expect(await openExternal(url), url).toBe(false);
    }
    expect(opened).toEqual([]);
  });

  it("treats an unrecognisable href as a path on our own origin, not a scheme", async () => {
    captureWindowOpen();
    // Resolved against the page rather than refused, which is the safe
    // reading: it can only ever point back at us. The allowlist above is what
    // actually stops a message reaching the machine.
    expect(await openExternal("::::")).toBe(true);
    expect(opened[0]).toMatch(/^https?:\/\//);
  });

  it("resolves a relative href against the page rather than dropping it", async () => {
    captureWindowOpen();
    expect(await openExternal("/help")).toBe(true);
    expect(opened[0]).toMatch(/^https?:\/\/[^/]+\/help$/);
  });
});
