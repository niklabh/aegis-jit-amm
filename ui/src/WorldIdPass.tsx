// SPDX-License-Identifier: MIT
// World ID Pass (0x2A proof type 1): Semaphore v3 identity in the local depth-30 tree -> Groth16 proof
// generated IN THIS BROWSER (snarkjs, public depth-30 artifacts whose verification key equals World ID's
// SemaphoreVerifier) -> WorldIDAdapter → IWorldID.verifyProof → MockWorldIDRouter → SemaphoreVerifier
// (eth_call) -> attach to the SwapVM simulator. World App / IDKit produce the same result shape.
import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { toHex } from "viem";
import { IDKitRequestWidget, orbLegacy, type IDKitResult, type RpContext } from "@worldcoin/idkit";

import type { AegisClient, Deployment } from "./lib/aegis";
import {
  buildGroup, encodeWorldIdPayload, externalNullifierOf, fromIdKitResult, identityFor, legacyItemFromIdKit, proofWordsHex, proveWorldId, signalHashOf, worldIdActionFor,
  type WorldIdProofResult,
} from "./lib/worldid";
import { Badge, Step, short } from "./PassUi";
import type { AttachedProof } from "./ZkPass";

type WorldIdConfig = NonNullable<Deployment["worldId"]>;
const hex = (v: bigint) => toHex(v);

