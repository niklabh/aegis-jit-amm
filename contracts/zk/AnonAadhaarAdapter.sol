// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IZKVerifier } from "../interfaces/IZKVerifier.sol";
import { IAnonAadhaar } from "./IAnonAadhaar.sol";

/// @title AnonAadhaarAdapter
/// @notice `IZKVerifier` for opcode 0x2A backed by a deployed Anon Aadhaar Groth16 verifier.
///
///   proof bytes = abi.encode(uint256 timestamp, uint256[8] groth16Proof)   (288 bytes)
///
///   * Signal binding: the proof must commit to `signal = uint160(taker)`. A searcher who copies
///     a retail trader's takerData from the mempool and submits it from their own address
///     presents a different taker, so the Groth16 check fails.
///   * Freshness: `block.timestamp - timestamp <= MAX_PROOF_AGE`, so an old QR-code proof cannot
///     be replayed indefinitely.
///   * Policy: `revealArray[0]` (ageAbove18) must be 1; `revealArray[3]` (state, as the packed
///     value emitted by the circuit) must equal `REQUIRED_STATE` unless it is 0.
///   * App scoping: proofs must use this adapter's `NULLIFIER_SEED`.
/// @dev Never reverts on malformed input — it returns false, so tiered mode keeps working.
contract AnonAadhaarAdapter is IZKVerifier {
    uint256 private constant _PROOF_LENGTH = 32 * 9;
    uint256 private constant _AGE_ABOVE_18 = 0;
    uint256 private constant _STATE = 3;

    IAnonAadhaar public immutable ANON_AADHAAR;
    uint256 public immutable NULLIFIER_SEED;
    uint256 public immutable MAX_PROOF_AGE;
    uint256 public immutable REQUIRED_STATE;

    constructor(IAnonAadhaar anonAadhaar, uint256 nullifierSeed, uint256 maxProofAge, uint256 requiredState) {
        ANON_AADHAAR = anonAadhaar;
        NULLIFIER_SEED = nullifierSeed;
        MAX_PROOF_AGE = maxProofAge;
        REQUIRED_STATE = requiredState;
    }

    /// @inheritdoc IZKVerifier
    function verifyProof(
        address taker,
        uint256 nullifier,
        uint256[4] calldata revealArray,
        bytes calldata proof
    ) external view returns (bool) {
        if (proof.length != _PROOF_LENGTH) return false;
        (uint256 timestamp, uint256[8] memory groth16Proof) = abi.decode(proof, (uint256, uint256[8]));

        if (timestamp > block.timestamp || block.timestamp - timestamp > MAX_PROOF_AGE) return false;
        if (revealArray[_AGE_ABOVE_18] != 1) return false;
        if (REQUIRED_STATE != 0 && revealArray[_STATE] != REQUIRED_STATE) return false;

        try ANON_AADHAAR.verifyAnonAadhaarProof(
            NULLIFIER_SEED,
            nullifier,
            timestamp,
            uint256(uint160(taker)),
            revealArray,
            groth16Proof
        ) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }
}
