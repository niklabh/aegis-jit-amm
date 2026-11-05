// SPDX-License-Identifier: MIT
export type AadhaarQrErrorCode =
  /** The QR code decoded fine but it is not an Aadhaar Secure QR. */
  | "NOT_AADHAAR"
  /** Pre-2018 Aadhaar QR: plain XML with no digital signature. */
  | "LEGACY_XML"
  /** The payload looked like a Secure QR but could not be decompressed. */
  | "DECOMPRESS_FAILED"
  /** The decompressed payload does not have the expected structure. */
  | "MALFORMED";

export class AadhaarQrError extends Error {
  readonly code: AadhaarQrErrorCode;

  constructor(code: AadhaarQrErrorCode, message: string) {
    super(message);
    this.name = "AadhaarQrError";
    this.code = code;
  }
}

export function isAadhaarQrError(value: unknown): value is AadhaarQrError {
  return value instanceof AadhaarQrError;
}
