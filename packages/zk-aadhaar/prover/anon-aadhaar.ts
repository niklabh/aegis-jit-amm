// SPDX-License-Identifier: MIT
// Node-side Anon Aadhaar pipeline:
//   Secure QR digits ─► zkAadhaar payload/parse ─► UIDAI-style RSA-2048 check (Web Crypto)
//   ─► Anon Aadhaar v2 circuit inputs ─► snarkjs Groth16 (BN254) proof ─► packed uint256[8]
//
// Circuit-input encoding mirrors @anon-aadhaar/core 2.4.3 `generateArgs` (MIT, Ethereum Foundation).

import { X509Certificate, createHash, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import sha3 from "js-sha3";

import { buildSignedData, toQrDigits } from "../scripts/lib/secure-qr-builder.mjs";
import { extractCompressedPayload } from "../src/lib/aadhaar/payload";
import { parseSecureQr, type SecureQrData } from "../src/lib/aadhaar/parse";
import { verifySecureQrSignature, type VerificationKey, type VerificationStatus } from "../src/lib/aadhaar/verify";
import { UIDAI_CERTIFICATES } from "../src/lib/aadhaar/uidai-certificates";
import { parsePublicKeys } from "../src/lib/aadhaar/x509";
import { toBytes } from "../src/lib/aadhaar/bytes";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ARTIFACT_DIR = join(HERE, "..", "..", "..", ".cache", "anon-aadhaar", "v2.0.0");
export const WASM = join(ARTIFACT_DIR, "aadhaar-verifier.wasm");
export const ZKEY = join(ARTIFACT_DIR, "circuit_final.zkey");

export const TEST_SIGNER_KEY = join(HERE, "test-signer", "aegis-test-signer.key.pem");
export const TEST_SIGNER_CERT = join(HERE, "test-signer", "aegis-test-signer.cert.pem");

/** BN254 scalar field */
export const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_SIGNED_BYTES_PADDED = 512 * 3; // circuit maxDataLength

export function artifactsAvailable(): boolean {
  return existsSync(WASM) && existsSync(ZKEY);
}

// ------------------------------------------------------------------ synthetic V2 test QR

export interface TestQrOptions {
  /** Unix seconds the QR is "generated" at (IST reference id is derived from it) */
  timestamp: number;
  name?: string;
  dob?: string; // DD-MM-YYYY
  gender?: string;
  pincode?: string;
  state?: string;
}

/** Fictional resident, V2 layout (the layout the Anon Aadhaar v2 circuit parses). */
export function makeTestQr(o: TestQrOptions): { digits: string; signedData: Uint8Array } {
  const ist = new Date((o.timestamp + 19_800) * 1000); // IST = UTC+05:30
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp = `${ist.getUTCFullYear()}${p(ist.getUTCMonth() + 1)}${p(ist.getUTCDate())}${p(ist.getUTCHours())}${p(ist.getUTCMinutes())}${p(ist.getUTCSeconds())}000`;
  const signedData: Uint8Array = buildSignedData({
    version: "V2",
    indicator: "2",
    referenceId: `0420${stamp}`,
    name: o.name ?? "Test Resident Mumbai",
    dob: o.dob ?? "15-08-2002",
    gender: o.gender ?? "F",
    careOf: "C/O: Test Guardian",
    district: "Mumbai",
    landmark: "Near Gateway",
    house: "Flat 24",
    location: "Colaba",
    pincode: o.pincode ?? "400001",
    postOffice: "Mumbai GPO",
    state: o.state ?? "Maharashtra",
    street: "Marine Drive",
    subDistrict: "Mumbai City",
    vtc: "Mumbai",
    mobile: "1234",
    photo: new Uint8Array(readFileSync(join(HERE, "..", "scripts", "assets", "demo-photo.j2k"))),
  });
  if (signedData.length + 9 > MAX_SIGNED_BYTES_PADDED - 64) throw new Error(`signed data too long for circuit: ${signedData.length}`);
  const signature = new Uint8Array(sign("sha256", signedData, readFileSync(TEST_SIGNER_KEY)));
  return { digits: toQrDigits(signedData, signature), signedData };
}

// ------------------------------------------------------------------ parse + RSA verify (zkAadhaar)

export interface ParsedQr {
  data: SecureQrData;
  signedData: Uint8Array;
  signature: Uint8Array;
  rsa: { status: VerificationStatus; key: string | null };
}

let trustedKeys: VerificationKey[] | null = null;
function keys(): VerificationKey[] {
  if (!trustedKeys) {
    trustedKeys = [];
    for (const c of UIDAI_CERTIFICATES) {
      for (const k of parsePublicKeys(c.pem)) trustedKeys.push({ id: `uidai:${c.fileName}`, label: c.fileName, trust: "uidai", spki: toBytes(k.spki) });
    }
    for (const k of parsePublicKeys(readFileSync(TEST_SIGNER_CERT, "utf8"))) {
      trustedKeys.push({ id: "aegis-test-signer", label: "AegisJIT TEST signer (NOT UIDAI)", trust: "custom", spki: toBytes(k.spki) });
    }
  }
  return trustedKeys;
}

export async function parseAndVerify(digits: string): Promise<ParsedQr> {
  const parsed = parseSecureQr(extractCompressedPayload({ text: digits }));
  const r = await verifySecureQrSignature(parsed.signedData, parsed.signature, keys());
  return { data: parsed.data, signedData: parsed.signedData, signature: parsed.signature, rsa: { status: r.status, key: r.key?.label ?? null } };
}

// ------------------------------------------------------------------ circuit inputs

/** SHA-256 padding (FIPS 180-4) then zero-fill to `maxBytes`; returns the padded length too. */
function sha256Pad(message: Uint8Array, maxBytes: number): [Uint8Array, number] {
  const bitLen = BigInt(message.length) * 8n;
  let len = message.length + 1;
  while (len % 64 !== 56) len++;
  const padded = new Uint8Array(len + 8);
  padded.set(message);
  padded[message.length] = 0x80;
  for (let i = 0; i < 8; i++) padded[len + i] = Number((bitLen >> BigInt(8 * (7 - i))) & 0xffn);
  if (padded.length > maxBytes) throw new Error(`padded message ${padded.length} > ${maxBytes}`);
  const out = new Uint8Array(maxBytes);
  out.set(padded);
  return [out, padded.length];
}

function splitToWords(x: bigint, wordBits: bigint, n: number): string[] {
  const words: string[] = [];
  const mod = 1n << wordBits;
  for (let i = 0; i < n; i++) { words.push((x % mod).toString()); x /= mod; }
  if (x !== 0n) throw new Error("does not fit");
  return words;
}

const bytesToBigInt = (b: Uint8Array) => BigInt("0x" + Buffer.from(b).toString("hex"));

/** keccak256(uint256 signal) >> 3 — matches AnonAadhaar.sol `_hash` */
export function hashSignal(signal: bigint): bigint {
  const word = Buffer.from(signal.toString(16).padStart(64, "0"), "hex");
  return BigInt("0x" + sha3.keccak256(word)) >> 3n;
}

/** Modulus of an X.509 certificate's RSA key */
export function rsaModulus(certPem: string): bigint {
  const jwk = new X509Certificate(certPem).publicKey.export({ format: "jwk" }) as { n: string };
  return BigInt("0x" + Buffer.from(jwk.n, "base64url").toString("hex"));
}

export interface ProveRequest {
  signedData: Uint8Array;
  signature: Uint8Array;
  modulus: bigint;
  nullifierSeed: bigint;
  signal: bigint;
  reveal?: { ageAbove18?: boolean; gender?: boolean; pincode?: boolean; state?: boolean };
}

export function circuitInputs(r: ProveRequest) {
  if (r.nullifierSeed >= SNARK_FIELD) throw new Error("nullifierSeed >= field");
  const [padded, paddedLen] = sha256Pad(r.signedData, MAX_SIGNED_BYTES_PADDED);
  const delimiterIndices: string[] = [];
  for (let i = 0; i < padded.length && delimiterIndices.length < 18; i++) if (padded[i] === 255) delimiterIndices.push(String(i));
  const rv = { ageAbove18: true, state: true, ...r.reveal };
  return {
    qrDataPadded: Array.from(padded, String),
    qrDataPaddedLength: String(paddedLen),
    delimiterIndices,
    signature: splitToWords(bytesToBigInt(r.signature), 121n, 17),
    pubKey: splitToWords(r.modulus, 121n, 17),
    nullifierSeed: r.nullifierSeed.toString(),
    signalHash: hashSignal(r.signal).toString(),
    revealAgeAbove18: rv.ageAbove18 ? "1" : "0",
    revealGender: rv.gender ? "1" : "0",
    revealPinCode: rv.pincode ? "1" : "0",
    revealState: rv.state ? "1" : "0",
  };
}

// ------------------------------------------------------------------ proving

export interface AnonAadhaarProof {
  /** Packed for AnonAadhaar.sol: [a0, a1, b01, b00, b11, b10, c0, c1] */
  groth16Proof: string[];
  publicSignals: {
    pubkeyHash: string; nullifier: string; timestamp: string;
    ageAbove18: string; gender: string; pincode: string; state: string;
    nullifierSeed: string; signalHash: string;
  };
  provingMs: number;
  stateText: string;
}

/** Packed reveal value → text (little-endian bytes, as @anon-aadhaar/core convertRevealBigIntToString) */
export function revealToString(v: bigint): string {
  let s = "";
  while (v > 0n) { s += String.fromCharCode(Number(v % 256n)); v /= 256n; }
  return s;
}

export async function prove(r: ProveRequest): Promise<AnonAadhaarProof> {
  if (!artifactsAvailable()) throw new Error("Anon Aadhaar artifacts missing — run: node packages/zk-aadhaar/prover/fetch-artifacts.mjs");
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInputs(r), WASM, ZKEY);
  const provingMs = Math.round(performance.now() - t0);
  const [pubkeyHash, nullifier, timestamp, ageAbove18, gender, pincode, state, nullifierSeed, signalHash] = publicSignals as string[];
  return {
    groth16Proof: [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]],
    publicSignals: { pubkeyHash, nullifier, timestamp, ageAbove18, gender, pincode, state, nullifierSeed, signalHash },
    provingMs,
    stateText: revealToString(BigInt(state)),
  };
}

/** One-shot: QR digits → verified parse → proof (the full client pipeline). */
export async function proveFromQr(digits: string, nullifierSeed: bigint, signal: bigint, certPem = readFileSync(TEST_SIGNER_CERT, "utf8")) {
  const parsed = await parseAndVerify(digits);
  if (parsed.rsa.status === "invalid" || parsed.rsa.status === "unavailable") throw new Error(`RSA signature check failed: ${parsed.rsa.status}`);
  const proof = await prove({ signedData: parsed.signedData, signature: parsed.signature, modulus: rsaModulus(certPem), nullifierSeed, signal });
  return { parsed, proof };
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
