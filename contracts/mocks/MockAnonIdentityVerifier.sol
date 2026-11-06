// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import { IZKVerifier } from "../interfaces/IZKVerifier.sol";

/// @title MockAnonIdentityVerifier
/// @notice Deterministic local stand-in for an Anon-Aadhaar / World ID Groth16 verifier.
/// @dev Instead of a SNARK, a trusted issuer key signs the public inputs
///      `(chainid, verifier, taker, nullifier, revealArray)` (EIP-191). Verification is a real
///      ECDSA recovery — there is no hardcoded `true`. Binding `taker` into the signed message
///      means a bot cannot replay a human's proof from another address.
///      A production adapter implements the same `IZKVerifier` and plugs into opcode 0x2A unchanged.
contract MockAnonIdentityVerifier is IZKVerifier {
    address public immutable ISSUER;

    constructor(address issuer) {
        ISSUER = issuer;
    }

    /// @notice The 32-byte message the issuer signs (before EIP-191 prefixing)
    function attestationHash(address taker, uint256 nullifier, uint256[4] calldata revealArray) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), taker, nullifier, revealArray));
    }

    /// @inheritdoc IZKVerifier
    function verifyProof(
        address taker,
        uint256 nullifier,
        uint256[4] calldata revealArray,
        bytes calldata proof
    ) external view returns (bool, address, uint40) {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(attestationHash(taker, nullifier, revealArray));
        (address signer, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, proof);
        bool ok = err == ECDSA.RecoverError.NoError && signer == ISSUER;
        return (ok, taker, ok ? type(uint40).max : 0);
    }
}
