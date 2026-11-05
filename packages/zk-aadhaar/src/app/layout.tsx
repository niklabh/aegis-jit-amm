// SPDX-License-Identifier: MIT
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { CONTENT_SECURITY_POLICY } from "@/lib/security-policy.mjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Aadhaar QR Verifier — offline Secure QR scanner",
  description:
    "Scan an Aadhaar Secure QR code, verify UIDAI's digital signature and view the decoded details — entirely in your browser, with nothing uploaded.",
  applicationName: "Aadhaar QR Verifier",
  referrer: "no-referrer",
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

// Static hosting may not allow response headers, so the policy also ships as
// a meta tag (production only — the dev server needs eval and websockets).
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        {process.env.NODE_ENV === "production" && (
          <meta httpEquiv="Content-Security-Policy" content={CONTENT_SECURITY_POLICY} />
        )}
      </head>
      <body className="min-h-full bg-zinc-50 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        {children}
      </body>
    </html>
  );
}
