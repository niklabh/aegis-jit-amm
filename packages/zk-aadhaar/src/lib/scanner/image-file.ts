// SPDX-License-Identifier: MIT
import type { QrDecoder } from "./decoder";
import type { DecodedQr } from "./engine";
import { FrameGrabber } from "./frames";

interface LoadedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  release(): void;
}

async function loadImage(file: Blob): Promise<LoadedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Fall through to <img>, which can decode more formats on some browsers (e.g. HEIC on Safari).
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/**
 * Finds a QR code in a photo or screenshot. Tries a few resolutions with a
 * white quiet zone added, since screenshots are often cropped right to the code.
 */
export async function decodeQrFromImageFile(file: Blob, decoder: QrDecoder): Promise<DecodedQr | null> {
  const image = await loadImage(file);
  try {
    const longest = Math.max(image.width, image.height);
    const sizes = [Math.min(longest, 2400), Math.min(longest, 1500), Math.min(longest, 1000)];
    if (longest < 900) sizes.push(longest * 2);
    const grabber = new FrameGrabber();
    const whole = { sx: 0, sy: 0, sw: image.width, sh: image.height };
    for (const size of new Set(sizes)) {
      // grab() only shrinks; small screenshots get a nearest-neighbour upscale instead.
      const frame = size > longest ? upscale(image, size) : grabber.grab(image.source, whole, size, 0.06);
      if (!frame) continue;
      const result = await decoder.decode(frame, "still");
      if (result) return result;
    }
    return null;
  } finally {
    image.release();
  }
}

function upscale(image: LoadedImage, longestSide: number): ImageData | null {
  const factor = longestSide / Math.max(image.width, image.height);
  const w = Math.round(image.width * factor);
  const h = Math.round(image.height * factor);
  const pad = Math.round(Math.max(w, h) * 0.06);
  const canvas = document.createElement("canvas");
  canvas.width = w + 2 * pad;
  canvas.height = h + 2 * pad;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(image.source, pad, pad, w, h);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}
