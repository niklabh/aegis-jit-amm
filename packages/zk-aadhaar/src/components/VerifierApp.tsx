// SPDX-License-Identifier: MIT
"use client";

import { KeyRound, ScanLine, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useOfflineSupport } from "@/hooks/useOfflineSupport";
import { isAadhaarQrError } from "@/lib/aadhaar/errors";
import { getBuiltInKeys, importedKeyStore } from "@/lib/aadhaar/keys";
import { parseSecureQr, type ParsedSecureQr } from "@/lib/aadhaar/parse";
import { extractCompressedPayload, type QrScan } from "@/lib/aadhaar/payload";
import { verifySecureQrSignature } from "@/lib/aadhaar/verify";
import type { Notice, ScanOutcome, ScanSource } from "@/lib/outcome";
import { photoToDataUrl } from "@/lib/photo/photo-url";
import type { FacingMode } from "@/lib/scanner/camera";
import type { DecodedQr } from "@/lib/scanner/engine";
import { decodeQrFromImageFile } from "@/lib/scanner/image-file";
import { getQrDecoder } from "@/lib/scanner/shared-decoder";
import { KeyManager } from "./KeyManager";
import { ResultView } from "./ResultView";
import { ScannerView } from "./ScannerView";

type View = { kind: "scan" } | { kind: "processing" } | { kind: "result"; outcome: ScanOutcome };

const noSubscription = () => () => {};

