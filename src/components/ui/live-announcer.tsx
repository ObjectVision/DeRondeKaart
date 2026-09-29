import { createSignal, type JSX } from "solid-js";

/**
 * A single polite live region for the whole app (WCAG 2.1 SC 4.1.3 Status
 * Messages).
 *
 * The app changes large amounts of content without moving focus: switching a
 * config variant replaces the entire layer catalogue and navigation tree, and
 * adding or removing a layer repaints the map. A sighted user sees it happen; a
 * screen-reader user is told nothing, because nothing was focused and no alert
 * was raised.
 *
 * ONE region, module-level, rather than one per feature. A live region only
 * announces when its content CHANGES while it is already in the document, so a
 * region that mounts alongside the message it carries is silent — the classic
 * way this fails. Mounting once at app start and writing into it afterwards is
 * what makes the announcement reliable.
 *
 * `polite` rather than `assertive`: these are status messages, not errors, and
 * assertive interrupts whatever the reader is currently saying.
 */

const [message, setMessage] = createSignal("");

/**
 * Announce a short Dutch sentence to screen-reader users.
 *
 * Repeating the same string is handled: an identical value would not be a change
 * and would not be announced, so it is cleared first and set on the next tick.
 * That matters for repeated actions — adding two layers in a row should say so
 * twice.
 */
export function announce(text: string): void {
  if (!text) return;
  if (message() === text) {
    setMessage("");
    queueMicrotask(() => setMessage(text));
    return;
  }
  setMessage(text);
}

/** The live region itself. Rendered once, near the root of the app. */
export function LiveAnnouncer(): JSX.Element {
  return (
    <div
      aria-live="polite"
      // `aria-atomic` so the whole sentence is read rather than only the words
      // that differ from the previous one.
      aria-atomic="true"
      // Visually hidden, not `display: none` — a hidden region is not announced.
      class="sr-only"
    >
      {message()}
    </div>
  );
}
