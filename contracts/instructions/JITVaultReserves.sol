// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Powered by SwapVM — © Degensoft Ltd 2025
/// @dev AegisJIT extension of SwapVM (created 2026-11-05). Compiled into the SwapVM router
///      runtime, hence a Modification under SwapVM-1.1 §1.7 and licensed under SwapVM-1.1 (§3.1A).

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";

/// @title JITVaultReservesArgsBuilder
/// @notice Encodes/decodes the 86-byte args of opcode 0x9A.
/// @dev Vaults and reference allocations are stored by token order (A = lower address,
///      B = higher address) so a single order serves both swap directions; the In/Out
///      variants are resolved at runtime.
library JITVaultReservesArgsBuilder {
    using Calldata for bytes;

    uint256 internal constant ARGS_LENGTH = 86;
    /// @dev λ and boost are expressed in basis points of 1e4 (10_000 = 100% / 1.0x)
    uint256 internal constant BPS_1E4 = 1e4;

    error JITInvalidArgsLength(uint256 length);
    error JITInvalidLambda(uint256 lambdaBps);
    error JITInvalidBoost(uint256 virtualBoostBps);

    /// @param refA / refB          Maker's committed Aqua allocation for tokenA / tokenB (the anchor for
    ///                             the constant virtual offsets `(boost - 1) * ref`)
    /// @param exposureWindowSec    length of the λ budget window (0 = cap single executions only)
    function build(
        address vaultA,
        address vaultB,
        uint32 lambdaBps,
        uint48 virtualBoostBps,
        uint128 refA,
        uint128 refB,
        uint32 exposureWindowSec
    ) internal pure returns (bytes memory) {
        _validate(lambdaBps, virtualBoostBps);
        return abi.encodePacked(vaultA, vaultB, lambdaBps, virtualBoostBps, refA, refB, exposureWindowSec);
    }

    struct Parsed {
        address vaultIn;
        address vaultOut;
        uint256 lambdaBps;
        uint256 offsetIn;          // constant virtual offset added to balanceIn
        uint256 offsetOut;         // constant virtual offset added to balanceOut
        uint256 exposureWindowSec; // λ budget window (0 = per execution only)
    }

    function parse(bytes calldata args, address tokenIn, address tokenOut) internal pure returns (Parsed memory p) {
        require(args.length == ARGS_LENGTH, JITInvalidArgsLength(args.length));
        address vaultA = address(bytes20(args.slice(0, 20)));
        address vaultB = address(bytes20(args.slice(20, 40)));
        p.lambdaBps = uint32(bytes4(args.slice(40, 44)));
        uint256 virtualBoostBps = uint48(bytes6(args.slice(44, 50)));
        uint256 refA = uint128(bytes16(args.slice(50, 66)));
        uint256 refB = uint128(bytes16(args.slice(66, 82)));
        p.exposureWindowSec = uint32(bytes4(args.slice(82, 86)));
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
///         * Reads the Maker's live ERC-4626 backing for `tokenOut` (STATICCALL only) through
///           `maxWithdraw(maker)`: what the Maker can redeem right now, including any vault-level
///           liquidity limit, so `quote()` never promises what `preTransferOut` cannot withdraw.
///         * Caps the output of any single execution at `lambdaBps` of that backing
///           (and at the Aqua-tracked balance, which is what can actually be pulled).
///         * Caps the output of ALL executions in an `exposureWindowSec` window at `lambdaBps` of
///           the backing as it stood when the window opened. A whale that splits a drain into many
///           max-cap executions, even inside one block, gets exactly one budget per window.
///         * Concentrates liquidity by `virtualBoostBps` (>= 1.0x) using CONSTANT virtual offsets
///           `(boost - 1) * ref` on top of the Aqua book: a shifted constant-product curve
///           (Uniswap-v3-style range) that adds depth without locking extra capital.
/// @dev `quote()` and `swap()` execute identical math: the budget bucket is read in both and written
///      only when `!ctx.vm.isStaticContext`, after the amounts are computed (same pattern as 0x7A).
///      Wraps the remainder of the program (like SwapVM's Fee/MinRate) to post-check the caps.
///
///      Budget bucket. Like the 0x7A flow bucket it lives on a fixed time grid: inside a window the
///      spent budget is constant, every elapsed window leaks one budget (λ · refBacking), and the
///      grid re-anchors (refreshing refBacking from the live backing) when the bucket is empty. So
///      at most λ of the backing leaves per window in steady state, and at most 2λ across any one
///      window boundary.
///
///      Why λ is a cap and not a reserve multiplier, and why the boost is an additive offset:
///      any per-swap re-scaling of the *current* reserves re-centres the curve after every
///      trade. With λ < 1 split trades get strictly cheaper (breaks sub-additivity); with a
///      multiplier > 1 a buy-then-sell round trip extracts value from the Maker. Constant
///      offsets keep pricing path-independent. See docs/SPEC.md §7.
abstract contract JITVaultReserves {
    using ContextLib for Context;
    using SafeCast for uint256;

    struct ExposureWindow {
        uint40 start;        // grid-aligned start of the current budget window (0 = never)
        uint216 outFlow;     // tokenOut that left the Maker in the bucket
        uint256 refBacking;  // withdrawable backing frozen while the bucket is non-empty
    }

    error JITExposureCapExceeded(uint256 amountOut, uint256 capOut);
    error JITExposureBudgetExceeded(uint256 amountOut, uint256 remainingBudget);
    error JITVaultAssetMismatch(address vault, address expectedAsset, address actualAsset);
    error JITReservesExpectedBeforeSwapAmountsComputation();

    event ExposureWindowUpdated(bytes32 indexed orderHash, address indexed tokenOut, uint256 start, uint256 outFlow, uint256 refBacking);

    mapping(bytes32 orderHash => mapping(address tokenOut => ExposureWindow)) internal _exposureWindows;

    /// @notice Raw budget-bucket state for an order/tokenOut (not leak-adjusted; see `_bucket`)
    function exposureWindow(bytes32 orderHash, address tokenOut) external view returns (uint256 start, uint256 outFlow, uint256 refBacking) {
        ExposureWindow storage e = _exposureWindows[orderHash][tokenOut];
        return (e.start, e.outFlow, e.refBacking);
    }

    /// @param args.vaultA            | 20 bytes (ERC-4626 for tokenA, or 0 = Aqua balance)
    /// @param args.vaultB            | 20 bytes (ERC-4626 for tokenB, or 0 = Aqua balance)
    /// @param args.lambdaBps         | 4 bytes  (exposure cap, 1e4 = 100%)
    /// @param args.virtualBoostBps   | 6 bytes  (depth multiplier, 1e4 = 1.0x)
    /// @param args.refA              | 16 bytes (committed Aqua allocation of tokenA)
    /// @param args.refB              | 16 bytes (committed Aqua allocation of tokenB)
    /// @param args.exposureWindowSec | 4 bytes  (λ budget window, 0 = per execution only)
    function _execJITVaultReserves(Context memory ctx, bytes calldata args) internal {
        require(ctx.swap.amountIn == 0 || ctx.swap.amountOut == 0, JITReservesExpectedBeforeSwapAmountsComputation());

        JITVaultReservesArgsBuilder.Parsed memory p =
            JITVaultReservesArgsBuilder.parse(args, ctx.query.tokenIn, ctx.query.tokenOut);

        if (p.vaultIn != address(0)) _requireVaultAsset(p.vaultIn, ctx.query.tokenIn);

        uint256 rawOut = ctx.swap.balanceOut;
        if (p.vaultOut != address(0)) {
            _requireVaultAsset(p.vaultOut, ctx.query.tokenOut);
            // maxWithdraw = convertToAssets(balanceOf(maker)) for a plain vault, less for an illiquid one
            rawOut = IERC4626(p.vaultOut).maxWithdraw(ctx.query.maker);
        }

        // Never more than λ of the live withdrawable backing, never more than Aqua can actually pull
        uint256 capOut = Math.min(rawOut * p.lambdaBps / JITVaultReservesArgsBuilder.BPS_1E4, ctx.swap.balanceOut);

        // Never more than λ of the backing per window, across all executions
        ExposureWindow storage e = _exposureWindows[ctx.query.orderHash][ctx.query.tokenOut];
        (uint256 used, uint256 refBacking, uint256 start) = _bucket(e, rawOut, p.lambdaBps, p.exposureWindowSec);
        uint256 remaining = type(uint256).max;
        if (p.exposureWindowSec != 0) {
            uint256 budget = refBacking * p.lambdaBps / JITVaultReservesArgsBuilder.BPS_1E4;
            remaining = budget > used ? budget - used : 0;
        }

        ctx.swap.balanceIn += p.offsetIn;
        ctx.swap.balanceOut += p.offsetOut;

        if (!ctx.query.isExactIn) _checkExposure(ctx.swap.amountOut, capOut, remaining);

        ctx.runLoop();

        _checkExposure(ctx.swap.amountOut, capOut, remaining);

        if (!ctx.vm.isStaticContext && p.exposureWindowSec != 0) {
            e.start = start.toUint40();
            e.outFlow = (used + ctx.swap.amountOut).toUint216();
            e.refBacking = refBacking;
            emit ExposureWindowUpdated(ctx.query.orderHash, ctx.query.tokenOut, start, used + ctx.swap.amountOut, refBacking);
        }
    }

    function _checkExposure(uint256 amountOut, uint256 capOut, uint256 remaining) private pure {
        require(amountOut <= capOut, JITExposureCapExceeded(amountOut, capOut));
        require(amountOut <= remaining, JITExposureBudgetExceeded(amountOut, remaining));
    }

    /// @dev Leak-adjusted budget bucket: budget already spent in the current window, the backing
    ///      the budget is measured against, and the grid-aligned start of the window the trade falls in.
    function _bucket(ExposureWindow storage e, uint256 rawOut, uint256 lambdaBps, uint256 windowSec)
        private
        view
        returns (uint256 used, uint256 refBacking, uint256 start)
    {
        if (windowSec == 0 || e.start == 0) return (0, rawOut, block.timestamp);
        uint256 elapsedWindows = (block.timestamp - e.start) / windowSec;
        if (elapsedWindows == 0) return (e.outFlow, e.refBacking, e.start);
        uint256 leak = elapsedWindows * (e.refBacking * lambdaBps / JITVaultReservesArgsBuilder.BPS_1E4);
        if (e.outFlow <= leak) return (0, rawOut, block.timestamp); // bucket empty: re-anchor, refresh the backing
        return (e.outFlow - leak, e.refBacking, e.start + elapsedWindows * windowSec);
    }

    function _requireVaultAsset(address vault, address token) private view {
        address asset = IERC4626(vault).asset();
        require(asset == token, JITVaultAssetMismatch(vault, token, asset));
    }
}
