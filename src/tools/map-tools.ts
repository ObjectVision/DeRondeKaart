import { loadLayerConfigs } from "@/layers";
import type { LayerConfig } from "@/layers";
import type { MapSide } from "@/lib/map-side";
import { zoomToLocation } from "@/tools/zoom-to-location";
import type { ToolName } from "@/tools/tool-names";

/**
 * The map's callable tools.
 *
 * One definition serves three consumers: the JSON Schema is what Needle reads
 * to choose a call, what the fine-tuning JSONL declares, and what the command
 * bar validates against. Keeping them in one place is what stops the three
 * drifting apart.
 *
 * **The descriptions are in Dutch on purpose, and that is load-bearing.**
 * Measured against the real model with these four tools: English descriptions
 * scored 4/6 on Dutch commands with two outright wrong calls; the same tools
 * described in Dutch scored 11/12. The model reads these strings to decide, so
 * they are part of the model's accuracy, not documentation.
 */
export { TOOL_NAMES, isToolName, type ToolName } from "@/tools/tool-names";

/** JSON Schema for one tool, exactly as Needle consumes it. */
export interface ToolSchema {
  name: ToolName;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const TOOL_SCHEMAS: Readonly<Record<ToolName, ToolSchema>> = {
  zoom_to_location: {
    name: "zoom_to_location",
    description: "Zoom de kaart naar een plaats: gemeente, stad, dorp, wijk, buurt of straat.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "naam van de plaats" },
      },
      required: ["location"],
    },
  },
  open_layer: {
    name: "open_layer",
    description: "Toon een kaartlaag op de kaart: aanzetten, tonen, weergeven, laten zien.",
    parameters: {
      type: "object",
      properties: {
        layer: { type: "string", description: "naam van de kaartlaag" },
      },
      required: ["layer"],
    },
  },
  close_layer: {
    name: "close_layer",
    description:
      "Verberg een kaartlaag die nu zichtbaar is: uitzetten, verbergen, weghalen, verwijderen.",
    parameters: {
      type: "object",
      properties: {
        layer: { type: "string", description: "naam van de kaartlaag" },
      },
      required: ["layer"],
    },
  },
  search_layers: {
    name: "search_layers",
    description: "Zoek beschikbare kaartlagen op een trefwoord.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "trefwoord om op te zoeken" },
      },
      required: ["query"],
    },
  },
};

/**
 * Resolve a spoken/typed layer name to a config.
 *
 * Deliberately fuzzy: the name arrives as free text ("woonzorg", "de zorglaag"),
 * never as an id. Exact id first, then exact name, then a case-insensitive
 * substring — the first rule that matches wins, so a precise id is never
 * overridden by a loose name match.
 */
export function resolveLayer(
  configs: LayerConfig[],
  spoken: string,
): LayerConfig | undefined {
  const needle = spoken.trim().toLowerCase();
  if (!needle) return undefined;

  const byId = configs.find((c) => c.id.toLowerCase() === needle);
  if (byId) return byId;

  const byName = configs.find((c) => (c.name ?? "").toLowerCase() === needle);
  if (byName) return byName;

  return configs.find((c) => (c.name ?? "").toLowerCase().includes(needle));
}

/** Layers whose name matches a keyword, for `search_layers`. */
export function searchLayerConfigs(
  configs: LayerConfig[],
  query: string,
): LayerConfig[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return configs.filter((c) => (c.name ?? "").toLowerCase().includes(needle));
}

/** What running a tool did, so the caller can tell the user. */
export interface ToolResult {
  ok: boolean;
  /** Dutch, shown to the user when something could not be done. */
  message?: string;
  /** `search_layers` matches, for the caller to surface. */
  matches?: LayerConfig[];
}

export interface ToolContext {
  /** The map the command acts on — the left map, which is always present. */
  side: MapSide;
}

/**
 * Run one resolved tool call.
 *
 * Every failure is a `ToolResult` rather than a throw: this is driven by a
 * small model parsing free text, so "no such layer" is an ordinary outcome the
 * UI must explain, not an exception.
 */
export async function runTool(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case "zoom_to_location": {
      const location = typeof args.location === "string" ? args.location : "";
      if (!location.trim()) return { ok: false, message: "Geen plaatsnaam herkend." };
      const found = await zoomToLocation(location);
      return found
        ? { ok: true }
        : { ok: false, message: `Geen locatie gevonden voor "${location}".` };
    }

    case "open_layer": {
      const spoken = typeof args.layer === "string" ? args.layer : "";
      const configs = await loadLayerConfigs();
      const config = resolveLayer(configs, spoken);
      if (!config) {
        // No match is not a dead end: hand back what the keyword does find, so
        // the caller can offer those instead of silently doing nothing.
        return {
          ok: false,
          message: `Geen kaartlaag gevonden voor "${spoken}".`,
          matches: searchLayerConfigs(configs, spoken),
        };
      }
      await ctx.side.layers.addLayer(config);
      return { ok: true };
    }

    case "close_layer": {
      const spoken = typeof args.layer === "string" ? args.layer : "";
      // Only what is actually on the map can be closed; matching against the
      // full catalogue would "close" a layer that was never open.
      const onMap = ctx.side.layers.layerEntries().map((e) => e.config);
      const config = resolveLayer(onMap, spoken);
      if (!config) {
        return { ok: false, message: `De kaartlaag "${spoken}" staat niet aan.` };
      }
      ctx.side.layers.removeLayer(config.id);
      return { ok: true };
    }

    case "search_layers": {
      const query = typeof args.query === "string" ? args.query : "";
      const matches = searchLayerConfigs(await loadLayerConfigs(), query);
      return matches.length > 0
        ? { ok: true, matches }
        : { ok: false, message: `Geen kaartlagen gevonden voor "${query}".`, matches: [] };
    }
  }
}
