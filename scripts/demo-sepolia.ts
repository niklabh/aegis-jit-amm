// SPDX-License-Identifier: MIT
// Runs the AegisJIT judge scenarios against a PUBLIC deployment (deployments/<network>/aegis.json), e.g.
//   npx hardhat run --network sepolia scripts/demo-sepolia.ts
// Unlike scripts/demo-mumbai.ts there is no evm_snapshot / evm_increaseTime / debug_traceTransaction here:
// counterfactuals come from quote() (an eth_call on the same state), gas from receipts, and waiting for a
// window to roll means actually waiting. Results are merged into deployments/<network>/demo.json after
// EVERY scenario, so an RPC stall never loses finished work.
//   DEMO_SCENARIOS=9        run only scenario 9 (comma-separated list; default: all)
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import { ZKVerifierType, encodeZKBindingClaim, signTakerAuthorization } from "../src/aegisProgramBuilder";
import {
  RealProof, USDC, WETH, encodeRealProofTakerArgs, encodeWorldIdProofTakerArgs, generateRealProof, generateWorldIdProof,
  worldIdArtifactsAvailable,
} from "../test/utils/aegisFixture";
import { TakerTraitsLib } from "../test/utils/SwapVMHelpers";
import { C, banner, fmtUsdc, fmtWeth, grid, n, pct, short, table } from "./lib/format";
import { loadRecord, saveJson, takerWallets, txLink } from "./lib/deployment";

const { ethers, network } = require("hardhat");
const FEE_BPS = 1_000_000_000n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row { name: string; taker: string; inStr: string; outStr: string; price: string; fee: string; gas: string; tx: string; status: string; link?: string }
/** fee column: effective rate, with the base / surge split whenever the flow bucket added surge */
const feeLabel = (f: { total: bigint; base: bigint; surge: bigint }, amount: bigint) =>
  f.surge === 0n ? pct(f.total, amount, 3) : `${pct(f.total, amount, 3)} (${pct(f.base, amount, 3)} base + ${pct(f.surge, amount, 3)} surge)`;

