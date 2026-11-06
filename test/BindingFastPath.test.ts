// SPDX-License-Identifier: MIT
// 0x2A bound-nullifier fast path: after one full proof binds a nullifier to an address, that address
// trades with a 33-byte claim [type][nullifier] and the opcode skips the adapter (and the pairing).
import "@nomicfoundation/hardhat-chai-matchers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";

import { AegisEnv, deployAegis, MAHARASHTRA, MUMBAI_HUMAN_REVEAL, USDC } from "./utils/aegisFixture";
import { ZKMode, ZKVerifierType, encodeZKBindingClaim } from "../src/aegisProgramBuilder";

const { ethers } = require("hardhat");

const EPOCH = 3_600;
const epochFixture = () => deployAegis({ zkBackend: "anonAadhaar", epochDuration: EPOCH, salt: 60n });
const stateGatedFixture = () => deployAegis({ zkBackend: "anonAadhaar", requiredStateCode: MAHARASHTRA, salt: 61n });
const strictFixture = () => deployAegis({ zkBackend: "anonAadhaar", zkMode: ZKMode.STRICT, salt: 62n });
const worldFixture = () => deployAegis({ salt: 63n });

/** In Anon Aadhaar the nullifier is Poseidon(nullifierSeed, photo); the mock backend models it as a hash */
const mockNullifier = (seed: bigint) => BigInt(ethers.solidityPackedKeccak256(["uint256", "string"], [seed, "same-person-photo"])) >> 8n;
const usdcIn = (env: AegisEnv, zk?: string) => env.takerData({ tokenIn: env.addr.usdc, zk });
const aadhaarClaim = (n: bigint) => encodeZKBindingClaim(ZKVerifierType.AADHAAR, n);
const worldClaim = (n: bigint) => encodeZKBindingClaim(ZKVerifierType.WORLD_ID, n);
const UINT40_MAX = (1n << 40n) - 1n;

async function epochEnd(env: AegisEnv): Promise<bigint> {
  const e: bigint = await env.contracts.adapter.currentEpoch();
  return (e + 1n) * BigInt(EPOCH) - 1n;
}

