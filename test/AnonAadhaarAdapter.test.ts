// SPDX-License-Identifier: MIT
import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";

import { AEGIS_NULLIFIER_SEED, AegisEnv, deployAegis, MUMBAI_HUMAN_REVEAL, RevealArray, USDC } from "./utils/aegisFixture";

const { ethers } = require("hardhat");

const aadhaarFixture = () => deployAegis({ zkBackend: "anonAadhaar", salt: 10n });
const aadhaarStateFixture = () => deployAegis({ zkBackend: "anonAadhaar", adapterRequiredState: 27n, salt: 11n });

/** Unpack the 0x2A taker payload [L][0x02][nullifier][revealArray][proof] back into the adapter's verifyProof arguments */
function decodeZk(zk: string): { nullifier: bigint; reveal: RevealArray; proof: string } {
  const b = ethers.getBytes(zk);
  if (b[2] !== 0x02) throw new Error(`expected a ZK Aadhaar (type 2) payload, got type ${b[2]}`);
  const word = (i: number) => BigInt(ethers.hexlify(b.slice(3 + 32 * i, 3 + 32 * (i + 1))));
  return {
    nullifier: word(0),
    reveal: [word(1), word(2), word(3), word(4)],
    proof: ethers.hexlify(b.slice(3 + 160)),
  };
}

const usdcIn = (env: AegisEnv, zk?: string) => env.takerData({ tokenIn: env.addr.usdc, zk });

