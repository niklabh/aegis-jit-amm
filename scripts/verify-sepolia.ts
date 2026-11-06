// SPDX-License-Identifier: MIT
// Verifies every contract of deployments/<network>/aegis.json on Etherscan (needs ETHERSCAN_API_KEY).
//   npx hardhat run --network sepolia scripts/verify-sepolia.ts
import { loadRecord } from "./lib/deployment";

const hre = require("hardhat");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const rec = loadRecord();
  console.log(`verifying ${Object.keys(rec.contracts).length} contracts on ${rec.network}`);
  for (const [key, c] of Object.entries(rec.contracts)) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await hre.run("verify:verify", {
          address: c.address,
          constructorArguments: c.constructorArgs,
          contract: c.contract.includes(":") ? c.contract : undefined,
        });
        console.log(`✔ ${key} ${c.address}`);
        break;
      } catch (e: any) {
        const msg = String(e.message ?? e);
        if (/already verified/i.test(msg)) { console.log(`✔ ${key} ${c.address} (already verified)`); break; }
        if (attempt === 3) { console.log(`✘ ${key} ${c.address}: ${msg.split("\n")[0]}`); break; }
        console.log(`  retry ${attempt} for ${key}: ${msg.split("\n")[0]}`);
        await sleep(20_000);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
