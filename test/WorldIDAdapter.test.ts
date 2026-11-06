// SPDX-License-Identifier: MIT
// WorldIDAdapter: IZKVerifier for 0x2A proof type 1, over MockWorldIDRouter (World ID Router +
// Identity Manager semantics: group routing, root history and expiry) and MockSemaphoreVerifier
// (SNARK-soundness test double: a proof verifies only for the exact public inputs it was proven for).
import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

import { AegisEnv, deployAegis, USDC, WORLD_ID_GROUP, WORLD_ID_INITIAL_ROOT } from "./utils/aegisFixture";
import { TakerTraitsLib } from "./utils/SwapVMHelpers";
import {
  AegisOpcodes, AegisProgramBuilder, ZKMode, ZKVerifierType, encodeZKIdentityGuardArgs, worldIdExternalNullifier, worldIdSignalHash,
} from "../src/aegisProgramBuilder";

const { ethers } = require("hardhat");

// Default order accepts both proof types (verifierTypes = 3); Aadhaar side = AnonAadhaarAdapter over the mock Groth16 verifier
const dualFixture = () => deployAegis({ zkBackend: "anonAadhaar", salt: 40n });
const worldIdOnlyFixture = () => deployAegis({ zkVerifierTypes: ZKVerifierType.WORLD_ID, salt: 41n });
const aadhaarOnlyFixture = () => deployAegis({ zkBackend: "anonAadhaar", zkVerifierTypes: ZKVerifierType.AADHAAR, salt: 42n });
const strictWorldIdFixture = () => deployAegis({ zkVerifierTypes: ZKVerifierType.WORLD_ID, zkMode: ZKMode.STRICT, salt: 43n });

type Reveal4 = [bigint, bigint, bigint, bigint];
const ZERO_REVEAL: Reveal4 = [0n, 0n, 0n, 0n];
const abi = ethers.AbiCoder.defaultAbiCoder();

/** Unpack a type-1 payload [L][0x01][nullifierHash][envelope] back into the adapter's verifyProof arguments */
function decodeWorldId(zk: string): { nullifierHash: bigint; proof: string; root: bigint; words: bigint[] } {
  const b = ethers.getBytes(zk);
  if (b[2] !== ZKVerifierType.WORLD_ID) throw new Error(`expected a World ID (type 1) payload, got type ${b[2]}`);
  const proof = ethers.hexlify(b.slice(3 + 32));
  const [root, words] = abi.decode(["uint256", "uint256[8]"], proof) as [bigint, bigint[]];
  return { nullifierHash: BigInt(ethers.hexlify(b.slice(3, 35))), proof, root, words: [...words] };
}

const usdcIn = (env: AegisEnv, zk?: string) => env.takerData({ tokenIn: env.addr.usdc, zk });

/** takerData for a forwarder call: output `to` the end user */
function forwardedData(env: AegisEnv, user: string, zk: string) {
  return TakerTraitsLib.build({
    taker: env.addr.forwarder, to: user, isExactIn: true,
    isAToB: env.addr.usdc.toLowerCase() === env.tokenA.toLowerCase(),
    useTransferFromAndAquaPush: true, instructionsArgs: zk,
  });
}

/** quote() with msg.sender = `from` (e.g. the forwarder), via a raw eth_call */
async function quoteAs(env: AegisEnv, from: string, amount: bigint, data: string): Promise<bigint> {
  const iface = env.contracts.router.interface;
  const raw = await ethers.provider.call({ to: env.addr.router, from, data: iface.encodeFunctionData("quote", [env.order, amount, data]) });
  return iface.decodeFunctionResult("quote", raw)[1] as bigint;
}

