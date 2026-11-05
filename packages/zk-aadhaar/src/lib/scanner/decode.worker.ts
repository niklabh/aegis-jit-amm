// SPDX-License-Identifier: MIT
import { createQrEngine, type QrEngine } from "./engine";
import type { DecoderRequest, DecoderResponse } from "./protocol";

// Typed locally to avoid pulling the "webworker" lib into the DOM program.
interface WorkerScope {
  onmessage: ((event: MessageEvent<DecoderRequest>) => void) | null;
  postMessage(message: DecoderResponse, transfer?: Transferable[]): void;
  location: { href: string };
  performance: Performance;
}

const scope = self as unknown as WorkerScope;
let engine: Promise<QrEngine> | null = null;

/** URLs this worker loaded (its script, chunks, the WASM) so the page can cache them for offline use. */
function loadedResources(): string[] {
  try {
    return [scope.location.href, ...scope.performance.getEntriesByType("resource").map((entry) => entry.name)];
  } catch {
    return [];
  }
}

scope.onmessage = async ({ data: message }) => {
  if (message.type === "init") {
    engine ??= createQrEngine(message.options);
    try {
      const ready = await engine;
      scope.postMessage({ type: "ready", engine: ready.name, resources: loadedResources() });
    } catch (error) {
      scope.postMessage({ type: "init-failed", message: String(error) });
    }
    return;
  }

  try {
    if (!engine) throw new Error("Decoder used before init");
    const ready = await engine;
    const image = new ImageData(new Uint8ClampedArray(message.buffer), message.width, message.height);
    const result = await ready.decode(image, message.mode);
    scope.postMessage({ type: "result", id: message.id, result }, result?.bytes ? [result.bytes.buffer] : []);
  } catch (error) {
    scope.postMessage({ type: "result", id: message.id, result: null, error: String(error) });
  }
};
