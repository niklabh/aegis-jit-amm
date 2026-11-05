// SPDX-License-Identifier: MIT
import { sha256Hex, type Bytes } from "./bytes";
import { SIGNATURE_LENGTH } from "./parse";

/**
 * "uidai"  — an official UIDAI certificate shipped with the app.
 * "custom" — a key the user imported. A match proves the QR was signed by
 *            that key, not that it was issued by UIDAI.
 * "demo"   — the key that signs the built-in sample QR codes.
 */
export type KeyTrust = "uidai" | "custom" | "demo";

export interface VerificationKey {
  id: string;
  label: string;
  trust: KeyTrust;
  spki: Bytes;
}

export type VerificationStatus =
  /** Signature valid under an official UIDAI key. */
  | "authentic"
  /** Signature valid, but only under a demo or user-imported key. */
  | "untrusted-key"
  /** No key validates the signature: the data was altered or not signed by any known key. */
  | "invalid"
  /** The check could not run (no Web Crypto in this context). */
  | "unavailable";

export interface VerificationResult<K extends VerificationKey = VerificationKey> {
  status: VerificationStatus;
  key: K | null;
  keysTried: number;
  /** SHA-256 of the signed bytes — the digest the RSA signature commits to. */
  signedDataSha256: string | null;
  message?: string;
}

const TRUST_ORDER: Record<KeyTrust, number> = { uidai: 0, custom: 1, demo: 2 };
const importedKeys = new Map<string, Promise<CryptoKey>>();

function importVerifyKey(key: VerificationKey): Promise<CryptoKey> {
  let pending = importedKeys.get(key.id);
  if (!pending) {
    pending = crypto.subtle.importKey("spki", key.spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
      "verify",
    ]);
    importedKeys.set(key.id, pending);
    pending.catch(() => importedKeys.delete(key.id));
  }
  return pending;
}

export function isWebCryptoAvailable(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle?.verify === "function";
}

/**
 * Verifies the Secure QR signature (SHA256withRSA, PKCS#1 v1.5) against each
 * key — official UIDAI keys first — and reports which one matched. Keys are
 * only ever taken from the supplied list, never from the QR itself.
 */
export async function verifySecureQrSignature<K extends VerificationKey>(
  signedData: Bytes,
  signature: Bytes,
  keys: readonly K[],
): Promise<VerificationResult<K>> {
  if (!isWebCryptoAvailable()) {
    return {
      status: "unavailable",
      key: null,
      keysTried: 0,
      signedDataSha256: null,
      message: "Signature checks need the Web Crypto API, which browsers only enable on HTTPS or localhost.",
    };
  }

  const signedDataSha256 = await sha256Hex(signedData);
  if (signature.length !== SIGNATURE_LENGTH) {
    return {
      status: "invalid",
      key: null,
      keysTried: 0,
      signedDataSha256,
      message: "The signature has an unexpected length.",
    };
  }

  const ordered = [...keys].sort((a, b) => TRUST_ORDER[a.trust] - TRUST_ORDER[b.trust]);
  let keysTried = 0;
  for (const key of ordered) {
    keysTried++;
    try {
      const cryptoKey = await importVerifyKey(key);
      if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signedData)) {
        return {
          status: key.trust === "uidai" ? "authentic" : "untrusted-key",
          key,
          keysTried,
          signedDataSha256,
        };
      }
    } catch {
      // An unusable key (e.g. not RSA) simply cannot match; try the next one.
    }
  }
  return { status: "invalid", key: null, keysTried, signedDataSha256 };
}
