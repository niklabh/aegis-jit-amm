// SPDX-License-Identifier: MIT
// Downloads the public Semaphore v3 depth-30 proving artifacts (PSE trusted setup — the same
// verification key World ID's on-chain SemaphoreVerifier is generated from) into a git-ignored
// cache and checks them against pinned SHA-256 digests.
//   node packages/world-id/prover/fetch-artifacts.mjs
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const BASE = "https://www.trusted-setup-pse.org/semaphore/30";
export const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".cache", "semaphore", "30");

// Pinned on first download (2026-11-05). A mismatch aborts.
const ARTIFACTS = {
  "semaphore.wasm": { size: 1254182, sha256: "e20607caef27bc760d50c29daa489bfdccf16bddef31abb0a1c4b7a3a384069d" },
  "semaphore.zkey": { size: 4450580, sha256: "00aaa6d8cb426655ef880794a57a6e674b4d244f484d6960fe3430488fbba948" },
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
  const ok = got === sha256;
  console.log(`${ok ? "✔" : "✘"} ${name} sha256=${got}`);
  if (!ok) failed = true;
}
if (failed) { console.error("Artifact digest mismatch — refusing to use the cache."); process.exit(1); }
console.log(`Artifacts in ${CACHE_DIR}`);
