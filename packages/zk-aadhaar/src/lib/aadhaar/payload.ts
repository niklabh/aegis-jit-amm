// SPDX-License-Identifier: MIT
import { decimalToBytes, toBytes, type Bytes } from "./bytes";
import { AadhaarQrError } from "./errors";

/**
 * What a QR decoder hands over: the decoded text and, when the decoder exposes
 * it, the raw payload bytes (no character-set conversion applied).
 */
export interface QrScan {
  text: string;
  bytes?: Uint8Array | null;
}

// Real Secure QR payloads are ~2,500–4,000 digits. Anything much shorter
// cannot hold a 256-byte signature plus the demographic data.
const MIN_SECURE_QR_DIGITS = 600;
// Largest numeric payload a QR code can carry (version 40, level L).
const MAX_QR_NUMERIC_DIGITS = 7089;

/**
 * Turns a scanned QR into the compressed Secure QR byte stream.
 *
 * UIDAI encodes the Secure QR as one huge base-10 integer in QR numeric mode.
 * That integer, written big-endian, is a GZIP stream. Should a QR ever carry
 * the compressed stream directly in byte mode, the raw bytes are used as-is.
 */
export function extractCompressedPayload(scan: QrScan): Bytes {
  const text = (scan.text ?? "").trim();

  if (/^\d+$/.test(text)) {
    if (text.length < MIN_SECURE_QR_DIGITS || text.length > MAX_QR_NUMERIC_DIGITS) {
      throw new AadhaarQrError(
        "NOT_AADHAAR",
        "This QR code contains a number, but not an Aadhaar Secure QR payload.",
      );
    }
    const bytes = decimalToBytes(text);
    if (!hasCompressionHeader(bytes)) {
      throw new AadhaarQrError(
        "NOT_AADHAAR",
        "This QR code contains a number, but not an Aadhaar Secure QR payload.",
      );
    }
    return bytes;
  }

  if (scan.bytes && hasCompressionHeader(scan.bytes)) {
    return toBytes(scan.bytes);
  }

  if (looksLikeLegacyXml(text)) {
    throw new AadhaarQrError(
      "LEGACY_XML",
      "This is an older Aadhaar QR code (plain XML). It has no digital signature, so it cannot be verified. Use the Secure QR printed on newer Aadhaar letters, PVC cards or e-Aadhaar.",
    );
  }

  throw new AadhaarQrError("NOT_AADHAAR", "This QR code is not an Aadhaar Secure QR.");
}

/** GZIP (1F 8B) or zlib (CMF/FLG checksum) header. */
export function hasCompressionHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return true;
  return (bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0;
}

function looksLikeLegacyXml(text: string): boolean {
  return /^<\?xml|<PrintLetterBarcodeData|<QPD[AB]\b|\buid\s*=\s*"\d{12}"/i.test(text);
}
