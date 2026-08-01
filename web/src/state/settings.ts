import { DEFAULT_BINDINGS, type Action, type Binding, type Pane } from "../keymap/engine";
import {
  DEFAULT_PACKAGES,
  PACKAGE_IDS,
  type Management,
  type PackageId,
  type PackageSettings,
} from "./packages";

export interface Preferences {
  /** Rows fetched per query. */
  pageSize: number;
  /** Show HTML bodies rather than the plain-text alternative. */
  preferHtml: boolean;
  /** Load remote images without asking. */
  loadRemoteImages: boolean;
  /** Open the newest message expanded when a thread is opened. */
  expandNewest: boolean;
  /** Reply to everyone by default. */
  replyAll: boolean;
  /** Query the client starts on. */
  startQuery: string;
  /** Moving through a list updates the detail pane as you go. */
  followSelection: boolean;
  /** Which vim mode the composer and settings editor open in. */
  editorStartMode: "normal" | "insert";
  /** Open compose pinned to the bottom of the detail pane. */
  pinnedCompose: boolean;
  /** Drop the unread tag once a message has actually been on screen. */
  markReadOnOpen: boolean;
  /** How long it must be on screen first, in milliseconds. */
  markReadDelay: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  pageSize: 100,
  preferHtml: true,
  loadRemoteImages: false,
  expandNewest: true,
  replyAll: false,
  startQuery: "tag:inbox",
  followSelection: true,
  editorStartMode: "normal",
  pinnedCompose: true,
  markReadOnOpen: true,
  markReadDelay: 1200,
};

export interface Settings {
  preferences: Preferences;
  bindings: Binding[];
  packages: PackageSettings;
}

const STORAGE_KEY = "ecr.settings";

export function defaultSettings(): Settings {
  return {
    preferences: { ...DEFAULT_PREFERENCES },
    bindings: [...DEFAULT_BINDINGS],
    packages: structuredClone(DEFAULT_PACKAGES),
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      preferences: { ...DEFAULT_PREFERENCES, ...(parsed.preferences ?? {}) },
      bindings: parsed.bindings?.length ? parsed.bindings : [...DEFAULT_BINDINGS],
      packages: { ...structuredClone(DEFAULT_PACKAGES), ...(parsed.packages ?? {}) },
    };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // A full or disabled storage is not worth failing the edit over.
  }
}

/**
 * Settings are edited as text in the same vim editor used for mail, so the
 * format has to be readable and forgiving: `key = value` for preferences and
 * `keys<TAB>action<TAB>panes` for bindings, with `#` comments.
 */
export function toText(settings: Settings): string {
  const lines: string[] = [
    "# ecr settings — edit here, ZZ to apply, ZQ to discard",
    "",
    "[preferences]",
  ];

  for (const [key, value] of Object.entries(settings.preferences)) {
    lines.push(`${key} = ${value}`);
  }

  lines.push("", "[packages]", "# self = you manage it (ecr reads only) · ecr = ecr owns the config");
  for (const id of PACKAGE_IDS) {
    lines.push(`${id} = ${settings.packages[id]?.management ?? "self"}`);
  }

  lines.push(
    "",
    "[keybindings]",
    "# keys  action  panes(optional, comma separated: sidebar,list,detail)",
  );

  for (const binding of settings.bindings) {
    const action = actionToText(binding.action);
    const panes = binding.panes?.join(",") ?? "";
    lines.push(`${binding.keys}\t${action}\t${panes}`.trimEnd());
  }

  return lines.join("\n") + "\n";
}

export interface ParseResult {
  settings: Settings;
  errors: string[];
}

export function fromText(text: string): ParseResult {
  const settings = defaultSettings();
  settings.bindings = [];
  const errors: string[] = [];
  let section = "";

  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;

    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).toLowerCase();
      return;
    }

    if (section === "preferences") {
      const [key, ...rest] = line.split("=");
      const name = key?.trim() ?? "";
      const value = rest.join("=").trim();
      if (!(name in DEFAULT_PREFERENCES)) {
        errors.push(`line ${index + 1}: unknown preference "${name}"`);
        return;
      }
      applyPreference(settings.preferences, name as keyof Preferences, value, index + 1, errors);
      return;
    }

    if (section === "packages") {
      const [key, ...rest] = line.split("=");
      const id = (key?.trim() ?? "") as PackageId;
      const value = rest.join("=").trim();

      if (!PACKAGE_IDS.includes(id)) {
        errors.push(`line ${index + 1}: unknown package "${id}"`);
        return;
      }
      if (value !== "self" && value !== "ecr") {
        errors.push(`line ${index + 1}: ${id} expects self or ecr`);
        return;
      }
      settings.packages[id] = {
        ...(settings.packages[id] ?? { config: "" }),
        management: value as Management,
      };
      return;
    }

    if (section === "keybindings") {
      const parts = raw.split("\t").map((p) => p.trim()).filter((p, i) => i < 3);
      const [keys, actionText, panesText] = parts;
      if (!keys || !actionText) {
        errors.push(`line ${index + 1}: expected "keys<tab>action"`);
        return;
      }
      const action = actionFromText(actionText);
      if (!action) {
        errors.push(`line ${index + 1}: unknown action "${actionText}"`);
        return;
      }
      const panes = panesText
        ? (panesText.split(",").map((p) => p.trim()).filter(Boolean) as Pane[])
        : undefined;
      settings.bindings.push({
        keys,
        action,
        description: actionText,
        ...(panes?.length ? { panes } : {}),
      });
    }
  });

  if (settings.bindings.length === 0) {
    settings.bindings = [...DEFAULT_BINDINGS];
    if (text.includes("[keybindings]")) {
      errors.push("no valid keybindings; keeping the defaults");
    }
  }

  return { settings, errors };
}

function applyPreference(
  preferences: Preferences,
  name: keyof Preferences,
  value: string,
  line: number,
  errors: string[],
): void {
  const current = DEFAULT_PREFERENCES[name];

  if (typeof current === "boolean") {
    if (value !== "true" && value !== "false") {
      errors.push(`line ${line}: ${name} expects true or false`);
      return;
    }
    (preferences[name] as boolean) = value === "true";
    return;
  }

  if (name === "editorStartMode") {
    if (value !== "normal" && value !== "insert") {
      errors.push(`line ${line}: editorStartMode expects normal or insert`);
      return;
    }
    preferences.editorStartMode = value;
    return;
  }

  if (typeof current === "number") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push(`line ${line}: ${name} expects a positive number`);
      return;
    }
    (preferences[name] as number) = Math.floor(parsed);
    return;
  }

  (preferences[name] as string) = value;
}

/** `reply:all` carries the one action that has a parameter. */
export function actionToText(action: Action): string {
  if (action.kind === "reply") return action.all ? "reply:all" : "reply";
  if (action.kind === "mark") return `mark:${action.tag}`;
  if ((action.kind === "scrollDown" || action.kind === "scrollUp") && action.half) {
    return `${action.kind}:half`;
  }
  return action.kind;
}

export function actionFromText(text: string): Action | null {
  if (text === "reply") return { kind: "reply", all: false };
  if (text === "reply:all") return { kind: "reply", all: true };
  if (text === "scrollDown:half") return { kind: "scrollDown", half: true };
  if (text === "scrollUp:half") return { kind: "scrollUp", half: true };
  if (text.startsWith("mark:")) return { kind: "mark", tag: text.slice(5) };

  const known = new Set(DEFAULT_BINDINGS.map((b) => b.action.kind));
  return known.has(text as Action["kind"]) ? ({ kind: text } as Action) : null;
}
