#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copies the zxing-wasm reader binary into public/wasm/ (version in the file
// name) so the app never fetches it from a CDN, and a cached copy can never be
// paired with a newer JS glue after an upgrade. Runs before dev and build.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZXING_WASM_SHA256, ZXING_WASM_VERSION } from "zxing-wasm/reader";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = fileURLToPath(import.meta.resolve("zxing-wasm/reader/zxing_reader.wasm"));
const outDir = join(root, "public", "wasm");
const target = `zxing_reader-${ZXING_WASM_VERSION}.wasm`;

const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
if (digest !== ZXING_WASM_SHA256) {
  throw new Error(`zxing_reader.wasm checksum mismatch: expected ${ZXING_WASM_SHA256}, got ${digest}`);
}

mkdirSync(outDir, { recursive: true });
for (const name of readdirSync(outDir)) {
  if (name.startsWith("zxing_reader") && name !== target) rmSync(join(outDir, name));
}
copyFileSync(source, join(outDir, target));
console.log(`zxing-wasm ${ZXING_WASM_VERSION} → public/wasm/${target}`);
