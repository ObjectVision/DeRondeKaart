/**
 * postMessage bridge for the standalone dashboard, the counterpart of the map's
 * `map-data` / `map-command` bridges. An embedding host sends:
 *
 *   { type: "dashboard-set", selection?: { column, codes }, parameters?: {...} }
 *     → replaces the area selection and/or merges parameters, and the widgets
 *       re-query. No page reload: the host can drive the dashboard live.
 *   { type: "dashboard-reload", tables: { "<table>": "<parquet url>" } }
 *     → re-points semantic-model tables at other files, for when the data
 *       itself has to change rather than the filtering.
 *
 * Out: `{ type: "dashboard-ready", v: 1 }` once, when the first render is up,
 * and `{ type: "dashboard-state", v: 1, selection, parameters }` on every change
 * so the host can mirror the state it caused.
 *
 * Validation is shape-based with no origin allow-list, consistent with the two
 * existing bridges (see the protocol note in `src/hooks/use-embed-data.ts`).
 */
import { createEffect, onCleanup, onMount } from "solid-js";

import {
  mergeParameters,
  parameters,
  selection,
  setSelection,
  type DashboardSelection,
} from "@/dashboard/dashboard-state";

export interface DashboardBridgeOptions {
  /** True once the dashboard has rendered; gates the ready handshake. */
  ready: () => boolean;
  /** Called when table URLs change, so the caller can re-register and re-query. */
  onReloadTables?: (urls: Record<string, string>) => void;
}

/** Accept a selection only when both halves are the right shape. */
function parseSelection(raw: unknown): DashboardSelection | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object" || raw === undefined) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.column !== "string" || obj.column === "") return undefined;
  if (!Array.isArray(obj.codes)) return undefined;
  const codes = obj.codes.filter((code): code is string => typeof code === "string" && code !== "");
  return { column: obj.column, codes };
}

/** Parameters are a flat record of primitives; anything else is ignored. */
function parseParameters(raw: unknown): Record<string, string | number | null> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value === "string" || typeof value === "number") {
      out[key] = value;
    }
  }
  return out;
}

function parseTableUrls(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Record<string, string> = {};
  for (const [name, url] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof url === "string" && url !== "") out[name] = url;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Handle one message. Exported so the shape rules can be tested without a DOM
 * event; returns whether the message was one of ours and was applied.
 */
export function handleDashboardMessage(
  data: unknown,
  options: Pick<DashboardBridgeOptions, "onReloadTables">,
): boolean {
  if (!data || typeof data !== "object") return false;
  const message = data as Record<string, unknown>;

  if (message.type === "dashboard-set") {
    let applied = false;
    if ("selection" in message) {
      const parsed = parseSelection(message.selection);
      if (parsed === undefined) {
        console.warn("dashboard-set: invalid selection; ignoring");
      } else {
        setSelection(parsed);
        applied = true;
      }
    }
    if ("parameters" in message) {
      const parsed = parseParameters(message.parameters);
      if (!parsed) {
        console.warn("dashboard-set: invalid parameters; ignoring");
      } else {
        mergeParameters(parsed);
        applied = true;
      }
    }
    return applied;
  }

  if (message.type === "dashboard-reload") {
    const urls = parseTableUrls(message.tables);
    if (!urls) {
      console.warn("dashboard-reload: no usable table urls; ignoring");
      return false;
    }
    options.onReloadTables?.(urls);
    return true;
  }

  return false;
}

/** Attach the bridge for the lifetime of the calling component. */
export function useDashboardBridge(options: DashboardBridgeOptions): void {
  onMount(() => {
    function onMessage(event: MessageEvent) {
      handleDashboardMessage(event.data, options);
    }
    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
  });

  createEffect(() => {
    if (!options.ready()) return;
    post({ type: "dashboard-ready", v: 1 });
  });

  // State echo: reading both accessors is what subscribes this effect to them.
  createEffect(() => {
    post({
      type: "dashboard-state",
      v: 1,
      selection: selection(),
      parameters: parameters(),
    });
  });
}

function post(message: Record<string, unknown>): void {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(message, "*");
  }
}
