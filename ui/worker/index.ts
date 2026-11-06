// SPDX-License-Identifier: MIT
// Cloudflare Worker behind the hosted dashboard: serves ui/dist as static assets and provides the two prover
// endpoints the public page needs for the World ID pass (the same contract as packages/zk-aadhaar/prover/server.ts):
//   GET  /health              -> { ok, artifacts: false, hosted: true, worldId: { configured, rp_id, app_id, apps } }
//   POST /worldid/rp-context  -> IDKit `rp_context`, signed with the app's relying-party key. The key is a Worker
//                                secret: it never reaches the browser, exactly like the local prover process.
// Anon Aadhaar proving stays on the user's machine (620 MB of artifacts, GBs of RAM): the hosted page says so.
//   vars:    PRODUCTION_WORLD_ID_APP_ID                                   (wrangler.toml)
//   secrets: PRODUCTION_WORLD_ID_RP_ID, PRODUCTION_WORLD_ID_RP_SIGNING_KEY  (wrangler secret put …)
import { signRequest } from "@worldcoin/idkit-server";

type Env = {
  ASSETS: { fetch(request: Request): Promise<Response> };
  PRODUCTION_WORLD_ID_APP_ID?: string;
  PRODUCTION_WORLD_ID_RP_ID?: string;
  PRODUCTION_WORLD_ID_RP_SIGNING_KEY?: string;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function relyingParty(env: Env) {
  const appId = (env.PRODUCTION_WORLD_ID_APP_ID ?? "").trim();
  const rpId = (env.PRODUCTION_WORLD_ID_RP_ID ?? "").trim();
  const key = (env.PRODUCTION_WORLD_ID_RP_SIGNING_KEY ?? "").trim();
  return { appId, rpId, key, configured: Boolean(appId && rpId && key) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method !== "GET") return json(405, { error: "GET" });
      const rp = relyingParty(env);
      return json(200, {
        ok: true, artifacts: false, hosted: true,
        worldId: {
          configured: rp.configured, rp_id: rp.rpId || null, app_id: rp.appId || null,
          apps: rp.appId ? [{ app_id: rp.appId, rp_id: rp.rpId || null, configured: rp.configured, source: "cloudflare worker" }] : [],
        },
      });
    }

    if (url.pathname === "/worldid/rp-context") {
      if (request.method !== "POST") return json(405, { error: "POST" });
      // browsers send Origin on every cross-origin POST: only this page may use the signer from a browser
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json(403, { error: "origin not allowed" });
      let body: { action?: unknown; app_id?: unknown };
      try { body = await request.json(); } catch { return json(400, { error: "expected JSON { action, app_id? }" }); }
      const { action, app_id } = body ?? {};
      if (typeof action !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(action)) return json(400, { error: "expected { action, app_id? }" });
      if (app_id !== undefined && (typeof app_id !== "string" || !/^app_[a-z0-9_]{1,80}$/.test(app_id))) return json(400, { error: "bad app_id" });
      const rp = relyingParty(env);
      if (!rp.configured) return json(503, { error: "World ID RP not configured on this host: PRODUCTION_WORLD_ID_APP_ID (var), PRODUCTION_WORLD_ID_RP_ID and PRODUCTION_WORLD_ID_RP_SIGNING_KEY (secrets)" });
      if (app_id && app_id !== rp.appId) return json(503, { error: `no RP credentials for ${app_id}; configured: ${rp.appId}` });
      const { sig, nonce, createdAt, expiresAt } = signRequest({ signingKeyHex: rp.key.replace(/^0x/, ""), action });
      return json(200, { rp_id: rp.rpId, nonce, created_at: createdAt, expires_at: expiresAt, signature: sig, app_id: rp.appId });
    }

    return env.ASSETS.fetch(request);
  },
};
