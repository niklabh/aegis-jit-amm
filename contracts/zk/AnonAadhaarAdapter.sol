// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IZKVerifier } from "../interfaces/IZKVerifier.sol";
import { IAnonAadhaar } from "./IAnonAadhaar.sol";

/// @title AnonAadhaarAdapter
/// @notice `IZKVerifier` for opcode 0x2A backed by an Anon Aadhaar Groth16 verifier.
///
///   proof bytes (direct):     abi.encode(uint256 timestamp, uint256[8] groth16Proof)                     288 B
///   proof bytes (forwarded):  abi.encode(uint256 timestamp, address recipient, uint256[8] groth16Proof)  320 B
///
///   * Signal binding: the proof must commit to `signal = uint160(beneficiary)`, where the
///     beneficiary is the taker itself, or — only when the taker is one of this adapter's
///     constructor-fixed trusted forwarders — the explicit `recipient`. A searcher replaying a
///     trader's takerData from their own address presents a different beneficiary and fails.
///   * Epoch-rotating nullifiers (unlinkability): with `EPOCH_DURATION > 0` the proof must use
///     `nullifierSeed = keccak256(APP_SEED, epoch) mod p`, `epoch = block.timestamp / EPOCH_DURATION`.
///     The circuit's nullifier = Poseidon(nullifierSeed, photo), so the same person shows a fresh,
///     unlinkable nullifier every epoch, while within an epoch it is stable (Sybil-bound by 0x2A).
///   * Freshness: `0 <= block.timestamp - timestamp <= MAX_PROOF_AGE`.
///   * Policy: `revealArray[0]` (ageAbove18) == 1; `revealArray[3]` (state, packed as emitted by
///     the circuit) == `REQUIRED_STATE` unless 0. (Anon Aadhaar order: [age, gender, pincode, state].)
/// @dev No admin, no setters. Never reverts on malformed input — returns false.
contract AnonAadhaarAdapter is IZKVerifier {
    uint256 public constant SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 private constant _DIRECT_PROOF_LENGTH = 32 * 9;
    uint256 private constant _FORWARDED_PROOF_LENGTH = 32 * 10;
    uint256 private constant _AGE_ABOVE_18 = 0;
    uint256 private constant _STATE = 3;

    IAnonAadhaar public immutable ANON_AADHAAR;
    uint256 public immutable APP_SEED;
    uint256 public immutable EPOCH_DURATION;
    uint256 public immutable MAX_PROOF_AGE;
    uint256 public immutable REQUIRED_STATE;

    mapping(address => bool) public isTrustedForwarder;

    error NullifierSeedOutOfField(uint256 seed);

    constructor(
        IAnonAadhaar anonAadhaar,
        uint256 appSeed,
        uint256 epochDuration,
        uint256 maxProofAge,
        uint256 requiredState,
        address[] memory trustedForwarders
    ) {
        require(epochDuration != 0 || appSeed < SNARK_FIELD, NullifierSeedOutOfField(appSeed));
        ANON_AADHAAR = anonAadhaar;
        APP_SEED = appSeed;
        EPOCH_DURATION = epochDuration;
        MAX_PROOF_AGE = maxProofAge;
        REQUIRED_STATE = requiredState;
        for (uint256 i = 0; i < trustedForwarders.length; i++) isTrustedForwarder[trustedForwarders[i]] = true;
    }

    /// @notice Current epoch (0 when epochs are disabled)
    function currentEpoch() public view returns (uint256) {
        return EPOCH_DURATION == 0 ? 0 : block.timestamp / EPOCH_DURATION;
    }

    /// @notice nullifierSeed a proof must use in `epoch`
    function nullifierSeedFor(uint256 epoch) public view returns (uint256) {
        if (EPOCH_DURATION == 0) return APP_SEED;
        return uint256(keccak256(abi.encode(APP_SEED, epoch))) % SNARK_FIELD;
    }

    /// @notice nullifierSeed a proof must use right now
    function currentNullifierSeed() external view returns (uint256) {
        return nullifierSeedFor(currentEpoch());
    }

    /// @inheritdoc IZKVerifier
    function verifyProof(
        address taker,
        uint256 nullifier,
        uint256[4] calldata revealArray,
        bytes calldata proof
    ) external view returns (bool, address, uint40) {
        uint256 timestamp;
        address beneficiary = taker;
        uint256[8] memory groth16Proof;

        if (proof.length == _DIRECT_PROOF_LENGTH) {
            (timestamp, groth16Proof) = abi.decode(proof, (uint256, uint256[8]));
        } else if (proof.length == _FORWARDED_PROOF_LENGTH) {
            if (uint256(bytes32(proof[32:64])) > type(uint160).max) return (false, address(0), 0);
            (timestamp, beneficiary, groth16Proof) = abi.decode(proof, (uint256, address, uint256[8]));
            if (beneficiary != taker && !isTrustedForwarder[taker]) return (false, address(0), 0);
        } else {
            return (false, address(0), 0);
        }

        if (timestamp > block.timestamp || block.timestamp - timestamp > MAX_PROOF_AGE) return (false, address(0), 0);
        if (revealArray[_AGE_ABOVE_18] != 1) return (false, address(0), 0);
        if (REQUIRED_STATE != 0 && revealArray[_STATE] != REQUIRED_STATE) return (false, address(0), 0);

        try ANON_AADHAAR.verifyAnonAadhaarProof(
            nullifierSeedFor(currentEpoch()),
            nullifier,
            timestamp,
            uint256(uint160(beneficiary)),
            revealArray,
            groth16Proof
        ) returns (bool ok) {
            return ok ? (true, beneficiary, _bindingValidUntil(timestamp)) : (false, address(0), 0);
        } catch {
            return (false, address(0), 0);
        }
    }

    /// @notice How long 0x2A may honour a proof-less binding claim for a nullifier proven from a QR
    ///         issued at `timestamp`: until the nullifier's epoch ends, and never beyond the point
    ///         where the QR itself would be too old to prove with.
    function _bindingValidUntil(uint256 timestamp) internal view returns (uint40) {
        uint256 validUntil = Math.min(timestamp + MAX_PROOF_AGE, type(uint40).max);
        if (EPOCH_DURATION != 0) validUntil = Math.min(validUntil, (currentEpoch() + 1) * EPOCH_DURATION - 1);
        return uint40(validUntil);
    }
}
