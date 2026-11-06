// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IZKVerifier } from "../interfaces/IZKVerifier.sol";
import { IWorldID } from "./world-id/IWorldID.sol";
import { ByteHasher } from "./world-id/ByteHasher.sol";

/// @title WorldIDAdapter
/// @notice `IZKVerifier` for opcode 0x2A (verifierType 1) backed by the World ID Router.
///
///   proof bytes (direct):     abi.encode(uint256 merkleRoot, uint256[8] proof)                    288 B
///   proof bytes (forwarded):  abi.encode(uint256 merkleRoot, address recipient, uint256[8] proof) 320 B
///   nullifier                 = World ID `nullifierHash` (stable per human per app + action)
///   revealArray               = unused — World ID is a bare proof of personhood (Orb, group 1)
///
///   * Signal binding: the Semaphore signal is the beneficiary's address, hashed exactly as World
///     ID's on-chain template does: `abi.encodePacked(address).hashToField()`. World App / IDKit
///     produce the proof for `signal = <address>`, so a searcher who replays a trader's takerData
///     from another address presents a different `signalHash` and the pairing check fails.
///   * External nullifier: `hashToField(abi.encodePacked(hashToField(appId), action))` — one action
///     for the AegisJIT fee tier, so every human has exactly one `nullifierHash` here. 0x2A binds it
///     to the first beneficiary that swaps with it (one discounted address per human).
///   * Forwarded envelope: honoured only when `taker` is one of the constructor-fixed trusted
///     forwarders (`AegisZKForwarder`), which enforce `recipient == msg.sender`.
/// @dev No admin, no setters. Never reverts on malformed input — returns false. `view` only: the
///      router call is a STATICCALL, so `quote()` and `swap()` see identical results.
contract WorldIDAdapter is IZKVerifier {
    using ByteHasher for bytes;

    uint256 private constant _DIRECT_PROOF_LENGTH = 32 * 9;
    uint256 private constant _FORWARDED_PROOF_LENGTH = 32 * 10;

    IWorldID public immutable WORLD_ID;
    uint256 public immutable GROUP_ID;
    uint256 public immutable EXTERNAL_NULLIFIER;

    string public appId;
    string public action;
    mapping(address => bool) public isTrustedForwarder;

    constructor(
        IWorldID worldId,
        uint256 groupId,
        string memory appId_,
        string memory action_,
        address[] memory trustedForwarders
    ) {
        WORLD_ID = worldId;
        GROUP_ID = groupId;
        appId = appId_;
        action = action_;
        EXTERNAL_NULLIFIER = abi.encodePacked(abi.encodePacked(appId_).hashToField(), action_).hashToField();
        for (uint256 i = 0; i < trustedForwarders.length; i++) isTrustedForwarder[trustedForwarders[i]] = true;
    }

    /// @notice The Semaphore `signalHash` a proof must commit to for `beneficiary`
    function signalHashOf(address beneficiary) public pure returns (uint256) {
        return abi.encodePacked(beneficiary).hashToField();
    }

    /// @inheritdoc IZKVerifier
    function verifyProof(
        address taker,
        uint256 nullifier,
        uint256[4] calldata /* revealArray — no selective disclosure in World ID */,
        bytes calldata proof
    ) external view returns (bool, address, uint40) {
        uint256 root;
        address beneficiary = taker;
        uint256[8] memory groth16Proof;

        if (proof.length == _DIRECT_PROOF_LENGTH) {
            (root, groth16Proof) = abi.decode(proof, (uint256, uint256[8]));
        } else if (proof.length == _FORWARDED_PROOF_LENGTH) {
            if (uint256(bytes32(proof[32:64])) > type(uint160).max) return (false, address(0), 0);
            (root, beneficiary, groth16Proof) = abi.decode(proof, (uint256, address, uint256[8]));
            if (beneficiary != taker && !isTrustedForwarder[taker]) return (false, address(0), 0);
        } else {
            return (false, address(0), 0);
        }

        if (address(WORLD_ID).code.length == 0) return (false, address(0), 0);
        try WORLD_ID.verifyProof(root, GROUP_ID, signalHashOf(beneficiary), nullifier, EXTERNAL_NULLIFIER, groth16Proof) {
            // nullifierHash is stable per human per (app, action): the binding never expires
            return (true, beneficiary, type(uint40).max);
        } catch {
            return (false, address(0), 0);
        }
    }
}
