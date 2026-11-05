// SPDX-License-Identifier: MIT
export type FacingMode = "environment" | "user";

export interface CameraProblem {
  kind: "permission" | "not-found" | "in-use" | "insecure" | "unsupported" | "unknown";
  message: string;
}

class CameraStartError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** Opens the camera, preferring HD so dense Aadhaar QR modules stay sharp. */
export async function openCamera(facingMode: FacingMode): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new CameraStartError("InsecureContextError", "Camera needs HTTPS");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraStartError("UnsupportedError", "getUserMedia is unavailable");
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }
    throw error;
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

type ExtendedCapabilities = MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] };

function capabilities(track: MediaStreamTrack): ExtendedCapabilities {
  try {
    return (track.getCapabilities?.() ?? {}) as ExtendedCapabilities;
  } catch {
    return {};
  }
}

/** Continuous autofocus where the browser exposes it (Chrome on Android). */
export async function enableContinuousFocus(track: MediaStreamTrack): Promise<void> {
  if (!capabilities(track).focusMode?.includes("continuous")) return;
  await track
    .applyConstraints({ advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] })
    .catch(() => undefined);
}

export function supportsTorch(track: MediaStreamTrack): boolean {
  return capabilities(track).torch === true;
}

export async function setTorch(track: MediaStreamTrack, on: boolean): Promise<boolean> {
  try {
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

export async function countVideoInputs(): Promise<number> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "videoinput").length;
  } catch {
    return 0;
  }
}

export function describeCameraError(error: unknown): CameraProblem {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return {
        kind: "permission",
        message:
          "Camera access was blocked. Allow camera access for this site in your browser settings, or upload a photo of the QR code instead.",
      };
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return { kind: "not-found", message: "No camera was found. You can upload a photo or screenshot of the QR code instead." };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return { kind: "in-use", message: "The camera could not be started. It may be in use by another app or tab." };
    case "InsecureContextError":
      return {
        kind: "insecure",
        message: "Browsers only allow camera access over HTTPS (or on localhost). Open this page over HTTPS to scan.",
      };
    case "UnsupportedError":
      return { kind: "unsupported", message: "This browser does not support camera access. Upload a photo of the QR code instead." };
    default:
      return { kind: "unknown", message: "The camera could not be started." };
  }
}
