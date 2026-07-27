import { useEffect, useCallback, useRef } from "react";
import { loadLayerConfigs, getLayerConfigById } from "@/layers";
import type { LayerConfig } from "@/layers";
import type { MapRef } from "react-map-gl/maplibre";
import { isUrlAddressable } from "@/lib/share-url";
import type { useMapLayers } from "./use-map-layers";

interface MapSide {
  layers: ReturnType<typeof useMapLayers>;
  mapRef: React.RefObject<{ mapRef: React.RefObject<MapRef | null> } | null>;
}

export interface ViewUpdate {
  zoom?: number;
  center?: [number, number]; // [longitude, latitude]
  /**
   * Frame this extent instead of an explicit center/zoom ([minLng, minLat,
   * maxLng, maxLat]); resolved via the shared viewForBbox heuristic. Sent by
   * the Power BI visual for auto-zoom-to-data.
   */
  bbox?: [number, number, number, number];
}

interface UseUrlCommandsOptions {
  mapLeft: MapSide;
  mapRight: MapSide;
  ready: boolean;
  applyView: (view: ViewUpdate) => void;
  /** A share link carried an `annot` room id — join that collab session. */
  onAnnotationRoom?: (roomId: string) => void;
  /**
   * An `open-circular` message asked to show the circular-only view. The
   * layers/view/filter have already been reconciled by the time this fires; the
   * host carries title/subtitle straight into the view.
   */
  onOpenCircular?: (opts: { title?: string; subtitle?: string }) => void;
  /**
   * A message carried a `filter` object: set the gebiedsfilter. Keyed by filter
   * level (filter.json `name`, case-insensitive), valued by CBS code or display
   * label (null/"" clears the level). Awaited so the selection + fly-to settle
   * before an `open-circular` snapshots the preview.
   */
  onSetFilter?: (filter: Record<string, string | null>) => void | Promise<void>;
}

/** Room ids are UUIDv4 — anything else is rejected (also server-side). */
const ANNOT_ROOM_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LayerCommand {
  cmd: "add" | "remove" | "hide" | "refresh";
  map?: "a" | "b";
  layer?: string;
}

function parseView(params: URLSearchParams): ViewUpdate {
  const out: ViewUpdate = {};

  const zoomRaw = params.get("zoom");
  if (zoomRaw !== null) {
    const z = Number(zoomRaw);
    if (Number.isFinite(z)) out.zoom = Math.max(0, Math.min(22, z));
    else console.warn(`Invalid zoom value: "${zoomRaw}"`);
  }

  const centerRaw = params.get("center");
  if (centerRaw !== null) {
    const parts = centerRaw.split(",");
    if (parts.length === 2) {
      const lng = Number(parts[0]);
      const lat = Number(parts[1]);
      if (
        Number.isFinite(lng) &&
        Number.isFinite(lat) &&
        lng >= -180 &&
        lng <= 180 &&
        lat >= -85.05112878 &&
        lat <= 85.05112878
      ) {
        out.center = [lng, lat];
      } else {
        console.warn(`Invalid center value: "${centerRaw}"`);
      }
    } else {
      console.warn(`center must be "lng,lat", got: "${centerRaw}"`);
    }
  }

  return out;
}

function parseCommands(params: URLSearchParams): LayerCommand[] {
  const commands: LayerCommand[] = [];

  const cmdValues = params.getAll("cmd");
  const mapValues = params.getAll("map");
  const layerValues = params.getAll("layer");

  for (let i = 0; i < cmdValues.length; i++) {
    const cmd = cmdValues[i] as LayerCommand["cmd"];
    if (cmd === "refresh") {
      commands.push({ cmd });
      continue;
    }

    const map = (mapValues[i] ?? "a").toLowerCase() as "a" | "b";
    const layer = layerValues[i];

    if (layer && ["add", "remove", "hide"].includes(cmd)) {
      commands.push({ cmd, map, layer });
    }
  }

  return commands;
}

