// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { buildSignedData, toQrDigits, type SecureQrFields } from "../scripts/lib/secure-qr-builder.mjs";
import type { VerificationKey } from "@/lib/aadhaar/verify";

export const root = new URL("../", import.meta.url);
export const readFixture = (path: string) => new Uint8Array(readFileSync(new URL(path, root)));

export const demoPhoto = () => readFixture("scripts/assets/demo-photo.j2k");

export function sampleFields(overrides: Partial<SecureQrFields> = {}): SecureQrFields {
  return {
    version: "V5",
    indicator: "3",
    referenceId: "123420261104153012345",
    name: "Test Resident",
    dob: "01-02-1990",
    gender: "M",
    careOf: "S/O: Parent Name",
    district: "Test District",
    landmark: "Near Test Landmark",
    house: "12A",
    location: "Test Locality",
    pincode: "110001",
    postOffice: "Test PO",
    state: "Delhi",
    street: "Test Street",
    subDistrict: "Test Subdistrict",
    vtc: "Test City",
    mobile: "XXXXXX9876",
    photo: demoPhoto(),
    maskedEmail: "txxxxxxt@exxxxxe.com",
    ...overrides,
  };
}

export interface TestSigner {
  key: VerificationKey;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export async function createSigner(trust: VerificationKey["trust"] = "custom", id = "test"): Promise<TestSigner> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  return {
    key: { id, label: `Test key ${id}`, trust, spki },
    sign: async (data) =>
      new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new Uint8Array(data))),
  };
}

/** Builds and signs a Secure QR, returning the decimal string a QR code would hold. */
export async function makeQrDigits(signer: TestSigner, fields: SecureQrFields) {
  const signedData = buildSignedData(fields);
  const signature = await signer.sign(signedData);
  return { digits: toQrDigits(signedData, signature), signedData, signature };
}
