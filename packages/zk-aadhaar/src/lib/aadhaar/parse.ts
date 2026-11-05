// SPDX-License-Identifier: MIT
import { inflate } from "pako";
import { toBytes, type Bytes } from "./bytes";
import { AadhaarQrError } from "./errors";

/**
 * Aadhaar Secure QR layout (after base-10 → bytes → GZIP inflate):
 *
 *   [field]FF[field]FF … [field]FF [photo] [extra] [256-byte RSA signature]
 *
 * The signature (SHA256withRSA, PKCS#1 v1.5) covers every decompressed byte
 * before it. Text fields are separated by 0xFF, a value UTF-8 text never
 * contains. Only the known number of delimiters is consumed: the photo is
 * binary and may itself contain 0xFF bytes.
 *
 * Legacy layout (2019, no version marker), 16 fields:
 *   indicator, referenceId, name, dob, gender, careOf, district, landmark,
 *   house, location, pincode, postOffice, state, street, subDistrict, vtc
 *   then photo, then 32-byte SHA-256 email/mobile hashes per the indicator.
 *
 * Versioned layout ("V2", "V3", "V5" …), 18 fields:
 *   version, the same 16 fields, mobile (last 4 digits, or "XXXXXX1234")
 *   then the photo. Newer versions append the masked e-mail directly after
 *   the photo's JPEG 2000 codestream, so the photo length is taken from the
 *   codestream itself rather than assumed to run up to the signature.
 */

export const SIGNATURE_LENGTH = 256;
const DELIMITER = 0xff;
const HASH_LENGTH = 32;
const MAX_DECOMPRESSED_BYTES = 64 * 1024;

/** Versions whose layout has been checked against published decoders or a real card. */
const CONFIRMED_VERSIONS = new Set(["V2", "V3", "V5"]);

const COMMON_FIELDS = [
  "emailMobileIndicator",
  "referenceId",
  "name",
  "dob",
  "gender",
  "careOf",
  "district",
  "landmark",
  "house",
  "location",
  "pincode",
  "postOffice",
  "state",
  "street",
  "subDistrict",
  "vtc",
] as const;

export type PhotoFormat = "j2k" | "jp2" | "jpeg" | "png" | "unknown";

