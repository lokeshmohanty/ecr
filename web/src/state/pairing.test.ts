import { describe, expect, it } from "vitest";
import { parsePairing } from "./pairing";

const TOKEN = "8f1c2d3e4f5a6b7c";

describe("pairing codes", () => {
  it("reads a code carrying an address and a token", () => {
    expect(
      parsePairing(`ecr://pair?url=http%3A%2F%2Fbox%3A8383&token=${TOKEN}`),
    ).toEqual({ url: "http://box:8383", token: TOKEN });
  });

  it("still reads a bare token, which is what older codes are", () => {
    expect(parsePairing(TOKEN)).toEqual({ token: TOKEN });
  });

  it("keeps a url whose own punctuation was encoded", () => {
    const parsed = parsePairing(
      `ecr://pair?url=http%3A%2F%2Fbox%3A8383%2F%3Fa%3D1%26b%3D2&token=${TOKEN}`,
    );

    expect(parsed).toEqual({ url: "http://box:8383/?a=1&b=2", token: TOKEN });
  });

  it("refuses a code with no token, rather than pairing with nothing", () => {
    expect(parsePairing("ecr://pair?url=http%3A%2F%2Fbox")).toBeNull();
    expect(parsePairing("ecr://pair?token=")).toBeNull();
  });

  it("refuses something that is not a code at all", () => {
    expect(parsePairing("")).toBeNull();
    expect(parsePairing("   ")).toBeNull();
    expect(parsePairing("some words here")).toBeNull();
  });

  it("refuses a truncated escape rather than pairing with half a token", () => {
    expect(parsePairing("ecr://pair?token=ab%")).toBeNull();
    expect(parsePairing("ecr://pair?token=ab%2")).toBeNull();
  });

  it("ignores a field it does not know", () => {
    expect(parsePairing(`ecr://pair?token=${TOKEN}&name=phone`)).toEqual({
      token: TOKEN,
    });
  });
});
