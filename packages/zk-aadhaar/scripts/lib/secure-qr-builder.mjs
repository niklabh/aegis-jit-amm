// SPDX-License-Identifier: MIT
// Builds synthetic Aadhaar Secure QR payloads for tests and demo samples.
// Mirrors the real layout: 0xFF-delimited text fields, photo, optional
// trailer, then a 256-byte SHA256withRSA signature, GZIP-compressed and
// written as one big base-10 integer.
import { gzipSync } from "node:zlib";

const DELIMITER = 0xff;
const encoder = new TextEncoder();

/** @param {Uint8Array[]} parts */
export function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * @typedef {object} SecureQrFields
 * @property {string | null} [version]  "V2"/"V5"…; null or omitted = legacy (2019) layout
 * @property {string} indicator         "0"–"3" (1 = e-mail, 2 = mobile, 3 = both)
 * @property {string} referenceId       last 4 Aadhaar digits + YYYYMMDDHHMMSSmmm
 * @property {string} name
 * @property {string} dob
 * @property {string} gender
 * @property {string} careOf
 * @property {string} district
 * @property {string} landmark
 * @property {string} house
 * @property {string} location
 * @property {string} pincode
 * @property {string} postOffice
 * @property {string} state
 * @property {string} street
 * @property {string} subDistrict
 * @property {string} vtc
 * @property {string} [mobile]          versioned layout: "1234" or "XXXXXX1234"
 * @property {Uint8Array} photo
 * @property {string} [maskedEmail]     newer versions: appended right after the photo
 * @property {Uint8Array} [emailHash]   legacy layout: 32 bytes
 * @property {Uint8Array} [mobileHash]  legacy layout: 32 bytes
 */

/** @param {SecureQrFields} f */
export function buildSignedData(f) {
  const versioned = Boolean(f.version);
  const values = [
    ...(versioned ? [f.version] : []),
    f.indicator,
    f.referenceId,
    f.name,
    f.dob,
    f.gender,
    f.careOf,
    f.district,
    f.landmark,
    f.house,
    f.location,
    f.pincode,
    f.postOffice,
    f.state,
    f.street,
    f.subDistrict,
    f.vtc,
    ...(versioned ? [f.mobile ?? ""] : []),
  ];
  const parts = values.flatMap((value) => [encoder.encode(String(value)), Uint8Array.of(DELIMITER)]);
  parts.push(f.photo);
  if (versioned) {
    if (f.maskedEmail) parts.push(encoder.encode(f.maskedEmail));
  } else {
    if (f.emailHash) parts.push(f.emailHash);
    if (f.mobileHash) parts.push(f.mobileHash);
  }
  return concat(parts);
}

/**
 * GZIP(signedData ‖ signature) as the decimal string a Secure QR encodes.
 * @param {Uint8Array} signedData
 * @param {Uint8Array} signature
 */
export function toQrDigits(signedData, signature) {
  const compressed = gzipSync(concat([signedData, signature]), { level: 9 });
  return BigInt(`0x${Buffer.from(compressed).toString("hex")}`).toString(10);
}

/**
 * Replaces the bytes of one delimited text field (0-based index) — used to
 * simulate tampering while keeping the original signature.
 * @param {Uint8Array} signedData
 * @param {number} fieldIndex
 * @param {string} value
 */
export function replaceField(signedData, fieldIndex, value) {
  let start = 0;
  for (let i = 0; i < fieldIndex; i++) start = signedData.indexOf(DELIMITER, start) + 1;
  const end = signedData.indexOf(DELIMITER, start);
  return concat([signedData.subarray(0, start), encoder.encode(value), signedData.subarray(end)]);
}
