import { enabledTools } from "@/config/map-config";
import { TOOL_SCHEMAS, isToolName, runTool, type ToolContext, type ToolResult } from "@/tools/map-tools";

/**
 * Turning a line of Dutch into a map tool call.
 *
 * **Nothing here is imported statically by the app.** Reached only through
 * `await import("@/ai/command-engine")`, which is what keeps the model glue off
 * the entry bundle — the same rule `dashboard/duckdb-engine.ts` states for
 * DuckDB, where only the absence of a static import keeps the chunk separate.
 */

/** One parsed call, as the model returns it. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** What a Needle-shaped engine must provide. */
export interface Parser {
  parse: (text: string) => Promise<ToolCall[]>;
}

/**
 * Route one command.
 *
 * The rules, in order, and each is deliberate:
 *
 * 1. No parser yet (still downloading, disabled, or it threw) → treat the text
 *    as a place name. That is exactly what this bar did before, so the feature
 *    can only ever add capability, never take away the search that works.
 * 2. Exactly one call → run it.
 * 3. Several calls → run the first, log the rest. Two map actions from one
 *    sentence is beyond what a 45M model reliably grounds.
 * 4. No call at all → the model refused. Fall back to a location search, which
 *    makes an over-eager refusal harmless.
 *
 * **`confidence` is deliberately not consulted.** Measured on the real model:
 * a correct Dutch call scored 0.000 and an incorrect one 0.42. Cactus's own
 * fine-tuning doc says the head is calibrated for the base model's training mix,
 * is not updated by fine-tuning (tuned weights report `None`), and that "correct
 * Spanish calls have been measured at confidence 0.0". A threshold would reject
 * good commands, so all four tools — each trivially reversible — simply run.
 */
export async function runCommand(
  text: string,
  ctx: ToolContext,
  parser: Parser | null,
): Promise<ToolResult> {
  const query = text.trim();
  if (!query) return { ok: false };

  if (!parser) return runTool("zoom_to_location", { location: query }, ctx);

  let calls: ToolCall[];
  try {
    calls = await parser.parse(query);
  } catch (err) {
    console.warn("Command parsing failed; treating the text as a location:", err);
    return runTool("zoom_to_location", { location: query }, ctx);
  }

  const allowed = new Set(enabledTools());
  const usable = calls.filter((c) => isToolName(c.name) && allowed.has(c.name));

  if (usable.length === 0) {
    return runTool("zoom_to_location", { location: query }, ctx);
  }
  if (usable.length > 1) {
    console.info(
      `Command produced ${usable.length} calls; running the first:`,
      usable.map((c) => c.name),
    );
  }

  const call = usable[0];
  // Narrowed by the filter above; `isToolName` is the guard.
  return runTool(call.name as never, call.arguments ?? {}, ctx);
}

/** The schemas for the tools this project enables, as Needle consumes them. */
export function activeToolSchemas() {
  return enabledTools().map((name) => TOOL_SCHEMAS[name]);
}
