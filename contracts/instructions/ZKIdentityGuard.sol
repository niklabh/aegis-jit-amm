// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Powered by SwapVM — © Degensoft Ltd 2025
/// @dev AegisJIT extension of SwapVM (created 2026-11-05). Compiled into the SwapVM router
///      runtime, hence a Modification under SwapVM-1.1 §1.7 and licensed under SwapVM-1.1 (§3.1A).

import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";

import { IZKVerifier } from "../interfaces/IZKVerifier.sol";

/// @title ZKIdentityGuardArgsBuilder
/// @notice Encodes/decodes the 46-byte args of opcode 0x2A and the taker-side proof payloads.
///
///   args   [verifierTypes:1][mode:1][requiredStateCode:4][worldIdVerifier:20][aadhaarVerifier:20]
///   taker  [uint16 L][verifierType:1][nullifier:32][revealArray:4x32 — Aadhaar only][proof:rest]
///
///   `verifierTypes` is a bitmask of the proof types the Maker accepts (1 = World ID, 2 = ZK
///   Aadhaar, 3 = either); the taker's payload starts with the single type it supplies. Each type
///   routes to its own `IZKVerifier` adapter; both end in the same verified-human fee tier.
library ZKIdentityGuardArgsBuilder {
    uint8 internal constant MODE_STRICT = 0;
    uint8 internal constant MODE_TIERED = 1;

    uint8 internal constant TYPE_WORLD_ID = 0x01;
    uint8 internal constant TYPE_AADHAAR = 0x02;
    uint8 internal constant TYPE_ANY = TYPE_WORLD_ID | TYPE_AADHAAR;

    uint256 internal constant ARGS_LENGTH = 46;
    /// @dev verifierType (1) + nullifier (32)
    uint256 internal constant PAYLOAD_HEADER_LENGTH = 33;
    /// @dev revealArray (4 * 32), present in Aadhaar payloads only
    uint256 internal constant REVEAL_ARRAY_LENGTH = 128;

    struct Args {
        uint8 verifierTypes;
        uint8 mode;
        uint32 requiredStateCode;
        address worldIdVerifier;
        address aadhaarVerifier;
    }

    error ZKIdentityGuardInvalidMode(uint8 mode);
    error ZKIdentityGuardInvalidVerifierTypes(uint8 verifierTypes);
    error ZKIdentityGuardVerifierMismatch(uint8 verifierType, address verifier);
    error ZKIdentityGuardInvalidArgsLength(uint256 length);

    /// @param verifierTypes     accepted proof types (bitmask: 1 World ID, 2 ZK Aadhaar)
    /// @param mode              0 = strict gate, 1 = tiered retail
    /// @param requiredStateCode 0 = any jurisdiction, else Aadhaar revealArray[3] must match
    /// @param worldIdVerifier   IZKVerifier for type 1 (zero iff the bit is unset)
    /// @param aadhaarVerifier   IZKVerifier for type 2 (zero iff the bit is unset)
    function build(
        uint8 verifierTypes,
        uint8 mode,
        uint32 requiredStateCode,
        address worldIdVerifier,
        address aadhaarVerifier
    ) internal pure returns (bytes memory) {
        _validate(verifierTypes, mode, worldIdVerifier, aadhaarVerifier);
        return abi.encodePacked(verifierTypes, mode, requiredStateCode, worldIdVerifier, aadhaarVerifier);
    }

    function parse(bytes calldata args) internal pure returns (Args memory a) {
        require(args.length == ARGS_LENGTH, ZKIdentityGuardInvalidArgsLength(args.length));
        a.verifierTypes = uint8(args[0]);
        a.mode = uint8(args[1]);
        a.requiredStateCode = uint32(bytes4(args[2:6]));
        a.worldIdVerifier = address(bytes20(args[6:26]));
        a.aadhaarVerifier = address(bytes20(args[26:46]));
        _validate(a.verifierTypes, a.mode, a.worldIdVerifier, a.aadhaarVerifier);
    }

    /// @notice ZK Aadhaar taker payload: [uint16 L][0x02][nullifier:32][revealArray:4x32][proof:L-161]
    function buildTakerArgs(uint256 nullifier, uint256[4] memory revealArray, bytes memory proof) internal pure returns (bytes memory) {
        bytes memory payload = abi.encodePacked(TYPE_AADHAAR, nullifier, revealArray, proof);
        return abi.encodePacked(uint16(payload.length), payload);
    }

    /// @notice World ID taker payload: [uint16 L][0x01][nullifierHash:32][proof:L-33]
    function buildWorldIdTakerArgs(uint256 nullifierHash, bytes memory proof) internal pure returns (bytes memory) {
        bytes memory payload = abi.encodePacked(TYPE_WORLD_ID, nullifierHash, proof);
        return abi.encodePacked(uint16(payload.length), payload);
    }

    function _validate(uint8 verifierTypes, uint8 mode, address worldIdVerifier, address aadhaarVerifier) private pure {
        require(mode <= MODE_TIERED, ZKIdentityGuardInvalidMode(mode));
        require(verifierTypes != 0 && verifierTypes <= TYPE_ANY, ZKIdentityGuardInvalidVerifierTypes(verifierTypes));
        require(
            (verifierTypes & TYPE_WORLD_ID != 0) == (worldIdVerifier != address(0)),
            ZKIdentityGuardVerifierMismatch(TYPE_WORLD_ID, worldIdVerifier)
        );
        require(
            (verifierTypes & TYPE_AADHAAR != 0) == (aadhaarVerifier != address(0)),
            ZKIdentityGuardVerifierMismatch(TYPE_AADHAAR, aadhaarVerifier)
        );
    }
}

