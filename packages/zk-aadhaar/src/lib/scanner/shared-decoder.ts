// SPDX-License-Identifier: MIT
import { QrDecoder } from "./decoder";

/** Site root (honours NEXT_PUBLIC_BASE_PATH for sub-path deployments). */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

let shared: QrDecoder | null = null;

/**
 * One decoder (and Web Worker) for the page's lifetime, created on first use.
 * Call from effects or event handlers only. `?decoder=zxing-js` forces the
 * pure-JS fallback engine, for comparison.
 */
export function getQrDecoder(): QrDecoder {
  if (!shared) {
    const prefer = new URLSearchParams(window.location.search).get("decoder") === "zxing-js" ? "zxing-js" : undefined;
    shared = new QrDecoder({ assetBase: new URL(`${BASE_PATH}/`, window.location.origin).href, prefer });
  }
  return shared;
}
