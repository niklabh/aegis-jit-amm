// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title AegisOpcodes
/// @notice Opcode indices added on top of `AquaOpcodes` (which occupies 10..33).
library AegisOpcodes {
    uint256 internal constant ZK_IDENTITY_GUARD = 0x2A;
    uint256 internal constant REQUIRE_MIN_RATE_1D = 0x2B;
    uint256 internal constant VOLATILITY_SURGE_FEE = 0x7A;
    uint256 internal constant JIT_VAULT_RESERVES = 0x9A;

    // Re-exported AquaOpcodes indices used by the AegisJIT program
    uint256 internal constant JUMP = 0x0A;
    uint256 internal constant JUMP_IF_TOKEN_IN = 0x0B;
    uint256 internal constant DEADLINE = 0x0D;
    uint256 internal constant XYC_SWAP_XD = 0x11;
    uint256 internal constant SALT = 0x14;
}
