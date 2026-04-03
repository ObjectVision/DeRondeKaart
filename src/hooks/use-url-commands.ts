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

function parseCommands(search: string): LayerCommand[] {
  const params = new URLSearchParams(search);
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

        if (!config && command.cmd !== "refresh") {
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

  // Process URL params once the map is ready
  useEffect(() => {
    if (!ready) return;

    function handleUrl() {
      const search = window.location.search;
      if (!search) return;

      const commands = parseCommands(search);
      if (commands.length > 0) {
        processCommands(commands);
        // Clear the URL params after processing (without reload)
        window.history.replaceState({}, "", window.location.pathname);
      }
    }

    // Initial processing
    handleUrl();

    // Listen for popstate (back/forward navigation)
    window.addEventListener("popstate", handleUrl);

    return () => {
      window.removeEventListener("popstate", handleUrl);
    };
  }, [ready, processCommands]);

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
