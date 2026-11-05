// SPDX-License-Identifier: MIT
"use client";

import {
  Camera,
  CameraOff,
  FileImage,
  Flashlight,
  FlashlightOff,
  KeyRound,
  LoaderCircle,
  Lock,
  ShieldCheck,
  ShieldX,
  SwitchCamera,
  Upload,
  X,
} from "lucide-react";
import { useRef, type ChangeEvent } from "react";
import { useQrCamera, type CameraStatus } from "@/hooks/useQrCamera";
import type { FacingMode } from "@/lib/scanner/camera";
import type { DecodedQr } from "@/lib/scanner/engine";
import { cn } from "@/lib/cn";
import type { Notice } from "@/lib/outcome";

interface ScannerViewProps {
  cameraActive: boolean;
  facingMode: FacingMode;
  busyText: string | null;
  notice: Notice | null;
  keyCount: number;
  onStartCamera: () => void;
  onStopCamera: () => void;
  onSwitchCamera: () => void;
  onDecoded: (qr: DecodedQr) => boolean;
  onFile: (file: File) => void;
  onSample: (kind: "signed" | "tampered") => void;
  onOpenKeys: () => void;
}

const HINTS: Record<CameraStatus, string> = {
  off: "Scan the QR on an Aadhaar letter, PVC card, e-Aadhaar PDF or mAadhaar app.",
  starting: "Starting the camera…",
  live: "Hold the QR code inside the frame. Move closer until it fills most of the box.",
  error: "",
};

const roundButton =
  "grid size-12 place-items-center rounded-full bg-black/45 text-white ring-1 ring-white/25 backdrop-blur-md transition hover:bg-black/65 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

