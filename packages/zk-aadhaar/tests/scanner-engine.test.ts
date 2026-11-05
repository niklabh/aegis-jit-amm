// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { DEMO_QR_SIGNED } from "@/lib/demo/samples";
import { createQrEngine } from "@/lib/scanner/engine";

const wasmBinary = readFileSync(new URL("../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", import.meta.url));

function loadImage(path: string): ImageData {
  const png = PNG.sync.read(readFileSync(new URL(path, import.meta.url)));
  // Duck-typed ImageData (Node has no DOM).
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height, colorSpace: "srgb" } as ImageData;
}

describe("QR engines read the dense (version 30) sample QR", () => {
  it("zxing-wasm returns the raw payload bytes", async () => {
    const engine = await createQrEngine({
      assetBase: "http://localhost/",
      wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength),
    });
    expect(engine.name).toBe("zxing-wasm");
    const result = await engine.decode(loadImage("../public/samples/demo-signed-qr.png"), "still");
    expect(result?.text).toBe(DEMO_QR_SIGNED);
    expect(new TextDecoder().decode(result?.bytes ?? new Uint8Array())).toBe(DEMO_QR_SIGNED);
  });

  it("the @zxing/library fallback also reads it (still-image strategy)", async () => {
    const engine = await createQrEngine({ assetBase: "http://localhost/", prefer: "zxing-js" });
    expect(engine.name).toBe("zxing-js");
    const result = await engine.decode(loadImage("../public/samples/demo-signed-qr.png"), "still");
    expect(result?.text).toBe(DEMO_QR_SIGNED);
  });
});
