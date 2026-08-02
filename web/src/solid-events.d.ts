import "solid-js";

/**
 * Solid's `oncapture:*` attributes are typed from this interface and it ships
 * empty, so the event has to be declared before the JSX will compile.
 *
 * The three panes claim focus on the capture phase: a control inside a pane
 * that moves to a *different* pane has to have the last word, and a bubbling
 * handler on the container runs after it and puts the pane straight back.
 */
declare module "solid-js" {
  namespace JSX {
    interface CustomCaptureEvents {
      click: MouseEvent;
    }
  }
}
