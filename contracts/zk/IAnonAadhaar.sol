// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IAnonAadhaar
/// @notice Interface of the deployed Anon Aadhaar verifier (anon-aadhaar `AnonAadhaar.sol`).
/// @dev `signal` is passed raw; the Anon Aadhaar contract hashes it internally before checking
///      it against the circuit's signalHash public output.
///      `revealArray` = [ageAbove18, gender, pincode, state] (0 for fields not revealed).
interface IAnonAadhaar {
    function verifyAnonAadhaarProof(
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] memory revealArray,
        uint256[8] memory groth16Proof
    ) external view returns (bool);
}
