// SPDX-License-Identifier: MIT
// End-to-end with REAL World ID-style proofs:
//   Semaphore v3 identity in a local depth-30 tree (the role of World ID's signup sequencer)
//   -> snarkjs Groth16 over the public PSE depth-30 artifacts -> 0x2A type-1 payload
//   -> AegisSwapVMRouter.swap() -> WorldIDAdapter -> IWorldID.verifyProof -> MockWorldIDRouter
//   (group 1, root history) -> World ID's vendored SemaphoreVerifier -> ecPairing (0x08)
// Requires the artifacts: node packages/world-id/prover/fetch-artifacts.mjs (~5.7 MB)
import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";

import {
  AegisEnv, deployAegis, encodeWorldIdProofTakerArgs, generateWorldIdProof, USDC, WORLD_ID_MEMBERS,
  worldIdArtifactsAvailable, worldIdTreeRoot,
} from "./utils/aegisFixture";
import { worldIdExternalNullifier, worldIdSignalHash } from "../src/aegisProgramBuilder";

const { ethers } = require("hardhat");

async function realFixture() {
  const env = await deployAegis({ worldIdBackend: "semaphore", salt: 50n });
  const h = await env.accounts.human.getAddress();
  const ext: bigint = await env.contracts.worldIdAdapter.EXTERNAL_NULLIFIER();
  const proof = await generateWorldIdProof({ identity: "human", signal: h, externalNullifier: ext }); // ~0.5 s
  await (await env.contracts.worldIdRouter.connect(env.accounts.deployer).registerRoot(BigInt(proof.root))).wait();
  return { env, proof, zk: encodeWorldIdProofTakerArgs(proof), ext };
}

/** Did this tx execute a STATICCALL to the BN254 ecPairing precompile (0x08)? */
async function callsEcPairing(txHash: string): Promise<boolean> {
  const trace = await ethers.provider.send("debug_traceTransaction", [txHash, { disableMemory: true, disableStorage: true }]);
  return trace.structLogs.some((l: any) => l.op === "STATICCALL" && BigInt("0x" + l.stack[l.stack.length - 2].replace(/^0x/, "")) === 8n);
}

const ZERO4: [bigint, bigint, bigint, bigint] = [0n, 0n, 0n, 0n];
const usdcIn = (env: AegisEnv, zk?: string) => env.takerData({ tokenIn: env.addr.usdc, zk });

