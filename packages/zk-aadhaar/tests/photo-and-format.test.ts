// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeAddress, describeDob, genderLabel, maskAadhaar } from "@/lib/aadhaar/format";
import type { SecureQrData } from "@/lib/aadhaar/parse";
import { decodeJpeg2000, readJpeg2000Size } from "@/lib/photo/jpeg2000";
import { demoPhoto } from "./helpers";

/** Reads a binary PPM (P6), skipping "#" comment lines. */
function readPpm(path: string) {
  const b = readFileSync(new URL(path, import.meta.url));
  let p = 0;
  const token = () => {
    for (;;) {
      while (b[p] === 0x20 || b[p] === 0x0a || b[p] === 0x0d || b[p] === 0x09) p++;
      if (b[p] !== 0x23) break;
      while (b[p] !== 0x0a) p++;
    }
    let s = "";
    while (![0x20, 0x0a, 0x0d, 0x09].includes(b[p])) s += String.fromCharCode(b[p++]);
    return s;
  };
  token();
  const width = Number(token());
  const height = Number(token());
  token();
  p++;
  return { width, height, rgb: b.subarray(p, p + width * height * 3) };
}

function maxDifference(rgba: Uint8ClampedArray, rgb: Uint8Array) {
  let max = 0;
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
    for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(rgba[i + c] - rgb[j + c]));
  }
  return max;
}

function psnr(rgba: Uint8ClampedArray, rgb: Uint8Array) {
  let squared = 0;
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
    for (let c = 0; c < 3; c++) squared += (rgba[i + c] - rgb[j + c]) ** 2;
  }
  return 10 * Math.log10((255 * 255) / (squared / rgb.length));
}

describe("decodeJpeg2000 (vs. OpenJPEG reference output)", () => {
  // The fixtures use the same coding parameters as real Secure QR photos:
  // 9/7 irreversible wavelet, explicit quantization, 5 levels, SOP markers.
  it("decodes a raw J2K codestream like the one in Secure QR codes", () => {
    const image = decodeJpeg2000(demoPhoto());
    const ref = readPpm("fixtures/demo-photo.ref.ppm");
    expect([image.width, image.height]).toEqual([ref.width, ref.height]);
    expect(maxDifference(image.rgba, ref.rgb)).toBeLessThanOrEqual(2);
  });

  it("decodes a boxed JP2 file", () => {
    const image = decodeJpeg2000(new Uint8Array(readFileSync(new URL("fixtures/avatar.jp2", import.meta.url))));
    const ref = readPpm("fixtures/avatar.ref.ppm");
    expect(image.width).toBe(60);
    expect(maxDifference(image.rgba, ref.rgb)).toBeLessThanOrEqual(2);
  });

  it("decodes lossy reversible (5/3) codestreams within visual tolerance", () => {
    // Not used by Aadhaar; the JS decoder reconstructs truncated bit-planes
    // slightly differently from OpenJPEG here, so only PSNR is asserted.
    const image = decodeJpeg2000(new Uint8Array(readFileSync(new URL("fixtures/avatar-53.j2k", import.meta.url))));
    expect(psnr(image.rgba, readPpm("fixtures/avatar-53.ref.ppm").rgb)).toBeGreaterThan(35);
  });

  it("ignores bytes after the end-of-codestream marker", () => {
    const withTrailer = new Uint8Array([...demoPhoto(), ...new TextEncoder().encode("axxxxxx1@gxxxxx")]);
    expect(decodeJpeg2000(withTrailer).width).toBe(60);
  });

  it("refuses images that claim absurd dimensions before decoding", () => {
    const hostile = demoPhoto();
    expect(readJpeg2000Size(hostile)).toEqual({ width: 60, height: 60 });
    new DataView(hostile.buffer).setUint32(8, 100_000); // Xsiz
    new DataView(hostile.buffer).setUint32(12, 100_000); // Ysiz
    expect(() => decodeJpeg2000(hostile)).toThrow(/implausibly large/);
  });
});

describe("display formatting", () => {
  it("masks the Aadhaar number", () => {
    expect(maskAadhaar("1234")).toBe("XXXX XXXX 1234");
  });

  it("describes dates of birth and ages", () => {
    const today = new Date(2026, 10, 4);
    expect(describeDob("15-08-1994", today)).toEqual({ display: "15 Aug 1994", age: 32 });
    expect(describeDob("05-12-1994", today).age).toBe(31);
    expect(describeDob("1980", today)).toEqual({ display: "1980 (year of birth)", age: 46 });
  });

  it("labels gender codes", () => {
    expect([genderLabel("M"), genderLabel("F"), genderLabel("T")]).toEqual(["Male", "Female", "Transgender"]);
  });

  it("composes the address in Aadhaar letter order without repeats", () => {
    const d = {
      careOf: "D/O: Ravi",
      house: "42",
      street: "MG Road",
      landmark: "",
      location: "Sample Nagar",
      vtc: "Bengaluru",
      postOffice: "Bangalore GPO",
      subDistrict: "bengaluru",
      district: "Bengaluru Urban",
      state: "Karnataka",
      pincode: "560001",
    } as SecureQrData;
    expect(composeAddress(d)).toBe(
      "D/O: Ravi, 42, MG Road, Sample Nagar, Bengaluru, PO: Bangalore GPO, Bengaluru Urban, Karnataka – 560001",
    );
  });
});
