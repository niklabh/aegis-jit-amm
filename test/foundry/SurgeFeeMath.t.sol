// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { BPS } from "@1inch/swap-vm/src/instructions/Fee.sol";
import { VolatilitySurgeFee } from "../../contracts/instructions/VolatilitySurgeFee.sol";

contract SurgeFeeHarness is VolatilitySurgeFee {
    function fee(uint256 g, uint256 g0, uint256 b, uint256 p) external pure returns (uint256) { return _surgeFee(g, g0, b, p); }
    function net(uint256 g, uint256 g0, uint256 b, uint256 p) public pure returns (uint256) { return g - _surgeFee(g, g0, b, p); }
    function grossForNet(uint256 n, uint256 g0, uint256 b, uint256 p) external pure returns (uint256) { return _grossForNet(n, g0, b, p); }
}

/// @notice Property-based tests of the 0x7A fee schedule and its exactOut inverse, composed
///         with the XYC curve exactly as the SwapVM program executes them.
contract SurgeFeeMathTest is Test {
    SurgeFeeHarness internal h;

    function setUp() public { h = new SurgeFeeHarness(); }

    function _params(uint256 g0, uint256 b, uint256 p) internal pure returns (uint256, uint256, uint256) {
        g0 = bound(g0, 0, 1e30);
        b = bound(b, 0, BPS / 2);
        p = bound(p, 0, BPS / 2 - b); // base + premium = maxSurge <= 50%
        return (g0, b, p);
    }

    /// net(g) is non-decreasing and never jumps by more than 1 (marginal rate < 100%)
    function testFuzz_netMonotone(uint256 g, uint256 g0, uint256 b, uint256 p) public view {
        (g0, b, p) = _params(g0, b, p);
        g = bound(g, 0, 1e30);
        uint256 n0 = h.net(g, g0, b, p);
        uint256 n1 = h.net(g + 1, g0, b, p);
        assertGe(n1, n0);
        assertLe(n1 - n0, 1);
    }

    /// grossForNet returns the minimal gross that nets at least n
    function testFuzz_inverseIsMinimal(uint256 n, uint256 g0, uint256 b, uint256 p) public view {
        (g0, b, p) = _params(g0, b, p);
        n = bound(n, 1, 1e30);
        uint256 g = h.grossForNet(n, g0, b, p);
        assertGe(h.net(g, g0, b, p), n);
        assertLt(h.net(g - 1, g0, b, p), n);
    }

    /// Round trip on the fee alone: grossForNet(net(g)) is within 1 wei below g
    function testFuzz_feeRoundTrip(uint256 g, uint256 g0, uint256 b, uint256 p) public view {
        (g0, b, p) = _params(g0, b, p);
        g = bound(g, 1, 1e30);
        uint256 g2 = h.grossForNet(h.net(g, g0, b, p), g0, b, p);
        assertLe(g2, g);
        assertLe(g - g2, 1);
    }

    /// Full pipeline symmetry: exactIn(X) -> Y, exactOut(Y) -> X' with X' <= X (Maker never
    /// charges an exactOut taker more than the equivalent exactIn trade). Fine-grained output side.
    function testFuzz_pipelineSymmetry(uint256 x, uint256 bIn, uint256 bOut, uint256 g0, uint256 b, uint256 p) public view {
        (g0, b, p) = _params(g0, b, p);
        bIn = bound(bIn, 1e6, 1e24);
        bOut = bound(bOut, 1e18, 1e30);
        x = bound(x, 1, bIn);
        uint256 n = h.net(x, g0, b, p);
        uint256 y = n * bOut / (bIn + n);
        vm.assume(y > 0 && y < bOut);
        uint256 nPrime = Math.ceilDiv(y * bIn, bOut - y);
        uint256 xPrime = h.grossForNet(nPrime, g0, b, p);
        assertLe(xPrime, x);
    }

    /// Effective fee rate never exceeds maxSurge = b + p (rounding up by at most 1 wei)
    function testFuzz_feeCapped(uint256 g, uint256 g0, uint256 b, uint256 p) public view {
        (g0, b, p) = _params(g0, b, p);
        g = bound(g, 1, 1e30);
        assertLe(h.fee(g, g0, b, p), Math.ceilDiv(g * (b + p), BPS));
        assertGe(h.fee(g, g0, b, p), g * b / BPS);
    }
}