describe("Real Semaphore (BN254) World ID proof -> AegisJIT swap", function () {
  this.timeout(180_000);

  before(function () {
    if (!worldIdArtifactsAvailable()) {
      console.warn("    ⚠ Semaphore depth-30 artifacts not found — run `node packages/world-id/prover/fetch-artifacts.mjs` (≈5.7 MB). Skipping real World ID suite.");
      this.skip();
    }
  });

  it("local tree + hashing: the proof's root is the registered root; signalHash / externalNullifier follow World ID's conventions", async function () {
    const { env, proof } = await loadFixture(realFixture);
    const h = await env.accounts.human.getAddress();
    expect(BigInt(proof.root)).to.equal(await worldIdTreeRoot());
    expect(BigInt(proof.root)).to.equal(await env.contracts.worldIdRouter.latestRoot());
    expect(BigInt(proof.signalHash)).to.equal(worldIdSignalHash(h));
    expect(BigInt(proof.externalNullifierHash)).to.equal(worldIdExternalNullifier(env.cfg.worldIdAppId, env.cfg.worldIdAction));
    expect(proof.memberIndex).to.equal(WORLD_ID_MEMBERS.indexOf("human"));
    expect(proof.proof).to.have.length(8);
    expect(proof.publicSignals.map(BigInt)).to.deep.equal([proof.root, proof.nullifierHash, proof.signalHash, proof.externalNullifierHash].map(BigInt));
    console.log(`      proving time: ${proof.provingMs} ms (Semaphore v3 depth 30, snarkjs)`);
  });

  it("World ID's vendored SemaphoreVerifier accepts the proof and rejects tampered words / other signals", async function () {
    const { env, proof } = await loadFixture(realFixture);
    const v = env.contracts.semaphoreReal;
    expect(env.addr.semaphoreVerifier).to.equal(env.addr.semaphoreReal); // the router is wired to the real verifier
    const words = proof.proof.map(BigInt);
    const input = proof.publicSignals.map(BigInt);
    await v.verifyProof(words, input); // no revert = verified
    console.log(`      SemaphoreVerifier.verifyProof gas (incl. 21k base): ${await v.verifyProof.estimateGas(words, input)}`);
    const tampered = [...words]; tampered[3] ^= 1n;
    await expect(v.verifyProof(tampered, input)).to.be.revertedWithCustomError(v, "ProofInvalid");
    const otherSignal = [...input]; otherSignal[2] = worldIdSignalHash(await env.accounts.bot.getAddress());
    await expect(v.verifyProof(words, otherSignal)).to.be.revertedWithCustomError(v, "ProofInvalid");
  });

  it("adapter + router: true for the bound taker, false for anyone else; unknown root is NonExistentRoot", async function () {
    const { env, proof, ext } = await loadFixture(realFixture);
    const { worldIdAdapter, worldIdRouter } = env.contracts;
    const h = await env.accounts.human.getAddress();
    const b = await env.accounts.bot.getAddress();
    const envelope = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256[8]"], [BigInt(proof.root), proof.proof.map(BigInt)]);
    const ok = await worldIdAdapter.verifyProof(h, BigInt(proof.nullifierHash), ZERO4, envelope);
    expect(ok[0]).to.equal(true);
    expect(ok[1]).to.equal(h);
    expect((await worldIdAdapter.verifyProof(b, BigInt(proof.nullifierHash), ZERO4, envelope))[0]).to.equal(false);
    await expect(worldIdRouter.verifyProof(BigInt(proof.root) + 1n, 1n, BigInt(proof.signalHash), BigInt(proof.nullifierHash), ext, proof.proof.map(BigInt)))
      .to.be.revertedWithCustomError(worldIdRouter, "NonExistentRoot");
  });

  it("swap(): real proof in takerData executes ecPairing (0x08), passes 0x2A and gets the human tier; quote == swap; same tier as an Aadhaar proof", async function () {
    const { env, zk, proof } = await loadFixture(realFixture);
    const { human, bot } = env.accounts;
    const h = await human.getAddress();
    const data = usdcIn(env, zk);
    const amount = USDC(5_000);

    const humanQ = await env.quote(human, amount, data);
    const botQ = await env.quote(bot, amount, usdcIn(env));
    expect(humanQ.amountOut).to.be.gt(botQ.amountOut);
    const aadhaarQ = await env.quote(human, amount, usdcIn(env, await env.zkArgs(h))); // type-2 proof, same taker
    expect(aadhaarQ.amountOut).to.equal(humanQ.amountOut); // identical 0x7A tier

    const s = await env.swap(human, amount, data);
    expect(s.amountOut).to.equal(humanQ.amountOut); // 0 wei divergence
    expect(await callsEcPairing(s.receipt.hash)).to.equal(true);
    await expect(s.tx).to.emit(env.contracts.router, "NullifierBound").withArgs(env.addr.worldIdAdapter, BigInt(proof.nullifierHash), h);
    console.log(`      swap gas with real World ID verification: ${s.receipt.gasUsed}`);
  });

  it("MEV bot replaying the exact takerData (real proof) is priced as unverified; the pairing runs and fails on signalHash", async function () {
    const { env, zk } = await loadFixture(realFixture);
    const { human, bot } = env.accounts;
    const copied = usdcIn(env, zk);
    const amount = USDC(50_000);
    const botQ = await env.quote(bot, amount, usdcIn(env));
    const humanQ = await env.quote(human, amount, copied);
    const hijack = await env.swap(bot, amount, copied);
    expect(hijack.amountOut).to.equal(botQ.amountOut);
    expect(hijack.amountOut).to.be.lt(humanQ.amountOut);
    expect(await callsEcPairing(hijack.receipt.hash)).to.equal(true);
    await expect(hijack.tx).to.not.emit(env.contracts.router, "NullifierBound");
  });

  it("Sybil: the same World ID in a second wallet (fresh real proof) is priced as a bot once the first wallet is bound", async function () {
    const { env, zk, proof, ext } = await loadFixture(realFixture);
    const { human, bot, whale: altWallet } = env.accounts;
    const h = await human.getAddress();
    const alt = await altWallet.getAddress();
    const p2 = await generateWorldIdProof({ identity: "human", signal: alt, externalNullifier: ext });
    expect(p2.nullifierHash).to.equal(proof.nullifierHash); // Poseidon(externalNullifier, identityNullifier): wallet-independent
    expect(p2.root).to.equal(proof.root);
    const zk2 = encodeWorldIdProofTakerArgs(p2);

    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(altWallet, USDC(5_000), usdcIn(env, zk2))).amountOut).to.be.gt(botQ.amountOut); // either wallet, before binding

    await env.swap(human, USDC(5_000), usdcIn(env, zk));
    expect(await env.contracts.router.nullifierTaker(env.addr.worldIdAdapter, BigInt(proof.nullifierHash))).to.equal(h);
    const altQ = await env.quote(altWallet, USDC(5_000), usdcIn(env, zk2));
    const botNow = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect(altQ.amountOut).to.equal(botNow.amountOut);
    expect((await env.quote(human, USDC(5_000), usdcIn(env, zk))).amountOut).to.be.gt(botNow.amountOut);
  });

  it("root lifecycle: the sequencer publishes a new tree root; the old proof stays valid for 1 h, then only proofs for the new root verify", async function () {
    const { env, zk, ext } = await loadFixture(realFixture);
    const { human, bot, deployer } = env.accounts;
    const h = await human.getAddress();
    const { worldIdRouter } = env.contracts;

    // a new identity joins the tree => new root (same human, new merkle path)
    const grown = [...WORLD_ID_MEMBERS, "erin"];
    const p2 = await generateWorldIdProof({ identity: "human", signal: h, externalNullifier: ext, members: grown });
    expect(BigInt(p2.root)).to.equal(await worldIdTreeRoot(grown));
    await worldIdRouter.connect(deployer).registerRoot(BigInt(p2.root));

    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(human, USDC(5_000), usdcIn(env, zk))).amountOut).to.be.gt(botQ.amountOut); // historical root, fresh
    await time.increase(env.cfg.rootHistoryExpiry + 1);
    const botQ2 = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(human, USDC(5_000), usdcIn(env, zk))).amountOut).to.equal(botQ2.amountOut); // ExpiredRoot
    expect((await env.quote(human, USDC(5_000), usdcIn(env, encodeWorldIdProofTakerArgs(p2)))).amountOut).to.be.gt(botQ2.amountOut);
  });

  it("a tampered Groth16 proof never grants the discount (and never reverts the swap in tiered mode)", async function () {
    const { env, proof } = await loadFixture(realFixture);
    const { human, bot } = env.accounts;
    const bad = usdcIn(env, encodeWorldIdProofTakerArgs(proof, { tamper: true }));
    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(human, USDC(5_000), bad)).amountOut).to.equal(botQ.amountOut);
    const s = await env.swap(human, USDC(5_000), bad);
    expect(s.amountOut).to.equal(botQ.amountOut);
  });
});
