// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
// Powered by SwapVM — © Degensoft Ltd 2025. Imports the swap-vm-template helpers
// (test/utils/SwapVMHelpers.ts), so this file is licensed under SwapVM-1.1 (created 2026-11-05).
// Shared deployment + helpers for AegisJIT tests and the Mumbai demo script.

import { BytesLike, Signer, Wallet, ContractTransactionReceipt, ContractTransactionResponse } from "ethers";

import { TakerTraitsLib } from "./SwapVMHelpers";
import {
  AegisProgramBuilder,
  AegisStrategyParams,
  Order,
  ZKMode,
  encodeZKTakerArgs,
  zkAttestationHash,
} from "../../src/aegisProgramBuilder";

import type {
  Aqua,
  AegisSwapVMRouter,
  AegisJITVaultHook,
  AegisJITStrategy,
  MockAnonIdentityVerifier,
  MockGroth16AnonAadhaar,
  AnonAadhaarAdapter,
  MockERC4626Vault,
  StaticQuoter,
  TokenCustomDecimalsMock,
  WETHMock,
} from "../../typechain-types";

const { ethers } = require("hardhat");

export const USDC = (n: number | bigint | string) => ethers.parseUnits(n.toString(), 6) as bigint;
export const WETH = (n: number | bigint | string) => ethers.parseUnits(n.toString(), 18) as bigint;

/**
 * Anon-Aadhaar reveal: [ageAbove18, gender, pincode, state]; 0 = not revealed.
 * Minimal disclosure by default: only ageAbove18 and state (27 = Maharashtra GST code in the
 * mock backends; the real Anon Aadhaar circuit emits the state as a packed string).
 */
export type RevealArray = [bigint, bigint, bigint, bigint];
export const MUMBAI_HUMAN_REVEAL: RevealArray = [1n, 0n, 0n, 27n];
/** App-scoped nullifier seed for the Anon Aadhaar adapter */
export const AEGIS_NULLIFIER_SEED = BigInt(ethers.id("aegis-jit/anon-aadhaar/nullifier-seed")) >> 8n;
export const MAHARASHTRA = 27;

export interface AegisConfig {
  usdcLiquidity: bigint;
  wethLiquidity: bigint;
  lambdaBps: number;
  virtualBoostBps: number;
  baseFeeBps: number;
  maxSurgeFeeBps: number;
  impactThresholdBps: bigint;
  decayWindowSec: number;
  zkMode: number;
  requiredStateCode: number;
  useFloors: boolean;
  /** Maker never sells WETH below this many USDC (USDC -> WETH direction) */
  minSellPriceUsdc: number;
  /** Maker never buys WETH above this many USDC (WETH -> USDC direction) */
  maxBuyPriceUsdc: number;
  useVaults: boolean;
  salt: bigint;
  /** "ecdsa" = MockAnonIdentityVerifier; "anonAadhaar" = AnonAadhaarAdapter over MockGroth16AnonAadhaar */
  zkBackend: "ecdsa" | "anonAadhaar";
  maxProofAge: number;
  adapterRequiredState: bigint;
}

export const DEFAULT_CONFIG: AegisConfig = {
  usdcLiquidity: USDC(1_000_000),
  wethLiquidity: WETH(400),          // 2,500 USDC / WETH
  lambdaBps: 2_500,                  // λ = 25% of the vault exposed per execution
  virtualBoostBps: 20_000,           // 2.0x virtual depth
  baseFeeBps: 3_000_000,             // 0.30% (BPS = 1e9)
  maxSurgeFeeBps: 15_000_000,        // 1.50% marginal above threshold
  impactThresholdBps: 100n,          // surge starts at 1% utilization of balanceIn
  decayWindowSec: 600,               // 10-minute flow window
  zkMode: ZKMode.TIERED,
  requiredStateCode: 0,
  useFloors: true,
  minSellPriceUsdc: 2_000,
  maxBuyPriceUsdc: 3_000,
  useVaults: true,
  salt: 0n,
  zkBackend: "ecdsa",
  maxProofAge: 24 * 3600,
  adapterRequiredState: 0n,
};

export interface SwapResult {
  amountIn: bigint;
  amountOut: bigint;
  tx: ContractTransactionResponse;
  receipt: ContractTransactionReceipt;
}

