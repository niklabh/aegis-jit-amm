// SPDX-License-Identifier: MIT
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { decimalToBytes } from "@/lib/aadhaar/bytes";
import { AadhaarQrError } from "@/lib/aadhaar/errors";
import { detectImageFormat, measureImageLength, parseSecureQr } from "@/lib/aadhaar/parse";
import { extractCompressedPayload, hasCompressionHeader } from "@/lib/aadhaar/payload";
import { concat } from "../scripts/lib/secure-qr-builder.mjs";
import { createSigner, demoPhoto, makeQrDigits, sampleFields } from "./helpers";

const parseDigits = (digits: string) => parseSecureQr(extractCompressedPayload({ text: digits }));

describe("decimal payload", () => {
  it("converts a big decimal back to the exact big-endian bytes", () => {
    const bytes = Uint8Array.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0x00, 0x01]);
    const decimal = BigInt(`0x${Buffer.from(bytes).toString("hex")}`).toString(10);
    expect(decimalToBytes(decimal)).toEqual(bytes);
  });

  it("recognises GZIP and zlib headers only", () => {
    expect(hasCompressionHeader(Uint8Array.of(0x1f, 0x8b))).toBe(true);
    expect(hasCompressionHeader(Uint8Array.of(0x78, 0x9c))).toBe(true);
    expect(hasCompressionHeader(Uint8Array.of(0x12, 0x34))).toBe(false);
  });
});

describe("parseSecureQr — versioned layout (V5, as on current e-Aadhaar)", () => {
  const fields = sampleFields();
  let signedData: Uint8Array;
  let signature: Uint8Array;
  let parsed: ReturnType<typeof parseDigits>;

  beforeAll(async () => {
    const built = await makeQrDigits(await createSigner(), fields);
    ({ signedData, signature } = built);
    parsed = parseDigits(built.digits);
  });

  it("splits signature (last 256 bytes) from the signed data", () => {
    expect(parsed.signature).toEqual(signature);
    expect(parsed.signedData).toEqual(signedData);
    expect(parsed.decompressedLength).toBe(signedData.length + 256);
  });

  it("reads every demographic field", () => {
    const d = parsed.data;
    expect(d.layout).toBe("versioned");
    expect(d.version).toBe("V5");
    expect(d).toMatchObject({
      name: fields.name,
      dob: fields.dob,
      gender: "M",
      careOf: fields.careOf,
      district: fields.district,
      landmark: fields.landmark,
      house: fields.house,
      location: fields.location,
      pincode: "110001",
      postOffice: fields.postOffice,
      state: "Delhi",
      street: fields.street,
      subDistrict: fields.subDistrict,
      vtc: fields.vtc,
      hasEmail: true,
      hasMobile: true,
      aadhaarLast4: "1234",
      maskedMobile: "XXXXXX9876",
      mobileLast4: "9876",
      maskedEmail: "txxxxxxt@exxxxxe.com",
      emailHash: null,
      mobileHash: null,
    });
    expect(d.generatedAt).toEqual({ year: 2026, month: 11, day: 4, hour: 15, minute: 30, second: 12 });
    expect(parsed.warnings).toEqual([]);
  });

  it("separates the JPEG 2000 photo from the masked e-mail that follows it", () => {
    expect(parsed.photoFormat).toBe("j2k");
    expect(parsed.photo).toEqual(fields.photo);
  });

  it("keeps the photo intact even though it contains 0xFF bytes", () => {
    expect(fields.photo.filter((b) => b === 0xff).length).toBeGreaterThan(3);
  });
});

