// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import {
  createAegisClient, disassemble, feeModel, fmtUnits, splitOrder, USDC_DEC, WETH_DEC,
  type AegisClient, type ChainState, type Deployment, type Frame, type FrameKind, type Order, type Profile,
  type QuoteResult, type SplitResult,
} from "./lib/aegis";
import { ZkPass, type AttachedProof } from "./ZkPass";

const KIND_STYLE: Record<FrameKind, { chip: string; text: string; ring: string; label: string }> = {
  zk: { chip: "bg-emerald-500/15 border-emerald-500/50", text: "text-emerald-300", ring: "ring-emerald-400", label: "0x2A ZK guard" },
  jit: { chip: "bg-indigo-500/15 border-indigo-500/50", text: "text-indigo-300", ring: "ring-indigo-400", label: "0x9A JIT vault" },
  fee: { chip: "bg-amber-500/15 border-amber-500/50", text: "text-amber-300", ring: "ring-amber-400", label: "0x7A surge fee" },
  stock: { chip: "bg-slate-500/10 border-slate-600", text: "text-slate-300", ring: "ring-slate-400", label: "stock SwapVM" },
};

const PROFILES: Record<Profile, { title: string; sub: string; amount: number }> = {
  human: { title: "Verified Human", sub: "Anon Aadhaar ZK proof attached · signal = taker", amount: 5_000 },
  bot: { title: "Unverified MEV Bot", sub: "no proof · full base fee + surge", amount: 50_000 },
  split: { title: "Split-Order Attacker", sub: "5 × legs in one rolling window", amount: 50_000 },
  whale: { title: "Whale", sub: "tries to drain the vault", amount: 500_000 },
};

const usdc = (v: bigint, dp = 2) => fmtUnits(v, USDC_DEC, dp);
const weth = (v: bigint, dp = 4) => fmtUnits(v, WETH_DEC, dp);
const shortHex = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const bps = (fee: bigint, amt: bigint) => (amt === 0n ? "—" : `${(Number(fee * 1_000_000n / amt) / 100).toFixed(2)} bps`);

interface LogEntry { t: string; profile: Profile; amountIn: bigint; quoteOut?: bigint; actualOut?: bigint; hash: Hex; gas: bigint; note?: string }

