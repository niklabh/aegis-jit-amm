// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IWorldIDSemaphoreVerifier
/// @notice Independently declared interface of the Groth16 verifier behind World ID's identity
///         manager (world-id-contracts `ISemaphoreVerifier`): verifies a Semaphore v3 (depth 30)
///         proof for `input = [root, nullifierHash, signalHash, externalNullifierHash]` and reverts
///         (`ProofInvalid()`) when it does not verify. No return value.
interface IWorldIDSemaphoreVerifier {
    function verifyProof(uint256[8] calldata proof, uint256[4] calldata input) external view;
}
