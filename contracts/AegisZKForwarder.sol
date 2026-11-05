// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Powered by SwapVM — © Degensoft Ltd 2025
/// @dev AegisJIT reference forwarder (created 2026-11-05). Uses SwapVM's TakerTraitsLib, hence SwapVM-1.1.

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { TakerTraits, TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { ZKIdentityGuardArgsBuilder } from "./instructions/ZKIdentityGuard.sol";

/// @title AegisZKForwarder
/// @notice Reference aggregator / relayer that may call the router on behalf of verified humans.
///         When `AegisSwapVMRouter.swap` is called by this contract, `ctx.query.taker` is the
///         forwarder, so the ZK proof must commit to the END USER (`recipient`). The forwarder
///         is only safe to whitelist in `AnonAadhaarAdapter` / `WorldIDAdapter` because it enforces:
///           1. the proof's `recipient` == `msg.sender` (a copied proof cannot be used by anyone else),
///           2. the swap output is sent to `msg.sender` (takerTraits `to`),
///           3. the input is pulled from `msg.sender`.
/// @dev Assumes the ZK payload is the first chunk of the taker's instruction args (0x2A runs first
///      in the AegisJIT program). exactIn only.
contract AegisZKForwarder {
    using SafeERC20 for IERC20;
    using TakerTraitsLib for TakerTraits;

    uint256 private constant _FORWARDED_PROOF = 32 * 10; // (timestamp | merkleRoot), recipient, uint256[8]

    ISwapVM public immutable ROUTER;

    error ForwarderRecipientMismatch(address recipient, address caller);
    error ForwarderOutputNotToCaller(address to, address caller);
    error ForwarderExactInOnly();
    error ForwarderMissingZkEnvelope();

    constructor(ISwapVM router) {
        ROUTER = router;
    }

    function swapExactIn(
        ISwapVM.Order calldata order,
        address tokenIn,
        uint256 amountIn,
        bytes calldata takerTraitsAndData
    ) external returns (uint256 swapAmountIn, uint256 swapAmountOut) {
        (TakerTraits traits, bytes calldata takerData) = TakerTraitsLib.parse(takerTraitsAndData);
        require(traits.isExactIn(), ForwarderExactInOnly());

        address recipient = _zkRecipient(traits.instructionsArgs(takerData));
        require(recipient == msg.sender, ForwarderRecipientMismatch(recipient, msg.sender));

        address to = traits.to(takerData, address(this));
        require(to == msg.sender, ForwarderOutputNotToCaller(to, msg.sender));

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(ROUTER), amountIn);
        (swapAmountIn, swapAmountOut,) = ROUTER.swap(order, amountIn, takerTraitsAndData);
    }

    /// @dev [uint16 L][verifierType:1][nullifier:32][revealArray:128 if ZK Aadhaar][abi.encode(word, recipient, uint256[8])]
    function _zkRecipient(bytes calldata args) private pure returns (address) {
        require(args.length >= 3, ForwarderMissingZkEnvelope());
        uint256 len = uint16(bytes2(args[0:2]));
        uint8 proofType = uint8(args[2]);
        uint256 publicInputs = ZKIdentityGuardArgsBuilder.PAYLOAD_HEADER_LENGTH;
        if (proofType == ZKIdentityGuardArgsBuilder.TYPE_AADHAAR) publicInputs += ZKIdentityGuardArgsBuilder.REVEAL_ARRAY_LENGTH;
        else require(proofType == ZKIdentityGuardArgsBuilder.TYPE_WORLD_ID, ForwarderMissingZkEnvelope());
        require(len == publicInputs + _FORWARDED_PROOF && args.length >= 2 + len, ForwarderMissingZkEnvelope());
        uint256 offset = 2 + publicInputs + 32;
        uint256 word = uint256(bytes32(args[offset:offset + 32]));
        require(word <= type(uint160).max, ForwarderMissingZkEnvelope());
        return address(uint160(word));
    }
}
