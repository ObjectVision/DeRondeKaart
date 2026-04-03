import { useEffect, useCallback, useRef } from "react";
import { loadLayerConfigs, getLayerConfigById } from "@/layers";
import type { LayerConfig } from "@/layers";
import type { MapRef } from "react-map-gl/maplibre";
import type { useMapLayers } from "./use-map-layers";

interface MapSide {
  layers: ReturnType<typeof useMapLayers>;
  mapRef: React.RefObject<{ mapRef: React.RefObject<MapRef | null> } | null>;
}

interface UseUrlCommandsOptions {
  mapA: MapSide;
  mapB: MapSide;
  ready: boolean;
}

interface LayerCommand {
  cmd: "add" | "remove" | "hide" | "refresh";
  map?: "a" | "b";
  layer?: string;
}

function parseCommands(paramString: string): LayerCommand[] {
  const params = new URLSearchParams(paramString);
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

export function useUrlCommands({ mapA, mapB, ready }: UseUrlCommandsOptions) {
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

        const side = command.map === "b" ? mapB : mapA;
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
    [getConfigs, mapA, mapB],
  );

  const processHash = useCallback(() => {
    const hash = window.location.hash.slice(1); // remove leading #
    if (!hash) return;

    const commands = parseCommands(hash);
    if (commands.length > 0) {
      processCommands(commands);
      // Clear the hash after processing (without reload or hashchange event)
      window.history.replaceState({}, "", window.location.pathname + window.location.search);
    }
  }, [processCommands]);

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

      const { commands } = event.data as { type: string; commands: LayerCommand[] };
      if (Array.isArray(commands)) {
        processCommands(commands);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [processCommands]);
}
