import { useCallback, useEffect, useRef } from "react";
import type { ViewState } from "@/components/map/MapView";
import type { AreaFilterState } from "./use-area-filter";
import type { ViewUpdate } from "./use-url-commands";

/**
 * The gebiedsfilter half of the embedding-host bridge (Power BI visual): turns
 * a host `filter` message into one committed area-filter selection.
 *
 * Owns the two refs that make that possible — a queue for messages arriving
 * before the filter options have loaded, and the last committed selection used
 * to chain two messages within a single tick. They live here, next to the only
 * code that reads them.
 */
export interface UseHostFilterOptions {
  /** App's live mirror of the area filter; also read by annotation restore. */
  areaFilterRef: React.RefObject<AreaFilterState>;
  /** Rendered values, watched to flush the queue and retire the chaining ref. */
  areaFilter: AreaFilterState;
  applyView: (view: ViewUpdate) => void;
  initialViewState: ViewState;
}

export function useHostFilter({
  areaFilterRef,
  areaFilter,
  applyView,
  initialViewState,
}: UseHostFilterOptions): (filter: Record<string, string | null>) => void {
  // A host `filter` message that arrives before the gebiedsfilter options have
  // finished loading (entries still empty) is stashed here and flushed once the
  // options are ready — see the effect below.
  const pendingFilterRef = useRef<Record<string, string | null> | null>(null);
  // The selection the last host `filter` message committed, used to chain two
  // messages that arrive in the same tick. Cleared once React state catches up,
  // so any change from elsewhere (dropdowns, snapshot restore) is picked up
  // normally rather than being masked by a stale value.
  const lastHostSelectionRef = useRef<Map<string, Set<string>> | null>(null);

  // Set the gebiedsfilter by level name → CBS code or display label. Resolves
  // against the loaded filter options and builds the end state coarse→fine,
  // then commits it in ONE applySelections call (cascade pruning + fly-to
  // included). Unknown levels/values are warned and skipped.
  //
  // The single commit is load-bearing, not a tidy-up: setValue rebuilds from the
  // hook's `selections` render closure, so calling it once per level in this
  // synchronous pass made every call discard the previous one's result. Last
  // write won — which is why unpicking Buurt then re-sending {Gemeente, Wijk}
  // re-flew to the still-present Buurt instead of zooming out to Wijk.
  const setFilterFromHost = useCallback(
    (filter: Record<string, string | null>) => {
      const af = areaFilterRef.current;
      if (af.entries.length === 0) {
        // Options not loaded yet (they resolve async after mount, and in embed
        // mode the map-ready handshake fires immediately). Queue this message and
        // flush it once entries are ready, so a filter sent right after open is
        // not silently dropped.
        pendingFilterRef.current = filter;
        return;
      }
      // Build the post-message selection locally, starting from the current one:
      // levels this message doesn't name keep their value (partial merge).
      //
      // Seed from the last commit we made rather than `af.selections` when one
      // exists: React state doesn't update until a re-render, so two host messages
      // arriving in the same tick (the two-message unpick — an explicit clear
      // followed by the new state) would both read the pre-clear selection and the
      // second would resurrect what the first cleared.
      const selectedAfter = new Map(lastHostSelectionRef.current ?? af.selections);

      // Apply coarse→fine (filter.json/entries order) so each level's options are
      // narrowed by the ancestors already resolved in this same pass — hence
      // resolving against `selectedAfter` rather than the committed selections,
      // which don't change until the single commit below.
      for (const entry of af.entries) {
        const match = Object.keys(filter).find(
          (level) => level.toLowerCase() === entry.name.toLowerCase(),
        );
        if (match === undefined) continue;

        const value = filter[match];
        if (value === null || value === "") {
          selectedAfter.set(entry.key, new Set());
          // Clearing a level cascades to every finer one (same as setValue's prune).
          const idx = af.entries.indexOf(entry);
          for (let i = idx + 1; i < af.entries.length; i++) {
            selectedAfter.set(af.entries[i].key, new Set());
          }
          continue;
        }

        const options = af.optionsFor(entry, selectedAfter);
        const resolved =
          options.find((o) => o.code === value) ??
          options.find((o) => o.label.toLowerCase() === value.toLowerCase());
        if (!resolved) {
          console.warn(
            `filter: value "${value}" not found for level "${entry.name}" (skipped)`,
          );
          continue;
        }
        selectedAfter.set(entry.key, new Set([resolved.code]));
      }

      // One commit, one fly-to, both computed from the true end state.
      lastHostSelectionRef.current = selectedAfter;
      af.applySelections(selectedAfter, { fly: true });

      for (const level of Object.keys(filter)) {
        if (!af.entries.some((e) => e.name.toLowerCase() === level.toLowerCase())) {
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
        applyView({
          center: [initialViewState.longitude, initialViewState.latitude],
          zoom: initialViewState.zoom,
        });
      }
    },
    [areaFilterRef, applyView, initialViewState],
  );

  // Flush a filter message that arrived before the gebiedsfilter options loaded
  // (see the queue above). Runs when entries become available.
  useEffect(() => {
    if (areaFilter.entries.length === 0 || !pendingFilterRef.current) return;
    const pending = pendingFilterRef.current;
    pendingFilterRef.current = null;
    setFilterFromHost(pending);
  }, [areaFilter.entries, setFilterFromHost]);

  // Once React state reflects the last host commit, drop the chaining ref: from
  // here on `areaFilter.selections` is authoritative again, so a dropdown change
  // or snapshot restore isn't masked by a stale host value.
  useEffect(() => {
    if (lastHostSelectionRef.current === null) return;
    if (lastHostSelectionRef.current === areaFilter.selections) {
      lastHostSelectionRef.current = null;
    }
  }, [areaFilter.selections]);

  return setFilterFromHost;
}
