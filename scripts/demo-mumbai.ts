// SPDX-License-Identifier: MIT
// AegisJIT — ETHGlobal Mumbai 2026 judge demo
//   npx hardhat run scripts/demo-mumbai.ts                      (in-process network)
//   npx hardhat node  &&  npx hardhat run --network localhost scripts/demo-mumbai.ts
//
// Deploys Aqua, WETHMock, USDC, 2x MockERC4626Vault (1,000,000 USDC + 400 WETH), the ZK Aadhaar and
// World ID verifier stacks and AegisSwapVMRouter, ships the Maker's self-custodial AegisJIT strategy
// to Aqua and runs the live on-chain scenarios (1A ZK Aadhaar human, 1B World ID human, 2 bot,
// 3 whale, 4 split attack).

import { existsSync } from "fs";
import * as path from "path";
import {
  deployAegis, USDC, AegisEnv, generateRealProof, encodeRealProofTakerArgs, MAHARASHTRA_PACKED, RealProof,
  generateWorldIdProof, encodeWorldIdProofTakerArgs, worldIdArtifactsAvailable, WorldIdProof, WORLD_ID_MEMBERS,
} from "../test/utils/aegisFixture";
import { AegisOpcodes, AegisProgramBuilder, FEE_BPS } from "../src/aegisProgramBuilder";

const { ethers } = require("hardhat");

