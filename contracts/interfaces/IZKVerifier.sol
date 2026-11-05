// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IZKVerifier
/// @notice Minimal identity-proof verifier consumed by the `ZKIdentityGuard` (0x2A) opcode.
/// @dev Implementations MUST be `view` (they are called with STATICCALL during `quote`).
///      `revealArray` follows the Anon-Aadhaar convention: [ageAbove18, gender, pincode, state].
interface IZKVerifier {
    /// @param taker       Address the proof is bound to (the SwapVM taker / msg.sender of swap)
    /// @param nullifier   Identity nullifier (unique per human per app)
    /// @param revealArray Selectively disclosed attributes
    /// @param proof       Proof bytes (Groth16 calldata, attestation signature, ...)
    /// @return ok         True iff the proof is valid for the given public inputs
    function verifyProof(
        address taker,
        uint256 nullifier,
        uint256[4] calldata revealArray,
        bytes calldata proof
    ) external view returns (bool ok);
}
