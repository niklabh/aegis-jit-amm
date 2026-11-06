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

/// @title IAnonAadhaarMultiKey
/// @notice Verifier that trusts a SET of UIDAI signing keys. UIDAI rotates its QR-signing certificate
///         every few years and several stay valid at once (QRs signed by an older key remain
///         authentic), so a single hard-coded `pubkeyHash` would reject valid residents after a
///         rotation. The prover supplies the circuit's `pubkeyHash` public signal; the verifier
///         checks it is trusted and uses it as public input 0.
interface IAnonAadhaarMultiKey {
    function isTrustedPubkeyHash(uint256 pubkeyHash) external view returns (bool);

    function verifyAnonAadhaarProofWithKey(
        uint256 pubkeyHash,
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] memory revealArray,
        uint256[8] memory groth16Proof
    ) external view returns (bool);
}
