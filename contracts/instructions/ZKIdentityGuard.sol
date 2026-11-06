// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Powered by SwapVM — © Degensoft Ltd 2025
/// @dev AegisJIT extension of SwapVM (created 2026-11-05). Compiled into the SwapVM router
///      runtime, hence a Modification under SwapVM-1.1 §1.7 and licensed under SwapVM-1.1 (§3.1A).

import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";

import { IZKVerifier } from "../interfaces/IZKVerifier.sol";

/// @title ZKIdentityGuardArgsBuilder
/// @notice Encodes/decodes the 46-byte args of opcode 0x2A and the taker-side payloads.
///
///   args   [verifierTypes:1][mode:1][requiredStateCode:4][worldIdVerifier:20][aadhaarVerifier:20]
///   taker  [uint16 L][verifierType:1][nullifier:32][revealArray:4x32 — Aadhaar only][proof:rest]
///   claim  [uint16 33][verifierType:1][nullifier:32]   (no proof: the nullifier is already bound to msg.sender)
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
    /// @dev verifierType (1) + nullifier (32); a payload of exactly this length is a binding claim
    uint256 internal constant PAYLOAD_HEADER_LENGTH = 33;
    /// @dev revealArray (4 * 32), present in Aadhaar proof payloads only
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

    /// @notice Binding claim (fast path): [uint16 33][verifierType:1][nullifier:32], no proof.
    function buildBindingClaim(uint8 verifierType, uint256 nullifier) internal pure returns (bytes memory) {
        return abi.encodePacked(uint16(PAYLOAD_HEADER_LENGTH), verifierType, nullifier);
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
///
///      Nullifier binding (anti-Sybil). The first successful *swap* binds the proof's nullifier
///      (per verifier) to the proof's beneficiary, with a `validUntil` taken from the adapter: how
///      long a proof for this nullifier could stay valid (the end of its epoch for rotating
///      schemes, forever for a stable World ID nullifierHash).
///        * A proof for the same nullifier from a different beneficiary is treated as unverified,
///          expired or not: a nullifier belongs to its first address, so one human cannot farm the
///          discount across many bot addresses. Rotating schemes give the human a fresh nullifier
///          (and so a free choice of wallet) every epoch.
///        * While the binding is live the bound address may trade with a 33-byte binding CLAIM
///          `[type][nullifier]` instead of the proof. 0x2A then checks one storage slot and skips
///          the adapter call and the BN254 pairing entirely (~260k gas), so only the first trade
///          per epoch pays for the proof. Claims are honoured only for direct takers
///          (beneficiary == msg.sender) and only on orders without an opcode-level jurisdiction
///          policy (`requiredStateCode == 0`), because that policy was not evaluated for this order
///          when the nullifier was bound. The same beneficiary may always re-prove to extend `validUntil`.
///      Bindings are read in `quote()` and written only when `!ctx.vm.isStaticContext`, after
///      verification, so `quote()` stays STATICCALL-safe and equal to `swap()`.
abstract contract ZKIdentityGuard {
    using ContextLib for Context;

    struct NullifierBinding {
        address beneficiary; // address the nullifier is bound to (0 = unbound)
        uint40 validUntil;   // last timestamp the binding (and claims against it) is honoured
    }

    /// @dev Outcome of parsing/verifying the taker payload
    struct Verdict {
        bool verified;        // proof verified by the adapter
        bool claim;           // proof-less binding claim (checked against storage by the caller)
        address verifier;
        uint256 nullifier;
        address beneficiary;
        uint256 validUntil;
    }

    error ZKVerificationFailed();

    event NullifierBound(address indexed verifier, uint256 indexed nullifier, address indexed beneficiary, uint256 validUntil);

    /// @notice verifier => nullifier => binding
    mapping(address verifier => mapping(uint256 nullifier => NullifierBinding)) internal _bindings;

    uint256 private constant _AGE_ABOVE_18_INDEX = 0;
    uint256 private constant _STATE_INDEX = 3;

    /// @dev Router hook invoked once the taker is proven to be a verified human.
    function _onVerifiedHuman(Context memory ctx) internal pure virtual;

    /// @notice Current binding of `nullifier` under `verifier` (raw; `validUntil` may be in the past)
    function nullifierBinding(address verifier, uint256 nullifier) external view returns (address beneficiary, uint40 validUntil) {
        NullifierBinding storage b = _bindings[verifier][nullifier];
        return (b.beneficiary, b.validUntil);
    }

    /// @notice Address `nullifier` was last bound to under `verifier` (0 = never bound)
    function nullifierTaker(address verifier, uint256 nullifier) external view returns (address) {
        return _bindings[verifier][nullifier].beneficiary;
    }

    /// @param args.verifierTypes     | 1 byte  (bitmask: 1 World ID, 2 ZK Aadhaar, 3 either)
    /// @param args.mode              | 1 byte  (0 strict, 1 tiered)
    /// @param args.requiredStateCode | 4 bytes (0 = any; Aadhaar only)
    /// @param args.worldIdVerifier   | 20 bytes
    /// @param args.aadhaarVerifier   | 20 bytes
    function _execZKIdentityGuard(Context memory ctx, bytes calldata args) internal {
        ZKIdentityGuardArgsBuilder.Args memory a = ZKIdentityGuardArgsBuilder.parse(args);

        Verdict memory v = _verifyTakerProof(ctx, a);
        bool verified = v.verified;

        if (v.claim) {
            // Fast path: honour the claim iff the nullifier is live-bound to this very taker
            NullifierBinding storage b = _bindings[v.verifier][v.nullifier];
            verified = b.beneficiary == ctx.query.taker && b.validUntil >= block.timestamp;
        } else if (verified) {
            NullifierBinding storage b = _bindings[v.verifier][v.nullifier];
            if (b.beneficiary != address(0) && b.beneficiary != v.beneficiary) {
                verified = false; // the nullifier belongs to its first address, expired or not
            } else if ((b.beneficiary == address(0) || b.validUntil < v.validUntil) && !ctx.vm.isStaticContext && v.validUntil >= block.timestamp) {
                b.beneficiary = v.beneficiary;
                b.validUntil = uint40(v.validUntil);
                emit NullifierBound(v.verifier, v.nullifier, v.beneficiary, v.validUntil);
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
    ///      A payload of exactly [type][nullifier] is a binding claim and is not sent to the adapter.
    function _verifyTakerProof(Context memory ctx, ZKIdentityGuardArgsBuilder.Args memory a)
        private
        view
        returns (Verdict memory v)
    {
        bytes calldata lengthPrefix = ctx.tryChopTakerArgs(2);
        if (lengthPrefix.length < 2) return v;
        uint256 payloadLength = uint16(bytes2(lengthPrefix));

        bytes calldata payload = ctx.tryChopTakerArgs(payloadLength);
        if (payload.length != payloadLength || payloadLength < ZKIdentityGuardArgsBuilder.PAYLOAD_HEADER_LENGTH) return v;

        uint8 proofType = uint8(payload[0]);
        if (proofType & a.verifierTypes == 0) return v; // Maker does not accept this type
        if (proofType == ZKIdentityGuardArgsBuilder.TYPE_WORLD_ID) v.verifier = a.worldIdVerifier;
        else if (proofType == ZKIdentityGuardArgsBuilder.TYPE_AADHAAR) v.verifier = a.aadhaarVerifier;
        else return v;
        if (v.verifier.code.length == 0) return v;

        v.nullifier = uint256(bytes32(payload[1:33]));

        if (payloadLength == ZKIdentityGuardArgsBuilder.PAYLOAD_HEADER_LENGTH) {
            // Binding claim: no proof, no policy re-check possible => only on orders without one
            v.claim = a.requiredStateCode == 0;
            return v;
        }

        uint256[4] memory revealArray;
        uint256 proofOffset = ZKIdentityGuardArgsBuilder.PAYLOAD_HEADER_LENGTH;
        if (proofType == ZKIdentityGuardArgsBuilder.TYPE_AADHAAR) {
            proofOffset += ZKIdentityGuardArgsBuilder.REVEAL_ARRAY_LENGTH;
            if (payloadLength < proofOffset) return v;
            for (uint256 i = 0; i < 4; i++) {
                revealArray[i] = uint256(bytes32(payload[33 + 32 * i:65 + 32 * i]));
            }
            // Public-input policy checks (cheap) before the proof check (expensive).
            if (revealArray[_AGE_ABOVE_18_INDEX] != 1) return v;
            if (a.requiredStateCode != 0 && revealArray[_STATE_INDEX] != a.requiredStateCode) return v;
        }
        bytes calldata proof = payload[proofOffset:];

        (bool success, bytes memory result) = v.verifier.staticcall(
            abi.encodeCall(IZKVerifier.verifyProof, (ctx.query.taker, v.nullifier, revealArray, proof))
        );
        if (!success || result.length != 96) return v;
        (uint256 ok, uint256 who, uint256 validUntil) = abi.decode(result, (uint256, uint256, uint256));
        if (ok != 1 || who > type(uint160).max || validUntil > type(uint40).max) return v;
        v.beneficiary = who == 0 ? ctx.query.taker : address(uint160(who));
        v.validUntil = validUntil;
        v.verified = true;
    }
}
