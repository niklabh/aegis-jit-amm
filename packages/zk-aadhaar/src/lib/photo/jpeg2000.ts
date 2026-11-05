// SPDX-License-Identifier: MIT
import { JpxImage } from "jpeg2000";

/**
 * The `jpeg2000` package (a pure-JS port of PDF.js's JPX decoder) reads header
 * fields through three Node `Buffer` methods. This subclass provides them on a
 * plain Uint8Array so the decoder runs in browsers with no Buffer polyfill.
 */
class ByteSource extends Uint8Array {
  readInt8(offset: number): number {
    const value = this[offset];
    return value > 127 ? value - 256 : value;
  }

  readUInt16BE(offset: number): number {
    return (this[offset] << 8) | this[offset + 1];
  }

  readUInt32BE(offset: number): number {
    return ((this[offset] << 24) | (this[offset + 1] << 16) | (this[offset + 2] << 8) | this[offset + 3]) >>> 0;
  }
}

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

// Secure QR photos are about 60×60. Refuse anything absurd before the
// (synchronous) decoder tries to allocate memory for it.
const MAX_PIXELS = 4_000_000;

/** Image size from the SIZ marker (J2K, or the codestream inside a JP2 file). */
export function readJpeg2000Size(bytes: Uint8Array): { width: number; height: number } | null {
  const u32 = (p: number) => ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  const limit = Math.min(bytes.length - 23, 4096);
  for (let p = 0; p < limit; p++) {
    // SIZ always directly follows SOC (FF4F) at the start of a codestream.
    if (bytes[p] === 0xff && bytes[p + 1] === 0x4f && bytes[p + 2] === 0xff && bytes[p + 3] === 0x51) {
      const siz = p + 4;
      const width = u32(siz + 4) - u32(siz + 12);
      const height = u32(siz + 8) - u32(siz + 16);
      return width > 0 && height > 0 ? { width, height } : null;
    }
  }
  return null;
}

/** Decodes a JPEG 2000 codestream (J2K) or JP2 file into RGBA pixels. */
export function decodeJpeg2000(bytes: Uint8Array): DecodedImage {
  const size = readJpeg2000Size(bytes);
  if (!size || size.width * size.height > MAX_PIXELS) {
    throw new Error("The photo has an invalid or implausibly large size.");
  }

  const source = new ByteSource(bytes.length);
  source.set(bytes);

  const jpx = new JpxImage();
  jpx.parse(source);

  const { width, height, componentsCount: components, tiles } = jpx;
  if (!width || !height || !tiles?.length) {
    throw new Error("The photo is not a decodable JPEG 2000 image.");
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const originX = Math.min(...tiles.map((t) => t.left));
  const originY = Math.min(...tiles.map((t) => t.top));

  for (const tile of tiles) {
    const { items } = tile;
    for (let y = 0; y < tile.height; y++) {
      const dy = tile.top - originY + y;
      if (dy >= height) break;
      for (let x = 0; x < tile.width; x++) {
        const dx = tile.left - originX + x;
        if (dx >= width) break;
        const s = (y * tile.width + x) * components;
        const d = (dy * width + dx) * 4;
        if (components >= 3) {
          rgba[d] = items[s];
          rgba[d + 1] = items[s + 1];
          rgba[d + 2] = items[s + 2];
        } else {
          rgba[d] = rgba[d + 1] = rgba[d + 2] = items[s];
        }
        rgba[d + 3] = 255;
      }
    }
  }
  return { width, height, rgba };
}
