import { parse as parseToml } from "smol-toml";

import { lineOfHeader, lineOfKey } from "./settings";

/**
 * The semantic palette. These names, not Tailwind's, are what a theme file
 * writes: a theme author decides what "unread" looks like, not what class the
 * component happens to use.
 */
export const COLOR_KEYS = [
  "paper",
  "paper_2",
  "card",
  "ink",
  "ink_2",
  "ink_3",
  "rule",
  "rule_soft",
  "proved",
  "proved_bg",
  "obligation",
  "obligation_bg",
  "blocking",
  "blocking_bg",
  "neutral_bg",
] as const;

export type ColorKey = (typeof COLOR_KEYS)[number];
export type FontKey = "display" | "body" | "mono";

export interface Theme {
  name: string;
  colorScheme: "dark" | "light";
  colors: Partial<Record<ColorKey, string>>;
  fonts: Partial<Record<FontKey, string>>;
}

export interface ThemeParseResult {
  theme: Theme;
  errors: string[];
}

const FONT_KEYS: FontKey[] = ["display", "body", "mono"];
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The last theme the server gave us. Reading it before the first request lands
 * is what stops the app painting in the built-in palette and then flipping.
 */
const STORAGE_KEY = "ecr.theme.toml";

export function loadThemeText(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveThemeText(raw: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Private browsing, or a full quota: the theme still applies this session.
  }
}

export function emptyTheme(): Theme {
  return { name: "", colorScheme: "dark", colors: {}, fonts: {} };
}

/** `paper_2` is the token `--color-paper-2`. */
export function colorVariable(key: ColorKey): string {
  return `--color-${key.replace(/_/g, "-")}`;
}

export function fontVariable(key: FontKey): string {
  return `--font-${key}`;
}

/**
 * Tailwind compiles every utility to `var(--color-*)` rather than a literal, so
 * writing these properties on the document element restyles the whole app.
 * Nothing else in the client knows a theme exists.
 */
export function applyTheme(theme: Theme, root: HTMLElement): void {
  for (const key of COLOR_KEYS) {
    const value = theme.colors[key];
    if (value) root.style.setProperty(colorVariable(key), value);
    else root.style.removeProperty(colorVariable(key));
  }

  for (const key of FONT_KEYS) {
    const value = theme.fonts[key];
    if (value) root.style.setProperty(fontVariable(key), value);
    else root.style.removeProperty(fontVariable(key));
  }

  root.style.setProperty("color-scheme", theme.colorScheme);
}

/**
 * A theme may set only the colours it cares about; anything omitted keeps the
 * built-in value. Presets shipped with the server are the ones held to
 * completeness, and a Rust test enforces that.
 */
export function parseTheme(text: string): ThemeParseResult {
  const theme = emptyTheme();
  const errors: string[] = [];

  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch (error) {
    const line = (error as { line?: number }).line ?? 1;
    const message = (error as Error).message.split("\n")[0] ?? "could not be parsed";
    return { theme, errors: [`line ${line}: ${message}`] };
  }

  if (typeof doc.name === "string") theme.name = doc.name;
  else if (doc.name !== undefined) {
    errors.push(`line ${lineOfKey(text, "", "name")}: name expects text in quotes`);
  }

  if (doc.color_scheme === "dark" || doc.color_scheme === "light") {
    theme.colorScheme = doc.color_scheme;
  } else if (doc.color_scheme !== undefined) {
    errors.push(`line ${lineOfKey(text, "", "color_scheme")}: color_scheme expects dark or light`);
  }

  readColors(doc.colors, text, theme, errors);
  readFonts(doc.fonts, text, theme, errors);

  return { theme, errors };
}

function readColors(table: unknown, text: string, theme: Theme, errors: string[]): void {
  if (table === undefined) return;
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    errors.push(`line ${lineOfHeader(text, "colors")}: [colors] expects a table`);
    return;
  }

  const known = new Set<string>(COLOR_KEYS);
  for (const [key, value] of Object.entries(table)) {
    const line = lineOfKey(text, "[colors]", key);
    if (!known.has(key)) {
      errors.push(`line ${line}: unknown colour "${key}" in [colors]`);
      continue;
    }
    if (typeof value !== "string" || !HEX.test(value)) {
      errors.push(`line ${line}: ${key} expects a hex colour such as "#1a1b26"`);
      continue;
    }
    theme.colors[key as ColorKey] = value;
  }
}

function readFonts(table: unknown, text: string, theme: Theme, errors: string[]): void {
  if (table === undefined) return;
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    errors.push(`line ${lineOfHeader(text, "fonts")}: [fonts] expects a table`);
    return;
  }

  for (const [key, value] of Object.entries(table)) {
    const line = lineOfKey(text, "[fonts]", key);
    if (!FONT_KEYS.includes(key as FontKey)) {
      errors.push(`line ${line}: unknown font "${key}" in [fonts]`);
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`line ${line}: ${key} expects a font family in quotes`);
      continue;
    }
    theme.fonts[key as FontKey] = value;
  }
}
