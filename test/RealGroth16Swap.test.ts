// SPDX-License-Identifier: MIT
// End-to-end with REAL zero-knowledge proofs:
//   synthetic V2 Aadhaar Secure QR (AegisJIT test signer) -> zkAadhaar parse + RSA-2048 check
//   -> Anon Aadhaar v2 circuit (snarkjs Groth16, BN254) -> takerData -> AegisSwapVMRouter.swap()
//   -> 0x2A -> AnonAadhaarAdapter -> AnonAadhaarGroth16Verifier -> Verifier.sol (ecPairing 0x08)
// Requires the official artifacts: node packages/zk-aadhaar/prover/fetch-artifacts.mjs
import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { existsSync } from "fs";
import * as path from "path";

import {
  AegisEnv, deployAegis, encodeRealProofTakerArgs, generateRealProof, MAHARASHTRA_PACKED, RealProof,
  TEST_SIGNER_PUBKEY_HASH, UIDAI_2021_PUBKEY_HASH, USDC, AEGIS_NULLIFIER_SEED,
} from "./utils/aegisFixture";

const { ethers } = require("hardhat");

const ZKEY = path.join(__dirname, "..", ".cache", "anon-aadhaar", "v2.0.0", "circuit_final.zkey");

async function realFixture() {
  const env = await deployAegis({ zkBackend: "groth16", adapterRequiredState: MAHARASHTRA_PACKED, salt: 20n });
  const human = await env.accounts.human.getAddress();
  const ts = (await ethers.provider.getBlock("latest"))!.timestamp;
  const real = generateRealProof({ timestamp: ts, seed: AEGIS_NULLIFIER_SEED, signal: human }); // ~15 s
  return { env, real, zk: encodeRealProofTakerArgs(real) };
}

/** Did this tx execute a STATICCALL to the BN254 ecPairing precompile (0x08)? */
async function callsEcPairing(txHash: string): Promise<boolean> {
  const trace = await ethers.provider.send("debug_traceTransaction", [txHash, { disableMemory: true, disableStorage: true }]);
  return trace.structLogs.some((l: any) => l.op === "STATICCALL" && BigInt("0x" + l.stack[l.stack.length - 2].replace(/^0x/, "")) === 8n);
}

const proofArgs = (r: RealProof) => {
  const ps = r.proof.publicSignals;
  return {
    nullifier: BigInt(ps.nullifier),
    reveal: [BigInt(ps.ageAbove18), BigInt(ps.gender), BigInt(ps.pincode), BigInt(ps.state)] as [bigint, bigint, bigint, bigint],
    proof: ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256[8]"], [BigInt(ps.timestamp), r.proof.groth16Proof.map(BigInt)]),
    timestamp: BigInt(ps.timestamp),
    words: r.proof.groth16Proof.map(BigInt) as unknown as bigint[],
  };
};

