// SPDX-License-Identifier: MIT
// Deploys the complete AegisJIT demo stack on a public network (Sepolia) and ships the Maker's strategy.
//   npx hardhat run --network sepolia scripts/deploy-sepolia.ts
//
// Everything a judge needs to replay the demo is written to deployments/<network>/aegis.json.
// Mocks, on purpose (this is the hackathon demo, not production):
//   * USDC / WETH   mintable ERC-20 mocks (6 / 18 decimals) — Sepolia has no 400 ETH to wrap and no 1M USDC faucet
//   * vaults        MockERC4626Vault (OpenZeppelin ERC-4626) as the Maker's yield vaults
//   * World ID      MockWorldIDRouter (router + identity-manager semantics) in front of World ID's REAL
//                   SemaphoreVerifier; the identity tree is the project's local tree (packages/world-id)
//   * Aadhaar       the REAL Anon Aadhaar v2 Groth16 verifier, trust root = the public AegisJIT TEST signer
// Aqua, the router, the opcodes, the adapters and the hook are the real contracts.
import { AegisProgramBuilder, AegisStrategyParams, ZKMode, ZKVerifierType } from "../src/aegisProgramBuilder";
import {
  AEGIS_NULLIFIER_SEED, TEST_SIGNER_PUBKEY_HASH, USDC, WETH, WORLD_ID_GROUP, WORLD_ID_INITIAL_ROOT,
  worldIdArtifactsAvailable, worldIdTreeRoot,
} from "../test/utils/aegisFixture";
import { C, banner, fmtUsdc, fmtWeth, short, table } from "./lib/format";
import { ContractRecord, DeploymentRecord, TAKER_ROLES, addressLink, saveRecord, takerWallets, txLink } from "./lib/deployment";

const { ethers, network } = require("hardhat");

