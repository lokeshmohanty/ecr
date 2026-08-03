/**
 * What a pairing QR carries. The other half of `ecr_core::pairing` — a scanner
 * runs here and the code is written there, so the two have to agree on the
 * format, and each has its own tests over the same cases.
 *
 * `ecr://pair?url=…&token=…`, with a bare token still accepted because that is
 * what `ecr token new --qr` printed before the address was included.
 */
export interface Pairing {
  /** Absent when the code carries a token only, as every older code does. */
  url?: string;
  token: string;
}

const SCHEME = "ecr://pair?";

export function parsePairing(text: string): Pairing | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (!trimmed.startsWith(SCHEME)) {
    // A bare token, and nothing with a space in it can be one.
    return /\s/.test(trimmed) ? null : { token: trimmed };
  }

  let url: string | undefined;
  let token: string | undefined;

  for (const field of trimmed.slice(SCHEME.length).split("&")) {
    const at = field.indexOf("=");
    if (at < 0) continue;

    const key = field.slice(0, at);
    const value = decode(field.slice(at + 1));
    // A truncated escape is refused outright rather than guessed at: half a
    // token pairs a device that then cannot talk to anything.
    if (value === null) return null;

    if (key === "url") url = value;
    else if (key === "token") token = value;
  }

  if (!token) return null;
  return url ? { url, token } : { token };
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
