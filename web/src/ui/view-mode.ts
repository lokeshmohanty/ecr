import { handleKey, initialState, selectionSpan, type EditorState } from "../keymap/vim";
import {
  flatten,
  installCursorStyle,
  linkAt,
  paint,
  rangeFor,
  verticalFromRect,
  type Flat,
} from "./doc-cursor";

export interface ViewTarget {
  /** The element holding the rendered message. */
  root: Element;
  /** The frame element, when there is one, for converting coordinates. */
  frame: HTMLElement | null;
}

export interface ViewOptions {
  scroller: HTMLElement | null;
  onExit: () => void;
  onStatus: (text: string) => void;
  onOpenLink?: (href: string) => void;
}

/**
 * Keys view mode claims. Everything else falls through to the application, so
 * `r` still replies and `q` still closes the pane while reading.
 */
const MOTIONS = new Set([
  ..."hjklwWbBeE0^$gG{}%;,fFtTnN/?".split(""),
  ..."0123456789".split(""),
  "v", "V", "o", "y",
]);

function owns(state: EditorState, key: string): boolean {
  if (state.pending !== "" || state.promptKind !== null) return true;
  if (state.mode === "visual" && (key === "i" || key === "a")) return true;
  return MOTIONS.has(key);
}

/** Whether a keystroke did anything, so a key that did not can pass through. */
function moved(before: EditorState, after: EditorState): boolean {
  return (
    before.caret !== after.caret ||
    before.anchor !== after.anchor ||
    before.mode !== after.mode ||
    before.pending !== after.pending ||
    before.count !== after.count ||
    before.promptKind !== after.promptKind ||
    before.prompt !== after.prompt ||
    before.status !== after.status
  );
}

/**
 * Runs the ordinary vim grammar over a rendered message. The buffer is the
 * flattened document, and any keystroke that would change it is refused rather
 * than applied — reading is not editing — which leaves motions, visual mode,
 * search and yank working exactly as they do in the composer.
 */
export function attachViewCursor(target: ViewTarget, options: ViewOptions): () => void {
  const flat: Flat = flatten(target.root);

  // Resolved here rather than when the element was created: Solid builds nodes
  // from a <template>, whose contents belong to an inert document until they
  // are inserted, and an inert document has no selection to paint into.
  const doc = target.root.ownerDocument;
  installCursorStyle(doc);

  let state: EditorState = { ...initialState(flat.text, "normal"), caret: 0 };

  const reveal = (range: Range | null) => {
    const scroller = options.scroller;
    if (!range || !scroller) return;

    const rect = range.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) return;

    // A rect from inside the frame is relative to the frame's own viewport.
    const offset = target.frame ? target.frame.getBoundingClientRect().top : 0;
    const top = rect.top + offset;
    const bottom = rect.bottom + offset;
    const view = scroller.getBoundingClientRect();
    const margin = 32;

    if (top < view.top + margin) scroller.scrollBy({ top: top - view.top - margin });
    else if (bottom > view.bottom - margin) scroller.scrollBy({ top: bottom - view.bottom + margin });
  };

  const repaint = () => {
    const span =
      state.mode === "visual"
        ? selectionSpan(state)
        : { from: state.caret, to: state.caret + 1 };

    const range = rangeFor(flat, span.from, span.to);
    paint(doc, range);
    reveal(range);
  };

  const handler = (event: KeyboardEvent) => {
    if (event.altKey || event.metaKey) return;

    const consume = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (event.key === "Escape") {
      consume();
      paint(doc, null);
      options.onExit();
      return;
    }

    // Enter follows a link, but only when it is not the key that submits an
    // open search prompt or completes a pending sequence.
    if (event.key === "Enter" && state.promptKind === null && state.pending === "") {
      const href = linkAt(flat, state.caret);
      consume();
      if (href) {
        if (options.onOpenLink) options.onOpenLink(href);
        else window.open(href, "_blank", "noopener,noreferrer");
      } else {
        options.onStatus("no link under the cursor");
      }
      return;
    }

    if (event.ctrlKey && !owns(state, event.key)) return;
    if (!event.ctrlKey && !owns(state, event.key)) return;

    // j and k follow rendered lines: a wrapped paragraph is one line in the
    // buffer but many on screen, and the reader means the ones on screen.
    if (!event.ctrlKey && state.pending === "" && (event.key === "j" || event.key === "k")) {
      const next = verticalFromRect(flat, doc, state.caret, event.key === "j" ? 1 : -1);
      if (next !== null) {
        consume();
        state = { ...state, caret: next, count: "", status: "" };
        repaint();
        return;
      }
    }

    const next = handleKey(state, {
      key: event.key,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
    });

    // The message is not a buffer to edit: refuse anything that would write.
    if (next.text !== state.text || next.mode === "insert") return;
    if (!moved(state, next)) return;

    consume();
    state = next;

    if (state.clipboard !== null) {
      const text = state.clipboard;
      void navigator.clipboard?.writeText(text).catch(() => {});
      state = { ...state, clipboard: null };
      options.onStatus(`yanked ${text.length} characters`);
    } else if (state.status) {
      options.onStatus(state.status);
    }

    repaint();
  };

  // Clicking inside the frame moves focus there, and its document is where the
  // key then arrives, so both have to be listened to.
  const listening = new Set<Document>([doc]);
  if (typeof document !== "undefined") listening.add(document);
  for (const each of listening) each.addEventListener("keydown", handler, true);

  repaint();

  return () => {
    for (const each of listening) each.removeEventListener("keydown", handler, true);
    paint(doc, null);
  };
}