export async function deployAegis(overrides: Partial<AegisConfig> = {}) {
  const cfg: AegisConfig = { ...DEFAULT_CONFIG, ...overrides };
  const [deployer, maker, human, bot, whale] = (await ethers.getSigners()) as Signer[];
  // Deterministic issuer key standing in for the Anon-Aadhaar / World ID trusted setup
  const issuer = new Wallet(ethers.id("aegis-jit/mock-anon-identity-issuer"));

  const deploy = async <T>(name: string, args: unknown[] = []): Promise<T> => {
    const c = await (await ethers.getContractFactory(name)).deploy(...args);
    await c.waitForDeployment();
    return c as T;
  };

  const aqua = await deploy<Aqua>("Aqua");
  const weth = await deploy<WETHMock>("WETHMock");
  const usdc = await deploy<TokenCustomDecimalsMock>("TokenCustomDecimalsMock", ["USD Coin", "USDC", 0, 6]);
  const router = await deploy<AegisSwapVMRouter>("AegisSwapVMRouter", [
    await aqua.getAddress(), await weth.getAddress(), await deployer.getAddress(), "AegisJIT", "1",
  ]);
  const hook = await deploy<AegisJITVaultHook>("AegisJITVaultHook", [await router.getAddress()]);
  const strategy = await deploy<AegisJITStrategy>("AegisJITStrategy");
  const verifier = await deploy<MockAnonIdentityVerifier>("MockAnonIdentityVerifier", [issuer.address]);
  const anonAadhaar = await deploy<MockGroth16AnonAadhaar>("MockGroth16AnonAadhaar", [await deployer.getAddress()]);
  const adapter = await deploy<AnonAadhaarAdapter>("AnonAadhaarAdapter", [
    await anonAadhaar.getAddress(), AEGIS_NULLIFIER_SEED, cfg.maxProofAge, cfg.adapterRequiredState,
  ]);
  const usdcVault = await deploy<MockERC4626Vault>("MockERC4626Vault", [await usdc.getAddress(), "Aegis USDC Vault", "avUSDC"]);
  const wethVault = await deploy<MockERC4626Vault>("MockERC4626Vault", [await weth.getAddress(), "Aegis WETH Vault", "avWETH"]);
  const quoter = await deploy<StaticQuoter>("StaticQuoter");

  const addr = {
    aqua: await aqua.getAddress(),
    router: await router.getAddress(),
    hook: await hook.getAddress(),
    usdc: await usdc.getAddress(),
    weth: await weth.getAddress(),
    usdcVault: await usdcVault.getAddress(),
    wethVault: await wethVault.getAddress(),
    verifier: await verifier.getAddress(),
    anonAadhaar: await anonAadhaar.getAddress(),
    adapter: await adapter.getAddress(),
    zkVerifier: cfg.zkBackend === "anonAadhaar" ? await adapter.getAddress() : await verifier.getAddress(),
    maker: await maker.getAddress(),
  };
  const tokenA = BigInt(addr.usdc) < BigInt(addr.weth) ? addr.usdc : addr.weth;

  // ---- Maker: deposit capital into self-custodial ERC-4626 vaults (shares stay in Maker wallet)
  await usdc.mint(addr.maker, cfg.usdcLiquidity);
  await weth.connect(maker).deposit({ value: cfg.wethLiquidity });
  await usdc.connect(maker).approve(addr.usdcVault, cfg.usdcLiquidity);
  await weth.connect(maker).approve(addr.wethVault, cfg.wethLiquidity);
  await usdcVault.connect(maker).deposit(cfg.usdcLiquidity, addr.maker);
  await wethVault.connect(maker).deposit(cfg.wethLiquidity, addr.maker);

  // Aqua pulls tokenOut from the Maker wallet; the hook moves assets wallet <-> vault JIT
  for (const t of [usdc, weth]) {
    await t.connect(maker).approve(addr.aqua, ethers.MaxUint256);
    await t.connect(maker).approve(addr.hook, ethers.MaxUint256);
  }
  await usdcVault.connect(maker).approve(addr.hook, ethers.MaxUint256);
  await wethVault.connect(maker).approve(addr.hook, ethers.MaxUint256);

  // ---- Strategy
  const latest = await ethers.provider.getBlock("latest");
  const params: AegisStrategyParams = {
    maker: addr.maker,
    token0: addr.usdc,
    token1: addr.weth,
    vault0: cfg.useVaults ? addr.usdcVault : ethers.ZeroAddress,
    vault1: cfg.useVaults ? addr.wethVault : ethers.ZeroAddress,
    jitHook: cfg.useVaults ? addr.hook : ethers.ZeroAddress,
    deadline: BigInt(latest!.timestamp + 30 * 24 * 3600),
    zkVerifier: addr.zkVerifier,
    zkMode: cfg.zkMode,
    requiredStateCode: cfg.requiredStateCode,
    lambdaBps: cfg.lambdaBps,
    virtualBoostBps: cfg.virtualBoostBps,
    allocation0: cfg.usdcLiquidity,
    allocation1: cfg.wethLiquidity,
    // Hard floors (defaults): never sell WETH below 2,000 USDC, never buy WETH above 3,000 USDC
    floor01: cfg.useFloors ? { amountIn: USDC(cfg.minSellPriceUsdc), amountOut: WETH(1) } : undefined,
    floor10: cfg.useFloors ? { amountIn: WETH(1), amountOut: USDC(cfg.maxBuyPriceUsdc) } : undefined,
    baseFeeBps: cfg.baseFeeBps,
    maxSurgeFeeBps: cfg.maxSurgeFeeBps,
    impactThresholdBps: cfg.impactThresholdBps,
    decayWindowSec: cfg.decayWindowSec,
    salt: cfg.salt,
  };
  const order: Order = AegisProgramBuilder.buildOrder(params);

  // Aqua allocation = the Maker's full vault position (virtual balances; no tokens move)
  const shipTx = await aqua.connect(maker).ship(
    addr.router,
    AegisProgramBuilder.encodeStrategy(order),
    [addr.usdc, addr.weth],
    [cfg.usdcLiquidity, cfg.wethLiquidity],
  );
  const shipReceipt = await shipTx.wait();
  const orderHash: string = await router.hash(order);

  // ---- Takers
  for (const t of [human, bot, whale]) {
    const a = await t.getAddress();
    await usdc.mint(a, USDC(2_000_000));
    await weth.connect(t).deposit({ value: WETH(500) });
    await usdc.connect(t).approve(addr.router, ethers.MaxUint256);
    await weth.connect(t).approve(addr.router, ethers.MaxUint256);
  }

  const chainId: bigint = (await ethers.provider.getNetwork()).chainId;

  /**
   * Identity proof bound to `taker`, encoded as taker instruction args for 0x2A.
   *  - ecdsa backend: issuer-signed attestation
   *  - anonAadhaar backend: Groth16-shaped proof `abi.encode(timestamp, uint256[8])`, registered
   *    with the mock verifier for exactly (seed, nullifier, timestamp, signal = uint160(taker), reveal)
   */
  async function zkArgs(
    taker: string,
    reveal: RevealArray = MUMBAI_HUMAN_REVEAL,
    nullifier = 0xa11ce5n,
    opts: { timestamp?: bigint } = {},
  ): Promise<string> {
    if (cfg.zkBackend === "ecdsa") {
      const hash = zkAttestationHash(chainId, addr.verifier, taker, nullifier, reveal);
      const proof = await issuer.signMessage(ethers.getBytes(hash));
      return encodeZKTakerArgs(nullifier, reveal, proof);
    }
    const timestamp = opts.timestamp ?? BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
    const signal = BigInt(taker);
    const groth16 = Array.from({ length: 8 }, (_, i) =>
      BigInt(ethers.solidityPackedKeccak256(["uint256", "uint256", "uint256", "uint256"], [signal, nullifier, timestamp, i])),
    ) as unknown as bigint[];
    await (await anonAadhaar.connect(deployer).registerProof(AEGIS_NULLIFIER_SEED, nullifier, timestamp, signal, reveal, groth16)).wait();
    const proof = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256[8]"], [timestamp, groth16]);
    return encodeZKTakerArgs(nullifier, reveal, proof);
  }

  function takerData(opts: { tokenIn: string; exactIn?: boolean; zk?: BytesLike; threshold?: bigint }): string {
    return TakerTraitsLib.build({
      isExactIn: opts.exactIn ?? true,
      isAToB: opts.tokenIn.toLowerCase() === tokenA.toLowerCase(),
      useTransferFromAndAquaPush: true,
      threshold: opts.threshold,
      instructionsArgs: opts.zk,
    });
  }

  async function quote(signer: Signer, amount: bigint, td: string): Promise<{ amountIn: bigint; amountOut: bigint }> {
    const [amountIn, amountOut] = await router.connect(signer).quote.staticCall(order, amount, td);
    return { amountIn, amountOut };
  }

  async function swap(signer: Signer, amount: bigint, td: string): Promise<SwapResult> {
    const tx = await router.connect(signer).swap(order, amount, td);
    const receipt = (await tx.wait())!;
    const ev = receipt.logs
      .map((l) => { try { return router.interface.parseLog(l); } catch { return null; } })
      .find((e) => e?.name === "Swapped");
    if (!ev) throw new Error("Swapped event not found");
    return { amountIn: ev.args.amountIn as bigint, amountOut: ev.args.amountOut as bigint, tx, receipt };
  }

  async function vaultAssets(): Promise<{ usdc: bigint; weth: bigint }> {
    return {
      usdc: await usdcVault.convertToAssets(await usdcVault.balanceOf(addr.maker)),
      weth: await wethVault.convertToAssets(await wethVault.balanceOf(addr.maker)),
    };
  }

  async function aquaBalances(): Promise<{ usdc: bigint; weth: bigint }> {
    const [u] = await aqua.rawBalances(addr.maker, addr.router, orderHash, addr.usdc);
    const [w] = await aqua.rawBalances(addr.maker, addr.router, orderHash, addr.weth);
    return { usdc: u, weth: w };
  }

  return {
    cfg, params, order, orderHash, shipReceipt, chainId, issuer,
    accounts: { deployer, maker, human, bot, whale },
    contracts: { aqua, weth, usdc, router, hook, strategy, verifier, anonAadhaar, adapter, usdcVault, wethVault, quoter },
    addr, tokenA,
    zkArgs, takerData, quote, swap, vaultAssets, aquaBalances,
  };
}

export type AegisEnv = Awaited<ReturnType<typeof deployAegis>>;
