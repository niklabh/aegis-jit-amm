// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IZKVerifier
/// @notice Minimal identity-proof verifier consumed by the `ZKIdentityGuard` (0x2A) opcode.
/// @dev Implementations MUST be `view` (they are called with STATICCALL during `quote`).
///      `revealArray` follows the Anon-Aadhaar convention: [ageAbove18, gender, pincode, state].
///      Bare proof-of-personhood schemes (World ID) receive zeros and ignore it.
interface IZKVerifier {
    /// @param taker       The SwapVM taker (msg.sender of swap) — an EOA, or a trusted forwarder
    /// @param nullifier   Identity nullifier (unique per human per app; per epoch for rotating schemes;
    ///                    the World ID `nullifierHash` for World ID)
    /// @param revealArray Selectively disclosed attributes
    /// @param proof       Scheme-specific proof envelope (Groth16 words + merkle root / timestamp, attestation signature, ...)
    /// @return ok          True iff the proof is valid for the given public inputs
    /// @return beneficiary The human-controlled address the proof is bound to (`taker` for direct
    ///                     swaps; the end user when `taker` is a trusted forwarder). 0x2A binds
    ///                     the nullifier to this address.
    function verifyProof(
        address taker,
        uint256 nullifier,
        uint256[4] calldata revealArray,
        bytes calldata proof
    ) external view returns (bool ok, address beneficiary);
}