describe("Real Groth16 (BN254) Anon Aadhaar proof -> AegisJIT swap", function () {
  this.timeout(10 * 60_000);

  before(function () {
    if (!existsSync(ZKEY)) {
      console.warn("    ⚠ Anon Aadhaar artifacts not found — run `node packages/zk-aadhaar/prover/fetch-artifacts.mjs` (≈620 MB). Skipping real-proof suite.");
      this.skip();
    }
  });

  it("QR pipeline: V2 Secure QR parses, RSA-2048 signature verifies, circuit outputs ageAbove18 = 1 and state = Maharashtra", async function () {
    const { real } = await loadFixture(realFixture);
    expect(real.qr.version).to.equal("V2");
    expect(real.qr.rsa.status).to.equal("untrusted-key");         // valid signature, TEST signer (not UIDAI)
    expect(real.qr.rsa.key).to.match(/AegisJIT TEST signer/);
    const ps = real.proof.publicSignals;
    expect(BigInt(ps.pubkeyHash)).to.equal(TEST_SIGNER_PUBKEY_HASH);
    expect(ps.ageAbove18).to.equal("1");
    expect(BigInt(ps.state)).to.equal(MAHARASHTRA_PACKED);
    expect(real.proof.stateText).to.equal("Maharashtra");
    expect([ps.gender, ps.pincode]).to.deep.equal(["0", "0"]);     // not revealed
    expect(BigInt(ps.nullifierSeed)).to.equal(AEGIS_NULLIFIER_SEED);
    expect(real.proof.groth16Proof).to.have.length(8);
    console.log(`      proving time: ${real.proof.provingMs} ms`);
  });

  it("the real BN254 verifier accepts the proof for the bound taker and rejects other takers / tampered proofs", async function () {
    const { env, real } = await loadFixture(realFixture);
    const { adapter, groth16 } = env.contracts;
    const a = proofArgs(real);
    const human = await env.accounts.human.getAddress();
    const bot = await env.accounts.bot.getAddress();

    expect(await groth16.verifyAnonAadhaarProof(AEGIS_NULLIFIER_SEED, a.nullifier, a.timestamp, BigInt(human), a.reveal, a.words)).to.equal(true);
    expect(await adapter.verifyProof(human, a.nullifier, a.reveal, a.proof)).to.equal(true);
    expect(await adapter.verifyProof(bot, a.nullifier, a.reveal, a.proof)).to.equal(false);   // signal mismatch

    const tampered = [...a.words]; tampered[7] ^= 1n;
    expect(await groth16.verifyAnonAadhaarProof(AEGIS_NULLIFIER_SEED, a.nullifier, a.timestamp, BigInt(human), a.reveal, tampered)).to.equal(false);
    const otherState = [...a.reveal] as [bigint, bigint, bigint, bigint]; otherState[3] = MAHARASHTRA_PACKED + 1n;
    expect(await groth16.verifyAnonAadhaarProof(AEGIS_NULLIFIER_SEED, a.nullifier, a.timestamp, BigInt(human), otherState, a.words)).to.equal(false);

    const gas = await groth16.verifyAnonAadhaarProof.estimateGas(AEGIS_NULLIFIER_SEED, a.nullifier, a.timestamp, BigInt(human), a.reveal, a.words);
    console.log(`      Groth16 verifyAnonAadhaarProof gas (incl. 21k base): ${gas}`);
  });

  it("trust root: a verifier pinned to the UIDAI key hash rejects proofs from the test signer", async function () {
    const { env, real } = await loadFixture(realFixture);
    const prod = await (await ethers.getContractFactory("AnonAadhaarGroth16Verifier")).deploy(env.addr.pairingVerifier, UIDAI_2021_PUBKEY_HASH);
    const a = proofArgs(real);
    expect(await prod.verifyAnonAadhaarProof(AEGIS_NULLIFIER_SEED, a.nullifier, a.timestamp, BigInt(await env.accounts.human.getAddress()), a.reveal, a.words)).to.equal(false);
  });

  it("swap(): real proof in takerData executes ecPairing (0x08), passes 0x2A and gets the human fee tier in 0x7A; quote == swap", async function () {
    const { env, zk } = await loadFixture(realFixture);
    const { human, bot } = env.accounts;
    const data = env.takerData({ tokenIn: env.addr.usdc, zk });
    const amount = USDC(5_000);

    const humanQ = await env.quote(human, amount, data);
    const botQ = await env.quote(bot, amount, env.takerData({ tokenIn: env.addr.usdc }));
    expect(humanQ.amountOut).to.be.gt(botQ.amountOut);

    const s = await env.swap(human, amount, data);
    expect(s.amountOut).to.equal(humanQ.amountOut);                       // 0 wei divergence
    expect(await callsEcPairing(s.receipt.hash)).to.equal(true);
    await expect(s.tx).to.emit(env.contracts.router, "NullifierBound");
    console.log(`      swap gas with real Groth16 verification: ${s.receipt.gasUsed}`);
  });

  it("MEV bot replaying the exact takerData (real proof) is priced as unverified; pairing still runs and fails the signal binding", async function () {
    const { env, zk } = await loadFixture(realFixture);
    const { human, bot } = env.accounts;
    const copied = env.takerData({ tokenIn: env.addr.usdc, zk });
    const amount = USDC(50_000);
    const botQ = await env.quote(bot, amount, env.takerData({ tokenIn: env.addr.usdc }));
    const humanQ = await env.quote(human, amount, copied);
    const hijack = await env.swap(bot, amount, copied);
    expect(hijack.amountOut).to.equal(botQ.amountOut);
    expect(hijack.amountOut).to.be.lt(humanQ.amountOut);
    expect(await callsEcPairing(hijack.receipt.hash)).to.equal(true);
    await expect(hijack.tx).to.not.emit(env.contracts.router, "NullifierBound");
  });

  it("a tampered Groth16 proof never grants the discount (and never reverts the swap in tiered mode)", async function () {
    const { env, real } = await loadFixture(realFixture);
    const { human, bot } = env.accounts;
    const bad = env.takerData({ tokenIn: env.addr.usdc, zk: encodeRealProofTakerArgs(real, true) });
    const q = await env.quote(human, USDC(5_000), bad);
    const botQ = await env.quote(bot, USDC(5_000), env.takerData({ tokenIn: env.addr.usdc }));
    expect(q.amountOut).to.equal(botQ.amountOut);
  });
});
