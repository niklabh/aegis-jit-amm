// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title TakerAuthorization
/// @notice EIP-712 authorisation by a proof's beneficiary for one specific taker (an aggregator,
///         relayer or smart account) to present the beneficiary's identity proof on its behalf.
///         Replaces a fixed forwarder whitelist: any taker works if, and only if, the beneficiary
///         signed for exactly that address, and only until `deadline`.
///
///           TakerAuthorization(address taker,uint256 deadline)
///           domain: name "AegisJIT ZK Adapter", version "1", chainId, verifyingContract = the adapter
///
///         A payload copied out of the mempool by another taker fails (not the authorised address);
///         the authorised taker can at most present the beneficiary's proof until the deadline, so
///         clients should sign short-lived authorisations (the current epoch, or a few minutes).
/// @dev ECDSA for EOAs, ERC-1271 for smart accounts (OpenZeppelin `SignatureChecker`, view-only, so
///      the adapters stay STATICCALL-safe).
abstract contract TakerAuthorization is EIP712 {
    bytes32 public constant TAKER_AUTHORIZATION_TYPEHASH = keccak256("TakerAuthorization(address taker,uint256 deadline)");

    constructor() EIP712("AegisJIT ZK Adapter", "1") {}

    /// @notice Digest the beneficiary signs to let `taker` present its proofs until `deadline`
    function takerAuthorizationDigest(address taker, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(TAKER_AUTHORIZATION_TYPEHASH, taker, deadline)));
    }

    /// @dev True iff `taker` may act for `beneficiary`: it is the beneficiary itself, or it holds an
    ///      unexpired authorisation signed by the beneficiary (ECDSA or ERC-1271).
    function _isAuthorizedTaker(address beneficiary, address taker, uint256 deadline, bytes32 r, bytes32 s, uint8 v)
        internal
        view
        returns (bool)
    {
        if (beneficiary == taker) return true;
        if (block.timestamp > deadline) return false;
        return SignatureChecker.isValidSignatureNow(beneficiary, takerAuthorizationDigest(taker, deadline), abi.encodePacked(r, s, v));
    }
}
