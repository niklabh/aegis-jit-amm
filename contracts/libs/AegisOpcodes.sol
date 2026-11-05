// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Powered by SwapVM — © Degensoft Ltd 2025
/// @dev AegisJIT extension of SwapVM (created 2026-11-05). Compiled into the SwapVM router
///      runtime, hence a Modification under SwapVM-1.1 §1.7 and licensed under SwapVM-1.1 (§3.1A).

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
