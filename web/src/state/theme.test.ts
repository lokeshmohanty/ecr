import { describe, expect, it } from "vitest";

import { applyTheme, colorVariable, emptyTheme, parseTheme } from "./theme";

const NORD = `name = "Nord"
color_scheme = "dark"

[colors]
paper = "#2e3440"
ink = "#eceff4"
`;

describe("parseTheme", () => {
  it("reads the name, scheme and colours", () => {
    const { theme, errors } = parseTheme(NORD);

    expect(errors).toEqual([]);
    expect(theme.name).toBe("Nord");
    expect(theme.colorScheme).toBe("dark");
    expect(theme.colors.paper).toBe("#2e3440");
    expect(theme.colors.ink).toBe("#eceff4");
  });

  it("leaves colours it was not given alone", () => {
    const { theme, errors } = parseTheme(NORD);

    expect(errors).toEqual([]);
    expect(theme.colors.blocking).toBeUndefined();
  });

  it("reports an unknown colour with its line", () => {
    const { errors } = parseTheme(`[colors]\npaper = "#000000"\nsparkle = "#ffffff"\n`);

    expect(errors).toEqual(['line 3: unknown colour "sparkle" in [colors]']);
  });

  it("rejects a value that is not a hex colour", () => {
    const { errors } = parseTheme(`[colors]\npaper = "rebeccapurple"\n`);

    expect(errors).toEqual(['line 2: paper expects a hex colour such as "#1a1b26"']);
  });

  it("accepts the three-, six- and eight-digit forms", () => {
    const { theme, errors } = parseTheme(
      `[colors]\npaper = "#000"\nink = "#abcdef"\ncard = "#11223344"\n`,
    );

    expect(errors).toEqual([]);
    expect(theme.colors.paper).toBe("#000");
    expect(theme.colors.card).toBe("#11223344");
  });

  it("rejects a colour scheme that is neither dark nor light", () => {
    const { errors } = parseTheme(`color_scheme = "sepia"\n`);

    expect(errors).toEqual(["line 1: color_scheme expects dark or light"]);
  });

  it("reports a parse failure with its line rather than throwing", () => {
    const { errors } = parseTheme(`name = "ok"\ncolor_scheme =\n`);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^line 2: /);
  });

  it("reports an unknown font", () => {
    const { errors } = parseTheme(`[fonts]\ncursive = "Comic Sans"\n`);

    expect(errors).toEqual(['line 2: unknown font "cursive" in [fonts]']);
  });

  it("reads the font overrides it does know", () => {
    const { theme, errors } = parseTheme(`[fonts]\nmono = "Iosevka"\n`);

    expect(errors).toEqual([]);
    expect(theme.fonts.mono).toBe("Iosevka");
  });
});

describe("applyTheme", () => {
  it("writes each colour to the variable the utilities read", () => {
    const root = document.createElement("div");
    const { theme } = parseTheme(NORD);

    applyTheme(theme, root);

    expect(root.style.getPropertyValue(colorVariable("paper"))).toBe("#2e3440");
    expect(root.style.getPropertyValue(colorVariable("ink"))).toBe("#eceff4");
    expect(root.style.getPropertyValue("color-scheme")).toBe("dark");
  });

  it("clears a colour the next theme does not set, so nothing leaks between themes", () => {
    const root = document.createElement("div");

    applyTheme(parseTheme(NORD).theme, root);
    expect(root.style.getPropertyValue(colorVariable("paper"))).toBe("#2e3440");

    applyTheme(emptyTheme(), root);
    expect(root.style.getPropertyValue(colorVariable("paper"))).toBe("");
  });

  it("underscored names become the hyphenated custom property", () => {
    expect(colorVariable("paper_2")).toBe("--color-paper-2");
    expect(colorVariable("obligation_bg")).toBe("--color-obligation-bg");
  });
});
