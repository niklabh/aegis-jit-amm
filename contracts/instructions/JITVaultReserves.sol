// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Powered by SwapVM — © Degensoft Ltd 2025
/// @dev AegisJIT extension of SwapVM (created 2026-11-05). Compiled into the SwapVM router
///      runtime, hence a Modification under SwapVM-1.1 §1.7 and licensed under SwapVM-1.1 (§3.1A).

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";

/// @title JITVaultReservesArgsBuilder
/// @notice Encodes/decodes the 82-byte args of opcode 0x9A.
/// @dev Vaults and reference allocations are stored by token order (A = lower address,
///      B = higher address) so a single order serves both swap directions; the In/Out
///      variants are resolved at runtime.
library JITVaultReservesArgsBuilder {
    using Calldata for bytes;

    uint256 internal constant ARGS_LENGTH = 82;
    /// @dev λ and boost are expressed in basis points of 1e4 (10_000 = 100% / 1.0x)
    uint256 internal constant BPS_1E4 = 1e4;

    error JITInvalidArgsLength(uint256 length);
    error JITInvalidLambda(uint256 lambdaBps);
    error JITInvalidBoost(uint256 virtualBoostBps);

    /// @param refA / refB  Maker's committed Aqua allocation for tokenA / tokenB (the anchor for
    ///                    the constant virtual offsets `(boost - 1) * ref`)
    function build(
        address vaultA,
        address vaultB,
        uint32 lambdaBps,
        uint48 virtualBoostBps,
        uint128 refA,
        uint128 refB
    ) internal pure returns (bytes memory) {
        _validate(lambdaBps, virtualBoostBps);
        return abi.encodePacked(vaultA, vaultB, lambdaBps, virtualBoostBps, refA, refB);
    }

    struct Parsed {
        address vaultIn;
        address vaultOut;
        uint256 lambdaBps;
        uint256 offsetIn;   // constant virtual offset added to balanceIn
        uint256 offsetOut;  // constant virtual offset added to balanceOut
    }

    function parse(bytes calldata args, address tokenIn, address tokenOut) internal pure returns (Parsed memory p) {
        require(args.length == ARGS_LENGTH, JITInvalidArgsLength(args.length));
        address vaultA = address(bytes20(args.slice(0, 20)));
        address vaultB = address(bytes20(args.slice(20, 40)));
        p.lambdaBps = uint32(bytes4(args.slice(40, 44)));
        uint256 virtualBoostBps = uint48(bytes6(args.slice(44, 50)));
        uint256 refA = uint128(bytes16(args.slice(50, 66)));
        uint256 refB = uint128(bytes16(args.slice(66, 82)));
        _validate(p.lambdaBps, virtualBoostBps);

        uint256 offsetA = refA * (virtualBoostBps - BPS_1E4) / BPS_1E4;
        uint256 offsetB = refB * (virtualBoostBps - BPS_1E4) / BPS_1E4;
        (p.vaultIn, p.vaultOut, p.offsetIn, p.offsetOut) = tokenIn < tokenOut
            ? (vaultA, vaultB, offsetA, offsetB)
            : (vaultB, vaultA, offsetB, offsetA);
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
///         * Concentrates liquidity by `virtualBoostBps` (>= 1.0x) using CONSTANT virtual offsets
///           `(boost - 1) * ref` on top of the Aqua book: a shifted constant-product curve
///           (Uniswap-v3-style range) that adds depth without locking extra capital.
/// @dev 100% view-safe: no SSTORE/TSTORE. `quote()` and `swap()` execute identical math.
///      Wraps the remainder of the program (like SwapVM's Fee/MinRate) to post-check the cap.
///
///      Why λ is a cap and not a reserve multiplier, and why the boost is an additive offset:
///      any per-swap re-scaling of the *current* reserves re-centres the curve after every
///      trade. With λ < 1 split trades get strictly cheaper (breaks sub-additivity); with a
///      multiplier > 1 a buy-then-sell round trip extracts value from the Maker. Constant
///      offsets keep pricing path-independent. See docs/SPEC.md §7.
abstract contract JITVaultReserves {
    using ContextLib for Context;

    error JITExposureCapExceeded(uint256 amountOut, uint256 capOut);
    error JITVaultAssetMismatch(address vault, address expectedAsset, address actualAsset);
    error JITReservesExpectedBeforeSwapAmountsComputation();

    /// @param args.vaultA          | 20 bytes (ERC-4626 for tokenA, or 0 = Aqua balance)
    /// @param args.vaultB          | 20 bytes (ERC-4626 for tokenB, or 0 = Aqua balance)
    /// @param args.lambdaBps       | 4 bytes  (exposure cap, 1e4 = 100%)
    /// @param args.virtualBoostBps | 6 bytes  (depth multiplier, 1e4 = 1.0x)
    /// @param args.refA            | 16 bytes (committed Aqua allocation of tokenA)
    /// @param args.refB            | 16 bytes (committed Aqua allocation of tokenB)
    function _execJITVaultReserves(Context memory ctx, bytes calldata args) internal {
        require(ctx.swap.amountIn == 0 || ctx.swap.amountOut == 0, JITReservesExpectedBeforeSwapAmountsComputation());

        JITVaultReservesArgsBuilder.Parsed memory p =
            JITVaultReservesArgsBuilder.parse(args, ctx.query.tokenIn, ctx.query.tokenOut);

        if (p.vaultIn != address(0)) _requireVaultAsset(p.vaultIn, ctx.query.tokenIn);

        uint256 rawOut = ctx.swap.balanceOut;
        if (p.vaultOut != address(0)) {
            _requireVaultAsset(p.vaultOut, ctx.query.tokenOut);
            rawOut = IERC4626(p.vaultOut).convertToAssets(IERC4626(p.vaultOut).balanceOf(ctx.query.maker));
        }

        // Never more than λ of the live underlying, never more than Aqua can actually pull
        uint256 capOut = Math.min(rawOut * p.lambdaBps / JITVaultReservesArgsBuilder.BPS_1E4, ctx.swap.balanceOut);

        ctx.swap.balanceIn += p.offsetIn;
        ctx.swap.balanceOut += p.offsetOut;

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
