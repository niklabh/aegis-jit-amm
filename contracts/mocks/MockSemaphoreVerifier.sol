// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IWorldIDSemaphoreVerifier } from "../zk/world-id/IWorldIDSemaphoreVerifier.sol";

/// @title MockSemaphoreVerifier (test double)
/// @notice Stands in for World ID's `SemaphoreVerifier` (Groth16, Semaphore v3 depth 30) with the
///         same ABI and revert behaviour. It models SNARK soundness: a proof verifies only for the
///         exact public inputs `[root, nullifierHash, signalHash, externalNullifierHash]` it was
///         "proven" for (registered by the test prover). Any change to a public input or a proof
///         word reverts `ProofInvalid()`, like the real verifier. No hardcoded success path.
/// @dev Used where real proving is too slow or impossible (Foundry fuzzing, malformed inputs).
///      End-to-end paths use the vendored real verifier with proofs from `packages/world-id`.
contract MockSemaphoreVerifier is IWorldIDSemaphoreVerifier {
    address public immutable PROVER;
    mapping(bytes32 statement => bool) public isValidProof;

    error OnlyProver();
    /// @dev Same error as World ID's `SemaphoreVerifier`
    error ProofInvalid();

    event ProofRegistered(bytes32 indexed statement, uint256 indexed root, uint256 indexed nullifierHash);

    constructor(address prover) {
        PROVER = prover;
    }

    function statementHash(uint256[8] memory proof, uint256[4] memory input) public pure returns (bytes32) {
        return keccak256(abi.encode(proof, input));
    }

    /// @notice Test prover publishes a proof for exactly these public inputs
    function registerProof(uint256[8] calldata proof, uint256[4] calldata input) external {
        require(msg.sender == PROVER, OnlyProver());
        bytes32 s = statementHash(proof, input);
        isValidProof[s] = true;
        emit ProofRegistered(s, input[0], input[1]);
    }

    /// @inheritdoc IWorldIDSemaphoreVerifier
    function verifyProof(uint256[8] calldata proof, uint256[4] calldata input) external view {
        if (!isValidProof[statementHash(proof, input)]) revert ProofInvalid();
    }
}
