// SPDX-License-Identifier: MIT
// Local Anon Aadhaar prover service for the AegisJIT dashboard (127.0.0.1 only).
//   tsx prover/server.ts            (PORT=8547, ALLOW_ORIGIN=http://127.0.0.1:5173)
//
//   GET  /health                      -> { ok, artifacts }
//   POST /test-qr { timestamp }       -> { digits, png }      synthetic V2 QR signed by the TEST signer
//   POST /prove   { digits, seed, signal } -> { qr, proof }   zkAadhaar parse + RSA check + Groth16
//
// The QR payload is only ever sent here, to a process on the same machine. Nothing is logged.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import QRCode from "qrcode";
import { artifactsAvailable, makeTestQr, proveFromQr, sha256 } from "./anon-aadhaar";

const PORT = Number(process.env.PORT ?? 8547);
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
    if (req.method === "GET" && req.url === "/health") return send(res, origin, 200, { ok: true, artifacts: artifactsAvailable() });

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
