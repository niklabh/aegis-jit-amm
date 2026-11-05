// SPDX-License-Identifier: MIT
import { DEMO_CERTIFICATE } from "@/lib/demo/demo-certificate";
import { bytesToBase64, formatFingerprint, sha256Hex } from "./bytes";
import { UIDAI_CERTIFICATES } from "./uidai-certificates";
import type { VerificationKey } from "./verify";
import { parsePublicKeys, type ParsedPublicKey } from "./x509";

export interface TrustedKey extends VerificationKey {
  source: "built-in" | "demo" | "imported";
  /** SHA-256 of the certificate (or bare key) DER, "AA:BB:…". */
  fingerprint: string;
  details: ParsedPublicKey;
  note?: string;
}

let builtInKeys: TrustedKey[] | null = null;

/** Official UIDAI certificates (newest first) plus the demo signer. Parsed once. */
export function getBuiltInKeys(): TrustedKey[] {
  if (builtInKeys) return builtInKeys;
  const uidai = UIDAI_CERTIFICATES.map((certificate): TrustedKey => {
    const [details] = parsePublicKeys(certificate.pem);
    return {
      id: `uidai:${certificate.fileName}`,
      label: certificate.subjectCN,
      trust: "uidai",
      source: "built-in",
      spki: details.spki,
      fingerprint: certificate.sha256,
      details,
      note: certificate.fileName,
    };
  });
  const [demoDetails] = parsePublicKeys(DEMO_CERTIFICATE.pem);
  const demo: TrustedKey = {
    id: "demo",
    label: "zkAadhaar demo signer",
    trust: "demo",
    source: "demo",
    spki: demoDetails.spki,
    fingerprint: DEMO_CERTIFICATE.sha256,
    details: demoDetails,
    note: "Signs the sample QR codes only. Not a UIDAI key.",
  };
  builtInKeys = [...uidai, demo];
  return builtInKeys;
}

// ---------------------------------------------------------------------------
// User-imported keys. Only public certificates/keys are stored (never any
// scanned data), in localStorage, exposed as a useSyncExternalStore store.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "zkaadhaar.imported-keys.v1";

interface StoredKey {
  label: string;
  pem: string;
  fingerprint: string;
  official: boolean;
  addedAt: string;
}

const EMPTY: TrustedKey[] = [];
const listeners = new Set<() => void>();
let snapshot: TrustedKey[] | null = null;

function readStorage(): StoredKey[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (k): k is StoredKey =>
        typeof k === "object" &&
        k !== null &&
        typeof k.label === "string" &&
        typeof k.pem === "string" &&
        typeof k.fingerprint === "string",
    );
  } catch {
    return [];
  }
}

function writeStorage(keys: StoredKey[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  snapshot = null;
  listeners.forEach((listener) => listener());
}

function toTrustedKey(stored: StoredKey): TrustedKey | null {
  try {
    const [details] = parsePublicKeys(stored.pem);
    return {
      id: `imported:${stored.fingerprint}`,
      label: stored.label,
      trust: stored.official ? "uidai" : "custom",
      source: "imported",
      spki: details.spki,
      fingerprint: stored.fingerprint,
      details,
      note: stored.official ? "Imported and marked as an official UIDAI certificate." : "Imported key.",
    };
  } catch {
    return null;
  }
}

function toPem(label: "CERTIFICATE" | "PUBLIC KEY", der: Uint8Array): string {
  const body = bytesToBase64(der).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

export const importedKeyStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        snapshot = null;
        listener();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  },

  getSnapshot(): TrustedKey[] {
    snapshot ??= readStorage()
      .map(toTrustedKey)
      .filter((k): k is TrustedKey => k !== null);
    return snapshot;
  },

  getServerSnapshot(): TrustedKey[] {
    return EMPTY;
  },

  /**
   * Parses and stores every public key in `input`. Returns how many were
   * added and how many were skipped as already known.
   */
  async add(input: string | Uint8Array, options: { official: boolean; fallbackLabel?: string }) {
    const parsed = parsePublicKeys(input);
    const stored = readStorage();
    const known = new Set([...getBuiltInKeys().map((k) => k.fingerprint), ...stored.map((k) => k.fingerprint)]);
    let added = 0;
    let skipped = 0;
    for (const details of parsed) {
      const fingerprint = formatFingerprint(await sha256Hex(details.der));
      if (known.has(fingerprint)) {
        skipped++;
        continue;
      }
      known.add(fingerprint);
      stored.push({
        label:
          details.subject?.commonName ??
          options.fallbackLabel ??
          `Imported RSA-${details.modulusBits} key ${fingerprint.slice(0, 11)}`,
        pem: details.kind === "certificate" ? toPem("CERTIFICATE", details.der) : toPem("PUBLIC KEY", details.spki),
        fingerprint,
        official: options.official,
        addedAt: new Date().toISOString(),
      });
      added++;
    }
    if (added > 0) writeStorage(stored);
    return { added, skipped, modulusBits: parsed.map((p) => p.modulusBits) };
  },

  remove(id: string): void {
    writeStorage(readStorage().filter((k) => `imported:${k.fingerprint}` !== id));
  },
};
