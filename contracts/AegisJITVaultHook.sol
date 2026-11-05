// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IMakerHooks } from "@1inch/swap-vm/src/interfaces/IMakerHooks.sol";

/// @title AegisJITVaultHook
/// @notice Just-in-time settlement for self-custodial Makers whose capital sits in ERC-4626 vaults.
///         * preTransferOut: withdraw exactly `amountOut` of `tokenOut` from the Maker's vault
///           position into the Maker's own wallet, right before Aqua pulls it to the taker.
///         * postTransferIn: re-deposit the `amountIn` the Maker just received back into the
///           Maker's vault position, so it keeps earning yield.
/// @dev The hook can only move a Maker's assets between that Maker's wallet and that Maker's
///      vault position — never to a third party. It needs the Maker's allowances on vault
///      shares (withdraw) and on the underlying tokens (deposit). `makerData` is
///      `abi.encodePacked(vaultA, vaultB)` (either may be zero = token not vault-backed).
contract AegisJITVaultHook is IMakerHooks {
    using SafeERC20 for IERC20;

    address public immutable ROUTER;

    error OnlyRouter(address caller);
    error InvalidMakerData(uint256 length);

    event JITWithdraw(address indexed maker, address indexed vault, uint256 assets);
    event JITDeposit(address indexed maker, address indexed vault, uint256 assets);

    modifier onlyRouter() {
        require(msg.sender == ROUTER, OnlyRouter(msg.sender));
        _;
    }

    constructor(address router) {
        ROUTER = router;
    }

    function preTransferIn(address, address, address, address, uint256, uint256, bytes32, bytes calldata, bytes calldata) external view onlyRouter {}

    function postTransferIn(
        address maker,
        address /* taker */,
        address tokenIn,
        address /* tokenOut */,
        uint256 amountIn,
        uint256 /* amountOut */,
        bytes32 /* orderHash */,
        bytes calldata makerData,
        bytes calldata /* takerData */
    ) external onlyRouter {
        address vault = _vaultFor(tokenIn, makerData);
        if (vault == address(0) || amountIn == 0) return;

        IERC20(tokenIn).safeTransferFrom(maker, address(this), amountIn);
        IERC20(tokenIn).forceApprove(vault, amountIn);
        IERC4626(vault).deposit(amountIn, maker);
        emit JITDeposit(maker, vault, amountIn);
    }

    function preTransferOut(
        address maker,
        address /* taker */,
        address /* tokenIn */,
        address tokenOut,
        uint256 /* amountIn */,
        uint256 amountOut,
        bytes32 /* orderHash */,
        bytes calldata makerData,
        bytes calldata /* takerData */
    ) external onlyRouter {
        address vault = _vaultFor(tokenOut, makerData);
        if (vault == address(0) || amountOut == 0) return;

        IERC4626(vault).withdraw(amountOut, maker, maker);
        emit JITWithdraw(maker, vault, amountOut);
    }

    function postTransferOut(address, address, address, address, uint256, uint256, bytes32, bytes calldata, bytes calldata) external view onlyRouter {}

    function _vaultFor(address token, bytes calldata makerData) private view returns (address) {
        require(makerData.length == 40, InvalidMakerData(makerData.length));
        address vaultA = address(bytes20(makerData[0:20]));
        address vaultB = address(bytes20(makerData[20:40]));
        if (vaultA != address(0) && IERC4626(vaultA).asset() == token) return vaultA;
        if (vaultB != address(0) && IERC4626(vaultB).asset() == token) return vaultB;
        return address(0);
    }
}