describe("0x2A bound-nullifier fast path (binding claims)", function () {
  it("a claim for a nullifier nobody has bound is priced as a bot", async function () {
    const env = await loadFixture(epochFixture);
    const { human, bot } = env.accounts;
    const n = mockNullifier(await env.contracts.adapter.currentNullifierSeed());
    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(human, USDC(5_000), usdcIn(env, aadhaarClaim(n)))).amountOut).to.equal(botQ.amountOut);
    expect(await env.contracts.router.nullifierTaker(env.addr.adapter, n)).to.equal(ethers.ZeroAddress);
  });

  it("after one full proof the bound address trades on a 33-byte claim: human tier, quote == swap, no adapter call", async function () {
    const env = await loadFixture(epochFixture);
    const { human, bot } = env.accounts;
    const h = await human.getAddress();
    const { router, adapter } = env.contracts;
    const n = mockNullifier(await adapter.currentNullifierSeed());

    const full = await env.swap(human, USDC(5_000), usdcIn(env, await env.zkArgs(h, MUMBAI_HUMAN_REVEAL, n)));
    const [bound, validUntil] = await router.nullifierBinding(env.addr.adapter, n);
    expect(bound).to.equal(h);
    expect(validUntil).to.equal(await epochEnd(env)); // epoch end (shorter than the 24 h QR freshness)

    const claimData = usdcIn(env, aadhaarClaim(n));
    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    const q = await env.quote(human, USDC(5_000), claimData);
    expect(q.amountOut).to.be.gt(botQ.amountOut);
    const s = await env.swap(human, USDC(5_000), claimData);
    expect(s.amountOut).to.equal(q.amountOut);
    await expect(s.tx).to.not.emit(router, "NullifierBound"); // nothing to (re)bind

    // the adapter is never called: no STATICCALL to it in the trace
    const trace = await ethers.provider.send("debug_traceTransaction", [s.receipt.hash, { disableMemory: true, disableStorage: true }]);
    const adapterWord = BigInt(env.addr.adapter);
    const calledAdapter = trace.structLogs.some((l: any) => l.op === "STATICCALL" && BigInt("0x" + l.stack[l.stack.length - 2].replace(/^0x/, "")) === adapterWord);
    expect(calledAdapter).to.equal(false);

    // and it is cheap: a few k gas over a proof-less bot swap, far below the full-proof swap
    const botSwap = await env.swap(bot, USDC(5_000), usdcIn(env));
    expect(s.receipt.gasUsed - botSwap.receipt.gasUsed).to.be.lt(12_000n);
    expect(full.receipt.gasUsed).to.be.gt(s.receipt.gasUsed);
    console.log(`      gas: full proof ${full.receipt.gasUsed} · claim ${s.receipt.gasUsed} · no proof ${botSwap.receipt.gasUsed}`);
  });

  it("a claim from any other address, or a claim on a nullifier bound to someone else, is priced as a bot", async function () {
    const env = await loadFixture(epochFixture);
    const { human, bot, whale } = env.accounts;
    const h = await human.getAddress();
    const n = mockNullifier(await env.contracts.adapter.currentNullifierSeed());
    await env.swap(human, USDC(5_000), usdcIn(env, await env.zkArgs(h, MUMBAI_HUMAN_REVEAL, n)));
    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(bot, USDC(5_000), usdcIn(env, aadhaarClaim(n)))).amountOut).to.equal(botQ.amountOut);   // copied claim
    expect((await env.quote(whale, USDC(5_000), usdcIn(env, aadhaarClaim(n)))).amountOut).to.equal(botQ.amountOut); // same human, other wallet
  });

  it("an expired binding is refused for claims; the next epoch's nullifier binds afresh (any wallet), the old one stays with its first address", async function () {
    const env = await loadFixture(epochFixture);
    const { human, bot, whale: altWallet } = env.accounts;
    const h = await human.getAddress(), alt = await altWallet.getAddress();
    const { router, adapter } = env.contracts;
    const n1 = mockNullifier(await adapter.currentNullifierSeed());
    await env.swap(human, USDC(5_000), usdcIn(env, await env.zkArgs(h, MUMBAI_HUMAN_REVEAL, n1)));

    const now = BigInt(await time.latest());
    await time.increaseTo((now / BigInt(EPOCH) + 1n) * BigInt(EPOCH) + 5n);
    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(human, USDC(5_000), usdcIn(env, aadhaarClaim(n1)))).amountOut).to.equal(botQ.amountOut); // expired

    const n2 = mockNullifier(await adapter.currentNullifierSeed());
    const s = await env.swap(altWallet, USDC(5_000), usdcIn(env, await env.zkArgs(alt, MUMBAI_HUMAN_REVEAL, n2)));
    await expect(s.tx).to.emit(router, "NullifierBound").withArgs(env.addr.adapter, n2, alt, await epochEnd(env));
    const botNow = await env.quote(bot, USDC(5_000), usdcIn(env)); // same post-swap state for both quotes
    expect((await env.quote(altWallet, USDC(5_000), usdcIn(env, aadhaarClaim(n2)))).amountOut).to.be.gt(botNow.amountOut);
    const [b1] = await router.nullifierBinding(env.addr.adapter, n1);
    expect(b1).to.equal(h); // the old record is simply stale ...
    // ... but the old nullifier still belongs to the human: a full proof for n1 from the alt wallet is refused
    expect((await env.quote(altWallet, USDC(5_000), usdcIn(env, await env.zkArgs(alt, MUMBAI_HUMAN_REVEAL, n1)))).amountOut).to.equal(botNow.amountOut);
  });

  it("claims are refused on orders with an opcode-level jurisdiction policy; the full proof still works", async function () {
    const env = await loadFixture(stateGatedFixture);
    const { human, bot } = env.accounts;
    const h = await human.getAddress();
    const n = 0xa11ce5n;
    const zk = await env.zkArgs(h, [1n, 0n, 0n, 27n], n);
    await env.swap(human, USDC(5_000), usdcIn(env, zk));
    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(human, USDC(5_000), usdcIn(env, aadhaarClaim(n)))).amountOut).to.equal(botQ.amountOut);
    expect((await env.quote(human, USDC(5_000), usdcIn(env, zk))).amountOut).to.be.gt(botQ.amountOut);
  });

  it("strict mode: an unbound claim reverts, a bound one trades", async function () {
    const env = await loadFixture(strictFixture);
    const { human } = env.accounts;
    const h = await human.getAddress();
    const { router } = env.contracts;
    const n = 0xbeefn;
    await expect(env.quote(human, USDC(5_000), usdcIn(env, aadhaarClaim(n)))).to.be.revertedWithCustomError(router, "ZKVerificationFailed");
    await env.swap(human, USDC(5_000), usdcIn(env, await env.zkArgs(h, MUMBAI_HUMAN_REVEAL, n)));
    const s = await env.swap(human, USDC(5_000), usdcIn(env, aadhaarClaim(n)));
    expect(s.amountOut).to.be.gt(0n);
  });

  it("World ID: a stable nullifierHash binds without expiry, so claims work indefinitely", async function () {
    const env = await loadFixture(worldFixture);
    const { human, bot } = env.accounts;
    const h = await human.getAddress();
    const { router } = env.contracts;
    const zk = await env.worldIdArgs(h);
    const nullifierHash = BigInt(ethers.hexlify(ethers.getBytes(zk).slice(3, 35)));
    const s = await env.swap(human, USDC(5_000), usdcIn(env, zk));
    await expect(s.tx).to.emit(router, "NullifierBound").withArgs(env.addr.worldIdAdapter, nullifierHash, h, UINT40_MAX);
    await time.increase(20 * 24 * 3600); // many Aadhaar epochs later, still inside the order's 30-day deadline
    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect((await env.quote(human, USDC(5_000), usdcIn(env, worldClaim(nullifierHash)))).amountOut).to.be.gt(botQ.amountOut);
    expect((await env.quote(bot, USDC(5_000), usdcIn(env, worldClaim(nullifierHash)))).amountOut).to.equal(botQ.amountOut);
  });

  it("quote() under a real STATICCALL reads the binding but never writes it; a contract taker gets no tier from someone else's claim", async function () {
    const env = await loadFixture(epochFixture);
    const { human, bot } = env.accounts;
    const h = await human.getAddress();
    const n = 0xc1a10n;
    await env.swap(human, USDC(1_000), usdcIn(env, await env.zkArgs(h, MUMBAI_HUMAN_REVEAL, n))); // bound to the human
    const [, out] = await env.contracts.quoter.quote(env.addr.router, env.order, USDC(5_000), usdcIn(env, aadhaarClaim(n)));
    const botQ = await env.quote(bot, USDC(5_000), usdcIn(env));
    expect(out).to.equal(botQ.amountOut); // the quoter is the taker of the STATICCALL and is not the bound address
    const [bound] = await env.contracts.router.nullifierBinding(env.addr.adapter, n);
    expect(bound).to.equal(h);
  });
});
