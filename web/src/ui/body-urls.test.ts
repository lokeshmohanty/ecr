import { describe, expect, it } from "vitest";
import { absolutizePartUrls } from "./body-urls";

const BASE = "http://mail.example:8080";
const TOKEN = "abc123";

describe("absolutizePartUrls", () => {
  it("makes a part reference absolute and adds the token", () => {
    const html = `<img src="/api/v1/messages/a@b.c/parts/3">`;
    expect(absolutizePartUrls(html, BASE, TOKEN)).toBe(
      `<img src="http://mail.example:8080/api/v1/messages/a@b.c/parts/3?access_token=abc123">`,
    );
  });

  it("handles single quotes", () => {
    const html = `<img src='/api/v1/messages/x/parts/1'>`;
    expect(absolutizePartUrls(html, BASE, TOKEN)).toContain(`${BASE}/api/v1/messages/x/parts/1?`);
  });

  it("handles css url() references", () => {
    const html = `<div style="background:url(/api/v1/messages/x/parts/2)">`;
    expect(absolutizePartUrls(html, BASE, TOKEN)).toContain(`url(${BASE}/api/v1/messages/x/parts/2?`);
  });

  it("rewrites several references in one body", () => {
    const html = `<img src="/api/v1/messages/x/parts/1"><img src="/api/v1/messages/x/parts/2">`;
    const out = absolutizePartUrls(html, BASE, TOKEN);
    expect(out.match(/mail\.example/g)).toHaveLength(2);
  });

  it("leaves external URLs untouched", () => {
    const html = `<img src="https://tracker.example.com/pixel.gif">`;
    expect(absolutizePartUrls(html, BASE, TOKEN)).toBe(html);
  });

  it("leaves ordinary links untouched", () => {
    const html = `<a href="https://example.com/api/v1/messages/nope">x</a>`;
    expect(absolutizePartUrls(html, BASE, TOKEN)).toBe(html);
  });

  it("omits the token when there is none", () => {
    const html = `<img src="/api/v1/messages/x/parts/1">`;
    expect(absolutizePartUrls(html, BASE, "")).toBe(
      `<img src="${BASE}/api/v1/messages/x/parts/1">`,
    );
  });

  it("tolerates a base url with a trailing slash", () => {
    const html = `<img src="/api/v1/messages/x/parts/1">`;
    expect(absolutizePartUrls(html, `${BASE}/`, TOKEN)).toContain(
      `${BASE}/api/v1/messages/x/parts/1`,
    );
    expect(absolutizePartUrls(html, `${BASE}/`, TOKEN)).not.toContain("//api");
  });

  it("url-encodes a token with special characters", () => {
    const html = `<img src="/api/v1/messages/x/parts/1">`;
    expect(absolutizePartUrls(html, BASE, "a+b/c")).toContain("access_token=a%2Bb%2Fc");
  });

  it("leaves a body with no parts unchanged", () => {
    const html = `<p>plain text body</p>`;
    expect(absolutizePartUrls(html, BASE, TOKEN)).toBe(html);
  });
});
