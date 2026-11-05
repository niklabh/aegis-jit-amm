// SPDX-License-Identifier: MIT
import "@nomicfoundation/hardhat-chai-matchers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";

import { AegisEnv, deployAegis, MAHARASHTRA, MUMBAI_HUMAN_REVEAL, RevealArray, USDC, WETH } from "./utils/aegisFixture";
import { AegisOpcodes, AegisProgramBuilder, FEE_BPS, ZKMode } from "../src/aegisProgramBuilder";

const { ethers } = require("hardhat");

// ---------- fixtures (module-level references so loadFixture can snapshot them) ----------
const baseFixture = () => deployAegis();
const strictFixture = () => deployAegis({ zkMode: ZKMode.STRICT, requiredStateCode: MAHARASHTRA, salt: 1n });
const stateGatedFixture = () => deployAegis({ requiredStateCode: MAHARASHTRA, salt: 2n });
const tightSellFloorFixture = () => deployAegis({ minSellPriceUsdc: 2_600, salt: 3n });
const tightBuyFloorFixture = () => deployAegis({ maxBuyPriceUsdc: 2_400, salt: 4n });
const noBoostFixture = () => deployAegis({ virtualBoostBps: 10_000, salt: 5n });

type Tier = "human" | "bot";
const TIERS: Tier[] = ["human", "bot"];

async function td(env: AegisEnv, tier: Tier, tokenIn: string, exactIn = true): Promise<string> {
  const taker = tier === "human" ? env.accounts.human : env.accounts.bot;
  const zk = tier === "human" ? await env.zkArgs(await taker.getAddress()) : undefined;
  return env.takerData({ tokenIn, exactIn, zk });
}
const signerOf = (env: AegisEnv, tier: Tier) => (tier === "human" ? env.accounts.human : env.accounts.bot);

/** Off-chain re-implementation of the full AegisJIT exactIn pipeline on a fresh surge window. */
async function modelExactInFresh(env: AegisEnv, tokenIn: string, gross: bigint, human: boolean): Promise<bigint> {
  const { cfg } = env;
  const isUsdcIn = tokenIn === env.addr.usdc;
  const aq = await env.aquaBalances();
  const [aIn, aOut] = isUsdcIn ? [aq.usdc, aq.weth] : [aq.weth, aq.usdc];
  const [refIn, refOut] = isUsdcIn ? [cfg.usdcLiquidity, cfg.wethLiquidity] : [cfg.wethLiquidity, cfg.usdcLiquidity];
  const boost = BigInt(cfg.virtualBoostBps);
  const bIn = aIn + refIn * (boost - 10_000n) / 10_000n;
  const bOut = aOut + refOut * (boost - 10_000n) / 10_000n;

  const base = BigInt(cfg.baseFeeBps);
  const b = human ? base / 2n : base;
  const p = BigInt(cfg.maxSurgeFeeBps) - base;
  const g0 = bIn * cfg.impactThresholdBps / 10_000n;
  const excess = gross > g0 ? gross - g0 : 0n;
  const num = gross * b + excess * p;
  const fee = (num + FEE_BPS - 1n) / FEE_BPS;
  const net = gross - fee;
  return net * bOut / (bIn + net);
}

