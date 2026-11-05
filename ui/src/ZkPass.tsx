// SPDX-License-Identifier: MIT
// Aadhaar ZK Pass: Secure QR -> in-browser decompression + RSA-2048 check (zkAadhaar)
// -> Groth16 proof from the local prover -> on-chain pairing check -> attach to the SwapVM simulator.
import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";

import { extractCompressedPayload } from "@/lib/aadhaar/payload";
import { parseSecureQr, type SecureQrData } from "@/lib/aadhaar/parse";
import { verifySecureQrSignature, type VerificationStatus } from "@/lib/aadhaar/verify";
import { getBuiltInKeys, type TrustedKey } from "@/lib/aadhaar/keys";
import { parsePublicKeys } from "@/lib/aadhaar/x509";
import { toBytes } from "@/lib/aadhaar/bytes";
import { createQrEngine } from "@/lib/scanner/engine";
import { decodeQrFromImageFile } from "@/lib/scanner/image-file";
import type { QrDecoder } from "@/lib/scanner/decoder";
import { AEGIS_TEST_SIGNER_CERT_PEM as testSignerPem } from "@/lib/aadhaar/aegis-test-signer";

import { proofHex, type AegisClient, type Deployment, type ProverResult } from "./lib/aegis";

export interface AttachedProof { data: Hex; result: ProverResult; verified: boolean; beneficiary: string }

interface Parsed { data: SecureQrData; status: VerificationStatus; keyLabel: string | null; trust: string | null }

const TEST_KEYS: TrustedKey[] = parsePublicKeys(testSignerPem).map((k) => ({
  id: "aegis-test-signer", label: "AegisJIT TEST signer (NOT UIDAI)", trust: "custom", spki: toBytes(k.spki),
} as TrustedKey));

function ageFromDob(dob: string): number | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(dob);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

const short = (h: string, n = 10) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);

