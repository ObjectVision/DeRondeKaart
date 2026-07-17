import { loadLayerConfigs, getLayerConfigById } from "@/layers";
import type { useMapLayers } from "@/hooks/use-map-layers";
import { flyToView } from "@/lib/fly-to";
import { selectionsFromJson, type AnnotationSnapshot } from "@/types/annotation";
import type { MapRef } from "react-map-gl/maplibre";

export interface RestoreSide {
  layers: ReturnType<typeof useMapLayers>;
  mapRef: React.RefObject<MapRef | null>;
}

export interface RestoreDeps {
  /** Apply a full gebiedsfilter selection map (useAreaFilter.applySelections). */
  applySelections(next: Map<string, Set<string>>): void;
  /**
   * Live side accessors — layer adds await full loads, so the sides' state
   * moves under this async function; getters keep the reconciliation fresh.
   */
  getSideA(): RestoreSide;
  getSideB(): RestoreSide;
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
    getSide: () => RestoreSide;
  }> = [
    { target: snapshot.mapA, getSide: deps.getSideA },
    { target: snapshot.mapB, getSide: deps.getSideB },
  ];

  for (const { target, getSide } of sides) {
    // Snapshots can reference layers since removed from layers.json (or from
    // another instance's config) — skip those, keep the rest of the restore.
    const targetIds = target.layerIds.filter((id) => {
      if (getLayerConfigById(configs, id)) return true;
      console.warn(`Annotation snapshot: layer "${id}" not found in layers.json`);
      return false;
    });
    const targetSet = new Set(targetIds);

    const side = getSide();
    for (const entry of side.layers.layerEntries) {
      if (!targetSet.has(entry.config.id)) {
        side.layers.removeLayer(entry.config.id, side.mapRef);
      }
    }

    const currentIds = new Set(side.layers.layerEntries.map((e) => e.config.id));
    for (const id of targetIds) {
      if (currentIds.has(id)) continue;
      const config = getLayerConfigById(configs, id);
      if (config) await getSide().layers.addLayer(config, getSide().mapRef);
      if (isCancelled()) return;
    }

    // Hidden reconciliation, against the post-add state.
    const fresh = getSide();
    const hiddenTarget = new Set(target.hiddenIds);
    for (const id of targetIds) {
      const shouldHide = hiddenTarget.has(id);
      const isHidden = fresh.layers.hiddenIds.has(id);
      if (shouldHide && !isHidden) fresh.layers.hideLayer(id, fresh.mapRef);
      else if (!shouldHide && isHidden) fresh.layers.toggleLayer(id, fresh.mapRef);
    }
  }
}
