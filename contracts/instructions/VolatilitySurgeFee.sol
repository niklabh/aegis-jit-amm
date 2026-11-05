// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";
import { BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";

/// @title VolatilitySurgeFeeArgsBuilder
/// @notice Encodes/decodes the 20-byte args of opcode 0x7A.
/// @dev Fee rates use SwapVM's `BPS = 1e9` (100%). The utilization threshold uses 1e4 bps.
library VolatilitySurgeFeeArgsBuilder {
    using Calldata for bytes;

    uint256 internal constant ARGS_LENGTH = 20;
    uint256 internal constant UTILIZATION_BPS = 1e4;
    /// @dev Upper bound on the marginal fee rate; keeps the exactOut inverse well-conditioned.
    uint256 internal constant MAX_FEE_BPS = BPS / 2;

    error SurgeFeeInvalidArgsLength(uint256 length);
    error SurgeFeeInvalidRates(uint256 baseFeeBps, uint256 maxSurgeFeeBps);

    function build(uint32 baseFeeBps, uint32 maxSurgeFeeBps, uint64 impactThresholdBps, uint32 decayWindowSec) internal pure returns (bytes memory) {
        _validate(baseFeeBps, maxSurgeFeeBps);
        return abi.encodePacked(baseFeeBps, maxSurgeFeeBps, impactThresholdBps, decayWindowSec);
    }

    function parse(bytes calldata args) internal pure returns (
        uint256 baseFeeBps,
        uint256 maxSurgeFeeBps,
        uint256 impactThresholdBps,
        uint256 decayWindowSec
    ) {
        require(args.length == ARGS_LENGTH, SurgeFeeInvalidArgsLength(args.length));
        baseFeeBps = uint32(bytes4(args.slice(0, 4)));
        maxSurgeFeeBps = uint32(bytes4(args.slice(4, 8)));
        impactThresholdBps = uint64(bytes8(args.slice(8, 16)));
        decayWindowSec = uint32(bytes4(args.slice(16, 20)));
        _validate(baseFeeBps, maxSurgeFeeBps);
    }

    function _validate(uint256 baseFeeBps, uint256 maxSurgeFeeBps) private pure {
        require(baseFeeBps <= maxSurgeFeeBps && maxSurgeFeeBps <= MAX_FEE_BPS, SurgeFeeInvalidRates(baseFeeBps, maxSurgeFeeBps));
    }
}

/// @title VolatilitySurgeFee — opcode 0x7A
/// @notice Dynamic LVR / toxic-flow fee on `amountIn`.
///
///   Marginal fee rate on cumulative in-window flow x (gross tokenIn):
///       rate(x) = b          for x <  T
///       rate(x) = b + P      for x >= T
///   where b = baseFee (halved for verified humans), P = maxSurgeFee - baseFee,
///   T = refBalanceIn * impactThresholdBps / 1e4.
///
///   For a trade of gross size g with F flow already in the window, G0 = max(0, T - F):
///       fee(g) = ceil((g*b + max(0, g - G0)*P) / BPS),   net(g) = g - fee(g)
///
///   The effective rate rises piecewise-linearly from b toward maxSurgeFee. Because the
///   schedule is integrated over cumulative window flow (with a frozen reference balance),
///   splitting a trade inside the window pays the same total fee as the single trade —
///   this is what makes the fee sub-additive. A stateless size-based fee cannot be.
///
/// @dev Window state is written ONLY when `!ctx.vm.isStaticContext`, after amounts are computed,
///      so `quote()` (STATICCALL) and `swap()` read identical pre-state and return identical amounts.
abstract contract VolatilitySurgeFee {
    using ContextLib for Context;
    using SafeCast for uint256;

    struct SurgeWindow {
        uint40 start;          // window start timestamp (0 = never started)
        uint216 flow;          // gross tokenIn flow accumulated in the window
        uint256 refBalanceIn;  // pricing balanceIn frozen at window start
    }

    error SurgeFeeShouldBeAppliedBeforeSwapAmountsComputation();

    event SurgeWindowUpdated(bytes32 indexed orderHash, address indexed tokenIn, uint256 start, uint256 flow, uint256 refBalanceIn);

    mapping(bytes32 orderHash => mapping(address tokenIn => SurgeWindow)) internal _surgeWindows;

    /// @notice Current surge window state for an order/direction (raw, not expiry-adjusted)
    function surgeWindow(bytes32 orderHash, address tokenIn) external view returns (uint256 start, uint256 flow, uint256 refBalanceIn) {
        SurgeWindow storage w = _surgeWindows[orderHash][tokenIn];
        return (w.start, w.flow, w.refBalanceIn);
    }

    /// @param args.baseFeeBps         | 4 bytes (1e9 = 100%)
    /// @param args.maxSurgeFeeBps     | 4 bytes (1e9 = 100%)
    /// @param args.impactThresholdBps | 8 bytes (1e4 = 100% of balanceIn)
    /// @param args.decayWindowSec     | 4 bytes (0 = stateless)
    /// @param verifiedHuman           set by ZKIdentityGuard (0x2A) via the router's dispatcher
    function _execVolatilitySurgeFee(Context memory ctx, bytes calldata args, bool verifiedHuman) internal {
        require(ctx.swap.amountIn == 0 || ctx.swap.amountOut == 0, SurgeFeeShouldBeAppliedBeforeSwapAmountsComputation());

        (uint256 baseFeeBps, uint256 maxSurgeFeeBps, uint256 impactThresholdBps, uint256 decayWindowSec) =
            VolatilitySurgeFeeArgsBuilder.parse(args);

        uint256 b = verifiedHuman ? baseFeeBps / 2 : baseFeeBps;
        uint256 p = maxSurgeFeeBps - baseFeeBps;

        SurgeWindow storage w = _surgeWindows[ctx.query.orderHash][ctx.query.tokenIn];
        bool active = decayWindowSec != 0 && w.start != 0 && block.timestamp < uint256(w.start) + decayWindowSec;
        uint256 flow = active ? w.flow : 0;
        uint256 refBalanceIn = active ? w.refBalanceIn : ctx.swap.balanceIn;

        uint256 threshold = refBalanceIn * impactThresholdBps / VolatilitySurgeFeeArgsBuilder.UTILIZATION_BPS;
        uint256 g0 = threshold > flow ? threshold - flow : 0;

        uint256 gross;
        if (ctx.query.isExactIn) {
            // Reduce amountIn by the fee only while the swap instruction runs (fee stays with Maker)
            gross = ctx.swap.amountIn;
            ctx.swap.amountIn = gross - _surgeFee(gross, g0, b, p);
            ctx.runLoop();
            ctx.swap.amountIn = gross;
        } else {
            // Swap computes the required net input; gross it up (rounding up, Maker-favouring)
            ctx.runLoop();
            gross = _grossForNet(ctx.swap.amountIn, g0, b, p);
            ctx.swap.amountIn = gross;
        }

        if (!ctx.vm.isStaticContext && decayWindowSec != 0) {
            if (!active) {
                w.start = block.timestamp.toUint40();
                w.refBalanceIn = refBalanceIn;
                w.flow = gross.toUint216();
            } else {
                w.flow = (flow + gross).toUint216();
            }
            emit SurgeWindowUpdated(ctx.query.orderHash, ctx.query.tokenIn, w.start, w.flow, w.refBalanceIn);
        }
    }

    /// @dev fee(g) = ceil((g*b + max(0, g - g0)*p) / BPS)
    function _surgeFee(uint256 gross, uint256 g0, uint256 b, uint256 p) internal pure returns (uint256) {
        uint256 excess = gross > g0 ? gross - g0 : 0;
        return Math.ceilDiv(gross * b + excess * p, BPS);
    }

    /// @dev Smallest gross g with net(g) = g - fee(g) >= net. Closed-form inverse of the
    ///      piecewise-linear schedule, then an integer fix-up (bounded: marginal rate <= 50%).
    function _grossForNet(uint256 net, uint256 g0, uint256 b, uint256 p) internal pure returns (uint256 gross) {
        if (net * BPS <= g0 * (BPS - b)) {
            gross = Math.ceilDiv(net * BPS, BPS - b);
        } else {
            gross = Math.ceilDiv(net * BPS - g0 * p, BPS - b - p);
        }
        while (gross - _surgeFee(gross, g0, b, p) < net) {
            gross++;
        }
    }
}
