// SPDX-License-Identifier: MIT
export interface SecureQrFields {
  version?: string | null;
  indicator: string;
  referenceId: string;
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
  mobile?: string;
  photo: Uint8Array;
  maskedEmail?: string;
  emailHash?: Uint8Array;
  mobileHash?: Uint8Array;
}

export function concat(parts: Uint8Array[]): Uint8Array;
export function buildSignedData(fields: SecureQrFields): Uint8Array;
export function toQrDigits(signedData: Uint8Array, signature: Uint8Array): string;
export function replaceField(signedData: Uint8Array, fieldIndex: number, value: string): Uint8Array;
