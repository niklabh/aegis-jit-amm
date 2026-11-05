// SPDX-License-Identifier: MIT
// Exercises the dashboard's client library against a running, seeded node.
import { readFileSync } from "fs";
import { createAegisClient, disassemble, feeModel, splitOrder, type Deployment } from "../src/lib/aegis";
import type { VerificationKey } from "../../packages/zk-aadhaar/src/lib/aadhaar/verify";

// zkAadhaar (the same modules the dashboard bundles) is a CommonJS-typed package: load with interop
const zk = async (m: string) => { const x: any = await import(`../../packages/zk-aadhaar/src/lib/aadhaar/${m}.ts`); return x.default ?? x; };
const { extractCompressedPayload } = await zk("payload");
const { parseSecureQr } = await zk("parse");
const { verifySecureQrSignature } = await zk("verify");
const { parsePublicKeys } = await zk("x509");
const { toBytes } = await zk("bytes");

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
// ---------------- Aadhaar QR -> client-side parse/RSA -> Groth16 -> swap() ----------------
const health = await c.proverHealth();
assert(health?.ok && health.artifacts, "local prover reachable with Anon Aadhaar artifacts (start: npm --prefix packages/zk-aadhaar run prover:serve)");
const qr = await c.testQr();
const parsedQr = parseSecureQr(extractCompressedPayload({ text: qr.digits }));
const testKeys: VerificationKey[] = parsePublicKeys(readFileSync(new URL("../../packages/zk-aadhaar/prover/test-signer/aegis-test-signer.cert.pem", import.meta.url), "utf8"))
  .map((k: any) => ({ id: "test", label: "AegisJIT TEST signer", trust: "custom", spki: toBytes(k.spki) }));
const rsa = await verifySecureQrSignature(parsedQr.signedData, parsedQr.signature, testKeys);
assert(parsedQr.data.version === "V2" && rsa.status === "untrusted-key", `QR decompressed + RSA-2048 verified (${parsedQr.data.state}, DOB ${parsedQr.data.dob})`);

const t0 = Date.now();
const real = await c.prove(qr.digits, dep.accounts.human);
assert(real.proof.publicSignals.ageAbove18 === "1" && real.proof.stateText === "Maharashtra", `real Groth16 proof (${real.proof.provingMs} ms proving, ${Date.now() - t0} ms round trip)`);
const chainCheck = await c.verifyOnChain(dep.accounts.human, real);
assert(chainCheck.ok && chainCheck.beneficiary.toLowerCase() === dep.accounts.human.toLowerCase(), "adapter.verifyProof (BN254 ecPairing) accepts it for the human");
assert(!(await c.verifyOnChain(dep.accounts.bot, real)).ok, "…and rejects it for the bot (signal binding)");

const realData = c.realProofTakerData(real);
const hq = await c.quote("human", amt, realData), bq = await c.quote("bot", amt);
assert(hq.ok && bq.ok && hq.amountOut > bq.amountOut, "human tier with the fresh real proof > bot tier");
const rs = await c.swap("human", amt, realData);
assert(!rs.reverted && rs.quote.ok && rs.amountOut === rs.quote.amountOut, `swap() with real proof: 0 wei divergence, tx ${rs.hash}`);
const copied = await c.quote("bot", amt, realData), bq2 = await c.quote("bot", amt);
assert(copied.ok && bq2.ok && copied.amountOut === bq2.amountOut, "bot replaying the real-proof takerData is priced as a bot");

console.log("smoke: all good");