export function ZkPass({ dep, client, onAttach, attached }: {
  dep: Deployment; client: AegisClient; onAttach: (a: AttachedProof | null) => void; attached: AttachedProof | null;
}) {
  const [health, setHealth] = useState<{ ok: boolean; artifacts: boolean } | null | undefined>(undefined);
  const [digits, setDigits] = useState<string | null>(null);
  const [png, setPng] = useState<string | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [proof, setProof] = useState<ProverResult | null>(null);
  const [onChain, setOnChain] = useState<{ ok: boolean; beneficiary: string } | null>(null);
  const [epoch, setEpoch] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<null | "qr" | "decode" | "prove">(null);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { client.proverHealth().then(setHealth); }, [client]);
  useEffect(() => {
    if (busy !== "prove") return;
    const t0 = performance.now();
    const id = setInterval(() => setElapsed(Math.round(performance.now() - t0)), 100);
    return () => clearInterval(id);
  }, [busy]);

  const reset = () => { setParsed(null); setProof(null); setOnChain(null); setErr(null); onAttach(null); };

  async function loadDigits(d: string) {
    reset();
    setDigits(d);
    // Step 1 — runs entirely in this browser tab
    const qr = parseSecureQr(extractCompressedPayload({ text: d }));
    const v = await verifySecureQrSignature(qr.signedData, qr.signature, [...getBuiltInKeys(), ...TEST_KEYS]);
    setParsed({ data: qr.data, status: v.status, keyLabel: v.key?.label ?? null, trust: v.key?.trust ?? null });
  }

  async function generateTestQr() {
    setBusy("qr"); setErr(null); setPng(null);
    try { const q = await client.testQr(); setPng(q.png); await loadDigits(q.digits); }
    catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setBusy(null); }
  }

  async function upload(file: File) {
    setBusy("decode"); setErr(null); setPng(URL.createObjectURL(file));
    try {
      const engine = await createQrEngine({ assetBase: `${window.location.origin}/` });
      const decoder = { decode: (img: ImageData, mode: "still" | "video") => engine.decode(img, mode) } as unknown as QrDecoder;
      const r = await decodeQrFromImageFile(file, decoder);
      if (!r) throw new Error("No QR code found in the image");
      await loadDigits(r.text);
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setBusy(null); }
  }

  async function prove() {
    if (!digits) return;
    setBusy("prove"); setErr(null); setProof(null); setOnChain(null);
    try {
      const r = await client.prove(digits, dep.accounts.human);
      setProof(r);
      setEpoch(await client.currentEpoch());
      setOnChain(await client.verifyOnChain(dep.accounts.human, r));
    } catch (e: any) { setErr(String(e.message ?? e)); }
    finally { setBusy(null); }
  }

  const statusBadge = (s: VerificationStatus, trust: string | null) =>
    s === "authentic" ? <Badge tone="good">✔ RSA-2048 valid · official UIDAI key</Badge>
      : s === "untrusted-key" ? <Badge tone="warn">✔ RSA-2048 valid · {trust === "demo" ? "zkAadhaar demo key" : "AegisJIT TEST signer"} (not UIDAI)</Badge>
      : s === "invalid" ? <Badge tone="bad">✘ signature invalid — tampered or unknown signer</Badge>
      : <Badge tone="bad">Web Crypto unavailable</Badge>;

  const ps = proof?.proof.publicSignals;

  return (
    <section className="rounded-xl border border-emerald-900/60 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-emerald-300">Aadhaar ZK Pass · client-side pipeline</h2>
        <Badge tone={health?.artifacts ? "good" : health ? "warn" : "bad"}>
          {health === undefined ? "prover…" : health === null ? "local prover offline" : health.artifacts ? "local prover ready" : "prover: artifacts missing"}
        </Badge>
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={generateTestQr} disabled={!!busy || !health}
          className="px-3 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm text-white">
          {busy === "qr" ? "Signing…" : "Generate signed test Aadhaar QR (Mumbai resident, age 24, Maharashtra)"}
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={!!busy}
          className="px-3 py-2 rounded-lg border border-slate-700 hover:border-slate-500 disabled:opacity-40 text-sm">
          {busy === "decode" ? "Decoding…" : "Upload Secure QR image"}
        </button>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>
      {err && <p className="mt-3 text-xs text-rose-300 break-words">{err}</p>}

      {parsed && (
        <Step n={1} title="QR decompression & RSA-2048 signature — verified in this browser">
          <div className="flex gap-4">
            {png && <img src={png} alt="Secure QR" className="w-28 h-28 rounded bg-white p-1 shrink-0 object-contain" />}
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap gap-2 mb-2">
                {statusBadge(parsed.status, parsed.trust)}
                <Badge tone="neutral">🔒 Private — parsed in browser memory, never stored</Badge>
              </div>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
                <dt className="text-slate-500">format</dt><dd>{parsed.data.version} · ref …{parsed.data.aadhaarLast4}</dd>
                <dt className="text-slate-500">name</dt><dd>{parsed.data.name}</dd>
                <dt className="text-slate-500">age</dt><dd>{ageFromDob(parsed.data.dob) ?? "?"} <span className="text-slate-500">(DOB {parsed.data.dob})</span></dd>
                <dt className="text-slate-500">state</dt><dd>{parsed.data.state}</dd>
                <dt className="text-slate-500">pincode</dt><dd>{parsed.data.pincode}</dd>
              </dl>
            </div>
          </div>
        </Step>
      )}

      {parsed && (
        <Step n={2} title="Groth16 proof (Anon Aadhaar v2 circuit, BN254)">
          <button onClick={prove} disabled={!!busy || !health?.artifacts || parsed.status === "invalid"}
            className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-sm text-white">
            {busy === "prove" ? `Proving… ${(elapsed / 1000).toFixed(1)} s` : "Generate ZK proof for the Verified Human taker"}
          </button>
          <p className="text-[11px] text-slate-500 mt-1.5">
            The proving step sends the QR payload to the local prover at {dep.zk.proverUrl} (this machine; no remote server).
            Only the public signals below ever reach the chain.
          </p>
          {proof && ps && (
            <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs font-mono">
              <dt className="text-slate-500 font-sans">proving time</dt><dd className="text-emerald-300">{proof.proof.provingMs.toLocaleString()} ms</dd>
              <dt className="text-slate-500 font-sans">ageAbove18</dt><dd>{ps.ageAbove18}</dd>
              <dt className="text-slate-500 font-sans">state</dt><dd>{proof.proof.stateText} <span className="text-slate-500">({short(ps.state, 6)})</span></dd>
              <dt className="text-slate-500 font-sans">gender / pincode</dt><dd>{ps.gender} / {ps.pincode} <span className="text-slate-500 font-sans">(not revealed)</span></dd>
              <dt className="text-slate-500 font-sans">epoch nullifier</dt><dd>{short(`0x${BigInt(ps.nullifier).toString(16)}`)} <span className="text-slate-500 font-sans">epoch #{epoch?.toString()}</span></dd>
              <dt className="text-slate-500 font-sans">signal (taker)</dt><dd>{dep.accounts.human}</dd>
              <dt className="text-slate-500 font-sans">groth16Proof</dt>
              <dd className="break-all text-[10px] leading-4 text-slate-400 max-h-20 overflow-auto">{proofHex(proof)}</dd>
              <dt className="text-slate-500 font-sans">on-chain check</dt>
              <dd className={onChain?.ok ? "text-emerald-300" : "text-rose-300"}>
                {onChain ? (onChain.ok ? "✔ AnonAadhaarAdapter → BN254 ecPairing (0x08) accepted" : "✘ rejected (trust root / epoch / freshness / signal)") : "…"}
              </dd>
            </dl>
          )}
        </Step>
      )}

      {proof && onChain && (
        <Step n={3} title="Pack into SwapVM takerData">
          <button onClick={() => onAttach({ data: client.realProofTakerData(proof), result: proof, verified: onChain.ok, beneficiary: onChain.beneficiary })}
            disabled={!onChain.ok}
            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-sm text-white">
            {attached?.result === proof ? "✔ Attached to Verified Human" : "Attach real proof to the swap simulator"}
          </button>
          <p className="text-[11px] text-slate-500 mt-1.5">takerData = takerTraits header ‖ [uint16 len ‖ nullifier ‖ revealArray[4] ‖ abi.encode(timestamp, uint256[8])] → consumed by 0x2A.</p>
        </Step>
      )}
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-slate-800 pt-3">
      <div className="text-xs font-semibold text-slate-300 mb-2"><span className="text-emerald-400 mr-2">{n}</span>{title}</div>
      {children}
    </div>
  );
}

function Badge({ tone, children }: { tone: "good" | "warn" | "bad" | "neutral"; children: React.ReactNode }) {
  const c = { good: "border-emerald-700 text-emerald-300", warn: "border-amber-700 text-amber-300", bad: "border-rose-700 text-rose-300", neutral: "border-slate-700 text-slate-300" }[tone];
  return <span className={`text-[11px] px-2 py-0.5 rounded border ${c}`}>{children}</span>;
}
