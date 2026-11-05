// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";

/// @title JITVaultReservesArgsBuilder
/// @notice Encodes/decodes the 50-byte args of opcode 0x9A.
/// @dev Vaults are stored by token order (A = lower address, B = higher address) so a single
///      order serves both swap directions; vaultIn/vaultOut are resolved at runtime.
library JITVaultReservesArgsBuilder {
    using Calldata for bytes;

    uint256 internal constant ARGS_LENGTH = 50;
    /// @dev λ and boost are expressed in basis points of 1e4 (10_000 = 100% / 1.0x)
    uint256 internal constant BPS_1E4 = 1e4;

    error JITInvalidArgsLength(uint256 length);
    error JITInvalidLambda(uint256 lambdaBps);
    error JITInvalidBoost(uint256 virtualBoostBps);

    function build(address vaultA, address vaultB, uint32 lambdaBps, uint48 virtualBoostBps) internal pure returns (bytes memory) {
        _validate(lambdaBps, virtualBoostBps);
        return abi.encodePacked(vaultA, vaultB, lambdaBps, virtualBoostBps);
    }

    function parse(bytes calldata args, address tokenIn, address tokenOut) internal pure returns (
        address vaultIn,
        address vaultOut,
        uint256 lambdaBps,
        uint256 virtualBoostBps
    ) {
        require(args.length == ARGS_LENGTH, JITInvalidArgsLength(args.length));
        address vaultA = address(bytes20(args.slice(0, 20)));
        address vaultB = address(bytes20(args.slice(20, 40)));
        lambdaBps = uint32(bytes4(args.slice(40, 44)));
        virtualBoostBps = uint48(bytes6(args.slice(44, 50)));
        _validate(lambdaBps, virtualBoostBps);
        (vaultIn, vaultOut) = tokenIn < tokenOut ? (vaultA, vaultB) : (vaultB, vaultA);
    }

    function _validate(uint256 lambdaBps, uint256 virtualBoostBps) private pure {
        require(lambdaBps > 0 && lambdaBps <= BPS_1E4, JITInvalidLambda(lambdaBps));
        require(virtualBoostBps >= BPS_1E4, JITInvalidBoost(virtualBoostBps));
    }
}

/// @title JITVaultReserves — opcode 0x9A
/// @notice Self-custodial just-in-time liquidity sizing.
///         * Reads the Maker's live ERC-4626 backing for `tokenOut` (STATICCALL only).
///         * Caps the output of any single execution at `lambdaBps` of that backing
///           (and at the Aqua-tracked balance, which is what can actually be pulled).
///         * Concentrates the pricing reserves by `virtualBoostBps` (>= 1.0x).
/// @dev 100% view-safe: no SSTORE/TSTORE. `quote()` and `swap()` execute identical math.
///      Wraps the remainder of the program (like SwapVM's Fee/MinRate) to post-check the cap.
///
///      Why λ is a cap and not a reserve multiplier: re-scaling the reserves by λ < 1 on every
///      swap re-centres the curve after each trade and makes split trades strictly cheaper
///      (breaks sub-additivity). A multiplier >= 1 (the boost) re-centres the other way and
///      penalises splits, so it is safe. See docs/SPEC.md §7.
abstract contract JITVaultReserves {
    using ContextLib for Context;

    error JITExposureCapExceeded(uint256 amountOut, uint256 capOut);
    error JITVaultAssetMismatch(address vault, address expectedAsset, address actualAsset);
    error JITReservesExpectedBeforeSwapAmountsComputation();

    /// @param args.vaultA          | 20 bytes (ERC-4626 for tokenA, or 0 = Aqua balance)
    /// @param args.vaultB          | 20 bytes (ERC-4626 for tokenB, or 0 = Aqua balance)
    /// @param args.lambdaBps       | 4 bytes  (exposure cap, 1e4 = 100%)
    /// @param args.virtualBoostBps | 6 bytes  (depth multiplier, 1e4 = 1.0x)
    function _execJITVaultReserves(Context memory ctx, bytes calldata args) internal {
        require(ctx.swap.amountIn == 0 || ctx.swap.amountOut == 0, JITReservesExpectedBeforeSwapAmountsComputation());

        (address vaultIn, address vaultOut, uint256 lambdaBps, uint256 virtualBoostBps) =
            JITVaultReservesArgsBuilder.parse(args, ctx.query.tokenIn, ctx.query.tokenOut);

        if (vaultIn != address(0)) _requireVaultAsset(vaultIn, ctx.query.tokenIn);

        uint256 rawOut = ctx.swap.balanceOut;
        if (vaultOut != address(0)) {
            _requireVaultAsset(vaultOut, ctx.query.tokenOut);
            rawOut = IERC4626(vaultOut).convertToAssets(IERC4626(vaultOut).balanceOf(ctx.query.maker));
        }

        uint256 capOut = Math.min(rawOut * lambdaBps / JITVaultReservesArgsBuilder.BPS_1E4, ctx.swap.balanceOut);

        ctx.swap.balanceIn = ctx.swap.balanceIn * virtualBoostBps / JITVaultReservesArgsBuilder.BPS_1E4;
        ctx.swap.balanceOut = ctx.swap.balanceOut * virtualBoostBps / JITVaultReservesArgsBuilder.BPS_1E4;

        if (!ctx.query.isExactIn) {
            require(ctx.swap.amountOut <= capOut, JITExposureCapExceeded(ctx.swap.amountOut, capOut));
        }

        ctx.runLoop();

        require(ctx.swap.amountOut <= capOut, JITExposureCapExceeded(ctx.swap.amountOut, capOut));
    }

    function _requireVaultAsset(address vault, address token) private view {
        address asset = IERC4626(vault).asset();
        require(asset == token, JITVaultAssetMismatch(vault, token, asset));
    }
}
