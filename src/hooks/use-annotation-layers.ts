import { useMemo } from "react";
import type { Layer } from "@deck.gl/core";
import { IconLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { hexToRgba } from "@/lib/collab-identity";
import type { Annotation, CollabPresence } from "@/types/annotation";
import type { AnnotationDraft } from "@/hooks/use-annotation-tool";

const FONT_FAMILY = "'Geist Variable', system-ui, sans-serif";
const CURSOR_ICON = {
  url: "/cursor-arrow.svg",
  width: 24,
  height: 24,
  // Anchor at the arrow tip so the icon points at the peer's exact position.
  anchorX: 5,
  anchorY: 3,
  mask: true,
} as const;

export interface AnnotationLayersOptions {
  annotations: Annotation[];
  /** In-progress circle while drawing (from the annotation tool). */
  draft: AnnotationDraft | null;
  /** Locally selected annotation — rendered with an emphasized ring. */
  selectedId: string | null;
  /** Remote participants (live cursors + their selection highlights). */
  peers: CollabPresence[];
  /** Local identity color (tints the draft circle). */
  identityColor: string;
  /** False hides everything (annotation mode off). */
  visible: boolean;
  /** "a" | "b" — layer ids must differ per map (two Deck overlays). */
  suffix: string;
}

/**
 * Deck.gl layers for the annotation tool, loaded through the `topLayers`
 * channel (pinned above data + labels), mirroring useSelectionBoxLayers.
 * Call once per map — Layer instances must not be shared across two Deck
 * overlays. Both maps share the viewState, so peer cursors and circles are
 * geographically consistent on A and B.
 */
export function useAnnotationLayers({
  annotations,
  draft,
  selectedId,
  peers,
  identityColor,
  visible,
  suffix,
}: AnnotationLayersOptions): Layer[] {
  // Annotations highlighted for anyone: the local selection plus every peer's
  // broadcast selection (shows collaborators what others are looking at).
  const activeIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedId) ids.add(selectedId);
    for (const peer of peers) {
      if (peer.activeAnnotationId) ids.add(peer.activeAnnotationId);
    }
    return ids;
  }, [selectedId, peers]);

  return useMemo(() => {
    if (!visible) return [];
    const activeKey = [...activeIds].sort().join(",");
    const layers: Layer[] = [
      new ScatterplotLayer<Annotation>({
        id: `annotations-circles-${suffix}`,
        data: annotations,
        pickable: true,
        stroked: true,
        filled: true,
        radiusUnits: "meters",
        getPosition: (d) => [d.center.lng, d.center.lat],
        getRadius: (d) => d.radiusM,
        getFillColor: (d) => hexToRgba(d.color, 30),
        getLineColor: (d) => hexToRgba(d.color, activeIds.has(d.id) ? 255 : 200),
        getLineWidth: (d) => (activeIds.has(d.id) ? 3.5 : 2),
        lineWidthUnits: "pixels",
        updateTriggers: {
          getLineColor: activeKey,
          getLineWidth: activeKey,
        },
      }),
      new TextLayer<Annotation>({
        id: `annotations-labels-${suffix}`,
        data: annotations.filter((d) => d.title),
        pickable: false,
        getPosition: (d) => [d.center.lng, d.center.lat],
        getText: (d) => d.title,
        getSize: 13,
        sizeUnits: "pixels",
        fontFamily: FONT_FAMILY,
        characterSet: "auto",
        getColor: [40, 40, 40, 255],
        background: true,
        getBackgroundColor: [255, 255, 255, 220],
        backgroundPadding: [6, 3, 6, 3],
        getPixelOffset: [0, -14],
        billboard: true,
      }),
    ];

    if (draft) {
      layers.push(
        new ScatterplotLayer<AnnotationDraft>({
          id: `annotations-draft-${suffix}`,
          data: [draft],
          pickable: false,
          stroked: true,
          filled: true,
          radiusUnits: "meters",
          getPosition: (d) => [d.center.lng, d.center.lat],
          getRadius: (d) => d.radiusM,
          getFillColor: hexToRgba(identityColor, 15),
          getLineColor: hexToRgba(identityColor, 180),
          getLineWidth: 2,
          lineWidthUnits: "pixels",
        }),
      );
    }

    const cursors = peers.filter(
      (p): p is CollabPresence & { cursor: { lng: number; lat: number } } =>
        p.cursor !== null,
    );
    if (cursors.length > 0) {
      layers.push(
        new IconLayer<(typeof cursors)[number]>({
          id: `annotations-cursors-${suffix}`,
          data: cursors,
          pickable: false,
          getPosition: (d) => [d.cursor.lng, d.cursor.lat],
          getIcon: () => ({ id: "cursor-arrow", ...CURSOR_ICON }),
          getSize: 20,
          sizeUnits: "pixels",
          getColor: (d) => hexToRgba(d.user.color, 255),
          billboard: true,
        }),
        new TextLayer<(typeof cursors)[number]>({
          id: `annotations-cursor-names-${suffix}`,
          data: cursors,
          pickable: false,
          getPosition: (d) => [d.cursor.lng, d.cursor.lat],
          getText: (d) => d.user.name,
          getSize: 11,
          sizeUnits: "pixels",
          fontFamily: FONT_FAMILY,
          characterSet: "auto",
          getColor: [255, 255, 255, 255],
          background: true,
          getBackgroundColor: (d) => hexToRgba(d.user.color, 230),
          backgroundPadding: [5, 2, 5, 2],
          getPixelOffset: [14, 18],
          getTextAnchor: "start",
          billboard: true,
        }),
      );
    }

    return layers;
  }, [visible, annotations, draft, activeIds, peers, identityColor, suffix]);
}
