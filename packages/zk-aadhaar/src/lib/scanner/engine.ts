// SPDX-License-Identifier: MIT
import type { ReaderOptions } from "zxing-wasm/reader";
import type { QrScan } from "@/lib/aadhaar/payload";

export type DecodeMode = "video" | "still";
export type EngineName = "zxing-wasm" | "zxing-js";

export interface DecodedQr extends QrScan {
  text: string;
  /** Raw payload bytes exactly as stored in the QR symbol (no charset conversion). */
  bytes: Uint8Array<ArrayBuffer> | null;
  engine: EngineName;
}

export interface QrEngine {
  name: EngineName;
  decode(image: ImageData, mode: DecodeMode): Promise<DecodedQr | null>;
}

export interface EngineOptions {
  /** Absolute URL of the site root; the WASM binary is served from `<assetBase>wasm/`. */
  assetBase: string;
  prefer?: EngineName;
  /** Pre-loaded WASM bytes (tests / Node), instead of fetching from `assetBase`. */
  wasmBinary?: ArrayBuffer;
}

/**
 * Aadhaar Secure QR codes are dense (version ~30, 137×137 modules). ZXing's
 * C++ engine compiled to WebAssembly reads them reliably from camera frames;
 * the older JS port (@zxing/library) frequently misses them, so it is only a
 * fallback for browsers without WebAssembly (e.g. iOS Lockdown Mode).
 */
export async function createQrEngine(options: EngineOptions): Promise<QrEngine> {
  if (options.prefer !== "zxing-js" && typeof WebAssembly === "object") {
    try {
      return await createZxingWasmEngine(options);
    } catch (error) {
      console.warn("[scanner] zxing-wasm unavailable, falling back to @zxing/library:", error);
    }
  }
  return createZxingJsEngine();
}

function copyBytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(view.length);
  out.set(view);
  return out;
}

async function createZxingWasmEngine({ assetBase, wasmBinary }: EngineOptions): Promise<QrEngine> {
  const zxing = await import("zxing-wasm/reader");
  // Self-hosted binary (copied by scripts/copy-wasm.mjs); the library's default is a CDN.
  const wasmUrl = new URL(`wasm/zxing_reader-${zxing.ZXING_WASM_VERSION}.wasm`, assetBase).href;
  await zxing.prepareZXingModule({
    overrides: wasmBinary
      ? { wasmBinary }
      : { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) },
    fireImmediately: true,
  });

  const options = (pass: ReaderOptions): ReaderOptions => ({
    formats: ["QRCode"],
    maxNumberOfSymbols: 1,
    tryInvert: false,
    ...pass,
  });
  // Video: one fast pass per frame (frames keep coming). Stills: escalate.
  const passes: Record<DecodeMode, ReaderOptions[]> = {
    video: [options({ tryHarder: true })],
    still: [
      options({ tryHarder: true }),
      options({ isPure: true }),
      options({ tryHarder: true, binarizer: "GlobalHistogram" }),
      options({ tryHarder: true, tryDenoise: true }),
      options({ tryHarder: true, tryInvert: true }),
    ],
  };

  return {
    name: "zxing-wasm",
    async decode(image, mode) {
      for (const pass of passes[mode]) {
        const results = await zxing.readBarcodes(image, pass);
        const hit = results.find((r) => r.isValid);
        if (hit) return { text: hit.text, bytes: copyBytes(hit.bytes), engine: "zxing-wasm" };
      }
      return null;
    },
  };
}

interface Luma {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function toLuma(image: ImageData): Luma {
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return { data: out, width, height };
}

function resample(src: Luma, factor: number): Luma {
  const width = Math.max(1, Math.round(src.width * factor));
  const height = Math.max(1, Math.round(src.height * factor));
  const out = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.max(0, (y + 0.5) / factor - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.max(0, (x + 0.5) / factor - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = sx - x0;
      const top = src.data[y0 * src.width + x0] * (1 - fx) + src.data[y0 * src.width + x1] * fx;
      const bottom = src.data[y1 * src.width + x0] * (1 - fx) + src.data[y1 * src.width + x1] * fx;
      out[y * width + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return { data: out, width, height };
}

async function createZxingJsEngine(): Promise<QrEngine> {
  const zx = await import("@zxing/library");
  const reader = new zx.QRCodeReader();

  const attempt = (image: Luma, binarizer: "hybrid" | "global", pure: boolean): DecodedQr | null => {
    const hints = new Map<import("@zxing/library").DecodeHintType, unknown>([
      [zx.DecodeHintType.POSSIBLE_FORMATS, [zx.BarcodeFormat.QR_CODE]],
      [pure ? zx.DecodeHintType.PURE_BARCODE : zx.DecodeHintType.TRY_HARDER, true],
    ]);
    try {
      const source = new zx.RGBLuminanceSource(image.data, image.width, image.height);
      const bitmap = new zx.BinaryBitmap(
        binarizer === "hybrid" ? new zx.HybridBinarizer(source) : new zx.GlobalHistogramBinarizer(source),
      );
      const result = reader.decode(bitmap, hints);
      const segments = result.getResultMetadata()?.get(zx.ResultMetadataType.BYTE_SEGMENTS) as
        | Uint8Array[]
        | undefined;
      let bytes: Uint8Array<ArrayBuffer> | null = null;
      if (segments?.length) {
        bytes = new Uint8Array(segments.reduce((n, s) => n + s.length, 0));
        let offset = 0;
        for (const segment of segments) {
          bytes.set(segment, offset);
          offset += segment.length;
        }
      }
      return { text: result.getText(), bytes, engine: "zxing-js" };
    } catch {
      return null; // NotFound / Checksum / Format exceptions: nothing readable at this scale
    } finally {
      reader.reset();
    }
  };

  // The JS port's detector is sensitive to module size, so try several scales.
  const plans: Record<DecodeMode, Array<[number, "hybrid" | "global", boolean]>> = {
    video: [
      [1, "hybrid", false],
      [0.75, "hybrid", false],
      [0.6, "hybrid", false],
    ],
    still: [
      [1, "hybrid", true],
      [1, "hybrid", false],
      [0.75, "hybrid", false],
      [0.6, "hybrid", false],
      [1, "global", false],
      [0.5, "global", true],
      [1.3, "hybrid", false],
    ],
  };

  return {
    name: "zxing-js",
    async decode(image, mode) {
      const luma = toLuma(image);
      for (const [scale, binarizer, pure] of plans[mode]) {
        const hit = attempt(scale === 1 ? luma : resample(luma, scale), binarizer, pure);
        if (hit) return hit;
      }
      return null;
    },
  };
}