export function VerifierApp() {
  const [view, setView] = useState<View>({ kind: "scan" });
  const [cameraOn, setCameraOn] = useState(false);
  const [facingMode, setFacingMode] = useState<FacingMode>("environment");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyText, setBusyText] = useState<string | null>(null);
  const [keysOpenedAt, setKeysOpenedAt] = useState<number | null>(null);

  const imported = useSyncExternalStore(
    importedKeyStore.subscribe,
    importedKeyStore.getSnapshot,
    importedKeyStore.getServerSnapshot,
  );
  const keys = useMemo(() => [...getBuiltInKeys(), ...imported], [imported]);
  const secureContext = useSyncExternalStore(noSubscription, () => window.isSecureContext, () => true);

  useOfflineSupport();

  useEffect(() => {
    // Start loading the decoder (worker + WASM) right away, and resume the
    // camera automatically when permission was already granted earlier.
    getQrDecoder();
    navigator.permissions?.query({ name: "camera" as PermissionName }).then(
      (permission) => {
        if (permission.state === "granted") setCameraOn(true);
      },
      () => undefined,
    );
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** Parses a decoded QR; on success switches to the results view. Returns false to keep scanning. */
  const handleScan = useCallback(
    (scan: QrScan, source: ScanSource, engine: string | null): boolean => {
      let parsed: ParsedSecureQr;
      try {
        parsed = parseSecureQr(extractCompressedPayload(scan));
      } catch (error) {
        const text = isAadhaarQrError(error) ? error.message : "This QR code could not be read.";
        const tone = isAadhaarQrError(error) && error.code === "NOT_AADHAAR" ? "info" : "warning";
        // The camera reports the same code many times a second; keep one notice.
        setNotice((current) => (current?.text === text ? current : { tone, text }));
        return false;
      }

      const scannedAt = Date.now();
      setNotice(null);
      setView({ kind: "processing" });
      void (async () => {
        try {
          const [verification, photo] = await Promise.all([
            verifySecureQrSignature(parsed.signedData, parsed.signature, keys),
            parsed.photo
              ? photoToDataUrl(parsed.photo, parsed.photoFormat).then(
                  (url) => ({ url, error: null }),
                  () => ({ url: null, error: "Photo could not be decoded" }),
                )
              : Promise.resolve({ url: null, error: null }),
          ]);
          setView({
            kind: "result",
            outcome: {
              parsed,
              verification,
              photoUrl: photo.url,
              photoError: photo.error,
              source,
              engine,
              keysCount: keys.length,
              scannedAt,
            },
          });
        } catch {
          setView({ kind: "scan" });
          setNotice({ tone: "error", text: "Something went wrong while verifying this QR code. Please try again." });
        }
      })();
      return true;
    },
    [keys],
  );

  const onDecoded = useCallback(
    (qr: DecodedQr) => {
      const accepted = handleScan(qr, "camera", qr.engine);
      if (accepted) navigator.vibrate?.(40);
      return accepted;
    },
    [handleScan],
  );

  const onFile = useCallback(
    async (file: File) => {
      setNotice(null);
      setBusyText("Looking for a QR code in the image…");
      try {
        const qr = await decodeQrFromImageFile(file, getQrDecoder());
        if (qr) {
          handleScan(qr, "image", qr.engine);
        } else {
          setNotice({
            tone: "warning",
            text: "No QR code found in that image. Try a sharper, well-lit photo where the code fills more of the frame.",
          });
        }
      } catch {
        setNotice({ tone: "error", text: "That file could not be opened as an image." });
      } finally {
        setBusyText(null);
      }
    },
    [handleScan],
  );

  const onSample = useCallback(
    async (kind: "signed" | "tampered") => {
      const samples = await import("@/lib/demo/samples");
      handleScan({ text: kind === "signed" ? samples.DEMO_QR_SIGNED : samples.DEMO_QR_TAMPERED }, "sample", null);
    },
    [handleScan],
  );

  // Dropping the outcome from state releases the decoded data and photo.
  const scanAnother = useCallback(() => {
    setNotice(null);
    setView({ kind: "scan" });
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 border-b border-zinc-200/70 bg-white/80 backdrop-blur-lg dark:border-zinc-800/80 dark:bg-zinc-950/75">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3 sm:px-6">
          <span className="grid size-9 place-items-center rounded-xl bg-indigo-600 text-white shadow-sm">
            <ScanLine aria-hidden className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold leading-tight">Aadhaar QR Verifier</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Secure QR · verified on your device</p>
          </div>
          <button
            type="button"
            onClick={() => setKeysOpenedAt(Date.now())}
            className="ml-auto inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-zinc-700 ring-1 ring-zinc-200 transition hover:bg-zinc-100 dark:text-zinc-200 dark:ring-zinc-700 dark:hover:bg-zinc-800"
          >
            <KeyRound aria-hidden className="size-4" />
            <span className="hidden sm:inline">Trusted keys</span>
            <span className="rounded-md bg-zinc-100 px-1.5 text-xs tabular-nums dark:bg-zinc-800">{keys.length}</span>
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-12 pt-5 sm:px-6 sm:pt-8">
        {!secureContext && (
          <p className="mb-5 flex gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-100">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            This page is not served over HTTPS, so the browser blocks the camera and signature verification. Open it
            via https:// or on localhost.
          </p>
        )}

        {view.kind === "result" ? (
          <ResultView outcome={view.outcome} onScanAnother={scanAnother} />
        ) : (
          <ScannerView
            cameraActive={cameraOn && view.kind === "scan"}
            facingMode={facingMode}
            busyText={view.kind === "processing" ? "Verifying signature…" : busyText}
            notice={notice}
            keyCount={keys.length}
            onStartCamera={() => setCameraOn(true)}
            onStopCamera={() => setCameraOn(false)}
            onSwitchCamera={() => setFacingMode((mode) => (mode === "environment" ? "user" : "environment"))}
            onDecoded={onDecoded}
            onFile={onFile}
            onSample={onSample}
            onOpenKeys={() => setKeysOpenedAt(Date.now())}
          />
        )}
      </main>

      <footer className="border-t border-zinc-200/70 py-6 text-center text-xs text-zinc-500 dark:border-zinc-800/80 dark:text-zinc-400">
        <p>Independent open-source tool · not affiliated with UIDAI · works offline once loaded</p>
      </footer>

      <KeyManager
        open={keysOpenedAt !== null}
        now={keysOpenedAt ?? 0}
        keys={keys}
        onClose={() => setKeysOpenedAt(null)}
      />
    </div>
  );
}
