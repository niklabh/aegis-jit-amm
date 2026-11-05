// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

/// @title StaticQuoter (test helper)
/// @notice Calls `ISwapVM.quote` through its `view` interface, so the EVM performs a real
///         STATICCALL — proving every AegisJIT opcode is view-safe (any SSTORE/TSTORE would revert).
contract StaticQuoter {
    function quote(ISwapVM router, ISwapVM.Order calldata order, uint256 amount, bytes calldata takerTraitsAndData)
        external
        view
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
    {
        return router.quote(order, amount, takerTraitsAndData);
    }
}
