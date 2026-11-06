// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
// Powered by SwapVM — © Degensoft Ltd 2025. Imports the swap-vm-template helpers
// (test/utils/SwapVMHelpers.ts), so this file is licensed under SwapVM-1.1 (created 2026-11-05).
// Shared deployment + helpers for AegisJIT tests and the Mumbai demo script.

import { BytesLike, Signer, Wallet, ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import { spawn } from "child_process";
import { existsSync } from "fs";
import * as path from "path";

import { TakerTraitsLib } from "./SwapVMHelpers";
import {
  AegisProgramBuilder,
  AegisStrategyParams,
  Order,
  ZKMode,
  ZKVerifierType,
  encodeWorldIdProofEnvelope,
  encodeWorldIdTakerArgs,
  encodeZKTakerArgs,
  worldIdSignalHash,
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
  AnonAadhaarGroth16Verifier,
  AegisZKForwarder,
  WorldIDAdapter,
  MockWorldIDRouter,
  MockSemaphoreVerifier,
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
/** Circuit pubkeyHash of the AegisJIT TEST signer (packages/zk-aadhaar/prover/test-signer) — local trust root */
export const TEST_SIGNER_PUBKEY_HASH = 179423072149871449489663359223133821359370095615226024492284075770447210161n;
/** Anon Aadhaar production trust root (UIDAI 2021 key), from anon-aadhaar core constants */
export const UIDAI_2021_PUBKEY_HASH = 18063425702624337643644061197836918910810808173893535653269228433734128853484n;
/** revealArray[3] for "Maharashtra" as packed by the Anon Aadhaar circuit */
export const MAHARASHTRA_PACKED = 117806301630445265963475277n;

export interface RealProof {
  digits: string;
  qr: { version: string; rsa: { status: string; key: string | null }; state: string; signedDataSha256: string };
  proof: {
    groth16Proof: string[];
    publicSignals: Record<"pubkeyHash" | "nullifier" | "timestamp" | "ageAbove18" | "gender" | "pincode" | "state" | "nullifierSeed" | "signalHash", string>;
    provingMs: number;
    stateText: string;
  };
}

const PROVER_DIR = path.join(__dirname, "..", "..", "packages", "zk-aadhaar");

/**
 * Runs a JSON-printing prover CLI in a subprocess WITHOUT blocking the event loop. A synchronous
 * spawn would stall the loop for the whole proving time (~13 s for Anon Aadhaar); against a live
 * JSON-RPC node that leaves stale keep-alive sockets behind and the next request dies with
 * ECONNRESET. Async spawn lets the HTTP client notice closed connections while we wait.
 */
function runJsonCli(pkgDir: string, args: string[]): Promise<any> {
  const bin = path.join(pkgDir, "node_modules", ".bin", "tsx");
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: pkgDir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${path.basename(pkgDir)} prover ${args.slice(0, 2).join(" ")} failed (exit ${code}): ${err || out}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

/** Real pipeline in a subprocess: synthetic V2 Secure QR -> zkAadhaar parse + RSA -> Groth16 (snarkjs) */
export function generateRealProof(o: { timestamp: number; seed: bigint; signal: string }): Promise<RealProof> {
  // signal = the beneficiary address the proof commits to
  return runJsonCli(PROVER_DIR, ["prover/cli.ts", "e2e", "--timestamp", String(o.timestamp), "--seed", o.seed.toString(), "--signal", o.signal]);
}

/**
 * 0x2A taker args for a real proof: [L][nullifier][revealArray][envelope]
 *   envelope = abi.encode(timestamp, uint256[8])             (direct)
 *            | abi.encode(timestamp, recipient, uint256[8])  (via a trusted forwarder)
 */
export function encodeRealProofTakerArgs(p: RealProof, tamper = false, recipient?: string): string {
  const ps = p.proof.publicSignals;
  const words = p.proof.groth16Proof.map(BigInt);
  if (tamper) words[7] = words[7] ^ 1n;
  const proofBytes = encodeEnvelope(BigInt(ps.timestamp), words, recipient);
  return encodeZKTakerArgs(BigInt(ps.nullifier), [BigInt(ps.ageAbove18), BigInt(ps.gender), BigInt(ps.pincode), BigInt(ps.state)], proofBytes);
}

export function encodeEnvelope(timestamp: bigint, words: bigint[], recipient?: string): string {
  const c = ethers.AbiCoder.defaultAbiCoder();
  return recipient
    ? c.encode(["uint256", "address", "uint256[8]"], [timestamp, recipient, words])
    : c.encode(["uint256", "uint256[8]"], [timestamp, words]);
}

// ---------------------------------------------------------------- World ID (Semaphore v3, depth 30)
const WORLD_ID_PROVER_DIR = path.join(__dirname, "..", "..", "packages", "world-id");
const WORLD_ID_ZKEY = path.join(__dirname, "..", "..", ".cache", "semaphore", "30", "semaphore.zkey");
/** Identity seeds of the local "World ID" tree (mirror of packages/world-id DEFAULT_MEMBERS) */
export const WORLD_ID_MEMBERS = ["human", "alice", "bob", "carol", "dave"];

export function worldIdArtifactsAvailable(): boolean {
  return existsSync(WORLD_ID_ZKEY);
}

export interface WorldIdProof {
  root: string;
  nullifierHash: string;
  signalHash: string;
  externalNullifierHash: string;
  identityCommitment: string;
  memberIndex: number;
  /** [a0, a1, b01, b00, b11, b10, c0, c1] */
  proof: string[];
  /** [root, nullifierHash, signalHash, externalNullifierHash] */
  publicSignals: string[];
  provingMs: number;
}

const worldIdCli = (args: string[]): Promise<any> => runJsonCli(WORLD_ID_PROVER_DIR, ["prover/cli.ts", ...args]);

/** Real Semaphore depth-30 Groth16 proof (subprocess, ~0.5 s) for a member of the local tree, bound to `signal` */
export function generateWorldIdProof(o: { identity: string; signal: string; externalNullifier: bigint; members?: string[] }): Promise<WorldIdProof> {
  const args = ["prove", "--identity", o.identity, "--signal", o.signal, "--external-nullifier", o.externalNullifier.toString()];
  if (o.members) args.push("--members", o.members.join(","));
  return worldIdCli(args);
}

/** Root of the local tree (what the sequencer publishes to the router) */
export async function worldIdTreeRoot(members?: string[]): Promise<bigint> {
  return BigInt((await worldIdCli(members ? ["root", "--members", members.join(",")] : ["root"])).root);
}

/** 0x2A type-1 taker args for a World ID proof: [L][0x01][nullifierHash][abi.encode(root, [recipient,] uint256[8])] */
export function encodeWorldIdProofTakerArgs(p: WorldIdProof, opts: { tamper?: boolean; recipient?: string } = {}): string {
  const words = p.proof.map(BigInt);
  if (opts.tamper) words[7] = words[7] ^ 1n;
  return encodeWorldIdTakerArgs(BigInt(p.nullifierHash), encodeWorldIdProofEnvelope(BigInt(p.root), words, opts.recipient));
}

/** App-scoped nullifier seed for the Anon Aadhaar adapter */
export const AEGIS_NULLIFIER_SEED = BigInt(ethers.id("aegis-jit/anon-aadhaar/nullifier-seed")) >> 8n;
/** World ID: Orb-verified humans are Semaphore group 1 */
export const WORLD_ID_GROUP = 1n;
/** Root the local MockWorldIDRouter starts with (any nonzero value; real roots are registered later) */
export const WORLD_ID_INITIAL_ROOT = BigInt(ethers.id("aegis-jit/world-id/initial-root")) >> 8n;
export const MAHARASHTRA = 27;

export interface AegisConfig {
  usdcLiquidity: bigint;
  wethLiquidity: bigint;
  lambdaBps: number;
  virtualBoostBps: number;
  /** λ budget window: cumulative tokenOut per window <= λ of the backing (0 = per-execution cap only) */
  exposureWindowSec: number;
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
  /**
   * "ecdsa"       = MockAnonIdentityVerifier
   * "anonAadhaar" = AnonAadhaarAdapter over MockGroth16AnonAadhaar (fast, for unit tests)
   * "groth16"     = AnonAadhaarAdapter over AnonAadhaarGroth16Verifier + real BN254 Verifier.sol
   */
  zkBackend: "ecdsa" | "anonAadhaar" | "groth16";
  groth16TrustRoot: bigint;
  maxProofAge: number;
  adapterRequiredState: bigint;
  /** Anon Aadhaar nullifier epoch (0 = static app seed; >0 = nullifierSeed rotates every epoch) */
  epochDuration: number;
  /** 0x2A proof types the Maker accepts: 1 World ID, 2 ZK Aadhaar, 3 either */
  zkVerifierTypes: number;
  /** World ID app id + action behind the adapter's external nullifier */
  worldIdAppId: string;
  worldIdAction: string;
  /** MockWorldIDRouter root-history expiry in seconds (World ID default: 1 hour) */
  rootHistoryExpiry: number;
  /**
   * "mock"      = MockSemaphoreVerifier behind the router (fast; registered statements)
   * "semaphore" = World ID's vendored SemaphoreVerifier (real BN254 pairing; proofs from packages/world-id)
   */
  worldIdBackend: "mock" | "semaphore";
}

export const DEFAULT_CONFIG: AegisConfig = {
  usdcLiquidity: USDC(1_000_000),
  wethLiquidity: WETH(400),          // 2,500 USDC / WETH
  lambdaBps: 2_500,                  // λ = 25% of the vault exposed per execution
  virtualBoostBps: 20_000,           // 2.0x virtual depth
  exposureWindowSec: 600,            // λ is a budget per 10-minute window, across all executions
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
  groth16TrustRoot: TEST_SIGNER_PUBKEY_HASH,
  maxProofAge: 24 * 3600,
  adapterRequiredState: 0n,
  epochDuration: 0,
  zkVerifierTypes: ZKVerifierType.ANY,
  worldIdAppId: "app_staging_aegis_jit_mumbai",
  worldIdAction: "aegis-jit-fee-tier",
  rootHistoryExpiry: 3600,
  worldIdBackend: "mock",
};

export interface SwapResult {
  amountIn: bigint;
  amountOut: bigint;
  tx: ContractTransactionResponse;
  receipt: ContractTransactionReceipt;
}

export async function deployAegis(overrides: Partial<AegisConfig> = {}) {
  const cfg: AegisConfig = { ...DEFAULT_CONFIG, ...overrides };
  const [deployer, maker, human, bot, whale, worldHuman] = (await ethers.getSigners()) as Signer[];
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
  const pairingVerifier = await deploy<any>("contracts/zk/vendor/anon-aadhaar/Verifier.sol:Verifier");
  const groth16 = await deploy<AnonAadhaarGroth16Verifier>("AnonAadhaarGroth16Verifier", [
    await pairingVerifier.getAddress(), cfg.groth16TrustRoot,
  ]);
  const forwarder = await deploy<AegisZKForwarder>("AegisZKForwarder", [await router.getAddress()]);
  const adapter = await deploy<AnonAadhaarAdapter>("AnonAadhaarAdapter", [
    cfg.zkBackend === "groth16" ? await groth16.getAddress() : await anonAadhaar.getAddress(),
    AEGIS_NULLIFIER_SEED, cfg.epochDuration, cfg.maxProofAge, cfg.adapterRequiredState, [await forwarder.getAddress()],
  ]);
  // World ID stack: router mock (groups, root history) -> Semaphore verifier (World ID's real one, or the
  // soundness double); adapter = 0x2A type-1 verifier
  const semaphoreMock = await deploy<MockSemaphoreVerifier>("MockSemaphoreVerifier", [await deployer.getAddress()]);
  const semaphoreReal = await deploy<any>("contracts/zk/vendor/world-id/SemaphoreVerifier.sol:SemaphoreVerifier");
  const semaphoreVerifier = cfg.worldIdBackend === "semaphore" ? semaphoreReal : semaphoreMock;
  const worldIdRouter = await deploy<MockWorldIDRouter>("MockWorldIDRouter", [
    await semaphoreVerifier.getAddress(), await deployer.getAddress(), WORLD_ID_GROUP, WORLD_ID_INITIAL_ROOT, cfg.rootHistoryExpiry,
  ]);
  const worldIdAdapter = await deploy<WorldIDAdapter>("WorldIDAdapter", [
    await worldIdRouter.getAddress(), WORLD_ID_GROUP, cfg.worldIdAppId, cfg.worldIdAction, [await forwarder.getAddress()],
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
    groth16: await groth16.getAddress(),
    forwarder: await forwarder.getAddress(),
    pairingVerifier: await pairingVerifier.getAddress(),
    zkVerifier: cfg.zkBackend === "ecdsa" ? await verifier.getAddress() : await adapter.getAddress(),
    worldIdAdapter: await worldIdAdapter.getAddress(),
    worldIdRouter: await worldIdRouter.getAddress(),
    semaphoreVerifier: await semaphoreVerifier.getAddress(),
    semaphoreMock: await semaphoreMock.getAddress(),
    semaphoreReal: await semaphoreReal.getAddress(),
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
    zkVerifierTypes: cfg.zkVerifierTypes,
    worldIdVerifier: cfg.zkVerifierTypes & ZKVerifierType.WORLD_ID ? addr.worldIdAdapter : ethers.ZeroAddress,
    aadhaarVerifier: cfg.zkVerifierTypes & ZKVerifierType.AADHAAR ? addr.zkVerifier : ethers.ZeroAddress,
    zkMode: cfg.zkMode,
    requiredStateCode: cfg.requiredStateCode,
    lambdaBps: cfg.lambdaBps,
    virtualBoostBps: cfg.virtualBoostBps,
    exposureWindowSec: cfg.exposureWindowSec,
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
  for (const t of [human, bot, whale, worldHuman]) {
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
    opts: { timestamp?: bigint; recipient?: string; seed?: bigint } = {},
  ): Promise<string> {
    // `taker` is the beneficiary the proof commits to; `recipient` selects the forwarder envelope
    const seed = opts.seed ?? (await adapter.currentNullifierSeed());
    if (cfg.zkBackend === "groth16") {
      const ts = opts.timestamp ?? BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
      return encodeRealProofTakerArgs(await generateRealProof({ timestamp: Number(ts), seed, signal: taker }), false, opts.recipient);
    }
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
    await (await anonAadhaar.connect(deployer).registerProof(seed, nullifier, timestamp, signal, reveal, groth16)).wait();
    const proof = encodeEnvelope(timestamp, groth16, opts.recipient);
    return encodeZKTakerArgs(nullifier, reveal, proof);
  }

  /**
   * World ID proof bound to `taker` (type-1 payload for 0x2A), mock backend: the deployer plays the
   * World ID sequencer + World App and registers the statement (root, nullifierHash, signalHash,
   * externalNullifier) with MockSemaphoreVerifier for 8 hash-derived proof words. The statement is
   * exactly what the real verifier checks, so every public input matters (and nothing else does).
   *  - `person`    selects the human: same person => same nullifierHash, whatever the wallet
   *  - `root`      merkle root the proof claims (default: the router's latest root)
   *  - `recipient` selects the forwarder envelope (root, recipient, proof)
   *  - `tamper`    flips a proof word after registration => invalid proof
   */
  async function worldIdArgs(
    taker: string,
    opts: { person?: string; root?: bigint; recipient?: string; tamper?: boolean; members?: string[] } = {},
  ): Promise<string> {
    if (cfg.worldIdBackend === "semaphore") {
      // Real proof: `person` is an identity seed in the local tree (default "human"); the deployer
      // (sequencer) publishes the tree root to the router if it is not the latest one already.
      const externalNullifier: bigint = await worldIdAdapter.EXTERNAL_NULLIFIER();
      const p = await generateWorldIdProof({ identity: opts.person ?? "human", signal: taker, externalNullifier, members: opts.members });
      if (opts.root === undefined) {
        if ((await worldIdRouter.latestRoot()) !== BigInt(p.root)) {
          await (await worldIdRouter.connect(deployer).registerRoot(BigInt(p.root))).wait();
        }
      } else {
        p.root = opts.root.toString(); // claim a root the proof was not generated for
      }
      return encodeWorldIdProofTakerArgs(p, { tamper: opts.tamper, recipient: opts.recipient });
    }
    const person = opts.person ?? taker.toLowerCase();
    // stands in for the circuit's Poseidon(externalNullifier, identityNullifier)
    const nullifierHash = BigInt(ethers.solidityPackedKeccak256(["string", "string"], ["aegis-jit/world-id/mock-nullifier", person])) >> 8n;
    const root: bigint = opts.root ?? (await worldIdRouter.latestRoot());
    const signalHash = worldIdSignalHash(taker);
    const externalNullifier: bigint = await worldIdAdapter.EXTERNAL_NULLIFIER();
    const words = Array.from({ length: 8 }, (_, i) =>
      BigInt(ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "uint256", "uint256", "uint256"], [root, nullifierHash, signalHash, externalNullifier, i],
      )) >> 8n);
    await (await semaphoreMock.connect(deployer).registerProof(words, [root, nullifierHash, signalHash, externalNullifier])).wait();
    if (opts.tamper) words[7] ^= 1n;
    return encodeWorldIdTakerArgs(nullifierHash, encodeWorldIdProofEnvelope(root, words, opts.recipient));
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
    accounts: { deployer, maker, human, bot, whale, worldHuman },
    contracts: {
      aqua, weth, usdc, router, hook, strategy, verifier, anonAadhaar, adapter, groth16, pairingVerifier, forwarder,
      worldIdAdapter, worldIdRouter, semaphoreVerifier, semaphoreMock, semaphoreReal, usdcVault, wethVault, quoter,
    },
    addr, tokenA,
    zkArgs, worldIdArgs, takerData, quote, swap, vaultAssets, aquaBalances,
  };
}

export type AegisEnv = Awaited<ReturnType<typeof deployAegis>>;
