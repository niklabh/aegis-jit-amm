// SPDX-License-Identifier: MIT
// "About" header: what AegisJIT is, the three custom opcodes with this deployment's parameters, and links to the
// repository and to every public deployment's contracts (deployment.json → about, written by the seed scripts).
import type { Deployment } from "./lib/aegis";

const REPO_FALLBACK = "https://github.com/niklabh/aegis-jit-amm";
const NAMES: Record<string, string> = {
  router: "AegisSwapVMRouter", aqua: "Aqua", hook: "AegisJITVaultHook", strategy: "AegisJITStrategy", forwarder: "AegisZKForwarder",
  usdcVault: "avUSDC vault (ERC-4626)", wethVault: "avWETH vault (ERC-4626)", usdc: "USDC", weth: "WETH",
  worldIdAdapter: "WorldIDAdapter · 0x2A type 1", worldIdRouter: "World ID Router", semaphoreVerifier: "SemaphoreVerifier (World ID's)",
  adapter: "AnonAadhaarAdapter · 0x2A type 2", groth16: "AnonAadhaarGroth16Verifier", pairingVerifier: "Anon Aadhaar v2 pairing verifier",
};
const ORDER = ["router", "aqua", "hook", "strategy", "forwarder", "usdcVault", "wethVault", "worldIdAdapter", "worldIdRouter", "semaphoreVerifier", "adapter", "groth16", "pairingVerifier", "usdc", "weth"];
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;
const num = (v: unknown) => Number(v ?? 0);

const link = "underline decoration-slate-600 underline-offset-2 hover:text-white";

export function About({ dep }: { dep: Deployment }) {
  const about = dep.about;
  const repo = about?.repo ?? REPO_FALLBACK;
  const c = dep.cfg as Record<string, unknown>;
  const lambda = num(c.lambdaBps) / 100, expWin = num(c.exposureWindowSec);
  const base = num(c.baseFeeBps) / 1e7, surge = num(c.maxSurgeFeeBps) / 1e7, thr = num(c.impactThresholdBps) / 100, win = num(c.decayWindowSec);
  const pct = (x: number) => `${Number(x.toFixed(2))}%`;

  const ops = [
    { code: "0x2A", name: "ZKIdentityGuard", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
      text: `A proof of personhood travels in takerData: World ID (Orb proof via IDKit) or Anon Aadhaar (Secure QR → Groth16). It is bound to the taker address and the nullifier stays with its first address. A valid proof buys the retail tier; no proof means bot pricing, never a revert in tiered mode.` },
    { code: "0x9A", name: "JITVaultReserves", cls: "border-indigo-500/40 bg-indigo-500/10 text-indigo-300",
      text: `Only λ = ${pct(lambda)} of each ERC-4626 vault is exposed per execution${expWin ? ` and per ${expWin} s window` : ""}. A whale asking for more reverts with JITExposureCapExceeded; the rest never leaves the vault and keeps earning.` },
    { code: "0x7A", name: "VolatilitySurgeFee", cls: "border-amber-500/40 bg-amber-500/10 text-amber-300",
      text: `Token-bucket surge fee: ${pct(base)} base (${pct(base / 2)} for verified humans), ${pct(surge)} marginal on flow beyond ${pct(thr)} of the active reserves within a ${win} s window. Bots and split orders pay it; the bucket never resets inside a window.` },
  ];

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-4xl">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">About AegisJIT · {about?.event ?? "ETHGlobal Mumbai 2026"}</h2>
          <p className="mt-2 text-sm text-slate-300 leading-relaxed">
            AegisJIT is a <b>1inch Aqua</b> strategy whose pricing is three custom <b>SwapVM</b> opcodes. The Maker's capital stays in two ERC-4626 vaults
            (USDC and WETH); every swap runs the order's bytecode through <code>AegisSwapVMRouter</code>, and <code>router.asView().quote()</code> equals{" "}
            <code>swap()</code> to the wei because every opcode is view-safe. Humans prove personhood once, bots pay the surge, whales hit the cap.
            The left column decodes the live order from Aqua's <code>Shipped</code> event; the right column attaches a pass and quotes every profile.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <a href={repo} target="_blank" rel="noreferrer" className="px-2 py-1 rounded border border-slate-700 text-slate-200 hover:border-slate-400" title={repo}>GitHub ↗</a>
          <a href={about?.readme ?? `${repo}#readme`} target="_blank" rel="noreferrer" className="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:border-slate-500">README ↗</a>
          {about?.deployments.map((d) => d.explorer && (
            <a key={d.network} href={`${d.explorer}/address/${d.contracts.router}`} target="_blank" rel="noreferrer"
              className="px-2 py-1 rounded border border-slate-700 text-slate-300 hover:border-slate-500" title={`AegisSwapVMRouter on ${d.label}`}>
              {d.label} contracts ↗
            </a>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        {ops.map((o) => (
          <div key={o.code} className={`rounded-lg border p-3 ${o.cls}`}>
            <div className="font-mono text-xs"><b>{o.code}</b> {o.name}</div>
            <p className="mt-1 text-xs text-slate-300 leading-relaxed">{o.text}</p>
          </div>
        ))}
      </div>

      {about && about.deployments.length > 0 && (
        <div className="mt-4 flex flex-col gap-2">
          {about.deployments.map((d) => {
            const here = d.chainId === dep.chainId;
            const keys = [...ORDER.filter((k) => d.contracts[k]), ...Object.keys(d.contracts).filter((k) => !ORDER.includes(k))];
            const addr = (a: string) => (d.explorer ? `${d.explorer}/address/${a}` : undefined);
            return (
              <details key={d.network} open={here} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs">
                <summary className="cursor-pointer select-none text-slate-300">
                  <b className="text-slate-200">{d.label}</b> · chain {d.chainId}{here ? <span className="ml-2 px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/40 text-sky-300">this page</span> : null}
                  {" · "}{keys.length} contracts, source-verified{d.realWorldId ? " · the chain's real World ID Router" : " · mock World ID router"}
                  {" · "}<a href={d.readme} target="_blank" rel="noreferrer" className={link}>README section ↗</a>
                </summary>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {keys.map((k) => {
                    const a = d.contracts[k], href = addr(a), label = NAMES[k] ?? k;
                    const body = <><span className="text-slate-300">{label}</span> <span className="font-mono text-slate-500">{short(a)}</span></>;
                    return href
                      ? <a key={k} href={href} target="_blank" rel="noreferrer" title={a} className="px-2 py-1 rounded border border-slate-800 bg-slate-900 hover:border-slate-600">{body}</a>
                      : <span key={k} title={a} className="px-2 py-1 rounded border border-slate-800 bg-slate-900">{body}</span>;
                  })}
                </div>
                <div className="mt-2 text-slate-500">
                  order <span className="font-mono">{short(d.orderHash)}</span> · shipped in{" "}
                  {d.explorer ? <a href={`${d.explorer}/tx/${d.shipTx}`} target="_blank" rel="noreferrer" className={`font-mono ${link}`}>{short(d.shipTx)}</a> : <span className="font-mono">{short(d.shipTx)}</span>}
                  {d.shipBlock ? ` (block ${d.shipBlock.toLocaleString()})` : ""}{d.deployedAt ? ` · deployed ${d.deployedAt.slice(0, 10)}` : ""}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}