export function WorldIdPass({ dep, worldId: w, client, attached, onAttach }: {
  dep: Deployment; worldId: WorldIdConfig; client: AegisClient; attached: AttachedProof | null; onAttach: (a: AttachedProof | null) => void;
}) {
  const taker = dep.accounts.human as Address;
  const [identity, setIdentity] = useState(w.members[0] ?? "human");
  const [artifacts, setArtifacts] = useState<boolean | null>(null);
  const [latestRoot, setLatestRoot] = useState<bigint | null>(null);
  const [proof, setProof] = useState<WorldIdProofResult | null>(null);
  const [onChain, setOnChain] = useState<{ ok: boolean; beneficiary: string } | null>(null);
  const [rootStatus, setRootStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [idkitJson, setIdkitJson] = useState("");
  const [idkit, setIdkit] = useState<{ root: bigint; nullifierHash: bigint; ok: boolean; rootStatus: string; error?: string } | null>(null);
  // live World ID through IDKit (World App, or the World ID Simulator for staging apps)
  const realRouter = w.backend === "worldid";
  const [rpStatus, setRpStatus] = useState<{ configured: boolean; rp_id: string | null; app_id: string | null } | null>(null);
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [idkitOpen, setIdkitOpen] = useState(false);
  const [live, setLive] = useState<{ root: bigint; nullifierHash: bigint; proof: bigint[]; raw: unknown } | null>(null);
  const [liveErr, setLiveErr] = useState<string | null>(null);

  const group = useMemo(() => buildGroup(w.identityPrefix, w.members), [w.identityPrefix, w.members]);
  const id = useMemo(() => identityFor(w.identityPrefix, identity), [w.identityPrefix, identity]);
  const memberIndex = group.indexOf(id.commitment);
  const localRoot = BigInt(group.root);
  const [epoch, setEpoch] = useState<bigint>(0n);
  // the action rotates per epoch when the adapter is deployed with an epoch duration (CROPS unlinkability for World ID too)
  const externalNullifier = useMemo(() => externalNullifierOf(w.appId, worldIdActionFor(w.action, w.epochDuration ?? 0, epoch)), [w.appId, w.action, w.epochDuration, epoch]);
  const artifactUrl = (f: string) => `${w.artifactsBase}/${f}`;

  useEffect(() => {
    fetch(artifactUrl("semaphore.zkey"), { method: "HEAD" }).then((r) => setArtifacts(r.ok)).catch(() => setArtifacts(false));
    if (!realRouter) client.worldIdLatestRoot().then(setLatestRoot).catch(() => setLatestRoot(null));
    client.worldIdCurrentEpoch().then(setEpoch).catch(() => setEpoch(0n));
    client.proverHealth().then((h) => setRpStatus(h?.worldId ?? { configured: false, rp_id: null, app_id: null })).catch(() => setRpStatus({ configured: false, rp_id: null, app_id: null }));
  }, [client, w.artifactsBase, realRouter]);
  const idkitAction = worldIdActionFor(w.action, w.epochDuration ?? 0, epoch);

  async function startIdKit() {
    setLiveErr(null); setLive(null);
    try {
      const ctx = await client.worldIdRpContext(idkitAction);
      setRpContext({ rp_id: ctx.rp_id, nonce: ctx.nonce, created_at: ctx.created_at, expires_at: ctx.expires_at, signature: ctx.signature });
      setIdkitOpen(true);
    } catch (e: any) { setLiveErr(String(e.message ?? e)); }
  }
  /** runs inside the widget: decode the legacy orb item and check it against this chain's adapter (eth_call) */
  async function handleIdKitVerify(result: IDKitResult) {
    const p = fromIdKitResult(legacyItemFromIdKit(result));
    const chk = await client.verifyWorldIdOnChain(taker, p);
    if (!chk.ok) throw new Error("WorldIDAdapter rejected the proof on this chain: wrong root for this router, signal is not the taker address, or app/action differs");
    setLive({ ...p, raw: result });
  }
  function onIdKitSuccess(result: IDKitResult) {
    const p = fromIdKitResult(legacyItemFromIdKit(result));
    onAttach({
      kind: "worldid", label: "World ID · World App", data: client.worldIdTakerData(encodeWorldIdPayload(p.root, epoch, p.nullifierHash, p.proof)),
      verified: true, beneficiary: taker,
      worldId: { root: p.root, nullifierHash: p.nullifierHash, signalHash: signalHashOf(taker), externalNullifierHash: externalNullifier, proof: p.proof, identityCommitment: 0n, memberIndex: -1, provingMs: 0 },
    });
  }
  const downloadLive = () => {
    if (!live) return;
    const blob = new Blob([JSON.stringify(live.raw, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "idkit-result.json"; a.click();
  };
  useEffect(() => {
    if (!busy) return;
    const t0 = performance.now();
    const t = setInterval(() => setElapsed(Math.round(performance.now() - t0)), 100);
    return () => clearInterval(t);
  }, [busy]);

  const reset = () => { setProof(null); setOnChain(null); setRootStatus(null); setErr(null); if (attached?.kind === "worldid") onAttach(null); };

  async function prove() {
    setBusy(true); reset();
    try {
      const p = await proveWorldId({
        prefix: w.identityPrefix, members: w.members, identity, signal: taker, externalNullifier,
        artifacts: { wasm: artifactUrl("semaphore.wasm"), zkey: artifactUrl("semaphore.zkey") },
      });
      setProof(p);
      setOnChain(await client.verifyWorldIdOnChain(taker, p));
      setRootStatus(await client.worldIdRootStatus(p.root));
      setLatestRoot(await client.worldIdLatestRoot());
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setBusy(false); }
  }

  async function importIdKit() {
    setIdkit(null);
    try {
      const r = fromIdKitResult(legacyItemFromIdKit(JSON.parse(idkitJson)));
      const chk = await client.verifyWorldIdOnChain(taker, r);
      setIdkit({ ...r, ok: chk.ok, rootStatus: await client.worldIdRootStatus(r.root) });
    } catch (e: any) { setIdkit({ root: 0n, nullifierHash: 0n, ok: false, rootStatus: "—", error: String(e.message ?? e) }); }
  }

  const attach = () => proof && onChain && onAttach({
    kind: "worldid", label: "World ID · Semaphore", data: client.worldIdTakerData(encodeWorldIdPayload(proof.root, epoch, proof.nullifierHash, proof.proof)),
    verified: onChain.ok, beneficiary: onChain.beneficiary, worldId: proof,
  });
  const isAttached = attached?.kind === "worldid" && attached.worldId === proof;

  return (
    <div data-testid="worldid-pass">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <p className="text-xs text-slate-400">
          Global proof of personhood: Semaphore identity → depth-30 World ID tree → Groth16 <b>in this browser</b> → <code>IWorldID.verifyProof</code> → <code>0x2A</code> type 1
        </p>
        <div className="flex gap-2">
          <Badge tone={w.backend === "semaphore" ? "good" : "warn"}>{w.backend === "semaphore" ? "on-chain: World ID's SemaphoreVerifier (real pairing)" : "on-chain: MockSemaphoreVerifier"}</Badge>
          <Badge tone={artifacts ? "good" : artifacts === null ? "neutral" : "bad"}>{artifacts === null ? "artifacts…" : artifacts ? "depth-30 artifacts served" : "artifacts missing (/semaphore/30)"}</Badge>
        </div>
      </div>

      <Step n={1} title="Identity — Semaphore v3, member of the local World ID tree">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="text-slate-500">identity seed</label>
          <select value={identity} onChange={(e) => { setIdentity(e.target.value); reset(); }} data-testid="worldid-identity"
            className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-100">
            {w.members.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <span className="text-slate-500">Identity(<code>{w.identityPrefix}{identity}</code>) — deterministic here; World App holds a random one</span>
        </div>
        <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs font-mono">
          <dt className="text-slate-500 font-sans">commitment</dt><dd>{short(hex(id.commitment))} <span className="text-slate-500 font-sans">leaf #{memberIndex} of {w.members.length} · depth {w.treeDepth} · group {w.groupId} (Orb)</span></dd>
          <dt className="text-slate-500 font-sans">tree root (browser)</dt>
          <dd>{short(hex(localRoot))} <span className={latestRoot === localRoot ? "text-emerald-300 font-sans" : "text-amber-300 font-sans"}>
            {latestRoot === null ? "" : latestRoot === localRoot ? "== MockWorldIDRouter.latestRoot ✔" : `≠ router latest ${short(hex(latestRoot))}`}</span></dd>
          <dt className="text-slate-500 font-sans">app / action</dt><dd>{w.appId} / {w.action} <span className="text-slate-500 font-sans">→ externalNullifier {short(hex(externalNullifier))}</span></dd>
          <dt className="text-slate-500 font-sans">signal (taker)</dt><dd>{taker} <span className="text-slate-500 font-sans">→ signalHash {short(hex(signalHashOf(taker)))}</span></dd>
        </dl>
      </Step>

      <Step n={2} title="Groth16 membership proof — generated in this browser (snarkjs, depth-30 Semaphore circuit)">
        <button onClick={prove} disabled={busy || artifacts === false || memberIndex < 0} data-testid="worldid-prove"
          className="px-3 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-40 text-sm text-white">
          {busy ? `Proving in browser… ${(elapsed / 1000).toFixed(1)} s` : "Generate World ID proof for the Verified Human taker"}
        </button>
        <p className="text-[11px] text-slate-500 mt-1.5">
          Nothing leaves this tab: the witness (identity secrets, merkle path) stays in browser memory; only the 4 public signals and the proof reach the chain.
          Artifacts: {w.artifactsBase}/semaphore.{"{wasm,zkey}"} (public PSE trusted setup; VK == World ID's on-chain verifier).
        </p>
        {err && <p className="mt-2 text-xs text-rose-300 break-words">{err}</p>}
        {proof && (
          <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs font-mono" data-testid="worldid-proof">
            <dt className="text-slate-500 font-sans">proving time</dt><dd className="text-emerald-300">{proof.provingMs.toLocaleString()} ms</dd>
            <dt className="text-slate-500 font-sans">merkle root</dt><dd>{short(hex(proof.root))} <span className={`font-sans ${rootStatus === "latest" || rootStatus === "historical" ? "text-emerald-300" : "text-rose-300"}`}>{rootStatus ? `router: ${rootStatus}` : ""}</span></dd>
            <dt className="text-slate-500 font-sans">nullifierHash</dt><dd>{short(hex(proof.nullifierHash))} <span className="text-slate-500 font-sans">stable per human per action → bound to the first address that swaps</span></dd>
            <dt className="text-slate-500 font-sans">signalHash</dt><dd>{short(hex(proof.signalHash))} <span className="text-slate-500 font-sans">= hashToField(taker)</span></dd>
            <dt className="text-slate-500 font-sans">externalNullifier</dt><dd>{short(hex(proof.externalNullifierHash))}</dd>
            <dt className="text-slate-500 font-sans">proof (8 × uint256)</dt>
            <dd className="break-all text-[10px] leading-4 text-slate-400 max-h-20 overflow-auto">{proofWordsHex(proof.proof)}</dd>
            <dt className="text-slate-500 font-sans">on-chain check</dt>
            <dd className={onChain?.ok ? "text-emerald-300" : "text-rose-300"} data-testid="worldid-onchain">
              {onChain ? (onChain.ok ? "✔ WorldIDAdapter → IWorldID.verifyProof → SemaphoreVerifier (ecPairing 0x08) accepted" : "✘ rejected (root / signal / external nullifier / proof)") : "…"}
            </dd>
          </dl>
        )}
      </Step>

      {proof && onChain && (
        <Step n={3} title="Pack into SwapVM takerData">
          <button onClick={attach} disabled={!onChain.ok} data-testid="worldid-attach"
            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-sm text-white">
            {isAttached ? "✔ Attached to Verified Human" : "Attach World ID proof to the swap simulator"}
          </button>
          <p className="text-[11px] text-slate-500 mt-1.5">takerData = takerTraits header ‖ [uint16 len ‖ <b>0x01</b> ‖ nullifierHash ‖ abi.encode(merkleRoot, uint256[8])] → consumed by 0x2A as proof type 1.</p>
        </Step>
      )}

      <div className="mt-4 border-t border-slate-800 pt-3" data-testid="worldid-idkit">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-sm font-medium text-slate-200">{realRouter ? "Live World ID: World App / Simulator via IDKit" : "World App / Simulator via IDKit (live World ID)"}</h3>
          <Badge tone={rpStatus === null ? "neutral" : rpStatus.configured ? "good" : "warn"}>
            {rpStatus === null ? "prover…" : rpStatus.configured ? `RP signer ready · ${rpStatus.rp_id}` : "RP signer not configured (WORLD_ID_RP_ID / WORLD_ID_RP_SIGNING_KEY)"}
          </Badge>
        </div>
        <p className="text-[11px] text-slate-500 mt-1.5">
          {realRouter
            ? <>This deployment verifies against World ID's own router at <code>{w.router}</code>; the local tree above cannot prove into it. </>
            : <>On this local chain the adapter points at <code>MockWorldIDRouter</code>, so a real World ID root will not verify here; the flow still shows the proof. </>}
          IDKit asks World App (or the Simulator for a <b>{w.environment ?? "staging"}</b> app) for an Orb proof of app <code>{w.appId}</code>,
          action <code>{idkitAction}</code>, signal = the Verified Human taker <code>{taker}</code>. The request signature comes from the local prover process.
        </p>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <button onClick={startIdKit} disabled={!rpStatus?.configured || idkitOpen} data-testid="idkit-start"
            className="px-3 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-40 text-sm text-white">Verify with World App / Simulator</button>
          {live && <button onClick={downloadLive} className="px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-500 text-sm">Download IDKit result (for IDKIT_RESULT=…)</button>}
        </div>
        {rpContext && (
          <IDKitRequestWidget
            open={idkitOpen}
            onOpenChange={setIdkitOpen}
            app_id={w.appId as `app_${string}`}
            action={idkitAction}
            action_description="AegisJIT verified-human fee tier"
            rp_context={rpContext}
            allow_legacy_proofs={true}
            environment={(w.environment ?? "staging") as "staging" | "production" | "sandbox"}
            preset={orbLegacy({ signal: taker })}
            handleVerify={handleIdKitVerify}
            onSuccess={onIdKitSuccess}
            onError={(code) => setLiveErr(`IDKit: ${code}`)}
          />
        )}
        {liveErr && <p className="mt-2 text-xs text-rose-300 break-words" data-testid="idkit-live-error">{liveErr}</p>}
        {live && (
          <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs font-mono" data-testid="idkit-live">
            <dt className="text-slate-500 font-sans">merkle root</dt><dd>{short(hex(live.root))} <span className="text-emerald-300 font-sans">✔ WorldIDAdapter accepted it on this chain</span></dd>
            <dt className="text-slate-500 font-sans">nullifierHash</dt><dd>{short(hex(live.nullifierHash))}</dd>
            <dt className="text-slate-500 font-sans">proof (8 × uint256)</dt><dd className="break-all text-[10px] leading-4 text-slate-400 max-h-20 overflow-auto">{proofWordsHex(live.proof)}</dd>
            <dt className="text-slate-500 font-sans">attached</dt><dd className="font-sans">{attached?.kind === "worldid" && attached.label === "World ID · World App" ? "✔ attached to the Verified Human profile" : "—"}</dd>
          </dl>
        )}
      </div>

      <details className="mt-4 border-t border-slate-800 pt-3 text-xs">
        <summary className="cursor-pointer text-slate-300">Paste an IDKit result instead</summary>
        <p className="text-slate-500 mt-2">
          IDKit's <code>orbLegacy({"{ signal: <taker address> }"})</code> request for this app / action returns
          <code> {"{ merkle_root, nullifier, proof }"}</code>. Those bytes form the same type-1 payload — paste a result (or the whole IDKit response) to encode and check it:
        </p>
        <textarea value={idkitJson} onChange={(e) => setIdkitJson(e.target.value)} rows={3} spellCheck={false} data-testid="idkit-json"
          placeholder='{"merkle_root":"0x…","nullifier":"0x…","proof":"0x…(abi.encode(uint256[8]))"}'
          className="mt-2 w-full bg-slate-950 border border-slate-700 rounded p-2 font-mono text-[11px] text-slate-200" />
        <button onClick={importIdKit} disabled={!idkitJson.trim()} data-testid="idkit-import"
          className="mt-2 px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-500 disabled:opacity-40 text-sm">Encode + verify on this chain</button>
        {idkit && (
          <p className={`mt-2 ${idkit.ok ? "text-emerald-300" : "text-amber-300"}`} data-testid="idkit-result">
            {idkit.error ? `✘ ${idkit.error}`
              : idkit.ok ? `✔ accepted · root ${short(hex(idkit.root))} (${idkit.rootStatus}) · nullifierHash ${short(hex(idkit.nullifierHash))}`
              : realRouter ? `✘ rejected by World ID's router: root ${short(hex(idkit.root))} (${idkit.rootStatus}), or the signal is not ${short(taker)}`
              : `✘ not verifiable here: root ${short(hex(idkit.root))} is ${idkit.rootStatus} for MockWorldIDRouter — a real World ID root verifies against the World ID Router on World Chain / Ethereum`}
          </p>
        )}
      </details>
    </div>
  );
}