describe("parseSecureQr — other layouts", () => {
  it("reads V2 (4-digit mobile, no e-mail trailer)", async () => {
    const signer = await createSigner();
    const { digits } = await makeQrDigits(
      signer,
      sampleFields({ version: "V2", indicator: "2", mobile: "4321", maskedEmail: undefined }),
    );
    const { data, photo } = parseDigits(digits);
    expect(data.version).toBe("V2");
    expect(data.mobileLast4).toBe("4321");
    expect(data.hasEmail).toBe(false);
    expect(data.maskedEmail).toBeNull();
    expect(photo).toEqual(demoPhoto());
  });

  it("reads the legacy 2019 layout with e-mail and mobile hashes before the signature", async () => {
    const signer = await createSigner();
    const emailHash = new Uint8Array(32).fill(0xee);
    const mobileHash = new Uint8Array(32).fill(0xaa);
    const { digits } = await makeQrDigits(
      signer,
      sampleFields({ version: null, indicator: "3", emailHash, mobileHash, maskedEmail: undefined }),
    );
    const { data, photo } = parseDigits(digits);
    expect(data.layout).toBe("legacy");
    expect(data.name).toBe("Test Resident");
    expect(data.vtc).toBe("Test City");
    expect(data.maskedMobile).toBeNull();
    expect(data.emailHash).toEqual(emailHash);
    expect(data.mobileHash).toEqual(mobileHash);
    expect(photo).toEqual(demoPhoto());
  });

  it("reads a JP2 (boxed) photo and stops at the end of its last box", async () => {
    const signer = await createSigner();
    const jp2 = new Uint8Array((await import("node:fs")).readFileSync(new URL("fixtures/avatar.jp2", import.meta.url)));
    const { digits } = await makeQrDigits(signer, sampleFields({ photo: jp2 }));
    const parsed = parseDigits(digits);
    expect(parsed.photoFormat).toBe("jp2");
    expect(parsed.photo).toEqual(jp2);
    expect(parsed.data.maskedEmail).toBe("txxxxxxt@exxxxxe.com");
  });

  it("warns about versions it has not been tested with", async () => {
    const signer = await createSigner();
    const { digits } = await makeQrDigits(signer, sampleFields({ version: "V9" }));
    const parsed = parseDigits(digits);
    expect(parsed.data.version).toBe("V9");
    expect(parsed.warnings[0]).toMatch(/V9/);
  });

  it("measures J2K codestreams via SOT tile-part lengths", () => {
    const photo = demoPhoto();
    const withTrailer = concat([photo, new TextEncoder().encode("trailing@data")]);
    expect(detectImageFormat(withTrailer)).toBe("j2k");
    expect(measureImageLength(withTrailer, "j2k")).toBe(photo.length);
  });
});

describe("rejections", () => {
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof AadhaarQrError ? error.code : "other";
    }
    return "none";
  };

  it("rejects ordinary QR codes", () => {
    expect(codeOf(() => extractCompressedPayload({ text: "https://example.com" }))).toBe("NOT_AADHAAR");
    expect(codeOf(() => extractCompressedPayload({ text: "12345" }))).toBe("NOT_AADHAAR");
    expect(codeOf(() => extractCompressedPayload({ text: "9".repeat(3000) }))).toBe("NOT_AADHAAR");
  });

  it("identifies the old unsigned XML QR", () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?><PrintLetterBarcodeData uid="999999999999" name="X"/>';
    expect(codeOf(() => extractCompressedPayload({ text: xml }))).toBe("LEGACY_XML");
  });

  it("accepts a raw GZIP payload delivered as QR byte-mode bytes", async () => {
    const signer = await createSigner();
    const { digits } = await makeQrDigits(signer, sampleFields());
    const raw = decimalToBytes(digits);
    const parsed = parseSecureQr(extractCompressedPayload({ text: "\u001f\u008b…garbled", bytes: raw }));
    expect(parsed.data.name).toBe("Test Resident");
  });

  it("reports corrupt and truncated payloads", () => {
    const notGzip = BigInt(`0x1f8b${"00".repeat(400)}`).toString(10);
    expect(codeOf(() => parseDigits(notGzip))).toBe("DECOMPRESS_FAILED");

    const tooShort = gzipSync(concat([Uint8Array.of(0x56, 0x32, 0xff, 0x33, 0xff), new Uint8Array(256)]));
    expect(codeOf(() => parseSecureQr(tooShort))).toBe("MALFORMED");

    const noFields = gzipSync(new Uint8Array(900).fill(0x41));
    expect(codeOf(() => parseSecureQr(noFields))).toBe("MALFORMED");

    // "V2", indicator, then no further delimiters: fields are missing.
    const missingFields = gzipSync(concat([Uint8Array.of(0x56, 0x32, 0xff, 0x33, 0xff), new Uint8Array(600)]));
    expect(() => parseSecureQr(missingFields)).toThrow(/fewer fields/);
  });
});
