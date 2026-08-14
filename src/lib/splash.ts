/**
 * Boot splash teardown.
 *
 * The splash itself is declared inline in `index.html` — it has to be, because
 * the stylesheets and the app bundle are render-blocking, so anything rendered
 * by React arrives at the same time as the app it is meant to cover.
 *
 * Lives in its own module rather than in `main.tsx`: App.tsx needs it, and
 * importing it from `main.tsx` would close a cycle (main -> App -> main).
 */

/**
 * Remove the boot splash.
 *
 * Safe to call repeatedly and from any path. Every caller funnels through here
 * because the one unacceptable outcome is a splash that outlives the load: it
 * covers a working app and makes it look broken. `index.html` carries a 12s
 * timeout as a final backstop for the case where this module never runs.
 */
export function dismissSplash(): void {
  const splash = document.getElementById("splash");
  if (!splash) return;

  splash.classList.add("is-hiding");
  // Remove after the fade. A cancelled or skipped transition never fires
  // `transitionend`, so the timeout — not the event — is what guarantees
  // removal; the event just makes the common case prompt.
  const remove = () => splash.remove();
  splash.addEventListener("transitionend", remove, { once: true });
  setTimeout(remove, 400);
}
