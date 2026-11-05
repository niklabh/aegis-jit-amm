// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Powered by SwapVM — © Degensoft Ltd 2025
/// @dev AegisJIT extension of SwapVM (created 2026-11-05). Compiled into the SwapVM router
///      runtime, hence a Modification under SwapVM-1.1 §1.7 and licensed under SwapVM-1.1 (§3.1A).

import { Calldata } from "@1inch/solidity-utils/contracts/libraries/Calldata.sol";
import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";

import { IZKVerifier } from "../interfaces/IZKVerifier.sol";

/// @title ZKIdentityGuardArgsBuilder
/// @notice Encodes/decodes the 25-byte args of opcode 0x2A and the taker-side proof payload.
library ZKIdentityGuardArgsBuilder {
    using Calldata for bytes;

    uint8 internal constant MODE_STRICT = 0;
    uint8 internal constant MODE_TIERED = 1;

    /// @dev nullifier (32) + revealArray (4 * 32)
    uint256 internal constant PUBLIC_INPUTS_LENGTH = 160;

    uint256 internal constant ARGS_LENGTH = 25;

    error ZKIdentityGuardInvalidMode(uint8 mode);
    error ZKIdentityGuardInvalidArgsLength(uint256 length);

    /// @param verifier          IZKVerifier implementation
    /// @param mode              0 = strict gate, 1 = tiered retail
    /// @param requiredStateCode 0 = any jurisdiction, else revealArray[3] must match
    function build(address verifier, uint8 mode, uint32 requiredStateCode) internal pure returns (bytes memory) {
        require(mode <= MODE_TIERED, ZKIdentityGuardInvalidMode(mode));
        return abi.encodePacked(verifier, mode, requiredStateCode);
    }

    function parse(bytes calldata args) internal pure returns (address verifier, uint8 mode, uint32 requiredStateCode) {
        require(args.length == ARGS_LENGTH, ZKIdentityGuardInvalidArgsLength(args.length));
        verifier = address(bytes20(args.slice(0, 20)));
        mode = uint8(bytes1(args.slice(20, 21)));
        requiredStateCode = uint32(bytes4(args.slice(21, 25)));
        require(mode <= MODE_TIERED, ZKIdentityGuardInvalidMode(mode));
    }

    /// @notice Taker payload: [uint16 L][nullifier:32][revealArray:4x32][proof:L-160]
    function buildTakerArgs(uint256 nullifier, uint256[4] memory revealArray, bytes memory proof) internal pure returns (bytes memory) {
        bytes memory payload = abi.encodePacked(nullifier, revealArray, proof);
        return abi.encodePacked(uint16(payload.length), payload);
    }
}

/// @title ZKIdentityGuard — opcode 0x2A
/// @notice Opcode-level Sybil & compliance gate. Consumes an identity proof from the taker's
///         instruction args, verifies it with a STATICCALL to an `IZKVerifier`, and either
///         reverts (strict mode) or tiers the taker (tiered mode).
/// @dev On success it calls `_onVerifiedHuman(ctx)`, which the router implements by switching
///      `ctx.vm.dispatch` to a dispatcher that routes the fee opcode with `verifiedHuman = true`.
///      Nullifier binding (anti-Sybil): the first successful *swap* binds the proof's nullifier
///      (per verifier) to its taker. A later proof with the same nullifier but a different taker
///      is treated as unverified, so one human cannot farm the discount across many bot
///      addresses. The binding is read in `quote()` and written only when
///      `!ctx.vm.isStaticContext`, after verification, so `quote()` stays STATICCALL-safe and
///      equal to `swap()`.
abstract contract ZKIdentityGuard {
    using Calldata for bytes;
    using ContextLib for Context;

    error ZKVerificationFailed();

    event NullifierBound(address indexed verifier, uint256 indexed nullifier, address indexed taker);

    /// @notice verifier => nullifier => taker the nullifier was first used by (0 = unbound)
    mapping(address verifier => mapping(uint256 nullifier => address taker)) public nullifierTaker;

    uint256 private constant _AGE_ABOVE_18_INDEX = 0;
    uint256 private constant _STATE_INDEX = 3;

    /// @dev Router hook invoked once the taker is proven to be a verified human.
    function _onVerifiedHuman(Context memory ctx) internal pure virtual;

    /// @param args.verifier          | 20 bytes
    /// @param args.mode              | 1 byte  (0 strict, 1 tiered)
    /// @param args.requiredStateCode | 4 bytes (0 = any)
    function _execZKIdentityGuard(Context memory ctx, bytes calldata args) internal {
        (address verifier, uint8 mode, uint32 requiredStateCode) = ZKIdentityGuardArgsBuilder.parse(args);

        (bool verified, uint256 nullifier) = _verifyTakerProof(ctx, verifier, requiredStateCode);

        if (verified) {
            address bound = nullifierTaker[verifier][nullifier];
            if (bound == address(0)) {
                if (!ctx.vm.isStaticContext) {
                    nullifierTaker[verifier][nullifier] = ctx.query.taker;
                    emit NullifierBound(verifier, nullifier, ctx.query.taker);
                }
            } else if (bound != ctx.query.taker) {
                verified = false; // nullifier already belongs to another address
            }
        }

        if (verified) {
            _onVerifiedHuman(ctx);
        } else if (mode == ZKIdentityGuardArgsBuilder.MODE_STRICT) {
            revert ZKVerificationFailed();
        }
        // MODE_TIERED + not verified: continue as an unverified (bot) taker.
    }

    function _verifyTakerProof(Context memory ctx, address verifier, uint32 requiredStateCode) private view returns (bool, uint256) {
        // Always consume the proof payload (if any) so later instructions see their own args.
        bytes calldata lengthPrefix = ctx.tryChopTakerArgs(2);
        if (lengthPrefix.length < 2) return (false, 0);
        uint256 payloadLength = uint16(bytes2(lengthPrefix));

        bytes calldata payload = ctx.tryChopTakerArgs(payloadLength);
        if (payload.length != payloadLength || payloadLength < ZKIdentityGuardArgsBuilder.PUBLIC_INPUTS_LENGTH) return (false, 0);
        if (verifier.code.length == 0) return (false, 0);

        uint256 nullifier = uint256(bytes32(payload.slice(0, 32)));
        uint256[4] memory revealArray;
        for (uint256 i = 0; i < 4; i++) {
            revealArray[i] = uint256(bytes32(payload.slice(32 + 32 * i, 64 + 32 * i)));
        }
        bytes calldata proof = payload.slice(ZKIdentityGuardArgsBuilder.PUBLIC_INPUTS_LENGTH);

        // Public-input policy checks (cheap) before the proof check (expensive).
        if (revealArray[_AGE_ABOVE_18_INDEX] != 1) return (false, nullifier);
        if (requiredStateCode != 0 && revealArray[_STATE_INDEX] != requiredStateCode) return (false, nullifier);

        (bool success, bytes memory result) = verifier.staticcall(
            abi.encodeCall(IZKVerifier.verifyProof, (ctx.query.taker, nullifier, revealArray, proof))
        );
        return (success && result.length == 32 && abi.decode(result, (uint256)) == 1, nullifier);
    }
}
