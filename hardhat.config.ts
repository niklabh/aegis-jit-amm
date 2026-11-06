// Modified for AegisJIT on 2026-11-05: added TokenCustomDecimalsMock to dependencyCompiler and a
// full-Yul-optimizer override for contracts/AegisSwapVMRouter.sol (EIP-170). Original: swap-vm-template.
import * as dotenv from "dotenv";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-verify";
import 'hardhat-deploy';
import 'hardhat-tracer';
import "@typechain/hardhat";
import 'hardhat-dependency-compiler';
import { HardhatUserConfig } from 'hardhat/config';

dotenv.config();

/**
 * Deployer key for public networks, from PRIVATE_KEY in .env (git-ignored). Accepted with or without
 * the 0x prefix. Anything that is not a 64-hex-char key (empty, the .env.example placeholder, ...) is
 * ignored instead of breaking every Hardhat command with HH8, so local work never depends on it.
 */
function deployerAccounts(): string[] {
  const raw = (process.env.PRIVATE_KEY ?? "").trim().replace(/^0x/i, "");
  if (raw === "") return [];
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    console.warn("hardhat.config: PRIVATE_KEY is not a 64-hex-character key; ignoring it (public-network deploys disabled)");
    return [];
  }
  return ["0x" + raw];
}

const config: HardhatUserConfig = {
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      // SEPOLIA_RPC_URL falls back to a public endpoint; the deployer key comes from PRIVATE_KEY (see below)
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: deployerAccounts(),
      timeout: 120_000, // public / free-tier RPCs occasionally stall; the deploy script also retries and resumes
    },
    worldchainSepolia: {
      // World Chain Sepolia (chainId 4801): the legacy World ID Router lives at 0x57f928158C3EE7CDad1e4D8642503c4D0201f611
      url: process.env.WORLDCHAIN_SEPOLIA_RPC_URL || "https://worldchain-sepolia.g.alchemy.com/public",
      chainId: 4801,
      accounts: deployerAccounts(),
      timeout: 120_000,
    },
    // Add your deployment network here and the corresponding URL in the .env file
  },
  namedAccounts: {
    deployer: {
      default: 0, // here this will by default take the first account as deployer
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.8.30",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1,
            details: {
              yul: true,
              yulDetails: {
                stackAllocation: true,
                optimizerSteps: "dhfoDgvulfnTUtnIf"
              }
            }
          },
          evmVersion: "cancun",
          viaIR: true
        }
      }
    ],
    overrides: {
      // The router adds 3 instructions on top of AquaSwapVMRouter (already ~24.3KB with the
      // minimal Yul step sequence above). The full default Yul optimizer keeps it < 24KB (EIP-170).
      "contracts/AegisSwapVMRouter.sol": {
        version: "0.8.30",
        settings: {
          optimizer: { enabled: true, runs: 1 },
          evmVersion: "cancun",
          viaIR: true
        }
      }
    }
  },
  dependencyCompiler: {
    paths: [
      "@1inch/aqua/src/Aqua.sol",
      "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol",
      "@1inch/swap-vm/src/routers/SwapVMRouter.sol",
      "@1inch/swap-vm/test/mocks/WETHMock.sol",
      "@1inch/solidity-utils/contracts/mocks/TokenMock.sol",
      "@1inch/solidity-utils/contracts/mocks/TokenCustomDecimalsMock.sol"
    ]
  },
  typechain: {
    outDir: "typechain-types",
  },
  etherscan: {
    // A single key selects Etherscan's API V2 (one key for every chain); the per-network map used the retired V1 endpoints
    apiKey: process.env.ETHERSCAN_API_KEY || "",
    customChains: [
      {
        network: "worldchainSepolia",
        chainId: 4801,
        urls: { apiURL: "https://api.etherscan.io/v2/api?chainid=4801", browserURL: "https://sepolia.worldscan.org" },
      },
    ],
  }
};

export default config;
