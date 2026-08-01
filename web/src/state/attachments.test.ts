import { describe, expect, it } from "vitest";
import {
  attachmentBytes,
  encodeBytes,
  formatSize,
  refuseReason,
  totalBytes,
  MAX_ATTACHMENT_BYTES,
} from "./attachments";

const file = (data_b64: string) => ({ filename: "f", content_type: "text/plain", data_b64 });

describe("sizing an attachment from its encoding", () => {
  it("reads the decoded size off the encoded length", () => {
    // 6 bytes encode to 8 characters with no padding.
    expect(attachmentBytes(file("AAAAAAAA"))).toBe(6);
  });

  it("accounts for padding", () => {
    expect(attachmentBytes(file("AAAA"))).toBe(3);
    expect(attachmentBytes(file("AAA="))).toBe(2);
    expect(attachmentBytes(file("AA=="))).toBe(1);
  });

  it("is zero for an empty attachment", () => {
    expect(attachmentBytes(file(""))).toBe(0);
  });

  it("sums a list", () => {
    expect(totalBytes([file("AAAA"), file("AAAA")])).toBe(6);
  });

  it("agrees with what was actually encoded", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(attachmentBytes(file(encodeBytes(bytes)))).toBe(5);
  });
});

describe("refusing a file before it is uploaded", () => {
  it("allows an ordinary file", () => {
    expect(refuseReason([], 1024)).toBeNull();
  });

  it("refuses an empty one", () => {
    expect(refuseReason([], 0)).toBe("that file is empty");
  });

  it("refuses one that would breach the cap", () => {
    expect(refuseReason([], MAX_ATTACHMENT_BYTES + 1)).toContain("exceed");
  });

  it("counts what is already attached towards the cap", () => {
    const half = "A".repeat(Math.ceil(MAX_ATTACHMENT_BYTES / 2 / 3) * 4);
    expect(refuseReason([file(half)], MAX_ATTACHMENT_BYTES / 2 + 4096)).toContain("exceed");
  });

  it("allows a file that just fits alongside another", () => {
    expect(refuseReason([file("AAAA")], 1024)).toBeNull();
  });
});

describe("formatting a size", () => {
  it("uses bytes, then K, then M", () => {
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(2048)).toBe("2K");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0M");
  });
});

describe("encoding bytes", () => {
  it("round-trips through atob", () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 128]);
    const decoded = atob(encodeBytes(bytes));
    expect([...decoded].map((c) => c.charCodeAt(0))).toEqual([...bytes]);
  });

  it("handles a payload past the argument limit of one call", () => {
    const bytes = new Uint8Array(200_000).fill(65);
    expect(() => encodeBytes(bytes)).not.toThrow();
    expect(atob(encodeBytes(bytes)).length).toBe(200_000);
  });
});
