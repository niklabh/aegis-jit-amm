// SPDX-License-Identifier: MIT
// Local Anon Aadhaar prover service for the AegisJIT dashboard (127.0.0.1 only).
//   tsx prover/server.ts            (PORT=8547, ALLOW_ORIGIN=http://127.0.0.1:5173)
//
//   GET  /health                      -> { ok, artifacts, worldId: { configured, rp_id, app_id } }
//   POST /test-qr { timestamp }       -> { digits, png }      synthetic V2 QR signed by the TEST signer
//   POST /prove   { digits, seed, signal } -> { qr, proof }   zkAadhaar parse + RSA check + Groth16
//   POST /worldid/rp-context { action } -> IDKit `rp_context`  World ID relying-party request signature
//        (World ID 4.x IDKit requires every request to be signed server-side with the app's RP signing key;
//         the key stays in this process, read from WORLD_ID_RP_SIGNING_KEY / the repo .env, never sent to the browser)
//
// The QR payload is only ever sent here, to a process on the same machine. Nothing is logged.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { artifactsAvailable, makeTestQr, proveFromQr, sha256 } from "./anon-aadhaar";

const PORT = Number(process.env.PORT ?? 8547);

/** World ID relying-party settings: process env first, then the repo's git-ignored .env */
function worldIdEnv(): { appId: string; rpId: string; signingKey: string } {
  const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env");
  const fromFile: Record<string, string> = {};
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  const get = (k: string) => (process.env[k] ?? fromFile[k] ?? "").trim();
  return { appId: get("WORLD_ID_APP_ID") || get("WORLD_ID_STAGING_APP_ID"), rpId: get("WORLD_ID_RP_ID"), signingKey: get("WORLD_ID_RP_SIGNING_KEY") };
}
const ALLOW = (process.env.ALLOW_ORIGIN ?? "http://127.0.0.1:5173,http://localhost:5173").split(",");
const MAX_BODY = 64 * 1024;

let queue: Promise<unknown> = Promise.resolve(); // one proof at a time (GBs of RAM each)

function send(res: ServerResponse, origin: string | undefined, status: number, body: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (origin && ALLOW.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? undefined : v)));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const isUint = (v: unknown) => typeof v === "string" && /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(v);

createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !ALLOW.includes(origin)) return send(res, undefined, 403, { error: "origin not allowed" });
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": origin ?? "",
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }
  try {
    if (req.method === "GET" && req.url === "/health") {
      const w = worldIdEnv();
      return send(res, origin, 200, { ok: true, artifacts: artifactsAvailable(), worldId: { configured: Boolean(w.rpId && w.signingKey), rp_id: w.rpId || null, app_id: w.appId || null } });
    }

    if (req.method === "POST" && req.url === "/worldid/rp-context") {
      const { action } = await readJson(req);
      if (typeof action !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(action)) return send(res, origin, 400, { error: "expected { action }" });
      const w = worldIdEnv();
      if (!w.rpId || !w.signingKey) return send(res, origin, 503, { error: "World ID RP not configured: set WORLD_ID_RP_ID and WORLD_ID_RP_SIGNING_KEY in .env (Developer Portal → app → RP registration)" });
      const { sig, nonce, createdAt, expiresAt } = signRequest({ signingKeyHex: w.signingKey.replace(/^0x/, ""), action });
      return send(res, origin, 200, { rp_id: w.rpId, nonce, created_at: createdAt, expires_at: expiresAt, signature: sig, app_id: w.appId || null });
    }

    if (req.method === "POST" && req.url === "/test-qr") {
      const { timestamp } = await readJson(req);
      const ts = Number(timestamp ?? Math.floor(Date.now() / 1000));
      if (!Number.isSafeInteger(ts) || ts <= 0) return send(res, origin, 400, { error: "bad timestamp" });
      const qr = makeTestQr({ timestamp: ts });
      const png = await QRCode.toDataURL(qr.digits, { errorCorrectionLevel: "M", margin: 2, scale: 3 });
      return send(res, origin, 200, { digits: qr.digits, png, signedDataSha256: sha256(qr.signedData) });
    }

    if (req.method === "POST" && req.url === "/prove") {
      const { digits, seed, signal } = await readJson(req);
      if (typeof digits !== "string" || !/^\d{600,7089}$/.test(digits) || !isUint(seed) || !isUint(signal)) {
        return send(res, origin, 400, { error: "expected { digits, seed, signal }" });
      }
      if (!artifactsAvailable()) return send(res, origin, 503, { error: "artifacts missing: run node packages/zk-aadhaar/prover/fetch-artifacts.mjs" });
      const job = queue.then(() => proveFromQr(digits, BigInt(seed), BigInt(signal)));
      queue = job.catch(() => undefined);
      const { parsed, proof } = await job;
      return send(res, origin, 200, { qr: { version: parsed.data.version, rsa: parsed.rsa }, proof });
    }
    send(res, origin, 404, { error: "not found" });
  } catch (e: any) {
    send(res, origin, 500, { error: String(e?.message ?? e) });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`Anon Aadhaar prover on http://127.0.0.1:${PORT} (artifacts: ${artifactsAvailable() ? "ok" : "MISSING"})`);
});