// Same economics as the local demo (test/utils/aegisFixture.ts DEFAULT_CONFIG)
const CFG = {
  usdcLiquidity: USDC(1_000_000),
  wethLiquidity: WETH(400),            // 2,500 USDC / WETH
  lambdaBps: 2_500,                    // λ = 25% per execution and per window
  virtualBoostBps: 20_000,             // 2.0x virtual depth
  exposureWindowSec: 600,
  baseFeeBps: 3_000_000,               // 0.30%
  maxSurgeFeeBps: 15_000_000,          // 1.50% marginal above threshold
  impactThresholdBps: 100n,            // surge starts at 1% utilisation of balanceIn
  decayWindowSec: 600,
  zkMode: ZKMode.TIERED,
  requiredStateCode: 0,
  minSellPriceUsdc: 2_000,
  maxBuyPriceUsdc: 3_000,
  maxProofAge: 30 * 24 * 3600,
  epochDuration: 24 * 3600,
  epochGrace: 600,
  worldIdAppId: "app_staging_aegis_jit_mumbai",
  worldIdAction: "aegis-jit-fee-tier",
  worldIdEpochDuration: 0,
  worldIdEpochGrace: 600,
  rootHistoryExpiry: 3600,
  takerUsdc: USDC(2_000_000),
  takerWeth: WETH(500),
  fundTakerEth: process.env.FUND_TAKER_ETH ?? "0.25",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error(`no deployer for network "${network.name}": set PRIVATE_KEY in .env`);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const deployerAddr = await deployer.getAddress();
  banner(`AegisJIT · deploy to ${network.name} (chainId ${chainId})`);
  console.log(`deployer / Maker ${deployerAddr}  balance ${ethers.formatEther(await ethers.provider.getBalance(deployerAddr))} ETH`);

  const contracts: Record<string, ContractRecord> = {};
  const deploy = async <T>(key: string, name: string, args: unknown[] = []): Promise<T> => {
    const factory = await ethers.getContractFactory(name);
    const c = await factory.deploy(...args);
    const rc = await c.deploymentTransaction()!.wait();
    const address = await c.getAddress();
    contracts[key] = { address, contract: name, constructorArgs: args, txHash: rc!.hash, blockNumber: rc!.blockNumber };
    console.log(`  ${C.green}✔${C.reset} ${key.padEnd(18)} ${address}  ${C.dim}gas ${rc!.gasUsed}${C.reset}`);
    return c as T;
  };
  const send = async (label: string, p: Promise<any>) => {
    const tx = await p;
    const rc = await tx.wait();
    console.log(`  ${C.dim}· ${label.padEnd(44)} ${short(rc.hash)}  gas ${rc.gasUsed}${C.reset}`);
    return rc;
  };

  // ---------------- takers
  banner("1 · Taker accounts (derived from TAKER_MNEMONIC in .env, funded by the deployer)");
  const takers = takerWallets();
  const fund = ethers.parseEther(CFG.fundTakerEth);
  for (const role of TAKER_ROLES) {
    const a = takers[role].address;
    const bal: bigint = await ethers.provider.getBalance(a);
    if (bal < fund) await send(`fund ${role} with ${CFG.fundTakerEth} ETH`, deployer.sendTransaction({ to: a, value: fund - bal }));
    console.log(`  ${role.padEnd(11)} ${a}  ${ethers.formatEther(await ethers.provider.getBalance(a))} ETH`);
  }

  // ---------------- core + mocks
  banner("2 · Contracts");
  const aqua = await deploy<any>("aqua", "Aqua");
  const usdc = await deploy<any>("usdc", "TokenCustomDecimalsMock", ["USD Coin (AegisJIT mock)", "USDC", 0, 6]);
  const weth = await deploy<any>("weth", "TokenCustomDecimalsMock", ["Wrapped Ether (AegisJIT mock)", "WETH", 0, 18]);
  const usdcAddr = await usdc.getAddress(), wethAddr = await weth.getAddress();
  const router = await deploy<any>("router", "AegisSwapVMRouter", [await aqua.getAddress(), wethAddr, deployerAddr, "AegisJIT", "1"]);
  const routerAddr = await router.getAddress();
  const hook = await deploy<any>("hook", "AegisJITVaultHook", [routerAddr]);
  await deploy<any>("strategy", "AegisJITStrategy");
  const forwarder = await deploy<any>("forwarder", "AegisZKForwarder", [routerAddr]);
  const usdcVault = await deploy<any>("usdcVault", "MockERC4626Vault", [usdcAddr, "Aegis USDC Vault", "avUSDC"]);
  const wethVault = await deploy<any>("wethVault", "MockERC4626Vault", [wethAddr, "Aegis WETH Vault", "avWETH"]);

  // ZK Aadhaar: real Groth16 (vendored snarkjs verifier) behind the key-set wrapper and the adapter
  const pairing = await deploy<any>("pairingVerifier", "contracts/zk/vendor/anon-aadhaar/Verifier.sol:Verifier");
  const groth16 = await deploy<any>("groth16", "AnonAadhaarGroth16Verifier", [await pairing.getAddress(), [TEST_SIGNER_PUBKEY_HASH]]);
  const adapter = await deploy<any>("adapter", "AnonAadhaarAdapter", [
    await groth16.getAddress(), AEGIS_NULLIFIER_SEED, CFG.epochDuration, CFG.epochGrace, CFG.maxProofAge, 0n,
  ]);

  // World ID: World ID's real SemaphoreVerifier behind the mock router; the local tree's root is the initial root
  const semaphore = await deploy<any>("semaphoreVerifier", "contracts/zk/vendor/world-id/SemaphoreVerifier.sol:SemaphoreVerifier");
  const initialRoot: bigint = worldIdArtifactsAvailable() ? await worldIdTreeRoot() : WORLD_ID_INITIAL_ROOT;
  const worldIdRouter = await deploy<any>("worldIdRouter", "MockWorldIDRouter", [
    await semaphore.getAddress(), deployerAddr, WORLD_ID_GROUP, initialRoot, CFG.rootHistoryExpiry,
  ]);
  const worldIdAdapter = await deploy<any>("worldIdAdapter", "WorldIDAdapter", [
    await worldIdRouter.getAddress(), WORLD_ID_GROUP, CFG.worldIdAppId, CFG.worldIdAction, CFG.worldIdEpochDuration, CFG.worldIdEpochGrace,
  ]);

  // ---------------- Maker: capital into the vaults, allowances for Aqua + hook
  banner("3 · Maker capital → ERC-4626 vaults, allowances");
  const usdcVaultAddr = await usdcVault.getAddress(), wethVaultAddr = await wethVault.getAddress(), hookAddr = await hook.getAddress(), aquaAddr = await aqua.getAddress();
  await send("mint 1,000,000 USDC to Maker", usdc.mint(deployerAddr, CFG.usdcLiquidity));
  await send("mint 400 WETH to Maker", weth.mint(deployerAddr, CFG.wethLiquidity));
  await send("approve USDC → vault", usdc.approve(usdcVaultAddr, CFG.usdcLiquidity));
  await send("approve WETH → vault", weth.approve(wethVaultAddr, CFG.wethLiquidity));
  await send("deposit 1,000,000 USDC into avUSDC", usdcVault.deposit(CFG.usdcLiquidity, deployerAddr));
  await send("deposit 400 WETH into avWETH", wethVault.deposit(CFG.wethLiquidity, deployerAddr));
  for (const [t, label] of [[usdc, "USDC"], [weth, "WETH"]] as const) {
    await send(`approve ${label} → Aqua (pull)`, t.approve(aquaAddr, ethers.MaxUint256));
    await send(`approve ${label} → JIT hook (re-deposit)`, t.approve(hookAddr, ethers.MaxUint256));
  }
  await send("approve avUSDC shares → JIT hook (withdraw)", usdcVault.approve(hookAddr, ethers.MaxUint256));
  await send("approve avWETH shares → JIT hook (withdraw)", wethVault.approve(hookAddr, ethers.MaxUint256));

  // ---------------- strategy
  banner("4 · Ship the AegisJIT strategy to Aqua (virtual balances; no tokens move)");
  const latest = await ethers.provider.getBlock("latest");
  const params: AegisStrategyParams = {
    maker: deployerAddr,
    token0: usdcAddr, token1: wethAddr,
    vault0: usdcVaultAddr, vault1: wethVaultAddr,
    jitHook: hookAddr,
    deadline: BigInt(latest!.timestamp + 30 * 24 * 3600),
    zkVerifierTypes: ZKVerifierType.ANY,
    worldIdVerifier: await worldIdAdapter.getAddress(),
    aadhaarVerifier: await adapter.getAddress(),
    zkMode: CFG.zkMode,
    requiredStateCode: CFG.requiredStateCode,
    lambdaBps: CFG.lambdaBps,
    virtualBoostBps: CFG.virtualBoostBps,
    exposureWindowSec: CFG.exposureWindowSec,
    allocation0: CFG.usdcLiquidity, allocation1: CFG.wethLiquidity,
    floor01: { amountIn: USDC(CFG.minSellPriceUsdc), amountOut: WETH(1) },
    floor10: { amountIn: WETH(1), amountOut: USDC(CFG.maxBuyPriceUsdc) },
    baseFeeBps: CFG.baseFeeBps, maxSurgeFeeBps: CFG.maxSurgeFeeBps,
    impactThresholdBps: CFG.impactThresholdBps, decayWindowSec: CFG.decayWindowSec,
    salt: 0n,
  };
  const order = AegisProgramBuilder.buildOrder(params);
  const shipRc = await send("Aqua.ship(router, strategy, [USDC, WETH], [1M, 400])",
    aqua.ship(routerAddr, AegisProgramBuilder.encodeStrategy(order), [usdcAddr, wethAddr], [CFG.usdcLiquidity, CFG.wethLiquidity]));
  const orderHash: string = await router.hash(order);

  // ---------------- takers: tokens + router allowances
  banner("5 · Takers: mint mock tokens, approve the router");
  for (const role of TAKER_ROLES) {
    const w = takers[role];
    await send(`mint 2,000,000 USDC to ${role}`, usdc.mint(w.address, CFG.takerUsdc));
    await send(`mint 500 WETH to ${role}`, weth.mint(w.address, CFG.takerWeth));
    await send(`${role}: approve USDC → router`, usdc.connect(w).approve(routerAddr, ethers.MaxUint256));
    await send(`${role}: approve WETH → router`, weth.connect(w).approve(routerAddr, ethers.MaxUint256));
  }
  await send("human: approve USDC → forwarder (aggregator scenario)", usdc.connect(takers.human).approve(await forwarder.getAddress(), ethers.MaxUint256));

  // ---------------- record
  const rec: DeploymentRecord = {
    network: network.name, chainId, deployedAt: new Date().toISOString(),
    deployer: deployerAddr, maker: deployerAddr,
    takers: Object.fromEntries(TAKER_ROLES.map((r) => [r, takers[r].address])) as any,
    contracts,
    cfg: Object.fromEntries(Object.entries(CFG).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])) as any,
    params: params as any,
    order, orderHash,
    ship: { txHash: shipRc.hash, blockNumber: shipRc.blockNumber },
    notes: [
      "USDC and WETH are mintable ERC-20 mocks (TokenCustomDecimalsMock, 6 / 18 decimals).",
      "MockERC4626Vault = OpenZeppelin ERC-4626; the Maker's capital sits there, the hook moves it JIT.",
      "World ID: MockWorldIDRouter (router + identity-manager semantics) in front of World ID's real SemaphoreVerifier; identity tree = packages/world-id local tree.",
      "ZK Aadhaar: real Anon Aadhaar v2 Groth16 verifier; trust root = the public AegisJIT TEST signer, NOT UIDAI.",
      "Order deadline: 30 days after deployment.",
    ],
  };
  const file = saveRecord(rec);

  banner("Summary");
  table(`AegisJIT on ${network.name}`, [
    ["Maker (deployer)", addressLink(chainId, deployerAddr)],
    ...Object.entries(contracts).map(([k, c]) => [k, addressLink(chainId, c.address)] as [string, string]),
    ["orderHash", orderHash],
    ["ship tx", txLink(chainId, shipRc.hash)],
    ["Maker vault position", `${fmtUsdc(await usdcVault.convertToAssets(await usdcVault.balanceOf(deployerAddr)), 0)} USDC + ${fmtWeth(await wethVault.convertToAssets(await wethVault.balanceOf(deployerAddr)), 0)} WETH`],
    ["record", file],
  ]);
  console.log(`\nnext: npx hardhat run --network ${network.name} scripts/verify-sepolia.ts   then   scripts/demo-sepolia.ts\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
