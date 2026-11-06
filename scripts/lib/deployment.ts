// SPDX-License-Identifier: MIT
// Deployment record + account helpers shared by deploy-sepolia / verify-sepolia / demo-sepolia.
import * as fs from "fs";
import * as path from "path";
import { HDNodeWallet, Mnemonic, Wallet } from "ethers";

const { ethers, network } = require("hardhat");

export const TAKER_ROLES = ["human", "bot", "whale", "worldHuman"] as const;
export type TakerRole = (typeof TAKER_ROLES)[number];

export interface ContractRecord {
  address: string;
  /** fully qualified name when it is ambiguous (vendored verifiers), else the contract name */
  contract: string;
  constructorArgs: unknown[];
  txHash: string;
  blockNumber: number;
}

export interface DeploymentRecord {
  network: string;
  chainId: number;
  deployedAt: string;
  deployer: string;
  maker: string;
  takers: Record<TakerRole, string>;
  contracts: Record<string, ContractRecord>;
  cfg: Record<string, string | number | boolean>;
  params: Record<string, unknown>;
  order: { maker: string; traits: string; data: string };
  orderHash: string;
  ship: { txHash: string; blockNumber: number };
  /** World ID wiring: the router the adapter verifies against, whether it is the project's mock, app id and action */
  worldId?: { router: string; mock: boolean; appId: string; action: string };
  notes: string[];
}

export const recordPath = (networkName: string = network.name) => path.join(__dirname, "..", "..", "deployments", networkName, "aegis.json");

/** JSON with bigints as decimal strings (the dashboard and the record readers re-wrap them with BigInt()) */
export const toJson = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

export function saveRecord(rec: DeploymentRecord) {
  const file = recordPath(rec.network);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toJson(rec) + "\n");
  return file;
}

export function loadRecord(networkName: string = network.name): DeploymentRecord {
  const file = recordPath(networkName);
  if (!fs.existsSync(file)) throw new Error(`no deployment record for network "${networkName}" (${file}); run scripts/deploy-sepolia.ts first`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveJson(name: string, data: unknown, networkName: string = network.name) {
  const file = path.join(__dirname, "..", "..", "deployments", networkName, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toJson(data) + "\n");
  return file;
}

/**
 * Taker accounts (human, bot, whale, worldHuman) derived from TAKER_MNEMONIC in .env. The phrase is
 * generated on first use and appended to the git-ignored .env, never printed.
 */
export function takerWallets(): Record<TakerRole, HDNodeWallet> {
  let phrase = process.env.TAKER_MNEMONIC?.trim();
  if (!phrase) {
    phrase = Wallet.createRandom().mnemonic!.phrase;
    const envFile = path.join(__dirname, "..", "..", ".env");
    fs.appendFileSync(envFile, `\n# Taker accounts for the Sepolia demo (human, bot, whale, worldHuman = m/44'/60'/0'/0/0..3). Generated; funded by the deployer.\nTAKER_MNEMONIC=${phrase}\n`);
    process.env.TAKER_MNEMONIC = phrase;
    console.log("generated TAKER_MNEMONIC and appended it to .env (git-ignored)");
  }
  const m = Mnemonic.fromPhrase(phrase);
  const out = {} as Record<TakerRole, HDNodeWallet>;
  TAKER_ROLES.forEach((role, i) => {
    out[role] = HDNodeWallet.fromMnemonic(m, `m/44'/60'/0'/0/${i}`).connect(ethers.provider) as HDNodeWallet;
  });
  return out;
}

export function explorerBase(chainId: number): string | null {
  return ({ 11155111: "https://sepolia.etherscan.io", 1: "https://etherscan.io", 4801: "https://sepolia.worldscan.org", 480: "https://worldscan.org" } as Record<number, string>)[chainId] ?? null;
}

export const addressLink = (chainId: number, a: string) => { const b = explorerBase(chainId); return b ? `${b}/address/${a}` : a; };
export const txLink = (chainId: number, h: string) => { const b = explorerBase(chainId); return b ? `${b}/tx/${h}` : h; };

// ------------------------------------------------------------------ dashboard "About" block
export const REPO_URL = "https://github.com/niklabh/aegis-jit-amm";
const PUBLIC_NETWORKS: Record<string, { label: string; readme: string }> = {
  worldchainSepolia: { label: "World Chain Sepolia", readme: "#live-on-world-chain-sepolia-real-world-id-router" },
  sepolia: { label: "Ethereum Sepolia", readme: "#live-on-sepolia" },
};
/**
 * `about` for ui/public/deployment.json: repository links and every public deployment record present under deployments/,
 * each with its explorer, README section and contract addresses, so the dashboard header can link to them on any chain.
 */
export function aboutSection() {
  const deployments = Object.entries(PUBLIC_NETWORKS)
    .filter(([n]) => fs.existsSync(recordPath(n)))
    .map(([n, meta]) => {
      const r = loadRecord(n);
      const contracts: Record<string, string> = Object.fromEntries(Object.entries(r.contracts).map(([k, c]) => [k, c.address]));
      const realWorldId = Boolean(r.worldId?.router && !r.worldId.mock);
      if (realWorldId) contracts.worldIdRouter = r.worldId!.router;
      return {
        network: n, label: meta.label, chainId: r.chainId, explorer: explorerBase(r.chainId), readme: `${REPO_URL}${meta.readme}`,
        realWorldId, contracts, orderHash: r.orderHash, shipTx: r.ship.txHash, shipBlock: Number(r.ship.blockNumber), deployedAt: r.deployedAt,
      };
    });
  return { repo: REPO_URL, readme: `${REPO_URL}#readme`, event: "ETHGlobal Mumbai 2026", deployments };
}