export function ScannerView(props: ScannerViewProps) {
  const { cameraActive, facingMode, busyText, notice } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const camera = useQrCamera({
    active: cameraActive,
    facingMode,
    videoRef,
    targetRef,
    onDecoded: props.onDecoded,
  });
  const live = camera.status === "live";

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) props.onFile(file);
  };

  return (
    <section aria-labelledby="scan-heading" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
      <div>
        <h1 id="scan-heading" className="sr-only">
          Scan an Aadhaar Secure QR code
        </h1>
        <div className="relative mx-auto aspect-[3/4] w-full max-w-md overflow-hidden rounded-[2rem] bg-zinc-950 shadow-xl ring-1 ring-black/10 sm:aspect-square">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            aria-hidden
            className={cn(
              "absolute inset-0 size-full object-cover transition-opacity duration-300",
              live ? "opacity-100" : "opacity-0",
              camera.mirrored && "-scale-x-100",
            )}
          />

          {/* Targeting box — also defines the region that is decoded. */}
          <div
            ref={targetRef}
            className={cn(
              "pointer-events-none absolute left-1/2 top-[46%] aspect-square w-[78%] -translate-x-1/2 -translate-y-1/2 rounded-3xl transition-opacity sm:w-[66%]",
              live ? "opacity-100 shadow-[0_0_0_100vmax_rgba(0,0,0,0.45)]" : "opacity-0",
            )}
          >
            <span className="absolute left-0 top-0 size-12 rounded-tl-3xl border-l-4 border-t-4 border-white" />
            <span className="absolute right-0 top-0 size-12 rounded-tr-3xl border-r-4 border-t-4 border-white" />
            <span className="absolute bottom-0 left-0 size-12 rounded-bl-3xl border-b-4 border-l-4 border-white" />
            <span className="absolute bottom-0 right-0 size-12 rounded-br-3xl border-b-4 border-r-4 border-white" />
            {live && !busyText && (
              <span className="absolute inset-x-5 top-1/2 h-0.5 rounded-full bg-linear-to-r from-transparent via-emerald-300 to-transparent shadow-[0_0_12px_2px_rgba(110,231,183,0.6)] motion-safe:animate-scan" />
            )}
          </div>

          {camera.status === "off" && !busyText && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-linear-to-b from-zinc-900 to-zinc-950 p-8 text-center text-zinc-100">
              <span className="grid size-16 place-items-center rounded-2xl bg-white/10 ring-1 ring-white/15">
                <Camera aria-hidden className="size-8" />
              </span>
              <div>
                <p className="text-lg font-semibold">Scan an Aadhaar Secure QR</p>
                <p className="mt-1 text-sm text-zinc-400">
                  Camera frames are processed on this device and never stored or uploaded.
                </p>
              </div>
              <button
                type="button"
                onClick={props.onStartCamera}
                className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-zinc-900 shadow transition hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <Camera aria-hidden className="size-4" />
                Start camera
              </button>
            </div>
          )}

          {camera.status === "starting" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center text-zinc-200">
              <LoaderCircle aria-hidden className="size-8 animate-spin" />
              <p className="text-sm">Starting camera… allow access if your browser asks.</p>
            </div>
          )}

          {camera.status === "error" && camera.problem && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center text-zinc-100">
              <span className="grid size-14 place-items-center rounded-2xl bg-rose-500/15 text-rose-300 ring-1 ring-rose-400/30">
                <CameraOff aria-hidden className="size-7" />
              </span>
              <p className="max-w-xs text-sm text-zinc-300">{camera.problem.message}</p>
              <div className="flex flex-wrap justify-center gap-2">
                {camera.problem.kind !== "insecure" && camera.problem.kind !== "unsupported" && (
                  <button
                    type="button"
                    onClick={camera.retry}
                    className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-zinc-200"
                  >
                    Try again
                  </button>
                )}
                <button
                  type="button"
                  onClick={props.onStopCamera}
                  className="rounded-full px-4 py-2 text-sm font-medium text-zinc-200 ring-1 ring-white/25 hover:bg-white/10"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {live && (
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 bg-linear-to-t from-black/60 to-transparent p-5 pt-10">
              {camera.canSwitch && (
                <button
                  type="button"
                  onClick={props.onSwitchCamera}
                  className={roundButton}
                  aria-label={facingMode === "environment" ? "Switch to front camera" : "Switch to rear camera"}
                  title="Switch camera"
                >
                  <SwitchCamera aria-hidden className="size-5" />
                </button>
              )}
              {camera.torchSupported && (
                <button
                  type="button"
                  onClick={camera.toggleTorch}
                  className={cn(roundButton, camera.torchOn && "bg-amber-400/90 text-zinc-900 hover:bg-amber-300")}
                  aria-label={camera.torchOn ? "Turn torch off" : "Turn torch on"}
                  aria-pressed={camera.torchOn}
                >
                  {camera.torchOn ? <FlashlightOff aria-hidden className="size-5" /> : <Flashlight aria-hidden className="size-5" />}
                </button>
              )}
              <button type="button" onClick={props.onStopCamera} className={roundButton} aria-label="Stop camera">
                <X aria-hidden className="size-5" />
              </button>
            </div>
          )}

          {busyText && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-zinc-950/70 p-8 text-center text-white backdrop-blur-sm">
              <LoaderCircle aria-hidden className="size-9 animate-spin" />
              <p className="text-sm font-medium">{busyText}</p>
            </div>
          )}
        </div>

        <p
          aria-live="polite"
          className={cn(
            "mx-auto mt-4 min-h-10 max-w-md text-center text-sm",
            notice?.tone === "error" && "text-rose-700 dark:text-rose-300",
            notice?.tone === "warning" && "text-amber-800 dark:text-amber-300",
            (!notice || notice.tone === "info") && "text-zinc-600 dark:text-zinc-400",
          )}
        >
          {notice?.text ?? HINTS[camera.status]}
        </p>
      </div>

      <aside className="space-y-4">
        <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
          <h2 className="text-sm font-semibold">No camera handy?</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Upload a photo or screenshot of the QR code (for example from an e-Aadhaar PDF).
          </p>
          <input ref={fileRef} type="file" accept="image/*" className="sr-only" tabIndex={-1} onChange={onFileChange} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={Boolean(busyText)}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
          >
            <Upload aria-hidden className="size-4" />
            Upload QR image
          </button>
        </div>

        <div className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FileImage aria-hidden className="size-4 text-zinc-500" />
            Try a sample
          </h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Fictional data signed with a demo key — see what a valid and a tampered QR look like.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => props.onSample("signed")}
              disabled={Boolean(busyText)}
              className="inline-flex items-center justify-center gap-1.5 rounded-2xl px-3 py-2.5 text-sm font-medium ring-1 ring-zinc-200 transition hover:bg-zinc-50 disabled:opacity-60 dark:ring-zinc-700 dark:hover:bg-zinc-800"
            >
              <ShieldCheck aria-hidden className="size-4 text-emerald-600" />
              Signed
            </button>
            <button
              type="button"
              onClick={() => props.onSample("tampered")}
              disabled={Boolean(busyText)}
              className="inline-flex items-center justify-center gap-1.5 rounded-2xl px-3 py-2.5 text-sm font-medium ring-1 ring-zinc-200 transition hover:bg-zinc-50 disabled:opacity-60 dark:ring-zinc-700 dark:hover:bg-zinc-800"
            >
              <ShieldX aria-hidden className="size-4 text-rose-600" />
              Tampered
            </button>
          </div>
        </div>

        <div className="rounded-3xl bg-zinc-100/80 p-5 ring-1 ring-zinc-200 dark:bg-zinc-900/60 dark:ring-zinc-800">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Lock aria-hidden className="size-4 text-zinc-500" />
            Private by design
          </h2>
          <ul className="mt-2 space-y-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            <li>Decoding and signature checks run entirely in this browser.</li>
            <li>No scanned data is sent anywhere; the page’s security policy blocks outgoing requests.</li>
            <li>Nothing is saved. Results disappear when you scan another or close the tab.</li>
          </ul>
          <button
            type="button"
            onClick={props.onOpenKeys}
            className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-indigo-700 hover:text-indigo-600 dark:text-indigo-300"
          >
            <KeyRound aria-hidden className="size-4" />
            Trusted signing keys ({props.keyCount})
          </button>
        </div>
      </aside>
    </section>
  );
}