describe("WorldIDAdapter (IZKVerifier over the World ID Router) — 0x2A proof type 1", function () {
  it("is wired as the order's World ID verifier next to the ZK Aadhaar adapter (verifierTypes = 3)", async function () {
    const env = await loadFixture(dualFixture);
    const { worldIdAdapter, worldIdRouter } = env.contracts;
    expect(env.params.worldIdVerifier).to.equal(env.addr.worldIdAdapter);
    expect(env.params.aadhaarVerifier).to.equal(env.addr.adapter);
    expect(await worldIdAdapter.WORLD_ID()).to.equal(env.addr.worldIdRouter);
    expect(await worldIdAdapter.GROUP_ID()).to.equal(WORLD_ID_GROUP);
    expect(await worldIdRouter.GROUP_ID()).to.equal(WORLD_ID_GROUP);
    expect(await worldIdRouter.latestRoot()).to.equal(WORLD_ID_INITIAL_ROOT);
    // external nullifier and signal hashing follow World ID's on-chain template (ByteHasher.hashToField)
    expect(await worldIdAdapter.EXTERNAL_NULLIFIER()).to.equal(worldIdExternalNullifier(env.cfg.worldIdAppId, env.cfg.worldIdAction));
    const h = await env.accounts.human.getAddress();
    expect(await worldIdAdapter.signalHashOf(h)).to.equal(worldIdSignalHash(h));
    expect(await worldIdAdapter.appId()).to.equal(env.cfg.worldIdAppId);
    expect(await worldIdAdapter.action()).to.equal(env.cfg.worldIdAction);

    // 0x2A frame: 46 bytes = verifierTypes(1) mode(1) state(4) worldIdVerifier(20) aadhaarVerifier(20)
    const program = ethers.getBytes(AegisProgramBuilder.buildProgram(env.params));
    let pc = 0;
    while (program[pc] !== AegisOpcodes.ZK_IDENTITY_GUARD) pc += 2 + program[pc + 1];
    expect(program[pc + 1]).to.equal(46);
    const args = program.slice(pc + 2, pc + 48);
    expect(args[0]).to.equal(ZKVerifierType.ANY);
    expect(args[1]).to.equal(ZKMode.TIERED);
    expect(ethers.getAddress(ethers.hexlify(args.slice(6, 26)))).to.equal(env.addr.worldIdAdapter);
    expect(ethers.getAddress(ethers.hexlify(args.slice(26, 46)))).to.equal(env.addr.adapter);
  });

  it("a valid World ID proof bound to the taker passes 0x2A and lands in exactly the same 0x7A human tier as a ZK Aadhaar proof", async function () {
    const env = await loadFixture(dualFixture);
    const { human, bot } = env.accounts;
    const h = await human.getAddress();
    const { router, worldIdAdapter } = env.contracts;

    const zkWorld = await env.worldIdArgs(h);
    const { nullifierHash, proof } = decodeWorldId(zkWorld);
    const direct = await worldIdAdapter.verifyProof(h, nullifierHash, ZERO_REVEAL, proof);
    expect(direct[0]).to.equal(true);
    expect(direct[1]).to.equal(h);

    const amount = USDC(5_000);
    const botQ = await env.quote(bot, amount, usdcIn(env));
    const worldQ = await env.quote(human, amount, usdcIn(env, zkWorld));
    const aadhaarQ = await env.quote(human, amount, usdcIn(env, await env.zkArgs(h)));
    expect(worldQ.amountOut).to.be.gt(botQ.amountOut);
    expect(worldQ.amountOut).to.equal(aadhaarQ.amountOut); // both proof types → verifiedHuman dispatcher → base fee / 2

    const s = await env.swap(human, amount, usdcIn(env, zkWorld));
    expect(s.amountOut).to.equal(worldQ.amountOut); // quote == swap (0 wei)
    await expect(s.tx).to.emit(router, "NullifierBound").withArgs(env.addr.worldIdAdapter, nullifierHash, h, anyValue);
    expect(await router.nullifierTaker(env.addr.worldIdAdapter, nullifierHash)).to.equal(h);
  });

  it("a proof for a root the router has never seen is rejected (NonExistentRoot) → bot tier, never a revert in tiered mode", async function () {
    const env = await loadFixture(dualFixture);
    const { human, bot } = env.accounts;
    const h = await human.getAddress();
    const { worldIdAdapter, worldIdRouter } = env.contracts;

    const bogus = await env.worldIdArgs(h, { root: 0xbad0007n });
    const { nullifierHash, proof, root, words } = decodeWorldId(bogus);
    await expect(worldIdRouter.verifyProof(root, WORLD_ID_GROUP, worldIdSignalHash(h), nullifierHash, await worldIdAdapter.EXTERNAL_NULLIFIER(), words))
      .to.be.revertedWithCustomError(worldIdRouter, "NonExistentRoot");
    expect((await worldIdAdapter.verifyProof(h, nullifierHash, ZERO_REVEAL, proof))[0]).to.equal(false);

    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(human, USDC(5_000), usdcIn(env, bogus))).amountOut).to.equal(botQ.amountOut);
    const s = await env.swap(human, USDC(5_000), usdcIn(env, bogus));
    expect(s.amountOut).to.equal(botQ.amountOut);
    await expect(s.tx).to.not.emit(env.contracts.router, "NullifierBound");
  });

  it("root history: a superseded root stays valid for ROOT_HISTORY_EXPIRY (1 h) and then expires", async function () {
    const env = await loadFixture(dualFixture);
    const { human, bot, deployer } = env.accounts;
    const h = await human.getAddress();
    const { worldIdRouter } = env.contracts;

    const rootA: bigint = await worldIdRouter.latestRoot();
    const proofForA = await env.worldIdArgs(h); // proven against root A
    const rootB = rootA + 1n;
    await expect(worldIdRouter.connect(deployer).registerRoot(rootB)).to.emit(worldIdRouter, "RootRegistered").withArgs(rootB, rootA);
    expect(await worldIdRouter.latestRoot()).to.equal(rootB);

    // A is now historical but fresh: still accepted
    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(human, USDC(5_000), usdcIn(env, proofForA))).amountOut).to.be.gt(botQ.amountOut);

    await time.increase(env.cfg.rootHistoryExpiry + 1);
    await expect(worldIdRouter.requireValidRoot(rootA)).to.be.revertedWithCustomError(worldIdRouter, "ExpiredRoot");
    const botQ2 = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(human, USDC(5_000), usdcIn(env, proofForA))).amountOut).to.equal(botQ2.amountOut);

    // a fresh proof against the latest root B passes
    const proofForB = await env.worldIdArgs(h);
    expect(decodeWorldId(proofForB).root).to.equal(rootB);
    expect((await env.quote(human, USDC(5_000), usdcIn(env, proofForB))).amountOut).to.be.gt(botQ2.amountOut);

    // only the identity operator (sequencer) publishes roots
    await expect(worldIdRouter.connect(bot).registerRoot(rootB + 1n)).to.be.revertedWithCustomError(worldIdRouter, "Unauthorized");
  });

  it("reused nullifier (Sybil): one World ID cannot farm the discount across wallets — the first address binds it", async function () {
    const env = await loadFixture(dualFixture);
    const { human, bot, whale: altWallet } = env.accounts;
    const h = await human.getAddress();
    const alt = await altWallet.getAddress(); // same human, second wallet
    const { router } = env.contracts;

    const zkMain = await env.worldIdArgs(h, { person: "alice" });
    const zkAlt = await env.worldIdArgs(alt, { person: "alice" }); // valid proof for the alt wallet, same nullifierHash
    const nullifierHash = decodeWorldId(zkMain).nullifierHash;
    expect(decodeWorldId(zkAlt).nullifierHash).to.equal(nullifierHash);

    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    // before first use either wallet could claim the discount
    expect((await env.quote(altWallet, USDC(5_000), usdcIn(env, zkAlt))).amountOut).to.be.gt(botQ.amountOut);

    await env.swap(human, USDC(5_000), usdcIn(env, zkMain));
    expect(await router.nullifierTaker(env.addr.worldIdAdapter, nullifierHash)).to.equal(h);

    const altQ = await env.quote(altWallet, USDC(5_000), usdcIn(env, zkAlt));
    const botNow = await env.quote(bot, USDC(5_000), usdcIn(env));
    const humanNow = await env.quote(human, USDC(5_000), usdcIn(env, zkMain));
    expect(altQ.amountOut).to.equal(botNow.amountOut); // priced exactly as a bot
    expect(humanNow.amountOut).to.be.gt(botNow.amountOut); // the bound wallet keeps its discount

    const altSwap = await env.swap(altWallet, USDC(5_000), usdcIn(env, zkAlt));
    expect(altSwap.amountOut).to.equal(altQ.amountOut);
    await expect(altSwap.tx).to.not.emit(router, "NullifierBound");
    expect(await router.nullifierTaker(env.addr.worldIdAdapter, nullifierHash)).to.equal(h);
  });

  it("World ID and ZK Aadhaar nullifiers live in separate namespaces (keyed by verifier)", async function () {
    const env = await loadFixture(dualFixture);
    const { human, whale: other } = env.accounts;
    const h = await human.getAddress(), o = await other.getAddress();
    const { router } = env.contracts;
    const zkWorld = await env.worldIdArgs(h, { person: "p" });
    const n = decodeWorldId(zkWorld).nullifierHash;
    await env.swap(human, USDC(1_000), usdcIn(env, zkWorld));
    // an Aadhaar proof whose nullifier happens to equal the World ID nullifierHash is a different human
    const zkAadhaar = await env.zkArgs(o, undefined, n);
    const s = await env.swap(other, USDC(1_000), usdcIn(env, zkAadhaar));
    await expect(s.tx).to.emit(router, "NullifierBound").withArgs(env.addr.adapter, n, o, anyValue);
    expect(await router.nullifierTaker(env.addr.worldIdAdapter, n)).to.equal(h);
    expect(await router.nullifierTaker(env.addr.adapter, n)).to.equal(o);
  });

  it("signal binding (mempool hijack): a bot replaying the exact takerData fails the signalHash check and pays the full surge fee", async function () {
    const env = await loadFixture(dualFixture);
    const { human, bot } = env.accounts;
    const h = await human.getAddress();
    const zk = await env.worldIdArgs(h);
    const copied = usdcIn(env, zk); // byte-for-byte what the human broadcast
    const { nullifierHash, proof } = decodeWorldId(zk);
    expect((await env.contracts.worldIdAdapter.verifyProof(await bot.getAddress(), nullifierHash, ZERO_REVEAL, proof))[0]).to.equal(false);

    const amount = USDC(50_000); // deep into the surge band
    const unverified = await env.quote(bot, amount, usdcIn(env));
    const humanQ = await env.quote(human, amount, copied);
    const hijack = await env.swap(bot, amount, copied);
    expect(hijack.amountOut).to.equal(unverified.amountOut);
    expect(hijack.amountOut).to.be.lt(humanQ.amountOut);
    await expect(hijack.tx).to.not.emit(env.contracts.router, "NullifierBound");
  });

  it("strict mode (0) with World ID only: unverified takers and replayed proofs revert ZKVerificationFailed, verified ones trade", async function () {
    const env = await loadFixture(strictWorldIdFixture);
    const { human, bot } = env.accounts;
    const h = await human.getAddress();
    const { router } = env.contracts;
    await expect(env.quote(bot, USDC(5_000), usdcIn(env))).to.be.revertedWithCustomError(router, "ZKVerificationFailed");
    const zk = await env.worldIdArgs(h);
    await expect(router.connect(bot).swap(env.order, USDC(5_000), usdcIn(env, zk))).to.be.revertedWithCustomError(router, "ZKVerificationFailed");
    const s = await env.swap(human, USDC(5_000), usdcIn(env, zk));
    expect(s.amountOut).to.be.gt(0n);
  });

  it("tampered proofs, foreign external nullifiers, wrong groups and malformed envelopes never verify and never revert the adapter", async function () {
    const env = await loadFixture(dualFixture);
    const { human, bot, deployer } = env.accounts;
    const h = await human.getAddress();
    const { worldIdAdapter, worldIdRouter, semaphoreMock } = env.contracts;
    const ext: bigint = await worldIdAdapter.EXTERNAL_NULLIFIER();
    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));

    // tampered proof word
    const tampered = await env.worldIdArgs(h, { tamper: true });
    const t = decodeWorldId(tampered);
    await expect(semaphoreMock.verifyProof(t.words, [t.root, t.nullifierHash, worldIdSignalHash(h), ext])).to.be.revertedWithCustomError(semaphoreMock, "ProofInvalid");
    expect((await worldIdAdapter.verifyProof(h, t.nullifierHash, ZERO_REVEAL, t.proof))[0]).to.equal(false);
    expect((await env.quote(human, USDC(5_000), usdcIn(env, tampered))).amountOut).to.equal(botQ.amountOut);

    // a proof for another app / action (different external nullifier) is a different statement
    const good = decodeWorldId(await env.worldIdArgs(h));
    const otherApp = good.words.map((w) => w ^ 0xffn);
    await semaphoreMock.connect(deployer).registerProof(otherApp, [good.root, good.nullifierHash, worldIdSignalHash(h), ext + 1n]);
    const otherAppProof = abi.encode(["uint256", "uint256[8]"], [good.root, otherApp]);
    expect((await worldIdAdapter.verifyProof(h, good.nullifierHash, ZERO_REVEAL, otherAppProof))[0]).to.equal(false);

    // wrong group at the router
    await expect(worldIdRouter.verifyProof(good.root, 2n, worldIdSignalHash(h), good.nullifierHash, ext, good.words))
      .to.be.revertedWithCustomError(worldIdRouter, "NoSuchGroup").withArgs(2n);

    // malformed envelopes
    expect((await worldIdAdapter.verifyProof(h, good.nullifierHash, ZERO_REVEAL, "0x1234"))[0]).to.equal(false);
    expect((await worldIdAdapter.verifyProof(h, good.nullifierHash, ZERO_REVEAL, ethers.randomBytes(288)))[0]).to.equal(false);
    for (const zk of ["0x0001" + "01", "0x002101" + "00".repeat(32)]) {
      expect((await env.quote(human, USDC(5_000), usdcIn(env, zk))).amountOut).to.equal(botQ.amountOut);
    }
  });

  it("Maker policy: verifierTypes selects which proofs count (1 = World ID only, 2 = ZK Aadhaar only, 3 = either)", async function () {
    const onlyWorld = await loadFixture(worldIdOnlyFixture);
    {
      const { human, bot } = onlyWorld.accounts;
      const h = await human.getAddress();
      expect(onlyWorld.params.aadhaarVerifier).to.equal(ethers.ZeroAddress);
      const botQ = await onlyWorld.quote(bot, USDC(5_000), usdcIn(onlyWorld));
      expect((await onlyWorld.quote(human, USDC(5_000), usdcIn(onlyWorld, await onlyWorld.worldIdArgs(h)))).amountOut).to.be.gt(botQ.amountOut);
      expect((await onlyWorld.quote(human, USDC(5_000), usdcIn(onlyWorld, await onlyWorld.zkArgs(h)))).amountOut).to.equal(botQ.amountOut); // Aadhaar proof ignored
    }
    const onlyAadhaar = await loadFixture(aadhaarOnlyFixture);
    {
      const { human, bot } = onlyAadhaar.accounts;
      const h = await human.getAddress();
      expect(onlyAadhaar.params.worldIdVerifier).to.equal(ethers.ZeroAddress);
      const botQ = await onlyAadhaar.quote(bot, USDC(5_000), usdcIn(onlyAadhaar));
      expect((await onlyAadhaar.quote(human, USDC(5_000), usdcIn(onlyAadhaar, await onlyAadhaar.zkArgs(h)))).amountOut).to.be.gt(botQ.amountOut);
      expect((await onlyAadhaar.quote(human, USDC(5_000), usdcIn(onlyAadhaar, await onlyAadhaar.worldIdArgs(h)))).amountOut).to.equal(botQ.amountOut); // World ID proof ignored
    }
    // inconsistent configs are rejected by both builders
    const a = onlyWorld.addr.worldIdAdapter;
    expect(() => encodeZKIdentityGuardArgs({ verifierTypes: 0, mode: 1 })).to.throw();
    expect(() => encodeZKIdentityGuardArgs({ verifierTypes: 4, mode: 1, worldIdVerifier: a })).to.throw();
    expect(() => encodeZKIdentityGuardArgs({ verifierTypes: 1, mode: 1 })).to.throw(); // bit set, verifier missing
    expect(() => encodeZKIdentityGuardArgs({ verifierTypes: 2, mode: 1, worldIdVerifier: a, aadhaarVerifier: a })).to.throw(); // verifier set, bit unset
    const p = onlyWorld.params;
    await expect(onlyWorld.contracts.strategy.buildProgram({
      maker: p.maker, token0: p.token0, token1: p.token1, vault0: p.vault0!, vault1: p.vault1!, jitHook: p.jitHook!, deadline: p.deadline!,
      zkVerifierTypes: ZKVerifierType.ANY, worldIdVerifier: a, aadhaarVerifier: ethers.ZeroAddress, // bit 2 set, no verifier
      zkMode: p.zkMode, requiredStateCode: 0, lambdaBps: p.lambdaBps, virtualBoostBps: p.virtualBoostBps, exposureWindowSec: p.exposureWindowSec!,
      allocation0: p.allocation0, allocation1: p.allocation1, floor01AmountIn: 0, floor01AmountOut: 0, floor10AmountIn: 0, floor10AmountOut: 0,
      baseFeeBps: p.baseFeeBps, maxSurgeFeeBps: p.maxSurgeFeeBps, impactThresholdBps: p.impactThresholdBps, decayWindowSec: p.decayWindowSec, salt: 0,
    })).to.be.revertedWithCustomError(onlyWorld.contracts.strategy, "ZKIdentityGuardVerifierMismatch");
  });

  it("trusted forwarder: a World ID proof with a recipient envelope keeps the discount and binds the nullifier to the human", async function () {
    const env = await loadFixture(dualFixture);
    const { human, bot } = env.accounts;
    const h = await human.getAddress();
    const { forwarder, usdc, weth, router } = env.contracts;
    const zk = await env.worldIdArgs(h, { recipient: h });
    const data = forwardedData(env, h, zk);

    const viaForwarder = await quoteAs(env, env.addr.forwarder, USDC(5_000), data);
    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect(viaForwarder).to.be.gt(botQ.amountOut);

    await usdc.connect(human).approve(env.addr.forwarder, USDC(5_000));
    const wethBefore = await weth.balanceOf(h);
    const tx = await forwarder.connect(human).swapExactIn(env.order, env.addr.usdc, USDC(5_000), data);
    const rc = await tx.wait();
    const ev = rc!.logs.map((l: any) => { try { return router.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Swapped");
    expect(ev!.args.amountOut).to.equal(viaForwarder);
    expect(await weth.balanceOf(h) - wethBefore).to.equal(viaForwarder);
    await expect(tx).to.emit(router, "NullifierBound").withArgs(env.addr.worldIdAdapter, decodeWorldId(zk).nullifierHash, h, anyValue);

    // a searcher replaying the forwarder calldata is rejected by the forwarder; a direct call with the envelope is priced as a bot
    await usdc.connect(bot).approve(env.addr.forwarder, USDC(5_000));
    await expect(forwarder.connect(bot).swapExactIn(env.order, env.addr.usdc, USDC(5_000), data))
      .to.be.revertedWithCustomError(forwarder, "ForwarderRecipientMismatch");
    expect((await env.quote(bot, USDC(5_000), usdcIn(env, zk))).amountOut).to.equal((await env.quote(bot, USDC(5_000), usdcIn(env))).amountOut);
  });

  it("quote() under a real STATICCALL with a World ID payload works and leaves the binding untouched", async function () {
    const env = await loadFixture(dualFixture);
    const quoterAddr = await env.contracts.quoter.getAddress();
    const zk = await env.worldIdArgs(quoterAddr);
    const [, out] = await env.contracts.quoter.quote(env.addr.router, env.order, USDC(5_000), usdcIn(env, zk));
    const botQ = await env.quote(env.accounts.bot, USDC(5_000), usdcIn(env));
    expect(out).to.be.gt(botQ.amountOut);
    expect(await env.contracts.router.nullifierTaker(env.addr.worldIdAdapter, decodeWorldId(zk).nullifierHash)).to.equal(ethers.ZeroAddress);
  });
});