/// @title ZKIdentityGuard — opcode 0x2A
/// @notice Opcode-level Sybil & compliance gate with a modular verifier router. Consumes an identity
///         proof from the taker's instruction args, routes it by its type byte to the Maker's World
///         ID or ZK Aadhaar `IZKVerifier` (STATICCALL), and either reverts (strict mode) or tiers
///         the taker (tiered mode). Both proof types grant the same verified-human tier.
/// @dev On success it calls `_onVerifiedHuman(ctx)`, which the router implements by switching
///      `ctx.vm.dispatch` to a dispatcher that routes the fee opcode (0x7A) with
///      `verifiedHuman = true`. That flag lives only in this execution's in-memory Context —
///      the VM's own transient state — so it is valid under STATICCALL (`quote()`), cannot leak
///      across swaps, and needs no TSTORE (which would revert inside `quote()`).
///      Nullifier binding (anti-Sybil): the first successful *swap* binds the proof's nullifier
///      (per verifier) to the proof's beneficiary (the taker, or the end user behind a trusted
///      forwarder). A later proof with the same nullifier but a different beneficiary is treated
///      as unverified, so one human cannot farm the discount across many bot addresses.
///        * World ID: the nullifierHash is stable per human per app/action, so this is
///          "one discounted address per human" for the lifetime of the adapter.
///        * ZK Aadhaar with an epoch-rotating verifier (AnonAadhaarAdapter): the nullifier itself
///          changes every epoch, so this is "one address per human per epoch", unlinkable across epochs.
///      The binding is read in `quote()` and written only when `!ctx.vm.isStaticContext`, after
///      verification, so `quote()` stays STATICCALL-safe and equal to `swap()`.
abstract contract ZKIdentityGuard {
    using ContextLib for Context;

    error ZKVerificationFailed();

    event NullifierBound(address indexed verifier, uint256 indexed nullifier, address indexed beneficiary);

    /// @notice verifier => nullifier => beneficiary the nullifier was first used by (0 = unbound)
    mapping(address verifier => mapping(uint256 nullifier => address beneficiary)) public nullifierTaker;

    uint256 private constant _AGE_ABOVE_18_INDEX = 0;
    uint256 private constant _STATE_INDEX = 3;

    /// @dev Router hook invoked once the taker is proven to be a verified human.
    function _onVerifiedHuman(Context memory ctx) internal pure virtual;

    /// @param args.verifierTypes     | 1 byte  (bitmask: 1 World ID, 2 ZK Aadhaar, 3 either)
    /// @param args.mode              | 1 byte  (0 strict, 1 tiered)
    /// @param args.requiredStateCode | 4 bytes (0 = any; Aadhaar only)
    /// @param args.worldIdVerifier   | 20 bytes
    /// @param args.aadhaarVerifier   | 20 bytes
    function _execZKIdentityGuard(Context memory ctx, bytes calldata args) internal {
        ZKIdentityGuardArgsBuilder.Args memory a = ZKIdentityGuardArgsBuilder.parse(args);

        (bool verified, address verifier, uint256 nullifier, address beneficiary) = _verifyTakerProof(ctx, a);

        if (verified) {
            address bound = nullifierTaker[verifier][nullifier];
            if (bound == address(0)) {
                if (!ctx.vm.isStaticContext) {
                    nullifierTaker[verifier][nullifier] = beneficiary;
                    emit NullifierBound(verifier, nullifier, beneficiary);
                }
            } else if (bound != beneficiary) {
                verified = false; // nullifier already belongs to another address
            }
        }

        if (verified) {
            _onVerifiedHuman(ctx);
        } else if (a.mode == ZKIdentityGuardArgsBuilder.MODE_STRICT) {
            revert ZKVerificationFailed();
        }
        // MODE_TIERED + not verified: continue as an unverified (bot) taker.
    }

    /// @dev Consumes the taker payload (always, so later instructions see their own args), routes it
    ///      to the adapter for its type and runs the type's public-input policy before the proof check.
    function _verifyTakerProof(Context memory ctx, ZKIdentityGuardArgsBuilder.Args memory a)
        private
        view
        returns (bool, address, uint256, address)
    {
        bytes calldata lengthPrefix = ctx.tryChopTakerArgs(2);
        if (lengthPrefix.length < 2) return (false, address(0), 0, address(0));
        uint256 payloadLength = uint16(bytes2(lengthPrefix));

        bytes calldata payload = ctx.tryChopTakerArgs(payloadLength);
        if (payload.length != payloadLength || payloadLength < ZKIdentityGuardArgsBuilder.PAYLOAD_HEADER_LENGTH) {
            return (false, address(0), 0, address(0));
        }

        uint8 proofType = uint8(payload[0]);
        if (proofType & a.verifierTypes == 0) return (false, address(0), 0, address(0)); // Maker does not accept this type
        address verifier;
        if (proofType == ZKIdentityGuardArgsBuilder.TYPE_WORLD_ID) verifier = a.worldIdVerifier;
        else if (proofType == ZKIdentityGuardArgsBuilder.TYPE_AADHAAR) verifier = a.aadhaarVerifier;
        else return (false, address(0), 0, address(0));
        if (verifier.code.length == 0) return (false, verifier, 0, address(0));

        uint256 nullifier = uint256(bytes32(payload[1:33]));
        uint256[4] memory revealArray;
        uint256 proofOffset = ZKIdentityGuardArgsBuilder.PAYLOAD_HEADER_LENGTH;
        if (proofType == ZKIdentityGuardArgsBuilder.TYPE_AADHAAR) {
            proofOffset += ZKIdentityGuardArgsBuilder.REVEAL_ARRAY_LENGTH;
            if (payloadLength < proofOffset) return (false, verifier, nullifier, address(0));
            for (uint256 i = 0; i < 4; i++) {
                revealArray[i] = uint256(bytes32(payload[33 + 32 * i:65 + 32 * i]));
            }
            // Public-input policy checks (cheap) before the proof check (expensive).
            if (revealArray[_AGE_ABOVE_18_INDEX] != 1) return (false, verifier, nullifier, address(0));
            if (a.requiredStateCode != 0 && revealArray[_STATE_INDEX] != a.requiredStateCode) {
                return (false, verifier, nullifier, address(0));
            }
        }
        bytes calldata proof = payload[proofOffset:];

        (bool success, bytes memory result) = verifier.staticcall(
            abi.encodeCall(IZKVerifier.verifyProof, (ctx.query.taker, nullifier, revealArray, proof))
        );
        if (!success || result.length != 64) return (false, verifier, nullifier, address(0));
        (uint256 ok, uint256 who) = abi.decode(result, (uint256, uint256));
        if (ok != 1 || who > type(uint160).max) return (false, verifier, nullifier, address(0));
        address beneficiary = who == 0 ? ctx.query.taker : address(uint160(who));
        return (true, verifier, nullifier, beneficiary);
    }
}
