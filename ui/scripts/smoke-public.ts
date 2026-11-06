// SPDX-License-Identifier: MIT
// Exercises the dashboard's client library against a PUBLIC deployment in read-only mode (ui/public/deployment.json
// written by `npx hardhat run --network <net> scripts/ui-deployment.ts`): live order, disassembly, quotes for every
// tier, the fee mirror, the read-only guards, and the World ID adapter's wiring to the chain's real World ID Router.
//   npm run smoke:public
import { readFileSync } from "fs";
import { encodeAbiParameters, toHex } from "viem";
import { createAegisClient, disassemble, feeModel, splitOrder, type Deployment } from "../src/lib/aegis";
import { externalNullifierOf, fromIdKitResult, legacyItemFromIdKit } from "../src/lib/worldid";

const dep: Deployment = JSON.parse(readFileSync(new URL("../public/deployment.json", import.meta.url), "utf8"));
const c = createAegisClient(dep);
const assert = (cond: unknown, msg: string) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } console.log("ok  ", msg); };
const rejects = async (p: Promise<unknown>, needle: string) => { try { await p; return false; } catch (e: any) { return String(e.message ?? e).includes(needle); } };

assert(dep.readOnly === true && dep.explorer, `public deployment: chain ${dep.chainId}, explorer ${dep.explorer}, read-only`);
const live = await c.fetchLiveOrder();
assert(live.order.data.toLowerCase() === dep.order.data.toLowerCase() && BigInt(live.order.traits) === BigInt(dep.order.traits), `live order from the Aqua Shipped log (block ${dep.shipBlock}) == recorded order`);
const frames = disassemble(splitOrder(live.order).program);
const names = frames.map((f) => f.name); if (names[names.length - 1] === "Salt") names.pop(); // ORDER_SALT > 0 appends a Salt frame
assert(names.join(",") === "Deadline,ZKIdentityGuard,JITVaultReserves,JumpIfTokenIn,RequireMinRate,Jump,RequireMinRate,VolatilitySurgeFee,XYCSwap", "disassembly: " + frames.map((f) => f.name).join(" → "));

const amt = 5_000n * 10n ** 6n;
const st = await c.readState();
assert(st.blockNumber > 0n, `state read at block #${st.blockNumber}`);
const h = await c.quote("human", amt), b = await c.quote("bot", amt);
// right after a demo run the λ budget of the current window can be spent: 0x9A then refuses every quote until the window rolls
const budgetSpent = !h.ok && h.error.startsWith("JITExposureBudgetExceeded");
if (budgetSpent) {
  console.log(`info  λ window budget consumed by a recent run (${h.ok ? "" : h.error}); tier and fee-mirror checks skipped until the ${dep.cfg?.exposureWindowSec ?? "exposure"}-second window rolls`);
} else {
  assert(h.ok && b.ok && h.amountOut > b.amountOut, `human quote ${h.ok ? h.amountOut : 0n} > bot quote ${b.ok ? b.amountOut : 0n} (real Aadhaar proof in the human takerData)`);
  assert(h.ok && h.amountOut === feeModel(dep, st, amt, true).expectedOut, "fee mirror == on-chain quote (human)");
  assert(b.ok && b.amountOut === feeModel(dep, st, amt, false).expectedOut, "fee mirror == on-chain quote (bot)");
}
const w = await c.quote("whale", 500_000n * 10n ** 6n);
assert(!w.ok && /^JITExposure(Cap|Budget)Exceeded/.test(w.error), "whale 500k blocked by 0x9A: " + (w.ok ? "" : w.error));
assert(await rejects(c.swap("human", amt), "read-only"), "swap() refuses in read-only mode (no signer in the browser)");
assert(await rejects(c.splitAttack(amt, 2), "read-only"), "splitAttack() refuses in read-only mode (needs evm_snapshot)");

// ---------------- World ID: the adapter talks to the chain's World ID Router
const wid = dep.worldId!;
assert(wid.backend === "worldid" && wid.mock === false && wid.router, `World ID backend = the chain's router ${wid.router} (app ${wid.appId}, action ${wid.action}, ${wid.environment})`);
assert((await c.worldIdExternalNullifier()) === externalNullifierOf(wid.appId, wid.action), "adapter external nullifier == hashToField(hashToField(appId) ‖ action) for the portal app");
assert((await c.worldIdCurrentEpoch()) === 0n && (wid.epochDuration ?? 0) === 0, "action rotation off: IDKit is asked for the static action");
assert((await c.worldIdRootStatus(1n)) === "world-id-router", "root status defers to the real router");
const bogus = await c.verifyWorldIdOnChain(dep.accounts.human, { root: 1n, nullifierHash: 1n, proof: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n] });
assert(bogus.ok === false, "WorldIDAdapter → World ID Router: a bogus proof is rejected without reverting (the router's NonExistentRoot is caught)");
const item = legacyItemFromIdKit({ protocol_version: "3.0", nonce: "n", action: wid.action, responses: [{ identifier: "orb", merkle_root: toHex(7n), nullifier: toHex(9n), proof: encodeAbiParameters([{ type: "uint256[8]" }], [[1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n]]) }] });
const conv = fromIdKitResult(item);
assert(conv.root === 7n && conv.nullifierHash === 9n && conv.proof[7] === 8n, "IDKit 4.x result → legacy orb item → 0x2A payload fields");
const health = await c.proverHealth();
console.log(health ? `info  local prover: artifacts ${health.artifacts}, World ID RP ${health.worldId?.configured ? "configured (" + health.worldId.rp_id + ")" : "not configured"}` : "info  local prover not running (ZK Aadhaar tab and IDKit request signing need it)");
console.log("smoke:public: all good");
process.exit(0);
