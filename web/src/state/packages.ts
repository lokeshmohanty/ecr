/**
 * Which tools ecr drives, and whether the user or ecr owns their configuration.
 *
 * `self` means the machine already has a working setup (a Home Manager module,
 * say) — ecr reads it, never writes it, and the config held here is ignored and
 * disabled in the UI. `ecr` means ecr owns the file and the settings page is
 * the place to edit it.
 */
export type Management = "self" | "ecr";

/**
 * imapnotify and vdirsyncer used to be here. ecr does both jobs itself now — it
 * holds an IMAP IDLE connection rather than supervising a process to do it, and
 * talks CardDAV and CalDAV directly — so listing them would offer to manage a
 * tool ecr no longer runs. A settings file that still names them parses fine:
 * the server keeps unknown package ids rather than rejecting the file.
 */
export const PACKAGE_IDS = ["notmuch", "mbsync", "msmtp"] as const;

export type PackageId = (typeof PACKAGE_IDS)[number];

export interface PackageConfig {
  management: Management;
  config: string;
}

export type PackageSettings = Record<PackageId, PackageConfig>;

export const PACKAGE_LABELS: Record<PackageId, { title: string; purpose: string; file: string }> = {
  notmuch: { title: "notmuch", purpose: "indexes and tags mail", file: "notmuch/default/config" },
  mbsync: { title: "mbsync (isync)", purpose: "syncs IMAP to the maildir", file: "isyncrc" },
  msmtp: { title: "msmtp", purpose: "sends mail", file: "msmtp/config" },
};

export const DEFAULT_PACKAGES: PackageSettings = Object.fromEntries(
  PACKAGE_IDS.map((id) => [id, { management: "self", config: "" } satisfies PackageConfig]),
) as PackageSettings;

export function isEditable(settings: PackageSettings, id: PackageId): boolean {
  return settings[id]?.management === "ecr";
}

export function managedPackages(settings: PackageSettings): PackageId[] {
  return PACKAGE_IDS.filter((id) => settings[id]?.management === "ecr");
}

export interface ToolProbe {
  installed: boolean;
  version: string | null;
}

export interface PackageStatus {
  id: PackageId;
  management: Management;
  installed: boolean;
  version: string | null;
  /** Whether the config held in settings is actually used. */
  configApplies: boolean;
  summary: string;
}

export function packageStatus(
  settings: PackageSettings,
  id: PackageId,
  probe: ToolProbe,
): PackageStatus {
  const management = settings[id]?.management ?? "self";
  const configApplies = management === "ecr";

  const parts: string[] = [];
  if (!probe.installed) parts.push("not installed");
  else parts.push(probe.version ? `installed, ${probe.version}` : "installed");

  parts.push(configApplies ? "managed by ecr" : "self-managed, config ignored");

  return {
    id,
    management,
    installed: probe.installed,
    version: probe.version,
    configApplies,
    summary: parts.join(" · "),
  };
}
