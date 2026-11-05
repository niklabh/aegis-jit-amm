// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAnonAadhaar } from "./IAnonAadhaar.sol";

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
/// @dev `PUBKEY_HASH` is the trust root: the circuit's hash of the RSA key that signed the QR.
///      Production = the UIDAI key hash; local tests = the AegisJIT test signer.
contract AnonAadhaarGroth16Verifier is IAnonAadhaar {
    IAnonAadhaarPairingVerifier public immutable GROTH16;
    uint256 public immutable PUBKEY_HASH;

    constructor(IAnonAadhaarPairingVerifier groth16, uint256 pubkeyHash) {
        GROTH16 = groth16;
        PUBKEY_HASH = pubkeyHash;
    }

    function verifyAnonAadhaarProof(
        uint256 nullifierSeed,
        uint256 nullifier,
        uint256 timestamp,
        uint256 signal,
        uint256[4] memory revealArray,
        uint256[8] memory groth16Proof
    ) external view returns (bool) {
        return GROTH16.verifyProof(
            [groth16Proof[0], groth16Proof[1]],
            [[groth16Proof[2], groth16Proof[3]], [groth16Proof[4], groth16Proof[5]]],
            [groth16Proof[6], groth16Proof[7]],
            [
                PUBKEY_HASH,
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
