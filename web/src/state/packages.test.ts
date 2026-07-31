import { describe, expect, it } from "vitest";
import {
  DEFAULT_PACKAGES,
  PACKAGE_IDS,
  isEditable,
  managedPackages,
  packageStatus,
  type PackageSettings,
} from "./packages";

const settings = (overrides: Partial<PackageSettings> = {}): PackageSettings => ({
  ...DEFAULT_PACKAGES,
  ...overrides,
});

describe("defaults", () => {
  it("every known package has a default", () => {
    for (const id of PACKAGE_IDS) {
      expect(DEFAULT_PACKAGES[id], id).toBeDefined();
    }
  });

  it("defaults to self-managed, because the machine already has a working setup", () => {
    for (const id of PACKAGE_IDS) {
      expect(DEFAULT_PACKAGES[id].management, id).toBe("self");
    }
  });

  it("covers the tools ecr actually drives", () => {
    expect(PACKAGE_IDS).toContain("notmuch");
    expect(PACKAGE_IDS).toContain("mbsync");
    expect(PACKAGE_IDS).toContain("vdirsyncer");
    expect(PACKAGE_IDS).toContain("imapnotify");
  });
});

describe("who may edit a package's configuration", () => {
  it("refuses when the package is self-managed", () => {
    expect(isEditable(settings(), "notmuch")).toBe(false);
  });

  it("allows when ecr manages it", () => {
    const s = settings({ notmuch: { management: "ecr", config: "" } });
    expect(isEditable(s, "notmuch")).toBe(true);
  });

  it("treats an unknown package as not editable", () => {
    expect(isEditable(settings(), "nonesuch" as never)).toBe(false);
  });
});

describe("which packages ecr manages", () => {
  it("lists only the ecr-managed ones", () => {
    const s = settings({
      notmuch: { management: "ecr", config: "a" },
      mbsync: { management: "self", config: "" },
    });
    expect(managedPackages(s)).toEqual(["notmuch"]);
  });

  it("is empty when everything is self-managed", () => {
    expect(managedPackages(settings())).toEqual([]);
  });
});

describe("status reporting", () => {
  it("reports a self-managed package as ignored", () => {
    const status = packageStatus(settings(), "mbsync", { installed: true, version: "1.5.1" });
    expect(status.management).toBe("self");
    expect(status.configApplies).toBe(false);
    expect(status.summary).toMatch(/self-managed/i);
  });

  it("reports an ecr-managed package as applying its config", () => {
    const s = settings({ mbsync: { management: "ecr", config: "Channel main" } });
    const status = packageStatus(s, "mbsync", { installed: true, version: "1.5.1" });
    expect(status.configApplies).toBe(true);
    expect(status.summary).toMatch(/managed by ecr/i);
  });

  it("flags a package that is not installed", () => {
    const status = packageStatus(settings(), "vdirsyncer", { installed: false, version: null });
    expect(status.installed).toBe(false);
    expect(status.summary).toMatch(/not installed/i);
  });

  it("includes the version when there is one", () => {
    const status = packageStatus(settings(), "notmuch", { installed: true, version: "0.40" });
    expect(status.summary).toContain("0.40");
  });
});
