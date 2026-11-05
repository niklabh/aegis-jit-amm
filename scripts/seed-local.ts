// SPDX-License-Identifier: MIT
// Deploys + seeds the AegisJIT stack on a running node and writes ui/public/deployment.json
//   npx hardhat node  &&  npx hardhat run --network localhost scripts/seed-local.ts

import * as fs from "fs";
import * as path from "path";
import { deployAegis, MAHARASHTRA_PACKED, TEST_SIGNER_PUBKEY_HASH } from "../test/utils/aegisFixture";

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  // Real BN254 Groth16 verification; nullifier seed rotates every 24 h
  const EPOCH = 24 * 3600;
  const env = await deployAegis({ zkBackend: "groth16", epochDuration: EPOCH });
  const { maker, human, bot, whale } = env.accounts;
  const humanAddr = await human.getAddress();
  console.log("Generating a real Groth16 proof for the default 'Verified Human' profile (~15 s)…");
  const zk = await env.zkArgs(humanAddr);
  const humanData = env.takerData({ tokenIn: env.addr.usdc, zk });
  // takerTraits header (22 B) for any 450-byte ZK payload: the UI appends a fresh proof to it
  const zkLen = ethers.getBytes(zk).length;
  const header = ethers.dataSlice(humanData, 0, 22);
  if (ethers.concat([header, zk]) !== humanData) throw new Error("takerData header layout changed");

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
    zk: {
      proverUrl: "http://127.0.0.1:8547",
      epochDuration: EPOCH,
      payloadLength: zkLen,
      takerHeader: header,
      trustRoot: TEST_SIGNER_PUBKEY_HASH.toString(),
      maharashtraPacked: MAHARASHTRA_PACKED.toString(),
    },
    takerData: {
      human: humanData,
      bot: env.takerData({ tokenIn: env.addr.usdc }),
      whale: env.takerData({ tokenIn: env.addr.usdc }),
    },
    abi: {
      router: await abi("AegisSwapVMRouter"),
      vault: await abi("MockERC4626Vault"),
      aqua: await abi("Aqua"),
      adapter: await abi("AnonAadhaarAdapter"),
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
