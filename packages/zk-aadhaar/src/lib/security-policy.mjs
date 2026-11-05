// SPDX-License-Identifier: MIT
// Content-Security-Policy shared by the page (<meta> tag, see app/layout.tsx)
// and the local preview server / recommended hosting headers.
//
// connect-src 'self' is the privacy guarantee: the page cannot send data to
// any other origin. 'unsafe-inline' scripts are required by Next.js' inline
// bootstrap in a static export; 'wasm-unsafe-eval' lets the QR decoder compile
// its WebAssembly module.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

// Directives browsers only honour from an HTTP header (not from <meta>).
export const HEADER_ONLY_DIRECTIVES = "frame-ancestors 'none'";
