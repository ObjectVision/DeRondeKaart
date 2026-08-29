import { modelUrls } from "@/config/map-config";
import { activeToolSchemas, type Parser, type ToolCall } from "@/ai/command-engine";
import NeedleWorker from "@/ai/needle.worker?worker";

/**
 * The main-thread half of Needle: owns the worker, turns a line of text into
 * tool calls.
 *
 * **Nothing imports this statically** — it is reached only through
 * `await import(...)`, which is what keeps the glue out of the entry bundle.
 * Same rule as `dashboard/duckdb-engine.ts`.
 *
 * The `?worker` import suffix is load-bearing and its absence fails only in
 * production builds, exactly like the MapLibre worker documented in
 * `MapView.tsx` — verify any change with `npm run build && npm run preview`,
 * never dev alone.
 */

/** Needle's reply, per the model card. */
interface NeedleResponse {
  type?: string;
  function_calls?: Array<{ name?: string; arguments?: Record<string, unknown> }>;
}

let enginePromise: Promise<Parser> | null = null;

/**
 * The parser, initialised at most once.
 *
 * Memoizes the PROMISE rather than a ready flag: two commands submitted in
 * quick succession would otherwise each spin up a worker and re-send the
 * weights. On failure the memo is cleared so a later attempt can retry — the
 * same shape as `ensureParquetWasmInit` in `layers/parquet-loader.ts`.
 */
export function ensureNeedle(weights: ArrayBuffer): Promise<Parser> {
  return (enginePromise ??= initEngine(weights).catch((err) => {
    enginePromise = null;
    throw err;
  }));
}

function initEngine(weights: ArrayBuffer): Promise<Parser> {
  const urls = modelUrls();
  if (!urls.needleGlue || !urls.needleWasm) {
    return Promise.reject(new Error("modelUrls.needleGlue / needleWasm are not configured"));
  }

  const worker = new NeedleWorker();
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: ToolCall[]) => void; reject: (e: Error) => void }>();

  return new Promise<Parser>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;

      if (msg.type === "ready") {
        resolve({
          parse: (text: string) =>
            new Promise<ToolCall[]>((res, rej) => {
              const id = nextId++;
              pending.set(id, { resolve: res, reject: rej });
              worker.postMessage({ type: "parse", id, text });
            }),
        });
        return;
      }

      if (msg.type === "failed") {
        worker.terminate();
        reject(new Error(msg.error));
        return;
      }

      const waiting = pending.get(msg.id);
      if (!waiting) return;
      pending.delete(msg.id);

      if (msg.type === "error") {
        waiting.reject(new Error(msg.error));
        return;
      }
      waiting.resolve(toCalls(msg.result));
    };

    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(`needle worker failed: ${e.message}`));
    };

    // Copied, NOT transferred. Transferring would detach the caller's buffer,
    // and the loader holds the only reference to it — so a failed init could
    // never be retried, and any later re-init would ship 0 bytes. 13.7 MB is
    // worth spending once to keep the weights re-usable.
    worker.postMessage({
      type: "init",
      glueUrl: urls.needleGlue,
      wasmUrl: urls.needleWasm,
      weights,
      toolsJson: JSON.stringify(activeToolSchemas()),
    });
  });
}

/** Normalise Needle's reply to the calls the dispatcher understands. */
function toCalls(result: unknown): ToolCall[] {
  const response = result as NeedleResponse | null;
  const calls = response?.function_calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .filter((c): c is { name: string; arguments?: Record<string, unknown> } =>
      typeof c?.name === "string",
    )
    .map((c) => ({ name: c.name, arguments: c.arguments ?? {} }));
}
