// SPDX-License-Identifier: MIT
// Self-host the browser binaries: the zxing-wasm QR decoder (the library default is a CDN) and the
// Semaphore depth-30 artifacts for in-browser World ID proving (fetched into .cache/ by
// packages/world-id/prover/fetch-artifacts.mjs; same files World ID's verifier key comes from).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "node_modules", "zxing-wasm");
const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const out = join(root, "public", "wasm");
mkdirSync(out, { recursive: true });
copyFileSync(join(pkgDir, "dist", "reader", "zxing_reader.wasm"), join(out, `zxing_reader-${version}.wasm`));

const semaphore = join(root, "..", ".cache", "semaphore", "30");
const semaphoreOut = join(root, "public", "semaphore", "30");
if (existsSync(join(semaphore, "semaphore.zkey")) && existsSync(join(semaphore, "semaphore.wasm"))) {
  mkdirSync(semaphoreOut, { recursive: true });
  for (const f of ["semaphore.wasm", "semaphore.zkey"]) copyFileSync(join(semaphore, f), join(semaphoreOut, f));
} else {
  console.warn("Semaphore depth-30 artifacts not found in .cache/semaphore/30 — in-browser World ID proving will be unavailable. Run: node packages/world-id/prover/fetch-artifacts.mjs");
}
