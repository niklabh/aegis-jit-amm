// SPDX-License-Identifier: MIT
// Epoch-rotating nullifiers (CROPS unlinkability) + trusted-forwarder (aggregator) support.
import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { existsSync } from "fs";
import * as path from "path";

import {
  AegisEnv, deployAegis, encodeRealProofTakerArgs, generateRealProof, MUMBAI_HUMAN_REVEAL, USDC,
} from "./utils/aegisFixture";
import { TakerTraitsLib } from "./utils/SwapVMHelpers";

const { ethers } = require("hardhat");

const EPOCH = 3_600; // 1 h epochs; proof freshness stays 24 h, so failures below are due to the seed alone
const epochFixture = () => deployAegis({ zkBackend: "anonAadhaar", epochDuration: EPOCH, salt: 30n });
const realEpochFixture = () => deployAegis({ zkBackend: "groth16", epochDuration: EPOCH, salt: 31n });

/** In Anon Aadhaar the nullifier is Poseidon(nullifierSeed, photo); the mock backend models it as a hash */
const mockNullifier = (seed: bigint) => BigInt(ethers.solidityPackedKeccak256(["uint256", "string"], [seed, "same-person-photo"])) >> 8n;

async function nextEpoch() {
  const now = BigInt(await time.latest());
  await time.increaseTo((now / BigInt(EPOCH) + 1n) * BigInt(EPOCH) + 5n);
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

async function forwardSwap(env: AegisEnv, signer: any, amount: bigint, data: string, forwarder = env.contracts.forwarder) {
  await env.contracts.usdc.connect(signer).approve(await forwarder.getAddress(), amount);
  const tx = await forwarder.connect(signer).swapExactIn(env.order, env.addr.usdc, amount, data);
  const rc = await tx.wait();
  const ev = rc!.logs.map((l: any) => { try { return env.contracts.router.interface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Swapped");
  return { tx, amountOut: ev!.args.amountOut as bigint };
}

describe("Epoch-rotating nullifiers & trusted forwarders", function () {
  describe("epoch rotation (mock Groth16 backend)", function () {
    it("nullifierSeed = keccak(APP_SEED, epoch) mod p, and changes every epoch", async function () {
      const env = await loadFixture(epochFixture);
      const { adapter } = env.contracts;
      const e = await adapter.currentEpoch();
      expect(e).to.equal(BigInt(await time.latest()) / BigInt(EPOCH));
      const s1 = await adapter.currentNullifierSeed();
      expect(s1).to.equal(await adapter.nullifierSeedFor(e));
      expect(s1).to.be.lt(await adapter.SNARK_FIELD());
      await nextEpoch();
      expect(await adapter.currentNullifierSeed()).to.not.equal(s1);
      expect(await adapter.currentNullifierSeed()).to.equal(await adapter.nullifierSeedFor(e + 1n));
    });

    it("a proof is only valid in the epoch whose seed it commits to", async function () {
      const env = await loadFixture(epochFixture);
      const { human, bot } = env.accounts;
      const h = await human.getAddress();
      const seed = await env.contracts.adapter.currentNullifierSeed();
      const zk = await env.zkArgs(h, MUMBAI_HUMAN_REVEAL, mockNullifier(seed));
      const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
      expect((await env.quote(human, USDC(5_000), usdcIn(env, zk))).amountOut).to.be.gt(botQ.amountOut);

      await nextEpoch(); // still fresh (< 24 h), but the seed rotated
      const botQ2 = await env.quote(bot, USDC(5_000), usdcIn(env));
      expect((await env.quote(human, USDC(5_000), usdcIn(env, zk))).amountOut).to.equal(botQ2.amountOut);
    });

    it("one address per human per epoch; a fresh, unlinkable wallet next epoch", async function () {
      const env = await loadFixture(epochFixture);
      const { human, whale: altWallet, bot } = env.accounts;
      const h = await human.getAddress(), alt = await altWallet.getAddress();
      const { router, adapter } = env.contracts;

      // epoch 1: human binds its epoch nullifier
      const seed1 = await adapter.currentNullifierSeed();
      const n1 = mockNullifier(seed1);
      await env.swap(human, USDC(5_000), usdcIn(env, await env.zkArgs(h, MUMBAI_HUMAN_REVEAL, n1)));
      expect(await router.nullifierTaker(env.addr.adapter, n1)).to.equal(h);

      // same person, second wallet, same epoch -> priced as a bot (Sybil blocked)
      const altZk1 = await env.zkArgs(alt, MUMBAI_HUMAN_REVEAL, n1);
      expect((await env.quote(altWallet, USDC(5_000), usdcIn(env, altZk1))).amountOut)
        .to.equal((await env.quote(bot, USDC(5_000), usdcIn(env))).amountOut);

      // epoch 2: new seed -> new nullifier -> the fresh wallet binds; nothing on-chain links n1 and n2
      await nextEpoch();
      const n2 = mockNullifier(await adapter.currentNullifierSeed());
      expect(n2).to.not.equal(n1);
      const s = await env.swap(altWallet, USDC(5_000), usdcIn(env, await env.zkArgs(alt, MUMBAI_HUMAN_REVEAL, n2)));
      await expect(s.tx).to.emit(router, "NullifierBound").withArgs(env.addr.adapter, n2, alt, anyValue);
      expect(await router.nullifierTaker(env.addr.adapter, n1)).to.equal(h); // old binding untouched
    });
  });

  describe("trusted forwarder / aggregator (AegisZKForwarder)", function () {
    it("a verified human swapping through the forwarder keeps the discount; the nullifier binds to the human, not the forwarder", async function () {
      const env = await loadFixture(epochFixture);
      const { human, bot } = env.accounts;
      const h = await human.getAddress();
      const n = mockNullifier(await env.contracts.adapter.currentNullifierSeed());
      const zk = await env.zkArgs(h, MUMBAI_HUMAN_REVEAL, n, { recipient: h });
      const data = forwardedData(env, h, zk);

      const viaForwarder = await quoteAs(env, env.addr.forwarder, USDC(5_000), data);
      const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
      expect(viaForwarder).to.be.gt(botQ.amountOut);

      const wethBefore = await env.contracts.weth.balanceOf(h);
      const s = await forwardSwap(env, human, USDC(5_000), data);
      expect(s.amountOut).to.equal(viaForwarder);
      expect(await env.contracts.weth.balanceOf(h) - wethBefore).to.equal(s.amountOut); // output delivered to the human
      await expect(s.tx).to.emit(env.contracts.router, "NullifierBound").withArgs(env.addr.adapter, n, h, anyValue);
    });

    it("a searcher replaying the human's forwarder calldata is rejected by the forwarder (recipient != msg.sender)", async function () {
      const env = await loadFixture(epochFixture);
      const { human, bot } = env.accounts;
      const h = await human.getAddress();
      const zk = await env.zkArgs(h, MUMBAI_HUMAN_REVEAL, 7n, { recipient: h });
      const data = forwardedData(env, h, zk);
      await env.contracts.usdc.connect(bot).approve(env.addr.forwarder, USDC(5_000));
      await expect(env.contracts.forwarder.connect(bot).swapExactIn(env.order, env.addr.usdc, USDC(5_000), data))
        .to.be.revertedWithCustomError(env.contracts.forwarder, "ForwarderRecipientMismatch");
    });

    it("the forwarder refuses to route the output anywhere but the caller", async function () {
      const env = await loadFixture(epochFixture);
      const { human, bot } = env.accounts;
      const h = await human.getAddress();
      const zk = await env.zkArgs(h, MUMBAI_HUMAN_REVEAL, 8n, { recipient: h });
      const toBot = forwardedData(env, await bot.getAddress(), zk);
      await env.contracts.usdc.connect(human).approve(env.addr.forwarder, USDC(5_000));
      await expect(env.contracts.forwarder.connect(human).swapExactIn(env.order, env.addr.usdc, USDC(5_000), toBot))
        .to.be.revertedWithCustomError(env.contracts.forwarder, "ForwarderOutputNotToCaller");
    });

    it("recipient envelopes only work from adapter-whitelisted forwarders (untrusted relayer or direct call => bot tier)", async function () {
      const env = await loadFixture(epochFixture);
      const { human, bot } = env.accounts;
      const h = await human.getAddress();
      const zk = await env.zkArgs(h, MUMBAI_HUMAN_REVEAL, 9n, { recipient: h });
      const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));

      // a second, non-whitelisted forwarder
      const rogue = await (await ethers.getContractFactory("AegisZKForwarder")).deploy(env.addr.router);
      const rogueData = TakerTraitsLib.build({
        taker: await rogue.getAddress(), to: h, isExactIn: true,
        isAToB: env.addr.usdc.toLowerCase() === env.tokenA.toLowerCase(), useTransferFromAndAquaPush: true, instructionsArgs: zk,
      });
      const viaRogue = await forwardSwap(env, human, USDC(5_000), rogueData, rogue);
      expect(viaRogue.amountOut).to.be.lte(botQ.amountOut);

      // bot calling the router directly with an envelope naming the human
      expect((await env.quote(bot, USDC(5_000), usdcIn(env, zk))).amountOut).to.equal((await env.quote(bot, USDC(5_000), usdcIn(env))).amountOut);
    });

    it("Sybil through the forwarder: the same nullifier for a second wallet is priced as a bot", async function () {
      const env = await loadFixture(epochFixture);
      const { human, whale: alt, bot } = env.accounts;
      const h = await human.getAddress(), a = await alt.getAddress();
      const n = mockNullifier(await env.contracts.adapter.currentNullifierSeed());
      await forwardSwap(env, human, USDC(5_000), forwardedData(env, h, await env.zkArgs(h, MUMBAI_HUMAN_REVEAL, n, { recipient: h })));
      const altData = forwardedData(env, a, await env.zkArgs(a, MUMBAI_HUMAN_REVEAL, n, { recipient: a }));
      const altQ = await quoteAs(env, env.addr.forwarder, USDC(5_000), altData);
      expect(altQ).to.equal((await env.quote(bot, USDC(5_000), usdcIn(env))).amountOut);
    });
  });

  describe("real Groth16: the circuit's Poseidon nullifier rotates with the epoch seed", function () {
    this.timeout(10 * 60_000);
    before(function () {
      if (!existsSync(path.join(__dirname, "..", ".cache", "anon-aadhaar", "v2.0.0", "circuit_final.zkey"))) this.skip();
    });

    it("same Aadhaar QR, two epochs -> two unlinkable nullifiers; each proof only valid in its own epoch", async function () {
      const env = await loadFixture(realEpochFixture);
      const { human, bot } = env.accounts;
      const h = await human.getAddress();
      const { adapter } = env.contracts;

      const ts1 = await time.latest();
      const p1 = await generateRealProof({ timestamp: ts1, seed: await adapter.currentNullifierSeed(), signal: h });
      const zk1 = encodeRealProofTakerArgs(p1);
      const s1 = await env.swap(human, USDC(5_000), usdcIn(env, zk1));
      await expect(s1.tx).to.emit(env.contracts.router, "NullifierBound").withArgs(env.addr.adapter, BigInt(p1.proof.publicSignals.nullifier), h, anyValue);

      await nextEpoch();
      const p2 = await generateRealProof({ timestamp: await time.latest(), seed: await adapter.currentNullifierSeed(), signal: h });
      expect(p2.proof.publicSignals.nullifier).to.not.equal(p1.proof.publicSignals.nullifier); // same person, unlinkable
      expect(p2.qr.signedDataSha256).to.not.equal(undefined);

      // the epoch-1 proof is now rejected; the epoch-2 proof is accepted
      const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
      expect((await env.quote(human, USDC(5_000), usdcIn(env, zk1))).amountOut).to.equal(botQ.amountOut);
      expect((await env.quote(human, USDC(5_000), usdcIn(env, encodeRealProofTakerArgs(p2)))).amountOut).to.be.gt(botQ.amountOut);
    });

    it("a real proof routed through the trusted forwarder (recipient envelope) gets the human tier", async function () {
      const env = await loadFixture(realEpochFixture);
      const { human, bot } = env.accounts;
      const h = await human.getAddress();
      const p = await generateRealProof({ timestamp: await time.latest(), seed: await env.contracts.adapter.currentNullifierSeed(), signal: h });
      const data = forwardedData(env, h, encodeRealProofTakerArgs(p, false, h));
      const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
      const s = await forwardSwap(env, human, USDC(5_000), data);
      expect(s.amountOut).to.be.gt(botQ.amountOut);
      await expect(s.tx).to.emit(env.contracts.router, "NullifierBound").withArgs(env.addr.adapter, BigInt(p.proof.publicSignals.nullifier), h, anyValue);
    });
  });
});
