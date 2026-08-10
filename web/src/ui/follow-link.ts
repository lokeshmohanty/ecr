import { openExternal } from "../api/platform";
import { parseMailto } from "../state/mailto";
import type { AppStore } from "../state/store";

/**
 * Follows a link found in a message.
 *
 * A `mailto:` is the one kind this client can answer better than the system
 * can: it opens the composer, prefilled. Handing it to the shell's opener
 * instead would leave the app, ask the desktop which mail client to use, and —
 * once ecr is registered as that handler — arrive back here anyway, slower and
 * by way of a second window.
 *
 * Everything else goes out to the system, where `openExternal` decides what is
 * safe to hand over. Message HTML is untrusted, so this is not a place to be
 * clever: anything that is not a mailto is somebody else's problem by design.
 */
export function followLink(store: AppStore, href: string): void {
  const draft = parseMailto(href);
  if (draft) {
    store.composeDraft(draft, "compose");
    return;
  }

  // A link that does not open has to say so. `openExternal` answers whether it
  // handed the URL over, and discarding that answer is what made a failure here
  // indistinguishable from success: the reader clicks, nothing happens, and
  // there is nothing on screen or in any log to say why. The status line is the
  // right slot — it is about this action, it is not `lastError`'s *cannot reach
  // the server*, and it is gone the next time anything else reports.
  void openExternal(href).then((opened) => {
    if (!opened) store.setStatus(`could not open ${href}`);
  });
}
