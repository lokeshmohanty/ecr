export type MessageFormat = "html" | "text";

/**
 * Which format a message is shown in.
 *
 * The per-message choice is an explicit format, not a "force plain" flag. As a
 * flag it was ANDed with the preference, so with plain text preferred the
 * toggle had nothing to turn off and `t` did nothing.
 */
export function effectiveFormat(
  override: MessageFormat | undefined,
  preferHtml: boolean,
): MessageFormat {
  return override ?? (preferHtml ? "html" : "text");
}

export function toggled(
  override: MessageFormat | undefined,
  preferHtml: boolean,
): MessageFormat {
  return effectiveFormat(override, preferHtml) === "html" ? "text" : "html";
}

/** Labels say what the press will do, not what is on screen. */
export function toggleLabel(current: MessageFormat): string {
  return current === "html" ? "as plain text (t)" : "as html (t)";
}
