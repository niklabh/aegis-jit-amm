// SPDX-License-Identifier: MIT
export interface CropRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Maps the on-screen targeting box onto video pixels. The <video> uses
 * `object-fit: cover`, so the visible area is a centred crop of the frame.
 * A margin is added so a code that pokes slightly outside the box still reads.
 */
export function computeCropRect(video: HTMLVideoElement, box: DOMRect | null, margin = 0.12): CropRect {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const full = { sx: 0, sy: 0, sw: vw, sh: vh };
  const view = video.getBoundingClientRect();
  if (!box || view.width === 0 || view.height === 0) return full;

  const scale = Math.max(view.width / vw, view.height / vh);
  const offsetX = (vw * scale - view.width) / 2;
  const offsetY = (vh * scale - view.height) / 2;
  const w = box.width / scale;
  const h = box.height / scale;
  const x = (box.left - view.left + offsetX) / scale - w * margin;
  const y = (box.top - view.top + offsetY) / scale - h * margin;

  const sx = clamp(Math.floor(x), 0, vw);
  const sy = clamp(Math.floor(y), 0, vh);
  const ex = clamp(Math.ceil(x + w * (1 + 2 * margin)), 0, vw);
  const ey = clamp(Math.ceil(y + h * (1 + 2 * margin)), 0, vh);
  if (ex - sx < 64 || ey - sy < 64) return full;
  return { sx, sy, sw: ex - sx, sh: ey - sy };
}

/** Copies (part of) a frame into a reusable canvas and returns its pixels. */
export class FrameGrabber {
  private readonly canvas = document.createElement("canvas");
  private readonly context = this.canvas.getContext("2d", { willReadFrequently: true });

  grab(source: CanvasImageSource, rect: CropRect, maxSide: number, padding = 0): ImageData | null {
    if (!this.context || rect.sw === 0 || rect.sh === 0) return null;
    const scale = Math.min(1, maxSide / Math.max(rect.sw, rect.sh));
    const w = Math.max(1, Math.round(rect.sw * scale));
    const h = Math.max(1, Math.round(rect.sh * scale));
    const pad = Math.round(Math.max(w, h) * padding);
    const cw = w + 2 * pad;
    const ch = h + 2 * pad;
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    if (pad > 0) {
      // White quiet zone for tightly cropped screenshots.
      this.context.fillStyle = "#fff";
      this.context.fillRect(0, 0, cw, ch);
    }
    this.context.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, pad, pad, w, h);
    return this.context.getImageData(0, 0, cw, ch);
  }
}
