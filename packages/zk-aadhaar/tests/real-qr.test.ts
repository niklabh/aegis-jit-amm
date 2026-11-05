// SPDX-License-Identifier: MIT
// Opt-in check against a real Aadhaar Secure QR — never commit real data.
//
//   AADHAAR_QR_IMAGE=/path/to/qr.png npm run test:real
//   AADHAAR_QR_DIGITS=/path/to/digits.txt npm run test:real
//
// Asserts structure only and prints nothing personal.
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { getBuiltInKeys } from "@/lib/aadhaar/keys";
import { parseSecureQr } from "@/lib/aadhaar/parse";
import { extractCompressedPayload } from "@/lib/aadhaar/payload";
import { verifySecureQrSignature } from "@/lib/aadhaar/verify";
import { decodeJpeg2000 } from "@/lib/photo/jpeg2000";
import { createQrEngine } from "@/lib/scanner/engine";

const imagePath = process.env.AADHAAR_QR_IMAGE;
const digitsPath = process.env.AADHAAR_QR_DIGITS;

describe.skipIf(!imagePath && !digitsPath)("real Aadhaar Secure QR", () => {
  it("decodes, parses and verifies against an official UIDAI key", async () => {
    let digits: string;
    if (imagePath) {
      const png = PNG.sync.read(readFileSync(imagePath));
      const image = { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height } as ImageData;
      const wasm = readFileSync(new URL("../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", import.meta.url));
      const engine = await createQrEngine({ assetBase: "http://localhost/", wasmBinary: new Uint8Array(wasm).buffer });
      const result = await engine.decode(image, "still");
      expect(result, "no QR code found in the image").not.toBeNull();
      digits = result!.text;
    } else {
      digits = readFileSync(digitsPath!, "utf8").trim();
    }

    const qr = parseSecureQr(extractCompressedPayload({ text: digits }));
    const verification = await verifySecureQrSignature(qr.signedData, qr.signature, getBuiltInKeys());

    console.log(
      `format=${qr.data.version} compressed=${qr.compressedLength}B decompressed=${qr.decompressedLength}B ` +
        `photo=${qr.photoFormat}/${qr.photo?.length ?? 0}B status=${verification.status} key=${verification.key?.note ?? "-"}`,
    );
    expect(verification.status).toBe("authentic");
    expect(qr.data.name.length).toBeGreaterThan(0);
    expect(qr.data.aadhaarLast4).toMatch(/^\d{4}$/);
    expect(qr.data.pincode).toMatch(/^\d{6}$/);
    expect(qr.data.generatedAt).not.toBeNull();

    expect(qr.photo).not.toBeNull();
    const photo = decodeJpeg2000(qr.photo!);
    expect(photo.width).toBeGreaterThan(0);
    expect(photo.height).toBeGreaterThan(0);
  });
});
