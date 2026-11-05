// SPDX-License-Identifier: MIT
// Self-host the zxing-wasm QR decoder binary (the library default is a CDN).
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "node_modules", "zxing-wasm");
const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const out = join(root, "public", "wasm");
mkdirSync(out, { recursive: true });
copyFileSync(join(pkgDir, "dist", "reader", "zxing_reader.wasm"), join(out, `zxing_reader-${version}.wasm`));
