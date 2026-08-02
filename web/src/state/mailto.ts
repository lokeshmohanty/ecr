import type { Draft } from "../api/types";

/**
 * Parses a `mailto:` URL into a draft, per RFC 6068.
 *
 * The grammar is smaller than it looks and almost all of it is percent-encoding:
 * recipients sit in the path *and* may also arrive as a `to` parameter, and the
 * two are additive rather than one overriding the other. `subject`, `body`, `cc`
 * and `bcc` are the only other headers worth honouring — RFC 6068 permits any
 * header name in the query, and every one of the rest is either something the
 * server decides (`from`, `date`, `message-id`) or something a link has no
 * business setting on a reader's behalf.
 *
 * Nothing here throws. A mailto link is untrusted input arriving from message
 * HTML or from another application entirely, and the worst it should be able to
 * do is open an emptier composer than the sender intended.
 */
export function parseMailto(url: string): Draft | null {
  const trimmed = url.trim();
  if (!/^mailto:/i.test(trimmed)) return null;

  // Not `new URL()`: it treats everything after `mailto:` as an opaque path and
  // will not give up a searchParams for it in every engine. The split is the
  // whole of the syntax anyway.
  const rest = trimmed.slice("mailto:".length);
  const cut = rest.indexOf("?");
  const path = cut === -1 ? rest : rest.slice(0, cut);
  const query = cut === -1 ? "" : rest.slice(cut + 1);

  const draft: Draft = {
    to: addresses(path),
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    in_reply_to: null,
    references: [],
    attachments: [],
  };

  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const name = decode(eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    const value = eq === -1 ? "" : decode(pair.slice(eq + 1));

    switch (name) {
      case "to":
        draft.to = draft.to.concat(addresses(value));
        break;
      case "cc":
        draft.cc = draft.cc.concat(addresses(value));
        break;
      case "bcc":
        draft.bcc = draft.bcc.concat(addresses(value));
        break;
      case "subject":
        draft.subject = header(value);
        break;
      case "body":
        draft.body = value;
        break;
    }
  }

  draft.to = unique(draft.to);
  draft.cc = unique(draft.cc);
  draft.bcc = unique(draft.bcc);
  return draft;
}

/**
 * A query value in a mailto URL is `+`-as-space only by convention borrowed
 * from form encoding; RFC 6068 says percent-encoding, where `+` is a literal.
 * An address containing `+` is the common case — every `user+tag@host` — so
 * decoding it as a space would corrupt exactly the addresses people use for
 * filtering.
 */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A lone `%` is not a reason to lose the whole link.
    return value;
  }
}

function addresses(value: string): string[] {
  return decode(value)
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
}

/**
 * A header value cannot carry a newline: a link that embeds one is trying to
 * write a second header, and the composer would send whatever it named.
 */
function header(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
