// SPDX-License-Identifier: MIT
// Renders deployments/<network>/aegis.json (+ demo.json if present) as the Markdown block used in the README.
//   npx hardhat run --network sepolia scripts/deployment-readme.ts
import * as fs from "fs";
import * as path from "path";
import { addressLink, loadRecord, txLink } from "./lib/deployment";

const { network } = require("hardhat");

const LABELS: Record<string, string> = {
  aqua: "Aqua (1inch shared liquidity layer)",
  router: "AegisSwapVMRouter (SwapVM + 0x2A / 0x9A / 0x7A)",
  hook: "AegisJITVaultHook (JIT withdraw / re-deposit)",
  strategy: "AegisJITStrategy (on-chain order builder)",
  forwarder: "AegisZKForwarder (reference aggregator)",
  usdc: "USDC mock (6 dp, mintable)",
  weth: "WETH mock (18 dp, mintable)",
  usdcVault: "avUSDC MockERC4626Vault",
  wethVault: "avWETH MockERC4626Vault",
  pairingVerifier: "Anon Aadhaar v2 Groth16 verifier (vendored snarkjs, ecPairing)",
  groth16: "AnonAadhaarGroth16Verifier (UIDAI key set; test signer here)",
  adapter: "AnonAadhaarAdapter (0x2A type 2)",
  semaphoreVerifier: "World ID SemaphoreVerifier (vendored, real pairing)",
  worldIdRouter: "MockWorldIDRouter (router + identity-manager semantics)",
  worldIdAdapter: "WorldIDAdapter (0x2A type 1)",
};

function main() {
  const rec = loadRecord();
  const c = rec.chainId;
  const a = (x: string) => `[\`${x}\`](${addressLink(c, x)})`;
  const t = (h: string) => `[\`${h.slice(0, 10)}…${h.slice(-6)}\`](${txLink(c, h)})`;
  const out: string[] = [];
  out.push(`Deployed ${rec.deployedAt.slice(0, 10)} on ${rec.network} (chainId ${c}) by ${a(rec.deployer)}, who is also the Maker.`);
  out.push("");
  out.push("| Contract | Address | Deploy tx |");
  out.push("|---|---|---|");
  for (const [k, v] of Object.entries(rec.contracts)) out.push(`| ${LABELS[k] ?? k} | ${a(v.address)} | ${t(v.txHash)} |`);
  out.push("");
  out.push("| Strategy | |");
  out.push("|---|---|");
  out.push(`| orderHash | \`${rec.orderHash}\` |`);
  out.push(`| Aqua.ship tx | ${t(rec.ship.txHash)} (block ${rec.ship.blockNumber}) |`);
  out.push(`| Maker capital | 1,000,000 USDC + 400 WETH in the two vaults; Aqua book = the same, as virtual balances |`);
  out.push(`| λ / boost / windows | ${Number(rec.cfg.lambdaBps) / 100}% per execution and per ${rec.cfg.exposureWindowSec}s window / ${Number(rec.cfg.virtualBoostBps) / 10_000}x / ${rec.cfg.decayWindowSec}s fee bucket |`);
  out.push(`| fees | base ${Number(rec.cfg.baseFeeBps) / 1e7}% (humans ${Number(rec.cfg.baseFeeBps) / 2e7}%), surge marginal ${Number(rec.cfg.maxSurgeFeeBps) / 1e7}% above ${Number(rec.cfg.impactThresholdBps) / 100}% utilisation |`);
  out.push(`| Aadhaar epochs | ${Number(rec.cfg.epochDuration) / 3600} h, grace ${rec.cfg.epochGrace} s, QR freshness ${Number(rec.cfg.maxProofAge) / 86400} days |`);
  out.push("");
  out.push("Taker accounts used by the live run:");
  out.push("");
  out.push("| Role | Address |");
  out.push("|---|---|");
  for (const [k, v] of Object.entries(rec.takers)) out.push(`| ${k} | ${a(v)} |`);
  out.push("");
  for (const note of rec.notes) out.push(`- ${note}`);

  const demoFile = path.join(path.dirname(path.join(__dirname, "..", "deployments", rec.network, "aegis.json")), "demo.json");
  if (fs.existsSync(demoFile)) {
    const demo = JSON.parse(fs.readFileSync(demoFile, "utf8"));
    out.push("");
    out.push(`Live run of \`scripts/demo-sepolia.ts\` on ${String(demo.ranAt).slice(0, 10)}:`);
    out.push("");
    out.push("| Scenario | Taker | In | Out | USDC/WETH | Fee | Gas | Tx | Result |");
    out.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of demo.scenarios) {
      const tx = r.link ? `[${r.tx}](${r.link})` : r.tx;
      out.push(`| ${r.name} | ${r.taker} | ${r.inStr} | ${r.outStr} | ${r.price} | ${r.fee} | ${Number(r.gas) ? Number(r.gas).toLocaleString("en-US") : r.gas} | ${tx} | ${r.status} |`);
    }
  }
  console.log(out.join("\n"));
}

main();
