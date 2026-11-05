// SPDX-License-Identifier: MIT
// Exercises the dashboard's client library against a running, seeded node.
import { readFileSync } from "fs";
import { createAegisClient, disassemble, feeModel, splitOrder, type Deployment } from "../src/lib/aegis";

const dep: Deployment = JSON.parse(readFileSync(new URL("../public/deployment.json", import.meta.url), "utf8"));
const c = createAegisClient(dep);
const assert = (cond: unknown, msg: string) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok  ", msg); };

const live = await c.fetchLiveOrder();
assert(live.order.data.toLowerCase() === dep.order.data.toLowerCase() && BigInt(live.order.traits) === BigInt(dep.order.traits), "live order from Aqua Shipped log == seeded order");
const frames = disassemble(splitOrder(live.order).program);
assert(frames.map((f) => f.name).join(",") === "Deadline,ZKIdentityGuard,JITVaultReserves,JumpIfTokenIn,RequireMinRate,Jump,RequireMinRate,VolatilitySurgeFee,XYCSwap", "disassembly: " + frames.map((f) => f.name).join(" → "));

const amt = 5_000n * 10n ** 6n;
const st0 = await c.readState();
const h = await c.quote("human", amt), b = await c.quote("bot", amt);
assert(h.ok && b.ok && h.amountOut > b.amountOut, "human quote > bot quote");
assert(h.ok && h.amountOut === feeModel(dep, st0, amt, true).expectedOut, "fee mirror == on-chain quote (human)");

const s = await c.swap("human", amt);
assert(!s.reverted && s.quote.ok && s.amountOut === s.quote.amountOut, `swap == quote (0 wei divergence), tx ${s.hash}`);

const w = await c.quote("whale", 500_000n * 10n ** 6n);
assert(!w.ok && w.error.startsWith("JITExposureCapExceeded"), "whale quote blocked: " + (w.ok ? "" : w.error));

const before = await c.readState();
const sp = await c.splitAttack(50_000n * 10n ** 6n, 5);
const splitOut = sp.legs.reduce((a, l) => a + l.amountOut, 0n), splitFee = sp.legs.reduce((a, l) => a + l.fee.total, 0n);
assert(sp.single.ok && splitOut <= sp.single.amountOut && splitFee >= sp.singleFee.total, `split ${splitOut} <= single ${sp.single.ok ? sp.single.amountOut : 0n}; fee ${splitFee} >= ${sp.singleFee.total}`);
assert(sp.legs.every((l) => l.amountOut === l.quoteOut), "every split leg: swap == quote");
const after = await c.readState();
assert(after.aqua.usdc === before.aqua.usdc && after.vault.weth === before.vault.weth, "split sandbox reverted via evm_revert");
console.log("smoke: all good");
