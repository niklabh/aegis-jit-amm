// SPDX-License-Identifier: MIT
import { bytesToBase64 } from "@/lib/aadhaar/bytes";
import type { PhotoFormat } from "@/lib/aadhaar/parse";

/**
 * Turns the photo bytes from the QR into a base64 JPEG data URL.
 *
 * Aadhaar Secure QR photos are JPEG 2000, which only Safari can display
 * natively, so they are decoded in JS (lazy-loaded chunk) and re-encoded as
 * JPEG on a canvas. Nothing leaves the device.
 */
export async function photoToDataUrl(photo: Uint8Array, format: PhotoFormat): Promise<string> {
  if (format === "jpeg") return `data:image/jpeg;base64,${bytesToBase64(photo)}`;
  if (format === "png") return `data:image/png;base64,${bytesToBase64(photo)}`;
  if (format !== "j2k" && format !== "jp2") {
    throw new Error("Unsupported photo format.");
  }

  const { decodeJpeg2000 } = await import("./jpeg2000");
  const image = decodeJpeg2000(photo);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.putImageData(new ImageData(image.rgba, image.width, image.height), 0, 0);
  return canvas.toDataURL("image/jpeg", 0.95);
}
