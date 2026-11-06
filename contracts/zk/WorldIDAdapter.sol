// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

import { IZKVerifier } from "../interfaces/IZKVerifier.sol";
import { IWorldID } from "./world-id/IWorldID.sol";
import { ByteHasher } from "./world-id/ByteHasher.sol";
import { TakerAuthorization } from "./TakerAuthorization.sol";

/// @title WorldIDAdapter
/// @notice `IZKVerifier` for opcode 0x2A (verifierType 1) backed by the World ID Router.
///
///   proof bytes (direct):      abi.encode(uint256 merkleRoot, uint256 epoch, uint256[8] proof)                      320 B
///   proof bytes (authorised):  abi.encode(uint256 merkleRoot, uint256 epoch, address recipient, uint256 authDeadline,
///                                         bytes32 r, bytes32 s, uint8 v, uint256[8] proof)                           480 B
///   nullifier                  = World ID `nullifierHash` (stable per human per app + action)
///   revealArray                = unused — World ID is a bare proof of personhood (Orb, group 1)
///
///   * Signal binding: the Semaphore signal is the beneficiary's address, hashed exactly as World
///     ID's on-chain template does: `abi.encodePacked(address).hashToField()`. World App / IDKit
///     produce the proof for `signal = <address>`, so a searcher who replays a trader's takerData
///     from another address presents a different `signalHash` and the pairing check fails. The
///     beneficiary is the taker, or the `recipient` of an authorised envelope presented by a taker the
///     recipient signed a `TakerAuthorization` for (aggregators, relayers, smart accounts).
///   * External nullifier: `hashToField(abi.encodePacked(hashToField(appId), action))`. With
///     `EPOCH_DURATION > 0` the action rotates: `actionFor(epoch) = "<action>-<epoch>"`, so a human's
///     `nullifierHash` changes every epoch and trades are unlinkable across epochs (the same model as
///     the Aadhaar adapter), and a lost wallet costs at most the rest of the epoch. The envelope names
///     its epoch; the current epoch is accepted, and the previous one during `EPOCH_GRACE`. IDKit is
///     asked for `action = actionFor(currentEpoch())`.
/// @dev No admin, no setters. Never reverts on malformed input — returns false. `view` only: the
///      router call is a STATICCALL, so `quote()` and `swap()` see identical results.
contract WorldIDAdapter is IZKVerifier, TakerAuthorization {
    using ByteHasher for bytes;

    uint256 private constant _DIRECT_PROOF_LENGTH = 32 * 10;
    uint256 private constant _AUTHORIZED_PROOF_LENGTH = 32 * 15;

    IWorldID public immutable WORLD_ID;
    uint256 public immutable GROUP_ID;
    /// @notice hashToField(appId)
    uint256 public immutable APP_ID_HASH;
    /// @notice External nullifier of the un-rotated action (what applies when EPOCH_DURATION == 0)
    uint256 public immutable EXTERNAL_NULLIFIER;
    uint256 public immutable EPOCH_DURATION;
    /// @notice Seconds after an epoch roll during which the previous epoch's proofs are still accepted
    uint256 public immutable EPOCH_GRACE;

    string public appId;
    string public action;

    error EpochGraceTooLong(uint256 grace, uint256 epochDuration);

    constructor(
        IWorldID worldId,
        uint256 groupId,
        string memory appId_,
        string memory action_,
        uint256 epochDuration,
        uint256 epochGrace
    ) {
        require(epochDuration == 0 || epochGrace < epochDuration, EpochGraceTooLong(epochGrace, epochDuration));
        WORLD_ID = worldId;
        GROUP_ID = groupId;
        appId = appId_;
        action = action_;
        APP_ID_HASH = abi.encodePacked(appId_).hashToField();
        EXTERNAL_NULLIFIER = abi.encodePacked(APP_ID_HASH, action_).hashToField();
        EPOCH_DURATION = epochDuration;
        EPOCH_GRACE = epochGrace;
    }

    /// @notice Current epoch (0 when rotation is disabled)
    function currentEpoch() public view returns (uint256) {
        return EPOCH_DURATION == 0 ? 0 : block.timestamp / EPOCH_DURATION;
    }

    /// @notice True for the current epoch, and for the previous one during the grace period
    function isAcceptedEpoch(uint256 epoch) public view returns (bool) {
        uint256 current = currentEpoch();
        if (epoch == current) return true;
        return EPOCH_DURATION != 0 && epoch + 1 == current && block.timestamp % EPOCH_DURATION < EPOCH_GRACE;
    }

    /// @notice Last second of `epoch` (type(uint40).max when rotation is disabled)
    function epochEnd(uint256 epoch) public view returns (uint256) {
        return EPOCH_DURATION == 0 ? type(uint40).max : (epoch + 1) * EPOCH_DURATION - 1;
    }

    /// @notice The IDKit / World App `action` string for `epoch`
    function actionFor(uint256 epoch) public view returns (string memory) {
        return EPOCH_DURATION == 0 ? action : string.concat(action, "-", Strings.toString(epoch));
    }

    /// @notice externalNullifierHash a proof for `epoch` must commit to
    function externalNullifierFor(uint256 epoch) public view returns (uint256) {
        return EPOCH_DURATION == 0 ? EXTERNAL_NULLIFIER : abi.encodePacked(APP_ID_HASH, actionFor(epoch)).hashToField();
    }

    /// @notice externalNullifierHash a proof made right now must commit to
    function currentExternalNullifier() external view returns (uint256) {
        return externalNullifierFor(currentEpoch());
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
        uint256 epoch;
        address beneficiary = taker;
        uint256[8] memory groth16Proof;

        if (proof.length == _DIRECT_PROOF_LENGTH) {
            (root, epoch, groth16Proof) = abi.decode(proof, (uint256, uint256, uint256[8]));
        } else if (proof.length == _AUTHORIZED_PROOF_LENGTH) {
            if (uint256(bytes32(proof[64:96])) > type(uint160).max || uint256(bytes32(proof[192:224])) > type(uint8).max) return (false, address(0), 0);
            uint256 deadline;
            bytes32 r;
            bytes32 s;
            uint8 v;
            (root, epoch, beneficiary, deadline, r, s, v, groth16Proof) =
                abi.decode(proof, (uint256, uint256, address, uint256, bytes32, bytes32, uint8, uint256[8]));
            if (!_isAuthorizedTaker(beneficiary, taker, deadline, r, s, v)) return (false, address(0), 0);
        } else {
            return (false, address(0), 0);
        }

        if (!isAcceptedEpoch(epoch)) return (false, address(0), 0);
        if (address(WORLD_ID).code.length == 0) return (false, address(0), 0);
        try WORLD_ID.verifyProof(root, GROUP_ID, signalHashOf(beneficiary), nullifier, externalNullifierFor(epoch), groth16Proof) {
            return (true, beneficiary, uint40(epochEnd(epoch)));
        } catch {
            return (false, address(0), 0);
        }
    }
}
