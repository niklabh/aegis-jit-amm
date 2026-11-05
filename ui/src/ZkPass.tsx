// SPDX-License-Identifier: MIT
// ZK Pass selector: two doors into the same 0x2A → 0x7A retail tier.
//   🌍 World ID (Global)          — proof of personhood, Semaphore Groth16 generated in this browser (type 1)
//   🇮🇳 ZK Aadhaar (India Sovereign) — Secure QR → RSA → Anon Aadhaar Groth16 via the local prover (type 2)
import { useState } from "react";
import type { Hex } from "viem";

import type { AegisClient, Deployment, ProverResult } from "./lib/aegis";
import type { WorldIdProofResult } from "./lib/worldid";
import { AadhaarPass } from "./AadhaarPass";
import { WorldIdPass } from "./WorldIdPass";
import { Badge } from "./PassUi";

export type PassKind = "worldid" | "aadhaar";

export interface AttachedProof {
  kind: PassKind;
  /** short human label, e.g. "World ID · Semaphore" */
  label: string;
  /** full takerData (takerTraits header ‖ typed 0x2A payload) */
  data: Hex;
  verified: boolean;
  beneficiary: string;
  result?: ProverResult;
  worldId?: WorldIdProofResult;
}

const TABS: Array<{ id: PassKind; title: string; sub: string; accent: string }> = [
  { id: "worldid", title: "🌍 World ID (Global)", sub: "biometric proof of personhood · Semaphore Groth16 in-browser", accent: "border-sky-500 bg-sky-500/10 text-sky-100" },
  { id: "aadhaar", title: "🇮🇳 ZK Aadhaar (India Sovereign)", sub: "Secure QR → RSA-2048 → Anon Aadhaar Groth16", accent: "border-emerald-500 bg-emerald-500/10 text-emerald-100" },
];

export function ZkPass({ dep, client, attached, onAttach }: {
  dep: Deployment; client: AegisClient; attached: AttachedProof | null; onAttach: (a: AttachedProof | null) => void;
}) {
  const [tab, setTab] = useState<PassKind>("worldid");

  return (
    <section className="rounded-xl border border-slate-700 bg-slate-900/60 p-5" data-testid="zk-pass">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">ZK Pass · attach a proof of personhood to takerData</h2>
        <Badge tone={attached?.verified ? "good" : attached ? "bad" : "neutral"}>
          {attached ? `${attached.verified ? "✔" : "✘"} attached: ${attached.label}` : "no pass attached → priced as a bot"}
        </Badge>
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        Either pass is a <code>0x2A</code> payload starting with its type byte (1 World ID, 2 ZK Aadhaar). The opcode routes it to the matching
        <code> IZKVerifier</code> adapter, and both land in the same verified-human tier of <code>0x7A</code>: base fee 0.30% → 0.15%.
      </p>

      <div role="tablist" aria-label="ZK pass type" className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} data-testid={`tab-${t.id}`} onClick={() => setTab(t.id)}
            className={`text-left rounded-lg border p-2.5 transition ${tab === t.id ? t.accent : "border-slate-800 text-slate-300 hover:border-slate-600"}`}>
            <div className="text-sm font-medium">{t.title}</div>
            <div className="text-[11px] opacity-70 leading-tight">{t.sub}</div>
          </button>
        ))}
      </div>

      <div role="tabpanel" data-testid={`panel-${tab}`} className="mt-3">
        {tab === "worldid"
          ? (dep.worldId
            ? <WorldIdPass dep={dep} worldId={dep.worldId} client={client} attached={attached} onAttach={onAttach} />
            : <p className="text-xs text-rose-300">deployment.json has no World ID config — re-run <code>scripts/seed-local.ts</code>.</p>)
          : <AadhaarPass dep={dep} client={client} attached={attached} onAttach={onAttach} />}
      </div>
    </section>
  );
}
