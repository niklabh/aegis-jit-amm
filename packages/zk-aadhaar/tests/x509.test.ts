// SPDX-License-Identifier: MIT
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bytesToHex, formatFingerprint, sha256Hex } from "@/lib/aadhaar/bytes";
import { UIDAI_CERTIFICATES } from "@/lib/aadhaar/uidai-certificates";
import { KeyParseError, parsePublicKeys } from "@/lib/aadhaar/x509";

const certDir = new URL("../certs/uidai/", import.meta.url);

describe("embedded UIDAI certificates", () => {
  it("match the original files in certs/uidai/", () => {
    const files = readdirSync(certDir).filter((f) => f.endsWith(".cer"));
    expect(files.sort()).toEqual(UIDAI_CERTIFICATES.map((c) => c.fileName).sort());
    for (const embedded of UIDAI_CERTIFICATES) {
      const original = new X509Certificate(readFileSync(new URL(embedded.fileName, certDir)));
      expect(original.fingerprint256).toBe(embedded.sha256);
    }
  });

  it.each(UIDAI_CERTIFICATES.map((c) => [c.fileName, c] as const))("parses %s", async (_, embedded) => {
    const [key] = parsePublicKeys(embedded.pem);
    const node = new X509Certificate(embedded.pem);
    expect(key.kind).toBe("certificate");
    expect(key.modulusBits).toBe(2048);
    expect(key.publicExponent).toBe(65537);
    expect(key.subject?.commonName).toBe(embedded.subjectCN);
    expect(key.issuer?.commonName).toBe(embedded.issuerCN);
    expect(key.notBefore?.toISOString()).toBe(embedded.notBefore);
    expect(key.notAfter?.toISOString()).toBe(embedded.notAfter);
    expect(key.serialNumber).toBe(node.serialNumber.replace(/^0+(?=.)/, ""));
    expect(bytesToHex(key.spki)).toBe(node.publicKey.export({ type: "spki", format: "der" }).toString("hex"));
    expect(formatFingerprint(await sha256Hex(key.der))).toBe(embedded.sha256);
  });

  it("includes the current UIDAI key that signs Secure QR codes in 2026", () => {
    expect(UIDAI_CERTIFICATES.map((c) => c.sha256)).toContain(
      "E0:30:4B:9E:61:EE:36:40:EC:DD:AE:2D:B4:B6:17:F2:E2:67:8F:57:DB:C2:82:6C:2F:86:AC:5C:04:F2:77:DF",
    );
  });
});

describe("parsePublicKeys", () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spkiHex = publicKey.export({ type: "spki", format: "der" }).toString("hex");

  it("reads SPKI 'PUBLIC KEY' PEM", () => {
    const [key] = parsePublicKeys(publicKey.export({ type: "spki", format: "pem" }).toString());
    expect(key.kind).toBe("public-key");
    expect(bytesToHex(key.spki)).toBe(spkiHex);
  });

  it("wraps PKCS#1 'RSA PUBLIC KEY' PEM into SPKI", () => {
    const [key] = parsePublicKeys(publicKey.export({ type: "pkcs1", format: "pem" }).toString());
    expect(bytesToHex(key.spki)).toBe(spkiHex);
    expect(key.modulusBits).toBe(2048);
  });

  it("reads DER bytes of a .cer file", () => {
    const der = new X509Certificate(UIDAI_CERTIFICATES[0].pem).raw;
    const [key] = parsePublicKeys(new Uint8Array(der));
    expect(key.subject?.commonName).toBe(UIDAI_CERTIFICATES[0].subjectCN);
  });

  it("reads several certificates from one PEM bundle", () => {
    const bundle = UIDAI_CERTIFICATES.slice(0, 3).map((c) => c.pem).join("\n");
    expect(parsePublicKeys(bundle)).toHaveLength(3);
  });

  it("refuses private keys and non-RSA keys", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect(() => parsePublicKeys(privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toThrow(KeyParseError);
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey;
    expect(() => parsePublicKeys(ec.export({ type: "spki", format: "pem" }).toString())).toThrow(/Only RSA/);
  });

  it("explains when nothing usable was found", () => {
    expect(() => parsePublicKeys("hello")).toThrow(KeyParseError);
  });
});
