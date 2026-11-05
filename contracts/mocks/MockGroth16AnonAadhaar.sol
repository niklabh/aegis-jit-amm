// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAnonAadhaar } from "../zk/IAnonAadhaar.sol";

/// @title MockGroth16AnonAadhaar (test double)
/// @notice Stands in for the Anon Aadhaar Groth16 verifier with the same ABI. It models SNARK
///         soundness: a proof verifies only for the exact public signals it was "proven" for
///         (registered by the test prover). Any change to nullifierSeed, nullifier, timestamp,
///         signal, revealArray or proof words, including passing them in the wrong order,
///         returns false. No hardcoded `true`.
contract MockGroth16AnonAadhaar is IAnonAadhaar {
    address public immutable PROVER;
    mapping(bytes32 statement => bool) public isValidProof;

    error OnlyProver();

    event ProofRegistered(bytes32 indexed statement, uint256 nullifier, uint256 signal);

    constructor(address prover) {
        PROVER = prover;
    }

    function statementHash(
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] memory revealArray,
        uint256[8] memory groth16Proof
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof));
    }

    /// @notice Test prover publishes a proof for exactly these public signals
    function registerProof(
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] calldata revealArray,
        uint256[8] calldata groth16Proof
    ) external {
        require(msg.sender == PROVER, OnlyProver());
        bytes32 s = statementHash(nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof);
        isValidProof[s] = true;
        emit ProofRegistered(s, nullifier, signal);
    }

    function verifyAnonAadhaarProof(
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] memory revealArray,
        uint256[8] memory groth16Proof
    ) external view returns (bool) {
        return isValidProof[statementHash(nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof)];
    }
}
