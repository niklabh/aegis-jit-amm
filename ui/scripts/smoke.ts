// SPDX-License-Identifier: MIT
// Exercises the dashboard's client library against a running, seeded node — both ZK Pass tabs:
//   🌍 World ID: local Semaphore identity → Groth16 (same code path the browser runs, snarkjs in Node) → adapter → swap()
//   🇮🇳 ZK Aadhaar: QR → client-side parse/RSA → Groth16 via the local prover → adapter → swap()
import { existsSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { encodeAbiParameters, toHex } from "viem";
import { createAegisClient, disassemble, feeModel, splitOrder, type Deployment } from "../src/lib/aegis";
import { encodeWorldIdPayload, fromIdKitResult, proveWorldId, treeRoot } from "../src/lib/worldid";
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
const zkFrame = frames.find((f) => f.opcode === 0x2a)!;
assert(zkFrame.hex.length === 2 + 2 * (2 + 46) && zkFrame.fields.some(([k, v]) => k === "verifierTypes" && v.startsWith("3")), "0x2A frame: 46-byte args, verifierTypes = 3 (World ID or ZK Aadhaar)");
assert(zkFrame.fields.some(([k, v]) => k === "worldIdVerifier" && v.toLowerCase() === dep.addr.worldIdAdapter!.toLowerCase()), "0x2A frame names the WorldIDAdapter as the type-1 verifier");

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
// ---------------- 🌍 World ID tab: local identity -> Semaphore Groth16 -> adapter -> swap() ----------------
const wid = dep.worldId!;
assert(wid && dep.addr.worldIdAdapter && dep.takerData.worldIdHuman, "deployment carries the World ID config, adapter and a seeded World ID takerData");
const art = { wasm: fileURLToPath(new URL("../../.cache/semaphore/30/semaphore.wasm", import.meta.url)), zkey: fileURLToPath(new URL("../../.cache/semaphore/30/semaphore.zkey", import.meta.url)) };
assert(existsSync(art.zkey), "Semaphore depth-30 artifacts present (node packages/world-id/prover/fetch-artifacts.mjs)");
assert(treeRoot(wid.identityPrefix, wid.members) === BigInt(wid.root) && (await c.worldIdLatestRoot()) === BigInt(wid.root), "dashboard rebuilds the local World ID tree: root == MockWorldIDRouter.latestRoot");
assert((await c.worldIdExternalNullifier()) === BigInt(wid.externalNullifier), "adapter external nullifier == seeded hashToField(appId ‖ action)");
const tw = Date.now();
const wp = await proveWorldId({ prefix: wid.identityPrefix, members: wid.members, identity: "human", signal: dep.accounts.human, externalNullifier: BigInt(wid.externalNullifier), artifacts: art });
assert(wp.root === BigInt(wid.root) && wp.proof.length === 8, `Semaphore Groth16 proof generated by the dashboard code path (${wp.provingMs} ms proving, ${Date.now() - tw} ms total)`);
const wchk = await c.verifyWorldIdOnChain(dep.accounts.human, wp);
assert(wchk.ok && wchk.beneficiary.toLowerCase() === dep.accounts.human.toLowerCase(), "WorldIDAdapter → MockWorldIDRouter → SemaphoreVerifier accepts it for the human");
assert(!(await c.verifyWorldIdOnChain(dep.accounts.bot, wp)).ok, "…and rejects it for the bot (signalHash binding)");
assert(!(await c.verifyWorldIdOnChain(dep.accounts.human, { ...wp, proof: wp.proof.map((x, i) => (i === 7 ? x ^ 1n : x)) })).ok, "…and rejects a tampered proof word");
assert((await c.worldIdRootStatus(wp.root)) === "latest" && (await c.worldIdRootStatus(wp.root + 1n)) === "unknown-or-expired", "root status mirrors the router's requireValidRoot");
const wData = c.worldIdTakerData(encodeWorldIdPayload(wp.root, wp.nullifierHash, wp.proof));
assert(wData.toLowerCase() === dep.takerData.worldIdHuman!.slice(0, 46).toLowerCase() + wData.slice(46).toLowerCase() && wData.length === dep.takerData.worldIdHuman!.length, "takerTraits header rebuilt client-side == seeded header (type-1 payload length)");
const wq = await c.quote("human", amt, wData), bq3 = await c.quote("bot", amt);
assert(wq.ok && bq3.ok && wq.amountOut > bq3.amountOut, "human tier with the World ID proof > bot tier");
const seededW = await c.quote("human", amt, dep.takerData.worldIdHuman!);
assert(wq.ok && seededW.ok && seededW.amountOut === wq.amountOut, "seeded worldIdHuman takerData lands on the same tier");
const wIdKit = fromIdKitResult({ merkle_root: toHex(wp.root), nullifier: toHex(wp.nullifierHash), proof: encodeAbiParameters([{ type: "uint256[8]" }], [wp.proof as any]) });
assert(wIdKit.root === wp.root && wIdKit.nullifierHash === wp.nullifierHash && wIdKit.proof.every((x, i) => x === wp.proof[i]), "IDKit result → 0x2A payload converter round-trips");

// ---------------- 🇮🇳 ZK Aadhaar tab: QR -> client-side parse/RSA -> Groth16 -> swap() ----------------
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
const wq2 = await c.quote("human", amt, wData);
assert(hq.ok && wq2.ok && wq2.amountOut === hq.amountOut, "same state, same trade: World ID pass and ZK Aadhaar pass quote the identical 0x7A tier");
const rs = await c.swap("human", amt, realData);
assert(!rs.reverted && rs.quote.ok && rs.amountOut === rs.quote.amountOut, `swap() with real Aadhaar proof: 0 wei divergence, tx ${rs.hash}`);
const copied = await c.quote("bot", amt, realData), bq2 = await c.quote("bot", amt);
assert(copied.ok && bq2.ok && copied.amountOut === bq2.amountOut, "bot replaying the real-proof takerData is priced as a bot");
const ws = await c.swap("human", amt, wData);
assert(!ws.reverted && ws.quote.ok && ws.amountOut === ws.quote.amountOut, `swap() with the World ID proof: 0 wei divergence, tx ${ws.hash}`);
const copiedW = await c.quote("bot", amt, wData), bq4 = await c.quote("bot", amt);
assert(copiedW.ok && bq4.ok && copiedW.amountOut === bq4.amountOut, "bot replaying the World ID takerData is priced as a bot");

console.log("smoke: all good");
process.exit(0); // snarkjs keeps worker threads alive after proving; exit explicitly
