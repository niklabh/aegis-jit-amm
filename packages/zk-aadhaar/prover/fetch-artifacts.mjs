// SPDX-License-Identifier: MIT
// Downloads the official Anon Aadhaar v2 circuit artifacts (PSE / Ethereum Foundation) into a
// git-ignored cache and checks them against pinned SHA-256 digests.
//   node packages/zk-aadhaar/prover/fetch-artifacts.mjs
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const BASE = "https://anon-aadhaar-artifacts.s3.eu-central-1.amazonaws.com/v2.0.0";
export const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".cache", "anon-aadhaar", "v2.0.0");

// Pinned on first download (2026-11-05). A mismatch aborts.
const ARTIFACTS = {
  "aadhaar-verifier.wasm": { size: 10469686, sha256: "4894923663fafda95beb70abca4112ea97a62058c9a46419a274f04236f10d4f" },
  "circuit_final.zkey": { size: 612082146, sha256: "0d443ea85279b0370b53202f5e768ca9098cfcb5bb14f8ca8323d2266822c492" },
  "vkey.json": { size: 4388, sha256: "40f2ea24b56ffe2b6e6e3578053cbda15e773cb560697bac883a404077fcf177" },
};

const sha256File = (p) => new Promise((res, rej) => {
  const h = createHash("sha256");
  createReadStream(p).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
});

mkdirSync(CACHE_DIR, { recursive: true });
let failed = false;
for (const [name, { size, sha256 }] of Object.entries(ARTIFACTS)) {
  const dest = join(CACHE_DIR, name);
  if (!existsSync(dest) || statSync(dest).size !== size) {
    process.stdout.write(`↓ ${name} (${(size / 1e6).toFixed(1)} MB) … `);
    const res = await fetch(`${BASE}/${name}`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest + ".part"));
    renameSync(dest + ".part", dest);
    console.log("done");
  }
  const got = await sha256File(dest);
  const ok = sha256.startsWith("PINNED_") ? null : got === sha256;
  console.log(`${ok === false ? "✘" : "✔"} ${name} sha256=${got}${ok === null ? "  (not pinned yet)" : ""}`);
  if (ok === false) failed = true;
}
if (failed) { console.error("Artifact digest mismatch — refusing to use the cache."); process.exit(1); }
console.log(`Artifacts in ${CACHE_DIR}`);
