// SPDX-License-Identifier: MIT
// Framework-agnostic AegisJIT client used by the dashboard (and ui/scripts/smoke.ts).

import {
  createPublicClient, createWalletClient, decodeAbiParameters, defineChain, encodeAbiParameters, encodePacked,
  http, parseEventLogs, size, BaseError, ContractFunctionRevertedError, concat, pad, slice, toHex, type Address, type Hex,
} from "viem";
import { worldIdEnvelope } from "./worldid";

export type Order = { maker: Address; traits: Hex; data: Hex };
export type Profile = "human" | "bot" | "split" | "whale";

export interface Deployment {
  chainId: number;
  rpcUrl: string;
  shipBlock: number;
  orderHash: Hex;
  order: Order;
  cfg: {
    usdcLiquidity: string; wethLiquidity: string; lambdaBps: number; virtualBoostBps: number; exposureWindowSec: number;
    baseFeeBps: number; maxSurgeFeeBps: number; impactThresholdBps: string; decayWindowSec: number;
  };
  addr: Record<"aqua" | "router" | "hook" | "usdc" | "weth" | "usdcVault" | "wethVault" | "adapter" | "anonAadhaar" | "groth16" | "pairingVerifier" | "forwarder" | "maker", Address>
    & Partial<Record<"worldIdAdapter" | "worldIdRouter" | "semaphoreVerifier" | "semaphoreMock" | "semaphoreReal", Address>>;
  accounts: Record<"maker" | "human" | "bot" | "whale", Address>;
  takerData: Record<"human" | "bot" | "whale", Hex> & { worldIdHuman?: Hex };
  zk: { proverUrl: string; epochDuration: number; payloadLength: number; takerHeader: Hex; trustRoot: string; maharashtraPacked: string };
  /** World ID pass config (scripts/seed-local.ts) */
  worldId?: {
    backend: "semaphore" | "mock";
    appId: string;
    action: string;
    /** action rotation epoch in seconds (0 = one static action) */
    epochDuration?: number;
    externalNullifier: string;
    groupId: number;
    treeDepth: number;
    identityPrefix: string;
    members: string[];
    root: string;
    rootHistoryExpiry: number;
    payloadLength: number;
    takerHeader: Hex;
    /** URL base the dashboard serves semaphore.wasm / semaphore.zkey from */
    artifactsBase: string;
  };
  abi: { router: any; vault: any; aqua: any; adapter: any; worldIdAdapter?: any; worldIdRouter?: any; semaphoreVerifier?: any };
}

/** Output of the local prover (packages/zk-aadhaar/prover/server.ts) */
export interface ProverResult {
  qr: { version: string; rsa: { status: string; key: string | null } };
  proof: {
    groth16Proof: string[];
    publicSignals: Record<"pubkeyHash" | "nullifier" | "timestamp" | "ageAbove18" | "gender" | "pincode" | "state" | "nullifierSeed" | "signalHash", string>;
    provingMs: number;
    stateText: string;
  };
}

/** 0x2A proof types (selector byte at the start of the taker payload) */
export const ZK_TYPE_WORLD_ID = 1;
export const ZK_TYPE_AADHAAR = 2;

/** 0x2A ZK Aadhaar taker payload: [uint16 L][0x02][nullifier][revealArray[4]][abi.encode(timestamp, epoch, pubkeyHash, uint256[8])] */
export function encodeZkPayload(r: ProverResult, epoch: bigint): Hex {
  const ps = r.proof.publicSignals;
  const envelope = proofEnvelope(r, epoch);
  const body = encodePacked(
    ["uint8", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes"],
    [ZK_TYPE_AADHAAR, BigInt(ps.nullifier), BigInt(ps.ageAbove18), BigInt(ps.gender), BigInt(ps.pincode), BigInt(ps.state), envelope],
  );
  return encodePacked(["uint16", "bytes"], [size(body), body]);
}

/** AnonAadhaarAdapter envelope (direct): (timestamp, epoch, pubkeyHash, proof[8]); pubkeyHash selects the UIDAI key in the verifier's set */
export function proofEnvelope(r: ProverResult, epoch: bigint): Hex {
  return encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256[8]" }],
    [BigInt(r.proof.publicSignals.timestamp), epoch, BigInt(r.proof.publicSignals.pubkeyHash), r.proof.groth16Proof.map(BigInt) as any]);
}

