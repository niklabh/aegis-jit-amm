// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IWorldID } from "../zk/world-id/IWorldID.sol";
import { IWorldIDSemaphoreVerifier } from "../zk/world-id/IWorldIDSemaphoreVerifier.sol";

/// @title MockWorldIDRouter
/// @notice Local stand-in for the World ID Router + Identity Manager pair, for fast tests, fuzzing
///         and the dashboard. It mirrors the on-chain behaviour that matters to an integrator:
///           * `verifyProof(root, groupId, signalHash, nullifierHash, externalNullifierHash, proof)`
///             — the router entry point, `view`, reverts on failure, returns nothing;
///           * group routing — only `GROUP_ID` (1 = Orb) exists, anything else `NoSuchGroup`;
///           * root history — the latest root is always valid; a superseded root stays valid for
///             `ROOT_HISTORY_EXPIRY` (World ID default: 1 hour) and then `ExpiredRoot`; an unknown
///             root is `NonExistentRoot` (same errors as `IBaseWorldID`);
///           * proof verification is delegated to an `IWorldIDSemaphoreVerifier` — the vendored,
///             unmodified World ID `SemaphoreVerifier` (real BN254 pairing) or `MockSemaphoreVerifier`.
///         Roots are published by `IDENTITY_OPERATOR`, playing World ID's signup sequencer. The
///         identity tree itself lives off-chain (`packages/world-id`), as it does for World ID.
/// @dev Not a proxy, no upgradeability, no identity insertion proofs — those are out of scope for
///      verifying a proof against a known root.
contract MockWorldIDRouter is IWorldID {
    /// @dev Router error (WorldIDRouterImplV1)
    error NoSuchGroup(uint256 groupId);
    /// @dev Identity-manager errors (IBaseWorldID)
    error ExpiredRoot();
    error NonExistentRoot();
    error Unauthorized(address caller);

    event RootRegistered(uint256 indexed root, uint256 indexed supersededRoot);

    IWorldIDSemaphoreVerifier public immutable SEMAPHORE_VERIFIER;
    address public immutable IDENTITY_OPERATOR;
    uint256 public immutable GROUP_ID;
    uint256 public immutable ROOT_HISTORY_EXPIRY;

    uint256 public latestRoot;
    /// @notice root => timestamp at which it was superseded (0 = never registered, or the latest root)
    mapping(uint256 root => uint128 supersededAt) public rootHistory;

    constructor(
        IWorldIDSemaphoreVerifier semaphoreVerifier,
        address identityOperator,
        uint256 groupId,
        uint256 initialRoot,
        uint256 rootHistoryExpiry
    ) {
        SEMAPHORE_VERIFIER = semaphoreVerifier;
        IDENTITY_OPERATOR = identityOperator;
        GROUP_ID = groupId;
        ROOT_HISTORY_EXPIRY = rootHistoryExpiry;
        latestRoot = initialRoot;
    }

    /// @notice Publish a new tree root (the sequencer's `registerIdentities` outcome). The previous
    ///         latest root enters the history with the current timestamp.
    function registerRoot(uint256 newRoot) external {
        require(msg.sender == IDENTITY_OPERATOR, Unauthorized(msg.sender));
        uint256 previous = latestRoot;
        if (newRoot == previous) return;
        rootHistory[previous] = uint128(block.timestamp);
        latestRoot = newRoot;
        emit RootRegistered(newRoot, previous);
    }

    /// @notice Reverts unless `root` is the latest root or a non-expired historical root
    function requireValidRoot(uint256 root) public view {
        if (root == latestRoot) return;
        uint128 supersededAt = rootHistory[root];
        if (supersededAt == 0) revert NonExistentRoot();
        if (block.timestamp - supersededAt > ROOT_HISTORY_EXPIRY) revert ExpiredRoot();
    }

    /// @inheritdoc IWorldID
    function verifyProof(
        uint256 root,
        uint256 groupId,
        uint256 signalHash,
        uint256 nullifierHash,
        uint256 externalNullifierHash,
        uint256[8] calldata proof
    ) external view {
        if (groupId != GROUP_ID) revert NoSuchGroup(groupId);
        requireValidRoot(root);
        SEMAPHORE_VERIFIER.verifyProof(proof, [root, nullifierHash, signalHash, externalNullifierHash]);
    }
}
