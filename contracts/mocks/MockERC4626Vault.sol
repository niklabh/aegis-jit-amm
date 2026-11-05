// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC4626 } from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockERC4626Vault
/// @notice Standard OpenZeppelin ERC-4626 yield vault used as the Maker's self-custodial reserve
///         (e.g. a Circle USDC savings vault). `accrueYield` simulates strategy returns by
///         donating underlying, which raises `convertToAssets` for every share holder.
contract MockERC4626Vault is ERC4626 {
    using SafeERC20 for IERC20;

    event YieldAccrued(uint256 assets);

    constructor(IERC20Metadata asset_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
    {}

    /// @notice Donate `assets` of the underlying to the vault as yield
    function accrueYield(uint256 assets) external {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);
        emit YieldAccrued(assets);
    }
}
