// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { getBuiltInKeys } from "@/lib/aadhaar/keys";
import { parseSecureQr } from "@/lib/aadhaar/parse";
import { extractCompressedPayload } from "@/lib/aadhaar/payload";
import { verifySecureQrSignature } from "@/lib/aadhaar/verify";
import { DEMO_QR_SIGNED, DEMO_QR_TAMPERED } from "@/lib/demo/samples";
import { replaceField, toQrDigits } from "../scripts/lib/secure-qr-builder.mjs";
import { createSigner, makeQrDigits, sampleFields } from "./helpers";

const parse = (digits: string) => parseSecureQr(extractCompressedPayload({ text: digits }));

describe("verifySecureQrSignature", () => {
  it("reports 'authentic' only for keys trusted as UIDAI", async () => {
    const official = await createSigner("uidai", "official");
    const { digits } = await makeQrDigits(official, sampleFields());
    const qr = parse(digits);
    const result = await verifySecureQrSignature(qr.signedData, qr.signature, [official.key]);
    expect(result.status).toBe("authentic");
    expect(result.key?.id).toBe("official");
    expect(result.signedDataSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a valid signature from a non-UIDAI key as 'untrusted-key'", async () => {
    const custom = await createSigner("custom", "mine");
    const { digits } = await makeQrDigits(custom, sampleFields());
    const qr = parse(digits);
    const result = await verifySecureQrSignature(qr.signedData, qr.signature, [...getBuiltInKeys(), custom.key]);
    expect(result.status).toBe("untrusted-key");
    expect(result.key?.id).toBe("mine");
    // Official keys are always tried first.
    expect(result.keysTried).toBe(getBuiltInKeys().filter((k) => k.trust === "uidai").length + 1);
  });

  it("fails when any signed byte changes", async () => {
    const official = await createSigner("uidai");
    const { signedData, signature } = await makeQrDigits(official, sampleFields());
    const tampered = parse(toQrDigits(replaceField(signedData, 3, "Someone Else"), signature));
    expect(tampered.data.name).toBe("Someone Else");
    const result = await verifySecureQrSignature(tampered.signedData, tampered.signature, [official.key]);
    expect(result.status).toBe("invalid");
    expect(result.key).toBeNull();
  });

  it("fails for a signature made by an unknown key", async () => {
    const stranger = await createSigner("custom");
    const { digits } = await makeQrDigits(stranger, sampleFields());
    const qr = parse(digits);
    const result = await verifySecureQrSignature(qr.signedData, qr.signature, getBuiltInKeys());
    expect(result.status).toBe("invalid");
    expect(result.keysTried).toBe(getBuiltInKeys().length);
  });
});

describe("built-in samples", () => {
  it("the signed sample verifies against the demo key only", async () => {
    const qr = parse(DEMO_QR_SIGNED);
    const result = await verifySecureQrSignature(qr.signedData, qr.signature, getBuiltInKeys());
    expect(result.status).toBe("untrusted-key");
    expect(result.key?.source).toBe("demo");
    expect(qr.data.name).toBe("Ananya Sample");
  });

  it("the tampered sample fails verification", async () => {
    const qr = parse(DEMO_QR_TAMPERED);
    expect(qr.data.dob).toBe("15-08-1984");
    const result = await verifySecureQrSignature(qr.signedData, qr.signature, getBuiltInKeys());
    expect(result.status).toBe("invalid");
  });
});
