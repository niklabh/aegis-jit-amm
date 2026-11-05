// SPDX-License-Identifier: MIT
/**
 * Small byte helpers. Everything returns `Uint8Array<ArrayBuffer>` so the
 * results can be handed straight to Web Crypto (which rejects views over
 * SharedArrayBuffer at the type level).
 */

export type Bytes = Uint8Array<ArrayBuffer>;

/** Big-endian bytes of an unsigned decimal integer (no leading zero bytes). */
export function decimalToBytes(decimal: string): Bytes {
  if (!/^\d+$/.test(decimal)) {
    throw new TypeError("Expected a string of decimal digits");
  }
  let hex = BigInt(decimal).toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return hexToBytes(hex);
}

export function hexToBytes(hex: string): Bytes {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new TypeError("Invalid hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Bytes {
  const binary = atob(base64.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Copies any byte view into a fresh ArrayBuffer-backed array. */
export function toBytes(view: Uint8Array): Bytes {
  const out = new Uint8Array(view.length);
  out.set(view);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** "a1b2c3" -> "A1:B2:C3" */
export function formatFingerprint(hex: string): string {
  return (hex.toUpperCase().match(/../g) ?? []).join(":");
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(data));
  return bytesToHex(new Uint8Array(digest));
}