/** Groth16 proof as 256 bytes (8 × 32-byte BN254 coordinates) */
export const proofHex = (r: ProverResult): Hex => encodePacked(Array(8).fill("uint256"), r.proof.groth16Proof.map(BigInt) as any);

/**
 * takerData = takerTraits header ‖ instructionsArgs. The 22-byte header is 20 bytes of slice
 * indexes (only index9, the end of instructionsArgs, is non-zero here: no threshold / to /
 * deadline / hooks) + 2 bytes of flags (exactIn, transferFrom+Aqua push, A→B). The flags are
 * taken from the seeded header, so this works for any payload length and proof type.
 */
export function buildTakerData(dep: Deployment, instructionsArgs: Hex): Hex {
  const flags = slice(dep.zk.takerHeader, 20, 22);
  const indexes = pad(toHex(BigInt(size(instructionsArgs)) << 144n), { size: 20 });
  return concat([indexes, flags, instructionsArgs]);
}

export const FEE_BPS = 1_000_000_000n;
export const USDC_DEC = 6;
export const WETH_DEC = 18;

export function createAegisClient(dep: Deployment) {
  const chain = defineChain({
    id: dep.chainId, name: "Hardhat",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [dep.rpcUrl] } },
  });
  const transport = http(dep.rpcUrl);
  const pub = createPublicClient({ chain, transport });
  const wallet = createWalletClient({ chain, transport });
  const R = { address: dep.addr.router, abi: dep.abi.router } as const;

  const takerOf = (p: Profile): Address => (p === "split" ? dep.accounts.bot : dep.accounts[p]);
  const dataOf = (p: Profile): Hex => dep.takerData[p === "split" ? "bot" : p];

  // ------------------------------------------------------------------ order + disassembler
  async function fetchLiveOrder(): Promise<{ order: Order; txHash: Hex }> {
    const logs = await pub.getContractEvents({
      address: dep.addr.aqua, abi: dep.abi.aqua, eventName: "Shipped", fromBlock: BigInt(dep.shipBlock),
    });
    const log = (logs as any[]).find((l) => l.args.strategyHash.toLowerCase() === dep.orderHash.toLowerCase());
    if (!log) throw new Error("Shipped event for orderHash not found");
    const [o] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "maker", type: "address" }, { name: "traits", type: "uint256" }, { name: "data", type: "bytes" }] }],
      log.args.strategy,
    ) as any;
    return { order: { maker: o.maker, traits: `0x${o.traits.toString(16).padStart(64, "0")}`, data: o.data }, txHash: log.transactionHash };
  }

  // ------------------------------------------------------------------ quote / swap
  async function quote(p: Profile, amountIn: bigint, dataOverride?: Hex): Promise<QuoteResult> {
    try {
      const view = (await pub.readContract({ ...R, functionName: "asView", args: [] })) as Address; // router.asView()
      const [ain, aout] = (await pub.readContract({
        address: view, abi: dep.abi.router, functionName: "quote",
        args: [dep.order, amountIn, dataOverride ?? dataOf(p)], account: takerOf(p),
      })) as [bigint, bigint, Hex];
      return { ok: true, amountIn: ain, amountOut: aout };
    } catch (e) {
      return { ok: false, error: decodeError(e) };
    }
  }

  async function swap(p: Profile, amountIn: bigint, dataOverride?: Hex): Promise<SwapResult> {
    const q = await quote(p, amountIn, dataOverride);
    const hash = await wallet.writeContract({
      ...R, functionName: "swap", args: [dep.order, amountIn, dataOverride ?? dataOf(p)], account: takerOf(p), chain, gas: 3_000_000n,
    });
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") return { quote: q, hash, gasUsed: rc.gasUsed, reverted: true };
    const ev = parseEventLogs({ abi: dep.abi.router, logs: rc.logs, eventName: "Swapped" })[0] as any;
    return { quote: q, hash, gasUsed: rc.gasUsed, reverted: false, amountIn: ev.args.amountIn, amountOut: ev.args.amountOut };
  }

  /** Sandboxed A/B: single trade vs `parts` equal legs in the same window, then evm_revert. */
  async function splitAttack(total: bigint, parts = 5): Promise<SplitResult> {
    const snap = (await pub.request({ method: "evm_snapshot" as any, params: [] as any })) as Hex;
    try {
      const pre = await readState();
      const single = await quote("bot", total);
      const singleFee = feeModel(dep, pre, total, false);
      const legs: SplitLeg[] = [];
      for (let i = 0; i < parts; i++) {
        const leg = total / BigInt(parts);
        const st = await readState();
        const fee = feeModel(dep, st, leg, false);
        const s = await swap("bot", leg);
        legs.push({ amountIn: leg, amountOut: s.amountOut ?? 0n, fee, hash: s.hash, quoteOut: s.quote.ok ? s.quote.amountOut : 0n });
      }
      return { single, singleFee, legs };
    } finally {
      await pub.request({ method: "evm_revert" as any, params: [snap] as any });
    }
  }

  // ------------------------------------------------------------------ state
  async function readState(): Promise<ChainState> {
    const block = await pub.getBlock();
    const vault = (v: Address) => pub.readContract({ address: v, abi: dep.abi.vault, functionName: "balanceOf", args: [dep.accounts.maker] })
      .then((sh) => pub.readContract({ address: v, abi: dep.abi.vault, functionName: "convertToAssets", args: [sh] })) as Promise<bigint>;
    const aqua = (t: Address) => pub.readContract({
      address: dep.addr.aqua, abi: dep.abi.aqua, functionName: "rawBalances", args: [dep.accounts.maker, dep.addr.router, dep.orderHash, t],
    }).then((r: any) => r[0] as bigint);
    const [vUsdc, vWeth, aUsdc, aWeth, w] = await Promise.all([
      vault(dep.addr.usdcVault), vault(dep.addr.wethVault), aqua(dep.addr.usdc), aqua(dep.addr.weth),
      pub.readContract({ ...R, functionName: "surgeWindow", args: [dep.orderHash, dep.addr.usdc] }) as Promise<[bigint, bigint, bigint]>,
    ]);
    return {
      blockNumber: block.number, timestamp: block.timestamp,
      vault: { usdc: vUsdc, weth: vWeth }, aqua: { usdc: aUsdc, weth: aWeth },
      window: { start: w[0], flow: w[1], ref: w[2] },
      capOut: min(vWeth * BigInt(dep.cfg.lambdaBps) / 10_000n, aWeth),
    };
  }

  async function snapshot(): Promise<Hex> {
    return (await pub.request({ method: "evm_snapshot" as any, params: [] as any })) as Hex;
  }
  async function revert(id: Hex): Promise<boolean> {
    return (await pub.request({ method: "evm_revert" as any, params: [id] as any })) as boolean;
  }

  // ------------------------------------------------------------------ ZK
  const A = { address: dep.addr.adapter, abi: dep.abi.adapter } as const;
  async function currentNullifierSeed(): Promise<bigint> {
    return (await pub.readContract({ ...A, functionName: "currentNullifierSeed", args: [] })) as bigint;
  }
  async function currentEpoch(): Promise<bigint> {
    return (await pub.readContract({ ...A, functionName: "currentEpoch", args: [] })) as bigint;
  }
  /** Runs the adapter (and the real BN254 pairing) in an eth_call */
  async function verifyOnChain(taker: Address, r: ProverResult): Promise<{ ok: boolean; beneficiary: Address; validUntil: bigint }> {
    const ps = r.proof.publicSignals;
    const [ok, beneficiary, validUntil] = (await pub.readContract({
      ...A, functionName: "verifyProof",
      args: [taker, BigInt(ps.nullifier), [BigInt(ps.ageAbove18), BigInt(ps.gender), BigInt(ps.pincode), BigInt(ps.state)], proofEnvelope(r, await currentEpoch())],
    })) as [boolean, Address, bigint];
    return { ok, beneficiary, validUntil };
  }
  /** takerData for the human profile carrying a fresh real Aadhaar proof (type 2) for `epoch` */
  function realProofTakerData(r: ProverResult, epoch: bigint): Hex {
    return buildTakerData(dep, encodeZkPayload(r, epoch));
  }
  /** takerData for the human profile carrying a World ID payload (type 1) */
  function worldIdTakerData(payload: Hex): Hex {
    return buildTakerData(dep, payload);
  }

  // ------------------------------------------------------------------ World ID
  const W = () => {
    if (!dep.addr.worldIdAdapter || !dep.abi.worldIdAdapter) throw new Error("deployment has no World ID adapter — re-run scripts/seed-local.ts");
    return { address: dep.addr.worldIdAdapter, abi: dep.abi.worldIdAdapter } as const;
  };
  const WR = () => {
    if (!dep.addr.worldIdRouter || !dep.abi.worldIdRouter) throw new Error("deployment has no World ID router — re-run scripts/seed-local.ts");
    return { address: dep.addr.worldIdRouter, abi: dep.abi.worldIdRouter } as const;
  };
  /** WorldIDAdapter.verifyProof → IWorldID.verifyProof → SemaphoreVerifier, in an eth_call */
  async function verifyWorldIdOnChain(taker: Address, p: { root: bigint; nullifierHash: bigint; proof: bigint[] }): Promise<{ ok: boolean; beneficiary: Address; validUntil: bigint }> {
    const [ok, beneficiary, validUntil] = (await pub.readContract({
      ...W(), functionName: "verifyProof", args: [taker, p.nullifierHash, [0n, 0n, 0n, 0n], worldIdEnvelope(p.root, await worldIdCurrentEpoch(), p.proof)],
    })) as [boolean, Address, bigint];
    return { ok, beneficiary, validUntil };
  }
  /** Current action-rotation epoch of the World ID adapter (0 when rotation is off) */
  async function worldIdCurrentEpoch(): Promise<bigint> {
    return (await pub.readContract({ ...W(), functionName: "currentEpoch", args: [] })) as bigint;
  }
  async function worldIdLatestRoot(): Promise<bigint> {
    return (await pub.readContract({ ...WR(), functionName: "latestRoot", args: [] })) as bigint;
  }
  /** Mirrors the router's requireValidRoot: latest / historical (within the expiry window) / unknown or expired */
  async function worldIdRootStatus(root: bigint): Promise<"latest" | "historical" | "unknown-or-expired"> {
    if ((await worldIdLatestRoot()) === root) return "latest";
    try { await pub.readContract({ ...WR(), functionName: "requireValidRoot", args: [root] }); return "historical"; }
    catch { return "unknown-or-expired"; }
  }
  /** externalNullifierHash a proof made right now must commit to (rotates with the epoch if enabled) */
  async function worldIdExternalNullifier(): Promise<bigint> {
    return (await pub.readContract({ ...W(), functionName: "currentExternalNullifier", args: [] })) as bigint;
  }
  async function prove(digits: string, signal: Address): Promise<ProverResult> {
    const seed = await currentNullifierSeed();
    const res = await fetch(`${dep.zk.proverUrl}/prove`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ digits, seed: seed.toString(), signal }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ?? `prover HTTP ${res.status}`);
    return j;
  }
  async function testQr(): Promise<{ digits: string; png: string }> {
    const block = await pub.getBlock();
    const res = await fetch(`${dep.zk.proverUrl}/test-qr`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timestamp: Number(block.timestamp) }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ?? `prover HTTP ${res.status}`);
    return j;
  }
  async function proverHealth(): Promise<{ ok: boolean; artifacts: boolean } | null> {
    try { return await (await fetch(`${dep.zk.proverUrl}/health`)).json(); } catch { return null; }
  }

  return {
    pub, fetchLiveOrder, quote, swap, splitAttack, readState, snapshot, revert, takerOf,
    currentNullifierSeed, currentEpoch, verifyOnChain, realProofTakerData, prove, testQr, proverHealth,
    worldIdTakerData, verifyWorldIdOnChain, worldIdLatestRoot, worldIdRootStatus, worldIdExternalNullifier, worldIdCurrentEpoch,
  };
}

