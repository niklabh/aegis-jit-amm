// SPDX-License-Identifier: MIT
"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import {
  countVideoInputs,
  describeCameraError,
  enableContinuousFocus,
  openCamera,
  setTorch,
  stopStream,
  supportsTorch,
  type CameraProblem,
  type FacingMode,
} from "@/lib/scanner/camera";
import type { DecodedQr } from "@/lib/scanner/engine";
import { computeCropRect, FrameGrabber } from "@/lib/scanner/frames";
import { getQrDecoder } from "@/lib/scanner/shared-decoder";

export type CameraStatus = "off" | "starting" | "live" | "error";

interface SessionState {
  session: string;
  status: "live" | "error";
  problem: CameraProblem | null;
  torchSupported: boolean;
  torchOn: boolean;
  canSwitch: boolean;
  mirrored: boolean;
}

interface Options {
  active: boolean;
  facingMode: FacingMode;
  videoRef: RefObject<HTMLVideoElement | null>;
  targetRef: RefObject<HTMLElement | null>;
  /** Return true to stop scanning (a usable code was found). */
  onDecoded: (qr: DecodedQr) => boolean;
}

const FRAME_INTERVAL_MS = 60;

/**
 * Runs the camera and a decode loop while `active`. Frames are cropped to the
 * on-screen targeting box (every third frame uses the whole picture) and sent
 * to the decoder worker one at a time. The stream is stopped as soon as the
 * scanner deactivates or unmounts.
 */
export function useQrCamera({ active, facingMode, videoRef, targetRef, onDecoded }: Options) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SessionState | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const handleDecoded = useEffectEvent(onDecoded);

  // Each activation is a new session, so a restart shows "starting" rather
  // than the previous session's state (React's "adjust state on prop change").
  const [activation, setActivation] = useState({ active, count: 0 });
  if (activation.active !== active) {
    setActivation({ active, count: active ? activation.count + 1 : activation.count });
  }
  const session = `${facingMode}:${attempt}:${activation.count}`;

  useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grabber = new FrameGrabber();
    const decoder = getQrDecoder();
    let frame = 0;

    const scan = async () => {
      if (cancelled) return;
      let found = false;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        const wholeFrame = frame++ % 3 === 2;
        const rect = wholeFrame
          ? { sx: 0, sy: 0, sw: video.videoWidth, sh: video.videoHeight }
          : computeCropRect(video, targetRef.current?.getBoundingClientRect() ?? null);
        const pixels = grabber.grab(video, rect, wholeFrame ? 1600 : 1280);
        if (pixels) {
          const result = await decoder.decode(pixels, "video");
          if (!cancelled && result) found = handleDecoded(result);
        }
      }
      if (!cancelled && !found) timer = setTimeout(scan, FRAME_INTERVAL_MS);
    };

    (async () => {
      try {
        stream = await openCamera(facingMode);
        if (cancelled) {
          stopStream(stream);
          return;
        }
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        const [track] = stream.getVideoTracks();
        trackRef.current = track ?? null;
        if (track) await enableContinuousFocus(track);
        const cameras = await countVideoInputs();
        if (cancelled) return;
        const actualFacing = track?.getSettings?.().facingMode ?? facingMode;
        setState({
          session,
          status: "live",
          problem: null,
          torchSupported: track ? supportsTorch(track) : false,
          torchOn: false,
          canSwitch: cameras > 1,
          mirrored: actualFacing === "user",
        });
        void scan();
      } catch (error) {
        if (cancelled) return;
        setState({
          session,
          status: "error",
          problem: describeCameraError(error),
          torchSupported: false,
          torchOn: false,
          canSwitch: false,
          mirrored: false,
        });
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      stopStream(stream);
      trackRef.current = null;
      video.srcObject = null;
    };
  }, [active, facingMode, session, videoRef, targetRef]);

  const current = active && state?.session === session ? state : null;
  const status: CameraStatus = !active ? "off" : (current?.status ?? "starting");

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track || !current) return;
    const next = !current.torchOn;
    if (await setTorch(track, next)) {
      setState((s) => (s && s.session === current.session ? { ...s, torchOn: next } : s));
    }
  }, [current]);

  return {
    status,
    problem: current?.problem ?? null,
    torchSupported: current?.torchSupported ?? false,
    torchOn: current?.torchOn ?? false,
    canSwitch: current?.canSwitch ?? false,
    mirrored: current?.mirrored ?? false,
    retry,
    toggleTorch,
  };
}
