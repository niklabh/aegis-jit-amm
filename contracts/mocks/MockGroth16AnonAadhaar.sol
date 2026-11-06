// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAnonAadhaar, IAnonAadhaarMultiKey } from "../zk/IAnonAadhaar.sol";

/// @title MockGroth16AnonAadhaar (test double)
/// @notice Stands in for the Anon Aadhaar Groth16 verifier with the same ABI (single-key and
///         multi-key entry points). It models SNARK soundness: a proof verifies only for the exact
///         public signals it was "proven" for (registered by the test prover). Any change to
///         pubkeyHash, nullifierSeed, nullifier, timestamp, signal, revealArray or proof words,
///         including passing them in the wrong order, returns false. No hardcoded `true`.
contract MockGroth16AnonAadhaar is IAnonAadhaar, IAnonAadhaarMultiKey {
    address public immutable PROVER;
    mapping(bytes32 statement => bool) public isValidProof;
    mapping(uint256 pubkeyHash => bool) public isTrustedPubkeyHash;

    error OnlyProver();

    event ProofRegistered(bytes32 indexed statement, uint256 nullifier, uint256 signal);

    constructor(address prover) {
        PROVER = prover;
    }

    function statementHash(
        uint256 pubkeyHash,
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] memory revealArray,
        uint256[8] memory groth16Proof
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(pubkeyHash, nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof));
    }

    /// @notice Test prover publishes a proof for exactly these public signals (single-key statement)
    function registerProof(
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] calldata revealArray,
        uint256[8] calldata groth16Proof
    ) external {
        _register(0, nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof);
    }

    /// @notice Test prover publishes a proof made under a specific signing key
    function registerProofWithKey(
        uint256 pubkeyHash,
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] calldata revealArray,
        uint256[8] calldata groth16Proof
    ) external {
        isTrustedPubkeyHash[pubkeyHash] = true;
        _register(pubkeyHash, nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof);
    }

    function _register(
        uint256 pubkeyHash,
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] calldata revealArray,
        uint256[8] calldata groth16Proof
    ) private {
        require(msg.sender == PROVER, OnlyProver());
        bytes32 s = statementHash(pubkeyHash, nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof);
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
        return isValidProof[statementHash(0, nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof)];
    }

    function verifyAnonAadhaarProofWithKey(
        uint256 pubkeyHash,
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] memory revealArray,
        uint256[8] memory groth16Proof
    ) external view returns (bool) {
        return isValidProof[statementHash(pubkeyHash, nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof)];
    }
}
