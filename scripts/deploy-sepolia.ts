// SPDX-License-Identifier: MIT
// Deploys the complete AegisJIT demo stack on a public network (Sepolia) and ships the Maker's strategy.
//   npx hardhat run --network sepolia scripts/deploy-sepolia.ts
//   ORDER_SALT=1 npx hardhat run --network sepolia scripts/deploy-sepolia.ts   # reuse the contracts, ship a fresh order
//   REDEPLOY=worldIdAdapter ORDER_SALT=2 ...                                    # redeploy named contracts (e.g. a new World ID app id) and re-ship
//   WORLD_ID_ROUTER=0x57f9… npx hardhat run --network worldchainSepolia scripts/deploy-sepolia.ts
//                                              # real World ID Router instead of the mock; app id from WORLD_ID_APP_ID
//                                              # (falls back to WORLD_ID_STAGING_APP_ID, then the local placeholder id)
//
// Resumable and idempotent: every deployed contract is checkpointed to deployments/<network>/aegis.partial.json
// and every setup step checks on-chain state before sending (balances, allowances, vault positions, Aqua
// book), so re-running after an RPC hiccup continues where it stopped instead of redeploying.
// Everything a judge needs to replay the demo is written to deployments/<network>/aegis.json.
//
// Mocks, on purpose (this is the hackathon demo, not production):
//   * USDC / WETH   mintable ERC-20 mocks (6 / 18 decimals) — Sepolia has no 400 ETH to wrap and no 1M USDC faucet
//   * vaults        MockERC4626Vault (OpenZeppelin ERC-4626) as the Maker's yield vaults
//   * World ID      MockWorldIDRouter (router + identity-manager semantics) in front of World ID's REAL
//                   SemaphoreVerifier; the identity tree is the project's local tree (packages/world-id)
//   * Aadhaar       the REAL Anon Aadhaar v2 Groth16 verifier, trust root = the public AegisJIT TEST signer
// Aqua, the router, the opcodes, the adapters and the hook are the real contracts.
import * as fs from "fs";
import * as path from "path";
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
  worldIdAppId: process.env.WORLD_ID_APP_ID || process.env.WORLD_ID_STAGING_APP_ID || "app_staging_aegis_jit_mumbai",
  worldIdAction: "aegis-jit-fee-tier",
  worldIdEpochDuration: 0,
  worldIdEpochGrace: 600,
  rootHistoryExpiry: 3600,
  takerUsdc: USDC(2_000_000),
  takerWeth: WETH(500),
  fundTakerEth: process.env.FUND_TAKER_ETH ?? "0.25",
};

/** A real World ID Router address makes the deployment verify World App / Simulator proofs instead of the local tree */
const WORLD_ID_ROUTER = process.env.WORLD_ID_ROUTER ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isConnectionError = (e: any) => /timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|network error|fetch failed|other side closed|503|502|429/i.test(String(e?.message ?? e));

