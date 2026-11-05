// SPDX-License-Identifier: MIT
import type { DecodedQr, DecodeMode, EngineName, EngineOptions, QrEngine } from "./engine";
import type { DecoderRequest, DecoderResponse } from "./protocol";

export interface DecoderReady {
  engine: EngineName;
  /** URLs the decoder loaded (worker script, chunks, WASM) — handed to the service worker for offline use. */
  resources: string[];
  inWorker: boolean;
}

/**
 * Decodes QR codes off the main thread in a Web Worker. If the worker cannot
 * start (old browser, blocked by policy), the same engine runs on the main
 * thread instead.
 */
export class QrDecoder {
  readonly ready: Promise<DecoderReady>;
  private resolveReady!: (value: DecoderReady) => void;
  private worker: Worker | null = null;
  private local: Promise<QrEngine> | null = null;
  private pending = new Map<number, (result: DecodedQr | null) => void>();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly options: EngineOptions) {
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
    try {
      // A classic worker: Turbopack's worker bootstrap loads chunks with importScripts().
      const worker = new Worker(new URL("./decode.worker.ts", import.meta.url), { name: "qr-decoder" });
      worker.onmessage = (event: MessageEvent<DecoderResponse>) => this.onMessage(event.data);
      worker.onerror = (event) => {
        event.preventDefault();
        this.fallBackToMainThread();
      };
      worker.postMessage({ type: "init", options } satisfies DecoderRequest);
      this.worker = worker;
    } catch {
      console.warn("[scanner] Web Worker unavailable — decoding on the main thread.");
      this.fallBackToMainThread();
    }
  }

  /** Decodes one frame. The ImageData buffer is transferred and must not be reused. */
  decode(image: ImageData, mode: DecodeMode): Promise<DecodedQr | null> {
    if (this.disposed) return Promise.resolve(null);
    const worker = this.worker;
    if (!worker) return this.decodeLocally(image, mode);

    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      const buffer = image.data.buffer as ArrayBuffer;
      const request: DecoderRequest = { type: "decode", id, width: image.width, height: image.height, buffer, mode };
      worker.postMessage(request, [buffer]);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    this.flushPending();
  }

  private onMessage(message: DecoderResponse): void {
    if (message.type === "ready") {
      this.resolveReady({ engine: message.engine, resources: message.resources, inWorker: true });
    } else if (message.type === "init-failed") {
      this.fallBackToMainThread();
    } else {
      const resolve = this.pending.get(message.id);
      this.pending.delete(message.id);
      resolve?.(message.result);
    }
  }

  private loadLocalEngine(): Promise<QrEngine> {
    this.local ??= import("./engine").then(({ createQrEngine }) => createQrEngine(this.options));
    return this.local;
  }

  private fallBackToMainThread(): void {
    if (this.worker) console.warn("[scanner] Web Worker unavailable — decoding on the main thread.");
    this.worker?.terminate();
    this.worker = null;
    this.flushPending();
    if (this.disposed) return;
    this.loadLocalEngine().then(
      (engine) => this.resolveReady({ engine: engine.name, resources: [], inWorker: false }),
      () => undefined,
    );
  }

  private async decodeLocally(image: ImageData, mode: DecodeMode): Promise<DecodedQr | null> {
    try {
      return await (await this.loadLocalEngine()).decode(image, mode);
    } catch {
      return null;
    }
  }

  private flushPending(): void {
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }
}
