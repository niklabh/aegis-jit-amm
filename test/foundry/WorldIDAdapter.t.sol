// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { WorldIDAdapter } from "../../contracts/zk/WorldIDAdapter.sol";
import { IWorldID } from "../../contracts/zk/world-id/IWorldID.sol";
import { IWorldIDSemaphoreVerifier } from "../../contracts/zk/world-id/IWorldIDSemaphoreVerifier.sol";
import { MockWorldIDRouter } from "../../contracts/mocks/MockWorldIDRouter.sol";
import { MockSemaphoreVerifier } from "../../contracts/mocks/MockSemaphoreVerifier.sol";
import { SemaphoreVerifier } from "../../contracts/zk/vendor/world-id/SemaphoreVerifier.sol";

/// @notice Fuzzes the World ID adapter's signal binding, external nullifier, forwarder envelope
///         and the router's root history, and checks a REAL Semaphore depth-30 proof against the
///         vendored World ID SemaphoreVerifier (BN254 pairing).
contract WorldIDAdapterTest is Test {
    string internal constant APP_ID = "app_staging_aegis_jit_mumbai";
    string internal constant ACTION = "aegis-jit-fee-tier";
    uint256 internal constant GROUP = 1;
    uint256 internal constant INITIAL_ROOT = 0xa11ce;
    uint256 internal constant EXPIRY = 1 hours;
    address internal constant FORWARDER = address(0xF0F0);

    MockSemaphoreVerifier internal semaphore;
    MockWorldIDRouter internal router;
    WorldIDAdapter internal adapter;

    function setUp() public {
        vm.warp(1_800_000_000);
        semaphore = new MockSemaphoreVerifier(address(this));
        router = new MockWorldIDRouter(IWorldIDSemaphoreVerifier(address(semaphore)), address(this), GROUP, INITIAL_ROOT, EXPIRY);
        address[] memory fwd = new address[](1);
        fwd[0] = FORWARDER;
        adapter = new WorldIDAdapter(IWorldID(address(router)), GROUP, APP_ID, ACTION, fwd);
    }

    function _hashToField(bytes memory b) internal pure returns (uint256) {
        return uint256(keccak256(b)) >> 8;
    }

    /// Registers a statement for (root, nullifierHash, signal = beneficiary, this adapter's action)
    function _prove(address beneficiary, uint256 nullifierHash, uint256 root, uint256 externalNullifier) internal returns (uint256[8] memory words) {
        for (uint256 i; i < 8; i++) words[i] = uint256(keccak256(abi.encode(beneficiary, nullifierHash, root, i))) >> 8;
        semaphore.registerProof(words, [root, nullifierHash, adapter.signalHashOf(beneficiary), externalNullifier]);
    }

    function test_externalNullifierFollowsWorldIdTemplate() public view {
        uint256 expected = _hashToField(abi.encodePacked(_hashToField(abi.encodePacked(APP_ID)), ACTION));
        assertEq(adapter.EXTERNAL_NULLIFIER(), expected);
        assertEq(adapter.signalHashOf(address(0xBEEF)), _hashToField(abi.encodePacked(address(0xBEEF))));
    }

    /// The proof is bound to the beneficiary's address: any other taker is rejected (mempool hijack)
    function testFuzz_signalBinding(address taker, address other, uint256 nullifierHash) public {
        vm.assume(taker != other);
        uint256[8] memory words = _prove(taker, nullifierHash, INITIAL_ROOT, adapter.EXTERNAL_NULLIFIER());
        bytes memory proof = abi.encode(INITIAL_ROOT, words);
        (bool ok, address who,) = adapter.verifyProof(taker, nullifierHash, [uint256(0), 0, 0, 0], proof);
        assertTrue(ok);
        assertEq(who, taker);
        (bool okOther,,) = adapter.verifyProof(other, nullifierHash, [uint256(0), 0, 0, 0], proof);
        assertFalse(okOther);
    }

    /// A proof for another app / action never verifies here
    function testFuzz_externalNullifier(address taker, uint256 nullifierHash, uint256 otherExternalNullifier) public {
        vm.assume(otherExternalNullifier != adapter.EXTERNAL_NULLIFIER());
        uint256[8] memory words = _prove(taker, nullifierHash, INITIAL_ROOT, otherExternalNullifier);
        (bool ok,,) = adapter.verifyProof(taker, nullifierHash, [uint256(0), 0, 0, 0], abi.encode(INITIAL_ROOT, words));
        assertFalse(ok);
    }

    /// Root history: the latest root is always valid, a superseded root only for EXPIRY, unknown roots never
    function testFuzz_rootHistory(address taker, uint256 nullifierHash, uint256 newRoot, uint256 elapsed, uint256 unknownRoot) public {
        vm.assume(newRoot != INITIAL_ROOT && unknownRoot != INITIAL_ROOT && unknownRoot != newRoot);
        elapsed = bound(elapsed, 0, 30 days);
        uint256 ext = adapter.EXTERNAL_NULLIFIER();
        uint256[8] memory oldWords = _prove(taker, nullifierHash, INITIAL_ROOT, ext);
        uint256[8] memory newWords = _prove(taker, nullifierHash, newRoot, ext);
        uint256[8] memory unknownWords = _prove(taker, nullifierHash, unknownRoot, ext);

        router.registerRoot(newRoot);
        vm.warp(block.timestamp + elapsed);

        (bool okOld,,) = adapter.verifyProof(taker, nullifierHash, [uint256(0), 0, 0, 0], abi.encode(INITIAL_ROOT, oldWords));
        assertEq(okOld, elapsed <= EXPIRY, "superseded root valid iff within expiry");
        (bool okNew,,) = adapter.verifyProof(taker, nullifierHash, [uint256(0), 0, 0, 0], abi.encode(newRoot, newWords));
        assertTrue(okNew, "latest root always valid");
        (bool okUnknown,,) = adapter.verifyProof(taker, nullifierHash, [uint256(0), 0, 0, 0], abi.encode(unknownRoot, unknownWords));
        assertFalse(okUnknown, "unknown root never valid");
    }

    /// Only the identity operator publishes roots; only group 1 exists
    function testFuzz_routerAccess(address caller, uint256 root, uint256 groupId) public {
        vm.assume(caller != address(this) && groupId != GROUP);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(MockWorldIDRouter.Unauthorized.selector, caller));
        router.registerRoot(root);
        uint256[8] memory words;
        vm.expectRevert(abi.encodeWithSelector(MockWorldIDRouter.NoSuchGroup.selector, groupId));
        router.verifyProof(INITIAL_ROOT, groupId, 0, 0, 0, words);
    }

    /// Recipient envelopes bind the signal to `recipient` and are honoured only from trusted forwarders
    function testFuzz_forwardedEnvelope(address taker, address recipient, uint256 nullifierHash) public {
        vm.assume(taker != recipient && taker != FORWARDER);
        uint256[8] memory words = _prove(recipient, nullifierHash, INITIAL_ROOT, adapter.EXTERNAL_NULLIFIER());
        bytes memory envelope = abi.encode(INITIAL_ROOT, recipient, words);
        (bool okFwd, address who,) = adapter.verifyProof(FORWARDER, nullifierHash, [uint256(0), 0, 0, 0], envelope);
        assertTrue(okFwd);
        assertEq(who, recipient);
        (bool okDirect,,) = adapter.verifyProof(recipient, nullifierHash, [uint256(0), 0, 0, 0], envelope);
        assertTrue(okDirect, "the recipient may present its own envelope");
        (bool okRogue,,) = adapter.verifyProof(taker, nullifierHash, [uint256(0), 0, 0, 0], envelope);
        assertFalse(okRogue, "untrusted relayer cannot claim another beneficiary");
    }

    /// Arbitrary proof bytes never revert, only return false
    function testFuzz_malformedNeverReverts(address taker, uint256 nullifierHash, bytes calldata junk) public view {
        (bool ok,,) = adapter.verifyProof(taker, nullifierHash, [uint256(0), 0, 0, 0], junk);
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ real proof, real verifier

    struct Fixture {
        uint256 root;
        uint256 nullifierHash;
        uint256 signalHash;
        uint256 externalNullifierHash;
        address signal;
        uint256[8] proof;
    }

    function _fixture() internal view returns (Fixture memory f) {
        string memory json = vm.readFile("test/fixtures/world-id/human-proof.json");
        f.root = vm.parseJsonUint(json, ".root");
        f.nullifierHash = vm.parseJsonUint(json, ".nullifierHash");
        f.signalHash = vm.parseJsonUint(json, ".signalHash");
        f.externalNullifierHash = vm.parseJsonUint(json, ".externalNullifierHash");
        f.signal = vm.parseJsonAddress(json, ".signal");
        uint256[] memory words = vm.parseJsonUintArray(json, ".proof");
        for (uint256 i; i < 8; i++) f.proof[i] = words[i];
    }

    function _realStack() internal returns (WorldIDAdapter realAdapter, MockWorldIDRouter realRouter, SemaphoreVerifier verifier, Fixture memory f) {
        f = _fixture();
        verifier = new SemaphoreVerifier();
        realRouter = new MockWorldIDRouter(IWorldIDSemaphoreVerifier(address(verifier)), address(this), GROUP, f.root, EXPIRY);
        realAdapter = new WorldIDAdapter(IWorldID(address(realRouter)), GROUP, APP_ID, ACTION, new address[](0));
        assertEq(realAdapter.EXTERNAL_NULLIFIER(), f.externalNullifierHash, "fixture action == adapter action");
        assertEq(realAdapter.signalHashOf(f.signal), f.signalHash, "fixture signal hashing == adapter");
    }

    /// World ID's own SemaphoreVerifier (vendored, VK == PSE depth-30 zkey) accepts the real proof
    function test_realProof_verifiesOnWorldIdVerifier() public {
        (WorldIDAdapter realAdapter,, SemaphoreVerifier verifier, Fixture memory f) = _realStack();
        verifier.verifyProof(f.proof, [f.root, f.nullifierHash, f.signalHash, f.externalNullifierHash]);
        (bool ok, address who,) = realAdapter.verifyProof(f.signal, f.nullifierHash, [uint256(0), 0, 0, 0], abi.encode(f.root, f.proof));
        assertTrue(ok);
        assertEq(who, f.signal);
    }

    /// Flipping any proof word breaks the pairing equation
    function testFuzz_realProof_tamperedWordRejected(uint8 index, uint256 mask) public {
        index = uint8(bound(index, 0, 7));
        vm.assume(mask != 0);
        (WorldIDAdapter realAdapter,, SemaphoreVerifier verifier, Fixture memory f) = _realStack();
        f.proof[index] ^= mask;
        vm.expectRevert();
        verifier.verifyProof(f.proof, [f.root, f.nullifierHash, f.signalHash, f.externalNullifierHash]);
        (bool ok,,) = realAdapter.verifyProof(f.signal, f.nullifierHash, [uint256(0), 0, 0, 0], abi.encode(f.root, f.proof));
        assertFalse(ok);
    }

    /// Nobody but the bound address can use the real proof (signalHash is a public input)
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_realProof_onlyBoundTaker(address other) public {
        (WorldIDAdapter realAdapter,,, Fixture memory f) = _realStack();
        vm.assume(other != f.signal);
        (bool ok,,) = realAdapter.verifyProof(other, f.nullifierHash, [uint256(0), 0, 0, 0], abi.encode(f.root, f.proof));
        assertFalse(ok);
    }

    /// The real proof only verifies against its own root, and only while that root is live
    function test_realProof_rootLifecycle() public {
        (WorldIDAdapter realAdapter, MockWorldIDRouter realRouter,, Fixture memory f) = _realStack();
        bytes memory proof = abi.encode(f.root, f.proof);
        realRouter.registerRoot(f.root + 1);
        (bool okHistorical,,) = realAdapter.verifyProof(f.signal, f.nullifierHash, [uint256(0), 0, 0, 0], proof);
        assertTrue(okHistorical, "superseded root still valid within 1 h");
        vm.warp(block.timestamp + EXPIRY + 1);
        (bool okExpired,,) = realAdapter.verifyProof(f.signal, f.nullifierHash, [uint256(0), 0, 0, 0], proof);
        assertFalse(okExpired, "expired root");
        (bool okWrongRoot,,) = realAdapter.verifyProof(f.signal, f.nullifierHash, [uint256(0), 0, 0, 0], abi.encode(f.root + 1, f.proof));
        assertFalse(okWrongRoot, "latest root, but the proof was not generated for it");
    }
}