export type AegisClient = ReturnType<typeof createAegisClient>;

export type QuoteResult = { ok: true; amountIn: bigint; amountOut: bigint } | { ok: false; error: string };
export interface SwapResult { quote: QuoteResult; hash: Hex; gasUsed: bigint; reverted: boolean; amountIn?: bigint; amountOut?: bigint }
export interface SplitLeg { amountIn: bigint; amountOut: bigint; quoteOut: bigint; fee: FeeBreakdown; hash: Hex }
export interface SplitResult { single: QuoteResult; singleFee: FeeBreakdown; legs: SplitLeg[] }
export interface ChainState {
  blockNumber: bigint; timestamp: bigint;
  vault: { usdc: bigint; weth: bigint }; aqua: { usdc: bigint; weth: bigint };
  window: { start: bigint; flow: bigint; ref: bigint };
  capOut: bigint;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

function decodeError(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (r?.data?.errorName) return `${r.data.errorName}(${(r.data.args ?? []).map(String).join(", ")})`;
    return e.shortMessage;
  }
  return String(e);
}

// ------------------------------------------------------------------ 0x7A fee mirror (display)
export interface FeeBreakdown {
  total: bigint; base: bigint; surge: bigint; priorFlow: bigint; threshold: bigint; windowActive: boolean; expectedOut: bigint;
}