export interface QrTimestamp {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface SecureQrData {
  layout: "legacy" | "versioned";
  /** "V2", "V5", … or "legacy" for the 2019 layout without a version marker. */
  version: string;
  emailMobileIndicator: number;
  hasEmail: boolean;
  hasMobile: boolean;
  referenceId: string;
  /** The Secure QR never contains the full Aadhaar number — only its last 4 digits. */
  aadhaarLast4: string | null;
  /** When UIDAI generated (and signed) this QR, from the reference ID (IST). */
  generatedAt: QrTimestamp | null;
  name: string;
  dob: string;
  gender: string;
  careOf: string;
  district: string;
  landmark: string;
  house: string;
  location: string;
  pincode: string;
  postOffice: string;
  state: string;
  street: string;
  subDistrict: string;
  vtc: string;
  /** Mobile as encoded by UIDAI: "1234" or "XXXXXX1234" (versioned layout only). */
  maskedMobile: string | null;
  mobileLast4: string | null;
  /** Masked e-mail appended after the photo by newer versions, e.g. "axxxxxx1@gxxxxx". */
  maskedEmail: string | null;
  /** Legacy layout only: SHA-256-based hashes UIDAI uses for e-mail/mobile matching. */
  emailHash: Bytes | null;
  mobileHash: Bytes | null;
}

export interface ParsedSecureQr {
  data: SecureQrData;
  photo: Bytes | null;
  photoFormat: PhotoFormat;
  /** Every decompressed byte before the signature — exactly what UIDAI signed. */
  signedData: Bytes;
  signature: Bytes;
  compressedLength: number;
  decompressedLength: number;
  warnings: string[];
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");

function decodeText(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return latin1.decode(bytes);
  }
}

export function decompressPayload(compressed: Uint8Array): Bytes {
  let out: Uint8Array | undefined;
  try {
    // pako auto-detects the GZIP / zlib wrapper from the header.
    out = inflate(compressed);
  } catch {
    out = undefined;
  }
  if (!(out instanceof Uint8Array) || out.length === 0) {
    throw new AadhaarQrError(
      "DECOMPRESS_FAILED",
      "The QR payload could not be decompressed. It may be damaged or not an Aadhaar Secure QR.",
    );
  }
  if (out.length > MAX_DECOMPRESSED_BYTES) {
    throw new AadhaarQrError("MALFORMED", "The QR payload is unexpectedly large.");
  }
  return toBytes(out);
}

export function parseSecureQr(compressed: Uint8Array): ParsedSecureQr {
  const bytes = decompressPayload(compressed);
  if (bytes.length <= SIGNATURE_LENGTH + 16) {
    throw new AadhaarQrError("MALFORMED", "The Secure QR payload is too short.");
  }

  const signedEnd = bytes.length - SIGNATURE_LENGTH;
  const signedData = bytes.subarray(0, signedEnd);
  const signature = bytes.subarray(signedEnd);
  const warnings: string[] = [];

  const firstDelimiter = signedData.indexOf(DELIMITER);
  if (firstDelimiter === -1) {
    throw new AadhaarQrError("MALFORMED", "The Secure QR payload has no data fields.");
  }
  const marker = latin1.decode(signedData.subarray(0, firstDelimiter));

  let layout: SecureQrData["layout"];
  let version: string;
  let names: readonly string[];
  if (/^V\d{1,3}$/.test(marker)) {
    layout = "versioned";
    version = marker;
    names = ["version", ...COMMON_FIELDS, "mobile"];
    if (!CONFIRMED_VERSIONS.has(version)) {
      warnings.push(
        `This QR uses format ${version}, which this app has not been tested with. The signature check is unaffected, but some fields may be labelled incorrectly.`,
      );
    }
  } else if (/^[0-3]$/.test(marker)) {
    layout = "legacy";
    version = "legacy";
    names = COMMON_FIELDS;
  } else {
    throw new AadhaarQrError("MALFORMED", "Unrecognised Secure QR layout.");
  }

  const values: Record<string, string> = {};
  let offset = 0;
  for (const name of names) {
    const end = signedData.indexOf(DELIMITER, offset);
    if (end === -1) {
      throw new AadhaarQrError("MALFORMED", "The Secure QR payload has fewer fields than expected.");
    }
    values[name] = decodeText(signedData.subarray(offset, end)).trim();
    offset = end + 1;
  }
  const photoStart = offset;

  if (!/^[0-3]$/.test(values.emailMobileIndicator)) {
    throw new AadhaarQrError("MALFORMED", "The Secure QR e-mail/mobile indicator is not recognised.");
  }
  const indicator = Number(values.emailMobileIndicator);
  const hasEmail = (indicator & 1) === 1;
  const hasMobile = (indicator & 2) === 2;

  // Legacy layout: e-mail hash, then mobile hash, sit between photo and signature.
  let regionEnd = signedEnd;
  let emailHash: Bytes | null = null;
  let mobileHash: Bytes | null = null;
  if (layout === "legacy") {
    regionEnd = signedEnd - (Number(hasEmail) + Number(hasMobile)) * HASH_LENGTH;
    if (regionEnd < photoStart) {
      throw new AadhaarQrError("MALFORMED", "The Secure QR payload is truncated.");
    }
    let p = regionEnd;
    if (hasEmail) {
      emailHash = signedData.slice(p, p + HASH_LENGTH);
      p += HASH_LENGTH;
    }
    if (hasMobile) {
      mobileHash = signedData.slice(p, p + HASH_LENGTH);
    }
  }

  const region = signedData.subarray(photoStart, regionEnd);
  const photoFormat = region.length > 0 ? detectImageFormat(region) : "unknown";
  const photoLength = region.length > 0 ? (measureImageLength(region, photoFormat) ?? region.length) : 0;
  const photo = photoLength > 0 ? signedData.slice(photoStart, photoStart + photoLength) : null;
  const maskedEmail = parseMaskedEmail(region.subarray(photoLength));

  const referenceId = values.referenceId;
  const maskedMobile = layout === "versioned" && values.mobile ? values.mobile : null;

  return {
    data: {
      layout,
      version,
      emailMobileIndicator: indicator,
      hasEmail,
      hasMobile,
      referenceId,
      aadhaarLast4: /^\d{4}/.test(referenceId) ? referenceId.slice(0, 4) : null,
      generatedAt: parseReferenceTimestamp(referenceId.slice(4)),
      name: values.name,
      dob: values.dob,
      gender: values.gender,
      careOf: values.careOf,
      district: values.district,
      landmark: values.landmark,
      house: values.house,
      location: values.location,
      pincode: values.pincode,
      postOffice: values.postOffice,
      state: values.state,
      street: values.street,
      subDistrict: values.subDistrict,
      vtc: values.vtc,
      maskedMobile,
      mobileLast4: maskedMobile?.match(/(\d{4})$/)?.[1] ?? null,
      maskedEmail,
      emailHash,
      mobileHash,
    },
    photo,
    photoFormat,
    signedData,
    signature,
    compressedLength: compressed.length,
    decompressedLength: bytes.length,
    warnings,
  };
}

/** "YYYYMMDDHHMMSS[mmm]" → parts, or null when the shape is wrong. */
export function parseReferenceTimestamp(value: string): QrTimestamp | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\d{0,3}$/.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return { year, month, day, hour, minute, second };
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

export function detectImageFormat(bytes: Uint8Array): PhotoFormat {
  if (startsWith(bytes, [0xff, 0x4f, 0xff, 0x51])) return "j2k";
  if (startsWith(bytes, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a])) return "jp2";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  return "unknown";
}

