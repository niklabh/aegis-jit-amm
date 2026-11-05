#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Turbopack bundles `new Worker(new URL("./decode.worker.ts", import.meta.url))`
// into proper worker chunks, but also copies the raw .ts source to
// out/_next/static/media/ for an unused module. Nothing loads it; drop it so
// the deployed site only contains what the app needs.
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const media = join(dirname(fileURLToPath(import.meta.url)), "..", "out", "_next", "static", "media");
let removed = 0;
try {
  for (const name of readdirSync(media)) {
    if (/\.(ts|tsx)$/.test(name)) {
      rmSync(join(media, name));
      removed++;
    }
  }
} catch {
  // No media directory: nothing to clean.
}
if (removed) console.log(`postbuild: removed ${removed} unreferenced source file(s) from out/_next/static/media`);