interface Partial { network: string; chainId: number; contracts: Record<string, ContractRecord>; params?: any; order?: any; ship?: any }
const ORDER_SALT = BigInt(process.env.ORDER_SALT ?? "0");
/** record keys to deploy again even though the record has them (comma-separated), e.g. REDEPLOY=worldIdAdapter after changing the World ID app id */
const REDEPLOY = (process.env.REDEPLOY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const partialPath = () => path.join(__dirname, "..", "deployments", network.name, "aegis.partial.json");
const toJson = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error(`no deployer for network "${network.name}": set PRIVATE_KEY in .env`);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const deployerAddr = await deployer.getAddress();
  banner(`AegisJIT · deploy to ${network.name} (chainId ${chainId})`);
  console.log(`deployer / Maker ${deployerAddr}  balance ${ethers.formatEther(await ethers.provider.getBalance(deployerAddr))} ETH`);

  // ---------------- checkpoint
  let partial: Partial = { network: network.name, chainId, contracts: {} };
  let previousOrders: Array<{ orderHash: string; salt: string; shipTx: string }> = [];
  const finalPath = path.join(__dirname, "..", "deployments", network.name, "aegis.json");
  if (fs.existsSync(partialPath())) {
    partial = JSON.parse(fs.readFileSync(partialPath(), "utf8"));
    if (partial.chainId !== chainId) throw new Error(`partial record is for chainId ${partial.chainId}, connected to ${chainId}`);
    console.log(`${C.yellow}resuming: ${Object.keys(partial.contracts).length} contracts already deployed (${partialPath()})${C.reset}`);
  } else if (fs.existsSync(finalPath)) {
    // a finished deployment: reuse every contract; a new ORDER_SALT ships a fresh order (fresh fee / budget buckets)
    const prev: DeploymentRecord = JSON.parse(fs.readFileSync(finalPath, "utf8"));
    if (prev.chainId !== chainId) throw new Error(`deployment record is for chainId ${prev.chainId}, connected to ${chainId}`);
    partial.contracts = prev.contracts;
    previousOrders = [...((prev as any).previousOrders ?? [])];
    if (BigInt((prev.params as any).salt ?? 0) === ORDER_SALT) partial.params = prev.params;
    else previousOrders.push({ orderHash: prev.orderHash, salt: String((prev.params as any).salt ?? 0), shipTx: prev.ship.txHash });
    console.log(`${C.yellow}reusing the finished deployment in ${finalPath} (${Object.keys(partial.contracts).length} contracts); order salt ${ORDER_SALT}${C.reset}`);
  }
  const checkpoint = () => { fs.mkdirSync(path.dirname(partialPath()), { recursive: true }); fs.writeFileSync(partialPath(), toJson(partial) + "\n"); };

  /** Retries a provider-level call that failed before anything was broadcast */
  const withRetry = async <T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> => {
    for (let i = 1; ; i++) {
      try { return await fn(); } catch (e: any) {
        if (i >= attempts || !isConnectionError(e)) throw e;
        console.log(`  ${C.yellow}· ${label}: ${String(e.message ?? e).split("\n")[0].slice(0, 80)} — retry ${i}/${attempts - 1} in 15 s${C.reset}`);
        await sleep(15_000);
      }
    }
  };
  /** Waits for a receipt by hash, surviving RPC stalls */
  const waitReceipt = async (hash: string) => {
    for (let i = 0; i < 60; i++) {
      try { const rc = await ethers.provider.getTransactionReceipt(hash); if (rc) return rc; } catch (e) { if (!isConnectionError(e)) throw e; }
      await sleep(5_000);
    }
    throw new Error(`no receipt for ${hash} after 5 minutes`);
  };

  const deploy = async <T>(key: string, name: string, args: unknown[] = []): Promise<T> => {
    const existing = REDEPLOY.includes(key) ? undefined : partial.contracts[key];
    if (existing) {
      existing.constructorArgs = args; // keep the record's args exact (placeholders from a reconstructed checkpoint)
      console.log(`  ${C.dim}↺ ${key.padEnd(18)} ${existing.address}  (already deployed, reused)${C.reset}`);
      return (await ethers.getContractAt(name, existing.address)) as T; // fully qualified names are fine here
    }
    const factory = await ethers.getContractFactory(name);
    const c: any = await withRetry(`deploy ${key}`, () => factory.deploy(...args));
    const rc = await waitReceipt(c.deploymentTransaction()!.hash);
    const address = await c.getAddress();
    partial.contracts[key] = { address, contract: name, constructorArgs: args, txHash: rc!.hash, blockNumber: rc!.blockNumber };
    checkpoint();
    console.log(`  ${C.green}✔${C.reset} ${key.padEnd(18)} ${address}  ${C.dim}gas ${rc!.gasUsed}${C.reset}`);
    return c as T;
  };
  const send = async (label: string, fn: () => Promise<any>) => {
    const tx = await withRetry(label, fn);
    const rc = await waitReceipt(tx.hash);
    console.log(`  ${C.dim}· ${label.padEnd(50)} ${short(rc.hash)}  gas ${rc.gasUsed}${C.reset}`);
    return rc;
  };
  const skip = (label: string) => console.log(`  ${C.dim}= ${label.padEnd(50)} already done${C.reset}`);
  const MAX_HALF = ethers.MaxUint256 / 2n;
  const ensureAllowance = async (token: any, owner: any, ownerAddr: string, spender: string, label: string) => {
    if ((await token.allowance(ownerAddr, spender)) >= MAX_HALF) return skip(label);
    await send(label, () => token.connect(owner).approve(spender, ethers.MaxUint256));
  };
  const ensureBalance = async (token: any, holder: string, target: bigint, label: string) => {
    const bal: bigint = await token.balanceOf(holder);
    if (bal >= target) return skip(label);
    await send(label, () => token.mint(holder, target - bal));
  };

  // ---------------- takers
  banner("1 · Taker accounts (derived from TAKER_MNEMONIC in .env, funded by the deployer)");
  const takers = takerWallets();
  const fund = ethers.parseEther(CFG.fundTakerEth);
  for (const role of TAKER_ROLES) {
    const a = takers[role].address;
    const bal: bigint = await ethers.provider.getBalance(a);
    if (bal < fund) await send(`fund ${role} with ${CFG.fundTakerEth} ETH`, () => deployer.sendTransaction({ to: a, value: fund - bal }));
    else skip(`fund ${role}`);
    console.log(`  ${role.padEnd(11)} ${a}  ${ethers.formatEther(await ethers.provider.getBalance(a))} ETH`);
  }

  // ---------------- core + mocks
  banner("2 · Contracts");
  const aqua = await deploy<any>("aqua", "Aqua");
  const usdc = await deploy<any>("usdc", "TokenCustomDecimalsMock", ["USD Coin (AegisJIT mock)", "USDC", 0, 6]);
  const weth = await deploy<any>("weth", "TokenCustomDecimalsMock", ["Wrapped Ether (AegisJIT mock)", "WETH", 0, 18]);
  const usdcAddr = await usdc.getAddress(), wethAddr = await weth.getAddress(), aquaAddr = await aqua.getAddress();
  const router = await deploy<any>("router", "AegisSwapVMRouter", [aquaAddr, wethAddr, deployerAddr, "AegisJIT", "1"]);
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

  // World ID: either the REAL World ID Router of this chain (World App / Simulator proofs), or World ID's real
  // SemaphoreVerifier behind the project's mock router with the local tree's root as the initial root
  let worldIdRouterAddr: string;
  if (WORLD_ID_ROUTER) {
    if ((await ethers.provider.getCode(WORLD_ID_ROUTER)) === "0x") throw new Error(`WORLD_ID_ROUTER ${WORLD_ID_ROUTER} has no code on ${network.name}`);
    worldIdRouterAddr = WORLD_ID_ROUTER;
    console.log(`  ${C.green}✔${C.reset} worldIdRouter      ${worldIdRouterAddr}  ${C.dim}(World ID's router on this chain, not deployed by us)${C.reset}`);
  } else {
    const semaphore = await deploy<any>("semaphoreVerifier", "contracts/zk/vendor/world-id/SemaphoreVerifier.sol:SemaphoreVerifier");
    const initialRoot: bigint = worldIdArtifactsAvailable() ? await worldIdTreeRoot() : WORLD_ID_INITIAL_ROOT;
    const worldIdRouter = await deploy<any>("worldIdRouter", "MockWorldIDRouter", [
      await semaphore.getAddress(), deployerAddr, WORLD_ID_GROUP, initialRoot, CFG.rootHistoryExpiry,
    ]);
    worldIdRouterAddr = await worldIdRouter.getAddress();
  }
  const worldIdAdapter = await deploy<any>("worldIdAdapter", "WorldIDAdapter", [
    worldIdRouterAddr, WORLD_ID_GROUP, CFG.worldIdAppId, CFG.worldIdAction, CFG.worldIdEpochDuration, CFG.worldIdEpochGrace,
  ]);
  checkpoint();

  // ---------------- Maker: capital into the vaults, allowances for Aqua + hook (all idempotent)
  banner("3 · Maker capital → ERC-4626 vaults, allowances");
  const usdcVaultAddr = await usdcVault.getAddress(), wethVaultAddr = await wethVault.getAddress(), hookAddr = await hook.getAddress();
  for (const [token, vault, vaultAddr, target, sym, fmt] of [
    [usdc, usdcVault, usdcVaultAddr, CFG.usdcLiquidity, "USDC", (v: bigint) => fmtUsdc(v, 0)],
    [weth, wethVault, wethVaultAddr, CFG.wethLiquidity, "WETH", (v: bigint) => fmtWeth(v, 0)],
  ] as const) {
    const inVault: bigint = await vault.convertToAssets(await vault.balanceOf(deployerAddr));
    if (inVault >= target) { skip(`Maker ${sym} vault position (${fmt(inVault)})`); continue; }
    const missing = target - inVault;
    await ensureBalance(token, deployerAddr, missing, `mint ${fmt(missing)} ${sym} to Maker`);
    if ((await token.allowance(deployerAddr, vaultAddr)) < missing) await send(`approve ${sym} → vault`, () => token.approve(vaultAddr, missing));
    await send(`deposit ${fmt(missing)} ${sym} into the ${sym} vault`, () => vault.deposit(missing, deployerAddr));
  }
  for (const [t, label] of [[usdc, "USDC"], [weth, "WETH"]] as const) {
    await ensureAllowance(t, deployer, deployerAddr, aquaAddr, `approve ${label} → Aqua (pull)`);
    await ensureAllowance(t, deployer, deployerAddr, hookAddr, `approve ${label} → JIT hook (re-deposit)`);
  }
  await ensureAllowance(usdcVault, deployer, deployerAddr, hookAddr, "approve avUSDC shares → JIT hook (withdraw)");
  await ensureAllowance(wethVault, deployer, deployerAddr, hookAddr, "approve avWETH shares → JIT hook (withdraw)");

  // ---------------- strategy (params are checkpointed so a resume ships the same order, not a new one)
  banner("4 · Ship the AegisJIT strategy to Aqua (virtual balances; no tokens move)");
  let params: AegisStrategyParams;
  if (partial.params) {
    params = { ...partial.params, deadline: BigInt(partial.params.deadline), allocation0: BigInt(partial.params.allocation0), allocation1: BigInt(partial.params.allocation1),
      impactThresholdBps: BigInt(partial.params.impactThresholdBps), salt: BigInt(partial.params.salt ?? 0),
      floor01: { amountIn: BigInt(partial.params.floor01.amountIn), amountOut: BigInt(partial.params.floor01.amountOut) },
      floor10: { amountIn: BigInt(partial.params.floor10.amountIn), amountOut: BigInt(partial.params.floor10.amountOut) } };
  } else {
    const latest = await ethers.provider.getBlock("latest");
    params = {
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
      salt: ORDER_SALT,
    };
    partial.params = params; checkpoint();
  }
  const order = AegisProgramBuilder.buildOrder(params);
  const orderHash: string = await router.hash(order);
  const [, shippedCount] = await aqua.rawBalances(deployerAddr, routerAddr, orderHash, usdcAddr);
  let shipRc: any;
  if (shippedCount !== 0n) {
    skip(`Aqua.ship (orderHash ${short(orderHash)} already active)`);
    shipRc = (partial as any).ship ?? { hash: "(shipped in an earlier run)", blockNumber: 0 };
  } else {
    shipRc = await send("Aqua.ship(router, strategy, [USDC, WETH], [1M, 400])",
      () => aqua.ship(routerAddr, AegisProgramBuilder.encodeStrategy(order), [usdcAddr, wethAddr], [CFG.usdcLiquidity, CFG.wethLiquidity]));
    (partial as any).ship = { hash: shipRc.hash, blockNumber: shipRc.blockNumber }; checkpoint();
  }

  // ---------------- takers: tokens + router allowances
  banner("5 · Takers: mint mock tokens, approve the router");
  for (const role of TAKER_ROLES) {
    const w = takers[role];
    await ensureBalance(usdc, w.address, CFG.takerUsdc, `mint 2,000,000 USDC to ${role}`);
    await ensureBalance(weth, w.address, CFG.takerWeth, `mint 500 WETH to ${role}`);
    await ensureAllowance(usdc, w, w.address, routerAddr, `${role}: approve USDC → router`);
    await ensureAllowance(weth, w, w.address, routerAddr, `${role}: approve WETH → router`);
  }
  await ensureAllowance(usdc, takers.human, takers.human.address, await forwarder.getAddress(), "human: approve USDC → forwarder (aggregator scenario)");

  // ---------------- record
  const rec: DeploymentRecord = {
    network: network.name, chainId, deployedAt: new Date().toISOString(),
    deployer: deployerAddr, maker: deployerAddr,
    takers: Object.fromEntries(TAKER_ROLES.map((r) => [r, takers[r].address])) as any,
    contracts: partial.contracts,
    cfg: Object.fromEntries(Object.entries(CFG).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])) as any,
    params: params as any,
    order, orderHash,
    ship: { txHash: shipRc.hash, blockNumber: shipRc.blockNumber },
    ...(previousOrders.length ? { previousOrders } : {}),
    worldId: { router: worldIdRouterAddr, mock: !WORLD_ID_ROUTER, appId: CFG.worldIdAppId, action: CFG.worldIdAction },
    notes: [
      "USDC and WETH are mintable ERC-20 mocks (TokenCustomDecimalsMock, 6 / 18 decimals).",
      "MockERC4626Vault = OpenZeppelin ERC-4626; the Maker's capital sits there, the hook moves it JIT.",
      WORLD_ID_ROUTER
        ? `World ID: the chain's World ID Router (${WORLD_ID_ROUTER}); proofs come from World App / the World ID Simulator via IDKit for app ${CFG.worldIdAppId}, action ${CFG.worldIdAction}.`
        : "World ID: MockWorldIDRouter (router + identity-manager semantics) in front of World ID's real SemaphoreVerifier; identity tree = packages/world-id local tree.",
      "ZK Aadhaar: real Anon Aadhaar v2 Groth16 verifier; trust root = the public AegisJIT TEST signer, NOT UIDAI.",
      "Order deadline: 30 days after deployment.",
    ],
  };
  const file = saveRecord(rec);

  banner("Summary");
  table(`AegisJIT on ${network.name}`, [
    ["Maker (deployer)", addressLink(chainId, deployerAddr)],
    ...Object.entries(partial.contracts).map(([k, c]) => [k, addressLink(chainId, c.address)] as [string, string]),
    ["orderHash", orderHash],
    ["ship tx", shipRc.hash.startsWith("0x") ? txLink(chainId, shipRc.hash) : shipRc.hash],
    ["Maker vault position", `${fmtUsdc(await usdcVault.convertToAssets(await usdcVault.balanceOf(deployerAddr)), 0)} USDC + ${fmtWeth(await wethVault.convertToAssets(await wethVault.balanceOf(deployerAddr)), 0)} WETH`],
    ["record", file],
  ]);
  console.log(`\nnext: npx hardhat run --network ${network.name} scripts/verify-sepolia.ts   then   scripts/demo-sepolia.ts\n`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
