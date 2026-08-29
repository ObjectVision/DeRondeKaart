/// <reference lib="webworker" />

/**
 * Needle 2 inference, off the main thread.
 *
 * The model is small (13.7 MB, ~28 MB session RAM) but decoding still blocks
 * whatever thread it runs on, and this app's main thread is driving a map. The
 * worker also lets the weights be assembled without the UI ever holding a
 * multi-megabyte buffer.
 *
 * The C API (wasm/needle.h) is four functions:
 *   needle_load(ptr, len)                     -> 0 on success
 *   needle_init(system, tools_json, index)    -> 0 on success
 *   needle_complete(input, max_tokens, out, cap)
 *   needle_reset()
 */

interface NeedleModule {
  ccall: (
    name: string,
    returns: string | null,
    argTypes: string[],
    args: unknown[],
  ) => number;
  _malloc: (n: number) => number;
  _free: (p: number) => void;
  /** Raw export: (i32 ptr, i64 len) -> i32. See the call site for why. */
  _needle_load: (ptr: number, len: bigint) => number;
  HEAPU8: Uint8Array;
  UTF8ToString: (ptr: number) => string;
}

type Factory = (opts: Record<string, unknown>) => Promise<NeedleModule>;

let mod: NeedleModule | null = null;

/** Reply buffer. Needle answers with one JSON object; 8 KB is ample. */
const OUT_CAPACITY = 8192;

interface InitMessage {
  type: "init";
  glueUrl: string;
  wasmUrl: string;
  weights: ArrayBuffer;
  toolsJson: string;
}

interface ParseMessage {
  type: "parse";
  id: number;
  text: string;
}

async function init(msg: InitMessage): Promise<void> {
  const glue = await fetch(msg.glueUrl);
  if (!glue.ok) throw new Error(`needle.js: ${glue.status}`);
  const source = await glue.text();

  // The glue is a UMD bundle whose entry point is `var createNeedle = ...` at
  // top level. Inside `new Function` that `var` is scoped to the function, so
  // it never lands on globalThis — appending a return is what hands it back.
  // (Evaluating it as a classic script via importScripts is not an option: the
  // worker is a module worker, where importScripts throws.)
  const factory = new Function(`${source}\n;return createNeedle;`)() as Factory | undefined;
  if (typeof factory !== "function") {
    throw new Error("needle.js did not define createNeedle");
  }

  // Hand Emscripten the wasm BYTES, not a URL. Two reasons, both measured
  // against this exact build of the glue:
  //
  //  - It ignores the `locateFile` option. The published build inlines
  //    `locateFile(path){return scriptDirectory+path}` and never reads
  //    `Module.locateFile`, so overriding it does nothing.
  //  - `scriptDirectory` derives from `document.currentScript.src`. A worker has
  //    no `document`, so it stays "" and the glue fetches the bare relative path
  //    "needle.wasm" against OUR origin. The dev/preview server answers that
  //    with index.html, and the instantiation dies on the HTML magic word
  //    ("found 3c 21 64 6f" — that is "<!do").
  //
  // `Module.wasmBinary` is honoured, and `instantiateAsync` skips its fetch
  // entirely when the binary is already in hand.
  const wasm = await fetch(msg.wasmUrl);
  if (!wasm.ok) throw new Error(`needle.wasm: ${wasm.status}`);
  const wasmBinary = await wasm.arrayBuffer();

  mod = await factory({ wasmBinary });

  const bytes = new Uint8Array(msg.weights);
  const ptr = mod._malloc(bytes.byteLength);
  mod.HEAPU8.set(bytes, ptr);

  // needle_load is (i32 ptr, i64 len) — verified by probing the wasm exports;
  // it is the only one of the four with a 64-bit parameter. `ccall` has no type
  // name for i64, and passing a plain number throws "Cannot convert <len> to a
  // BigInt", so call the raw export and pass the length as a BigInt.
  const loaded = mod._needle_load(ptr, BigInt(bytes.byteLength));
  mod._free(ptr);
  if (loaded !== 0) throw new Error(`needle_load failed (${loaded})`);

  // needle_init returns the PROMPT TOKEN COUNT, not a status. Measured: "" -> 4,
  // "[]" -> 9, our four tools -> 257, and it grows with a longer system prompt.
  // So a non-zero result is the success case and zero would mean nothing was
  // tokenised at all — the opposite of the usual C convention. Only a negative
  // value is an error.
  const tokens = mod.ccall(
    "needle_init",
    "number",
    ["string", "string", "string"],
    ["", msg.toolsJson, ""],
  );
  if (tokens <= 0) throw new Error(`needle_init failed (${tokens})`);
}

/**
 * One turn. `needle_reset` first, every time: the session carries conversation
 * state, and measured on the real model that state leaks between commands — a
 * stale place name reappeared in later answers. Each command must be
 * independent.
 */
function parse(text: string): unknown {
  if (!mod) throw new Error("needle is not initialised");
  mod.ccall("needle_reset", null, [], []);

  const out = mod._malloc(OUT_CAPACITY);
  try {
    // Also a token count (measured 20-65 for one-line commands), not a byte
    // count — the JSON lands in `out` either way. Negative is the error case.
    const written = mod.ccall(
      "needle_complete",
      "number",
      ["string", "number", "number", "number"],
      [text, 128, out, OUT_CAPACITY],
    );
    if (written < 0) throw new Error(`needle_complete failed (${written})`);
    return JSON.parse(mod.UTF8ToString(out));
  } finally {
    mod._free(out);
  }
}

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as InitMessage | ParseMessage;

  if (msg.type === "init") {
    try {
      await init(msg);
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "failed", error: String(err) });
    }
    return;
  }

  if (msg.type === "parse") {
    try {
      self.postMessage({ type: "result", id: msg.id, result: parse(msg.text) });
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, error: String(err) });
    }
  }
};
