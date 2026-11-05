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

const config: HardhatUserConfig = {
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? ["0x" + process.env.PRIVATE_KEY] : [],
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
    apiKey: {
      // Add your Etherscan API keys here
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      // Add other networks as needed
    }
  }
};

export default config;