describe("AegisJIT", function () {
  describe("Program builder (TS SDK == on-chain AegisJITStrategy)", function () {
    it("TypeScript and Solidity builders produce byte-identical orders", async function () {
      const env = await loadFixture(baseFixture);
      const p = env.params;
      const solidity = await env.contracts.strategy.buildOrder({
        maker: p.maker, token0: p.token0, token1: p.token1,
        vault0: p.vault0!, vault1: p.vault1!, jitHook: p.jitHook!, deadline: p.deadline!,
        zkVerifier: p.zkVerifier, zkMode: p.zkMode, requiredStateCode: p.requiredStateCode ?? 0,
        lambdaBps: p.lambdaBps, virtualBoostBps: p.virtualBoostBps,
        allocation0: p.allocation0, allocation1: p.allocation1,
        floor01AmountIn: p.floor01!.amountIn, floor01AmountOut: p.floor01!.amountOut,
        floor10AmountIn: p.floor10!.amountIn, floor10AmountOut: p.floor10!.amountOut,
        baseFeeBps: p.baseFeeBps, maxSurgeFeeBps: p.maxSurgeFeeBps,
        impactThresholdBps: p.impactThresholdBps, decayWindowSec: p.decayWindowSec, salt: p.salt ?? 0n,
      });
      expect(solidity.maker).to.equal(env.order.maker);
      expect(ethers.toBeHex(solidity.traits, 32)).to.equal(env.order.traits);
      expect(solidity.data).to.equal(env.order.data);
    });

    it("encodes every instruction in [opcode][len][args] framing with the spec'd arg lengths", async function () {
      const env = await loadFixture(baseFixture);
      const program = ethers.getBytes(AegisProgramBuilder.buildProgram(env.params));
      const seen: Array<[number, number]> = [];
      for (let pc = 0; pc < program.length;) {
        const op = program[pc], len = program[pc + 1];
        seen.push([op, len]);
        pc += 2 + len;
        expect(pc).to.be.at.most(program.length);
      }
      expect(seen).to.deep.equal([
        [AegisOpcodes.DEADLINE, 5],
        [AegisOpcodes.ZK_IDENTITY_GUARD, 25],
        [AegisOpcodes.JIT_VAULT_RESERVES, 82],
        [AegisOpcodes.JUMP_IF_TOKEN_IN, 22],
        [AegisOpcodes.REQUIRE_MIN_RATE_1D, 16],
        [AegisOpcodes.JUMP, 2],
        [AegisOpcodes.REQUIRE_MIN_RATE_1D, 16],
        [AegisOpcodes.VOLATILITY_SURGE_FEE, 20],
        [AegisOpcodes.XYC_SWAP_XD, 0],
      ]);
    });

    it("on-chain math matches an independent off-chain model (no hidden fallbacks)", async function () {
      const env = await loadFixture(baseFixture);
      for (const tier of TIERS) {
        for (const amount of [USDC(5_000), USDC(50_000), USDC(150_000)]) {
          const q = await env.quote(signerOf(env, tier), amount, await td(env, tier, env.addr.usdc));
          expect(q.amountOut).to.equal(await modelExactInFresh(env, env.addr.usdc, amount, tier === "human"));
        }
      }
    });
  });

  describe("Invariant 1: quote() == swap()", function () {
    const cases: Array<{ tier: Tier; dir: "USDC->WETH" | "WETH->USDC"; exactIn: boolean; amount: () => bigint }> = [];
    for (const tier of TIERS) {
      cases.push({ tier, dir: "USDC->WETH", exactIn: true, amount: () => USDC(5_000) });
      cases.push({ tier, dir: "USDC->WETH", exactIn: true, amount: () => USDC(80_000) });
      cases.push({ tier, dir: "USDC->WETH", exactIn: false, amount: () => WETH(10) });
      cases.push({ tier, dir: "WETH->USDC", exactIn: true, amount: () => WETH(12) });
      cases.push({ tier, dir: "WETH->USDC", exactIn: false, amount: () => USDC(40_000) });
    }

    for (const c of cases) {
      it(`${c.tier} ${c.dir} ${c.exactIn ? "exactIn" : "exactOut"}`, async function () {
        const env = await loadFixture(baseFixture);
        const tokenIn = c.dir === "USDC->WETH" ? env.addr.usdc : env.addr.weth;
        const [tIn, tOut] = c.dir === "USDC->WETH" ? [env.contracts.usdc, env.contracts.weth] : [env.contracts.weth, env.contracts.usdc];
        const signer = signerOf(env, c.tier);
        const data = await td(env, c.tier, tokenIn, c.exactIn);

        // warm the surge window so quote must read non-trivial state
        await env.swap(env.accounts.whale, c.dir === "USDC->WETH" ? USDC(7_000) : WETH(3), env.takerData({ tokenIn }));

        const q = await env.quote(signer, c.amount(), data);
        const s = await env.swap(signer, c.amount(), data);
        expect(s.amountIn).to.equal(q.amountIn);
        expect(s.amountOut).to.equal(q.amountOut);
        await expect(s.tx).to.changeTokenBalances(tIn, [signer], [-q.amountIn]);
        await expect(s.tx).to.changeTokenBalances(tOut, [signer], [q.amountOut]);
      });
    }

    it("quote under a real STATICCALL (ISwapVM view interface) equals swap — all opcodes are view-safe", async function () {
      const env = await loadFixture(baseFixture);
      const quoter = env.contracts.quoter;
      const quoterAddr = await quoter.getAddress();
      // Unverified path
      const botData = env.takerData({ tokenIn: env.addr.usdc });
      const [qi, qo] = await quoter.quote(env.addr.router, env.order, USDC(60_000), botData);
      const s = await env.swap(env.accounts.bot, USDC(60_000), botData);
      expect([s.amountIn, s.amountOut]).to.deep.equal([qi, qo]);

      // Verified path: proof bound to the quoter contract (it is the taker of the STATICCALL)
      const humanSigner = env.accounts.human;
      const [hi, ho] = await quoter.quote(
        env.addr.router, env.order, USDC(5_000),
        env.takerData({ tokenIn: env.addr.usdc, zk: await env.zkArgs(quoterAddr) }),
      );
      const hs = await env.swap(humanSigner, USDC(5_000), await td(env, "human", env.addr.usdc));
      expect([hs.amountIn, hs.amountOut]).to.deep.equal([hi, ho]);
    });
  });

  describe("Invariant 2: symmetry exactIn(X)->Y  <=>  exactOut(Y)->X  (<= 2 wei)", function () {
    for (const tier of TIERS) {
      for (const usdcIn of [USDC(1_000), USDC(15_000), USDC(45_000), USDC(180_000)]) {
        it(`${tier}: USDC->WETH  X = ${ethers.formatUnits(usdcIn, 6)} USDC`, async function () {
          const env = await loadFixture(baseFixture);
          const s = signerOf(env, tier);
          const fwd = await env.quote(s, usdcIn, await td(env, tier, env.addr.usdc, true));
          const inv = await env.quote(s, fwd.amountOut, await td(env, tier, env.addr.usdc, false));
          expect(inv.amountOut).to.equal(fwd.amountOut);
          expect(inv.amountIn).to.be.at.most(usdcIn);           // never charges more than the forward trade
          expect(usdcIn - inv.amountIn).to.be.at.most(2n);
        });
      }
      // USDC (6 dp) is the coarse side here, so measure symmetry on the USDC leg
      for (const usdcOut of [USDC(2_000), USDC(30_000), USDC(120_000)]) {
        it(`${tier}: WETH->USDC  Y = ${ethers.formatUnits(usdcOut, 6)} USDC`, async function () {
          const env = await loadFixture(baseFixture);
          const s = signerOf(env, tier);
          const inv = await env.quote(s, usdcOut, await td(env, tier, env.addr.weth, false));
          const fwd = await env.quote(s, inv.amountIn, await td(env, tier, env.addr.weth, true));
          expect(fwd.amountOut).to.be.at.least(usdcOut);
          expect(fwd.amountOut - usdcOut).to.be.at.most(2n);
        });
      }
    }
  });

  describe("Invariant 3: sub-additivity (anti split-gaming)", function () {
    const singleVsSplit = async (tier: Tier, tokenIn: "usdc" | "weth", amount: bigint, exactIn: boolean) => {
      let env = await loadFixture(baseFixture);
      const tIn = env.addr[tokenIn];
      const single = await env.swap(signerOf(env, tier), amount, await td(env, tier, tIn, exactIn));

      env = await loadFixture(baseFixture);
      const half = amount / 2n;
      const a = await env.swap(signerOf(env, tier), half, await td(env, tier, tIn, exactIn));
      const b = await env.swap(signerOf(env, tier), amount - half, await td(env, tier, tIn, exactIn));
      return { single, split: { amountIn: a.amountIn + b.amountIn, amountOut: a.amountOut + b.amountOut } };
    };

    for (const tier of TIERS) {
      for (const amount of [USDC(10_000), USDC(36_000), USDC(150_000)]) {
        it(`${tier}: 2 x ${ethers.formatUnits(amount / 2n, 6)} USDC never beats 1 x ${ethers.formatUnits(amount, 6)} USDC`, async function () {
          const { single, split } = await singleVsSplit(tier, "usdc", amount, true);
          expect(split.amountIn).to.equal(single.amountIn);
          expect(split.amountOut).to.be.at.most(single.amountOut);
        });
      }
      for (const amount of [WETH(4), WETH(30)]) {
        it(`${tier}: 2 x ${ethers.formatEther(amount / 2n)} WETH never beats 1 x ${ethers.formatEther(amount)} WETH`, async function () {
          const { single, split } = await singleVsSplit(tier, "weth", amount, true);
          expect(split.amountOut).to.be.at.most(single.amountOut);
        });
      }
      it(`${tier}: exactOut — buying 2 x 20 WETH never costs less than 1 x 40 WETH`, async function () {
        const { single, split } = await singleVsSplit(tier, "usdc", WETH(40), false);
        expect(split.amountOut).to.equal(single.amountOut);
        expect(split.amountIn).to.be.at.least(single.amountIn);
      });
    }

    it("the surge window accumulates split flow, so the split pays the same surge as the single trade", async function () {
      const env = await loadFixture(baseFixture);
      const data = env.takerData({ tokenIn: env.addr.usdc });
      await env.swap(env.accounts.bot, USDC(30_000), data);
      await env.swap(env.accounts.bot, USDC(30_000), data);
      const [start, flow, ref] = await env.contracts.router.surgeWindow(env.orderHash, env.addr.usdc);
      expect(start).to.be.gt(0n);
      expect(flow).to.equal(USDC(60_000));
      expect(ref).to.equal(USDC(2_000_000)); // 1M Aqua + 1M virtual offset, frozen at window start
    });

    it("round trip (buy then sell back) never profits the taker — boost offsets are path-independent", async function () {
      const env = await loadFixture(baseFixture);
      const bot = env.accounts.bot;
      const buy = await env.swap(bot, USDC(50_000), env.takerData({ tokenIn: env.addr.usdc }));
      const sell = await env.swap(bot, buy.amountOut, env.takerData({ tokenIn: env.addr.weth }));
      expect(sell.amountOut).to.be.lt(USDC(50_000));
    });
  });

  describe("Invariant 4: monotonicity", function () {
    const grid = [1_000, 4_000, 10_000, 19_000, 21_000, 40_000, 80_000, 140_000, 200_000].map((n) => USDC(n));

    for (const tier of TIERS) {
      it(`${tier}: exactIn — amountOut strictly increases, average price never improves`, async function () {
        const env = await loadFixture(baseFixture);
        const data = await td(env, tier, env.addr.usdc, true);
        let prev: { amountIn: bigint; amountOut: bigint } | undefined;
        for (const x of grid) {
          const q = await env.quote(signerOf(env, tier), x, data);
          if (prev) {
            expect(q.amountOut).to.be.gt(prev.amountOut);
            // out/in non-increasing  <=>  out_i * in_{i-1} <= out_{i-1} * in_i
            expect(q.amountOut * prev.amountIn).to.be.at.most(prev.amountOut * q.amountIn);
          }
          prev = q;
        }
      });

      it(`${tier}: exactOut — amountIn strictly increases, average cost never improves`, async function () {
        const env = await loadFixture(baseFixture);
        const data = await td(env, tier, env.addr.usdc, false);
        let prev: { amountIn: bigint; amountOut: bigint } | undefined;
        for (const y of [0.5, 2, 6, 8, 12, 25, 50, 80, 99].map((n) => WETH(n))) {
          const q = await env.quote(signerOf(env, tier), y, data);
          if (prev) {
            expect(q.amountIn).to.be.gt(prev.amountIn);
            expect(q.amountIn * prev.amountOut).to.be.at.least(prev.amountIn * q.amountOut);
          }
          prev = q;
        }
      });
    }
  });

  describe("Invariant 5: ZK tier differentiation (0x2A -> 0x7A)", function () {
    it("a verified human gets a strictly better rate than an unverified bot for the same trade", async function () {
      const env = await loadFixture(baseFixture);
      for (const amount of [USDC(5_000), USDC(50_000)]) {
        const h = await env.quote(env.accounts.human, amount, await td(env, "human", env.addr.usdc));
        const b = await env.quote(env.accounts.bot, amount, await td(env, "bot", env.addr.usdc));
        expect(h.amountOut).to.be.gt(b.amountOut);
      }
    });

    it("the human discount is exactly 50% of the base fee (below the surge threshold)", async function () {
      const env = await loadFixture(baseFixture);
      const amount = USDC(5_000);
      const h = await env.quote(env.accounts.human, amount, await td(env, "human", env.addr.usdc));
      expect(h.amountOut).to.equal(await modelExactInFresh(env, env.addr.usdc, amount, true));
      const b = await env.quote(env.accounts.bot, amount, await td(env, "bot", env.addr.usdc));
      expect(b.amountOut).to.equal(await modelExactInFresh(env, env.addr.usdc, amount, false));
    });

    it("a bot replaying a human's proof is treated as unverified (proof is bound to the taker)", async function () {
      const env = await loadFixture(baseFixture);
      const stolen = await env.zkArgs(await env.accounts.human.getAddress());
      const replay = await env.quote(env.accounts.bot, USDC(5_000), env.takerData({ tokenIn: env.addr.usdc, zk: stolen }));
      const bot = await env.quote(env.accounts.bot, USDC(5_000), await td(env, "bot", env.addr.usdc));
      expect(replay.amountOut).to.equal(bot.amountOut);
    });

    it("invalid proofs never grant the discount in tiered mode (wrong issuer, under-18, garbage)", async function () {
      const env = await loadFixture(baseFixture);
      const human = env.accounts.human;
      const hAddr = await human.getAddress();
      const bot = await env.quote(env.accounts.bot, USDC(5_000), await td(env, "bot", env.addr.usdc));

      const under18: RevealArray = [0n, ...MUMBAI_HUMAN_REVEAL.slice(1)] as RevealArray;
      const forged = ethers.solidityPacked(["uint16", "bytes"], [160 + 65, ethers.concat([
        ethers.zeroPadValue("0x01", 32),
        ...MUMBAI_HUMAN_REVEAL.map((v) => ethers.zeroPadValue(ethers.toBeHex(v), 32)),
        await ethers.Wallet.createRandom().signMessage("forged"),
      ])]);
      for (const zk of [await env.zkArgs(hAddr, under18), forged, "0x00ff1234"]) {
        const q = await env.quote(human, USDC(5_000), env.takerData({ tokenIn: env.addr.usdc, zk }));
        expect(q.amountOut).to.equal(bot.amountOut);
      }
    });

    it("jurisdiction gate: requiredStateCode must match revealArray[3]", async function () {
      const env = await loadFixture(stateGatedFixture);
      const hAddr = await env.accounts.human.getAddress();
      const ok = await env.quote(env.accounts.human, USDC(5_000), env.takerData({ tokenIn: env.addr.usdc, zk: await env.zkArgs(hAddr) }));
      const otherState: RevealArray = [1n, 77n, 560001n, 29n];
      const ko = await env.quote(env.accounts.human, USDC(5_000), env.takerData({ tokenIn: env.addr.usdc, zk: await env.zkArgs(hAddr, otherState) }));
      expect(ok.amountOut).to.be.gt(ko.amountOut);
    });

    it("strict mode (0) reverts ZKVerificationFailed for unverified takers and serves verified ones", async function () {
      const env = await loadFixture(strictFixture);
      const { router } = env.contracts;
      await expect(env.quote(env.accounts.bot, USDC(5_000), env.takerData({ tokenIn: env.addr.usdc })))
        .to.be.revertedWithCustomError(router, "ZKVerificationFailed");
      await expect(router.connect(env.accounts.bot).swap(env.order, USDC(5_000), env.takerData({ tokenIn: env.addr.usdc })))
        .to.be.revertedWithCustomError(router, "ZKVerificationFailed");
      const s = await env.swap(env.accounts.human, USDC(5_000), await td(env, "human", env.addr.usdc));
      expect(s.amountOut).to.be.gt(0n);
    });
  });

  describe("Invariant 6: self-custodial JIT protection (0x9A, λ = 25%)", function () {
    it("a whale cannot drain more than λ of the Maker's vault in one execution (exactIn and exactOut)", async function () {
      const env = await loadFixture(baseFixture);
      const { router } = env.contracts;
      const whale = env.accounts.whale;
      const before = await env.vaultAssets();

      const exactInWhale = env.takerData({ tokenIn: env.addr.usdc });
      await expect(env.quote(whale, USDC(500_000), exactInWhale)).to.be.revertedWithCustomError(router, "JITExposureCapExceeded");
      await expect(router.connect(whale).swap(env.order, USDC(500_000), exactInWhale)).to.be.revertedWithCustomError(router, "JITExposureCapExceeded");

      const cap = before.weth * 2_500n / 10_000n;
      const exactOutWhale = env.takerData({ tokenIn: env.addr.usdc, exactIn: false });
      await expect(router.connect(whale).swap(env.order, cap + 1n, exactOutWhale))
        .to.be.revertedWithCustomError(router, "JITExposureCapExceeded").withArgs(cap + 1n, cap);

      // The maximum a single execution can take is exactly λ of the vault
      const s = await env.swap(whale, cap, exactOutWhale);
      const after = await env.vaultAssets();
      expect(before.weth - after.weth).to.equal(s.amountOut);
      expect(before.weth - after.weth).to.be.at.most(before.weth / 4n);
      expect(after.weth).to.be.at.least(before.weth * 3n / 4n); // >= 75% untouched, still earning yield
    });

    it("the cap tracks the LIVE vault position (Maker withdraws => exposure shrinks JIT)", async function () {
      const env = await loadFixture(baseFixture);
      const { router, wethVault } = env.contracts;
      const maker = env.accounts.maker;
      await wethVault.connect(maker).withdraw(WETH(300), env.addr.maker, env.addr.maker); // 100 WETH left in vault
      const data = env.takerData({ tokenIn: env.addr.usdc, exactIn: false });
      await expect(env.quote(env.accounts.bot, WETH(26), data))
        .to.be.revertedWithCustomError(router, "JITExposureCapExceeded").withArgs(WETH(26), WETH(25));
      const ok = await env.quote(env.accounts.bot, WETH(25), data);
      expect(ok.amountOut).to.equal(WETH(25));
    });

    it("vault yield raises the cap without any re-configuration", async function () {
      const env = await loadFixture(baseFixture);
      const { weth, wethVault, router } = env.contracts;
      const whale = env.accounts.whale;
      const data = env.takerData({ tokenIn: env.addr.usdc, exactIn: false });
      await expect(env.quote(whale, WETH(105), data)).to.be.revertedWithCustomError(router, "JITExposureCapExceeded");
      await weth.connect(whale).approve(env.addr.wethVault, WETH(40));
      await wethVault.connect(whale).accrueYield(WETH(40)); // maker owns 100% of shares => +40 WETH
      const q = await env.quote(whale, WETH(105), data);
      expect(q.amountOut).to.equal(WETH(105));
    });

    it("capital stays self-custodied: Maker wallet holds only vault shares; hook re-deposits amountIn", async function () {
      const env = await loadFixture(baseFixture);
      const { usdc, weth, usdcVault, wethVault } = env.contracts;
      const s = await env.swap(env.accounts.bot, USDC(50_000), env.takerData({ tokenIn: env.addr.usdc }));
      expect(await usdc.balanceOf(env.addr.maker)).to.equal(0n);
      expect(await weth.balanceOf(env.addr.maker)).to.equal(0n);
      await expect(s.tx).to.changeTokenBalances(usdc, [env.addr.usdcVault], [USDC(50_000)]);
      await expect(s.tx).to.changeTokenBalances(weth, [env.addr.wethVault], [-s.amountOut]);
      // vault accounting == Aqua accounting
      const v = await env.vaultAssets();
      const a = await env.aquaBalances();
      expect(v).to.deep.equal(a);
      expect(await usdcVault.balanceOf(env.addr.maker)).to.be.gt(0n);
      expect(await wethVault.balanceOf(env.addr.maker)).to.be.gt(0n);
    });

    it("the JIT hook only accepts calls from the router", async function () {
      const env = await loadFixture(baseFixture);
      const { hook } = env.contracts;
      const vaults = ethers.solidityPacked(["address", "address"], [env.addr.usdcVault, env.addr.wethVault]);
      await expect(hook.connect(env.accounts.bot).preTransferOut(
        env.addr.maker, env.addr.maker, env.addr.usdc, env.addr.weth, 0, WETH(1), env.orderHash, vaults, "0x",
      )).to.be.revertedWithCustomError(hook, "OnlyRouter");
    });
  });

  describe("VolatilitySurgeFee (0x7A) mechanics", function () {
    it("charges surge only on flow above the threshold and resets after decayWindowSec", async function () {
      const env = await loadFixture(baseFixture);
      const bot = env.accounts.bot;
      const data = env.takerData({ tokenIn: env.addr.usdc });
      // 1% of 2M virtual balance = 20k USDC threshold; 19k is pure base fee
      const below = await env.quote(bot, USDC(19_000), data);
      expect(below.amountOut).to.equal(await modelExactInFresh(env, env.addr.usdc, USDC(19_000), false));

      await env.swap(bot, USDC(19_000), data);
      const hot = await env.quote(bot, USDC(10_000), data); // 9k of this is above threshold now

      await time.increase(env.cfg.decayWindowSec + 1);
      const cool = await env.quote(bot, USDC(10_000), data); // new window: no surge
      expect(cool.amountOut).to.be.gt(hot.amountOut);
    });

    it("rejects malformed fee configs at build time", async function () {
      const env = await loadFixture(baseFixture);
      expect(() => AegisProgramBuilder.buildProgram({ ...env.params, baseFeeBps: 10, maxSurgeFeeBps: 5 })).to.throw();
      expect(() => AegisProgramBuilder.buildProgram({ ...env.params, maxSurgeFeeBps: 600_000_000 })).to.throw();
    });
  });

  describe("Guards: deadline and two-sided RequireMinRate band", function () {
    it("reverts after the strategy deadline", async function () {
      const env = await loadFixture(baseFixture);
      await time.increaseTo(env.params.deadline! + 1n);
      await expect(env.quote(env.accounts.bot, USDC(1_000), env.takerData({ tokenIn: env.addr.usdc })))
        .to.be.revertedWithCustomError(env.contracts.router, "DeadlineReached");
    });

    it("default floors (2,000 / 3,000) allow both directions at 2,500", async function () {
      const env = await loadFixture(baseFixture);
      expect((await env.quote(env.accounts.bot, USDC(1_000), env.takerData({ tokenIn: env.addr.usdc }))).amountOut).to.be.gt(0n);
      expect((await env.quote(env.accounts.bot, WETH(1), env.takerData({ tokenIn: env.addr.weth }))).amountOut).to.be.gt(0n);
    });

    it("blocks selling WETH below the Maker's floor (USDC -> WETH) but not the other side", async function () {
      const env = await loadFixture(tightSellFloorFixture);
      await expect(env.quote(env.accounts.bot, USDC(1_000), env.takerData({ tokenIn: env.addr.usdc })))
        .to.be.revertedWithCustomError(env.contracts.router, "MinRateFailed");
      expect((await env.quote(env.accounts.bot, WETH(1), env.takerData({ tokenIn: env.addr.weth }))).amountOut).to.be.gt(0n);
    });

    it("blocks buying WETH above the Maker's ceiling (WETH -> USDC) but not the other side", async function () {
      const env = await loadFixture(tightBuyFloorFixture);
      await expect(env.quote(env.accounts.bot, WETH(1), env.takerData({ tokenIn: env.addr.weth })))
        .to.be.revertedWithCustomError(env.contracts.router, "MinRateFailed");
      expect((await env.quote(env.accounts.bot, USDC(1_000), env.takerData({ tokenIn: env.addr.usdc }))).amountOut).to.be.gt(0n);
    });
  });

  describe("Virtual boost (constant offsets)", function () {
    it("2x boost gives retail better execution than 1x on the same capital", async function () {
      const boosted = await loadFixture(baseFixture);
      const b = await boosted.quote(boosted.accounts.bot, USDC(10_000), boosted.takerData({ tokenIn: boosted.addr.usdc }));
      const flat = await loadFixture(noBoostFixture);
      const f = await flat.quote(flat.accounts.bot, USDC(10_000), flat.takerData({ tokenIn: flat.addr.usdc }));
      expect(b.amountOut).to.be.gt(f.amountOut);
    });
  });
});