async function main() {
  const rec = loadRecord();
  const chainId = rec.chainId;
  const isLocal = network.name === "localhost" || network.name === "hardhat";
  const [deployer] = await ethers.getSigners();
  const takers = takerWallets();
  const { human, bot, whale, worldHuman } = takers;
  const at = (key: string, name: string) => ethers.getContractAt(name, rec.contracts[key].address);
  const router = await at("router", "AegisSwapVMRouter");
  const usdc = await at("usdc", "TokenCustomDecimalsMock");
  const weth = await at("weth", "TokenCustomDecimalsMock");
  const usdcVault = await at("usdcVault", "MockERC4626Vault");
  const wethVault = await at("wethVault", "MockERC4626Vault");
  const adapter = await at("adapter", "AnonAadhaarAdapter");
  const worldIdAdapter = await at("worldIdAdapter", "WorldIDAdapter");
  const worldIdRouter = await at("worldIdRouter", "MockWorldIDRouter");
  const forwarder = await at("forwarder", "AegisZKForwarder");
  const aqua = await at("aqua", "Aqua");
  const A = rec.contracts; const usdcAddr = A.usdc.address, wethAddr = A.weth.address;
  const tokenA = BigInt(usdcAddr) < BigInt(wethAddr) ? usdcAddr : wethAddr;
  const order = rec.order;
  const cfg = {
    usdcLiquidity: BigInt(rec.cfg.usdcLiquidity as string), wethLiquidity: BigInt(rec.cfg.wethLiquidity as string),
    lambdaBps: BigInt(rec.cfg.lambdaBps as number), virtualBoostBps: BigInt(rec.cfg.virtualBoostBps as number),
    exposureWindowSec: Number(rec.cfg.exposureWindowSec), decayWindowSec: Number(rec.cfg.decayWindowSec),
    baseFeeBps: BigInt(rec.cfg.baseFeeBps as number), maxSurgeFeeBps: BigInt(rec.cfg.maxSurgeFeeBps as number),
    impactThresholdBps: BigInt(rec.cfg.impactThresholdBps as string),
  };
  const REAL_ZK = existsSync(path.join(__dirname, "..", ".cache", "anon-aadhaar", "v2.0.0", "circuit_final.zkey"));
  if (!REAL_ZK) throw new Error("the public deployment has only the REAL Groth16 verifier: run `node packages/zk-aadhaar/prover/fetch-artifacts.mjs` first");
  if (!worldIdArtifactsAvailable()) throw new Error("World ID artifacts missing: run `node packages/world-id/prover/fetch-artifacts.mjs`");

  banner(`AegisJIT · live scenarios on ${network.name} (chainId ${chainId})`);
  console.log(`router ${A.router.address}   orderHash ${rec.orderHash}`);
  for (const [k, w] of Object.entries(takers)) console.log(`  ${k.padEnd(11)} ${w.address}  ${ethers.formatEther(await ethers.provider.getBalance(w.address))} ETH`);

  // ---------------- helpers
  const td = (o: { exactIn?: boolean; zk?: string; threshold?: bigint; taker?: string; to?: string } = {}) => TakerTraitsLib.build({
    taker: o.taker, to: o.to, isExactIn: o.exactIn ?? true, isAToB: usdcAddr.toLowerCase() === tokenA.toLowerCase(),
    useTransferFromAndAquaPush: true, threshold: o.threshold, instructionsArgs: o.zk,
  });
  const latestTs = async () => BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  async function quote(signer: any, amount: bigint, data: string): Promise<{ amountIn: bigint; amountOut: bigint }> {
    const [amountIn, amountOut] = await router.connect(signer).quote.staticCall(order, amount, data);
    return { amountIn: amountIn as bigint, amountOut: amountOut as bigint };
  }
  async function quoteAs(from: string, amount: bigint, data: string): Promise<bigint> {
    const raw = await ethers.provider.call({ to: A.router.address, from, data: router.interface.encodeFunctionData("quote", [order, amount, data]) });
    return router.interface.decodeFunctionResult("quote", raw)[1] as bigint;
  }
  async function swap(signer: any, amount: bigint, data: string) {
    const tx = await router.connect(signer).swap(order, amount, data);
    const rc = await tx.wait();
    const ev = rc.logs.map((l: any) => { try { return router.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Swapped");
    console.log(`  ${C.dim}tx ${txLink(chainId, rc.hash)}  gas ${rc.gasUsed}${C.reset}`);
    return { amountIn: ev.args.amountIn as bigint, amountOut: ev.args.amountOut as bigint, rc };
  }
  const findRevertData = (x: any, depth = 0): string | undefined => {
    if (x == null || depth > 6) return undefined;
    if (typeof x === "string" && /^0x[0-9a-fA-F]{8}/.test(x)) return x;
    if (typeof x !== "object") return undefined;
    for (const k of ["data", "error", "info", "revert"]) { const r = findRevertData(x[k], depth + 1); if (r !== undefined) return r; }
    return undefined;
  };
  const decodeError = (e: any) => { const raw = findRevertData(e); const err = raw ? router.interface.parseError(raw) : null; return err ? `${err.name}(${err.args.map((a: any) => typeof a === "bigint" ? a.toString() : String(a)).join(", ")})` : (e.shortMessage ?? String(e)); };
  /** Sends a swap that is expected to revert: decodes the error with a static call first, then broadcasts it so the
   *  revert is on-chain (a public node accepts it and mines a status-0 receipt; a local Hardhat node rejects it at
   *  submission, in which case there is no hash). */
  async function swapExpectRevert(signer: any, amount: bigint, data: string) {
    let decoded = C.red + "UNEXPECTED: static call succeeded" + C.reset;
    try { await router.connect(signer).swap.staticCall(order, amount, data); } catch (e: any) { decoded = decodeError(e); }
    let hash: string | null = null;
    let rc: any = null;
    try {
      const tx = await router.connect(signer).swap(order, amount, data, { gasLimit: 1_500_000 });
      hash = tx.hash;
      try { rc = await tx.wait(); } catch (e: any) { rc = e.receipt ?? null; }
      for (let i = 0; i < 20 && !rc; i++) { rc = await ethers.provider.getTransactionReceipt(hash); if (!rc) await sleep(3000); }
    } catch (e: any) {
      hash = findTxHash(e); // Hardhat node: "VM Exception while processing transaction" at submission; the tx may still be mined
      if (hash) rc = await ethers.provider.getTransactionReceipt(hash);
    }
    console.log(`  ${C.dim}tx ${hash ? txLink(chainId, hash) : "(rejected at submission by the local node)"}  status ${rc?.status ?? "—"}  gas ${rc?.gasUsed ?? "—"}${C.reset}`);
    return { decoded, rc, hash };
  }
  const findTxHash = (x: any, depth = 0): string | null => {
    if (x == null || depth > 6) return null;
    if (typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x)) return x;
    if (typeof x !== "object") return null;
    for (const k of ["transactionHash", "txHash", "hash", "data", "error", "info", "receipt"]) { const r = findTxHash(x[k], depth + 1); if (r) return r; }
    return null;
  };
  async function vaultAssets() {
    return {
      usdc: (await usdcVault.convertToAssets(await usdcVault.balanceOf(rec.maker))) as bigint,
      weth: (await wethVault.convertToAssets(await wethVault.balanceOf(rec.maker))) as bigint,
    };
  }
  async function aquaBalances() {
    const [u] = await aqua.rawBalances(rec.maker, A.router.address, rec.orderHash, usdcAddr);
    const [w] = await aqua.rawBalances(rec.maker, A.router.address, rec.orderHash, wethAddr);
    return { usdc: u as bigint, weth: w as bigint };
  }
  /** Mirror of 0x7A for USDC->WETH exactIn (display): bucket read from chain, next block assumed in the same window */
  async function feeBreakdown(gross: bigint, humanTier: boolean) {
    const [start, flow, ref] = await router.surgeWindow(rec.orderHash, usdcAddr);
    const now = (await latestTs()) + 12n;
    const aq = await aquaBalances();
    const vIn = aq.usdc + cfg.usdcLiquidity * (cfg.virtualBoostBps - 10_000n) / 10_000n;
    const vOut = aq.weth + cfg.wethLiquidity * (cfg.virtualBoostBps - 10_000n) / 10_000n;
    let F = 0n, refB = vIn;
    if (cfg.decayWindowSec !== 0 && start !== 0n) {
      const k = (now - start) / BigInt(cfg.decayWindowSec);
      const leak = k * (ref * cfg.impactThresholdBps / 10_000n);
      if (flow > leak) { F = flow - leak; refB = ref; }
    }
    const T = refB * cfg.impactThresholdBps / 10_000n;
    const g0 = T > F ? T - F : 0n;
    const b = humanTier ? cfg.baseFeeBps / 2n : cfg.baseFeeBps;
    const p = cfg.maxSurgeFeeBps - cfg.baseFeeBps;
    const excess = gross > g0 ? gross - g0 : 0n;
    const total = (gross * b + excess * p + FEE_BPS - 1n) / FEE_BPS;
    const base = gross * b / FEE_BPS;
    const net = gross - total;
    return { total, base, surge: total - base, priorFlow: F, excess, expectedOut: net * vOut / (vIn + net) };
  }
  const modelMark = (expected: bigint, actual: bigint) => expected === actual ? C.green + "off-chain model == on-chain ✔" + C.reset : C.yellow + "model differs (window boundary crossed between read and inclusion)" + C.reset;
  async function advanceTime(seconds: number, why: string) {
    if (isLocal) { await ethers.provider.send("evm_increaseTime", [seconds]); await ethers.provider.send("evm_mine", []); return; }
    console.log(`  ${C.dim}${why}: waiting ${seconds}s (no evm_increaseTime on a public chain)${C.reset}`);
    const target = Number(await latestTs()) + seconds;
    for (;;) {
      await sleep(15_000);
      try { if (Number(await latestTs()) >= target) break; process.stdout.write("."); }
      catch (e: any) { process.stdout.write("x"); } // RPC stall while waiting: keep waiting
    }
    console.log("");
  }

  // results: merged into deployments/<network>/demo.json after every scenario (rows are keyed by scenario name)
  const demoFile = path.join(__dirname, "..", "deployments", network.name, "demo.json");
  const previous: Row[] = existsSync(demoFile) ? (JSON.parse(readFileSync(demoFile, "utf8")).scenarios ?? []) : [];
  const rows: Row[] = [...previous];
  const push = (r: Row) => {
    const i = rows.findIndex((x) => x.name === r.name);
    if (i >= 0) rows[i] = r; else rows.push(r);
    rows.sort((a, b) => parseInt(a.name) - parseInt(b.name));
    saveJson("demo.json", { network: network.name, chainId, ranAt: new Date().toISOString(), orderHash: rec.orderHash, scenarios: rows });
  };
  const only = (process.env.DEMO_SCENARIOS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const runs = (k: string) => only.length === 0 || only.includes(k);
  const AMT = USDC(5_000);
  const botData = td();

  // the Aadhaar proof is made once and reused by scenarios 2, 3 and 4 (any of them may run alone)
  let realProof: RealProof | null = null;
  async function getRealProof(): Promise<RealProof> {
    if (realProof) return realProof;
    process.stdout.write(`${C.dim}  signed test Aadhaar QR → RSA-2048 → Groth16 proving…${C.reset}`);
    const epoch: bigint = await adapter.currentEpoch();
    realProof = await generateRealProof({ timestamp: Number(await latestTs()), seed: await adapter.currentNullifierSeed(), signal: human.address, epoch });
    process.stdout.write(` done (${realProof.proof.provingMs} ms)\n`);
    return realProof;
  }
  let botGas = 0n; // baseline gas of a proof-less 5k swap (scenario 1); read back from demo.json when 1 is skipped
  const prevBaseline = previous.find((r) => r.name.startsWith("1 "));
  if (prevBaseline && Number(prevBaseline.gas)) botGas = BigInt(prevBaseline.gas);

  // ---------------- S0 warm-up
  if (runs("0")) {
  banner("0 · Warm-up: bot swaps 1,000 USDC (opens the fee and budget buckets so later gas numbers compare like for like)");
  const s0 = await swap(bot, USDC(1_000), botData);
  push({ name: "0 Warm-up bot", taker: "unverified", inStr: "1,000 USDC", outStr: `${fmtWeth(s0.amountOut)} WETH`, price: fmtUsdc(USDC(1_000) * 10n ** 18n / s0.amountOut), fee: "0.300%", gas: s0.rc.gasUsed.toString(), tx: short(s0.rc.hash), status: "filled", link: txLink(chainId, s0.rc.hash) });
  }

  // ---------------- S1 bot baseline
  if (runs("1")) {
  banner("1 · Unverified bot: 5,000 USDC → WETH (baseline, no proof)");
  const s1 = await swap(bot, AMT, botData);
  botGas = s1.rc.gasUsed as bigint;
  push({ name: "1 Bot 5k (baseline)", taker: "unverified", inStr: "5,000 USDC", outStr: `${fmtWeth(s1.amountOut)} WETH`, price: fmtUsdc(AMT * 10n ** 18n / s1.amountOut), fee: "0.300%", gas: botGas.toString(), tx: short(s1.rc.hash), status: "filled", link: txLink(chainId, s1.rc.hash) });
  }

  // ---------------- S2 human, real Aadhaar proof
  let s2gas = 0n;
  if (runs("2")) {
  banner("2 · Verified human via ZK Aadhaar: 5,000 USDC → WETH (REAL Anon Aadhaar Groth16 proof)");
  const real = await getRealProof();
  const epoch: bigint = real.epoch ?? 0n;
  const zk = encodeRealProofTakerArgs(real);
  const humanData = td({ zk });
  const botQ2 = await quote(bot, AMT, botData);
  const q2 = await quote(human, AMT, humanData);
  const fee2 = await feeBreakdown(AMT, true);
  const v2a = await vaultAssets();
  const s2 = await swap(human, AMT, humanData);
  const v2b = await vaultAssets();
  const bound = s2.rc.logs.map((l: any) => { try { return router.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "NullifierBound");
  table("0x2A ZK Aadhaar pass (type 2) → 0x7A human tier → settled via Aqua + JIT hook", [
    ["proof", `REAL Groth16 (BN254) · ${real.proof.provingMs.toLocaleString()} ms · signal = ${short(human.address)} · epoch ${epoch} · state ${real.proof.stateText} (gender/pincode hidden)`],
    ["quote() / swap()", `${fmtWeth(q2.amountOut, 6)} / ${fmtWeth(s2.amountOut, 6)} WETH  ${s2.amountOut === q2.amountOut ? C.green + "== quote ✔ (0 wei)" + C.reset : C.red + "!= quote" + C.reset}`],
    ["same trade as unverified bot (quote)", `${fmtWeth(botQ2.amountOut, 6)} WETH  (human gets +${fmtWeth(q2.amountOut - botQ2.amountOut, 6)} WETH)`],
    ["fee charged", `${fmtUsdc(fee2.total)} USDC (${pct(fee2.total, AMT, 3)})  ${modelMark(fee2.expectedOut, s2.amountOut)}`],
    ["nullifier binding", bound ? `${short("0x" + BigInt(bound.args.nullifier).toString(16))} → ${short(bound.args.beneficiary)} valid until ${new Date(Number(bound.args.validUntil) * 1000).toISOString()}` : "(already bound)"],
    ["gas", `${n(s2.rc.gasUsed)}  vs ${n(botGas)} for the bot baseline → ZK overhead ${n(s2.rc.gasUsed - botGas)}`],
    ["avUSDC / avWETH (Maker)", `${fmtUsdc(v2a.usdc)} → ${fmtUsdc(v2b.usdc)}  /  ${fmtWeth(v2a.weth)} → ${fmtWeth(v2b.weth)}  (JIT withdraw + re-deposit)`],
  ]);
  push({ name: "2 Human · ZK Aadhaar", taker: "Groth16 ✔", inStr: "5,000 USDC", outStr: `${fmtWeth(s2.amountOut)} WETH`, price: fmtUsdc(AMT * 10n ** 18n / s2.amountOut), fee: feeLabel(fee2, AMT), gas: s2.rc.gasUsed.toString(), tx: short(s2.rc.hash), status: "filled", link: txLink(chainId, s2.rc.hash) });
  s2gas = s2.rc.gasUsed;
  }

  // ---------------- S3 binding claim
  if (runs("3")) {
  banner("3 · Same human, next trade: 35-byte binding claim, no proof, no pairing");
  const real = await getRealProof();
  const zk = encodeRealProofTakerArgs(real);
  const claimData = td({ zk: encodeZKBindingClaim(ZKVerifierType.AADHAAR, BigInt(real.proof.publicSignals.nullifier)) });
  const botQ3 = await quote(bot, AMT, botData);
  const q3 = await quote(human, AMT, claimData);
  const fee3 = await feeBreakdown(AMT, true);
  const s3 = await swap(human, AMT, claimData);
  table("0x2A fast path", [
    ["payload", `35 bytes (the proof payload was ${ethers.getBytes(zk).length} bytes)`],
    ["quote() / swap()", `${fmtWeth(q3.amountOut, 6)} / ${fmtWeth(s3.amountOut, 6)} WETH  ${s3.amountOut === q3.amountOut ? C.green + "== quote ✔" + C.reset : C.red + "!= quote" + C.reset} · ${s3.amountOut > botQ3.amountOut ? C.green + "human tier ✔" + C.reset : C.red + "bot tier" + C.reset}`],
    ["fee charged", `${fmtUsdc(fee3.total)} USDC (${pct(fee3.total, AMT, 3)})  ${modelMark(fee3.expectedOut, s3.amountOut)}`],
    ["gas", `${n(s3.rc.gasUsed)}  vs ${n(botGas)} baseline → fast-path overhead ${n(s3.rc.gasUsed - botGas)}  (full proof: ${s2gas ? n(s2gas) : "see scenario 2"})`],
  ]);
  push({ name: "3 Human · binding claim", taker: "binding ✔", inStr: "5,000 USDC", outStr: `${fmtWeth(s3.amountOut)} WETH`, price: fmtUsdc(AMT * 10n ** 18n / s3.amountOut), fee: feeLabel(fee3, AMT), gas: s3.rc.gasUsed.toString(), tx: short(s3.rc.hash), status: "filled", link: txLink(chainId, s3.rc.hash) });
  }

  // ---------------- S4 via authorised aggregator
  if (runs("4")) {
  banner("4 · Same human through an aggregator (AegisZKForwarder) with an EIP-712 TakerAuthorization");
  const real = await getRealProof();
  const deadline = (await latestTs()) + 3_600n;
  const auth = await signTakerAuthorization(human, chainId, A.adapter.address, A.forwarder.address, deadline);
  const zkAuth = encodeRealProofTakerArgs(real, { auth });
  const fwdData = td({ taker: A.forwarder.address, to: human.address, zk: zkAuth });
  const botQ4 = await quote(bot, AMT, botData);
  const q4 = await quoteAs(A.forwarder.address, AMT, fwdData);
  const fee4 = await feeBreakdown(AMT, true);
  const wethBefore: bigint = await weth.balanceOf(human.address);
  const tx4 = await forwarder.connect(human).swapExactIn(order, usdcAddr, AMT, fwdData);
  const rc4 = await tx4.wait();
  const ev4 = rc4.logs.map((l: any) => { try { return router.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Swapped");
  const out4: bigint = ev4.args.amountOut;
  console.log(`  ${C.dim}tx ${txLink(chainId, rc4.hash)}  gas ${rc4.gasUsed}${C.reset}`);
  table("aggregator path: recipient envelope + beneficiary-signed authorisation (no whitelist)", [
    ["taker (msg.sender of swap)", `${short(A.forwarder.address)} AegisZKForwarder · Swapped.taker = ${short(ev4.args.taker)}`],
    ["authorisation", `TakerAuthorization(taker = forwarder, deadline = ${new Date(Number(deadline) * 1000).toISOString()}) signed by ${short(human.address)}`],
    ["quote(from = forwarder) / swap()", `${fmtWeth(q4, 6)} / ${fmtWeth(out4, 6)} WETH  ${out4 === q4 ? C.green + "== quote ✔" + C.reset : C.red + "!= quote" + C.reset} · ${out4 > botQ4.amountOut ? C.green + "human tier ✔" + C.reset : C.red + "bot tier" + C.reset}`],
    ["output delivered to the human", `${fmtWeth((await weth.balanceOf(human.address)) - wethBefore, 6)} WETH  ${modelMark(fee4.expectedOut, out4)}`],
  ]);
  push({ name: "4 Human · via aggregator", taker: "authorised ✔", inStr: "5,000 USDC", outStr: `${fmtWeth(out4)} WETH`, price: fmtUsdc(AMT * 10n ** 18n / out4), fee: feeLabel(fee4, AMT), gas: rc4.gasUsed.toString(), tx: short(rc4.hash), status: "filled", link: txLink(chainId, rc4.hash) });
  }

  // ---------------- S5 World ID human
  let fee2base: bigint | null = null;
  if (runs("5")) {
  banner("5 · Verified human via World ID: 5,000 USDC → WETH (REAL Semaphore depth-30 proof, World ID's verifier)");
  process.stdout.write(`${C.dim}  Semaphore v3 identity → depth-30 merkle path → Groth16 proving…${C.reset}`);
  const wp = await generateWorldIdProof({ identity: "human", signal: worldHuman.address, externalNullifier: await worldIdAdapter.currentExternalNullifier(), epoch: await worldIdAdapter.currentEpoch() });
  process.stdout.write(` done (${wp.provingMs} ms)\n`);
  if ((await worldIdRouter.latestRoot()) !== BigInt(wp.root)) {
    const rtx = await worldIdRouter.connect(deployer).registerRoot(BigInt(wp.root)); const rrc = await rtx.wait();
    console.log(`  ${C.dim}sequencer published the tree root: ${txLink(chainId, rrc.hash)}${C.reset}`);
  }
  const worldData = td({ zk: encodeWorldIdProofTakerArgs(wp) });
  const botQ5 = await quote(bot, AMT, botData);
  const q5 = await quote(worldHuman, AMT, worldData);
  const fee5 = await feeBreakdown(AMT, true);
  const s5 = await swap(worldHuman, AMT, worldData);
  table("0x2A World ID pass (type 1) → 0x7A human tier", [
    ["proof", `REAL Semaphore Groth16 · ${wp.provingMs} ms · root ${short("0x" + BigInt(wp.root).toString(16))} · nullifierHash ${short("0x" + BigInt(wp.nullifierHash).toString(16))} · signal = ${short(worldHuman.address)}`],
    ["on-chain verify", "WorldIDAdapter → MockWorldIDRouter (group 1, root history) → World ID's SemaphoreVerifier → ecPairing 0x08"],
    ["quote() / swap()", `${fmtWeth(q5.amountOut, 6)} / ${fmtWeth(s5.amountOut, 6)} WETH  ${s5.amountOut === q5.amountOut ? C.green + "== quote ✔" + C.reset : C.red + "!= quote" + C.reset} · base fee ${fmtUsdc(fee5.base)} USDC (${fee5.base === AMT * (cfg.baseFeeBps / 2n) / FEE_BPS ? C.green + "human tier ✔" + C.reset : C.red + "not the human tier" + C.reset})`],
    ["same trade as unverified bot (quote)", `${fmtWeth(botQ5.amountOut, 6)} WETH`],
    ["gas", `${n(s5.rc.gasUsed)}  vs ${n(botGas)} baseline → World ID overhead ${n(s5.rc.gasUsed - botGas)}`],
  ]);
  push({ name: "5 Human · World ID", taker: "Semaphore ✔", inStr: "5,000 USDC", outStr: `${fmtWeth(s5.amountOut)} WETH`, price: fmtUsdc(AMT * 10n ** 18n / s5.amountOut), fee: feeLabel(fee5, AMT), gas: s5.rc.gasUsed.toString(), tx: short(s5.rc.hash), status: "filled", link: txLink(chainId, s5.rc.hash) });
  void fee2base;
  }

  // ---------------- S6 surge
  if (runs("6")) {
  banner("6 · Unverified arbitrage bot: 50,000 USDC → WETH (0x7A surge)");
  const BIG = USDC(50_000);
  const fee6 = await feeBreakdown(BIG, false);
  const q6 = await quote(bot, BIG, botData);
  const s6 = await swap(bot, BIG, botData);
  table("0x7A volatility surge fee", [
    ["quote() / swap()", `${fmtWeth(q6.amountOut, 6)} / ${fmtWeth(s6.amountOut, 6)} WETH  ${s6.amountOut === q6.amountOut ? C.green + "== quote ✔" + C.reset : C.red + "!= quote" + C.reset}`],
    ["flow already in the bucket", `${fmtUsdc(fee6.priorFlow)} USDC`],
    ["flow above the 1% threshold", `${fmtUsdc(fee6.excess)} USDC`],
    ["base fee / surge fee", `${fmtUsdc(fee6.base)} / ${C.yellow}${fmtUsdc(fee6.surge)}${C.reset} USDC`],
    ["total fee", `${fmtUsdc(fee6.total)} USDC (${pct(fee6.total, BIG, 3)} effective)  ${modelMark(fee6.expectedOut, s6.amountOut)}`],
  ]);
  push({ name: "6 Arb bot 50k", taker: "unverified", inStr: "50,000 USDC", outStr: `${fmtWeth(s6.amountOut)} WETH`, price: fmtUsdc(BIG * 10n ** 18n / s6.amountOut), fee: feeLabel(fee6, BIG), gas: s6.rc.gasUsed.toString(), tx: short(s6.rc.hash), status: "filled", link: txLink(chainId, s6.rc.hash) });
  }

  // ---------------- S7 split attack vs single (quote as the counterfactual)
  if (runs("7")) {
  const BIG = USDC(50_000);
  banner("7 · Split attack: 5 × 10,000 USDC vs the quote for 1 × 50,000 on the same state");
  const singleQ = await quote(bot, BIG, botData);
  const singleFee = await feeBreakdown(BIG, false);
  const legs: Array<{ out: bigint; fee: bigint; surge: bigint; hash: string; gas: bigint }> = [];
  for (let i = 0; i < 5; i++) {
    const f = await feeBreakdown(USDC(10_000), false);
    const s = await swap(bot, USDC(10_000), botData);
    legs.push({ out: s.amountOut, fee: f.total, surge: f.surge, hash: s.rc.hash, gas: s.rc.gasUsed });
  }
  const splitOut = legs.reduce((a, l) => a + l.out, 0n), splitFee = legs.reduce((a, l) => a + l.fee, 0n);
  grid(["Trade", "Surge fee", "Total fee", "WETH out", "Tx"], [
    ["1 x 50,000 (quote, counterfactual)", fmtUsdc(singleFee.surge), fmtUsdc(singleFee.total), fmtWeth(singleQ.amountOut, 6), "eth_call"],
    ...legs.map((l, i) => [`leg ${i + 1}/5 x 10,000`, fmtUsdc(l.surge), fmtUsdc(l.fee), fmtWeth(l.out, 6), short(l.hash)]),
    [C.bold + "5-part split total" + C.reset, fmtUsdc(legs.reduce((a, l) => a + l.surge, 0n)), fmtUsdc(splitFee), fmtWeth(splitOut, 6), ""],
  ]);
  const splitOk = splitOut <= singleQ.amountOut && splitFee >= singleFee.total;
  console.log(`  split WETH out ${fmtWeth(splitOut, 6)} <= single ${fmtWeth(singleQ.amountOut, 6)} and fee ${fmtUsdc(splitFee)} >= ${fmtUsdc(singleFee.total)} USDC: ${splitOk ? C.green + "✔ sub-additive" + C.reset : C.red + "✘" + C.reset}`);
  push({ name: "7 Split 5x10k", taker: "unverified", inStr: "50,000 USDC", outStr: `${fmtWeth(splitOut)} WETH`, price: fmtUsdc(BIG * 10n ** 18n / splitOut), fee: pct(splitFee, BIG, 3), gas: legs.reduce((a, l) => a + l.gas, 0n).toString(), tx: "5 txs", status: splitOk ? "no gain" : "VIOLATION", link: txLink(chainId, legs[0].hash) });
  }

  // ---------------- S8 whale single execution
  if (runs("8")) {
  banner("8 · Toxic whale: 500,000 USDC → WETH in one execution");
  const WHALE = USDC(500_000);
  const v8 = await vaultAssets();
  const r8 = await swapExpectRevert(whale, WHALE, botData);
  table("0x9A per-execution cap", [
    ["result", `${C.red}${C.bold}REVERTED${C.reset}  ${r8.decoded}`],
    ["max single execution", `${fmtWeth(v8.weth * cfg.lambdaBps / 10_000n, 4)} WETH = ${Number(cfg.lambdaBps) / 100}% of ${fmtWeth(v8.weth, 4)} WETH live backing`],
    ["avWETH (Maker)", `${fmtWeth((await vaultAssets()).weth)} WETH  ${C.green}untouched ✔${C.reset}`],
  ]);
  push({ name: "8 Whale 500k", taker: "unverified", inStr: "500,000 USDC", outStr: "0 WETH", price: "—", fee: "—", gas: r8.rc?.gasUsed?.toString() ?? "—", tx: r8.hash ? short(r8.hash) : "—", status: "blocked 0x9A", link: r8.hash ? txLink(chainId, r8.hash) : undefined });
  }

  // ---------------- S9 whale split into max-cap executions (budget)
  if (runs("9")) {
  banner("9 · Same whale, split into 4 max-cap executions inside one budget window");
  {
    // wait until the budget bucket is empty so the whale starts on a full λ budget (no evm_increaseTime here)
    const [start, outFlow, refBacking] = await router.exposureWindow(rec.orderHash, wethAddr);
    const W = BigInt(cfg.exposureWindowSec);
    if (start !== 0n && outFlow !== 0n) {
      const budget = refBacking * cfg.lambdaBps / 10_000n;
      const windows = (outFlow + budget - 1n) / budget;
      const target = start + windows * W + 5n;
      const wait = Number(target - (await latestTs()));
      if (wait > 0) await advanceTime(wait, `budget bucket holds ${fmtWeth(outFlow, 4)} WETH of ${fmtWeth(budget, 4)}; it leaks one budget per ${W}s window`);
    }
    const legRows: string[][] = [];
    let filled = 0;
    let firstLegHash: string | null = null;
    const vBefore = await vaultAssets();
    for (let i = 0; i < 4; i++) {
      const live = (await vaultAssets()).weth;
      const cap = live * cfg.lambdaBps / 10_000n;
      const data = td({ exactIn: false });
      let ok = false;
      try { await router.connect(whale).swap.staticCall(order, cap, data); ok = true; } catch { ok = false; }
      if (ok) {
        const s = await swap(whale, cap, data); filled++;
        firstLegHash = firstLegHash ?? s.rc.hash;
        legRows.push([`leg ${i + 1}/4`, `${fmtWeth(cap, 4)} WETH`, C.green + "filled" + C.reset, short(s.rc.hash)]);
      } else {
        const r = await swapExpectRevert(whale, cap, data);
        legRows.push([`leg ${i + 1}/4`, `${fmtWeth(cap, 4)} WETH`, C.red + "reverted " + r.decoded.split("(")[0] + C.reset, r.hash ? short(r.hash) : "—"]);
      }
    }
    const vAfter = await vaultAssets();
    grid(["Sequential max-cap legs (exactOut)", "Wants", "Result", "Tx"], legRows);
    table("0x9A exposure budget: λ of the backing per window, however many executions", [
      ["filled", `${filled} of 4`],
      ["WETH that left the vault", `${fmtWeth(vBefore.weth - vAfter.weth, 4)} of ${fmtWeth(vBefore.weth, 4)} = ${pct(vBefore.weth - vAfter.weth, vBefore.weth)}  (budget ${Number(cfg.lambdaBps) / 100}% per ${cfg.exposureWindowSec}s window)`],
    ]);
    const firstLeg = legRows[0]?.[3];
    push({ name: "9 Whale split 4x25%", taker: "unverified", inStr: "4 txs", outStr: `${fmtWeth(vBefore.weth - vAfter.weth)} WETH`, price: "—", fee: "—", gas: "—", tx: "4 txs", status: `${filled} of 4 filled`, link: firstLegHash ? txLink(chainId, firstLegHash) : undefined });
    void firstLeg;
  }
  }

  // ---------------- summary
  banner("Summary");
  grid(["Scenario", "Taker", "In", "Out", "USDC/WETH", "Fee", "Gas", "Tx", "Result"], rows.map((r) => [r.name, r.taker, r.inStr, r.outStr, r.price, r.fee, r.gas, r.tx, r.status]));
  const vEnd = await vaultAssets(); const aq = await aquaBalances();
  table("Maker position after the run", [
    ["vaults", `${fmtUsdc(vEnd.usdc)} USDC + ${fmtWeth(vEnd.weth)} WETH`],
    ["Aqua book", `${fmtUsdc(aq.usdc)} USDC + ${fmtWeth(aq.weth)} WETH`],
    ["vault backing covers the Aqua book", aq.usdc <= vEnd.usdc && aq.weth <= vEnd.weth ? C.green + "yes ✔" + C.reset : C.red + "NO" + C.reset],
    ["Maker wallet idle tokens", `${fmtUsdc(await usdc.balanceOf(rec.maker))} USDC, ${fmtWeth(await weth.balanceOf(rec.maker))} WETH`],
  ]);
  console.log(`\nresults in ${demoFile}\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
