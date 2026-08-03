import { describe, expect, it } from "vitest";
import { PHONE_MAX, layoutFor } from "./narrow";

describe("layoutFor", () => {
  it("stacks below the phone line whatever the sidebar asks for", () => {
    expect(layoutFor(390, 1024)).toBe("stacked");
    expect(layoutFor(PHONE_MAX, 1024)).toBe("stacked");
    expect(layoutFor(390, 0)).toBe("stacked");
  });

  it("drops the sidebar between the phone line and the configured width", () => {
    expect(layoutFor(PHONE_MAX + 1, 1024)).toBe("two");
    expect(layoutFor(900, 1024)).toBe("two");
    expect(layoutFor(1023, 1024)).toBe("two");
  });

  it("keeps three panes at the configured width and above", () => {
    expect(layoutFor(1024, 1024)).toBe("three");
    expect(layoutFor(1440, 1024)).toBe("three");
  });

  it("reads a width below the phone line as never wanting the drawer", () => {
    expect(layoutFor(800, 0)).toBe("three");
    expect(layoutFor(PHONE_MAX + 1, 500)).toBe("three");
  });

  it("reads a width above any screen as always wanting it", () => {
    expect(layoutFor(3840, 99_999)).toBe("two");
  });
});
