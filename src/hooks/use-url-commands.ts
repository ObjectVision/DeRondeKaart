import { useEffect, useCallback, useRef } from "react";
import { loadLayerConfigs, getLayerConfigById } from "@/layers";
import type { LayerConfig } from "@/layers";
import type { MapRef } from "react-map-gl/maplibre";
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

export function useUrlCommands({ mapLeft, mapRight, ready, applyView, onAnnotationRoom }: UseUrlCommandsOptions) {
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
    function handleMessage(event: MessageEvent) {
      if (!event.data || typeof event.data !== "object") return;
      if (event.data.type !== "map-command") return;

      const { commands, view } = event.data as {
        type: string;
        commands?: LayerCommand[];
        view?: ViewUpdate;
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
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [processCommands, applyView]);
}
