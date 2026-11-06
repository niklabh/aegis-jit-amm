// SPDX-License-Identifier: MIT
// Prints the configured deployer account and its balance on the selected network, without printing the key.
//   npx hardhat run --network sepolia scripts/account.ts
const { ethers, network } = require("hardhat");

async function main() {
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error(`no account configured for network "${network.name}": set PRIVATE_KEY in .env`);
  const address = await signer.getAddress();
  const { chainId } = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(address);
  console.log(`network   ${network.name} (chainId ${chainId})`);
  console.log(`deployer  ${address}`);
  console.log(`balance   ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) console.log("warning: balance is 0, fund this address before deploying");
}

main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exitCode = 1; });
