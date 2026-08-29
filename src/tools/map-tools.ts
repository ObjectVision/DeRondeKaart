import { loadLayerConfigs } from "@/layers";
import type { LayerConfig } from "@/layers";
import type { MapSide, MapSideId } from "@/lib/map-side";
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
        // Optional on purpose: an extra REQUIRED argument would have the model
        // invent a side for every command. Omitted means the left map, which is
        // what every command meant before this existed.
        kaart: { type: "string", description: "links of rechts; standaard links" },
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
        kaart: { type: "string", description: "links of rechts; standaard links" },
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

/**
 * Which map a command names.
 *
 * Forgiving by design: the model echoes whatever the user said, so this sees
 * "rechts", "rechterkaart", "de rechter kaart" and "op rechts" for one meaning.
 * Anything unrecognised — including a missing value — is the left map, so a
 * garbled side can never send a layer somewhere the user did not ask for.
 */
export function resolveSide(spoken: unknown): MapSideId {
  return typeof spoken === "string" && /recht/i.test(spoken) ? "right" : "left";
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
  /** The map a command acts on unless it names another — always the left map. */
  side: MapSide;
  /**
   * The right map. Optional so the tool layer stays usable on its own; when it
   * is absent a command naming the right map is refused rather than silently
   * acting on the left.
   */
  right?: MapSide;
  /**
   * Pair-aware close.
   *
   * Injected rather than called directly because a paired layer spans both maps
   * and closing one half must close the other — the rule `removeFromSide` in
   * App.tsx implements and every legend close button already routes through.
   * Without it `close_layer` strands the partner on the other map.
   */
  removeLayer?: (layerId: string, side: MapSideId) => void;
  /**
   * Whether the left map holds any layer. Comparison is left-anchored, so the
   * right map may not receive a layer while the left is empty. `toggleOnMap`
   * does not enforce this itself — the guard lives in the navigation UI — so a
   * command targeting the right map has to check it here.
   */
  leftHasLayers?: () => boolean;
}

/**
 * The map a resolved side refers to, or undefined when this project has no
 * right map. The left map always exists.
 */
function sideFor(ctx: ToolContext, side: MapSideId): MapSide | undefined {
  return side === "right" ? ctx.right : ctx.side;
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
      const side = resolveSide(args.kaart);

      const target = sideFor(ctx, side);
      if (!target) {
        return { ok: false, message: "Er is geen rechterkaart om lagen op te tonen." };
      }
      // Comparison is left-anchored: a layer on the right with an empty left map
      // would leave the app in a state its own UI never allows.
      if (side === "right" && ctx.leftHasLayers && !ctx.leftHasLayers()) {
        return {
          ok: false,
          message: "Zet eerst een kaartlaag op de linkerkaart om te kunnen vergelijken.",
        };
      }

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
      await target.layers.addLayer(config);
      return { ok: true };
    }

    case "close_layer": {
      const spoken = typeof args.layer === "string" ? args.layer : "";
      const side = resolveSide(args.kaart);

      const target = sideFor(ctx, side);
      if (!target) {
        return { ok: false, message: "Er is geen rechterkaart." };
      }

      // Only what is actually on the map can be closed; matching against the
      // full catalogue would "close" a layer that was never open.
      const onMap = target.layers.layerEntries().map((e) => e.config);
      const config = resolveLayer(onMap, spoken);
      if (!config) {
        return { ok: false, message: `De kaartlaag "${spoken}" staat niet aan.` };
      }

      // Through the injected closer when there is one, so a paired layer takes
      // its partner with it. The direct call is the standalone fallback.
      if (ctx.removeLayer) ctx.removeLayer(config.id, side);
      else target.layers.removeLayer(config.id);
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
