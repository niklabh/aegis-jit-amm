// SPDX-License-Identifier: MIT
// Writes ui/public/deployment.json for a PUBLIC deployment (deployments/<network>/aegis.json), so the dashboard can
// run against Sepolia / World Chain Sepolia in read-only mode: live quotes, bytecode disassembly, buckets, the ZK Aadhaar
// pass (local prover) and the World ID pass through IDKit (World App / Simulator). Swaps need a funded signer and are
// executed with scripts/demo-sepolia.ts instead.
//   npx hardhat run --network worldchainSepolia scripts/ui-deployment.ts
//   WORLD_ID_ENVIRONMENT=production ... (default: staging, which is what the Simulator produces)
import * as fs from "fs";
import * as path from "path";
import { MAHARASHTRA_PACKED, TEST_SIGNER_PUBKEY_HASH, WORLD_ID_MEMBERS, encodeRealProofTakerArgs, generateRealProof } from "../test/utils/aegisFixture";
import { TakerTraitsLib } from "../test/utils/SwapVMHelpers";
import { explorerBase, loadRecord, takerWallets, aboutSection, toJson } from "./lib/deployment";

const hre = require("hardhat");
const { ethers, network } = hre;

async function main() {
  const rec = loadRecord();
  const takers = takerWallets();
  const A = rec.contracts;
  const tokenA = BigInt(A.usdc.address) < BigInt(A.weth.address) ? A.usdc.address : A.weth.address;
  const td = (zk?: string) => TakerTraitsLib.build({ isExactIn: true, isAToB: A.usdc.address.toLowerCase() === tokenA.toLowerCase(), useTransferFromAndAquaPush: true, instructionsArgs: zk });
  const adapter = await ethers.getContractAt("AnonAadhaarAdapter", A.adapter.address);
  const worldIdAdapter = await ethers.getContractAt("WorldIDAdapter", A.worldIdAdapter.address);

  // a fresh real Aadhaar proof for the human profile (same as scripts/seed-local.ts); its header is reused for every payload length
  console.log("generating a real Groth16 Aadhaar proof for the Verified Human profile…");
  const latest = await ethers.provider.getBlock("latest");
  const real = await generateRealProof({ timestamp: latest!.timestamp, seed: await adapter.currentNullifierSeed(), signal: takers.human.address, epoch: await adapter.currentEpoch() });
  const zk = encodeRealProofTakerArgs(real);
  const humanData = td(zk);
  const header = ethers.dataSlice(humanData, 0, 22);

  const mockRouter = Boolean(A.worldIdRouter);
  const abi = async (name: string) => (await hre.artifacts.readArtifact(name)).abi;
  const cfg = Object.fromEntries(Object.entries(rec.cfg).map(([k, v]) => [k, typeof v === "bigint" ? String(v) : v]));
  const out = {
    chainId: rec.chainId,
    rpcUrl: (network.config as any).url ?? "http://127.0.0.1:8545",
    explorer: explorerBase(rec.chainId),
    readOnly: !(network.name === "localhost" || network.name === "hardhat"),
    shipBlock: rec.ship.blockNumber,
    orderHash: rec.orderHash,
    order: rec.order,
    cfg,
    addr: {
      aqua: A.aqua.address, router: A.router.address, hook: A.hook.address, usdc: A.usdc.address, weth: A.weth.address,
      usdcVault: A.usdcVault.address, wethVault: A.wethVault.address, adapter: A.adapter.address, anonAadhaar: A.groth16.address,
      groth16: A.groth16.address, pairingVerifier: A.pairingVerifier.address, forwarder: A.forwarder.address, maker: rec.maker,
      worldIdAdapter: A.worldIdAdapter.address, worldIdRouter: rec.worldId?.router ?? A.worldIdRouter?.address,
      ...(A.semaphoreVerifier ? { semaphoreVerifier: A.semaphoreVerifier.address, semaphoreReal: A.semaphoreVerifier.address } : {}),
    },
    accounts: { maker: rec.maker, human: takers.human.address, bot: takers.bot.address, whale: takers.whale.address, worldHuman: takers.worldHuman.address },
    about: aboutSection(),
    zk: {
      proverUrl: "http://127.0.0.1:8547",
      epochDuration: Number(rec.cfg.epochDuration),
      payloadLength: ethers.getBytes(zk).length,
      takerHeader: header,
      trustRoot: TEST_SIGNER_PUBKEY_HASH.toString(),
      maharashtraPacked: MAHARASHTRA_PACKED.toString(),
    },
    worldId: {
      backend: mockRouter ? "semaphore" : "worldid",
      mock: mockRouter,
      router: rec.worldId?.router ?? A.worldIdRouter?.address,
      appId: rec.worldId?.appId ?? rec.cfg.worldIdAppId,
      action: rec.worldId?.action ?? rec.cfg.worldIdAction,
      environment: process.env.WORLD_ID_ENVIRONMENT ?? "staging",
      epochDuration: Number(rec.cfg.worldIdEpochDuration),
      externalNullifier: (await worldIdAdapter.currentExternalNullifier()).toString(),
      groupId: 1,
      treeDepth: 30,
      identityPrefix: "aegis-jit/world-id/",
      members: WORLD_ID_MEMBERS,
      root: mockRouter ? (await (await ethers.getContractAt("MockWorldIDRouter", A.worldIdRouter.address)).latestRoot()).toString() : "0",
      rootHistoryExpiry: Number(rec.cfg.rootHistoryExpiry),
      payloadLength: 353,
      takerHeader: header,
      artifactsBase: "/semaphore/30",
    },
    takerData: { human: humanData, bot: td(), whale: td() },
    abi: {
      router: await abi("AegisSwapVMRouter"), vault: await abi("MockERC4626Vault"), aqua: await abi("Aqua"), adapter: await abi("AnonAadhaarAdapter"),
      worldIdAdapter: await abi("WorldIDAdapter"), worldIdRouter: await abi("MockWorldIDRouter"),
      ...(A.semaphoreVerifier ? { semaphoreVerifier: await abi("SemaphoreVerifier") } : {}),
    },
  };
  const file = path.join(__dirname, "..", "ui", "public", "deployment.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toJson(out));
  console.log(`wrote ${path.relative(process.cwd(), file)} for ${network.name} (chainId ${rec.chainId}, ${out.readOnly ? "read-only" : "local"}); World ID backend: ${out.worldId.backend}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
