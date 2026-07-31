import { DEFAULT_BINDINGS, type Action, type Binding, type Pane } from "../keymap/engine";

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
}

export const DEFAULT_PREFERENCES: Preferences = {
  pageSize: 100,
  preferHtml: true,
  loadRemoteImages: false,
  expandNewest: true,
  replyAll: false,
  startQuery: "tag:inbox",
};

export interface Settings {
  preferences: Preferences;
  bindings: Binding[];
}

const STORAGE_KEY = "ecr.settings";

export function defaultSettings(): Settings {
  return { preferences: { ...DEFAULT_PREFERENCES }, bindings: [...DEFAULT_BINDINGS] };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      preferences: { ...DEFAULT_PREFERENCES, ...(parsed.preferences ?? {}) },
      bindings: parsed.bindings?.length ? parsed.bindings : [...DEFAULT_BINDINGS],
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
  return action.kind;
}

export function actionFromText(text: string): Action | null {
  if (text === "reply") return { kind: "reply", all: false };
  if (text === "reply:all") return { kind: "reply", all: true };
  if (text.startsWith("mark:")) return { kind: "mark", tag: text.slice(5) };

  const known = new Set(DEFAULT_BINDINGS.map((b) => b.action.kind));
  return known.has(text as Action["kind"]) ? ({ kind: text } as Action) : null;
}
