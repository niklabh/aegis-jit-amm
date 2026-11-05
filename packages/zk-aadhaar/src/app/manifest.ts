// SPDX-License-Identifier: MIT
import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  return {
    name: "Aadhaar QR Verifier",
    short_name: "QR Verifier",
    description: "Verify Aadhaar Secure QR codes offline, on your device.",
    start_url: `${base}/`,
    scope: `${base}/`,
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#4f46e5",
    icons: [{ src: `${base}/icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
