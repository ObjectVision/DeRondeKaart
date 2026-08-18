import { createEffect } from "solid-js";
import type { ViewState } from "@/components/map/map-view-config";
import type { AreaFilterState } from "./use-area-filter";
import type { ViewUpdate } from "./use-url-commands";

/**
 * The gebiedsfilter half of the embedding-host bridge (Power BI visual): turns
 * a host `filter` message into one committed area-filter selection.
 *
 * Owns the queue for messages arriving before the filter options have loaded —
 * it lives here, next to the only code that reads it.
 */
export interface UseHostFilterOptions {
  /** The area filter's live state; its members are accessors. */
  areaFilter: AreaFilterState;
  applyView: (view: ViewUpdate) => void;
  initialViewState: ViewState;
}

export function useHostFilter(
  options: UseHostFilterOptions,
): (filter: Record<string, string | null>) => void {
  // A host `filter` message that arrives before the gebiedsfilter options have
  // finished loading (entries still empty) is stashed here and flushed once the
  // options are ready — see the effect below.
  let pendingFilter: Record<string, string | null> | null = null;

  // Set the gebiedsfilter by level name → CBS code or display label. Resolves
  // against the loaded filter options and builds the end state coarse→fine,
  // then commits it in ONE applySelections call (cascade pruning + fly-to
  // included). Unknown levels/values are warned and skipped.
  //
  // The single commit is load-bearing, not a tidy-up: setValue rebuilds from the
  // hook's current `selections`, so calling it once per level in this
  // synchronous pass made every call discard the previous one's result. Last
  // write won — which is why unpicking Buurt then re-sending {Gemeente, Wijk}
  // re-flew to the still-present Buurt instead of zooming out to Wijk.
  function setFilterFromHost(filter: Record<string, string | null>) {
    const af = options.areaFilter;
    if (af.entries().length === 0) {
      // Options not loaded yet (they resolve async after mount, and in embed
      // mode the map-ready handshake fires immediately). Queue this message and
      // flush it once entries are ready, so a filter sent right after open is
      // not silently dropped.
      pendingFilter = filter;
      return;
    }
    // Build the post-message selection locally, starting from the current one:
    // levels this message doesn't name keep their value (partial merge).
    //
    // Seeded straight from `af.selections()`. Signal writes land synchronously,
    // so a second host message arriving in the same tick already sees what the
    // first committed — React needed a separate "last host selection" ref here
    // precisely because its state would not update until a re-render, and two
    // messages in one tick would both read the pre-clear selection.
    const selectedAfter = new Map(af.selections());

    // Apply coarse→fine (filter.json/entries order) so each level's options are
    // narrowed by the ancestors already resolved in this same pass — hence
    // resolving against `selectedAfter` rather than the committed selections,
    // which don't change until the single commit below.
    for (const entry of af.entries()) {
      const match = Object.keys(filter).find(
        (level) => level.toLowerCase() === entry.name.toLowerCase(),
      );
      if (match === undefined) continue;

      const value = filter[match];
      if (value === null || value === "") {
        selectedAfter.set(entry.key, new Set());
        // Clearing a level cascades to every finer one (same as setValue's prune).
        const idx = af.entries().indexOf(entry);
        for (let i = idx + 1; i < af.entries().length; i++) {
          selectedAfter.set(af.entries()[i].key, new Set());
        }
        continue;
      }

      const opts = af.optionsFor(entry, selectedAfter);
      const resolved =
        opts.find((o) => o.code === value) ??
        opts.find((o) => o.label.toLowerCase() === value.toLowerCase());
      if (!resolved) {
        console.warn(
          `filter: value "${value}" not found for level "${entry.name}" (skipped)`,
        );
        continue;
      }
      selectedAfter.set(entry.key, new Set([resolved.code]));
    }

    // One commit, one fly-to, both computed from the true end state.
    af.applySelections(selectedAfter, { fly: true });

    for (const level of Object.keys(filter)) {
      if (!af.entries().some((e) => e.name.toLowerCase() === level.toLowerCase())) {
        console.warn(`filter: unknown level "${level}" (skipped)`);
      }
    }

    // When this message leaves NO level selected (the last filter was cleared),
    // fly back to the configured default view. flyToSelection is a no-op with an
    // empty selection, so without this the camera would stay zoomed in on the
    // area just cleared. applyView sets the view directly, winning over the
    // no-op fly-to above. (Host-driven only — dropdown clears elsewhere keep
    // their stay-put behavior.)
    const anySelected = [...selectedAfter.values()].some((s) => s.size > 0);
    if (!anySelected) {
      options.applyView({
        center: [options.initialViewState.longitude, options.initialViewState.latitude],
        zoom: options.initialViewState.zoom,
      });
    }
  }

  // Flush a filter message that arrived before the gebiedsfilter options loaded
  // (see the queue above). Runs when entries become available.
  createEffect(() => {
    if (options.areaFilter.entries().length === 0 || !pendingFilter) return;
    const pending = pendingFilter;
    pendingFilter = null;
    setFilterFromHost(pending);
  });

  return setFilterFromHost;
}
