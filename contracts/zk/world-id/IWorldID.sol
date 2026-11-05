// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IWorldID
/// @notice The World ID Router interface as consumed by on-chain verifiers. Mirrors
///         `interfaces/IWorldID.sol` of worldcoin/world-id-onchain-template (MIT).
/// @dev Declared `view`: the router returns nothing and reverts on an invalid proof, and the
///      implementation does not write state, so it is safe to STATICCALL — which SwapVM's `quote()`
///      (a `view`) requires. The exact revert type depends on the identity manager behind the group
///      (`ExpiredRoot()`, `NonExistentRoot()`, `ProofInvalid()`, string reasons, ...), so callers
///      wrap the call in `try/catch` and treat any revert as "not verified".
interface IWorldID {
    /// @notice Reverts if the zero-knowledge proof is invalid.
    /// @param root The root of the World ID Merkle tree the proof was generated against
    /// @param groupId The Semaphore group (1 = Orb-verified humans)
    /// @param signalHash `ByteHasher.hashToField(abi.encodePacked(signal))`
    /// @param nullifierHash The Semaphore nullifier hash (unique per identity per external nullifier)
    /// @param externalNullifierHash `hashToField(abi.encodePacked(hashToField(appId), action))`
    /// @param proof The Groth16 proof as 8 uint256 words (a0, a1, b01, b00, b11, b10, c0, c1)
    /// @dev A double-signalling check is not included here and must be carried by the caller.
    function verifyProof(
        uint256 root,
        uint256 groupId,
        uint256 signalHash,
        uint256 nullifierHash,
        uint256 externalNullifierHash,
        uint256[8] calldata proof
    ) external view;
}