/** Mirrors VolatilitySurgeFee + JIT offsets + XYCSwap for USDC -> WETH exactIn (verified on-chain by the test suite). */
export function feeModel(dep: Deployment, st: ChainState, gross: bigint, human: boolean): FeeBreakdown {
  const c = dep.cfg;
  const boost = BigInt(c.virtualBoostBps) - 10_000n;
  const vIn = st.aqua.usdc + BigInt(c.usdcLiquidity) * boost / 10_000n;
  const vOut = st.aqua.weth + BigInt(c.wethLiquidity) * boost / 10_000n;
  const now = st.timestamp + 1n;
  // fixed-grid token bucket (mirrors VolatilitySurgeFee._bucket): constant inside a window, leaks one threshold per elapsed window
  let F = 0n, ref = vIn;
  if (c.decayWindowSec !== 0 && st.window.start !== 0n) {
    const k = (now - st.window.start) / BigInt(c.decayWindowSec);
    const leak = k * (st.window.ref * BigInt(c.impactThresholdBps) / 10_000n);
    if (st.window.flow > leak) { F = st.window.flow - leak; ref = st.window.ref; }
  }
  const active = F !== 0n;
  const T = ref * BigInt(c.impactThresholdBps) / 10_000n;
  const g0 = T > F ? T - F : 0n;
  const base = BigInt(c.baseFeeBps);
  const b = human ? base / 2n : base;
  const p = BigInt(c.maxSurgeFeeBps) - base;
  const excess = gross > g0 ? gross - g0 : 0n;
  const total = (gross * b + excess * p + FEE_BPS - 1n) / FEE_BPS;
  const baseFee = gross * b / FEE_BPS;
  const net = gross - total;
  return { total, base: baseFee, surge: total - baseFee, priorFlow: F, threshold: T, windowActive: active, expectedOut: net * vOut / (vIn + net) };
}