// ---------- terminal formatting ----------
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m",
};
const fmtUsdc = (v: bigint, dp = 2) => Number(ethers.formatUnits(v, 6)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const fmtWeth = (v: bigint, dp = 4) => Number(ethers.formatUnits(v, 18)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-8)}`;
const pct = (num: bigint, den: bigint, dp = 2) => (Number((num * 10n ** 8n) / den) / 1e6).toFixed(dp) + "%";
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function table(title: string, rows: Array<[string, string]>) {
  const w0 = Math.max(...rows.map((r) => visible(r[0]).length));
  const w1 = Math.max(...rows.map((r) => visible(r[1]).length), visible(title).length - w0 - 3);
  const line = (l: string, m: string, r: string) => `${l}${"─".repeat(w0 + 2)}${m}${"─".repeat(w1 + 2)}${r}`;
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visible(s).length));
  console.log(line("┌", "─", "┐"));
  console.log(`│ ${pad(C.bold + title + C.reset, w0 + w1 + 3)} │`);
  console.log(line("├", "┬", "┤"));
  for (const [k, v] of rows) console.log(`│ ${pad(C.dim + k + C.reset, w0)} │ ${pad(v, w1)} │`);
  console.log(line("└", "┴", "┘"));
}

function grid(headers: string[], rows: string[][]) {
  const w = headers.map((h, i) => Math.max(visible(h).length, ...rows.map((r) => visible(r[i]).length)));
  const pad = (s: string, n: number, right = false) => right ? " ".repeat(n - visible(s).length) + s : s + " ".repeat(n - visible(s).length);
  const sep = (l: string, m: string, r: string) => l + w.map((n) => "─".repeat(n + 2)).join(m) + r;
  console.log(sep("┌", "┬", "┐"));
  console.log("│" + headers.map((h, i) => ` ${C.bold}${pad(h, w[i])}${C.reset} `).join("│") + "│");
  console.log(sep("├", "┼", "┤"));
  for (const r of rows) console.log("│" + r.map((c, i) => ` ${pad(c, w[i], i > 0)} `).join("│") + "│");
  console.log(sep("└", "┴", "┘"));
}

const banner = (s: string) => console.log(`\n${C.bold}${C.cyan}━━ ${s} ${"━".repeat(Math.max(0, 86 - s.length))}${C.reset}`);

// ---------- fee breakdown (display only: replicates 0x7A to explain what the contract charged;
//            test/AegisJIT.test.ts proves this model == on-chain result) ----------
async function surgeFeeBreakdown(env: AegisEnv, gross: bigint, human: boolean) {
  const { cfg } = env;
  const [start, flow, ref] = await env.contracts.router.surgeWindow(env.orderHash, env.addr.usdc);
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp) + 1n;
  const active = start !== 0n && now < start + BigInt(cfg.decayWindowSec);
  const aq = await env.aquaBalances();
  const virtualIn = aq.usdc + cfg.usdcLiquidity * BigInt(cfg.virtualBoostBps - 10_000) / 10_000n;
  const refB = active ? ref : virtualIn;
  const F = active ? flow : 0n;
  const T = refB * cfg.impactThresholdBps / 10_000n;
  const g0 = T > F ? T - F : 0n;
  const base = BigInt(cfg.baseFeeBps);
  const b = human ? base / 2n : base;
  const p = BigInt(cfg.maxSurgeFeeBps) - base;
  const excess = gross > g0 ? gross - g0 : 0n;
  const baseFee = (gross * b) / FEE_BPS;
  const total = (gross * b + excess * p + FEE_BPS - 1n) / FEE_BPS;
  const net = gross - total;
  const virtualOut = aq.weth + cfg.wethLiquidity * BigInt(cfg.virtualBoostBps - 10_000) / 10_000n;
  const expectedOut = net * virtualOut / (virtualIn + net);
  return { total, baseFee, surgeFee: total - baseFee, excess, priorFlow: F, expectedOut };
}


// ---------- on-chain token transfer trace ----------
const ERC20_EVENTS = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
]);

async function transferTrace(env: AegisEnv, receipt: any, title: string) {
  const name: Record<string, string> = {};
  const tag = (a: string, n: string) => { name[a.toLowerCase()] = n; };
  tag(env.addr.maker, "Maker"); tag(env.addr.router, "Router"); tag(env.addr.aqua, "Aqua"); tag(env.addr.hook, "JITHook");
  tag(env.addr.usdcVault, "avUSDC"); tag(env.addr.wethVault, "avWETH"); tag(ethers.ZeroAddress, "0x0 (mint/burn)");
  tag(await env.accounts.human.getAddress(), "Human"); tag(await env.accounts.bot.getAddress(), "Bot");
  tag(await env.accounts.whale.getAddress(), "Whale"); tag(await env.accounts.worldHuman.getAddress(), "World ID human");
  const token: Record<string, [string, (v: bigint) => string]> = {
    [env.addr.usdc.toLowerCase()]: ["USDC", (v) => fmtUsdc(v)],
    [env.addr.weth.toLowerCase()]: ["WETH", (v) => fmtWeth(v, 6)],
    [env.addr.usdcVault.toLowerCase()]: ["avUSDC share", (v) => fmtUsdc(v)],
    [env.addr.wethVault.toLowerCase()]: ["avWETH share", (v) => fmtWeth(v, 6)],
  };
  const lbl = (a: string) => name[a.toLowerCase()] ?? short(a);
  const rows: string[][] = [];
  for (const log of receipt.logs) {
    let ev; try { ev = ERC20_EVENTS.parseLog(log); } catch { continue; }
    if (!ev || ev.name !== "Transfer") continue;
    const t = token[log.address.toLowerCase()];
    if (!t) continue;
    rows.push([String(log.index), t[0], lbl(ev.args.from), lbl(ev.args.to), t[1](ev.args.value)]);
  }
  console.log(`${C.dim}${title} — ${rows.length} ERC-20 Transfer events in tx ${short(receipt.hash)}${C.reset}`);
  grid(["log#", "Token", "From", "To", "Amount"], rows);
}

/** Gas consumed by the first STATICCALL to `target` in a tx, measured from the opcode trace */
async function measureStaticCall(txHash: string, target: bigint): Promise<bigint | null> {
  const t = await ethers.provider.send("debug_traceTransaction", [txHash, { disableMemory: true, disableStorage: true }]);
  const logs = t.structLogs as Array<{ op: string; gas: number; depth: number; stack: string[] }>;
  for (let i = 0; i < logs.length - 1; i++) {
    const l = logs[i];
    if (l.op === "STATICCALL" && BigInt("0x" + l.stack[l.stack.length - 2].replace(/^0x/, "")) === target) {
      const next = logs.slice(i + 1).find((x) => x.depth === l.depth);
      return next ? BigInt(l.gas - next.gas) : null;
    }
  }
  return null;
}
const n = (v: bigint | null) => (v === null ? "n/a" : Number(v).toLocaleString("en-US"));

async function rpc(method: string, params: unknown[] = []) {
  return ethers.provider.send(method, params);
}

async function main() {
  console.log(`\n${C.bold}${C.magenta}   ▄▀█ █▀▀ █▀▀ █ █▀   ░░█ █ ▀█▀    AegisJIT · Custom-Opcode AMM & Self-Custodial JIT Vault${C.reset}`);
  console.log(`${C.bold}${C.magenta}   █▀█ ██▄ █▄█ █ ▄█   █▄█ █ ░█░    1inch Aqua + SwapVM · ETHGlobal Mumbai 2026${C.reset}`);

  banner("0 · Deploy & register the Maker's self-custodial strategy");
  const REAL_ZK = existsSync(path.join(__dirname, "..", ".cache", "anon-aadhaar", "v2.0.0", "circuit_final.zkey"));
  if (!REAL_ZK) {
    console.log(`${C.yellow}${C.bold}⚠ Anon Aadhaar artifacts not found — Scenario 1 falls back to the MOCK Groth16 verifier.${C.reset}`);
    console.log(`${C.yellow}  For real BN254 proofs run: node packages/zk-aadhaar/prover/fetch-artifacts.mjs (~620 MB)${C.reset}`);
  }
  const REAL_WORLD_ID = worldIdArtifactsAvailable();
  if (!REAL_WORLD_ID) {
    console.log(`${C.yellow}${C.bold}⚠ Semaphore depth-30 artifacts not found — Scenario 1B falls back to the MOCK Semaphore verifier.${C.reset}`);
    console.log(`${C.yellow}  For real World ID-style proofs run: node packages/world-id/prover/fetch-artifacts.mjs (~5.7 MB)${C.reset}`);
  }
  const env = await deployAegis({
    ...(REAL_ZK
      ? { zkBackend: "groth16" as const, epochDuration: 24 * 3600, adapterRequiredState: MAHARASHTRA_PACKED }
      : { zkBackend: "anonAadhaar" as const }),
    worldIdBackend: REAL_WORLD_ID ? "semaphore" : "mock",
  });
  const { human, bot, whale, worldHuman } = env.accounts;
  const { router } = env.contracts;

  table("Deployments (local Hardhat network)", [
    ["Aqua", env.addr.aqua],
    ["AegisSwapVMRouter", env.addr.router],
    ["AegisJITVaultHook", env.addr.hook],
    ["AnonAadhaarAdapter (0x2A type 2 verifier)", env.addr.adapter],
    ...(REAL_ZK
      ? [["AnonAadhaarGroth16Verifier", env.addr.groth16], ["Verifier.sol (BN254, ecPairing)", env.addr.pairingVerifier]] as [string, string][]
      : [["MockGroth16AnonAadhaar (fallback)", env.addr.anonAadhaar]] as [string, string][]),
    ["WorldIDAdapter (0x2A type 1 verifier)", env.addr.worldIdAdapter],
    ["MockWorldIDRouter (World ID Router + Identity Manager)", env.addr.worldIdRouter],
    ...(REAL_WORLD_ID
      ? [["SemaphoreVerifier (World ID's, vendored · ecPairing)", env.addr.semaphoreReal]] as [string, string][]
      : [["MockSemaphoreVerifier (fallback)", env.addr.semaphoreMock]] as [string, string][]),
    ["USDC (6 dp)", env.addr.usdc],
    ["WETHMock", env.addr.weth],
    ["avUSDC  MockERC4626Vault", env.addr.usdcVault],
    ["avWETH  MockERC4626Vault", env.addr.wethVault],
  ]);

  // Decode the program for display
  const program = ethers.getBytes(AegisProgramBuilder.buildProgram(env.params));
  const names: Record<number, string> = Object.fromEntries(Object.entries(AegisOpcodes).map(([k, v]) => [v as number, k]));
  const ops: string[] = [];
  for (let pc = 0; pc < program.length;) { ops.push(`0x${program[pc].toString(16).padStart(2, "0")} ${names[program[pc]]}`); pc += 2 + program[pc + 1]; }

  const v0 = await env.vaultAssets();
  table("Strategy registered via Aqua.ship()", [
    ["ship tx", short(env.shipReceipt!.hash) + `  (gas ${env.shipReceipt!.gasUsed})`],
    ["orderHash", short(env.orderHash)],
    ["Maker vault position", `${fmtUsdc(v0.usdc, 0)} USDC  +  ${fmtWeth(v0.weth, 0)} WETH  (shares in Maker wallet)`],
    ["Aqua virtual allocation", `${fmtUsdc(env.cfg.usdcLiquidity, 0)} USDC  +  ${fmtWeth(env.cfg.wethLiquidity, 0)} WETH  (no tokens moved)`],
    ["0x2A verifiers (types = 3)", `type 1 World ID → WorldIDAdapter  ·  type 2 ZK Aadhaar → AnonAadhaarAdapter  ·  tiered mode`],
    ["λ exposure cap / boost", `${env.cfg.lambdaBps / 100}% per execution  /  ${env.cfg.virtualBoostBps / 10_000}x virtual depth`],
    ["fees (1e9 = 100%)", `base ${env.cfg.baseFeeBps / 1e7}%  ·  surge marginal ${env.cfg.maxSurgeFeeBps / 1e7}% above ${Number(env.cfg.impactThresholdBps) / 100}% util`],
    ["program", `${program.length} bytes · ${ops.length} instructions`],
    ...ops.map((o, i) => [`  [${i}]`, o] as [string, string]),
  ]);

  type Row = { name: string; tier: string; inStr: string; outStr: string; price: string; fee: string; gas: string; hash: string; status: string };
  const results: Row[] = [];
  let fee1A = 0n, fee1B = 0n, fee2 = 0n;

  // ---------------- Scenario 1A ----------------
  banner("1A · Verified human via ZK Aadhaar: 5,000 USDC -> WETH");
  {
    const amount = USDC(5_000);
    const hAddr = await human.getAddress();
    let real: RealProof | null = null;
    let zk: string;
    if (REAL_ZK) {
      process.stdout.write(`${C.dim}  scanning signed test Aadhaar QR → RSA-2048 → Groth16 proving…${C.reset}`);
      const ts = (await ethers.provider.getBlock("latest"))!.timestamp;
      real = generateRealProof({ timestamp: ts, seed: await env.contracts.adapter.currentNullifierSeed(), signal: hAddr });
      zk = encodeRealProofTakerArgs(real);
      process.stdout.write(` done (${real.proof.provingMs} ms)\n`);
    } else {
      zk = await env.zkArgs(hAddr);
    }
    const data = env.takerData({ tokenIn: env.addr.usdc, zk });
    const botData = env.takerData({ tokenIn: env.addr.usdc });
    const botQuote = await env.quote(bot, amount, botData);
    // gasUsed of the identical swap WITHOUT a proof, measured in a snapshot sandbox
    const snap = await rpc("evm_snapshot");
    const botGas = (await env.swap(bot, amount, botData)).receipt.gasUsed;
    await rpc("evm_revert", [snap]);
    const q = await env.quote(human, amount, data);
    const fee = await surgeFeeBreakdown(env, amount, true);
    const before = await env.vaultAssets();
    const s = await env.swap(human, amount, data);
    const after = await env.vaultAssets();

    if (real) {
      const ps = real.proof.publicSignals;
      const pairing = await measureStaticCall(s.receipt.hash, 8n);
      const adapterGas = await measureStaticCall(s.receipt.hash, BigInt(env.addr.adapter));
      table("Real ZK pipeline (zkAadhaar → Anon Aadhaar v2 circuit → BN254 on-chain)", [
        ["1 · Secure QR", `${real.qr.version} layout · decompressed · RSA-2048 ${real.qr.rsa.status === "untrusted-key" ? "valid (AegisJIT TEST signer, not UIDAI)" : real.qr.rsa.status}`],
        ["2 · Groth16 proof", `${real.proof.provingMs.toLocaleString()} ms (snarkjs, Node) · 8 × uint256`],
        ["    public signals", `ageAbove18=${ps.ageAbove18} · state=${real.proof.stateText} · gender/pincode hidden · epoch nullifier ${short("0x" + BigInt(ps.nullifier).toString(16))}`],
        ["    signal", `keccak(${short(hAddr)}) >> 3 — bound to this taker`],
        ["3 · on-chain verify", `0x2A → AnonAadhaarAdapter → AnonAadhaarGroth16Verifier → Verifier.sol → ecPairing 0x08`],
        ["gas · ecPairing (0x08)", `${n(pairing)}  (measured; EIP-1108 45,000 + 4×34,000 = 181,000, +100 warm access)`],
        ["gas · 0x2A verifier call", `${n(adapterGas)}  (adapter + Groth16: ecMul/ecAdd for 9 public inputs + pairing)`],
        ["gas · swap with proof", `${n(s.receipt.gasUsed)}  vs  ${n(botGas)} same swap without proof  →  ZK overhead ${n(s.receipt.gasUsed - botGas)}`],
      ]);
    }
    fee1A = fee.total;
    table("0x2A ZK Aadhaar pass (type 2) → 0x7A human tier (50% base-fee discount) → settled via Aqua", [
      ["proof", real ? `REAL Groth16 (BN254) · signal = ${short(hAddr)}` : `Anon Aadhaar Groth16 (MOCK verifier fallback) · signal = ${short(hAddr)}`],
      ["quote()  (static)", `${fmtWeth(q.amountOut, 6)} WETH`],
      ["swap()   (executed)", `${fmtWeth(s.amountOut, 6)} WETH  ${s.amountOut === q.amountOut ? C.green + "== quote ✔ (0 wei)" + C.reset : C.red + "!= quote" + C.reset}`],
      ["same trade as unverified bot", `${fmtWeth(botQuote.amountOut, 6)} WETH  (human gets +${fmtWeth(q.amountOut - botQuote.amountOut, 6)} WETH)`],
      ["fee charged", `${fmtUsdc(fee.total)} USDC  (${pct(fee.total, amount, 3)})  ${fee.expectedOut === s.amountOut ? C.green + "off-chain model == on-chain ✔" + C.reset : C.red + "model mismatch" + C.reset}`],
      ["tx / gas", `${short(s.receipt.hash)}  /  ${s.receipt.gasUsed}`],
      ["avUSDC (Maker)", `${fmtUsdc(before.usdc)}  →  ${fmtUsdc(after.usdc)}   (+${fmtUsdc(after.usdc - before.usdc)} re-deposited JIT)`],
      ["avWETH (Maker)", `${fmtWeth(before.weth)}  →  ${fmtWeth(after.weth)}   (−${fmtWeth(before.weth - after.weth)} withdrawn JIT)`],
    ]);
    await transferTrace(env, s.receipt, "Scenario 1A settlement: JIT withdraw → Aqua pull → taker push → JIT re-deposit");
    results.push({ name: "1A Human · ZK Aadhaar", tier: C.green + (real ? "Groth16 ✔" : "ZK (mock)") + C.reset, inStr: `${fmtUsdc(amount, 0)} USDC`, outStr: `${fmtWeth(s.amountOut)} WETH`,
      price: fmtUsdc(amount * 10n ** 18n / s.amountOut), fee: pct(fee.total, amount, 3), gas: s.receipt.gasUsed.toString(), hash: short(s.receipt.hash), status: C.green + "filled" + C.reset });
  }

  // ---------------- Scenario 1B ----------------
  banner("1B · Verified human via World ID: 5,000 USDC -> WETH");
  {
    const amount = USDC(5_000);
    const wAddr = await worldHuman.getAddress();
    const { worldIdAdapter, worldIdRouter } = env.contracts;
    const ext: bigint = await worldIdAdapter.EXTERNAL_NULLIFIER();
    const hex = (d: string) => "0x" + BigInt(d).toString(16);
    let real: WorldIdProof | null = null;
    let zk: string;
    if (REAL_WORLD_ID) {
      process.stdout.write(`${C.dim}  Semaphore v3 identity → depth-30 merkle path → Groth16 proving…${C.reset}`);
      real = generateWorldIdProof({ identity: "human", signal: wAddr, externalNullifier: ext });
      if ((await worldIdRouter.latestRoot()) !== BigInt(real.root)) {
        await (await worldIdRouter.connect(env.accounts.deployer).registerRoot(BigInt(real.root))).wait(); // sequencer publishes the tree root
      }
      zk = encodeWorldIdProofTakerArgs(real);
      process.stdout.write(` done (${real.provingMs} ms)\n`);
    } else {
      zk = await env.worldIdArgs(wAddr);
    }
    const data = env.takerData({ tokenIn: env.addr.usdc, zk });
    const botData = env.takerData({ tokenIn: env.addr.usdc });
    const botQuote = await env.quote(bot, amount, botData);
    const snap = await rpc("evm_snapshot");
    const botGas = (await env.swap(bot, amount, botData)).receipt.gasUsed;
    await rpc("evm_revert", [snap]);
    const q = await env.quote(worldHuman, amount, data);
    const fee = await surgeFeeBreakdown(env, amount, true);
    const before = await env.vaultAssets();
    const s = await env.swap(worldHuman, amount, data);
    const after = await env.vaultAssets();
    fee1B = fee.total;

    const adapterGas = await measureStaticCall(s.receipt.hash, BigInt(env.addr.worldIdAdapter));
    if (real) {
      const pairing = await measureStaticCall(s.receipt.hash, 8n);
      table("World ID pipeline (Semaphore v3 identity → depth-30 tree → BN254 on-chain)", [
        ["1 · identity", `Semaphore v3 identity "human" · commitment ${short(hex(real.identityCommitment))} · leaf #${real.memberIndex} of the local tree (${WORLD_ID_MEMBERS.length} members, depth 30)`],
        ["2 · Groth16 proof", `${real.provingMs.toLocaleString()} ms (snarkjs, public PSE depth-30 artifacts) · 8 × uint256`],
        ["    public signals", `root ${short(hex(real.root))} · nullifierHash ${short(hex(real.nullifierHash))} · signalHash = hashToField(${short(wAddr)}) · externalNullifier = hashToField(appId ‖ action)`],
        ["3 · on-chain verify", `0x2A → WorldIDAdapter → IWorldID.verifyProof(root, group 1, …) → MockWorldIDRouter (root history) → SemaphoreVerifier (World ID's own) → ecPairing 0x08`],
        ["gas · ecPairing (0x08)", `${n(pairing)}  (measured; EIP-1108 45,000 + 4×34,000 = 181,000, +100 warm access)`],
        ["gas · 0x2A verifier call", `${n(adapterGas)}  (adapter + router + Groth16: MSM over 4 public inputs + pairing)`],
        ["gas · swap with proof", `${n(s.receipt.gasUsed)}  vs  ${n(botGas)} same swap without proof  →  World ID overhead ${n(s.receipt.gasUsed - botGas)}`],
      ]);
    }
    table("0x2A World ID pass (type 1) → 0x7A human tier (50% base-fee discount) → settled via Aqua", [
      ["proof", real ? `REAL Semaphore Groth16 (BN254) · signal = ${short(wAddr)}` : `World ID Semaphore proof (MOCK verifier fallback) · signal = ${short(wAddr)}`],
      ["quote()  (static)", `${fmtWeth(q.amountOut, 6)} WETH`],
      ["swap()   (executed)", `${fmtWeth(s.amountOut, 6)} WETH  ${s.amountOut === q.amountOut ? C.green + "== quote ✔ (0 wei)" + C.reset : C.red + "!= quote" + C.reset}`],
      ["same trade as unverified bot", `${fmtWeth(botQuote.amountOut, 6)} WETH  (human gets +${fmtWeth(q.amountOut - botQuote.amountOut, 6)} WETH)`],
      ["fee charged", `${fmtUsdc(fee.total)} USDC  (${pct(fee.total, amount, 3)})  ${fee.expectedOut === s.amountOut ? C.green + "off-chain model == on-chain ✔" + C.reset : C.red + "model mismatch" + C.reset}  ·  ${fee1A === fee1B ? C.green + "same tier as 1A ✔" + C.reset : C.red + "tier differs from 1A" + C.reset}`],
      ["nullifier binding", `nullifierHash → ${short(wAddr)} (one discounted address per World ID)`],
      ["tx / gas", `${short(s.receipt.hash)}  /  ${s.receipt.gasUsed}${real ? "" : `  (0x2A verifier call ${n(adapterGas)} gas)`}`],
      ["avUSDC (Maker)", `${fmtUsdc(before.usdc)}  →  ${fmtUsdc(after.usdc)}   (+${fmtUsdc(after.usdc - before.usdc)} re-deposited JIT)`],
      ["avWETH (Maker)", `${fmtWeth(before.weth)}  →  ${fmtWeth(after.weth)}   (−${fmtWeth(before.weth - after.weth)} withdrawn JIT)`],
    ]);
    await transferTrace(env, s.receipt, "Scenario 1B settlement");
    results.push({ name: "1B Human · World ID", tier: C.green + (real ? "Semaphore ✔" : "World ID (mock)") + C.reset, inStr: `${fmtUsdc(amount, 0)} USDC`, outStr: `${fmtWeth(s.amountOut)} WETH`,
      price: fmtUsdc(amount * 10n ** 18n / s.amountOut), fee: pct(fee.total, amount, 3), gas: s.receipt.gasUsed.toString(), hash: short(s.receipt.hash), status: C.green + "filled" + C.reset });
  }

  // ---------------- Scenario 2 ----------------
  banner("2 · Unverified arbitrage bot: 50,000 USDC -> WETH");
  {
    const amount = USDC(50_000);
    const data = env.takerData({ tokenIn: env.addr.usdc });
    const fee = await surgeFeeBreakdown(env, amount, false);
    const q = await env.quote(bot, amount, data);
    const before = await env.vaultAssets();
    const s = await env.swap(bot, amount, data);
    const after = await env.vaultAssets();
    fee2 = fee.total;
    table("0x2A no proof (tiered: treated as bot) → 0x7A volatility surge fee", [
      ["quote()  (static)", `${fmtWeth(q.amountOut, 6)} WETH`],
      ["swap()   (executed)", `${fmtWeth(s.amountOut, 6)} WETH  ${s.amountOut === q.amountOut ? C.green + "== quote ✔" + C.reset : C.red + "!= quote" + C.reset}`],
      ["in-window flow before trade", `${fmtUsdc(fee.priorFlow)} USDC  (split trades can't dodge the surge)`],
      ["flow above 1% threshold", `${fmtUsdc(fee.excess)} USDC`],
      ["base fee", `${fmtUsdc(fee.baseFee)} USDC`],
      ["surge fee (LVR captured)", `${C.yellow}${fmtUsdc(fee.surgeFee)} USDC${C.reset}`],
      ["total fee", `${fmtUsdc(fee.total)} USDC  (${pct(fee.total, amount, 3)} effective)  ${fee.expectedOut === s.amountOut ? C.green + "off-chain model == on-chain ✔" + C.reset : C.red + "model mismatch" + C.reset}`],
      ["tx / gas", `${short(s.receipt.hash)}  /  ${s.receipt.gasUsed}`],
      ["avUSDC (Maker)", `${fmtUsdc(before.usdc)}  →  ${fmtUsdc(after.usdc)}`],
      ["avWETH (Maker)", `${fmtWeth(before.weth)}  →  ${fmtWeth(after.weth)}`],
    ]);
    await transferTrace(env, s.receipt, "Scenario 2 settlement");
    results.push({ name: "2 Arb bot", tier: C.yellow + "unverified" + C.reset, inStr: `${fmtUsdc(amount, 0)} USDC`, outStr: `${fmtWeth(s.amountOut)} WETH`,
      price: fmtUsdc(amount * 10n ** 18n / s.amountOut), fee: pct(fee.total, amount, 3), gas: s.receipt.gasUsed.toString(), hash: short(s.receipt.hash), status: C.green + "filled" + C.reset });
  }

  // ---------------- Scenario 3 ----------------
  banner("3 · Toxic whale: 500,000 USDC -> WETH (attempted drain)");
  {
    const amount = USDC(500_000);
    const data = env.takerData({ tokenIn: env.addr.usdc });
    const before = await env.vaultAssets();
    const cap = before.weth * BigInt(env.cfg.lambdaBps) / 10_000n;
    let hash = "—", gas = "—", decoded = "";
    try {
      await router.connect(whale).swap(env.order, amount, data, { gasLimit: 2_000_000 });
      decoded = C.red + "UNEXPECTED: swap succeeded" + C.reset;
    } catch (e: any) {
      // Error shapes differ between the in-process network and a JSON-RPC node: search for them
      const find = (x: any, keys: string[], ok: (v: any) => boolean, depth = 0): any => {
        if (x == null || depth > 6) return undefined;
        if (ok(x)) return x;
        if (typeof x !== "object") return undefined;
        for (const k of keys) { const r = find(x[k], keys, ok, depth + 1); if (r !== undefined) return r; }
        return undefined;
      };
      const raw = find(e, ["data", "error", "info", "revert"], (v) => typeof v === "string" && /^0x[0-9a-fA-F]{8}/.test(v));
      const err = raw ? router.interface.parseError(raw) : null;
      decoded = err ? `${err.name}(${err.args.map((a: bigint) => fmtWeth(a, 4) + " WETH").join(", ")})` : (e.shortMessage ?? String(e));
      let txh: string | undefined = find(e, ["data", "error", "info", "txHash", "transactionHash"], (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v));
      if (!txh) {
        const block = await ethers.provider.getBlock("latest", true);
        txh = block?.prefetchedTransactions?.find((t: any) => t.to?.toLowerCase() === env.addr.router.toLowerCase())?.hash;
      }
      if (txh) {
        const rc = await ethers.provider.getTransactionReceipt(txh);
        if (rc && rc.status === 0) { hash = short(txh); gas = rc.gasUsed.toString(); }
      }
    }
    const after = await env.vaultAssets();
    table("0x9A JIT cap: λ = 25% of the LIVE vault per execution", [
      ["whale wants", `${fmtUsdc(amount, 0)} USDC in  →  curve would pay out > ${fmtWeth(cap, 2)} WETH`],
      ["result", `${C.red}${C.bold}REVERTED${C.reset}  ${decoded}`],
      ["tx / gas", `${hash}  /  ${gas}`],
      ["max single-execution exposure", `${fmtWeth(cap, 4)} WETH = ${env.cfg.lambdaBps / 100}% of ${fmtWeth(before.weth, 4)} WETH`],
      ["avWETH (Maker)", `${fmtWeth(before.weth)}  →  ${fmtWeth(after.weth)}   ${C.green}untouched ✔${C.reset}`],
      ["structurally out of reach", `${fmtWeth(before.weth - cap, 4)} WETH (${100 - env.cfg.lambdaBps / 100}%) keeps earning vault yield`],
    ]);
    results.push({ name: "3 Toxic whale", tier: C.yellow + "unverified" + C.reset, inStr: `${fmtUsdc(amount, 0)} USDC`, outStr: "0 WETH",
      price: "—", fee: "—", gas, hash, status: C.red + "blocked 0x9A" + C.reset });
  }


  // ---------------- Scenario 4 ----------------
  banner("4 · Split-attack defeat: 1 x 50,000 vs 5 x 10,000 USDC in one rolling window");
  {
    await rpc("evm_increaseTime", [env.cfg.decayWindowSec + 1]); // start from a fresh 0x7A window
    await rpc("evm_mine");
    const data = env.takerData({ tokenIn: env.addr.usdc });
    const snap = await rpc("evm_snapshot");

    const singleFee = await surgeFeeBreakdown(env, USDC(50_000), false);
    const single = await env.swap(bot, USDC(50_000), data);
    await rpc("evm_revert", [snap]);

    const legs: Array<{ fee: Awaited<ReturnType<typeof surgeFeeBreakdown>>; out: bigint; hash: string; gas: bigint; naiveFee: bigint }> = [];
    for (let i = 0; i < 5; i++) {
      const fee = await surgeFeeBreakdown(env, USDC(10_000), false);
      // counterfactual: what a stateless per-trade fee (fresh window every trade) would charge
      const aq = await env.aquaBalances();
      const virtualIn = aq.usdc + env.cfg.usdcLiquidity * BigInt(env.cfg.virtualBoostBps - 10_000) / 10_000n;
      const t = virtualIn * env.cfg.impactThresholdBps / 10_000n;
      const g = USDC(10_000);
      const naiveFee = (g * BigInt(env.cfg.baseFeeBps) + (g > t ? g - t : 0n) * BigInt(env.cfg.maxSurgeFeeBps - env.cfg.baseFeeBps) + FEE_BPS - 1n) / FEE_BPS;
      const s = await env.swap(bot, g, data);
      if (s.amountOut !== fee.expectedOut) throw new Error(`leg ${i + 1}: model mismatch`);
      legs.push({ fee, out: s.amountOut, hash: short(s.receipt.hash), gas: s.receipt.gasUsed, naiveFee });
    }
    const splitFee = legs.reduce((a, l) => a + l.fee.total, 0n);
    const splitSurge = legs.reduce((a, l) => a + l.fee.surgeFee, 0n);
    const splitOut = legs.reduce((a, l) => a + l.out, 0n);
    const naiveTotal = legs.reduce((a, l) => a + l.naiveFee, 0n);

    grid(["Trade", "Window flow before", "Base fee", "Surge fee", "Total fee", "WETH out", "Tx"], [
      ["1 x 50,000", fmtUsdc(singleFee.priorFlow), fmtUsdc(singleFee.baseFee), fmtUsdc(singleFee.surgeFee), fmtUsdc(singleFee.total), fmtWeth(single.amountOut, 6), short(single.receipt.hash) + C.dim + " (reverted to snapshot)" + C.reset],
      ...legs.map((l, i) => [`leg ${i + 1}/5 x 10,000`, fmtUsdc(l.fee.priorFlow), fmtUsdc(l.fee.baseFee), fmtUsdc(l.fee.surgeFee), fmtUsdc(l.fee.total), fmtWeth(l.out, 6), l.hash]),
      [C.bold + "5-part split total" + C.reset, "", "", fmtUsdc(splitSurge), fmtUsdc(splitFee), fmtWeth(splitOut, 6), ""],
    ]);
    const feeOk = splitFee >= singleFee.total;
    const outOk = splitOut <= single.amountOut;
    table("0x7A rolling-window accumulator vs split gaming", [
      ["split fee >= single fee", `${fmtUsdc(splitFee)} >= ${fmtUsdc(singleFee.total)} USDC  ${feeOk ? C.green + "✔" : C.red + "✘"}${C.reset}`],
      ["split WETH out <= single", `${fmtWeth(splitOut, 6)} <= ${fmtWeth(single.amountOut, 6)}  ${outOk ? C.green + "✔ sub-additive" : C.red + "✘"}${C.reset}`],
      ["stateless per-trade fee would charge", `${C.yellow}${fmtUsdc(naiveTotal)} USDC${C.reset}  (each 10k leg below threshold → surge dodged; counterfactual, off-chain)`],
    ]);
    if (!feeOk || !outOk) throw new Error("split-attack invariant violated");
    results.push({ name: "4 Split 5x10k", tier: C.yellow + "unverified" + C.reset, inStr: "50,000 USDC", outStr: `${fmtWeth(splitOut)} WETH`,
      price: fmtUsdc(USDC(50_000) * 10n ** 18n / splitOut), fee: pct(splitFee, USDC(50_000), 3), gas: legs.reduce((a, l) => a + l.gas, 0n).toString(), hash: "5 txs", status: C.green + "no gain" + C.reset });
  }

  // ---------------- Summary ----------------
  banner("Summary");
  grid(["Scenario", "Taker", "In", "Out", "USDC/WETH", "Fee", "Gas", "Tx", "Result"],
    results.map((r) => [r.name, r.tier, r.inStr, r.outStr, r.price, r.fee, r.gas, r.hash, r.status]));

  table("Dual verification → one 0x7A fee logic", [
    ["1A · ZK Aadhaar proof (type 2)", `${pct(fee1A, USDC(5_000), 3)} on 5,000 USDC  (${fmtUsdc(fee1A)} USDC)`],
    ["1B · World ID proof (type 1)", `${pct(fee1B, USDC(5_000), 3)} on 5,000 USDC  (${fmtUsdc(fee1B)} USDC)  ${fee1A === fee1B ? C.green + "identical retail tier ✔" + C.reset : C.red + "tiers differ" + C.reset}`],
    ["2  · unverified bot", `${pct(fee2, USDC(50_000), 3)} on 50,000 USDC  (${fmtUsdc(fee2)} USDC, incl. surge)`],
  ]);

  const vEnd = await env.vaultAssets();
  const refPrice = env.cfg.usdcLiquidity * 10n ** 18n / env.cfg.wethLiquidity; // 2,500 USDC/WETH
  const value = (v: { usdc: bigint; weth: bigint }) => v.usdc + v.weth * refPrice / 10n ** 18n;
  const pnl = value(vEnd) - value(v0);
  const aq = await env.aquaBalances();
  table("Maker position (self-custodied in ERC-4626 vaults)", [
    ["start", `${fmtUsdc(v0.usdc)} USDC + ${fmtWeth(v0.weth)} WETH`],
    ["end", `${fmtUsdc(vEnd.usdc)} USDC + ${fmtWeth(vEnd.weth)} WETH`],
    ["Aqua book == vault backing", aq.usdc === vEnd.usdc && aq.weth === vEnd.weth ? C.green + "yes ✔" + C.reset : C.red + "NO" + C.reset],
    ["Maker wallet idle tokens", `${fmtUsdc(await env.contracts.usdc.balanceOf(env.addr.maker))} USDC, ${fmtWeth(await env.contracts.weth.balanceOf(env.addr.maker))} WETH`],
    ["P&L marked at 2,500 USDC/WETH", `${C.green}+${fmtUsdc(pnl)} USDC${C.reset}  (fees + curve spread, marked at the initial price)`],
  ]);
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
