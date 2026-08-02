import { describe, expect, it } from "vitest";
import { parseMailto } from "./mailto";

describe("parsing mailto URLs", () => {
  it("takes the address out of the path", () => {
    expect(parseMailto("mailto:alice@example.com")?.to).toEqual([
      "alice@example.com",
    ]);
  });

  it("refuses anything that is not a mailto URL", () => {
    expect(parseMailto("https://example.com")).toBeNull();
    expect(parseMailto("")).toBeNull();
  });

  it("accepts the scheme in any case, as URLs are case-insensitive there", () => {
    expect(parseMailto("MAILTO:alice@example.com")?.to).toEqual([
      "alice@example.com",
    ]);
  });

  it("splits several addresses in the path", () => {
    expect(parseMailto("mailto:a@x.com,b@y.com")?.to).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });

  it("adds a `to` parameter to the path rather than replacing it", () => {
    expect(parseMailto("mailto:a@x.com?to=b@y.com")?.to).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });

  it("reads cc, bcc, subject and body", () => {
    const draft = parseMailto(
      "mailto:a@x.com?cc=c@x.com&bcc=d@x.com&subject=Hello&body=Hi%20there",
    );
    expect(draft?.cc).toEqual(["c@x.com"]);
    expect(draft?.bcc).toEqual(["d@x.com"]);
    expect(draft?.subject).toBe("Hello");
    expect(draft?.body).toBe("Hi there");
  });

  it("percent-decodes an encoded address", () => {
    expect(parseMailto("mailto:a%40x.com")?.to).toEqual(["a@x.com"]);
  });

  // The bug this guards: `+` means a literal plus in a mailto URL, and a space
  // only in form encoding. Decoding it as a space breaks every address anyone
  // uses for filtering.
  it("keeps a plus in an address instead of decoding it as a space", () => {
    expect(parseMailto("mailto:lokesh+lists@example.com")?.to).toEqual([
      "lokesh+lists@example.com",
    ]);
  });

  it("keeps a multi-line body", () => {
    expect(parseMailto("mailto:a@x.com?body=one%0D%0Atwo")?.body).toBe(
      "one\r\ntwo",
    );
  });

  // A subject is one header. A link carrying a newline in it is trying to write
  // a second one.
  it("flattens a newline in the subject", () => {
    const draft = parseMailto("mailto:a@x.com?subject=Hi%0D%0ABcc:%20evil@x.com");
    expect(draft?.subject).not.toContain("\n");
    expect(draft?.subject).toBe("Hi Bcc: evil@x.com");
  });

  it("ignores headers it is not willing to set", () => {
    const draft = parseMailto("mailto:a@x.com?from=spoof@x.com&subject=Real");
    expect(draft?.subject).toBe("Real");
    expect(draft?.to).toEqual(["a@x.com"]);
  });

  it("drops duplicate recipients", () => {
    expect(parseMailto("mailto:a@x.com?to=a@x.com")?.to).toEqual(["a@x.com"]);
  });

  it("survives a malformed percent escape", () => {
    expect(parseMailto("mailto:a@x.com?subject=100%")?.subject).toBe("100%");
  });

  it("gives an empty draft for a bare mailto:", () => {
    const draft = parseMailto("mailto:");
    expect(draft).not.toBeNull();
    expect(draft?.to).toEqual([]);
    expect(draft?.subject).toBe("");
  });

  it("produces a draft the composer can send as-is", () => {
    const draft = parseMailto("mailto:a@x.com");
    expect(draft?.in_reply_to).toBeNull();
    expect(draft?.references).toEqual([]);
    expect(draft?.attachments).toEqual([]);
  });

  it("trims whitespace around addresses in a list", () => {
    expect(parseMailto("mailto:a@x.com,%20b@y.com")?.to).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });
});