// ------------------------------------------------------------------ disassembler
export type FrameKind = "zk" | "jit" | "fee" | "stock";
export interface Frame { pc: number; opcode: number; name: string; kind: FrameKind; hex: Hex; fields: Array<[string, string]> }
export interface Section { name: string; hex: Hex }

const hexSlice = (b: Uint8Array, s: number, e: number): Hex => `0x${Array.from(b.slice(s, e), (x) => x.toString(16).padStart(2, "0")).join("")}`;
const uint = (b: Uint8Array, s: number, e: number) => BigInt(hexSlice(b, s, e));
const addr = (b: Uint8Array, s: number) => hexSlice(b, s, s + 20);
const bytes = (h: Hex) => Uint8Array.from((h.slice(2).match(/.{2}/g) ?? []).map((x) => parseInt(x, 16)));
const pctBps = (v: bigint, den: bigint) => `${(Number(v) * 100 / Number(den)).toLocaleString(undefined, { maximumFractionDigits: 4 })}%`;

export function splitOrder(order: Order): { sections: Section[]; program: Hex; programOffset: number } {
  const data = bytes(order.data);
  const traits = BigInt(order.traits);
  const programOffset = Number((traits >> 208n) & 0xffffn); // slice index3 (MakerTraits bit offset 160 + 48)
  return {
    sections: [
      { name: "tokenA ‖ tokenB", hex: hexSlice(data, 0, 40) },
      { name: "maker hook targets + data (JIT vault hook)", hex: hexSlice(data, 40, programOffset) },
    ],
    program: hexSlice(data, programOffset, data.length),
    programOffset,
  };
}