const u16 = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];
const u32 = (b: Uint8Array, p: number) =>
  ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

/** Byte length of the image at the start of `bytes`, from its own structure. */
export function measureImageLength(bytes: Uint8Array, format: PhotoFormat): number | null {
  switch (format) {
    case "j2k":
      return measureJ2kCodestream(bytes, 0);
    case "jp2":
      return measureJp2(bytes);
    case "jpeg":
      return measureJpeg(bytes);
    case "png":
      return measurePng(bytes);
    default:
      return null;
  }
}

/** Walks the JPEG 2000 codestream markers (tile-parts via Psot) up to EOC. */
function measureJ2kCodestream(b: Uint8Array, start: number): number | null {
  if (start + 4 > b.length || u16(b, start) !== 0xff4f) return null;
  let p = start + 2;
  while (p + 4 <= b.length) {
    const marker = u16(b, p);
    if (marker === 0xffd9) return p + 2 - start; // EOC
    if ((marker & 0xff00) !== 0xff00) return null;
    if (marker === 0xff90) {
      // SOT: Psot is the tile-part length (0 = runs to EOC).
      if (p + 12 > b.length) return null;
      const psot = u32(b, p + 6);
      if (psot === 0) {
        // Bit-stuffing means FF D9 cannot occur inside packet data.
        for (let q = p + 12; q + 1 < b.length; q++) {
          if (b[q] === 0xff && b[q + 1] === 0xd9) return q + 2 - start;
        }
        return null;
      }
      p += psot;
      continue;
    }
    const length = u16(b, p + 2);
    if (length < 2) return null;
    p += 2 + length;
  }
  return null;
}

/** Walks JP2 boxes; the image ends after the last well-formed box. */
function measureJp2(b: Uint8Array): number | null {
  const JP2C = 0x6a703263; // 'jp2c'
  let p = 0;
  let sawCodestream = false;
  while (p + 8 <= b.length) {
    let length = u32(b, p);
    const type = u32(b, p + 4);
    let header = 8;
    if (length === 1) {
      if (p + 16 > b.length) break;
      length = u32(b, p + 8) * 2 ** 32 + u32(b, p + 12);
      header = 16;
    } else if (length === 0) {
      // Box runs to the end of the data; for a codestream, trust its EOC instead.
      if (type !== JP2C) return b.length;
      const inner = measureJ2kCodestream(b, p + header);
      return inner === null ? b.length : p + header + inner;
    }
    if (length < header || p + length > b.length) break;
    if (type === JP2C) sawCodestream = true;
    p += length;
  }
  return sawCodestream ? p : null;
}

function measureJpeg(b: Uint8Array): number | null {
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return null;
    const marker = b[p + 1];
    if (marker === 0xd9) return p + 2; // EOI
    if (marker === 0xff) {
      p += 1;
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p += 2;
      continue;
    }
    const length = u16(b, p + 2);
    if (marker === 0xda) {
      // Skip entropy-coded data: stop at a marker that is not stuffing or RSTn.
      let q = p + 2 + length;
      while (q + 1 < b.length) {
        const next = b[q + 1];
        if (b[q] === 0xff && next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
        q += 1;
      }
      p = q;
      continue;
    }
    p += 2 + length;
  }
  return null;
}

function measurePng(b: Uint8Array): number | null {
  const IEND = 0x49454e44;
  let p = 8;
  while (p + 12 <= b.length) {
    const length = u32(b, p);
    const type = u32(b, p + 4);
    p += 12 + length;
    if (type === IEND) return p <= b.length ? p : null;
  }
  return null;
}

function parseMaskedEmail(bytes: Uint8Array): string | null {
  if (bytes.length < 3 || bytes.length > 254) return null;
  for (const c of bytes) {
    if (c < 0x21 || c > 0x7e) return null;
  }
  const text = latin1.decode(bytes);
  return /^[^@\s]+@[^@\s]+$/.test(text) ? text : null;
}
