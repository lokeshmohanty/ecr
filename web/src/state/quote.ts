/** Lines of quoted text kept before the rest is elided. */
const MAX_QUOTED_LINES = 100;

/**
 * Quotes a message body for a reply.
 *
 * Real quoting matters: a reply that shows only the subject gives the reader
 * nothing to answer against. Long bodies are capped, because a newsletter
 * quoted in full leaves a draft nobody can edit.
 */
export function quoteBody(body: string): string {
  const text = body.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (text.trim() === "") return "";

  const lines = text.split("\n");
  const kept = lines.slice(0, MAX_QUOTED_LINES);
  const elided = lines.length > MAX_QUOTED_LINES;

  const quoted = kept.map((line) => {
    if (line.trim() === "") return ">";
    // An already-quoted line nests without gaining a space.
    return line.startsWith(">") ? `>${line}` : `> ${line}`;
  });

  if (elided) quoted.push(">", `> […] ${lines.length - MAX_QUOTED_LINES} more lines`);

  return quoted.join("\n");
}

export function replyAttribution(date: string, sender: string | null): string {
  const who = sender ?? "someone";
  const when = date.trim();
  return when ? `On ${when}, ${who} wrote:` : `${who} wrote:`;
}