describe("AnonAadhaarAdapter (IZKVerifier over Anon Aadhaar Groth16)", function () {
  it("is wired as the order's 0x2A verifier", async function () {
    const env = await loadFixture(aadhaarFixture);
    expect(env.params.aadhaarVerifier).to.equal(env.addr.adapter); // 0x2A type-2 slot
    expect(await env.contracts.adapter.ANON_AADHAAR()).to.equal(env.addr.anonAadhaar);
    expect(await env.contracts.adapter.APP_SEED()).to.equal(AEGIS_NULLIFIER_SEED);
    expect(await env.contracts.adapter.currentNullifierSeed()).to.equal(AEGIS_NULLIFIER_SEED); // epochs disabled in this fixture
  });

  it("a valid proof bound to the taker passes and triggers the 0x2A -> 0x7A human discount", async function () {
    const env = await loadFixture(aadhaarFixture);
    const { human, bot } = env.accounts;
    const hAddr = await human.getAddress();
    const zk = await env.zkArgs(hAddr);

    const { nullifier, reveal, proof } = decodeZk(zk);
    expect((await env.contracts.adapter.verifyProof(hAddr, nullifier, reveal, proof))[0]).to.equal(true);

    const humanQ = await env.quote(human, USDC(5_000), usdcIn(env, zk));
    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect(humanQ.amountOut).to.be.gt(botQ.amountOut);

    const s = await env.swap(human, USDC(5_000), usdcIn(env, zk));
    expect(s.amountOut).to.equal(humanQ.amountOut);
    await expect(s.tx).to.emit(env.contracts.router, "NullifierBound").withArgs(env.addr.adapter, nullifier, hAddr, anyValue);
  });

  it("MEV frontrun: a bot replaying the exact takerData bytes fails the signal check and pays the full surge fee", async function () {
    const env = await loadFixture(aadhaarFixture);
    const { human, bot } = env.accounts;
    const hAddr = await human.getAddress();
    const zk = await env.zkArgs(hAddr);
    const copied = usdcIn(env, zk); // byte-for-byte what the human broadcast

    const { nullifier, reveal, proof } = decodeZk(zk);
    expect((await env.contracts.adapter.verifyProof(await bot.getAddress(), nullifier, reveal, proof))[0]).to.equal(false);

    const amount = USDC(50_000); // large enough to hit the surge band
    const unverified = await env.quote(bot, amount, usdcIn(env));
    const humanQ = await env.quote(human, amount, copied);
    const hijack = await env.swap(bot, amount, copied);
    expect(hijack.amountOut).to.equal(unverified.amountOut);
    expect(hijack.amountOut).to.be.lt(humanQ.amountOut);
    await expect(hijack.tx).to.not.emit(env.contracts.router, "NullifierBound");
  });

  it("expired proofs (older than maxProofAge) fail; fresh ones pass", async function () {
    const env = await loadFixture(aadhaarFixture);
    const { human, bot } = env.accounts;
    const hAddr = await human.getAddress();
    const now = BigInt(await time.latest());
    const stale = await env.zkArgs(hAddr, MUMBAI_HUMAN_REVEAL, 0xa11ce5n, { timestamp: now - BigInt(env.cfg.maxProofAge) - 10n });
    const fresh = await env.zkArgs(hAddr, MUMBAI_HUMAN_REVEAL, 0xa11ce5n, { timestamp: now - 3_600n });

    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(human, USDC(5_000), usdcIn(env, stale))).amountOut).to.equal(botQ.amountOut);
    expect((await env.quote(human, USDC(5_000), usdcIn(env, fresh))).amountOut).to.be.gt(botQ.amountOut);

    // the same fresh proof ages out
    await time.increase(env.cfg.maxProofAge);
    expect((await env.quote(human, USDC(5_000), usdcIn(env, fresh))).amountOut).to.equal(
      (await env.quote(bot, USDC(5_000), usdcIn(env))).amountOut,
    );
  });

  it("rejects future timestamps, under-18 reveals, wrong nullifier seed and malformed proof bytes (without reverting)", async function () {
    const env = await loadFixture(aadhaarFixture);
    const { adapter, anonAadhaar } = env.contracts;
    const hAddr = await env.accounts.human.getAddress();
    const now = BigInt(await time.latest());

    const future = decodeZk(await env.zkArgs(hAddr, MUMBAI_HUMAN_REVEAL, 1n, { timestamp: now + 3_600n }));
    expect((await adapter.verifyProof(hAddr, future.nullifier, future.reveal, future.proof))[0]).to.equal(false);

    const minor: RevealArray = [0n, 0n, 0n, 27n];
    const kid = decodeZk(await env.zkArgs(hAddr, minor, 2n));
    expect((await adapter.verifyProof(hAddr, kid.nullifier, kid.reveal, kid.proof))[0]).to.equal(false);

    // a proof generated for another app's nullifier seed does not verify here
    const ts = BigInt(await time.latest());
    const words = Array.from({ length: 8 }, (_, i) => BigInt(i + 1));
    await anonAadhaar.registerProof(AEGIS_NULLIFIER_SEED + 1n, 3n, ts, BigInt(hAddr), MUMBAI_HUMAN_REVEAL, words);
    const otherApp = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256[8]"], [ts, words]);
    expect((await adapter.verifyProof(hAddr, 3n, MUMBAI_HUMAN_REVEAL, otherApp))[0]).to.equal(false);

    expect((await adapter.verifyProof(hAddr, 1n, MUMBAI_HUMAN_REVEAL, "0x1234"))[0]).to.equal(false);
  });

  it("adapter-level jurisdiction policy (requiredState on revealArray[3])", async function () {
    const env = await loadFixture(aadhaarStateFixture);
    const hAddr = await env.accounts.human.getAddress();
    const ok = decodeZk(await env.zkArgs(hAddr, [1n, 0n, 0n, 27n], 5n));
    const ko = decodeZk(await env.zkArgs(hAddr, [1n, 0n, 0n, 29n], 6n));
    expect((await env.contracts.adapter.verifyProof(hAddr, ok.nullifier, ok.reveal, ok.proof))[0]).to.equal(true);
    expect((await env.contracts.adapter.verifyProof(hAddr, ko.nullifier, ko.reveal, ko.proof))[0]).to.equal(false);
  });

  it("nullifier binding: one Aadhaar identity cannot farm the discount across several addresses", async function () {
    const env = await loadFixture(aadhaarFixture);
    const { human, bot, whale } = env.accounts;
    const hAddr = await human.getAddress();
    const altAddr = await whale.getAddress(); // same human, second wallet
    const nullifier = 0xbeefn;

    const zkMain = await env.zkArgs(hAddr, MUMBAI_HUMAN_REVEAL, nullifier);
    const zkAlt = await env.zkArgs(altAddr, MUMBAI_HUMAN_REVEAL, nullifier); // valid Groth16 for the alt address

    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    // Before first use, either address could claim it
    expect((await env.quote(whale, USDC(5_000), usdcIn(env, zkAlt))).amountOut).to.be.gt(botQ.amountOut);

    await env.swap(human, USDC(5_000), usdcIn(env, zkMain));
    expect(await env.contracts.router.nullifierTaker(env.addr.adapter, nullifier)).to.equal(hAddr);

    // Now (same state for all three quotes) the alt wallet is priced exactly as a bot,
    // while the original wallet keeps its discount
    const altQ = await env.quote(whale, USDC(5_000), usdcIn(env, zkAlt));
    const botNow = await env.quote(bot, USDC(5_000), usdcIn(env));
    const humanNow = await env.quote(human, USDC(5_000), usdcIn(env, zkMain));
    expect(altQ.amountOut).to.equal(botNow.amountOut);
    expect(humanNow.amountOut).to.be.gt(botNow.amountOut);

    const alt = await env.swap(whale, USDC(5_000), usdcIn(env, zkAlt));
    expect(alt.amountOut).to.equal(altQ.amountOut);
    expect(await env.contracts.router.nullifierTaker(env.addr.adapter, nullifier)).to.equal(hAddr);
  });

  it("quote under a real STATICCALL still works with the Groth16 adapter (binding is read-only in quote)", async function () {
    const env = await loadFixture(aadhaarFixture);
    const quoterAddr = await env.contracts.quoter.getAddress();
    const zk = await env.zkArgs(quoterAddr);
    const [, out] = await env.contracts.quoter.quote(env.addr.router, env.order, USDC(5_000), usdcIn(env, zk));
    const bot = await env.quote(env.accounts.bot, USDC(5_000), usdcIn(env));
    expect(out).to.be.gt(bot.amountOut);
    expect(await env.contracts.router.nullifierTaker(env.addr.adapter, 0xa11ce5n)).to.equal(ethers.ZeroAddress);
  });
});
