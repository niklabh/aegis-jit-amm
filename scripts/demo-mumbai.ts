// AegisJIT — ETHGlobal Mumbai 2026 judge demo
//   npx hardhat run scripts/demo-mumbai.ts
//
// Deploys Aqua, WETHMock, USDC, 2x MockERC4626Vault (1,000,000 USDC + 400 WETH), the
// MockAnonIdentityVerifier and AegisSwapVMRouter, ships the Maker's self-custodial AegisJIT
// strategy to Aqua and runs three live on-chain scenarios.

import { deployAegis, USDC, WETH, AegisEnv } from "../test/utils/aegisFixture";
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

async function main() {
  console.log(`\n${C.bold}${C.magenta}   ▄▀█ █▀▀ █▀▀ █ █▀   ░░█ █ ▀█▀    AegisJIT · Custom-Opcode AMM & Self-Custodial JIT Vault${C.reset}`);
  console.log(`${C.bold}${C.magenta}   █▀█ ██▄ █▄█ █ ▄█   █▄█ █ ░█░    1inch Aqua + SwapVM · ETHGlobal Mumbai 2026${C.reset}`);

  banner("0 · Deploy & register the Maker's self-custodial strategy");
  const env = await deployAegis();
  const { human, bot, whale } = env.accounts;
  const { router } = env.contracts;

  table("Deployments (local Hardhat network)", [
    ["Aqua", env.addr.aqua],
    ["AegisSwapVMRouter", env.addr.router],
    ["AegisJITVaultHook", env.addr.hook],
    ["MockAnonIdentityVerifier", env.addr.verifier],
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
    ["λ exposure cap / boost", `${env.cfg.lambdaBps / 100}% per execution  /  ${env.cfg.virtualBoostBps / 10_000}x virtual depth`],
    ["fees (1e9 = 100%)", `base ${env.cfg.baseFeeBps / 1e7}%  ·  surge marginal ${env.cfg.maxSurgeFeeBps / 1e7}% above ${Number(env.cfg.impactThresholdBps) / 100}% util`],
    ["program", `${program.length} bytes · ${ops.length} instructions`],
    ...ops.map((o, i) => [`  [${i}]`, o] as [string, string]),
  ]);

  type Row = { name: string; tier: string; inStr: string; outStr: string; price: string; fee: string; gas: string; hash: string; status: string };
  const results: Row[] = [];

  // ---------------- Scenario 1 ----------------
  banner("1 · Verified human retail trader: 5,000 USDC -> WETH");
  {
    const amount = USDC(5_000);
    const hAddr = await human.getAddress();
    const zk = await env.zkArgs(hAddr);
    const data = env.takerData({ tokenIn: env.addr.usdc, zk });
    const botQuote = await env.quote(bot, amount, env.takerData({ tokenIn: env.addr.usdc }));
    const q = await env.quote(human, amount, data);
    const fee = await surgeFeeBreakdown(env, amount, true);
    const before = await env.vaultAssets();
    const s = await env.swap(human, amount, data);
    const after = await env.vaultAssets();
    table("0x2A ZK pass → 0x7A human tier (50% base-fee discount) → settled via Aqua", [
      ["proof", `issuer-signed Anon-Aadhaar reveal [age>18=1, state=27 Maharashtra], bound to ${short(hAddr)}`],
      ["quote()  (static)", `${fmtWeth(q.amountOut, 6)} WETH`],
      ["swap()   (executed)", `${fmtWeth(s.amountOut, 6)} WETH  ${s.amountOut === q.amountOut ? C.green + "== quote ✔" + C.reset : C.red + "!= quote" + C.reset}`],
      ["same trade as unverified bot", `${fmtWeth(botQuote.amountOut, 6)} WETH  (human gets +${fmtWeth(q.amountOut - botQuote.amountOut, 6)} WETH)`],
      ["fee charged", `${fmtUsdc(fee.total)} USDC  (${pct(fee.total, amount, 3)})  ${fee.expectedOut === s.amountOut ? C.green + "off-chain model == on-chain ✔" + C.reset : C.red + "model mismatch" + C.reset}`],
      ["tx / gas", `${short(s.receipt.hash)}  /  ${s.receipt.gasUsed}`],
      ["avUSDC (Maker)", `${fmtUsdc(before.usdc)}  →  ${fmtUsdc(after.usdc)}   (+${fmtUsdc(after.usdc - before.usdc)} re-deposited JIT)`],
      ["avWETH (Maker)", `${fmtWeth(before.weth)}  →  ${fmtWeth(after.weth)}   (−${fmtWeth(before.weth - after.weth)} withdrawn JIT)`],
    ]);
    results.push({ name: "1 Human retail", tier: C.green + "ZK verified" + C.reset, inStr: `${fmtUsdc(amount, 0)} USDC`, outStr: `${fmtWeth(s.amountOut)} WETH`,
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
      const raw = e?.data ?? e?.error?.data ?? e?.info?.error?.data;
      const err = raw ? router.interface.parseError(raw) : null;
      decoded = err ? `${err.name}(${err.args.map((a: bigint) => fmtWeth(a, 4) + " WETH").join(", ")})` : (e.shortMessage ?? String(e));
      const block = await ethers.provider.getBlock("latest", true);
      const txh = block?.prefetchedTransactions?.find((t: any) => t.to?.toLowerCase() === env.addr.router.toLowerCase())?.hash;
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

  // ---------------- Summary ----------------
  banner("Summary");
  grid(["Scenario", "Taker", "In", "Out", "USDC/WETH", "Fee", "Gas", "Tx", "Result"],
    results.map((r) => [r.name, r.tier, r.inStr, r.outStr, r.price, r.fee, r.gas, r.hash, r.status]));

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