export default function App() {
  const [dep, setDep] = useState<Deployment | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  useEffect(() => {
    fetch("/deployment.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("deployment.json not found — run scripts/start-local-demo.sh"))))
      .then(setDep)
      .catch((e) => setLoadErr(String(e.message ?? e)));
  }, []);
  const client = useMemo(() => (dep ? createAegisClient(dep) : null), [dep]);

  if (loadErr) return <Shell><div className="p-8 text-rose-300">{loadErr}</div></Shell>;
  if (!dep || !client) return <Shell><div className="p-8 text-slate-400">Loading deployment…</div></Shell>;
  return <Dashboard dep={dep} client={client} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-slate-950 text-slate-200 font-sans">{children}</div>;
}

function Dashboard({ dep, client }: { dep: Deployment; client: AegisClient }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [shipTx, setShipTx] = useState<Hex | null>(null);
  const [state, setState] = useState<ChainState | null>(null);
  const [rpcErr, setRpcErr] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<Hex | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [attached, setAttached] = useState<AttachedProof | null>(null);

  const refresh = useCallback(async () => {
    try { setState(await client.readState()); setRpcErr(null); } catch (e: any) { setRpcErr(e.shortMessage ?? String(e)); }
  }, [client]);

  useEffect(() => {
    client.fetchLiveOrder().then(({ order, txHash }) => { setOrder(order); setShipTx(txHash); }).catch((e) => setRpcErr(String(e.message ?? e)));
    client.snapshot().then(setBaseline).catch(() => {});
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [client, refresh]);

  const resetChain = async () => {
    if (!baseline) return;
    await client.revert(baseline);
    setBaseline(await client.snapshot());
    setLog([]);
    await refresh();
  };

  return (
    <Shell>
      <header className="border-b border-slate-800 px-6 py-4 flex flex-wrap items-center gap-4 justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white">AegisJIT <span className="text-slate-500 font-normal">· SwapVM Inspector</span></h1>
          <p className="text-xs text-slate-500">Custom-opcode AMM & self-custodial JIT vault on 1inch Aqua + SwapVM · Powered by SwapVM — © Degensoft Ltd 2025</p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className={`px-2 py-1 rounded border ${rpcErr ? "border-rose-600 text-rose-300" : "border-emerald-700 text-emerald-300"}`}>
            {rpcErr ? `RPC error: ${rpcErr}` : `chain ${dep.chainId} · block #${state?.blockNumber ?? "…"}`}
          </span>
          <button onClick={resetChain} disabled={!baseline} className="px-3 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40">Reset chain to page load</button>
        </div>
      </header>

      <main className="grid grid-cols-1 xl:grid-cols-2 gap-6 p-6">
        {order ? <Disassembler dep={dep} order={order} shipTx={shipTx} zk={attached} /> : <Card title="SwapVM bytecode"><p className="text-slate-500 text-sm">Fetching order from Aqua Shipped event…</p></Card>}
        <div className="flex flex-col gap-6">
          <ZkPass dep={dep} client={client} attached={attached} onAttach={setAttached} />
          <Simulator dep={dep} client={client} state={state} humanData={attached?.data} onDone={async (e) => { setLog((l) => [...e, ...l]); await refresh(); }} />
          {state && <VaultPanel dep={dep} state={state} />}
          <ActivityLog log={log} />
        </div>
      </main>
    </Shell>
  );
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex items-center justify-between mb-4 gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

// ------------------------------------------------------------------ disassembler
function Disassembler({ dep, order, shipTx, zk }: { dep: Deployment; order: Order; shipTx: Hex | null; zk: AttachedProof | null }) {
  const { sections, program, programOffset } = useMemo(() => splitOrder(order), [order]);
  const tokenA = (BigInt(dep.addr.usdc) < BigInt(dep.addr.weth) ? dep.addr.usdc : dep.addr.weth);
  const frames = useMemo(() => disassemble(program, { tokenA, usdc: dep.addr.usdc }), [program, tokenA, dep.addr.usdc]);
  const [hover, setHover] = useState<number | null>(null);

  return (
    <Card title="SwapVM bytecode disassembler" right={<span className="text-xs text-slate-500">live from Aqua <code>Shipped</code> {shipTx ? shortHex(shipTx) : ""}</span>}>
      <div className="flex flex-wrap gap-2 mb-3 text-[11px]">
        {(Object.keys(KIND_STYLE) as FrameKind[]).map((k) => (
          <span key={k} className={`px-2 py-0.5 rounded border ${KIND_STYLE[k].chip} ${KIND_STYLE[k].text}`}>{KIND_STYLE[k].label}</span>
        ))}
        <span className="px-2 py-0.5 rounded border border-slate-800 text-slate-500">order header</span>
      </div>

      <div className="font-mono text-[11px] leading-5 break-all rounded-lg bg-slate-950 border border-slate-800 p-3 max-h-72 overflow-auto">
        <span className="text-slate-500">0x</span>
        {sections.map((s) => <span key={s.name} title={s.name} className="text-slate-600">{s.hex.slice(2)}</span>)}
        {frames.map((f) => {
          const st = KIND_STYLE[f.kind];
          const h = f.hex.slice(2);
          return (
            <span key={f.pc} onMouseEnter={() => setHover(f.pc)} onMouseLeave={() => setHover(null)}
              className={`rounded-sm px-[1px] border ${st.chip} ${hover === f.pc ? `ring-1 ${st.ring}` : ""}`} title={`${f.name} @ pc ${f.pc}`}>
              <span className={`font-bold ${st.text}`}>{h.slice(0, 2)}</span>
              <span className="text-slate-400">{h.slice(2, 4)}</span>
              <span className={st.text + " opacity-80"}>{h.slice(4)}</span>
            </span>
          );
        })}
      </div>
      <p className="text-[11px] text-slate-500 mt-2">
        {order.data.length / 2 - 1} bytes order data · program starts at byte {programOffset} (MakerTraits slice index 3) · frame = <b className="text-slate-300">[opcode]</b>[len][args]
      </p>

      <ol className="mt-4 space-y-2">
        {frames.map((f, i) => {
          const st = KIND_STYLE[f.kind];
          return (
            <li key={f.pc} onMouseEnter={() => setHover(f.pc)} onMouseLeave={() => setHover(null)}
              className={`rounded-lg border p-3 ${st.chip} ${hover === f.pc ? `ring-1 ${st.ring}` : ""}`}>
              <div className="flex items-baseline gap-3">
                <span className="text-slate-500 text-xs w-5">[{i}]</span>
                <code className={`font-bold ${st.text}`}>0x{f.opcode.toString(16).padStart(2, "0")}</code>
                <span className="font-medium text-slate-100">{f.name}</span>
                {f.kind === "zk" && (
                  <span className={`text-[11px] px-2 py-0.5 rounded border ${zk?.verified ? "border-emerald-500 text-emerald-200 bg-emerald-500/20" : "border-slate-700 text-slate-400"}`}>
                    {zk?.verified ? "PASSED (Real Groth16 verified · ecPairing 0x08)" : "awaiting proof → unverified takers priced as bots"}
                  </span>
                )}
                <span className="ml-auto text-[11px] text-slate-500">pc {f.pc} · {f.hex.length / 2 - 3} B args</span>
              </div>
              {f.fields.length > 0 && (
                <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs">
                  {f.fields.map(([k, v]) => (
                    <div key={k} className="contents"><dt className="text-slate-500">{k}</dt><dd className="font-mono text-slate-300 break-all">{v}</dd></div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

// ------------------------------------------------------------------ simulator
function Simulator({ dep, client, state, humanData, onDone }: { dep: Deployment; client: AegisClient; state: ChainState | null; humanData?: Hex; onDone: (e: LogEntry[]) => Promise<void> }) {
  const [profile, setProfile] = useState<Profile>("human");
  const [amount, setAmount] = useState(PROFILES.human.amount);
  const [q, setQ] = useState<QuoteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ quoteOut?: bigint; actualOut?: bigint; hash?: Hex; note?: string } | null>(null);
  const [split, setSplit] = useState<SplitResult | null>(null);
  const reqId = useRef(0);

  const amountIn = BigInt(amount) * 10n ** 6n;
  const human = profile === "human";
  const override = human ? humanData : undefined;

  useEffect(() => {
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      const r = await client.quote(profile === "split" ? "bot" : profile, amountIn, override);
      if (id === reqId.current) setQ(r);
    }, 120);
    return () => clearTimeout(t);
  }, [client, profile, amountIn, state?.blockNumber, override]);

  const model = state ? feeModel(dep, state, amountIn, human) : null;
  const botModel = state && human ? feeModel(dep, state, amountIn, false) : null;
  const modelOk = q?.ok && model ? q.amountOut === model.expectedOut : undefined;

  const pick = (p: Profile) => { setProfile(p); setAmount(PROFILES[p].amount); setLast(null); setSplit(null); };

  const execute = async () => {
    setBusy(true); setLast(null);
    try {
      const s = await client.swap(profile, amountIn, override);
      const quoteOut = s.quote.ok ? s.quote.amountOut : undefined;
      const note = s.reverted ? (s.quote.ok ? "reverted" : `reverted: ${s.quote.error}`) : undefined;
      setLast({ quoteOut, actualOut: s.amountOut, hash: s.hash, note });
      await onDone([{ t: new Date().toLocaleTimeString(), profile, amountIn, quoteOut, actualOut: s.amountOut, hash: s.hash, gas: s.gasUsed, note }]);
    } finally { setBusy(false); }
  };

  const runSplit = async () => {
    setBusy(true); setSplit(null);
    try { setSplit(await client.splitAttack(amountIn, 5)); await onDone([]); } finally { setBusy(false); }
  };

  // surge accumulator bar
  const thr = model?.threshold ?? 0n;
  const prior = model?.priorFlow ?? 0n;
  const scale = Number(thr) > 0 ? Math.max(Number(prior + amountIn), Number(thr) * 1.25) : 1;
  const pctOf = (v: bigint) => `${Math.min(100, (Number(v) / scale) * 100)}%`;
  const remaining = state && model?.windowActive ? Number(state.window.start + BigInt(dep.cfg.decayWindowSec) - state.timestamp) : null;

  return (
    <Card title="Trade & quote simulator · USDC → WETH">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        {(Object.keys(PROFILES) as Profile[]).map((p) => (
          <button key={p} onClick={() => pick(p)}
            className={`text-left rounded-lg border p-2.5 transition ${profile === p ? "border-sky-500 bg-sky-500/10" : "border-slate-800 hover:border-slate-600"}`}>
            <div className="text-sm font-medium text-slate-100">{PROFILES[p].title}</div>
            <div className="text-[11px] text-slate-500 leading-tight">{PROFILES[p].sub}</div>
          </button>
        ))}
      </div>

      {human && (
        <p className={`text-[11px] mb-2 ${humanData ? "text-emerald-300" : "text-slate-500"}`}>
          {humanData ? "✔ Using the real Groth16 proof from the Aadhaar ZK Pass" : "Using the seeded real Groth16 proof (attach a fresh one from the ZK Pass above)"}
        </p>
      )}
      <label className="flex items-center justify-between text-xs text-slate-400 mb-1">
        <span>Amount in</span><span className="font-mono text-slate-100 text-sm">{amount.toLocaleString()} USDC{profile === "split" ? ` = 5 × ${(amount / 5).toLocaleString()}` : ""}</span>
      </label>
      <input type="range" min={1_000} max={600_000} step={1_000} value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="w-full accent-sky-500" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4">
        <Stat label={profile === "split" ? "quote() · as one trade" : "router.asView().quote()"}
          value={q ? (q.ok ? `${weth(q.amountOut, 6)} WETH` : "reverts") : "…"}
          sub={q && !q.ok ? q.error.replace(/\((\d+), (\d+)\)/, (_, a, b) => `(${weth(BigInt(a), 2)}, cap ${weth(BigInt(b), 2)} WETH)`) : q?.ok ? `${usdc(amountIn * 10n ** 18n / q.amountOut)} USDC/WETH` : ""}
          tone={q && !q.ok ? "bad" : undefined} />
        <Stat label="Effective 0x7A fee" value={model ? bps(model.total, amountIn) : "…"}
          sub={model ? `${usdc(model.base)} base + ${usdc(model.surge)} surge USDC${botModel ? ` · unverified bot: ${bps(botModel.total, amountIn)}` : ""}` : ""}
          tone={model && model.surge > 0n ? "warn" : human ? "good" : undefined} />
        <Stat label="Off-chain model vs chain" value={modelOk === undefined ? "—" : modelOk ? "match ✔" : "mismatch"} sub="independent TS mirror of 0x9A+0x7A+XYC" tone={modelOk === false ? "bad" : "good"} />
      </div>

      <div className="mt-5">
        <div className="flex justify-between text-[11px] text-slate-400 mb-1">
          <span>Rolling-window surge accumulator {model?.windowActive ? `· ${remaining}s left` : "· window idle (next trade opens it)"}</span>
          <span className="font-mono">{usdc(prior, 0)} + {usdc(amountIn, 0)} / threshold {usdc(thr, 0)} USDC</span>
        </div>
        <div className="relative h-4 rounded bg-slate-800 overflow-hidden">
          <div className="absolute inset-y-0 left-0 bg-slate-500" style={{ width: pctOf(prior) }} />
          <div className="absolute inset-y-0 bg-amber-500/70" style={{ left: pctOf(prior), width: `calc(${pctOf(prior + amountIn)} - ${pctOf(prior)})` }} />
          <div className="absolute inset-y-0 w-0.5 bg-rose-400" style={{ left: pctOf(thr) }} title="surge threshold" />
        </div>
        <div className="flex gap-4 text-[10px] text-slate-500 mt-1">
          <span><i className="inline-block w-2 h-2 bg-slate-500 mr-1" />flow already in window</span>
          <span><i className="inline-block w-2 h-2 bg-amber-500/70 mr-1" />this trade</span>
          <span><i className="inline-block w-2 h-2 bg-rose-400 mr-1" />surge threshold (flow beyond pays {(dep.cfg.maxSurgeFeeBps / 1e7).toFixed(2)}% marginal)</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mt-5">
        {profile !== "split" ? (
          <button onClick={execute} disabled={busy} className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-sm font-medium text-white">
            {busy ? "Executing…" : "Execute swap() on-chain"}
          </button>
        ) : (
          <button onClick={runSplit} disabled={busy} className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-sm font-medium text-white">
            {busy ? "Running…" : "Run 5-leg split attack (evm_snapshot sandbox)"}
          </button>
        )}
      </div>

      {last && (
        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <span className="text-slate-500">quote() before tx</span><span className="font-mono">{last.quoteOut !== undefined ? `${weth(last.quoteOut, 18)} WETH` : "reverted"}</span>
          <span className="text-slate-500">swap() executed</span><span className="font-mono">{last.actualOut !== undefined ? `${weth(last.actualOut, 18)} WETH` : last.note}</span>
          <span className="text-slate-500">divergence</span>
          <span className={`font-mono ${last.actualOut !== undefined && last.actualOut === last.quoteOut ? "text-emerald-300" : "text-rose-300"}`}>
            {last.actualOut !== undefined && last.quoteOut !== undefined ? `${(last.actualOut - last.quoteOut).toString()} wei` : "tx reverted (as quoted)"}
          </span>
          <span className="text-slate-500">tx</span><span className="font-mono">{last.hash}</span>
        </div>
      )}

      {split && <SplitTable split={split} total={amountIn} />}
    </Card>
  );
}

function SplitTable({ split, total }: { split: SplitResult; total: bigint }) {
  const out = split.legs.reduce((a, l) => a + l.amountOut, 0n);
  const fee = split.legs.reduce((a, l) => a + l.fee.total, 0n);
  const singleOut = split.single.ok ? split.single.amountOut : 0n;
  const ok = out <= singleOut && fee >= split.singleFee.total;
  return (
    <div className="mt-4 text-xs">
      <table className="w-full font-mono">
        <thead className="text-slate-500"><tr><th className="text-left font-normal py-1">trade</th><th className="text-right font-normal">window flow</th><th className="text-right font-normal">surge</th><th className="text-right font-normal">fee</th><th className="text-right font-normal">WETH out</th></tr></thead>
        <tbody>
          <tr className="border-t border-slate-800"><td className="py-1">1 × {usdc(total, 0)}</td><td className="text-right">{usdc(split.singleFee.priorFlow, 0)}</td><td className="text-right">{usdc(split.singleFee.surge)}</td><td className="text-right">{usdc(split.singleFee.total)}</td><td className="text-right">{weth(singleOut, 6)}</td></tr>
          {split.legs.map((l, i) => (
            <tr key={i} className="border-t border-slate-900 text-slate-400"><td className="py-1">leg {i + 1} × {usdc(l.amountIn, 0)}</td><td className="text-right">{usdc(l.fee.priorFlow, 0)}</td><td className="text-right">{usdc(l.fee.surge)}</td><td className="text-right">{usdc(l.fee.total)}</td><td className="text-right">{weth(l.amountOut, 6)}</td></tr>
          ))}
          <tr className="border-t border-slate-700 text-slate-100"><td className="py-1">split total</td><td /><td className="text-right">{usdc(split.legs.reduce((a, l) => a + l.fee.surge, 0n))}</td><td className="text-right">{usdc(fee)}</td><td className="text-right">{weth(out, 6)}</td></tr>
        </tbody>
      </table>
      <p className={`mt-2 ${ok ? "text-emerald-300" : "text-rose-300"}`}>
        {ok ? "✔ sub-additive: split pays ≥ the single-trade fee and gets ≤ its output" : "✘ invariant violated"} · each leg executed on-chain (swap == quote), then evm_revert
      </p>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-rose-300" : tone === "warn" ? "text-amber-300" : tone === "good" ? "text-emerald-300" : "text-slate-100";
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`font-mono text-lg ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-slate-500 break-words">{sub}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ vault
function VaultPanel({ dep, state }: { dep: Deployment; state: ChainState }) {
  const total = state.vault.weth;
  const capPct = total === 0n ? 0 : Number(state.capOut * 10_000n / total) / 100;
  return (
    <Card title="Maker ERC-4626 vault · 0x9A exposure">
      <div className="text-xs text-slate-400 mb-1 flex justify-between">
        <span>avWETH backing {weth(total, 2)} WETH</span>
        <span>λ = {dep.cfg.lambdaBps / 100}% per execution</span>
      </div>
      <div className="flex h-6 rounded overflow-hidden text-[10px] font-medium">
        <div className="bg-indigo-500/80 flex items-center justify-center text-white" style={{ width: `${capPct}%` }}>exposed {weth(state.capOut, 2)}</div>
        <div className="bg-emerald-600/40 flex-1 flex items-center justify-center text-emerald-100">untouched, earning yield {weth(total - state.capOut, 2)}</div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mt-3">
        <dt className="text-slate-500">avUSDC backing</dt><dd className="font-mono text-right">{usdc(state.vault.usdc)} USDC</dd>
        <dt className="text-slate-500">Aqua book (USDC / WETH)</dt><dd className="font-mono text-right">{usdc(state.aqua.usdc)} / {weth(state.aqua.weth)}</dd>
        <dt className="text-slate-500">book == vault backing</dt>
        <dd className={`text-right ${state.aqua.usdc === state.vault.usdc && state.aqua.weth === state.vault.weth ? "text-emerald-300" : "text-amber-300"}`}>
          {state.aqua.usdc === state.vault.usdc && state.aqua.weth === state.vault.weth ? "yes ✔" : "diverged"}
        </dd>
      </dl>
    </Card>
  );
}

function ActivityLog({ log }: { log: LogEntry[] }) {
  if (log.length === 0) return null;
  return (
    <Card title="On-chain activity">
      <table className="w-full text-xs font-mono">
        <thead className="text-slate-500"><tr><th className="text-left font-normal">time</th><th className="text-left font-normal">taker</th><th className="text-right font-normal">in</th><th className="text-right font-normal">out</th><th className="text-right font-normal">Δ quote</th><th className="text-right font-normal">gas</th><th className="text-right font-normal">tx</th></tr></thead>
        <tbody>
          {log.map((e, i) => (
            <tr key={i} className="border-t border-slate-800">
              <td className="py-1 text-slate-500">{e.t}</td><td>{PROFILES[e.profile].title}</td>
              <td className="text-right">{usdc(e.amountIn, 0)}</td>
              <td className="text-right">{e.actualOut !== undefined ? weth(e.actualOut) : <span className="text-rose-300">reverted</span>}</td>
              <td className="text-right">{e.actualOut !== undefined && e.quoteOut !== undefined ? `${e.actualOut - e.quoteOut} wei` : "—"}</td>
              <td className="text-right">{e.gas.toString()}</td><td className="text-right">{shortHex(e.hash)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