export function useUrlCommands({ mapLeft, mapRight, ready, applyView, onAnnotationRoom, onOpenCircular, onSetFilter }: UseUrlCommandsOptions) {
  const configsRef = useRef<LayerConfig[] | null>(null);
  const processedInitialHash = useRef(false);

  const getConfigs = useCallback(async () => {
    if (!configsRef.current) {
      configsRef.current = await loadLayerConfigs();
    }
    return configsRef.current;
  }, []);

  const processCommands = useCallback(
    async (commands: LayerCommand[]) => {
      const configs = await getConfigs();

      for (const command of commands) {
        if (command.cmd === "refresh") {
          window.location.reload();
          return;
        }

        const side = command.map === "b" ? mapRight : mapLeft;
        const config = command.layer
          ? getLayerConfigById(configs, command.layer)
          : undefined;

        if (!config) {
          console.warn(`Layer "${command.layer}" not found in layers.json`);
          continue;
        }

        const ref = side.mapRef.current?.mapRef ?? { current: null };

        switch (command.cmd) {
          case "add":
            if (config) await side.layers.addLayer(config, ref);
            break;
          case "remove":
            if (command.layer) side.layers.removeLayer(command.layer, ref);
            break;
          case "hide":
            if (command.layer) side.layers.hideLayer(command.layer, ref);
            break;
        }
      }
    },
    [getConfigs, mapLeft, mapRight],
  );

  // Reconcile the LEFT map to exactly `layerIds`: add the missing ones, remove
  // the extra url-addressable ones. In-memory embed datasets (Power BI
  // `map-data`) are non-url-addressable and left untouched, so a host that
  // pushed its own data doesn't get it clobbered by an open-circular request.
  const reconcileLeftLayers = useCallback(
    async (layerIds: string[]) => {
      const configs = await getConfigs();
      const ref = mapLeft.mapRef.current?.mapRef ?? { current: null };

      const desired = new Set<string>();
      for (const id of layerIds) {
        if (getLayerConfigById(configs, id)) desired.add(id);
        else console.warn(`open-circular: layer "${id}" not found in layers.json`);
      }

      const present = new Set(mapLeft.layers.layerEntries.map((e) => e.config.id));

      // Remove extras (only url-addressable ones — never host-pushed data).
      for (const entry of mapLeft.layers.layerEntries) {
        if (!desired.has(entry.config.id) && isUrlAddressable(entry)) {
          mapLeft.layers.removeLayer(entry.config.id, ref);
        }
      }

      // Add the ones not already present.
      for (const id of desired) {
        if (present.has(id)) continue;
        const config = getLayerConfigById(configs, id);
        if (config) await mapLeft.layers.addLayer(config, ref);
      }
    },
    [getConfigs, mapLeft],
  );

  const processHash = useCallback(() => {
    const hash = window.location.hash.slice(1); // remove leading #
    if (!hash) return;

    const params = new URLSearchParams(hash);
    const commands = parseCommands(params);
    const view = parseView(params);
    const hasView = view.zoom !== undefined || view.center !== undefined;

    const annotRaw = params.get("annot");
    const annotRoom = annotRaw && ANNOT_ROOM_RE.test(annotRaw) ? annotRaw : null;
    if (annotRaw && !annotRoom) {
      console.warn(`Invalid annot room id: "${annotRaw}"`);
    }

    if (commands.length > 0 || hasView || annotRoom) {
      if (hasView) applyView(view);
      if (commands.length > 0) processCommands(commands);
      // The joined room lives on in state — the hash is still cleared below,
      // like every other processed command.
      if (annotRoom) onAnnotationRoom?.(annotRoom);
      // Clear the hash after processing (without reload or hashchange event)
      window.history.replaceState({}, "", window.location.pathname + window.location.search);
    }
  }, [processCommands, applyView, onAnnotationRoom]);

  // Process hash params on mount (once ready) and on hashchange
  useEffect(() => {
    if (!ready) return;

    // Process initial hash on first ready
    if (!processedInitialHash.current) {
      processedInitialHash.current = true;
      processHash();
    }

    // Listen for hash changes (iframe src changes, programmatic navigation)
    function handleHashChange() {
      processHash();
    }

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [ready, processHash]);

  // Listen for postMessage from parent iframe
  useEffect(() => {
    // A `filter` field is a plain object of level→(code|label|null). Any other
    // shape is ignored.
    async function applyFilter(filter: unknown) {
      if (filter && typeof filter === "object" && !Array.isArray(filter)) {
        await onSetFilter?.(filter as Record<string, string | null>);
      }
    }

    async function handleMessage(event: MessageEvent) {
      if (!event.data || typeof event.data !== "object") return;

      if (event.data.type === "map-command") {
        const { commands, view, filter } = event.data as {
          type: string;
          commands?: LayerCommand[];
          view?: ViewUpdate;
          filter?: unknown;
        };
        if (
          view &&
          (view.zoom !== undefined || view.center !== undefined || view.bbox !== undefined)
        ) {
          applyView(view);
        }
        if (Array.isArray(commands)) {
          processCommands(commands);
        }
        await applyFilter(filter);
        return;
      }

      // Host request to show the circular-only view with a given title,
      // subtitle, exact set of active layers, and gebiedsfilter. Reconcile
      // view + layers + filter FIRST, then hand title/subtitle to the view
      // (the preview snapshots at mount — see App.tsx circularView).
      if (event.data.type === "open-circular") {
        const { layers, view, title, subtitle, filter } = event.data as {
          type: string;
          layers?: string[];
          view?: ViewUpdate;
          title?: unknown;
          subtitle?: unknown;
          filter?: unknown;
        };
        if (
          view &&
          (view.zoom !== undefined || view.center !== undefined || view.bbox !== undefined)
        ) {
          applyView(view);
        }
        if (Array.isArray(layers)) {
          await reconcileLeftLayers(layers.filter((l): l is string => typeof l === "string"));
        }
        await applyFilter(filter);
        onOpenCircular?.({
          title: typeof title === "string" ? title : undefined,
          subtitle: typeof subtitle === "string" ? subtitle : undefined,
        });
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [processCommands, applyView, reconcileLeftLayers, onOpenCircular, onSetFilter]);
}
