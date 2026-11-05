// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { AnonAadhaarAdapter } from "../../contracts/zk/AnonAadhaarAdapter.sol";
import { IAnonAadhaar } from "../../contracts/zk/IAnonAadhaar.sol";
import { MockGroth16AnonAadhaar } from "../../contracts/mocks/MockGroth16AnonAadhaar.sol";

/// @notice Fuzzes the adapter's signal binding and freshness window.
contract AnonAadhaarAdapterTest is Test {
    uint256 internal constant SEED = 1234;
    uint256 internal constant MAX_AGE = 1 days;
    MockGroth16AnonAadhaar internal aa;
    AnonAadhaarAdapter internal adapter;

    function setUp() public {
        vm.warp(1_800_000_000);
        aa = new MockGroth16AnonAadhaar(address(this));
        adapter = new AnonAadhaarAdapter(IAnonAadhaar(address(aa)), SEED, 0, MAX_AGE, 0, new address[](0));
    }

    function _prove(address taker, uint256 nullifier, uint256 ts) internal returns (uint256[4] memory reveal, bytes memory proof) {
        reveal = [uint256(1), 0, 0, 27];
        uint256[8] memory g;
        for (uint256 i; i < 8; i++) g[i] = uint256(keccak256(abi.encode(taker, nullifier, ts, i)));
        aa.registerProof(SEED, nullifier, ts, uint256(uint160(taker)), reveal, g);
        proof = abi.encode(ts, g);
    }

    /// Any address other than the one the proof commits to is rejected (mempool hijack)
    function testFuzz_signalBinding(address taker, address other, uint256 nullifier, uint256 age) public {
        vm.assume(taker != other);
        age = bound(age, 0, MAX_AGE);
        (uint256[4] memory reveal, bytes memory proof) = _prove(taker, nullifier, block.timestamp - age);
        (bool ok, address who) = adapter.verifyProof(taker, nullifier, reveal, proof);
        assertTrue(ok);
        assertEq(who, taker);
        (bool okOther,) = adapter.verifyProof(other, nullifier, reveal, proof);
        assertFalse(okOther);
    }

    /// Proofs older than MAX_PROOF_AGE or from the future are rejected
    function testFuzz_freshness(address taker, uint256 nullifier, uint256 offset, bool future) public {
        offset = bound(offset, 1, 365 days);
        uint256 ts = future ? block.timestamp + offset : block.timestamp - MAX_AGE - offset;
        (uint256[4] memory reveal, bytes memory proof) = _prove(taker, nullifier, ts);
        (bool ok,) = adapter.verifyProof(taker, nullifier, reveal, proof);
        assertFalse(ok);
    }

    /// Arbitrary proof bytes never revert, only return false
    function testFuzz_malformedNeverReverts(address taker, uint256 nullifier, bytes calldata junk) public view {
        uint256[4] memory reveal = [uint256(1), 0, 0, 0];
        (bool ok,) = adapter.verifyProof(taker, nullifier, reveal, junk);
        assertFalse(ok);
    }
}