export function disassemble(program: Hex, cfgDecimals?: { tokenA: Address; usdc: Address }): Frame[] {
  const b = bytes(program);
  const frames: Frame[] = [];
  const usdcIsA = cfgDecimals ? cfgDecimals.tokenA.toLowerCase() === cfgDecimals.usdc.toLowerCase() : true;
  for (let pc = 0; pc < b.length;) {
    const op = b[pc], len = b[pc + 1], a = pc + 2;
    const f: Frame = { pc, opcode: op, name: `0x${op.toString(16)}`, kind: "stock", hex: hexSlice(b, pc, a + len), fields: [] };
    switch (op) {
      case 0x0d: f.name = "Deadline"; f.fields.push(["deadline", new Date(Number(uint(b, a, a + 5)) * 1000).toISOString()]); break;
      case 0x2a: {
        f.name = "ZKIdentityGuard"; f.kind = "zk";
        const types = b[a], mode = b[a + 1];
        const st = uint(b, a + 2, a + 6);
        const typeLabel = types === 1 ? "1 · World ID" : types === 2 ? "2 · ZK Aadhaar" : types === 3 ? "3 · World ID or ZK Aadhaar" : `${types} · invalid`;
        f.fields.push(
          ["verifierTypes", typeLabel],
          ["mode", mode === 0 ? "0 · strict gate" : "1 · tiered retail"],
          ["requiredStateCode", st === 0n ? "0 · any" : st.toString()],
          ["worldIdVerifier", types & 1 ? addr(b, a + 6) : "— (not accepted)"],
          ["aadhaarVerifier", types & 2 ? addr(b, a + 26) : "— (not accepted)"],
        );
        break;
      }
      case 0x9a: {
        f.name = "JITVaultReserves"; f.kind = "jit";
        const lambda = uint(b, a + 40, a + 44), boost = uint(b, a + 44, a + 50);
        const refA = uint(b, a + 50, a + 66), refB = uint(b, a + 66, a + 82);
        const expWin = uint(b, a + 82, a + 86);
        const offA = refA * (boost - 10_000n) / 10_000n, offB = refB * (boost - 10_000n) / 10_000n;
        const fmt = (v: bigint, isUsdc: boolean) => `${(Number(v) / 10 ** (isUsdc ? USDC_DEC : WETH_DEC)).toLocaleString()} ${isUsdc ? "USDC" : "WETH"}`;
        f.fields.push(
          ["vaultA", addr(b, a)], ["vaultB", addr(b, a + 20)],
          ["lambdaBps", `${lambda} (${pctBps(lambda, 10_000n)} max exposure per execution and per window)`],
          ["exposureWindowSec", expWin === 0n ? "0 (per-execution cap only)" : `${expWin} s budget window (token bucket, leaks one budget per window)`],
          ["virtualBoostBps", `${boost} (${Number(boost) / 10_000}x)`],
          ["virtual offset A", `+${fmt(offA, usdcIsA)} (constant)`],
          ["virtual offset B", `+${fmt(offB, !usdcIsA)} (constant)`],
        );
        break;
      }
      case 0x7a: {
        f.name = "VolatilitySurgeFee"; f.kind = "fee";
        const base = uint(b, a, a + 4), max = uint(b, a + 4, a + 8), thr = uint(b, a + 8, a + 16), win = uint(b, a + 16, a + 20);
        f.fields.push(
          ["baseFee", `${base} (${pctBps(base, FEE_BPS)}; human ${pctBps(base / 2n, FEE_BPS)})`],
          ["maxSurgeFee", `${max} (${pctBps(max, FEE_BPS)} marginal)`],
          ["impactThreshold", `${thr} bps (${pctBps(thr, 10_000n)} of balanceIn)`],
          ["decayWindowSec", `${win} s flow window (token bucket: leaks one threshold per window)`],
        );
        break;
      }
      case 0x0b: f.name = "JumpIfTokenIn"; f.fields.push(["token", addr(b, a)], ["→ pc", uint(b, a + 20, a + 22).toString()]); break;
      case 0x0a: f.name = "Jump"; f.fields.push(["→ pc", uint(b, a, a + 2).toString()]); break;
      case 0x2b: f.name = "RequireMinRate"; f.fields.push(["rateLt", uint(b, a, a + 8).toString()], ["rateGt", uint(b, a + 8, a + 16).toString()]); break;
      case 0x11: f.name = "XYCSwap"; break;
      case 0x14: f.name = "Salt"; f.fields.push(["salt", uint(b, a, a + len).toString()]); break;
    }
    frames.push(f);
    pc = a + len;
  }
  return frames;
}

export const fmtUnits = (v: bigint, dec: number, dp = 4) =>
  (Number(v) / 10 ** dec).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
