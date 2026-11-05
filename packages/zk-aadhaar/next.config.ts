// SPDX-License-Identifier: MIT
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static, client-only app: `next build` writes plain files to out/.
  // There is no server-side code at all, so scanned data has nowhere to go.
  output: "export",
  // Set NEXT_PUBLIC_BASE_PATH (e.g. "/zkAadhaar") to host under a sub-path.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  reactStrictMode: true,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
