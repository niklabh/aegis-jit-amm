// SPDX-License-Identifier: MIT
"use client";

import { useEffect } from "react";
import { BASE_PATH, getQrDecoder } from "@/lib/scanner/shared-decoder";

/**
 * Production only: registers the service worker, warms the lazily loaded
 * pieces (decoder worker + WASM, JPEG 2000 decoder, samples) and hands their
 * URLs to the service worker so the app keeps working with no network.
 */
export function useOfflineSupport(): void {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") {
      // A worker left over from a production preview on this origin would serve stale files in dev.
      navigator.serviceWorker.getRegistrations().then(
        (registrations) => registrations.forEach((registration) => void registration.unregister()),
        () => undefined,
      );
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        await navigator.serviceWorker.register(`${BASE_PATH}/sw.js`, { scope: `${BASE_PATH}/` });
        const [decoder] = await Promise.all([
          getQrDecoder().ready,
          import("@/lib/photo/jpeg2000"),
          import("@/lib/demo/samples"),
        ]);
        const urls = new Set([
          `${window.location.origin}${window.location.pathname}`,
          ...performance.getEntriesByType("resource").map((entry) => entry.name),
          ...decoder.resources,
        ]);
        const registration = await navigator.serviceWorker.ready;
        if (cancelled) return;
        registration.active?.postMessage({
          type: "precache",
          urls: [...urls].filter((url) => url.startsWith(window.location.origin)),
        });
      } catch {
        // Offline support is best-effort; the app works online regardless.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}
