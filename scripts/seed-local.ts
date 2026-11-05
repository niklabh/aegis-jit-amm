// SPDX-License-Identifier: MIT
// Deploys + seeds the AegisJIT stack on a running node and writes ui/public/deployment.json
//   npx hardhat node  &&  npx hardhat run --network localhost scripts/seed-local.ts

import * as fs from "fs";
import * as path from "path";
import { deployAegis } from "../test/utils/aegisFixture";

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const env = await deployAegis({ zkBackend: "anonAadhaar" });
  const { maker, human, bot, whale } = env.accounts;
  const humanAddr = await human.getAddress();
  const zk = await env.zkArgs(humanAddr);

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
    takerData: {
      human: env.takerData({ tokenIn: env.addr.usdc, zk }),
      bot: env.takerData({ tokenIn: env.addr.usdc }),
      whale: env.takerData({ tokenIn: env.addr.usdc }),
    },
    abi: {
      router: await abi("AegisSwapVMRouter"),
      vault: await abi("MockERC4626Vault"),
      aqua: await abi("Aqua"),
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
