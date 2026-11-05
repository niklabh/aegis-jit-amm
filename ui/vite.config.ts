// SPDX-License-Identifier: MIT
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// Only zkAadhaar's src/ is served to the browser — never prover/ (it holds the test private key)
const zkAadhaarSrc = fileURLToPath(new URL("../packages/zk-aadhaar/src", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // zkAadhaar's parser / RSA verifier / QR scanner are imported from source
  resolve: { alias: { "@": zkAadhaarSrc } },
  server: { fs: { allow: [".", zkAadhaarSrc, fileURLToPath(new URL("../packages/zk-aadhaar/node_modules", import.meta.url))] } },
});
