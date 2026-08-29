/**
 * The tool names, alone in this module on purpose.
 *
 * `map-config` validates the configured tool list, and the tools themselves
 * read `map-config` for the search-country restriction. Importing the names
 * from `map-tools` would close that loop into an import cycle — one that would
 * happen to work today (every read is inside a function, not at module init)
 * and break the first time either side gains a top-level constant. Splitting
 * the names out keeps the dependency one-way.
 */
export const TOOL_NAMES = [
  "zoom_to_location",
  "open_layer",
  "close_layer",
  "search_layers",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Whether a string names one of the tools. */
export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}
