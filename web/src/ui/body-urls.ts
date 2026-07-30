/**
 * The server rewrites `cid:` references to root-relative part URLs, because it
 * has no idea what origin the client reaches it on. Inside a `srcdoc` iframe
 * those resolve against the *web* origin rather than the API, and a sandboxed
 * frame cannot send an Authorization header either — so both the origin and
 * the token have to be baked in before the HTML is handed to the frame.
 */
export function absolutizePartUrls(html: string, baseUrl: string, token: string): string {
  const base = baseUrl.replace(/\/$/, "");
  const suffix = token ? `?access_token=${encodeURIComponent(token)}` : "";

  return html.replace(
    /(["'(])\/api\/v1\/messages\/([^"')\s]+)/g,
    (_match, open: string, rest: string) => `${open}${base}/api/v1/messages/${rest}${suffix}`,
  );
}
