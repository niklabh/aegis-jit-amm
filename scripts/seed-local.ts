// SPDX-License-Identifier: MIT
// Deploys + seeds the AegisJIT stack on a running node and writes ui/public/deployment.json
//   npx hardhat node  &&  npx hardhat run --network localhost scripts/seed-local.ts

import * as fs from "fs";
import * as path from "path";
import { deployAegis, MAHARASHTRA_PACKED, TEST_SIGNER_PUBKEY_HASH, WORLD_ID_MEMBERS, worldIdArtifactsAvailable } from "../test/utils/aegisFixture";
import { aboutSection } from "./lib/deployment";

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  // Real BN254 Groth16 verification; nullifier seed rotates every 24 h. World ID: real Semaphore
  // verifier when the depth-30 artifacts are present, MockSemaphoreVerifier otherwise.
  const EPOCH = 24 * 3600;
  const REAL_WORLD_ID = worldIdArtifactsAvailable();
  const env = await deployAegis({ zkBackend: "groth16", epochDuration: EPOCH, worldIdBackend: REAL_WORLD_ID ? "semaphore" : "mock" });
  const { maker, human, bot, whale } = env.accounts;
  const humanAddr = await human.getAddress();
  console.log("Generating a real Groth16 proof for the default 'Verified Human' profile (~15 s)…");
  const zk = await env.zkArgs(humanAddr);
  const humanData = env.takerData({ tokenIn: env.addr.usdc, zk });
  // takerTraits header (22 B): slice indexes (incl. the end offset of instructionsArgs) + flags.
  // It depends on the payload LENGTH, so one header per payload type; the UI appends a fresh proof.
  const zkLen = ethers.getBytes(zk).length;
  const header = ethers.dataSlice(humanData, 0, 22);
  if (ethers.concat([header, zk]) !== humanData) throw new Error("takerData header layout changed");

  console.log(`Generating a World ID proof for the 'Verified Human' profile (${REAL_WORLD_ID ? "real Semaphore depth-30" : "mock verifier"})…`);
  const worldZk = await env.worldIdArgs(humanAddr); // identity "human" of the local tree; publishes the root
  const worldData = env.takerData({ tokenIn: env.addr.usdc, zk: worldZk });
  const worldLen = ethers.getBytes(worldZk).length;
  const worldHeader = ethers.dataSlice(worldData, 0, 22);
  if (ethers.concat([worldHeader, worldZk]) !== worldData) throw new Error("takerData header layout changed (World ID)");

  const abi = async (name: string) => (await hre.artifacts.readArtifact(name)).abi;
  const cfg = Object.fromEntries(Object.entries(env.cfg).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

  const out = {
    chainId: Number(env.chainId),
    rpcUrl: "http://127.0.0.1:8545",
    shipBlock: env.shipReceipt!.blockNumber,
    orderHash: env.orderHash,
    order: env.order,
    cfg,
    addr: env.addr,
    accounts: {
      maker: await maker.getAddress(),
      human: humanAddr,
      bot: await bot.getAddress(),
      whale: await whale.getAddress(),
    },
    // USDC -> WETH exactIn taker data per profile (amount-independent)
    about: aboutSection(),
    zk: {
      proverUrl: "http://127.0.0.1:8547",
      epochDuration: EPOCH,
      payloadLength: zkLen,
      takerHeader: header,
      trustRoot: TEST_SIGNER_PUBKEY_HASH.toString(),
      maharashtraPacked: MAHARASHTRA_PACKED.toString(),
    },
    worldId: {
      backend: REAL_WORLD_ID ? "semaphore" : "mock",
      appId: env.cfg.worldIdAppId,
      action: env.cfg.worldIdAction,
      epochDuration: env.cfg.worldIdEpochDuration,
      externalNullifier: (await env.contracts.worldIdAdapter.currentExternalNullifier()).toString(),
      groupId: 1,
      treeDepth: 30,
      // identity seeds of the local tree: Identity(`${identityPrefix}${seed}`) — the dashboard rebuilds the same tree
      identityPrefix: "aegis-jit/world-id/",
      members: WORLD_ID_MEMBERS,
      root: (await env.contracts.worldIdRouter.latestRoot()).toString(),
      rootHistoryExpiry: env.cfg.rootHistoryExpiry,
      payloadLength: worldLen,
      takerHeader: worldHeader,
      artifactsBase: "/semaphore/30",
    },
    takerData: {
      human: humanData,
      worldIdHuman: worldData,
      bot: env.takerData({ tokenIn: env.addr.usdc }),
      whale: env.takerData({ tokenIn: env.addr.usdc }),
    },
    abi: {
      router: await abi("AegisSwapVMRouter"),
      vault: await abi("MockERC4626Vault"),
      aqua: await abi("Aqua"),
      adapter: await abi("AnonAadhaarAdapter"),
      worldIdAdapter: await abi("WorldIDAdapter"),
      worldIdRouter: await abi("MockWorldIDRouter"),
      semaphoreVerifier: await abi(REAL_WORLD_ID ? "SemaphoreVerifier" : "MockSemaphoreVerifier"),
    },
  };

  const file = path.join(__dirname, "..", "ui", "public", "deployment.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`AegisJIT seeded on chain ${out.chainId}. Router ${env.addr.router}`);
  console.log(`Wrote ${path.relative(process.cwd(), file)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
