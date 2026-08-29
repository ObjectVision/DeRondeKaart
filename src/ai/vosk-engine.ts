import type { KaldiRecognizer, Model } from "vosk-browser";
import type { RecognizerMessage } from "vosk-browser/dist/interfaces";

/**
 * Dutch speech-to-text with Vosk, in the browser.
 *
 * Lazily imported like the rest of the AI code, so `vosk-browser` and its ~2 MB
 * of glue stay out of the entry bundle. The library compiles Vosk for a
 * WebWorker context itself, so recognition already runs off the main thread —
 * this module owns only the microphone and the audio graph feeding it.
 */

export interface Dictation {
  /** Stop capturing and release the microphone. */
  stop: () => void;
}

export interface DictationHandlers {
  /** Words as they are recognised, for live feedback in the input. */
  onPartial?: (text: string) => void;
  /** A finished utterance, once the speaker pauses. */
  onResult: (text: string) => void;
  onError?: (message: string) => void;
}

let modelPromise: Promise<Model> | null = null;

/**
 * The recogniser model, loaded at most once.
 *
 * Takes the already-downloaded bytes rather than a URL: the idle-gated loader
 * has them in hand, and pointing `createModel` at the network would pay the
 * ~40 MB a second time. Memoizes the PROMISE, not a ready flag, so two quick
 * clicks cannot each start an unpack — the same reasoning as
 * `ensureParquetWasmInit` in `layers/parquet-loader.ts`.
 */
function ensureModel(bytes: ArrayBuffer): Promise<Model> {
  return (modelPromise ??= (async () => {
    const { createModel } = await import("vosk-browser");
    // A blob URL of bytes we already hold: createModel only takes a URL, and
    // this keeps the fetch local rather than repeating the download.
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/gzip" }));
    try {
      return await createModel(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  })().catch((err) => {
    modelPromise = null;
    throw err;
  }));
}

/**
 * Capture from the microphone until the caller stops, reporting what is heard.
 *
 * `getUserMedia` needs a secure context AND — in the embed — an
 * `allow="microphone"` attribute on the parent page's iframe. Without it this
 * rejects, which the caller surfaces rather than leaving the mic looking stuck.
 */
export async function startDictation(
  bytes: ArrayBuffer,
  handlers: DictationHandlers,
): Promise<Dictation> {
  const model = await ensureModel(bytes);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });

  const context = new AudioContext();
  const recognizer: KaldiRecognizer = new model.KaldiRecognizer(context.sampleRate);

  recognizer.on("result", (message: RecognizerMessage) => {
    const text = "result" in message ? (message.result as { text?: string }).text : "";
    if (text?.trim()) handlers.onResult(text.trim());
  });
  recognizer.on("partialresult", (message: RecognizerMessage) => {
    const partial =
      "result" in message ? (message.result as { partial?: string }).partial : "";
    if (partial?.trim()) handlers.onPartial?.(partial.trim());
  });
  recognizer.on("error", (message: RecognizerMessage) => {
    if ("error" in message) handlers.onError?.(String(message.error));
  });

  const source = context.createMediaStreamSource(stream);
  // 4096 frames is the usual compromise: small enough that partial results feel
  // live, large enough not to wake the thread constantly.
  const processor = context.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event) => {
    try {
      recognizer.acceptWaveform(event.inputBuffer);
    } catch (err) {
      handlers.onError?.(String(err));
    }
  };

  source.connect(processor);
  processor.connect(context.destination);

  let stopped = false;
  return {
    stop: () => {
      // Guarded: the caller stops on both an utterance and a second click, and
      // disconnecting a closed context throws.
      if (stopped) return;
      stopped = true;
      processor.disconnect();
      source.disconnect();
      // Every track must be stopped, or the browser keeps showing its recording
      // indicator after the user has finished speaking.
      stream.getTracks().forEach((t) => t.stop());
      void context.close();
      recognizer.remove();
    },
  };
}
