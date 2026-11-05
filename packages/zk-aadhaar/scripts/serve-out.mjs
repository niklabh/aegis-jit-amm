#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Minimal static server to preview the production build in out/ —
// `npm run preview`. Sends the recommended security headers so the build is
// exercised exactly as it should be deployed.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT_SECURITY_POLICY, HEADER_ONLY_DIRECTIVES } from "../src/lib/security-policy.mjs";

const root = join(fileURLToPath(new URL("..", import.meta.url)), "out");
const port = Number(process.env.PORT ?? 4173);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

createServer((request, response) => {
  const { pathname } = new URL(request.url ?? "/", "http://localhost");
  let file = join(root, normalize(decodeURIComponent(pathname)));
  if (file !== root && !file.startsWith(root + sep)) {
    response.writeHead(403).end();
    return;
  }
  if (!isFile(file)) file = isFile(join(file, "index.html")) ? join(file, "index.html") : `${file}.html`;
  if (!isFile(file)) {
    file = join(root, "404.html");
    response.statusCode = 404;
  }
  response.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
  response.setHeader("Content-Security-Policy", `${CONTENT_SECURITY_POLICY}; ${HEADER_ONLY_DIRECTIVES}`);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  response.setHeader("Cache-Control", "no-cache");
  createReadStream(file).pipe(response);
}).listen(port, () => console.log(`Serving out/ at http://localhost:${port}`));
