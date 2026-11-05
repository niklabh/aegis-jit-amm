// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ByteHasher
/// @notice World ID's field-hashing helper, as in `helpers/ByteHasher.sol` of
///         worldcoin/world-id-onchain-template (MIT). IDKit / World App hash the signal and the
///         external nullifier the same way, so the on-chain values match the proof's public inputs.
library ByteHasher {
    /// @dev Creates a keccak256 hash of a bytestring. `>> 8` makes sure that the result is a valid
    ///      BN254 scalar-field element (the field is ~254 bits).
    function hashToField(bytes memory value) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(value))) >> 8;
    }
}
