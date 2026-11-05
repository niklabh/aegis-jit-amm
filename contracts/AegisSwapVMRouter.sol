// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";
import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";
import { MinRate } from "@1inch/swap-vm/src/instructions/MinRate.sol";

import { ZKIdentityGuard } from "./instructions/ZKIdentityGuard.sol";
import { JITVaultReserves } from "./instructions/JITVaultReserves.sol";
import { VolatilitySurgeFee } from "./instructions/VolatilitySurgeFee.sol";
import { AegisOpcodes } from "./libs/AegisOpcodes.sol";

/// @title AegisSwapVMRouter
/// @notice AquaSwapVMRouter extended with the AegisJIT instruction set.
/// @dev Two dispatchers exist. Execution starts on `_dispatch`; when ZKIdentityGuard (0x2A)
///      verifies the taker it swaps `ctx.vm.dispatch` to `_dispatchVerifiedHuman`, which routes
///      VolatilitySurgeFee (0x7A) with the human discount. The switch lives only in the in-memory
///      Context of this execution, so it is valid under STATICCALL (`quote`) and cannot leak
///      across swaps.
contract AegisSwapVMRouter is
    Simulator,
    SwapVM,
    AquaOpcodes,
    MinRate,
    ZKIdentityGuard,
    JITVaultReserves,
    VolatilitySurgeFee
{
    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        SwapVM(aqua, weth, owner, name, version)
        AquaOpcodes(aqua)
    {}

    /// @dev Default dispatcher (unverified taker)
    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        _route(ctx, opcode, args, false);
    }

    /// @dev Dispatcher installed by ZKIdentityGuard for verified human takers
    function _dispatchVerifiedHuman(Context memory ctx, uint256 opcode, bytes calldata args) internal {
        _route(ctx, opcode, args, true);
    }

    function _onVerifiedHuman(Context memory ctx) internal pure override {
        ctx.vm.dispatch = _dispatchVerifiedHuman;
    }

    function _route(Context memory ctx, uint256 opcode, bytes calldata args, bool verifiedHuman) private {
        if (opcode == AegisOpcodes.JIT_VAULT_RESERVES) _execJITVaultReserves(ctx, args);
        else if (opcode == AegisOpcodes.VOLATILITY_SURGE_FEE) _execVolatilitySurgeFee(ctx, args, verifiedHuman);
        else if (opcode == AegisOpcodes.ZK_IDENTITY_GUARD) _execZKIdentityGuard(ctx, args);
        else if (opcode == AegisOpcodes.REQUIRE_MIN_RATE_1D) MinRate._requireMinRate1D(ctx, args);
        else AquaOpcodes._runOpcode(ctx, opcode, args);
    }
}
