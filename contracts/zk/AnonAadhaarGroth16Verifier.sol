// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAnonAadhaar, IAnonAadhaarMultiKey } from "./IAnonAadhaar.sol";

/// @notice Interface of the snarkjs-generated Anon Aadhaar v2 Groth16 verifier
///         (vendor/anon-aadhaar/Verifier.sol). Independently declared.
interface IAnonAadhaarPairingVerifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[9] calldata pubSignals
    ) external view returns (bool);
}

/// @title AnonAadhaarGroth16Verifier
/// @notice `IAnonAadhaar` over the real BN254 Groth16 verifier (ecPairing precompile 0x08).
///         Public-signal layout and signal hashing follow Anon Aadhaar's `AnonAadhaar.sol`
///         (npm package anon-aadhaar contracts v2.4.3, MIT, Ethereum Foundation):
///         [pubkeyHash, nullifier, timestamp, ageAbove18, gender, pincode, state, nullifierSeed, signalHash]
/// @dev The trust root is a SET of circuit `pubkeyHash` values (hashes of the RSA keys that may have
///      signed the QR). The upstream-shaped 6-argument entry point uses the primary key
///      (`PUBKEY_HASH`, the first of the set); `verifyAnonAadhaarProofWithKey` accepts any trusted key.
///      Production = the UIDAI key hashes currently in circulation; local tests = the AegisJIT test signer.
///      The set is fixed at deployment (no admin): rotating in a new UIDAI key is a redeploy.
contract AnonAadhaarGroth16Verifier is IAnonAadhaar, IAnonAadhaarMultiKey {
    IAnonAadhaarPairingVerifier public immutable GROTH16;
    /// @notice Primary trust root (first key of the set)
    uint256 public immutable PUBKEY_HASH;

    mapping(uint256 pubkeyHash => bool) public isTrustedPubkeyHash;
    uint256[] private _trustedPubkeyHashes;

    error NoTrustedPubkeyHashes();

    constructor(IAnonAadhaarPairingVerifier groth16, uint256[] memory pubkeyHashes) {
        require(pubkeyHashes.length != 0, NoTrustedPubkeyHashes());
        GROTH16 = groth16;
        PUBKEY_HASH = pubkeyHashes[0];
        for (uint256 i = 0; i < pubkeyHashes.length; i++) {
            isTrustedPubkeyHash[pubkeyHashes[i]] = true;
            _trustedPubkeyHashes.push(pubkeyHashes[i]);
        }
    }

    /// @notice All trusted circuit pubkey hashes
    function trustedPubkeyHashes() external view returns (uint256[] memory) {
        return _trustedPubkeyHashes;
    }

    /// @inheritdoc IAnonAadhaar
    function verifyAnonAadhaarProof(
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] memory revealArray,
        uint256[8] memory groth16Proof
    ) external view returns (bool) {
        return _verify(PUBKEY_HASH, nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof);
    }

    /// @inheritdoc IAnonAadhaarMultiKey
    function verifyAnonAadhaarProofWithKey(
        uint256 pubkeyHash,
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] memory revealArray,
        uint256[8] memory groth16Proof
    ) external view returns (bool) {
        if (!isTrustedPubkeyHash[pubkeyHash]) return false;
        return _verify(pubkeyHash, nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof);
    }

    function _verify(
        uint256 pubkeyHash,
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] memory revealArray,
        uint256[8] memory groth16Proof
    ) private view returns (bool) {
        return GROTH16.verifyProof(
            [groth16Proof[0], groth16Proof[1]],
            [[groth16Proof[2], groth16Proof[3]], [groth16Proof[4], groth16Proof[5]]],
            [groth16Proof[6], groth16Proof[7]],
            [
                pubkeyHash,
                nullifier,
                timestamp,
                revealArray[0],
                revealArray[1],
                revealArray[2],
                revealArray[3],
                nullifierSeed,
                hashSignal(signal)
            ]
        );
    }

    /// @notice keccak256(signal) >> 3, so it fits the BN254 scalar field (same as AnonAadhaar.sol)
    function hashSignal(uint256 signal) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(signal))) >> 3;
    }
}
