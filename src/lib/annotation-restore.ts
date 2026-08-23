import { loadLayerConfigs, getLayerConfigById } from "@/layers";
import type { UseMapLayersResult } from "@/hooks/use-map-layers";
import { flyToView } from "@/lib/fly-to";
import { selectionsFromJson, type AnnotationSnapshot } from "@/types/annotation";

export interface RestoreSide {
  layers: UseMapLayersResult;
}

export interface RestoreDeps {
  /** Apply a full gebiedsfilter selection map (useAreaFilter.applySelections). */
  applySelections(next: Map<string, Set<string>>): void;
  /**
   * The two sides. Layer adds await full data loads, so the sides' state moves
   * under this async function — but every member of `layers` is an accessor, so
   * reading one mid-run always yields the current value. (The React version
   * passed `getSideA()`/`getSideB()` thunks to achieve the same thing.)
   */
  sideA: RestoreSide;
  sideB: RestoreSide;
}

/**
 * Restore an annotation's snapshot: gebiedsfilter selections, both maps'
 * layer sets + hidden ids, and the camera. Mirrors the ordering of the
 * share-URL command pipeline (use-url-commands.processCommands): camera and
 * filters apply immediately; layers are added sequentially (each add awaits
 * its data load); hidden ids are reconciled only after the adds resolve —
 * hiding a layer before its first data batch lands would leave it visible.
 *
 * `isCancelled` aborts a stale run when the user clicks another annotation
 * mid-restore (the caller bumps a token per restore).
 */
export async function restoreSnapshot(
  snapshot: AnnotationSnapshot,
  deps: RestoreDeps,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  deps.applySelections(selectionsFromJson(snapshot.areaFilterSelections));
  flyToView([snapshot.view.longitude, snapshot.view.latitude], snapshot.view.zoom);

  const configs = await loadLayerConfigs();
  if (isCancelled()) return;

  const sides: Array<{
    target: AnnotationSnapshot["mapA"];
    side: RestoreSide;
  }> = [
    { target: snapshot.mapA, side: deps.sideA },
    { target: snapshot.mapB, side: deps.sideB },
  ];

  for (const { target, side } of sides) {
    // Snapshots can reference layers since removed from layers.json (or from
    // another instance's config) — skip those, keep the rest of the restore.
    const targetIds = target.layerIds.filter((id) => {
      if (getLayerConfigById(configs, id)) return true;
      console.warn(`Annotation snapshot: layer "${id}" not found in layers.json`);
      return false;
    });
    const targetSet = new Set(targetIds);

    for (const entry of side.layers.layerEntries()) {
      if (!targetSet.has(entry.config.id)) {
        side.layers.removeLayer(entry.config.id);
      }
    }

    const currentIds = new Set(side.layers.layerEntries().map((e) => e.config.id));
    for (const id of targetIds) {
      if (currentIds.has(id)) continue;
      const config = getLayerConfigById(configs, id);
      // atEnd: `layerIds` is a stored draw order, so append verbatim rather than
      // re-seeding by band (which would undo a dragged order on restore).
      if (config) await side.layers.addLayer(config, { atEnd: true });
      if (isCancelled()) return;
    }

    // Hidden reconciliation, against the post-add state.
    const hiddenTarget = new Set(target.hiddenIds);
    for (const id of targetIds) {
      const shouldHide = hiddenTarget.has(id);
      const isHidden = side.layers.hiddenIds().has(id);
      if (shouldHide && !isHidden) side.layers.hideLayer(id);
      else if (!shouldHide && isHidden) side.layers.toggleLayer(id);
    }
  }
}
